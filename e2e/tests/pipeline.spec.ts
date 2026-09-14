/**
 * The routing contract: what has to be true of a document for the
 * pipeline to let it through without a human.
 *
 * Every case here goes in as a PDF and comes out as a database record --
 * the real worker, the real validation rules. Only the model's answer is
 * fixed (see fixtures/stub_ollama.py), because a test that asserted on
 * what Mistral happened to say would be asserting on the weather.
 */

import { expect, test } from "@playwright/test";
import { fixtureBytes, getDocument, uploadViaApi, urls, waitForTerminal } from "./helpers";

test.describe("document lifecycle", () => {
  test("an upload is queued, not processed in the request", async ({ request }) => {
    const response = await request.post(`${urls.api}/ingest/`, {
      multipart: {
        file: {
          name: "queued.pdf",
          mimeType: "application/pdf",
          buffer: fixtureBytes("clean"),
        },
      },
    });

    // 202, not 200: the work has been accepted, not done.
    expect(response.status()).toBe(202);
    const body = await response.json();
    expect(body.status).toBe("uploaded");
    expect(body.document_id).toMatch(/^[0-9a-f-]{36}$/);

    // Nothing has been extracted yet -- that's the worker's job.
    const record = await getDocument(request, body.document_id);
    expect(["uploaded", "processing"]).toContain(record.status);
    expect(record.extracted_data).toBeNull();
  });

  test("text extraction is recorded before the model is called", async ({ request }) => {
    const id = await uploadViaApi(request, "clean");
    const record = await waitForTerminal(request, id);

    // raw_text being non-null is how the schema records "text extraction
    // succeeded" -- there is deliberately no separate status for it.
    expect(record.raw_text).toContain("CLEANLINE SUPPLY CO");
    expect(record.raw_text).toContain("Total Due: 108.25");
  });
});

test.describe("routing decisions", () => {
  test("an invoice that reconciles and scores high auto-completes", async ({ request }) => {
    const id = await uploadViaApi(request, "clean");
    const record = await waitForTerminal(request, id);

    expect(record.status).toBe("completed");
    expect(record.needs_review).toBe(0);
    expect(record.confidence).toBeGreaterThanOrEqual(0.7);
    expect(record.extracted_data).toMatchObject({
      vendor_name: "Cleanline Supply Co",
      subtotal: 100,
      tax: 8.25,
      total: 108.25,
    });
  });

  test("line items that contradict the subtotal escalate to review", async ({ request }) => {
    const id = await uploadViaApi(request, "mismatched");
    const record = await waitForTerminal(request, id);

    // The model rated every field 1.0, so confidence alone (0.75 after
    // the rule-failure penalty) would have cleared the 0.7 threshold.
    // It's escalated because a rule *failed*, which no amount of
    // self-reported certainty can excuse.
    expect(record.status).toBe("needs_review");
    expect(record.needs_review).toBe(1);
    expect(record.confidence).toBeGreaterThan(0.7);
    expect(record.extracted_data).toMatchObject({ subtotal: 127.5, total: 137.7 });
  });

  test("a total that cannot be reconciled escalates however sure the model is", async ({
    request,
  }) => {
    const id = await uploadViaApi(request, "unverifiable");
    const record = await waitForTerminal(request, id);

    // No subtotal and no line items, so `subtotal + tax == total` could
    // not run. This is the gate that stops a self-assured model buying
    // its way past an unverified total: it claimed 1.0 on every field.
    expect(record.extracted_data?.confidence).toMatchObject({ total: 1 });
    expect(record.status).toBe("needs_review");
    expect(record.needs_review).toBe(1);
  });

  test("a missing required field escalates to review", async ({ request }) => {
    const id = await uploadViaApi(request, "missingTotal");
    const record = await waitForTerminal(request, id);

    expect(record.status).toBe("needs_review");
    expect(record.extracted_data).not.toHaveProperty("total");
  });
});

test.describe("failure handling", () => {
  test("a model answer that isn't JSON fails the document, keeping the text", async ({
    request,
  }) => {
    const id = await uploadViaApi(request, "unparseable");
    const record = await waitForTerminal(request, id);

    expect(record.status).toBe("failed");
    // The text we did extract survives the failure -- it's exactly what
    // you want when working out why the model choked.
    expect(record.raw_text).toContain("GIBBERISH INC");
  });

  test("a file that isn't really a PDF fails in the worker, not the request", async ({
    request,
  }) => {
    // The API trusts the client's content-type, so this is accepted...
    const id = await uploadViaApi(request, "fakePdf");
    const record = await waitForTerminal(request, id);

    // ...and only falls over when the worker tries to read it.
    expect(record.status).toBe("failed");
    expect(record.raw_text).toBeNull();
  });

  test("a failed document can be requeued and runs again", async ({ request }) => {
    const id = await uploadViaApi(request, "unparseable");
    await waitForTerminal(request, id);

    const retry = await request.post(`${urls.api}/documents/${id}/retry`);
    expect(retry.ok()).toBeTruthy();
    expect((await retry.json()).status).toBe("uploaded");

    // Requeuing is the whole retry mechanism: the claim query only looks
    // at 'uploaded', so putting it back is enough to rerun the pipeline.
    const record = await waitForTerminal(request, id);
    expect(record.status).toBe("failed");
  });

  test("documents are processed independently -- one failure doesn't stall the queue", async ({
    request,
  }) => {
    const poison = await uploadViaApi(request, "unparseable");
    const healthy = await uploadViaApi(request, "clean");

    expect((await waitForTerminal(request, poison)).status).toBe("failed");
    expect((await waitForTerminal(request, healthy)).status).toBe("completed");
  });
});
