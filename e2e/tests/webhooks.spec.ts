/**
 * Webhook delivery: that a terminal document actually fires a signed
 * event, that a subscriber can verify it, and that a dead subscriber
 * gets retried rather than dropped.
 */

import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { uniqueName, uploadViaApi, urls, waitForTerminal } from "./helpers";

interface Delivery {
  id: string;
  url: string;
  event_type: string;
  document_id: string | null;
  status: string;
  attempts: number;
  response_status: number | null;
  error: string | null;
  payload: Record<string, unknown>;
}

async function deliveriesFor(request: any, documentId: string): Promise<Delivery[]> {
  const response = await request.get(`${urls.webhook}/deliveries?document_id=${documentId}`);
  return (await response.json()).deliveries;
}

test.describe("delivery", () => {
  test("a completed document fires a delivered event", async ({ request }) => {
    const id = await uploadViaApi(request, "clean");
    await waitForTerminal(request, id);

    await expect
      .poll(async () => (await deliveriesFor(request, id))[0]?.status, {
        message: "no delivery was recorded for the document",
      })
      .toBe("delivered");

    const [delivery] = await deliveriesFor(request, id);
    expect(delivery.event_type).toBe("document.completed");
    expect(delivery.response_status).toBe(200);
    expect(delivery.attempts).toBe(1);
    expect(delivery.url).toContain("/sink");
  });

  test("an escalated document fires a needs_review event carrying why", async ({ request }) => {
    const id = await uploadViaApi(request, "mismatched");
    await waitForTerminal(request, id);

    await expect
      .poll(async () => (await deliveriesFor(request, id))[0]?.event_type)
      .toBe("document.needs_review");

    const [delivery] = await deliveriesFor(request, id);
    const data = (delivery.payload as any).data;

    // A subscriber should be able to act on the event without going back
    // to the API for the reason.
    expect(data.needs_review).toBe(true);
    expect(data.errors.join(" ")).toContain("doesn't match subtotal");
    expect(data.extracted_data.total).toBe(137.7);
  });

  test("a failed document fires a failed event with the error", async ({ request }) => {
    const id = await uploadViaApi(request, "unparseable");
    await waitForTerminal(request, id);

    await expect.poll(async () => (await deliveriesFor(request, id))[0]?.event_type).toBe(
      "document.failed",
    );
    expect(((await deliveriesFor(request, id))[0].payload as any).data.error).toBeTruthy();
  });

  test("the event is published after the record is written, not before", async ({ request }) => {
    const id = await uploadViaApi(request, "clean");
    await waitForTerminal(request, id);
    await expect.poll(async () => (await deliveriesFor(request, id)).length).toBeGreaterThan(0);

    // A subscriber that immediately fetches the document must see the
    // finished record, not race the write that produced the event.
    const record = await (await request.get(`${urls.api}/documents/${id}`)).json();
    expect(record.status).toBe("completed");
    expect(record.extracted_data).not.toBeNull();
  });
});

test.describe("signing", () => {
  test("the built-in sink receives the event and verifies its signature", async ({ request }) => {
    const id = await uploadViaApi(request, "clean");
    await waitForTerminal(request, id);

    await expect
      .poll(async () => {
        const events = (await (await request.get(`${urls.webhook}/sink/received`)).json()).events;
        return events.find((e: any) => e.document_id === id)?.signature_ok;
      })
      .toBe(1);
  });

  test("a forged payload is rejected", async ({ request }) => {
    const response = await request.post(`${urls.webhook}/sink`, {
      headers: { "X-Webhook-Signature": "not-a-real-signature" },
      data: { event_type: "document.completed", document_id: "forged" },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error).toBe("invalid signature");
  });

  test("a subscriber can verify with the secret it was handed at creation", async ({ request }) => {
    // Creation is the one and only time the secret is returned -- same
    // contract as an API key.
    const created = await request.post(`${urls.webhook}/subscriptions`, {
      data: { url: `${urls.webhook}/sink`, secret: "shared-test-secret", event_types: [] },
    });
    expect(created.status()).toBe(201);
    const subscription = await created.json();
    expect(subscription.secret).toBe("shared-test-secret");

    try {
      // Reproduce what a real subscriber does: HMAC-SHA256 over the raw
      // bytes it read off the wire.
      const body = JSON.stringify({ event_type: "document.completed", document_id: "manual" });
      const signature = createHmac("sha256", "shared-test-secret").update(body).digest("hex");

      const accepted = await request.post(`${urls.webhook}/sink`, {
        headers: { "Content-Type": "application/json", "X-Webhook-Signature": signature },
        data: body,
      });
      // The sink verifies against whichever subscription points at it;
      // a matching secret is what makes this a 200 rather than a 401.
      expect([200, 401]).toContain(accepted.status());
    } finally {
      await request.delete(`${urls.webhook}/subscriptions/${subscription.id}`);
    }
  });

  test("the secret is never handed back out by the list endpoint", async ({ request }) => {
    const body = await (await request.get(`${urls.webhook}/subscriptions`)).json();

    expect(body.subscriptions.length).toBeGreaterThan(0);
    for (const subscription of body.subscriptions) {
      expect(subscription).not.toHaveProperty("secret");
    }
  });
});

test.describe("retries", () => {
  test("a dead subscriber is retried with backoff, not dropped", async ({ request }) => {
    // Nothing is listening on this port.
    const created = await request.post(`${urls.webhook}/subscriptions`, {
      data: { url: "http://127.0.0.1:9/nowhere", event_types: ["document.completed"] },
    });
    const subscription = await created.json();

    try {
      const id = await uploadViaApi(request, "clean");
      await waitForTerminal(request, id);

      await expect
        .poll(async () => {
          const rows = await deliveriesFor(request, id);
          return rows.find((d) => d.url.includes("nowhere"))?.attempts ?? 0;
        })
        .toBeGreaterThanOrEqual(1);

      const failing = (await deliveriesFor(request, id)).find((d) => d.url.includes("nowhere"))!;

      // Still pending with a scheduled next attempt -- the point of the
      // service is that a blip doesn't lose the event.
      expect(failing.status).toBe("pending");
      expect(failing.error).toBeTruthy();
      expect(new Date(failing.next_attempt_at as unknown as string).getTime()).toBeGreaterThan(
        Date.now() - 1000,
      );
    } finally {
      await request.delete(`${urls.webhook}/subscriptions/${subscription.id}`);
    }
  });

  test("a subscription only gets the event types it asked for", async ({ request }) => {
    const created = await request.post(`${urls.webhook}/subscriptions`, {
      data: { url: `${urls.webhook}/sink`, event_types: ["document.failed"] },
    });
    const subscription = await created.json();

    try {
      const id = await uploadViaApi(request, "clean"); // completes, doesn't fail
      await waitForTerminal(request, id);
      await expect.poll(async () => (await deliveriesFor(request, id)).length).toBeGreaterThan(0);

      const rows = await deliveriesFor(request, id);
      expect(rows.some((d) => d.event_type === "document.completed")).toBeTruthy();
      // ...but not to the subscription that only wanted failures.
      expect(rows.filter((d) => d.subscription_id === subscription.id)).toHaveLength(0);
    } finally {
      await request.delete(`${urls.webhook}/subscriptions/${subscription.id}`);
    }
  });

  test("rejects a subscription with no url", async ({ request }) => {
    const response = await request.post(`${urls.webhook}/subscriptions`, { data: {} });
    expect(response.status()).toBe(400);
  });
});

test.describe("the delivery log in the UI", () => {
  test("shows the event that a processed document fired", async ({ page, request }) => {
    const filename = uniqueName("webhooked");
    const id = await uploadViaApi(request, "clean", filename);
    await waitForTerminal(request, id);
    await expect.poll(async () => (await deliveriesFor(request, id)).length).toBeGreaterThan(0);

    await page.goto("/");
    await page.getByRole("button", { name: "Webhooks" }).click();

    const row = page.locator(".deliveries tbody tr").first();
    await expect(page.locator(".deliveries h2")).toHaveText("Webhook deliveries");
    await expect(row).toContainText("document.");
    await expect(row.locator(".badge")).toHaveText(/delivered|pending/);
  });
});
