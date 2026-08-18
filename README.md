# Financial Document Extraction Pipeline

Ingests PDFs, extracts structured data with a local LLM, validates it against
business rules, routes low-confidence results to human review, and fires signed
webhooks when documents reach a terminal state.

```
                    ┌──────────────┐
  upload ─────────▶ │  API :8000   │ ── saves file + row (status: uploaded) ──┐
                    │  (FastAPI)   │                                          │
                    └──────────────┘                                          │
                            ▲                                        ┌────────▼────────┐
                            │ reads records                          │   SQLite        │
                    ┌───────┴──────┐                                 │  (the queue)    │
                    │  UI :5173    │                                 └────────┬────────┘
                    │  (React)     │                                          │ claims 'uploaded'
                    └───────┬──────┘                                 ┌────────▼────────┐
                            │ reads delivery log                     │    worker       │
                    ┌───────▼──────┐                                 │  text → LLM →   │
                    │ webhook:8787 │ ◀──── publishes events ───────── │   validate      │
                    │  (Node/TS)   │                                 └─────────────────┘
                    └──────┬───────┘
                           └────▶ signed POST to subscribers (retries w/ backoff)
```

## Running it

```bash
./start.sh
```

Then open **http://localhost:5173**.

Requires [Ollama](https://ollama.com) running locally with the `mistral` model
(`ollama pull mistral`). No API keys — extraction runs entirely on your machine.

To run pieces individually:

```bash
cd extraction-worker && python3 -m uvicorn ingest:app --port 8000   # API
cd extraction-worker && python3 worker.py                           # worker
cd webhook-service   && node src/index.ts                           # webhooks
cd front-end         && npm run dev                                 # UI
```

## How a document flows

| Status         | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `uploaded`     | Queued. The worker's claim query looks for exactly this.     |
| `processing`   | A worker owns it. The only in-flight state.                  |
| `needs_review` | Terminal. Confidence below threshold, or a rule failed.      |
| `completed`    | Terminal. Passed validation, or a human corrected it.        |
| `failed`       | Terminal. Something threw. Retryable from the UI.            |

`raw_text != NULL` means text extraction succeeded — there's deliberately no
separate `text_extracted` status, because a status the stale sweeper doesn't
watch is a status a document can get orphaned in.

## Components

### `extraction-worker/` (Python)

| File              | Role                                                          |
| ----------------- | ------------------------------------------------------------- |
| `ingest.py`       | FastAPI app. Accepts uploads, serves records. Does no pipeline work. |
| `worker.py`       | Standalone process. Claims queued documents and runs the pipeline. |
| `db.py`           | Plain sqlite3, no ORM. Every SQL statement is visible.        |
| `llm_extract.py`  | Local Ollama call, constrained to a JSON schema.              |
| `validate.py`     | Business rules + confidence scoring. Independent of the LLM.  |
| `storage.py`      | Raw file storage (stands in for Cloud Storage).               |
| `events.py`       | Publishes events to webhook-service. Never fails a document.  |

**The queue is the `documents` table.** `claim_next_document()` is a single
`UPDATE ... RETURNING`, so racing workers can't double-claim — run as many
worker processes as you like. Jobs orphaned by a dead worker are requeued by a
time-based sweep.

### `webhook-service/` (Node + TypeScript)

Signs payloads with HMAC-SHA256, retries with exponential backoff (2s, 8s, 32s,
128s; 5 attempts), and persists every attempt so you can see what happened.

Runs `.ts` directly — Node 22+ strips types natively, so there's no build step.

| Endpoint                | Purpose                                     |
| ----------------------- | ------------------------------------------- |
| `POST /events`          | Publish an event (the worker calls this).   |
| `GET/POST /subscriptions` | Manage subscriber endpoints.              |
| `GET /deliveries`       | Delivery log with attempts and errors.      |
| `POST /sink`            | Built-in subscriber; verifies the signature.|

A default subscription pointing at `/sink` is seeded on first run, so webhooks
are demonstrable without an external receiver.

Verifying a signature, as a subscriber would:

```
HMAC-SHA256(raw_request_body, subscription_secret) == X-Webhook-Signature
```

Verify against the **raw bytes**, not a re-serialized object — key order and
whitespace change the hash.

### `front-end/` (React + TypeScript)

Upload PDFs, watch them move through the pipeline (polling only while something
is in flight), correct extracted fields side-by-side with the original document,
and inspect webhook deliveries.

Human corrections are stored in `reviewed_data`, **separately** from the model's
`extracted_data`. The diff between them is the signal for improving prompts.

## Known limitations

These are deliberate, not oversights — they're the seams where this would grow
into something production-shaped.

- **The local model under-fills the schema.** Mistral routinely omits `subtotal`
  and only scores some confidence fields. Because validation guards on
  `is not None`, the `subtotal + tax == total` rule often doesn't run at all —
  the strongest check is frequently inert. Fixing this means either requiring
  `subtotal` in the schema or deriving it.
- **Event delivery isn't durable.** If webhook-service is down when a document
  finishes, that event is lost. A real system writes to an outbox table in the
  same transaction as the status update, then drains it separately.
- **The queue is single-machine.** SQLite polling doesn't survive being spread
  across hosts. Swapping in Pub/Sub changes where the worker gets job IDs, not
  the shape of the worker.
- **No auth anywhere.** CORS is pinned to localhost and there are no
  credentials on any endpoint.
- **Line items are read-only** in the review UI — displayed and carried through,
  but not editable.
