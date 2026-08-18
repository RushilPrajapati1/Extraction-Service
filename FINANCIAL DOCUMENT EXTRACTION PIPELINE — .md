FINANCIAL DOCUMENT EXTRACTION PIPELINE — BUILD PLAN
=====================================================
 
GOAL
----
Ingest bank statements, invoices, and loan documents; extract structured
data with an LLM; validate against business rules; expose results via
API and webhook; escalate low-confidence extractions to human review.
 
REPO STRUCTURE (single repo, monorepo)
---------------------------------------
finextract/g
  backend/            Spring Boot (Java) — core API, orchestration, job state
  extraction-worker/  Python — LLM calls, OCR, Ollama pre-screen
  webhook-service/    Node.js + TypeScript — delivery, retries, signing
  frontend/           React + TypeScript — human review UI
  infra/              Docker, Terraform (GCP)
 
PIPELINE STAGES
----------------
1. Ingestion
   - API endpoint accepts PDF/image upload (or GCS bucket trigger)
   - Store raw file in Cloud Storage, generate job ID, queue for processing
   - Queue: Cloud Tasks or Pub/Sub
 
2. Pre-processing
   - Text-based PDFs: extract via pdfplumber / pymupdf
   - Scanned/image docs: OCR (Tesseract or cloud OCR API)
   - Local Ollama-hosted transformer model pre-screens document type and
     scan quality BEFORE the paid LLM call (cost control)
 
3. Extraction (LLM)
   - Send page images/text to a vision-capable LLM (Claude / GPT-4o)
   - Enforce structured/tool-use output against a JSON schema per doc type
   - Model returns a confidence score PER FIELD, not just per document
 
4. Validation
   - Separate rules engine — LLM never self-grades as "valid"
   - Rules: debits/credits reconcile, subtotal + tax = total, dates sane,
     account/routing number formats check out, required fields present
   - Pydantic models work well for schema + rule validation together
 
5. Confidence scoring & routing
   - Combine LLM field confidence + rule pass/fail into an overall score
   - Below threshold -> route to human review queue
   - Above threshold -> auto-complete
 
6. Human review UI
   - React/TS page: document side-by-side with extracted fields
   - Reviewer corrects and submits, closing the loop
 
7. API + webhooks
   - REST endpoint to submit docs and poll/query job status
   - Node.js/TypeScript webhook service fires on completion or escalation
     (retry logic, delivery-status tracking, signature verification)
 
DATA STORAGE
------------
- PostgreSQL (Cloud SQL): validated structured results + job state
  (reliable querying, status tracking across concurrent jobs)
- MongoDB: raw LLM extraction output (flexible schema, varies by doc
  type and evolves as prompts are tuned)
- Elasticsearch: index extracted fields (vendor, date, amount) for
  full-text / faceted search across processed documents
 
BUILD ORDER (risk-first)
-------------------------
1. Single doc type (invoices) -> LLM extraction -> return JSON
   (no validation, no queue yet — prove extraction quality first)
2. Add validation rules + confidence scoring
3. Add async job queue + webhook delivery
4. Add second doc type to prove schema/pipeline generalizes
5. Add Ollama pre-screen pass (cost optimization)
6. Add human review queue/UI last (most UI-heavy, least extraction logic)
 
WHY THIS ISN'T JUST "CALL AN LLM"
-----------------------------------
- Strict schema enforcement so every doc returns the same shape
- Validation catches LLM errors instead of trusting output blindly
- Per-field confidence enables real routing decisions
- Pre-processing handles scans/rotations/multi-page docs before extraction
- Async job orchestration, retries, and webhook delivery make it a
  system, not a script
 