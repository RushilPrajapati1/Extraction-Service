/**
 * Shared vocabulary for the suite: uploading fixtures, waiting for the
 * pipeline, and locating things in the UI.
 */

import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, urls } from "../fixtures/sandbox.mjs";

export { urls };

/**
 * Fixture documents, by the behaviour they provoke. The scenario marker
 * inside each PDF is what tells the stubbed model which extraction to
 * return, so the filename really does determine the outcome.
 */
export const FIXTURES = {
  /** Reconciles cleanly and scores high -- should auto-complete. */
  clean: "clean-invoice.pdf",
  /** Line items sum to 45 against a stated subtotal of 127.50. */
  mismatched: "mismatched-invoice.pdf",
  /** No subtotal, no line items: the total cannot be reconciled. */
  unverifiable: "unverifiable-invoice.pdf",
  /** Reconciles like `clean`, but the model takes ~6s -- so a test can
   *  reliably observe the document while a worker owns it. */
  slow: "slow-invoice.pdf",
  /** Slow like `slow`, but escalates -- so a worker finishing after a
   *  human review produces a visibly different outcome. */
  slowMismatched: "slow-mismatched-invoice.pdf",
  /** Model omits `total`, a required field. */
  missingTotal: "missing-total-invoice.pdf",
  /** Model answers with prose, so extraction throws. */
  unparseable: "unparseable-invoice.pdf",
  /** A valid PDF with no text layer -- what a scan looks like here. */
  scanned: "scanned-no-text.pdf",
  /** Declares application/pdf but isn't one. */
  fakePdf: "not-really-a-pdf.pdf",
  /** Honestly not a PDF. */
  notPdf: "notes.txt",
} as const;

export type FixtureName = keyof typeof FIXTURES;

export const TERMINAL = ["needs_review", "completed", "failed"];

export function fixtureBytes(name: FixtureName): Buffer {
  return readFileSync(join(paths.pdfs, FIXTURES[name]));
}

/**
 * A filename unique to this upload.
 *
 * Tests share one queue and one database, so every assertion has to be
 * able to find *its* document among the others. The name is the handle.
 */
export function uniqueName(prefix: string, extension = "pdf"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${extension}`;
}

export interface DocumentDetail {
  id: string;
  filename: string;
  status: string;
  confidence: number | null;
  needs_review: number | null;
  raw_text: string | null;
  extracted_data: Record<string, unknown> | null;
  reviewed_data: Record<string, unknown> | null;
  reviewed_at: string | null;
}

/** Upload straight to the API, bypassing the UI. Returns the document id. */
export async function uploadViaApi(
  request: APIRequestContext,
  fixture: FixtureName,
  filename = uniqueName(fixture),
): Promise<string> {
  const response = await request.post(`${urls.api}/ingest/`, {
    multipart: {
      file: {
        name: filename,
        mimeType: filename.endsWith(".txt") ? "text/plain" : "application/pdf",
        buffer: fixtureBytes(fixture),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(202);
  return (await response.json()).document_id;
}

export async function getDocument(
  request: APIRequestContext,
  id: string,
): Promise<DocumentDetail> {
  const response = await request.get(`${urls.api}/documents/${id}`);
  expect(response.ok(), `GET /documents/${id} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

/**
 * Poll until the document stops moving.
 *
 * The pipeline is asynchronous by design, so there is no request to
 * await -- the only honest way to observe the outcome is to watch the
 * record. `expect.poll` keeps the failure message useful when it never
 * settles.
 */
export async function waitForTerminal(
  request: APIRequestContext,
  id: string,
  timeout = 60_000,
): Promise<DocumentDetail> {
  await expect
    .poll(async () => (await getDocument(request, id)).status, {
      timeout,
      message: `document ${id} never reached a terminal status`,
    })
    .toMatch(/needs_review|completed|failed/);
  return getDocument(request, id);
}

/* ------------------------------------------------------------------ UI */

/** The queue row for a given filename, in the left rail. */
export function queueRow(page: Page, filename: string): Locator {
  return page.locator("li").filter({ has: page.locator(".queue-filename", { hasText: filename }) });
}

/** The status badge shown on that row. */
export function queueBadge(page: Page, filename: string): Locator {
  return queueRow(page, filename).locator(".badge");
}

/**
 * An editable field in the review pane, by its visible label.
 *
 * Anchored at the start because the label element's text also contains
 * the confidence score ("Vendor0.98"), and because "Invoice date" and
 * "Invoice number" share a prefix.
 */
export function reviewField(page: Page, label: string): Locator {
  return page
    .locator("label.field")
    .filter({ hasText: new RegExp(`^${label}`) })
    .locator("input");
}

/** The per-field confidence annotation next to that label. */
export function fieldConfidence(page: Page, label: string): Locator {
  return page
    .locator("label.field")
    .filter({ hasText: new RegExp(`^${label}`) })
    .locator(".field-confidence");
}

/** Upload through the real file input the dropzone hides. */
export async function uploadViaUi(
  page: Page,
  fixture: FixtureName,
  filename = uniqueName(fixture),
): Promise<string> {
  await page.locator(".uploader input[type=file]").setInputFiles({
    name: filename,
    mimeType: filename.endsWith(".txt") ? "text/plain" : "application/pdf",
    buffer: fixtureBytes(fixture),
  });
  return filename;
}
