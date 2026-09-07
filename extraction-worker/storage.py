"""
Raw file storage -- one interface, two backends.

The build plan calls for Cloud Storage; local disk was the stand-in while
the pipeline was being proven out. Both now live behind the same three
functions, chosen at import time by the STORAGE_BACKEND environment
variable:

    STORAGE_BACKEND=local  (default)  -> ./uploads/<document_id>.pdf
    STORAGE_BACKEND=gcs               -> gs://$GCS_BUCKET/<prefix><document_id>.pdf

What goes into documents.storage_path is whatever save_upload() returns,
and it is deliberately OPAQUE: a local path in one case, a gs:// URI in
the other. Callers must not parse it, os.path.exists() it, or open() it
-- that is what read_document() and document_exists() are for. Two call
sites used to do exactly that (ingest.py served it with FileResponse,
worker.py open()'d it), which is why swapping backends was never as
simple as the old docstring claimed. Routing every access through this
module is what actually makes the seam real.

The GCS client is imported lazily, inside the backend that needs it, so
local development doesn't require google-cloud-storage to be installed.
"""

import os
from pathlib import Path

UPLOAD_DIR = Path(__file__).parent / "uploads"

GCS_SCHEME = "gs://"


def _backend_name() -> str:
    """
    Read at call time rather than caching at import, so tests can flip
    backends with monkeypatch.setenv without reimporting the module.
    """
    return os.environ.get("STORAGE_BACKEND", "local").strip().lower()


def _object_name(document_id: str) -> str:
    """
    Build the stored object's name from the document id alone.

    Never from the client-supplied filename: a caller could send
    "../../etc/passwd" and walk out of the upload directory. The original
    filename is kept as metadata on the DB record instead, where it can't
    influence where bytes land.
    """
    prefix = os.environ.get("GCS_PREFIX", "")
    return f"{prefix}{document_id}.pdf"


# --- GCS helpers -----------------------------------------------------------


def _gcs_bucket_name() -> str:
    bucket = os.environ.get("GCS_BUCKET")
    if not bucket:
        raise RuntimeError(
            "STORAGE_BACKEND=gcs requires GCS_BUCKET to be set "
            "(terraform apply prints it as `bucket_name`)."
        )
    return bucket


def _gcs_client():
    """
    Lazily construct a Storage client.

    Split out as its own function so tests can monkeypatch this single
    seam and hand back a fake, instead of needing credentials or network.
    """
    from google.cloud import storage as gcs  # imported lazily, see module docstring

    return gcs.Client()


def _split_gs_uri(uri: str) -> tuple[str, str]:
    """Turn 'gs://bucket/a/b.pdf' into ('bucket', 'a/b.pdf')."""
    if not uri.startswith(GCS_SCHEME):
        raise ValueError(f"Not a gs:// URI: {uri!r}")
    bucket, _, object_name = uri[len(GCS_SCHEME):].partition("/")
    if not bucket or not object_name:
        raise ValueError(f"Malformed gs:// URI: {uri!r}")
    return bucket, object_name


# --- public interface ------------------------------------------------------


def save_upload(document_id: str, filename: str, file_bytes: bytes) -> str:
    """
    Persist the raw uploaded file and return the location it was saved to.

    The return value is what goes into documents.storage_path, and its
    shape depends on the backend -- a filesystem path locally, a gs://
    URI on GCS. Treat it as an opaque handle and pass it back to
    read_document() / document_exists() rather than interpreting it.

    `filename` is accepted for interface symmetry but never used to build
    the storage location (see _object_name).
    """
    if _backend_name() == "gcs":
        bucket_name = _gcs_bucket_name()
        object_name = _object_name(document_id)
        blob = _gcs_client().bucket(bucket_name).blob(object_name)
        blob.upload_from_string(file_bytes, content_type="application/pdf")
        return f"{GCS_SCHEME}{bucket_name}/{object_name}"

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    file_path = UPLOAD_DIR / _object_name(document_id)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "wb") as f:
        f.write(file_bytes)
    return str(file_path)


def read_document(storage_path: str) -> bytes:
    """
    Read back the bytes previously stored at `storage_path`.

    Raises FileNotFoundError if the object is gone, matching what the
    local backend already does, so callers get one exception type to
    handle regardless of where the bytes actually live.
    """
    if storage_path.startswith(GCS_SCHEME):
        bucket_name, object_name = _split_gs_uri(storage_path)
        blob = _gcs_client().bucket(bucket_name).blob(object_name)
        if not blob.exists():
            raise FileNotFoundError(storage_path)
        return blob.download_as_bytes()

    with open(storage_path, "rb") as f:
        return f.read()


def document_exists(storage_path: str) -> bool:
    """
    Whether the stored object is still there.

    Used by the API before serving a file, so a row whose bytes have been
    deleted out from under it 404s cleanly instead of raising.
    """
    if not storage_path:
        return False

    if storage_path.startswith(GCS_SCHEME):
        bucket_name, object_name = _split_gs_uri(storage_path)
        return _gcs_client().bucket(bucket_name).blob(object_name).exists()

    return os.path.exists(storage_path)
