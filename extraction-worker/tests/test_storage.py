"""
Storage layer tests.

The central claim this file exists to check is INTERCHANGEABILITY: the
local and GCS backends must be substitutable behind save_upload() /
read_document() / document_exists() without any caller noticing. So the
core tests are parametrized over both backends and assert identical
behaviour, rather than testing each backend in isolation where a
divergence could hide.

Nothing here touches the network. The GCS backend is exercised against
FakeGCSClient (see fake_gcs.py), patched in at storage._gcs_client --
the one seam the module exposes for exactly this purpose.
"""

import pytest

import storage
from fake_gcs import FakeGCSClient

BUCKET = "extraction-documents-test"
PDF_BYTES = b"%PDF-1.7\nnot really a pdf, but bytes are bytes\n%%EOF"


@pytest.fixture
def local_backend(monkeypatch, tmp_path):
    """Local backend writing into a throwaway directory."""
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.delenv("GCS_PREFIX", raising=False)
    monkeypatch.setattr(storage, "UPLOAD_DIR", tmp_path / "uploads")
    return None


@pytest.fixture
def gcs_backend(monkeypatch):
    """GCS backend wired to an in-memory fake."""
    fake = FakeGCSClient()
    monkeypatch.setenv("STORAGE_BACKEND", "gcs")
    monkeypatch.setenv("GCS_BUCKET", BUCKET)
    monkeypatch.delenv("GCS_PREFIX", raising=False)
    monkeypatch.setattr(storage, "_gcs_client", lambda: fake)
    return fake


@pytest.fixture(params=["local", "gcs"])
def any_backend(request):
    """
    Both backends, one at a time.

    Every test using this fixture runs twice and must pass identically --
    that equality IS the compatibility guarantee.
    """
    return request.getfixturevalue(f"{request.param}_backend")


# --- the interchangeability contract ---------------------------------------


def test_round_trip_returns_the_same_bytes(any_backend):
    path = storage.save_upload("doc-1", "invoice.pdf", PDF_BYTES)
    assert storage.read_document(path) == PDF_BYTES


def test_saved_document_exists(any_backend):
    path = storage.save_upload("doc-2", "invoice.pdf", PDF_BYTES)
    assert storage.document_exists(path) is True


def test_unsaved_document_does_not_exist(any_backend):
    # Same shape of handle as save_upload would produce, but never written.
    absent = (
        f"gs://{BUCKET}/never-written.pdf"
        if storage._backend_name() == "gcs"
        else str(storage.UPLOAD_DIR / "never-written.pdf")
    )
    assert storage.document_exists(absent) is False


def test_empty_storage_path_does_not_exist(any_backend):
    # A row whose storage_path was never populated must not blow up the
    # API's 404 check.
    assert storage.document_exists("") is False
    assert storage.document_exists(None) is False


def test_reading_a_missing_document_raises_filenotfound(any_backend):
    """
    Both backends must raise the SAME exception type for a missing
    object. Without this the GCS backend would surface google's own
    NotFound and every caller's error handling would need a second
    branch -- which is precisely the kind of leak that makes a
    "swappable" backend not swappable.
    """
    absent = (
        f"gs://{BUCKET}/never-written.pdf"
        if storage._backend_name() == "gcs"
        else str(storage.UPLOAD_DIR / "never-written.pdf")
    )
    with pytest.raises(FileNotFoundError):
        storage.read_document(absent)


def test_documents_are_isolated_by_id(any_backend):
    a = storage.save_upload("doc-a", "a.pdf", b"AAAA")
    b = storage.save_upload("doc-b", "b.pdf", b"BBBB")
    assert a != b
    assert storage.read_document(a) == b"AAAA"
    assert storage.read_document(b) == b"BBBB"


def test_saving_the_same_id_twice_overwrites(any_backend):
    # Matters for the retry path: /documents/{id}/retry reruns the
    # pipeline against the same id, and re-upload must not duplicate.
    storage.save_upload("doc-3", "v1.pdf", b"first")
    path = storage.save_upload("doc-3", "v2.pdf", b"second")
    assert storage.read_document(path) == b"second"


# --- path traversal --------------------------------------------------------


@pytest.mark.parametrize(
    "hostile_filename",
    [
        "../../etc/passwd",
        "../../../root/.ssh/id_rsa",
        "/etc/shadow",
        "..\\..\\windows\\system32\\config\\sam",
    ],
)
def test_client_filename_cannot_escape_storage(any_backend, hostile_filename):
    """
    The client-supplied filename must never influence where bytes land.
    save_upload takes it only as metadata; the location comes from the
    document id alone.
    """
    path = storage.save_upload("doc-safe", hostile_filename, PDF_BYTES)
    assert "etc" not in path
    assert ".." not in path
    assert path.endswith("doc-safe.pdf")


# --- backend-specific details ----------------------------------------------


def test_local_backend_creates_upload_dir_on_demand(local_backend):
    assert not storage.UPLOAD_DIR.exists()
    storage.save_upload("doc-4", "invoice.pdf", PDF_BYTES)
    assert storage.UPLOAD_DIR.is_dir()


def test_local_backend_returns_a_filesystem_path(local_backend):
    path = storage.save_upload("doc-5", "invoice.pdf", PDF_BYTES)
    assert not path.startswith("gs://")
    assert path == str(storage.UPLOAD_DIR / "doc-5.pdf")


def test_gcs_backend_returns_a_gs_uri(gcs_backend):
    path = storage.save_upload("doc-6", "invoice.pdf", PDF_BYTES)
    assert path == f"gs://{BUCKET}/doc-6.pdf"


def test_gcs_backend_sets_pdf_content_type(gcs_backend):
    """
    Without this the review UI's <iframe> gets application/octet-stream
    from a signed URL and offers a download instead of rendering.
    """
    storage.save_upload("doc-7", "invoice.pdf", PDF_BYTES)
    assert gcs_backend.content_type_of(BUCKET, "doc-7.pdf") == "application/pdf"


def test_gcs_prefix_is_applied_when_set(monkeypatch, gcs_backend):
    monkeypatch.setenv("GCS_PREFIX", "documents/")
    path = storage.save_upload("doc-8", "invoice.pdf", PDF_BYTES)
    assert path == f"gs://{BUCKET}/documents/doc-8.pdf"
    assert storage.read_document(path) == PDF_BYTES


def test_gcs_backend_without_bucket_fails_loudly(monkeypatch):
    """
    Misconfiguration must fail at the first upload, not silently write
    somewhere unexpected.
    """
    monkeypatch.setenv("STORAGE_BACKEND", "gcs")
    monkeypatch.delenv("GCS_BUCKET", raising=False)
    with pytest.raises(RuntimeError, match="GCS_BUCKET"):
        storage.save_upload("doc-9", "invoice.pdf", PDF_BYTES)


def test_backend_defaults_to_local_when_unset(monkeypatch):
    monkeypatch.delenv("STORAGE_BACKEND", raising=False)
    assert storage._backend_name() == "local"


def test_backend_selection_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "  GCS ")
    assert storage._backend_name() == "gcs"


@pytest.mark.parametrize("bad_uri", ["gs://", "gs://bucket-only", "gs:///no-bucket"])
def test_malformed_gs_uris_are_rejected(bad_uri):
    with pytest.raises(ValueError):
        storage._split_gs_uri(bad_uri)


def test_split_gs_uri_keeps_nested_object_names_intact():
    bucket, name = storage._split_gs_uri("gs://my-bucket/documents/2026/doc.pdf")
    assert bucket == "my-bucket"
    assert name == "documents/2026/doc.pdf"
