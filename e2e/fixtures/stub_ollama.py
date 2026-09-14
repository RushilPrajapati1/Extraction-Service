"""
Stand-in for Ollama, so the pipeline is deterministic under test.

The worker talks to Ollama through the `ollama` python client, which
honours OLLAMA_HOST. Pointing that at this server exercises the *real*
llm_extract.py -- schema, prompt, retry, JSON parsing -- while making the
model's answer a fixture instead of a 7B model's opinion.

Which canned answer comes back is keyed off a marker string in the
document text (see SCENARIOS), so a test picks its extraction by
choosing which PDF it uploads.

Usage:  python3 stub_ollama.py [port]
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Each scenario is (marker in the document text, what "the model" returns).
# The marker lives in the PDF body, so the choice travels with the upload.
SCENARIOS: dict[str, dict] = {
    # Everything present and reconciling: 100 + 8.25 = 108.25, and the
    # single line item equals the subtotal. Should auto-complete.
    "SCENARIO-CLEAN": {
        "vendor_name": "Cleanline Supply Co",
        "invoice_date": "2026-03-03",
        "invoice_number": "INV-1001",
        "line_items": [
            {"description": "Consulting", "quantity": 1, "unit_price": 100.0, "amount": 100.0}
        ],
        "subtotal": 100.0,
        "tax": 8.25,
        "total": 108.25,
        "confidence": {
            "vendor_name": 0.98,
            "invoice_date": 0.96,
            "invoice_number": 0.95,
            "line_items": 0.94,
            "total": 0.97,
        },
    },
    # Line items sum to 45 but the subtotal claims 127.50 -- a rule
    # failure, so this must land in review however sure the model is.
    "SCENARIO-MISMATCH": {
        "vendor_name": "Acme Office Supplies",
        "invoice_date": "2026-03-03",
        "invoice_number": "INV-20394",
        "line_items": [
            {"description": "Copy Paper", "quantity": 10, "unit_price": 4.50, "amount": 45.00}
        ],
        "subtotal": 127.50,
        "tax": 10.20,
        "total": 137.70,
        "confidence": {
            "vendor_name": 1.0,
            "invoice_date": 1.0,
            "invoice_number": 1.0,
            "line_items": 1.0,
            "total": 1.0,
        },
    },
    # No subtotal and no line items: the total can't be reconciled. The
    # model rates itself 1.0 across the board, which must NOT be enough
    # to auto-complete -- that's the CRITICAL_CHECKS gate.
    "SCENARIO-UNVERIFIABLE": {
        "vendor_name": "Opaque Holdings",
        "invoice_date": "2026-02-01",
        "invoice_number": "INV-777",
        "line_items": [],
        "tax": 12.0,
        "total": 512.0,
        "confidence": {
            "vendor_name": 1.0,
            "invoice_date": 1.0,
            "invoice_number": 1.0,
            "line_items": 1.0,
            "total": 1.0,
        },
    },
    # Missing a required field (total) -- a hard validation error.
    "SCENARIO-MISSING-TOTAL": {
        "vendor_name": "Halfway Ltd",
        "invoice_date": "2026-01-15",
        "invoice_number": "INV-42",
        "line_items": [{"description": "Widget", "amount": 20.0}],
        "subtotal": 20.0,
        "tax": 0.0,
        "confidence": {"vendor_name": 0.9, "total": 0.2},
    },
    # Same answer as CLEAN, but slow. Tests that need to observe a
    # document while a worker owns it can't race an instant model.
    "SCENARIO-SLOW": None,  # filled in below -- it's CLEAN with a delay
    # Slow *and* escalating. Needed to see a human review get overwritten
    # by the worker: if the worker's own outcome were 'completed', it
    # would look identical to the review having stuck.
    "SCENARIO-SLOW-MISMATCH": None,  # filled in below
    # Not JSON at all. llm_extract retries once, then raises -- the
    # document should end up 'failed' and be retryable.
    "SCENARIO-BAD-JSON": None,
}

SCENARIOS["SCENARIO-SLOW"] = dict(SCENARIOS["SCENARIO-CLEAN"], vendor_name="Slowpoke Industries")
SCENARIOS["SCENARIO-SLOW-MISMATCH"] = dict(
    SCENARIOS["SCENARIO-MISMATCH"], vendor_name="Slow Mismatch Co"
)

# How long SCENARIO-SLOW holds the request open, in seconds. Long enough
# that a test can reliably catch the document in 'processing'.
SLOW_SECONDS = 6.0

DEFAULT = SCENARIOS["SCENARIO-CLEAN"]


def pick(document_text: str) -> dict | None:
    # Longest marker first: SCENARIO-SLOW-MISMATCH contains
    # SCENARIO-SLOW, so a plain first-match scan picks the wrong one.
    for marker in sorted(SCENARIOS, key=len, reverse=True):
        if marker in document_text:
            return SCENARIOS[marker]
    return DEFAULT


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"] or 0)) or b"{}")

        if not self.path.startswith("/api/chat"):
            return self._json(404, {"error": "not found"})

        # The document text is the user turn; the system prompt is ours.
        user_text = "".join(
            m.get("content", "") for m in body.get("messages", []) if m.get("role") == "user"
        )
        if "SCENARIO-SLOW" in user_text:  # covers SLOW and SLOW-MISMATCH
            time.sleep(SLOW_SECONDS)

        payload = pick(user_text)

        # A scenario of None means "the model emitted prose, not JSON",
        # which is the failure llm_extract's retry exists for.
        content = "I'm sorry, I can't do that." if payload is None else json.dumps(payload)

        self._json(
            200,
            {
                "model": body.get("model", "stub"),
                "created_at": "2026-01-01T00:00:00Z",
                "message": {"role": "assistant", "content": content},
                "done": True,
                "done_reason": "stop",
            },
        )

    def do_GET(self):
        # `ollama` and start.sh both probe /api/version.
        if self.path.startswith("/api/version"):
            return self._json(200, {"version": "stub"})
        if self.path.startswith("/api/tags"):
            return self._json(200, {"models": [{"name": "mistral:latest", "model": "mistral"}]})
        self._json(404, {"error": "not found"})

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        # Quiet: Playwright pipes this through its own output.
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11500
    print(f"[stub-ollama] listening on http://127.0.0.1:{port}", flush=True)
    # Threaded: SCENARIO-SLOW holds a request open, and that must not
    # stall the worker's other calls or the readiness probe.
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
