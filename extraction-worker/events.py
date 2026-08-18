"""
Event publishing -- hands terminal document events to webhook-service.

Deliberately fire-and-forget from the worker's point of view: publishing
must never fail a document. If webhook-service is down, the extraction
still succeeded, and the record in SQLite is still the source of truth.
The event is lost, which is the honest tradeoff of not having a durable
outbox here (see the note at the bottom).
"""

import json
import os
import urllib.error
import urllib.request

WEBHOOK_SERVICE_URL = os.environ.get("WEBHOOK_SERVICE_URL", "http://localhost:8787")
TIMEOUT_SECONDS = 3


def publish(event_type: str, document_id: str, data: dict | None = None) -> bool:
    """
    Publish an event to webhook-service. Returns True if it was accepted.

    Never raises: a webhook problem is not a document problem. Callers
    are free to ignore the return value.
    """
    payload = json.dumps(
        {"event_type": event_type, "document_id": document_id, "data": data or {}}
    ).encode()

    request = urllib.request.Request(
        f"{WEBHOOK_SERVICE_URL}/events",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # Log and carry on -- the document is already safely recorded.
        print(f"[events] could not publish {event_type} for {document_id}: {e}", flush=True)
        return False


# Note on durability: a real system would write the event to an outbox
# table in the same transaction as the status update, then have a
# separate process drain it. That makes delivery survive webhook-service
# being down. This is the simpler version -- fine for a single machine,
# and the shape to replace when reliability matters.
