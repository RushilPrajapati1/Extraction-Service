# One image for both the API and the worker; docker-compose picks the
# command. Keeping them on the same image guarantees they agree on the
# schema in db.py, which they share through a mounted volume.
FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# Runtime state lives on a volume, never in the image.
ENV INGEST_DB_PATH=/data/ingestion.db \
    UPLOAD_DIR=/data/uploads

EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "ingest:app", "--host", "0.0.0.0", "--port", "8000"]
