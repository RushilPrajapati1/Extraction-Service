/**
 * Document extraction pipeline -- operator UI.
 *
 * Upload PDFs, watch them move through the pipeline, correct whatever
 * the model got wrong, and see the webhooks that fired as a result.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAllDocuments,
  fetchReviewQueue,
  isTerminal,
  retryDocument,
  type DocumentSummary,
} from "./api";
import { ReviewPane } from "./ReviewPane";
import { Uploader } from "./Uploader";
import { Deliveries } from "./Deliveries";
import "./App.css";

type Filter = "review" | "all";
type Tab = "documents" | "deliveries";

/** How often to re-poll while something is still in flight. */
const POLL_MS = 2000;

/** "just now", "4 min ago", "2 h ago" -- exact time is in the tooltip. */
function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status.replace("_", " ")}</span>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("documents");
  const [filter, setFilter] = useState<Filter>("all");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Held in a ref so the polling effect can read the current filter
  // without tearing down and recreating the interval on every change.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const loadQueue = useCallback(async () => {
    try {
      const { documents } =
        filterRef.current === "review" ? await fetchReviewQueue() : await fetchAllDocuments();
      setDocuments(documents);
      setError(null);
      setSelectedId((current) =>
        current && documents.some((d) => d.id === current) ? current : null,
      );
    } catch (e) {
      setError(`${e}. Is the API running on :8000?`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadQueue();
  }, [filter, loadQueue]);

  // Poll only while something is actually moving. A queue of finished
  // documents doesn't need refreshing, and idle polling is just noise in
  // the network tab.
  const hasInFlight = documents.some((d) => !isTerminal(d.status));
  useEffect(() => {
    if (!hasInFlight || tab !== "documents") return;
    const timer = setInterval(() => void loadQueue(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasInFlight, tab, loadQueue]);

  async function handleRetry(id: string) {
    try {
      await retryDocument(id);
      await loadQueue();
    } catch (e) {
      setError(String(e));
    }
  }

  const inFlightCount = documents.filter((d) => !isTerminal(d.status)).length;
  const reviewCount = documents.filter((d) => d.status === "needs_review").length;

  // Surface the backlog in the tab so it's visible from another window.
  useEffect(() => {
    document.title = reviewCount > 0 ? `(${reviewCount}) Extraction review` : "Extraction review";
  }, [reviewCount]);

  return (
    <div className="app">
      <aside className="queue">
        <header>
          <h1>Documents</h1>
          <Uploader onUploaded={loadQueue} />

          <div className="filters">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
              All
            </button>
            <button
              className={filter === "review" ? "active" : ""}
              onClick={() => setFilter("review")}
            >
              Needs review{reviewCount > 0 && filter === "all" ? ` (${reviewCount})` : ""}
            </button>
          </div>

          {inFlightCount > 0 && (
            <p className="processing-note">
              <span className="pulse" /> {inFlightCount} processing…
            </p>
          )}
        </header>

        {error && <p className="pane-message error">{error}</p>}
        {loading && <p className="pane-message">Loading…</p>}
        {!loading && !error && documents.length === 0 && (
          <p className="pane-message">
            {filter === "review" ? "Nothing waiting for review." : "No documents yet — upload one."}
          </p>
        )}

        <ul>
          {documents.map((doc) => (
            <li key={doc.id}>
              <button
                className={doc.id === selectedId ? "queue-item selected" : "queue-item"}
                onClick={() => {
                  setSelectedId(doc.id);
                  setTab("documents");
                }}
                // A document mid-pipeline has nothing to show yet.
                disabled={!isTerminal(doc.status)}
              >
                <span className="queue-filename">{doc.filename}</span>
                <span className="queue-meta">
                  <StatusBadge status={doc.status} />
                  {doc.confidence !== null && (
                    <span className="queue-confidence">{doc.confidence.toFixed(2)}</span>
                  )}
                  <span className="queue-time" title={new Date(doc.updated_at).toLocaleString()}>
                    {relativeTime(doc.updated_at)}
                  </span>
                </span>
              </button>
              {doc.status === "failed" && (
                <button className="retry-link" onClick={() => void handleRetry(doc.id)}>
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <main className="detail">
        <nav className="tabs">
          <button
            className={tab === "documents" ? "active" : ""}
            onClick={() => setTab("documents")}
          >
            Review
          </button>
          <button
            className={tab === "deliveries" ? "active" : ""}
            onClick={() => setTab("deliveries")}
          >
            Webhooks
          </button>
        </nav>

        <div className="tab-body">
          {tab === "deliveries" ? (
            <Deliveries />
          ) : selectedId ? (
            <ReviewPane documentId={selectedId} onReviewed={loadQueue} key={selectedId} />
          ) : (
            <div className="pane-message">
              Select a processed document to review it, or upload a new one.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
