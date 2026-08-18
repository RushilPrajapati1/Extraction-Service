/**
 * Persistence for subscriptions and delivery attempts.
 *
 * Uses node:sqlite (built into Node 22+) so there's no native dependency
 * to compile. Same philosophy as the Python side: plain SQL you can read,
 * no ORM.
 *
 * Deliveries are persisted rather than kept in memory on purpose -- the
 * whole value of a webhook service is that it can tell you what it tried
 * to send and what happened, including across restarts.
 */

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, "..", "webhooks.db");

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,   -- HMAC key; receiver uses it to verify payloads
    event_types TEXT NOT NULL,   -- JSON array; empty array means "all events"
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id              TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    url             TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    document_id     TEXT,
    payload         TEXT NOT NULL,   -- JSON string, exactly what was signed and sent
    status          TEXT NOT NULL,   -- pending | delivered | failed
    attempts        INTEGER NOT NULL DEFAULT 0,
    response_status INTEGER,
    error           TEXT,
    next_attempt_at TEXT,            -- when the retry loop should try again
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  -- The retry loop scans by (status, next_attempt_at) on every tick.
  CREATE INDEX IF NOT EXISTS idx_deliveries_pending
    ON deliveries (status, next_attempt_at);

  -- Received payloads for the built-in sink, so the demo can show that a
  -- webhook actually arrived and its signature verified.
  CREATE TABLE IF NOT EXISTS sink_events (
    id             TEXT PRIMARY KEY,
    event_type     TEXT,
    document_id    TEXT,
    payload        TEXT NOT NULL,
    signature_ok   INTEGER NOT NULL,
    received_at    TEXT NOT NULL
  );
`);

export interface Subscription {
  id: string;
  url: string;
  secret: string;
  event_types: string;
  active: number;
  created_at: string;
}

export interface Delivery {
  id: string;
  subscription_id: string;
  url: string;
  event_type: string;
  document_id: string | null;
  payload: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  response_status: number | null;
  error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}
