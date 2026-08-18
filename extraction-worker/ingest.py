import json
import os
import uuid

from fastapi import  FastAPI, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

# Note: no pypdfium2 / llm_extract / validate here any more -- the API
# doesn't do pipeline work, it only accepts files and serves records.
# That lives in worker.py.
import db
import storage

app = FastAPI()

# The review UI runs on its own dev server (Vite, port 5173), so the
# browser treats these as cross-origin requests. Wide-open CORS is fine
# for local development; lock this down before this goes anywhere real.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    # Creates the documents table if it doesn't already exist, so it's
    # ready before any request comes in.
    db.init_db()


@app.post("/ingest/", status_code=202)
async def ingest(file: UploadFile = File(...)):
    """
    Accept a PDF, persist the raw bytes, and queue it for processing.

    Returns immediately with status 'uploaded' -- text extraction and the
    LLM call happen in worker.py, out of the request path. Poll
    GET /documents/{document_id} to watch it progress through
    'processing' -> 'text_extracted' -> 'needs_review' | 'completed'.

    202 Accepted rather than 200: the work has been queued, not done.
    """
    if file.content_type != "application/pdf":
         raise HTTPException(status_code=400, detail="Invalid file type. Only PDF files are allowed.")

    document_id = str(uuid.uuid4())
    file_bytes = await file.read()
    storage_path = storage.save_upload(document_id, file.filename, file_bytes)
    db.insert_document(document_id, file.filename, file.content_type, len(file_bytes), storage_path)

    return {"document_id": document_id, "status": "uploaded"}



@app.get("/documents")
async def list_documents(needs_review: bool | None = None, limit: int = 100):
    """
    List document records, newest first. The review UI calls this with
    ?needs_review=true to populate its queue.
    """
    rows = db.list_documents(needs_review=needs_review, limit=limit)
    return {"documents": [dict(row) for row in rows]}


@app.get("/documents/{document_id}")
async def get_document(document_id: str):
    """
    Look up one ingestion record by id, including the extracted data.

    extracted_data and reviewed_data are stored as JSON strings; parse
    them here so the client gets real objects instead of strings it has
    to JSON.parse itself.
    """
    document = db.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    result = dict(document)
    for json_field in ("extracted_data", "reviewed_data"):
        if result.get(json_field):
            result[json_field] = json.loads(result[json_field])
    return result


@app.get("/documents/{document_id}/file")
async def get_document_file(document_id: str):
    """
    Serve the original uploaded PDF, so the review UI can show the
    document side-by-side with the extracted fields.
    """
    document = db.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    storage_path = document["storage_path"]
    if not storage_path or not os.path.exists(storage_path):
        raise HTTPException(status_code=404, detail="Document file not found on disk")

    return FileResponse(
        storage_path,
        media_type="application/pdf",
        filename=document["filename"],
    )


@app.post("/documents/{document_id}/retry")
async def retry_document(document_id: str):
    """
    Requeue a failed document by putting it back to 'uploaded'.

    The worker's claim query only looks at 'uploaded' rows, so this is
    the whole retry mechanism -- no separate retry table, no dead-letter
    queue. The raw file is still on disk, so the pipeline reruns from
    the top.
    """
    document = db.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if document["status"] not in ("failed", "needs_review", "completed"):
        # In-flight documents would be double-processed if requeued.
        raise HTTPException(
            status_code=409,
            detail=f"Cannot retry a document with status '{document['status']}'",
        )

    db.update_document_status(document_id, "uploaded")
    return {"document_id": document_id, "status": "uploaded"}


@app.post("/documents/{document_id}/review")
async def submit_review(document_id: str, reviewed_data: dict = Body(...)):
    """
    Accept a reviewer's corrected fields, closing the loop on a document.

    The corrections are stored separately from the LLM's original output
    (see db.save_review) so the two stay comparable.
    """
    document = db.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    db.save_review(document_id, json.dumps(reviewed_data))
    return {"document_id": document_id, "status": "completed"}