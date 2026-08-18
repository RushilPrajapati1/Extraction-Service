"""
LLM-based structured extraction — local Ollama model, no external API.

Takes the raw text pulled out of a PDF (see ingest.py) and asks a local
model to return it as structured JSON matching INVOICE_SCHEMA, with a
confidence score per field so the pipeline can later route low-confidence
extractions to human review (per the build plan).

No validation happens here — this module's only job is "text in, JSON out".
Business-rule validation (debits/credits reconcile, required fields present,
etc.) is a separate concern, on purpose: the LLM should never be the thing
that grades its own output.
"""

import json

import ollama

MODEL = "mistral"

# One doc type for now (invoices), per the build plan's risk-first order:
# prove extraction quality on a single doc type before generalizing.
INVOICE_SCHEMA = {
    "type": "object",
    "properties": {
        "vendor_name": {"type": "string"},
        "invoice_date": {"type": "string", "description": "ISO 8601 date, e.g. 2026-01-15"},
        "invoice_number": {"type": "string"},
        "line_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "quantity": {"type": "number"},
                    "unit_price": {"type": "number"},
                    "amount": {"type": "number"},
                },
                "required": ["description", "amount"],
            },
        },
        "subtotal": {"type": "number"},
        "tax": {"type": "number"},
        "total": {"type": "number"},
        "confidence": {
            "type": "object",
            "description": "Per-field confidence scores, 0.0-1.0. Lower for anything unclear, missing, or guessed.",
            "properties": {
                "vendor_name": {"type": "number"},
                "invoice_date": {"type": "number"},
                "invoice_number": {"type": "number"},
                "line_items": {"type": "number"},
                "total": {"type": "number"},
            },
        },
    },
    "required": ["vendor_name", "invoice_date", "total", "confidence"],
}

SYSTEM_PROMPT = (
    "You extract structured data from invoice text. Return ONLY JSON matching "
    "the given schema -- no prose, no markdown fences. If a field isn't present "
    "in the text, omit it or use null rather than guessing, and reflect that "
    "with a low confidence score for that field."
)


def extract_invoice(raw_text: str, retries: int = 1) -> dict:
    """
    Send raw invoice text to the local Ollama model and get back structured
    JSON matching INVOICE_SCHEMA.

    Open models are less reliable than hosted structured-output APIs at
    actually respecting the schema, so this retries once on a parse failure
    before giving up. Raises json.JSONDecodeError if all attempts fail --
    the caller decides how to handle that (e.g. mark the document "failed").
    """
    last_error: Exception | None = None

    for attempt in range(retries + 1):
        response = ollama.chat(
            model=MODEL,
            format=INVOICE_SCHEMA,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": raw_text},
            ],
        )
        content = response["message"]["content"]

        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            last_error = e
            continue

    raise last_error
