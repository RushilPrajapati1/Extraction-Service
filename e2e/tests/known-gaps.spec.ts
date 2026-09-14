/**
 * Where the app does not yet do what it should.
 *
 * Each test below states the *expected* behaviour and is marked
 * `test.fail()`, so the suite stays green while the gap is open and goes
 * red the moment one is fixed -- at which point delete the `test.fail`
 * and the test becomes an ordinary guarantee.
 *
 * This file is the difference between "the tests pass" and "the app is
 * finished". Two of these are defects; the rest are limitations the
 * README already owns, pinned here so they can't drift into surprises.
 */

import { expect, test } from "@playwright/test";
import { getDocument, uploadViaApi, urls, waitForTerminal } from "./helpers";

test.describe("defects", () => {
  test.fail(
    "review should refuse a document a worker still owns",
    async ({ request }) => {
      // The slow fixture keeps the document in 'processing' long enough
      // to submit a review against it.
      const id = await uploadViaApi(request, "slow");
      await expect.poll(async () => (await getDocument(request, id)).status).toBe("processing");

      // POST /retry guards on status; POST /review does not, so this is
      // accepted -- and the worker then overwrites the human's outcome.
      const response = await request.post(`${urls.api}/documents/${id}/review`, {
        data: { vendor_name: "Corrected by a human" },
      });

      // Expected: 409, the same guard /retry uses.
      expect(response.status()).toBe(409);
    },
  );

  test.fail(
    "a human's review should not be undone by the worker finishing afterwards",
    async ({ request }) => {
      // Escalating *and* slow: if the worker's own verdict were
      // 'completed' this would pass whether or not the review survived.
      const id = await uploadViaApi(request, "slowMismatched");
      await expect.poll(async () => (await getDocument(request, id)).status).toBe("processing");

      await request.post(`${urls.api}/documents/${id}/review`, {
        data: { vendor_name: "Corrected by a human" },
      });

      // The review already set status to 'completed', so waiting on a
      // terminal status would return before the worker writes. What
      // marks the worker as finished is extracted_data appearing.
      await expect
        .poll(async () => (await getDocument(request, id)).extracted_data !== null, {
          message: "the worker never finished the document",
        })
        .toBe(true);

      const record = await getDocument(request, id);
      // Actual: the worker's update_document_extraction runs last and
      // resets status to 'needs_review' with needs_review = 1, so the
      // document reappears in the queue as if nobody had looked at it --
      // even though reviewed_data is sitting right there.
      expect(record.reviewed_data).not.toBeNull();
      expect(record.status).toBe("completed");
      expect(record.needs_review).toBe(0);
    },
  );

  test.fail(
    "requeuing a document should take it out of the review queue",
    async ({ request }) => {
      const id = await uploadViaApi(request, "mismatched");
      await waitForTerminal(request, id);

      await request.post(`${urls.api}/documents/${id}/retry`);
      const record = await getDocument(request, id);
      expect(record.status).toBe("uploaded");

      // Actual: update_document_status only writes `status`, so
      // needs_review stays 1 and confidence keeps its stale value. The
      // document shows up under "Needs review" with a status of
      // 'uploaded', where the UI then disables the row because it isn't
      // terminal -- an unclickable entry in the review queue.
      expect(record.needs_review).toBe(0);
      expect(record.confidence).toBeNull();

      const queue = (
        await (await request.get(`${urls.api}/documents?needs_review=true`)).json()
      ).documents;
      expect(queue.map((d: { id: string }) => d.id)).not.toContain(id);
    },
  );
});

test.describe("known limitations", () => {
  test.fail("a scanned PDF with no text layer should not be extracted silently", async ({
    request,
  }) => {
    const id = await uploadViaApi(request, "scanned");
    const record = await waitForTerminal(request, id);

    // Actual: extract_text returns "", which is handed to the model as
    // if it were the document. The model answers about nothing, and the
    // pipeline reports a normal result. Expected: the document is
    // flagged as unreadable rather than extracted from thin air.
    expect(record.raw_text?.trim()).not.toBe("");
    expect(record.status).not.toBe("completed");
  });

  test.fail("an upload that isn't a PDF should be rejected at ingest", async ({ request }) => {
    // The check is on the client-supplied content-type alone, so any
    // bytes get in as long as the header says application/pdf. Expected:
    // a magic-number check, so the failure is a 400 at the door rather
    // than a 'failed' document minutes later.
    const response = await request.post(`${urls.api}/ingest/`, {
      multipart: {
        file: {
          name: "fake.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("not a pdf at all"),
        },
      },
    });

    expect(response.status()).toBe(400);
  });

  test.fail("an event should survive webhook-service being unavailable", async ({ request }) => {
    // events.publish is fire-and-forget over HTTP with no outbox, so an
    // event published while the service is down is simply gone. This
    // asserts the durable behaviour a real system needs: the event is
    // replayable from the document record.
    const id = await uploadViaApi(request, "clean");
    await waitForTerminal(request, id);

    const response = await request.get(`${urls.api}/documents/${id}/events`);
    expect(response.status()).toBe(200);
  });
});
