/**
 * Client for the extraction-worker API (FastAPI, port 8000 by default).
 *
 * Kept deliberately thin: no caching layer, no react-query, just fetch
 * calls that mirror the endpoints one-for-one. Easy to see what HTTP
 * request each screen actually makes.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const WEBHOOK_BASE = import.meta.env.VITE_WEBHOOK_BASE ?? "http://localhost:8787";

/** Statuses a document can be in. Anything not terminal is still moving. */
export const TERMINAL_STATUSES = ["needs_review", "completed", "failed"] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Row shape returned by GET /documents (the list view -- no heavy fields). */
export interface DocumentSummary {
  id: string;
  filename: string;
  size_bytes: number;
  status: string;
  confidence: number | null;
  needs_review: number | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A single line item inside an extracted invoice. */
export interface LineItem {
  description?: string;
  quantity?: number;
  unit_price?: number;
  amount?: number;
}

/**
 * The LLM's structured output. Every field is optional on purpose --
 * the local model routinely omits fields (that's much of why a document
 * lands in the review queue in the first place).
 */
export interface InvoiceData {
  vendor_name?: string;
  invoice_date?: string;
  invoice_number?: string;
  line_items?: LineItem[];
  subtotal?: number;
  tax?: number;
  total?: number;
  confidence?: Record<string, number>;
}

/** Full record from GET /documents/{id}, including the extracted JSON. */
export interface DocumentDetail extends DocumentSummary {
  content_type: string;
  storage_path: string;
  raw_text: string | null;
  extracted_data: InvoiceData | null;
  reviewed_data: InvoiceData | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    // FastAPI puts the human-readable reason in `detail`; fall back to
    // the status line when the body isn't the shape we expect.
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* non-JSON error body; keep the status text */
    }
    throw new Error(`${response.status}: ${detail}`);
  }
  return response.json() as Promise<T>;
}

/** Documents awaiting human review, newest first. */
export function fetchReviewQueue(): Promise<{ documents: DocumentSummary[] }> {
  return request("/documents?needs_review=true");
}

/** Every document, regardless of review state. */
export function fetchAllDocuments(): Promise<{ documents: DocumentSummary[] }> {
  return request("/documents");
}

export function fetchDocument(id: string): Promise<DocumentDetail> {
  return request(`/documents/${id}`);
}

/** URL the browser can point an <iframe> at to render the original PDF. */
export function documentFileUrl(id: string): string {
  return `${API_BASE}/documents/${id}/file`;
}

export function submitReview(id: string, data: InvoiceData): Promise<{ status: string }> {
  return request(`/documents/${id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/** Requeue a document so the worker picks it up again. */
export function retryDocument(id: string): Promise<{ status: string }> {
  return request(`/documents/${id}/retry`, { method: "POST" });
}

/** Upload a PDF. Returns immediately -- processing happens in the worker. */
export async function uploadDocument(file: File): Promise<{ document_id: string; status: string }> {
  const body = new FormData();
  body.append("file", file);

  const response = await fetch(`${API_BASE}/ingest/`, { method: "POST", body });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const parsed = await response.json();
      if (parsed?.detail) detail = parsed.detail;
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return response.json();
}

/* ------------------------------------------------------- webhook service */

export interface WebhookDelivery {
  id: string;
  url: string;
  event_type: string;
  document_id: string | null;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  response_status: number | null;
  error: string | null;
  next_attempt_at: string | null;
  created_at: string;
}

/**
 * Delivery log from webhook-service. Returns an empty list rather than
 * throwing if the service is down -- the review workflow shouldn't break
 * just because the webhook sidecar isn't running.
 */
export async function fetchDeliveries(): Promise<WebhookDelivery[]> {
  try {
    const response = await fetch(`${WEBHOOK_BASE}/deliveries`);
    if (!response.ok) return [];
    const body = await response.json();
    return body.deliveries ?? [];
  } catch {
    return [];
  }
}
