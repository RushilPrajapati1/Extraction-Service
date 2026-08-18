"""
Ingestion record storage — plain sqlite3, no ORM, on purpose.

The whole point of this file is that you can see every SQL statement
that runs. No hidden magic, no session objects, no migrations framework.
Once you're comfortable with what's happening here, swapping in
SQLAlchemy (or Postgres later, per the build plan) will make a lot more
sense because you'll know what it's doing *for* you.

One table: `documents`. One row per uploaded file, tracking it through
the ingestion pipeline.

    id            TEXT PRIMARY KEY   -- uuid4, generated at upload time
    filename      TEXT               -- original filename from the client
    content_type  TEXT               -- MIME type reported by the client
    size_bytes    INTEGER
    storage_path  TEXT               -- where the raw PDF lives on disk
    status         TEXT              -- 'uploaded'   queued, waiting for a worker
                                      -- 'processing' a worker owns it (the only in-flight
                                      --              state, and the only one the stale
                                      --              sweeper reclaims)
                                      -- 'needs_review' | 'completed' | 'failed'  terminal
    raw_text       TEXT              -- nullable; filled in during processing. Non-null
                                      --   means text extraction succeeded, which is why
                                      --   there's no separate 'text_extracted' status.
    extracted_data TEXT              -- nullable; JSON string, the LLM's structured output
                                      --   (see llm_extract.extract_invoice)
    confidence     REAL              -- nullable; 0.0-1.0, from validate.validate_invoice
    needs_review   INTEGER           -- nullable; 0/1, from validate.validate_invoice
    reviewed_data  TEXT              -- nullable; JSON string, the human-corrected version.
                                      --   Kept separate from extracted_data on purpose: the
                                      --   diff between them is the signal for tuning prompts.
    reviewed_at    TEXT              -- nullable; ISO 8601, when a human submitted corrections
    created_at     TEXT              -- ISO 8601 timestamp
    updated_at     TEXT              -- ISO 8601 timestamp
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "ingestion.db"


def get_connection() -> sqlite3.Connection:
    """
    Open a connection to the sqlite file, creating it if it doesn't exist.

    Caller is responsible for closing it -- prefer the transaction()
    helper below, which handles commit and close for you.
    """
    #initialize the database connection and set row_factory to sqlite3.Row2
    conn = sqlite3.connect(DB_PATH)

    conn.row_factory = sqlite3.Row #implement row_factory to return rows as dict-like objects

    return conn


@contextmanager
def transaction():
    """
    Open a connection, commit on success, roll back on error, and always
    close.

    `with sqlite3.connect(...)` commits but does NOT close the
    connection -- fine in a short-lived request handler where refcounting
    cleans up, but a long-running worker polling in a loop would leak a
    connection per iteration. Hence this.
    """
    conn = get_connection()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db() -> None:

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT,
                content_type TEXT,
                size_bytes INTEGER,
                storage_path TEXT,
                status TEXT,
                raw_text TEXT,
                extracted_data TEXT,
                confidence REAL,
                needs_review INTEGER,
                reviewed_data TEXT,
                reviewed_at TEXT,
                created_at TEXT,
                updated_at TEXT
            )
            """
        )
        conn.commit()



def insert_document(
    id: str,
    filename: str,
    content_type: str,
    size_bytes: int,
    storage_path: str,
) -> None:
    """
    Insert a new row when a file is first uploaded.

    Status should start as 'uploaded'. raw_text starts as NULL.
    created_at and updated_at should both be "now" (see the datetime
    module — datetime.now(timezone.utc).isoformat() or similar).

    TODO: write a parameterized INSERT (never use f-strings/% to build
    SQL with user-supplied values — that's how SQL injection happens,
    even in a learning project it's worth building the habit).
    """
    #adds a new docuement within the database with the given parameters and sets the status to 'uploaded' and raw_text to NULL. It also sets the created_at and updated_at timestamps to the current UTC time. 
    with transaction() as conn:
        conn.execute(
            """
            INSERT INTO documents (id, filename, content_type, size_bytes, storage_path, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                filename,
                content_type,
                size_bytes,
                storage_path,
                "uploaded",
                datetime.now(timezone.utc).isoformat(),
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def update_document_status(id: str, status: str, raw_text: str | None = None) -> None:
    """
    Update a row's status (and optionally raw_text) as it moves through
    the pipeline. Also bump updated_at.

    raw_text is only written when the caller actually supplies it. A
    status-only update (e.g. marking a document "failed") must not wipe
    text that was already extracted -- that's exactly the text you want
    when debugging the failure.

    Note the f-string here builds the *column list*, never a value --
    every user-supplied value still goes through a ? placeholder.
    """
    sets = ["status = ?", "updated_at = ?"]
    values = [status, datetime.now(timezone.utc).isoformat()]

    if raw_text is not None:
        sets.append("raw_text = ?")
        values.append(raw_text)

    values.append(id)

    with transaction() as conn:
        conn.execute(
            f"UPDATE documents SET {', '.join(sets)} WHERE id = ?",
            values,
        )


def update_document_extraction(
    id: str,
    status: str,
    extracted_data: str,
    confidence: float,
    needs_review: bool,
) -> None:
    """
    Record the result of running llm_extract + validate against a
    document's raw_text, and move the record to its final status.

    status will be "needs_review" or "completed" (decide which, in
    ingest.py, based on validation_result.needs_review).

    extracted_data is the LLM's structured output -- store it as a JSON
    string (json.dumps(...)), not a Python dict; sqlite3 doesn't have a
    native JSON column type.

    confidence and needs_review come straight off the ValidationResult
    from validate.validate_invoice (needs_review is a bool in Python but
    sqlite3 doesn't have a BOOLEAN type -- it'll store fine as 0/1, just
    don't be surprised when get_document() hands it back as an int).

    TODO: write a parameterized UPDATE ... WHERE id = ?, same shape as
    update_document_status above, but also setting extracted_data,
    confidence, and needs_review. Don't forget to bump updated_at.
    """
    with transaction() as conn:
        conn.execute(
            """
            UPDATE documents
            SET status = ?, extracted_data = ?, confidence = ?, needs_review = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                status,
                extracted_data,
                confidence,
                int(needs_review),
                datetime.now(timezone.utc).isoformat(),
                id,
            ),
        )


def claim_next_document() -> sqlite3.Row | None:
    """
    Atomically claim the oldest queued document for processing, or return
    None if the queue is empty.

    The claim is a single UPDATE ... RETURNING, which matters: SQLite
    serializes writers, so two workers racing on the same row can't both
    win. A naive "SELECT then UPDATE" would let both read 'uploaded'
    before either wrote 'processing', and the document would be
    extracted twice.

    This is the whole queue. The `status` column *is* the work list --
    no broker, no separate queue table. Swapping in Pub/Sub later changes
    where job IDs come from, not the shape of the worker.
    """
    with transaction() as conn:
        cursor = conn.execute(
            """
            UPDATE documents
            SET status = 'processing', updated_at = ?
            WHERE id = (
                SELECT id FROM documents
                WHERE status = 'uploaded'
                ORDER BY created_at
                LIMIT 1
            )
            RETURNING *
            """,
            (datetime.now(timezone.utc).isoformat(),),
        )
        return cursor.fetchone()


def reset_stale_processing(older_than_minutes: int = 15) -> int:
    """
    Return documents stuck in 'processing' back to 'uploaded' so they get
    picked up again. Returns how many were reset.

    Needed because a claim is not a lease: if the worker dies mid-job
    (crash, restart, Ctrl-C), its row stays 'processing' forever and no
    one retries it. Run this at worker startup and periodically.

    The age threshold is what keeps this from stealing jobs out from
    under a worker that's simply still busy -- so it must comfortably
    exceed the slowest realistic run (the LLM call is ~15s here, so
    minutes of headroom is plenty).
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=older_than_minutes)
    with transaction() as conn:
        cursor = conn.execute(
            """
            UPDATE documents
            SET status = 'uploaded', updated_at = ?
            WHERE status = 'processing' AND updated_at < ?
            """,
            (datetime.now(timezone.utc).isoformat(), cutoff.isoformat()),
        )
        return cursor.rowcount


def list_documents(needs_review: bool | None = None, limit: int = 100) -> list[sqlite3.Row]:
    """
    List document records, newest first. Pass needs_review=True to get
    just the human-review queue.

    raw_text and extracted_data are deliberately excluded -- a list view
    doesn't need the full document text, and pulling it for every row
    makes the queue endpoint needlessly heavy.
    """
    sql = """
        SELECT id, filename, size_bytes, status, confidence, needs_review,
               reviewed_at, created_at, updated_at
        FROM documents
    """
    values: list = []

    if needs_review is not None:
        sql += " WHERE needs_review = ?"
        values.append(int(needs_review))

    sql += " ORDER BY created_at DESC LIMIT ?"
    values.append(limit)

    with transaction() as conn:
        return conn.execute(sql, values).fetchall()


def save_review(id: str, reviewed_data: str) -> None:
    """
    Record a reviewer's corrections and close the loop on a document.

    Sets status to 'completed' and clears needs_review -- a document a
    human has looked at is done by definition. extracted_data is left
    untouched so the original LLM output stays available for comparison.
    """
    now = datetime.now(timezone.utc).isoformat()
    with transaction() as conn:
        conn.execute(
            """
            UPDATE documents
            SET reviewed_data = ?, reviewed_at = ?, status = ?, needs_review = ?, updated_at = ?
            WHERE id = ?
            """,
            (reviewed_data, now, "completed", 0, now, id),
        )


def get_document(id: str) -> sqlite3.Row | None:
    """
    Fetch one document record by id.

    TODO: SELECT * FROM documents WHERE id = ?, return the row (or None
    if not found).
    """
    with transaction() as conn:
        cursor = conn.execute(
            """
            SELECT * FROM documents WHERE id = ?
            """,
            (id,),
        )
        return cursor.fetchone()
