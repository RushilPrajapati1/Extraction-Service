/**
 * Delivery engine: sign, send, and retry with exponential backoff.
 *
 * Delivery is deliberately *not* awaited by the caller that publishes an
 * event. The extraction worker shouldn't wait on a slow or dead
 * subscriber -- it hands the event over and moves on. Everything after
 * that is this module's problem.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { db, type Delivery, type Subscription } from "./db.ts";

/** Give up after this many total attempts. */
const MAX_ATTEMPTS = 5;

/** How often the retry loop looks for work. */
const RETRY_TICK_MS = 3_000;

/** Per-request timeout -- a hung subscriber shouldn't stall the loop. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface EventPayload {
  event_type: string;
  document_id?: string;
  data?: unknown;
}

/**
 * Backoff schedule in seconds: 2, 8, 32, 128...
 *
 * Exponential rather than fixed so a subscriber that's down for a few
 * minutes doesn't get hammered, but a subscriber that blipped for one
 * second recovers quickly.
 */
function backoffSeconds(attempt: number): number {
  return 2 * Math.pow(4, attempt - 1);
}

/**
 * HMAC-SHA256 over the exact bytes we send.
 *
 * Signing the serialized body (not the object) matters: the receiver
 * verifies against the raw bytes it read off the wire, and any
 * re-serialization on either side would change the hash.
 */
export function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time comparison, so a bad signature can't be brute-forced by timing. */
export function verifySignature(body: string, secret: string, received: string): boolean {
  const expected = sign(body, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received ?? "", "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Queue an event for every subscription that cares about it. */
export function publish(event: EventPayload): Delivery[] {
  const subscriptions = db
    .prepare("SELECT * FROM subscriptions WHERE active = 1")
    .all() as unknown as Subscription[];

  const now = new Date().toISOString();
  const created: Delivery[] = [];

  for (const sub of subscriptions) {
    // An empty event_types array means "everything".
    const types: string[] = JSON.parse(sub.event_types);
    if (types.length > 0 && !types.includes(event.event_type)) continue;

    const body = JSON.stringify({
      id: randomUUID(),
      event_type: event.event_type,
      document_id: event.document_id ?? null,
      data: event.data ?? null,
      created_at: now,
    });

    const delivery: Delivery = {
      id: randomUUID(),
      subscription_id: sub.id,
      url: sub.url,
      event_type: event.event_type,
      document_id: event.document_id ?? null,
      payload: body,
      status: "pending",
      attempts: 0,
      response_status: null,
      error: null,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      `INSERT INTO deliveries
         (id, subscription_id, url, event_type, document_id, payload, status,
          attempts, response_status, error, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      delivery.id,
      delivery.subscription_id,
      delivery.url,
      delivery.event_type,
      delivery.document_id,
      delivery.payload,
      delivery.status,
      delivery.attempts,
      delivery.response_status,
      delivery.error,
      delivery.next_attempt_at,
      delivery.created_at,
      delivery.updated_at,
    );

    created.push(delivery);
  }

  // Kick the loop rather than waiting for the next tick, so a healthy
  // subscriber sees the event within milliseconds instead of seconds.
  queueMicrotask(() => void processPending());

  return created;
}

/** Send one delivery, recording the outcome and scheduling a retry if needed. */
async function attemptDelivery(delivery: Delivery, secret: string): Promise<void> {
  const attempt = delivery.attempts + 1;
  const now = new Date().toISOString();

  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": sign(delivery.payload, secret),
        "X-Webhook-Event": delivery.event_type,
        "X-Webhook-Delivery": delivery.id,
        "X-Webhook-Attempt": String(attempt),
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      db.prepare(
        `UPDATE deliveries
         SET status = 'delivered', attempts = ?, response_status = ?,
             error = NULL, next_attempt_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(attempt, response.status, now, delivery.id);
      console.log(`[webhook] delivered ${delivery.event_type} -> ${delivery.url} (${response.status})`);
      return;
    }

    // Any non-2xx counts as a failure worth retrying. A stricter service
    // would treat 4xx as permanent, but subscribers commonly return 4xx
    // while still starting up.
    scheduleRetryOrFail(delivery, attempt, response.status, `HTTP ${response.status}`);
  } catch (e) {
    scheduleRetryOrFail(delivery, attempt, null, String(e));
  }
}

function scheduleRetryOrFail(
  delivery: Delivery,
  attempt: number,
  responseStatus: number | null,
  error: string,
): void {
  const now = new Date().toISOString();

  if (attempt >= MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE deliveries
       SET status = 'failed', attempts = ?, response_status = ?, error = ?,
           next_attempt_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(attempt, responseStatus, error, now, delivery.id);
    console.warn(`[webhook] gave up on ${delivery.id} after ${attempt} attempts: ${error}`);
    return;
  }

  const nextAt = new Date(Date.now() + backoffSeconds(attempt) * 1000).toISOString();
  db.prepare(
    `UPDATE deliveries
     SET attempts = ?, response_status = ?, error = ?, next_attempt_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(attempt, responseStatus, error, nextAt, now, delivery.id);
  console.warn(
    `[webhook] attempt ${attempt} failed for ${delivery.id} (${error}); retrying at ${nextAt}`,
  );
}

let draining = false;

/** Send every pending delivery whose backoff has elapsed. */
export async function processPending(): Promise<void> {
  // Guard against overlapping runs -- the timer and publish() both call
  // this, and two concurrent drains would double-send.
  if (draining) return;
  draining = true;

  try {
    const due = db
      .prepare(
        `SELECT * FROM deliveries
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY created_at
         LIMIT 50`,
      )
      .all(new Date().toISOString()) as unknown as Delivery[];

    for (const delivery of due) {
      const sub = db
        .prepare("SELECT * FROM subscriptions WHERE id = ?")
        .get(delivery.subscription_id) as unknown as Subscription | undefined;

      if (!sub) {
        // Subscription deleted while a delivery was still queued.
        db.prepare(
          `UPDATE deliveries SET status = 'failed', error = 'subscription removed', updated_at = ?
           WHERE id = ?`,
        ).run(new Date().toISOString(), delivery.id);
        continue;
      }

      await attemptDelivery(delivery, sub.secret);
    }
  } finally {
    draining = false;
  }
}

/** Start the background retry loop. */
export function startRetryLoop(): NodeJS.Timeout {
  const timer = setInterval(() => void processPending(), RETRY_TICK_MS);
  // Don't hold the process open just for this timer.
  timer.unref();
  return timer;
}
