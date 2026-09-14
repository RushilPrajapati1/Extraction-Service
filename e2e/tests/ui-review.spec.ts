/**
 * The human-review loop: see the document next to what the model read
 * off it, correct what's wrong, submit, and have that stick.
 */

import { expect, test } from "@playwright/test";
import {
  fieldConfidence,
  getDocument,
  queueBadge,
  queueRow,
  reviewField,
  uniqueName,
  uploadViaApi,
  waitForTerminal,
} from "./helpers";

/** Put an escalated document in the queue and open it for review. */
async function openForReview(page: import("@playwright/test").Page, request: any, fixture: any) {
  const filename = uniqueName("review");
  const id = await uploadViaApi(request, fixture, filename);
  await waitForTerminal(request, id);

  await page.goto("/");
  await expect(queueBadge(page, filename)).toHaveText("needs review", { timeout: 60_000 });
  await queueRow(page, filename).locator("button.queue-item").click();
  await expect(page.locator(".review-pane")).toBeVisible();

  return { id, filename };
}

test("shows the original document beside the extracted fields", async ({ page, request }) => {
  const { id, filename } = await openForReview(page, request, "mismatched");

  const frame = page.locator(".review-document iframe");
  await expect(frame).toHaveAttribute("src", new RegExp(`/documents/${id}/file$`));

  await expect(page.locator(".review-fields h2")).toHaveText(filename);
  await expect(page.locator(".review-fields .meta")).toContainText("needs_review");
});

test("pre-fills every field from the model's extraction", async ({ page, request }) => {
  await openForReview(page, request, "mismatched");

  await expect(reviewField(page, "Vendor")).toHaveValue("Acme Office Supplies");
  await expect(reviewField(page, "Invoice date")).toHaveValue("2026-03-03");
  await expect(reviewField(page, "Invoice number")).toHaveValue("INV-20394");
  await expect(reviewField(page, "Subtotal")).toHaveValue("127.5");
  await expect(reviewField(page, "Tax")).toHaveValue("10.2");
  await expect(reviewField(page, "Total")).toHaveValue("137.7");
});

test("surfaces per-field confidence, including fields the model never scored", async ({
  page,
  request,
}) => {
  await openForReview(page, request, "missingTotal");

  // The stub scores vendor_name but not invoice_date -- and an unscored
  // field has to look different from a confidently-scored one, or a thin
  // extraction reads as a good one.
  await expect(fieldConfidence(page, "Vendor")).toHaveText("0.90");
  await expect(fieldConfidence(page, "Invoice date")).toHaveText("not scored");
});

test("carries line items through read-only", async ({ page, request }) => {
  await openForReview(page, request, "mismatched");

  const table = page.locator(".line-items table");
  await expect(page.locator(".line-items h3")).toHaveText("Line items (1)");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr").first()).toContainText("Copy Paper");
  await expect(table.locator("tbody tr").first()).toContainText("45");

  // Known gap, stated in the UI rather than hidden.
  await expect(page.locator(".line-items .hint")).toContainText("aren't editable yet");
});

test("says so when the model returned no line items", async ({ page, request }) => {
  await openForReview(page, request, "unverifiable");

  await expect(page.locator(".review-fields .hint")).toContainText("no line items");
  await expect(page.locator(".line-items")).toHaveCount(0);
});

test("a submitted correction completes the document and leaves the queue", async ({
  page,
  request,
}) => {
  const { id, filename } = await openForReview(page, request, "mismatched");

  await reviewField(page, "Vendor").fill("Acme Office Supplies Ltd");
  await reviewField(page, "Subtotal").fill("45.00");
  await reviewField(page, "Total").fill("55.20");
  await page.getByRole("button", { name: "Submit review" }).click();

  await expect(queueBadge(page, filename)).toHaveText("completed", { timeout: 30_000 });

  const record = await getDocument(request, id);
  expect(record.reviewed_data).toMatchObject({
    vendor_name: "Acme Office Supplies Ltd",
    subtotal: 45,
    total: 55.2,
  });
  // Numbers go in as numbers, not the strings the form held them as.
  expect(typeof record.reviewed_data?.subtotal).toBe("number");
  // And the model's original answer is untouched.
  expect(record.extracted_data).toMatchObject({ subtotal: 127.5 });
});

test("reopening a reviewed document shows the human's version, not the model's", async ({
  page,
  request,
}) => {
  const { filename } = await openForReview(page, request, "mismatched");

  await reviewField(page, "Vendor").fill("Corrected By Hand");
  await page.getByRole("button", { name: "Submit review" }).click();
  await expect(queueBadge(page, filename)).toHaveText("completed", { timeout: 30_000 });

  await page.reload();
  await queueRow(page, filename).locator("button.queue-item").click();

  await expect(reviewField(page, "Vendor")).toHaveValue("Corrected By Hand");
});

test("a blanked field is omitted rather than saved as an empty string", async ({
  page,
  request,
}) => {
  const { id, filename } = await openForReview(page, request, "mismatched");

  await reviewField(page, "Invoice number").fill("");
  await page.getByRole("button", { name: "Submit review" }).click();
  await expect(queueBadge(page, filename)).toHaveText("completed", { timeout: 30_000 });

  const record = await getDocument(request, id);
  expect(record.reviewed_data).not.toHaveProperty("invoice_number");
});

test("line items survive a review that didn't touch them", async ({ page, request }) => {
  const { id, filename } = await openForReview(page, request, "mismatched");

  await reviewField(page, "Vendor").fill("Untouched Line Items Co");
  await page.getByRole("button", { name: "Submit review" }).click();
  await expect(queueBadge(page, filename)).toHaveText("completed", { timeout: 30_000 });

  const record = await getDocument(request, id);
  expect(record.reviewed_data?.line_items).toHaveLength(1);
});
