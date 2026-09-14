/**
 * The HTTP surface, checked directly.
 *
 * These are the promises the UI (and any other client) is built on:
 * which status codes come back, what the review queue filter means, and
 * what the API refuses to do.
 */

import { expect, test } from "@playwright/test";
import { fixtureBytes, getDocument, uploadViaApi, urls, uniqueName, waitForTerminal } from "./helpers";

test.describe("ingest", () => {
  test("rejects a non-PDF upload with a readable reason", async ({ request }) => {
    const response = await request.post(`${urls.api}/ingest/`, {
      multipart: {
        file: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
      },
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).detail).toContain("Only PDF files are allowed");
  });

  test("stores the file under an id, never the client's filename", async ({ request }) => {
    // A filename is attacker-controlled; if it reached the storage path,
    // this would walk out of the upload directory.
    const hostile = "../../../../tmp/escaped.pdf";
    const response = await request.post(`${urls.api}/ingest/`, {
      multipart: {
        file: { name: hostile, mimeType: "application/pdf", buffer: fixtureBytes("clean") },
      },
    });
    expect(response.status()).toBe(202);

    const id = (await response.json()).document_id;
    const record = await request.get(`${urls.api}/documents/${id}`);
    const body = await record.json();

    // The name is kept as metadata, where it can't influence anything...
    expect(body.filename).toBe(hostile);
    // ...and the bytes land at <uuid>.pdf inside the upload directory.
    expect(body.storage_path).toContain(`${id}.pdf`);
    expect(body.storage_path).not.toContain("..");
  });
});

test.describe("reading documents", () => {
  test("404s on an unknown id across every endpoint", async ({ request }) => {
    const missing = "00000000-0000-0000-0000-000000000000";

    expect((await request.get(`${urls.api}/documents/${missing}`)).status()).toBe(404);
    expect((await request.get(`${urls.api}/documents/${missing}/file`)).status()).toBe(404);
    expect((await request.post(`${urls.api}/documents/${missing}/retry`)).status()).toBe(404);
    expect(
      (await request.post(`${urls.api}/documents/${missing}/review`, { data: {} })).status(),
    ).toBe(404);
  });

  test("serves the original PDF back for side-by-side review", async ({ request }) => {
    const filename = uniqueName("served");
    const id = await uploadViaApi(request, "clean", filename);

    const response = await request.get(`${urls.api}/documents/${id}/file`);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toContain("application/pdf");
    expect(response.headers()["content-disposition"]).toContain(filename);
    expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("the list view omits the heavy fields", async ({ request }) => {
    await uploadViaApi(request, "clean");

    const rows = (await (await request.get(`${urls.api}/documents`)).json()).documents;
    expect(rows.length).toBeGreaterThan(0);

    // Pulling raw_text and extracted_data for every row would make the
    // queue endpoint needlessly heavy; the detail endpoint has them.
    expect(rows[0]).not.toHaveProperty("raw_text");
    expect(rows[0]).not.toHaveProperty("extracted_data");
    expect(rows[0]).toHaveProperty("confidence");
  });

  test("?needs_review=true returns exactly the review queue", async ({ request }) => {
    const escalated = await uploadViaApi(request, "mismatched");
    const auto = await uploadViaApi(request, "clean");
    await waitForTerminal(request, escalated);
    await waitForTerminal(request, auto);

    const queue = (
      await (await request.get(`${urls.api}/documents?needs_review=true`)).json()
    ).documents;
    const ids = queue.map((d: { id: string }) => d.id);

    expect(ids).toContain(escalated);
    expect(ids).not.toContain(auto);
  });

  test("lists newest first", async ({ request }) => {
    const first = uniqueName("older");
    const second = uniqueName("newer");
    await uploadViaApi(request, "clean", first);
    await uploadViaApi(request, "clean", second);

    const rows = (await (await request.get(`${urls.api}/documents`)).json()).documents;
    const names = rows.map((d: { filename: string }) => d.filename);
    expect(names.indexOf(second)).toBeLessThan(names.indexOf(first));
  });
});

test.describe("retry", () => {
  test("refuses to requeue a document a worker already owns", async ({ request }) => {
    // The slow fixture holds the model call open, so the document is
    // reliably observable in flight rather than racing an instant stub.
    const id = await uploadViaApi(request, "slow");
    await expect.poll(async () => (await getDocument(request, id)).status).toBe("processing");

    // Requeuing now would have the document extracted twice.
    const response = await request.post(`${urls.api}/documents/${id}/retry`);
    expect(response.status()).toBe(409);
    expect((await response.json()).detail).toContain("processing");

    // ...and it still finishes normally afterwards.
    expect((await waitForTerminal(request, id)).status).toBe("completed");
  });
});

test.describe("review", () => {
  test("stores corrections separately from what the model said", async ({ request }) => {
    const id = await uploadViaApi(request, "mismatched");
    await waitForTerminal(request, id);

    const corrected = {
      vendor_name: "Acme Office Supplies",
      invoice_date: "2026-03-03",
      invoice_number: "INV-20394",
      subtotal: 127.5,
      tax: 10.2,
      total: 137.7,
    };
    const response = await request.post(`${urls.api}/documents/${id}/review`, { data: corrected });
    expect(response.ok()).toBeTruthy();

    const record = await getDocument(request, id);
    expect(record.status).toBe("completed");
    expect(record.needs_review).toBe(0);
    expect(record.reviewed_at).not.toBeNull();
    expect(record.reviewed_data).toMatchObject(corrected);

    // The model's original output is left intact -- the diff between the
    // two is the signal for improving the prompt.
    expect(record.extracted_data).toMatchObject({ vendor_name: "Acme Office Supplies" });
    expect(record.extracted_data).not.toEqual(record.reviewed_data);
  });

  test("a reviewed document leaves the review queue", async ({ request }) => {
    const id = await uploadViaApi(request, "mismatched");
    await waitForTerminal(request, id);

    await request.post(`${urls.api}/documents/${id}/review`, { data: { vendor_name: "Reviewed" } });

    const queue = (
      await (await request.get(`${urls.api}/documents?needs_review=true`)).json()
    ).documents;
    expect(queue.map((d: { id: string }) => d.id)).not.toContain(id);
  });
});
