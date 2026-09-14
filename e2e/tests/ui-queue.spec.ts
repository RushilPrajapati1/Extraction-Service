/**
 * The operator's view of the queue: uploading, watching things move,
 * filtering, and retrying.
 */

import { expect, test } from "@playwright/test";
import { queueBadge, queueRow, uniqueName, uploadViaApi, uploadViaUi, urls, waitForTerminal } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("uploading a PDF puts it in the queue and walks it to a terminal state", async ({ page }) => {
  const filename = await uploadViaUi(page, "clean");

  await expect(queueRow(page, filename)).toBeVisible();

  // The interesting part is that the operator never refreshes: the UI
  // polls while anything is in flight and stops once nothing is.
  await expect(queueBadge(page, filename)).toHaveText("completed", { timeout: 60_000 });
});

test("rejects a non-PDF in the uploader, with the server's reason", async ({ page }) => {
  await uploadViaUi(page, "notPdf", uniqueName("notes", "txt"));

  await expect(page.locator(".upload-error")).toContainText("Only PDF files are allowed");
});

test("shows a progress note while documents are in flight", async ({ page }) => {
  await uploadViaUi(page, "clean");

  await expect(page.locator(".processing-note")).toContainText(/processing/);
  // And takes it away again once the queue settles.
  await expect(page.locator(".processing-note")).toBeHidden({ timeout: 60_000 });
});

test("an in-flight document can't be opened -- there's nothing to show yet", async ({ page }) => {
  const filename = await uploadViaUi(page, "clean");
  const row = queueRow(page, filename).locator("button.queue-item");

  await expect(row).toBeDisabled();
  await expect(row).toBeEnabled({ timeout: 60_000 });
});

test("uploads several files at once", async ({ page }) => {
  const names = [uniqueName("batch-a"), uniqueName("batch-b"), uniqueName("batch-c")];
  const { fixtureBytes } = await import("./helpers");

  await page.locator(".uploader input[type=file]").setInputFiles(
    names.map((name) => ({ name, mimeType: "application/pdf", buffer: fixtureBytes("clean") })),
  );

  for (const name of names) {
    await expect(queueRow(page, name)).toBeVisible();
    await expect(queueBadge(page, name)).toHaveText("completed", { timeout: 90_000 });
  }
});

test("the 'Needs review' filter narrows the queue to escalated documents", async ({
  page,
  request,
}) => {
  const escalated = uniqueName("escalated");
  const auto = uniqueName("auto");
  await uploadViaApi(request, "mismatched", escalated);
  const autoId = await uploadViaApi(request, "clean", auto);
  await waitForTerminal(request, autoId);

  await page.reload();
  await expect(queueBadge(page, escalated)).toHaveText("needs review", { timeout: 60_000 });

  await page.getByRole("button", { name: /Needs review/ }).click();

  await expect(queueRow(page, escalated)).toBeVisible();
  await expect(queueRow(page, auto)).toBeHidden();
});

test("a failed document offers a retry, and retrying reruns it", async ({ page, request }) => {
  const filename = uniqueName("broken");
  const id = await uploadViaApi(request, "unparseable", filename);
  await waitForTerminal(request, id);

  await page.reload();
  await expect(queueBadge(page, filename)).toHaveText("failed");

  const retry = queueRow(page, filename).getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await retry.click();

  // Back to the top of the pipeline, then back to failed -- the document
  // is genuinely unprocessable, but the operator could act on it.
  await expect(queueBadge(page, filename)).toHaveText("failed", { timeout: 60_000 });
});

test("says so plainly when the API is unreachable", async ({ page }) => {
  await page.route(`${urls.api}/documents*`, (route) => route.abort());
  await page.reload();

  await expect(page.locator(".pane-message.error")).toContainText("Is the API running");
});
