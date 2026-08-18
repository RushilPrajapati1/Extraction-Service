"""
Background worker -- drains the document queue.

Run as its own process, alongside the API:

    python3 worker.py

The API's job is now only to accept a file and record it. Everything
expensive -- text extraction, the LLM call, validation -- happens here,
out of the request path. That's the whole point of the split: a 15-second
LLM call has no business holding an HTTP connection open.

The "queue" is the documents table itself: rows with status 'uploaded'
are pending work (see db.claim_next_document). No broker to run.

Known limits, deliberately -- this is a single-machine dev worker:
  - Polling, not push. Idle workers wake up every POLL_INTERVAL seconds.
  - No retry limit. A document that fails is marked 'failed' and left
    alone; it won't be retried until something sets it back to
    'uploaded'.
  - Crash recovery is time-based (reset_stale_processing), not a real
    lease.
"""

import json
import signal
import sys
import time

import pypdfium2 as pdfium

import db
import events
import llm_extract
import validate

POLL_INTERVAL = 2.0          # seconds to sleep when the queue is empty
STALE_SWEEP_INTERVAL = 60.0  # seconds between stale-job sweeps

_shutdown = False


def _handle_signal(signum, frame):
    """
    Ask the loop to stop after the current document.

    Deliberately does not abort mid-job: a document interrupted between
    the LLM call and the DB write would be left in 'processing' with no
    result, which is exactly the state the stale sweeper exists to clean
    up. Finishing the current job avoids creating that mess in the first
    place.
    """
    global _shutdown
    _shutdown = True
    print("\n[worker] shutdown requested; finishing current document...", flush=True)


def extract_text(storage_path: str) -> str:
    """Pull the text layer out of a PDF on disk."""
    with open(storage_path, "rb") as f:
        file_bytes = f.read()

    pdf = pdfium.PdfDocument(file_bytes)
    try:
        page_texts = []
        for page in pdf:
            textpage = page.get_textpage()
            try:
                page_texts.append(textpage.get_text_range())
            finally:
                textpage.close()
            page.close()
        return "\n".join(page_texts)
    finally:
        pdf.close()


def process_document(document: dict) -> None:
    """
    Run one document through the full pipeline: text -> LLM -> validation.

    Any exception marks the document 'failed' and re-raises, so the
    caller can log it. The record keeps whatever raw_text we managed to
    extract (see db.update_document_status) -- that's the useful
    debugging artifact when an LLM call is what blew up.
    """
    document_id = document["id"]

    try:
        raw_text = extract_text(document["storage_path"])
        # Stay in 'processing' -- the document is still in flight, and
        # 'processing' is the only state the stale sweeper reclaims. A
        # separate 'text_extracted' status here would orphan the document
        # if the worker died during the LLM call below (the longest, most
        # crash-prone phase). Whether text extraction succeeded is
        # already visible from raw_text being non-null.
        db.update_document_status(document_id, "processing", raw_text=raw_text)

        extracted_data = llm_extract.extract_invoice(raw_text)
        validation_result = validate.validate_invoice(extracted_data)

        status = "needs_review" if validation_result.needs_review else "completed"
        db.update_document_extraction(
            document_id,
            status,
            json.dumps(extracted_data),
            validation_result.confidence,
            validation_result.needs_review,
        )
        print(
            f"[worker] {document_id} -> {status} "
            f"(confidence {validation_result.confidence:.2f})",
            flush=True,
        )

        # Announce the terminal state. Published after the DB write, so a
        # subscriber that immediately fetches the document sees the
        # finished record rather than racing it.
        events.publish(
            f"document.{status}",
            document_id,
            {
                "filename": document.get("filename"),
                "confidence": validation_result.confidence,
                "needs_review": validation_result.needs_review,
                "errors": validation_result.errors,
                "warnings": validation_result.warnings,
                "extracted_data": extracted_data,
            },
        )
    except Exception as e:
        db.update_document_status(document_id, "failed")
        events.publish(
            "document.failed",
            document_id,
            {"filename": document.get("filename"), "error": str(e)},
        )
        raise


def main() -> int:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    db.init_db()

    # Anything left 'processing' from a previous run is orphaned -- no
    # worker is coming back for it. Requeue before taking new work.
    requeued = db.reset_stale_processing(older_than_minutes=0)
    if requeued:
        print(f"[worker] requeued {requeued} orphaned document(s)", flush=True)

    print(f"[worker] polling every {POLL_INTERVAL}s; Ctrl-C to stop", flush=True)
    last_sweep = time.monotonic()

    while not _shutdown:
        document = db.claim_next_document()

        if document is None:
            # Idle. Periodically reclaim jobs from workers that died
            # mid-flight (a different case from the startup sweep above:
            # here another worker may still be alive, hence the age
            # threshold rather than 0).
            if time.monotonic() - last_sweep > STALE_SWEEP_INTERVAL:
                reclaimed = db.reset_stale_processing()
                if reclaimed:
                    print(f"[worker] reclaimed {reclaimed} stale document(s)", flush=True)
                last_sweep = time.monotonic()

            time.sleep(POLL_INTERVAL)
            continue

        print(f"[worker] claimed {document['id']} ({document['filename']})", flush=True)
        try:
            process_document(dict(document))
        except Exception as e:
            # Keep the loop alive: one poisoned document shouldn't take
            # the worker down and stall everything behind it.
            print(f"[worker] FAILED {document['id']}: {e}", flush=True)

    print("[worker] stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
