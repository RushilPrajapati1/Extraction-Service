# Financial Document Extraction Pipeline

**Live:** http://34.121.149.224 · [API docs](http://34.121.149.224/api/docs) · [Deployments](https://github.com/RushilPrajapati1/Extraction-Service/deployments)
*(single GCE VM, see [`deploy/gcp/deploy.sh`](deploy/gcp/deploy.sh); access is IP-restricted since the app has no auth)*

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

### Tests

Unit tests for the storage seam:

```bash
cd extraction-worker && pip install -r requirements-dev.txt && pytest
```

End-to-end, driving the whole stack through the browser:

```bash
cd e2e && npm install && npx playwright install chromium && npm test
```

The e2e suite starts every service itself, against throwaway databases,
with Ollama replaced by a fixture so the pipeline's behaviour is what's
under test rather than the model's mood. `e2e/tests/known-gaps.spec.ts`
is worth reading on its own: it states what the system *should* do where
it currently doesn't. See [e2e/README.md](e2e/README.md).

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
| `storage.py`      | Raw file storage. Local disk or GCS, via `STORAGE_BACKEND`.   |
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

## Unverifiable is not valid

The subtle failure mode in a validation layer is guarding every rule on
`if value is not None` — a model that omits the fields a rule needs then scores
identically to one that reconciled perfectly. Absence of evidence reads as
evidence of correctness.

`validate.py` avoids this three ways:

1. **Derive what can be derived, from independent evidence.** A missing
   `subtotal` is recovered by summing `line_items`. Deriving it as `total - tax`
   would be circular — the subsequent `subtotal + tax == total` check could never
   fail, so it would look like verification while proving nothing.
2. **Track what couldn't be checked.** `checks_run` and `checks_skipped` are on
   every result, and skipped checks cost confidence.
3. **Gate on the critical check.** Reconciling the total is *the* check on a
   financial document. If it couldn't run, the document goes to review no matter
   how confident the model claims to be — otherwise a model that rates itself
   1.0 everywhere buys its way past an unverified total, which is backwards:
   self-reported confidence is the thing under scrutiny.

## Known limitations

These are deliberate, not oversights — they're the seams where this would grow
into something production-shaped.

- **The local model still under-fills the schema.** Mistral often skips
  confidence scores for some fields, and mis-reads line items. Validation now
  catches this rather than ignoring it (see *Unverifiable is not valid* below),
  but the extraction quality itself is unimproved — that's a prompt/model
  problem, not a validation one.
- **Only invoices.** No bank statements, no loan documents -- so the build
  plan's claim that the schema and pipeline generalize is untested. There is
  no `doc_type` column at all: the type is implied by the single schema in
  `llm_extract.py`, which means routing, validation and storage all silently
  assume "invoice".
- **No OCR.** Text-layer PDFs only. `extract_text()` pulls the embedded text
  layer via pypdfium2; a scanned document has none, so it yields an empty
  string, which is then sent to the model as if it were the document. The
  failure is silent -- the LLM hallucinates against nothing rather than the
  pipeline reporting "this document has no readable text".
- **Event delivery isn't durable.** If webhook-service is down when a document
  finishes, that event is lost. A real system writes to an outbox table in the
  same transaction as the status update, then drains it separately.
- **The queue is single-machine.** SQLite polling doesn't survive being spread
  across hosts, and `claim_next_document()` is only safe *because* SQLite
  serializes writers -- under Postgres MVCC the same query lets two workers
  claim one row. Moving job state to Cloud SQL needs
  `SELECT ... FOR UPDATE SKIP LOCKED`, not a new connection string.
- **No auth anywhere.** CORS is pinned to localhost and there are no
  credentials on any endpoint.
- **Line items are read-only** in the review UI — displayed and carried through,
  but not editable.
