/**
 * Webhook delivery log.
 *
 * Exists so the webhook service isn't invisible plumbing: you can see
 * that an event fired, which endpoint it went to, how many attempts it
 * took, and what failed.
 */

import { useEffect, useState } from "react";
import { fetchDeliveries, type WebhookDelivery } from "./api";

export function Deliveries() {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = () =>
      fetchDeliveries().then((rows) => {
        if (cancelled) return;
        setDeliveries(rows);
        setLoaded(true);
      });

    void load();
    // Pending deliveries are retried on a backoff, so poll to watch
    // attempt counts climb rather than requiring a manual refresh.
    const timer = setInterval(() => void load(), 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (loaded && deliveries.length === 0) {
    return (
      <div className="pane-message">
        No webhook deliveries yet. Is webhook-service running on :8787? Process a document to
        trigger one.
      </div>
    );
  }

  return (
    <div className="deliveries">
      <h2>Webhook deliveries</h2>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Endpoint</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>HTTP</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td>
                <code>{d.event_type}</code>
              </td>
              <td className="url">{d.url}</td>
              <td>
                <span className={`badge badge-${d.status}`}>{d.status}</span>
              </td>
              <td>{d.attempts}</td>
              <td>{d.response_status ?? "—"}</td>
              <td>{new Date(d.created_at).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {deliveries.some((d) => d.error) && (
        <div className="delivery-errors">
          <h3>Recent errors</h3>
          {deliveries
            .filter((d) => d.error)
            .slice(0, 5)
            .map((d) => (
              <p key={d.id}>
                <code>{d.event_type}</code> → {d.error}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
