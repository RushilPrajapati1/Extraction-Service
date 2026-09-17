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

function formatMoney(value: number | undefined): string {
  if (value === undefined || value === null) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The reviewer's main job is checking that the amounts add up, so do the
 * arithmetic for them as they type. Mirrors the tolerance validate.py uses;
 * this is a hint, not a gate -- the server still runs the real check.
 */
function reconcile(form: FormState): { ok: boolean; message: string } | null {
  const subtotal = Number(form.subtotal);
  const total = Number(form.total);
  const tax = form.tax.trim() === "" ? 0 : Number(form.tax);
  if (form.subtotal.trim() === "" || form.total.trim() === "") return null;
  if ([subtotal, tax, total].some(Number.isNaN)) return null;

  const diff = subtotal + tax - total;
  if (Math.abs(diff) < 0.01) {
    return { ok: true, message: "subtotal + tax = total" };
  }
  return {
    ok: false,
    message: `subtotal + tax is ${formatMoney(subtotal + tax)}, total says ${formatMoney(total)} (off by ${formatMoney(Math.abs(diff))})`,
  };
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
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
      setSavedAt(Date.now());
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
  const reconciliation = reconcile(form);
  const original = toFormState(doc.reviewed_data ?? doc.extracted_data);

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
          const edited = (form[field.key] ?? "") !== original[field.key];
          const lowConfidence = score === undefined || score < 0.5;
          return (
            <label key={field.key} className="field">
              <span className="field-label">
                <span>
                  {field.label}
                  {edited && <span className="field-edited">edited</span>}
                </span>
                <span className="field-confidence" style={{ color: confidenceColor(score) }}>
                  {score === undefined ? "not scored" : score.toFixed(2)}
                </span>
              </span>
              <input
                className={lowConfidence ? "low-confidence" : undefined}
                type={field.type}
                step={field.type === "number" ? "0.01" : undefined}
                value={form[field.key] ?? ""}
                onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
              />
            </label>
          );
        })}

        {reconciliation && (
          <p className={reconciliation.ok ? "reconcile ok" : "reconcile off"}>
            {reconciliation.ok ? "✓ " : "⚠ "}
            {reconciliation.message}
          </p>
        )}

        {doc.extracted_data?.line_items?.length ? (
          <div className="line-items">
            <h3>Line items ({doc.extracted_data.line_items.length})</h3>
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {doc.extracted_data.line_items.map((item, i) => (
                  <tr key={i}>
                    <td>{item.description ?? "—"}</td>
                    <td className="num">{item.quantity ?? "—"}</td>
                    <td className="num">{formatMoney(item.unit_price)}</td>
                    <td className="num">{formatMoney(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">Line items aren't editable yet — they're carried through as-is.</p>
          </div>
        ) : (
          <p className="hint">The model returned no line items for this document.</p>
        )}

        <div className="review-footer">
          <button className="primary" onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving…" : "Submit review"}
          </button>
          {savedAt !== null && (
            <p key={savedAt} className="saved-note">
              ✓ Saved — marked completed
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
