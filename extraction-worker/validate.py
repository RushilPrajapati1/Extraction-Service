"""
Validation & confidence scoring -- a separate rules engine, on purpose.

llm_extract.py's job is "text in, JSON out." This module's job is to check
that JSON against real business rules, independent of anything the LLM
claimed about itself. Per the build plan: "LLM never self-grades as valid."

A central idea here: **an unverifiable extraction is not a passing one.**
If the model omits the fields a rule needs, that rule can't run -- and
silently skipping it would score a document that proved nothing exactly
the same as one that reconciled perfectly. So skipped checks are tracked
and cost confidence, which is what pushes thin extractions toward human
review rather than letting them coast through.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

THRESHOLD = 0.7

# Fields the extraction must have to be usable at all -- missing any of
# these is a hard validation failure, not just a confidence ding.
REQUIRED_FIELDS = ("vendor_name", "invoice_date", "total")

# Fields the LLM was asked to score (see llm_extract.INVOICE_SCHEMA);
# used to compute the LLM-side portion of the overall confidence.
CONFIDENCE_FIELDS = ("vendor_name", "invoice_date", "invoice_number", "line_items", "total")

# How much a failed rule check knocks off the overall confidence score.
RULE_FAILURE_PENALTY = 0.25

# How much a *skipped* check costs. Smaller than a failure -- "I couldn't
# verify this" is weaker evidence of a problem than "I checked and it's
# wrong" -- but not free, which is the whole point.
SKIPPED_CHECK_PENALTY = 0.15

# Checks that must run for an extraction to auto-complete. Reconciling
# the total is *the* check on a financial document; if it couldn't run,
# a human looks -- regardless of score.
#
# This is deliberately a hard gate rather than a bigger confidence
# penalty. A model that rates itself 1.0 across the board would otherwise
# buy its way past an unverifiable total by being confident, which is
# exactly backwards: self-reported confidence is the thing under
# scrutiny, so it shouldn't be able to excuse the absence of evidence.
CRITICAL_CHECKS = ("subtotal_plus_tax_equals_total",)

# Cents of slack allowed when reconciling amounts (floats).
AMOUNT_TOLERANCE = 0.01


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    # Which rules actually executed, and which couldn't for lack of data.
    # Exposed so a reviewer can see *why* something was escalated -- "no
    # rule could run" is a very different situation from "a rule failed."
    checks_run: list[str] = field(default_factory=list)
    checks_skipped: list[str] = field(default_factory=list)

    # Values validation computed for itself (e.g. subtotal recovered from
    # line items). Kept separate from the LLM's output so the extraction
    # record stays an honest account of what the model actually said.
    derived: dict = field(default_factory=dict)

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
    LLM's self-reported confidence. Warnings are informational. Checks
    that couldn't run are tracked and reduce confidence.
    """
    result = ValidationResult()

    _check_required_fields(data, result)
    _check_date(data, result)
    _check_amounts(data, result)

    result.confidence = _score_confidence(
        data,
        rule_failures=len(result.errors),
        skipped_checks=len(result.checks_skipped),
    )

    unverified = [c for c in CRITICAL_CHECKS if c not in result.checks_run]
    result.needs_review = (
        (not result.is_valid)
        or result.confidence < THRESHOLD
        or bool(unverified)
    )
    if unverified:
        result.warnings.append(
            f"escalated: could not verify {', '.join(unverified)}"
        )

    return result


def _check_required_fields(data: dict, result: ValidationResult) -> None:
    for field_name in REQUIRED_FIELDS:
        if not data.get(field_name):
            result.errors.append(f"missing required field: {field_name}")


def _check_date(data: dict, result: ValidationResult) -> None:
    invoice_date = data.get("invoice_date")
    if not invoice_date:
        result.checks_skipped.append("date_sanity")
        return

    parsed_date = _parse_date(invoice_date)
    if parsed_date is None:
        result.errors.append(f"invoice_date is not a recognizable date: {invoice_date!r}")
        return

    result.checks_run.append("date_sanity")
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    if parsed_date > now + timedelta(days=1):
        result.errors.append(f"invoice_date is in the future: {invoice_date!r}")
    elif parsed_date < now - timedelta(days=365 * 10):
        result.warnings.append(f"invoice_date is more than 10 years old: {invoice_date!r}")


def _line_item_sum(line_items: list) -> float | None:
    """
    Sum line item amounts, or None if there's nothing usable to sum.

    Returns None rather than 0.0 for an empty list -- "no line items" and
    "line items totalling zero" are different claims, and conflating them
    would let an empty extraction reconcile against a zero subtotal.
    """
    if not line_items:
        return None

    amounts = [
        item.get("amount")
        for item in line_items
        if isinstance(item, dict) and isinstance(item.get("amount"), (int, float))
    ]
    if not amounts:
        return None

    return round(sum(amounts), 2)


def _check_amounts(data: dict, result: ValidationResult) -> None:
    """
    Reconcile the money.

    The important subtlety is where a missing subtotal is allowed to come
    from. Line items are *independent evidence*: summing them and
    comparing against the total is a genuine cross-check of two separately
    extracted things. Deriving subtotal as `total - tax` would be
    circular -- the subsequent `subtotal + tax == total` check could never
    fail, so it would look like verification while proving nothing.
    """
    total = data.get("total")
    tax = data.get("tax")
    explicit_subtotal = data.get("subtotal")
    line_items = data.get("line_items") or []
    derived_subtotal = _line_item_sum(line_items)

    if total is not None and total <= 0:
        result.errors.append(f"total must be positive, got {total}")

    # If the model gave us both, they must agree -- this is the strongest
    # signal available, two independent extractions of the same quantity.
    if explicit_subtotal is not None and derived_subtotal is not None:
        result.checks_run.append("line_items_match_subtotal")
        if abs(derived_subtotal - explicit_subtotal) > AMOUNT_TOLERANCE:
            result.errors.append(
                f"line items sum to {derived_subtotal}, doesn't match subtotal {explicit_subtotal}"
            )

    # Prefer what the model stated; fall back to what the line items prove.
    subtotal = explicit_subtotal if explicit_subtotal is not None else derived_subtotal
    if explicit_subtotal is None and derived_subtotal is not None:
        result.derived["subtotal"] = derived_subtotal
        result.warnings.append(
            f"subtotal was missing; derived {derived_subtotal} from line items"
        )

    # The core reconciliation.
    if subtotal is None or total is None:
        result.checks_skipped.append("subtotal_plus_tax_equals_total")
        if subtotal is None:
            result.warnings.append(
                "could not verify totals: no subtotal and no line items to derive one from"
            )
        return

    # A missing tax is treated as zero, but only when that's consistent
    # with the total -- otherwise we'd be inventing a value to make the
    # arithmetic work, which is exactly the failure this check exists to
    # catch.
    effective_tax = tax if tax is not None else 0.0
    if tax is None:
        if abs(subtotal - total) > AMOUNT_TOLERANCE:
            result.checks_skipped.append("subtotal_plus_tax_equals_total")
            result.warnings.append(
                f"tax is missing and subtotal ({subtotal}) != total ({total}); "
                "cannot verify the difference is tax"
            )
            return
        result.warnings.append("tax was missing; treated as 0 since subtotal equals total")

    result.checks_run.append("subtotal_plus_tax_equals_total")
    if abs((subtotal + effective_tax) - total) > AMOUNT_TOLERANCE:
        source = "subtotal" if explicit_subtotal is not None else "derived subtotal"
        result.errors.append(
            f"{source} ({subtotal}) + tax ({effective_tax}) != total ({total})"
        )


def _parse_date(value: str) -> datetime | None:
    """
    Try a handful of common formats. LLMs don't reliably emit ISO 8601
    even when explicitly asked to -- Mistral returns "March 3, 2026" for
    the sample invoice despite the schema asking for ISO.
    """
    formats = (
        "%Y-%m-%d",
        "%B %d, %Y",
        "%b %d, %Y",
        "%d %B %Y",
        "%m/%d/%Y",
        "%d/%m/%Y",
        "%Y/%m/%d",
    )
    for fmt in formats:
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return None


def _score_confidence(data: dict, rule_failures: int, skipped_checks: int) -> float:
    """
    Blend the LLM's self-reported per-field confidence with what
    validation could actually establish.

    Three inputs, in descending order of trustworthiness:
      - rules that failed        (hard evidence of a problem)
      - rules that couldn't run  (absence of evidence -- still costly)
      - the LLM's self-assessment (weakest; it's the thing being checked)
    """
    llm_confidence = data.get("confidence") or {}
    scores = [
        llm_confidence[f]
        for f in CONFIDENCE_FIELDS
        if isinstance(llm_confidence.get(f), (int, float))
    ]

    # Fields the LLM didn't bother scoring count as low confidence, not
    # "ignored" -- an LLM that silently skips scoring a field is itself
    # a signal worth reflecting in the number.
    missing_scores = len(CONFIDENCE_FIELDS) - len(scores)
    scores.extend([0.3] * missing_scores)

    base = sum(scores) / len(scores) if scores else 0.0
    penalized = base - (rule_failures * RULE_FAILURE_PENALTY) - (skipped_checks * SKIPPED_CHECK_PENALTY)
    return max(0.0, min(1.0, penalized))
