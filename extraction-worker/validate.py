"""
Validation & confidence scoring -- a separate rules engine, on purpose.

llm_extract.py's job is "text in, JSON out." This module's job is to check
that JSON against real business rules, independent of anything the LLM
claimed about itself. Per the build plan: "LLM never self-grades as valid."

Combines the LLM's own per-field confidence scores with pass/fail rule
checks into one overall confidence score. Below THRESHOLD -> route to
human review; above -> auto-complete. (The routing decision itself lives
in the caller -- this module just produces the number and the reasons.)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

THRESHOLD = 0.7

# Fields the extraction must have to be usable at all -- missing any of
# these is a hard validation failure, not just a confidence ding.
REQUIRED_FIELDS = ("vendor_name", "invoice_date", "total")

# Fields the LLM was asked to score (see llm_extract.INVOICE_SCHEMA);
# used to compute the LLM-side portion of the overall confidence.
CONFIDENCE_FIELDS = ("vendor_name", "invoice_date", "invoice_number", "line_items", "total")

# How much a failed rule check knocks off the overall confidence score.
RULE_FAILURE_PENALTY = 0.25

# Cents of slack allowed when checking subtotal + tax == total (floats).
AMOUNT_TOLERANCE = 0.01


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    confidence: float = 0.0
    needs_review: bool = True

    @property
    def is_valid(self) -> bool:
        """No hard errors -- warnings alone don't invalidate the extraction."""
        return not self.errors


def validate_invoice(data: dict) -> ValidationResult:
    """
    Run business-rule checks against an invoice extraction dict (the
    output of llm_extract.extract_invoice) and compute an overall
    confidence score.

    Hard errors (missing required fields, amounts that don't reconcile,
    nonsensical dates) always trigger needs_review, regardless of the
    LLM's self-reported confidence. Warnings are informational and don't
    invalidate the extraction on their own.
    """
    result = ValidationResult()

    # --- required fields ---
    for field_name in REQUIRED_FIELDS:
        if not data.get(field_name):
            result.errors.append(f"missing required field: {field_name}")

    # --- date sanity ---
    invoice_date = data.get("invoice_date")
    if invoice_date:
        parsed_date = _parse_date(invoice_date)
        if parsed_date is None:
            result.errors.append(f"invoice_date is not a recognizable date: {invoice_date!r}")
        else:
            now = datetime.utcnow()
            if parsed_date > now + timedelta(days=1):
                result.errors.append(f"invoice_date is in the future: {invoice_date!r}")
            elif parsed_date < now - timedelta(days=365 * 10):
                result.warnings.append(f"invoice_date is more than 10 years old: {invoice_date!r}")

    # --- amounts ---
    total = data.get("total")
    subtotal = data.get("subtotal")
    tax = data.get("tax")

    if total is not None and total <= 0:
        result.errors.append(f"total must be positive, got {total}")

    if subtotal is not None and tax is not None and total is not None:
        if abs((subtotal + tax) - total) > AMOUNT_TOLERANCE:
            result.errors.append(f"subtotal ({subtotal}) + tax ({tax}) != total ({total})")

    line_items = data.get("line_items") or []
    if line_items and subtotal is not None:
        line_item_sum = sum(item.get("amount", 0) for item in line_items)
        if abs(line_item_sum - subtotal) > AMOUNT_TOLERANCE:
            result.warnings.append(
                f"line items sum to {line_item_sum}, doesn't match subtotal {subtotal}"
            )

    # --- confidence scoring ---
    result.confidence = _score_confidence(data, rule_failures=len(result.errors))
    result.needs_review = (not result.is_valid) or result.confidence < THRESHOLD

    return result


def _parse_date(value: str) -> datetime | None:
    """
    Try a handful of common formats. LLMs don't reliably emit ISO 8601
    even when explicitly asked to -- see llm_extract.py's SYSTEM_PROMPT
    and the sample run where Mistral returned "March 3, 2026" instead.
    """
    formats = (
        "%Y-%m-%d",
        "%B %d, %Y",
        "%b %d, %Y",
        "%m/%d/%Y",
        "%d/%m/%Y",
    )
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def _score_confidence(data: dict, rule_failures: int) -> float:
    """
    Blend the LLM's self-reported per-field confidence with rule
    pass/fail. The LLM's opinion of itself is a signal, not a verdict --
    each failed rule pulls the score down regardless of what the LLM said.
    """
    llm_confidence = data.get("confidence") or {}
    scores = [llm_confidence[f] for f in CONFIDENCE_FIELDS if f in llm_confidence]

    # Fields the LLM didn't bother scoring count as low confidence, not
    # "ignored" -- an LLM that silently skips scoring a field is itself
    # a signal worth reflecting in the number.
    missing_scores = len(CONFIDENCE_FIELDS) - len(scores)
    scores.extend([0.3] * missing_scores)

    base = sum(scores) / len(scores) if scores else 0.0
    penalized = base - (rule_failures * RULE_FAILURE_PENALTY)
    return max(0.0, min(1.0, penalized))
