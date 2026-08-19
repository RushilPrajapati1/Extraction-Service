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
    # subtotal and line_items are required because validation depends on
    # them: without one of the two there is nothing to reconcile the
    # total against, and the arithmetic checks silently can't run.
    # Marking them required doesn't force the model's hand (open models
    # treat schemas loosely), but it measurably improves the hit rate --
    # and validate.py penalizes what's still missing.
    "required": [
        "vendor_name",
        "invoice_date",
        "total",
        "subtotal",
        "line_items",
        "confidence",
    ],
}

SYSTEM_PROMPT = (
    "You extract structured data from invoice text. Return ONLY JSON matching "
    "the given schema -- no prose, no markdown fences.\n"
    "\n"
    "Include EVERY field the schema requires. In particular:\n"
    "- line_items: one entry per billed line, each with its amount.\n"
    "- subtotal: the pre-tax total. If the invoice doesn't print one, add up "
    "the line item amounts and use that.\n"
    "- tax: the tax amount. Use 0 if the invoice shows no tax.\n"
    "- confidence: a score from 0.0 to 1.0 for EVERY field listed in the "
    "confidence object, not just the ones you're sure about.\n"
    "\n"
    "If a value genuinely isn't in the text, use null rather than inventing "
    "one, and give that field a low confidence score."
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
