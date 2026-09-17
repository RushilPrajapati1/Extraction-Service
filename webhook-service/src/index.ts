/**
 * Webhook service -- HTTP surface.
 *
 * Publishers (the extraction worker) POST /events. Subscribers are
 * registered via /subscriptions and receive signed POSTs with retries.
 *
 * A built-in sink (/sink) is included so the pipeline is demonstrable
 * without standing up an external receiver: it verifies the signature
 * the same way a real subscriber would and records what it got.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { db, type Delivery, type Subscription } from "./db.ts";
import { publish, processPending, startRetryLoop, verifySignature } from "./delivery.ts";

const PORT = Number(process.env.PORT ?? 8787);
// Origin the review UI is served from. Behind a reverse proxy it is the
// same origin, so the header is harmless; in dev it is the Vite server.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const app = express();

// The sink needs the raw bytes to verify the HMAC -- a signature covers
// the exact body that was sent, and re-serializing a parsed object can
// change it (key order, whitespace). So capture the raw buffer here.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);

// The review UI reads the delivery log directly from this service.
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,X-Webhook-Signature");
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "webhook-service" });
});

/* ---------------------------------------------------------------- events */

/**
 * Publish an event. Called by the extraction worker when a document
 * reaches a terminal state.
 *
 * Returns 202 immediately: deliveries are queued, not sent inline. The
 * publisher shouldn't block on a subscriber's availability.
 */
app.post("/events", (req, res) => {
  const { event_type, document_id, data } = req.body ?? {};

  if (!event_type || typeof event_type !== "string") {
    return res.status(400).json({ error: "event_type is required" });
  }

  const deliveries = publish({ event_type, document_id, data });
  res.status(202).json({
    event_type,
    queued_deliveries: deliveries.length,
    delivery_ids: deliveries.map((d) => d.id),
  });
});

/* --------------------------------------------------------- subscriptions */

app.get("/subscriptions", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM subscriptions ORDER BY created_at DESC")
    .all() as unknown as Subscription[];
  // Never hand the signing secret back out over the API.
  res.json({
    subscriptions: rows.map(({ secret: _secret, ...rest }) => ({
      ...rest,
      event_types: JSON.parse(rest.event_types),
    })),
  });
});

app.post("/subscriptions", (req, res) => {
  const { url, secret, event_types } = req.body ?? {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }

  const subscription = {
    id: randomUUID(),
    url,
    // Generate a secret if the caller didn't supply one, so a
    // subscription is never accidentally unsigned.
    secret: typeof secret === "string" && secret ? secret : randomUUID(),
    event_types: JSON.stringify(Array.isArray(event_types) ? event_types : []),
    active: 1,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO subscriptions (id, url, secret, event_types, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    subscription.id,
    subscription.url,
    subscription.secret,
    subscription.event_types,
    subscription.active,
    subscription.created_at,
  );

  // The secret is returned exactly once, at creation -- same pattern as
  // an API key. After this the subscriber is expected to have stored it.
  res.status(201).json({ ...subscription, event_types: JSON.parse(subscription.event_types) });
});

app.delete("/subscriptions/:id", (req, res) => {
  db.prepare("DELETE FROM subscriptions WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

/* ------------------------------------------------------------ deliveries */

app.get("/deliveries", (req, res) => {
  const { document_id, status, limit } = req.query;

  const clauses: string[] = [];
  const values: unknown[] = [];

  if (typeof document_id === "string") {
    clauses.push("document_id = ?");
    values.push(document_id);
  }
  if (typeof status === "string") {
    clauses.push("status = ?");
    values.push(status);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(Number(limit ?? 100));

  const rows = db
    .prepare(`SELECT * FROM deliveries ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...(values as never[])) as unknown as Delivery[];

  res.json({
    deliveries: rows.map((d) => ({ ...d, payload: JSON.parse(d.payload) })),
  });
});

/** Force an immediate retry sweep -- handy when testing. */
app.post("/deliveries/retry", async (_req, res) => {
  db.prepare(
    `UPDATE deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
     WHERE status = 'failed'`,
  ).run(new Date().toISOString(), new Date().toISOString());
  await processPending();
  res.json({ status: "retried" });
});

/* ------------------------------------------------------------------ sink */

/**
 * Built-in subscriber, so the demo shows a real signed round trip.
 *
 * This is what a customer's endpoint would do: read the raw body, verify
 * the HMAC against the shared secret, then process.
 */
app.post("/sink", (req, res) => {
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? "";
  const signature = req.header("X-Webhook-Signature") ?? "";

  // Find the subscription pointing at this sink to get its secret.
  const sub = db
    .prepare("SELECT * FROM subscriptions WHERE url LIKE '%/sink' LIMIT 1")
    .get() as unknown as Subscription | undefined;

  const signatureOk = sub ? verifySignature(rawBody, sub.secret, signature) : false;

  db.prepare(
    `INSERT INTO sink_events (id, event_type, document_id, payload, signature_ok, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    req.body?.event_type ?? null,
    req.body?.document_id ?? null,
    rawBody,
    signatureOk ? 1 : 0,
    new Date().toISOString(),
  );

  if (!signatureOk) {
    // A real subscriber must reject unverified payloads -- otherwise
    // anyone who knows the URL can forge events.
    return res.status(401).json({ error: "invalid signature" });
  }

  res.json({ received: true });
});

app.get("/sink/received", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM sink_events ORDER BY received_at DESC LIMIT 100")
    .all() as unknown as Array<Record<string, unknown>>;
  res.json({
    events: rows.map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) })),
  });
});

/* ----------------------------------------------------------------- start */

function ensureDefaultSubscription(): void {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM subscriptions").get() as { n: number };
  if (existing.n > 0) return;

  const secret = randomUUID();
  db.prepare(
    `INSERT INTO subscriptions (id, url, secret, event_types, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(
    randomUUID(),
    `http://localhost:${PORT}/sink`,
    secret,
    JSON.stringify([]),
    new Date().toISOString(),
  );
  console.log("[webhook] seeded default subscription -> /sink (all event types)");
}

ensureDefaultSubscription();
startRetryLoop();

app.listen(PORT, () => {
  console.log(`[webhook] listening on http://localhost:${PORT}`);
});
