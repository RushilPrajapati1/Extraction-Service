/**
 * Side-by-side review: original PDF on the left, extracted fields on
 * the right for the reviewer to correct and submit.
 *
 * Field values are held as strings while editing (a half-typed number
 * like "12." isn't a valid number yet, so coercing on every keystroke
 * fights the user). Coercion to numbers happens once, on submit.
 */

import { useEffect, useState } from "react";
import {
  documentFileUrl,
  fetchDocument,
  submitReview,
  type DocumentDetail,
  type InvoiceData,
} from "./api";

/** Fields the reviewer edits, in the order they appear on screen. */
const FIELDS = [
  { key: "vendor_name", label: "Vendor", type: "text" },
  { key: "invoice_date", label: "Invoice date", type: "text" },
  { key: "invoice_number", label: "Invoice number", type: "text" },
  { key: "subtotal", label: "Subtotal", type: "number" },
  { key: "tax", label: "Tax", type: "number" },
  { key: "total", label: "Total", type: "number" },
] as const;

type FormState = Record<string, string>;

function toFormState(data: InvoiceData | null): FormState {
  const state: FormState = {};
  for (const field of FIELDS) {
    const value = data?.[field.key as keyof InvoiceData];
    state[field.key] = value === undefined || value === null ? "" : String(value);
  }
  return state;
}

function toInvoiceData(form: FormState, original: InvoiceData | null): InvoiceData {
  const result: InvoiceData = {};

  for (const field of FIELDS) {
    const raw = form[field.key].trim();
    if (raw === "") continue; // omit blanks rather than sending empty strings

    if (field.type === "number") {
      const parsed = Number(raw);
      // Leave unparseable input out entirely -- better a missing field
      // than a NaN silently persisted as valid data.
      if (!Number.isNaN(parsed)) {
        (result as Record<string, unknown>)[field.key] = parsed;
      }
    } else {
      (result as Record<string, unknown>)[field.key] = raw;
    }
  }

  // Line items aren't editable in this pass; carry the model's version
  // through so a review doesn't silently drop them.
  if (original?.line_items?.length) {
    result.line_items = original.line_items;
  }

  return result;
}

/** Colour-code the model's per-field confidence so low scores stand out. */
function confidenceColor(score: number | undefined): string {
  if (score === undefined) return "#9ca3af";
  if (score >= 0.8) return "#16a34a";
  if (score >= 0.5) return "#ca8a04";
  return "#dc2626";
}

interface Props {
  documentId: string;
  onReviewed: () => void;
}

export function ReviewPane({ documentId, onReviewed }: Props) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);

    fetchDocument(documentId)
      .then((detail) => {
        if (cancelled) return;
        setDoc(detail);
        // A previously-reviewed doc should open with the human's
        // corrections, not the model's original guesses.
        setForm(toFormState(detail.reviewed_data ?? detail.extracted_data));
      })
      .catch((e) => !cancelled && setError(String(e)));

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  async function handleSubmit() {
    if (!doc) return;
    setSaving(true);
    setError(null);
    try {
      await submitReview(documentId, toInvoiceData(form, doc.extracted_data));
      onReviewed();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="pane-message error">{error}</div>;
  if (!doc) return <div className="pane-message">Loading…</div>;

  const fieldConfidence = doc.extracted_data?.confidence ?? {};

  return (
    <div className="review-pane">
      <div className="review-document">
        <iframe title="Original document" src={documentFileUrl(documentId)} />
      </div>

      <div className="review-fields">
        <header>
          <h2>{doc.filename}</h2>
          <p className="meta">
            status <strong>{doc.status}</strong>
            {doc.confidence !== null && (
              <>
                {" · "}overall confidence{" "}
                <strong style={{ color: confidenceColor(doc.confidence) }}>
                  {doc.confidence.toFixed(2)}
                </strong>
              </>
            )}
          </p>
        </header>

        {FIELDS.map((field) => {
          const score = fieldConfidence[field.key];
          return (
            <label key={field.key} className="field">
              <span className="field-label">
                {field.label}
                <span className="field-confidence" style={{ color: confidenceColor(score) }}>
                  {score === undefined ? "not scored" : score.toFixed(2)}
                </span>
              </span>
              <input
                type={field.type}
                step={field.type === "number" ? "0.01" : undefined}
                value={form[field.key] ?? ""}
                onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
              />
            </label>
          );
        })}

        {doc.extracted_data?.line_items?.length ? (
          <div className="line-items">
            <h3>Line items ({doc.extracted_data.line_items.length})</h3>
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {doc.extracted_data.line_items.map((item, i) => (
                  <tr key={i}>
                    <td>{item.description ?? "—"}</td>
                    <td>{item.quantity ?? "—"}</td>
                    <td>{item.unit_price ?? "—"}</td>
                    <td>{item.amount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">Line items aren't editable yet — they're carried through as-is.</p>
          </div>
        ) : (
          <p className="hint">The model returned no line items for this document.</p>
        )}

        <button className="primary" onClick={handleSubmit} disabled={saving}>
          {saving ? "Saving…" : "Submit review"}
        </button>
      </div>
    </div>
  );
}
