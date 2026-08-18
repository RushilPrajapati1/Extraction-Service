"""
Raw file storage — local disk, standing in for Cloud Storage per the
build plan. Same idea, much smaller blast radius while you're learning:
a folder on disk instead of a GCS bucket.

Later, swapping this for actual Cloud Storage means changing what's
inside save_upload() (upload bytes to a bucket, return a gs:// URI
instead of a local path) without touching any of the calling code in
ingest.py — that's the point of giving it its own module now.
"""

from pathlib import Path

UPLOAD_DIR = Path(__file__).parent / "uploads"


def save_upload(document_id: str, filename: str, file_bytes: bytes) -> str:
    """
    Persist the raw uploaded file to disk and return the path it was
    saved to (this is what goes into documents.storage_path).

    Think about:
    - UPLOAD_DIR needs to exist before you write into it (mkdir).
    - Don't trust `filename` directly as part of the path — a
      malicious client could send a filename like "../../etc/passwd".
      Build the on-disk name from document_id instead (e.g.
      f"{document_id}.pdf"), and keep the original `filename` only as
      metadata in the DB record.

    TODO: create UPLOAD_DIR if missing, write file_bytes to
    UPLOAD_DIR / f"{document_id}.pdf", return the path as a string.
    """
    #create the upload directory if it doesn't exist
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    #create the file path using document_id
    file_path = UPLOAD_DIR / f"{document_id}.pdf"

    #write the file bytes to the file path
    with open(file_path, "wb") as f:
        f.write(file_bytes)

    #return the file path as a string
    return str(file_path)
