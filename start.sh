#!/usr/bin/env bash
#
# Start every service in the pipeline and stream their logs together.
# Ctrl-C stops all of them.
#
#   ./start.sh
#
# Services:
#   :8000  extraction API      (FastAPI)   accepts uploads, serves records
#          extraction worker   (Python)    drains the queue: OCR -> LLM -> validate
#   :8787  webhook service     (Node/TS)   signs and delivers events, with retries
#   :5173  review UI           (React)     upload, watch, correct

set -euo pipefail
cd "$(dirname "$0")"

PIDS=()

cleanup() {
  echo ""
  echo "Shutting down..."
  # SIGTERM lets the worker finish its current document rather than
  # orphaning it mid-LLM-call.
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "Stopped."
}
trap cleanup EXIT INT TERM

# --- preflight -------------------------------------------------------------

if ! curl -sf http://localhost:11434/api/version > /dev/null 2>&1; then
  echo "WARNING: Ollama doesn't appear to be running on :11434."
  echo "         Extraction will fail until it is. Start it with: ollama serve"
  echo ""
fi

if [ ! -d webhook-service/node_modules ]; then
  echo "Installing webhook-service dependencies..."
  (cd webhook-service && npm install --silent)
fi

if [ ! -d front-end/node_modules ]; then
  echo "Installing front-end dependencies..."
  (cd front-end && npm install --silent)
fi

# --- start -----------------------------------------------------------------

echo "Starting services..."

(cd extraction-worker && python3 -m uvicorn ingest:app --port 8000 2>&1 | sed 's/^/[api]     /') &
PIDS+=($!)

(cd webhook-service && node src/index.ts 2>&1 | sed 's/^/[webhook] /') &
PIDS+=($!)

# Give the API a moment to create the database before the worker touches it.
sleep 2

(cd extraction-worker && python3 worker.py 2>&1 | sed 's/^/[worker]  /') &
PIDS+=($!)

(cd front-end && npm run dev 2>&1 | sed 's/^/[ui]      /') &
PIDS+=($!)

sleep 3
echo ""
echo "  Review UI    http://localhost:5173"
echo "  API docs     http://localhost:8000/docs"
echo "  Webhooks     http://localhost:8787/deliveries"
echo ""
echo "Ctrl-C to stop everything."
echo ""

wait
