# End-to-end suite

Drives the whole pipeline the way an operator does — upload a PDF, watch
it move, correct what the model got wrong, check the webhook fired — and
pins each step to what it's *supposed* to do.

```bash
cd e2e
npm install
npx playwright install chromium
npm test
```

Nothing needs to be running first. Playwright starts the API, the worker,
the webhook service and the UI itself, and stops them afterwards.

## What's real and what isn't

Everything is the production code path except two things:

**The databases and upload directory.** `extraction-worker/db.py` and
`webhook-service/src/db.ts` both resolve their sqlite file relative to
their own source file, with no override. So `fixtures/sandbox.mjs` copies
the services into `e2e/.tmp/` and runs *those*, fresh every run. Your dev
data is never touched, and no test inherits another run's queue.

**Ollama.** `fixtures/stub_ollama.py` answers `/api/chat` with a fixed
extraction. The worker still runs the real `llm_extract.py` — the schema,
the prompt, the retry, the JSON parsing — it just gets a known answer
back. A suite that asserted on what Mistral happened to say that morning
would be asserting on the weather, and the thing under test here is the
*pipeline's* behaviour, not the model's.

Which answer comes back is keyed off a `SCENARIO-*` marker printed inside
each fixture PDF, so a test picks the model's behaviour by choosing which
file it uploads:

| Fixture          | The model returns                        | Expected outcome |
| ---------------- | ---------------------------------------- | ---------------- |
| `clean`          | everything, reconciling, high confidence | `completed`      |
| `mismatched`     | line items (45) vs. stated subtotal (127.50) | `needs_review` |
| `unverifiable`   | a total, but no subtotal and no line items | `needs_review` |
| `missingTotal`   | no `total` at all                        | `needs_review`   |
| `unparseable`    | prose instead of JSON                    | `failed`         |
| `slow`           | `clean`, after a ~6s pause               | `completed`      |
| `slowMismatched` | `mismatched`, after a ~6s pause          | `needs_review`   |
| `scanned`        | — (the PDF has no text layer)            | see known-gaps   |
| `fakePdf`        | — (not a PDF despite the content-type)   | `failed`         |

The two slow fixtures exist so a test can reliably observe a document
*while a worker owns it* — racing an instant stub would make those tests
pass or skip at random.

## Ports

The suite runs on its own ports so it doesn't collide with `./start.sh`:
API `8001`, webhooks `8788`, stub Ollama `11500`. The UI is the exception
— it must be **5173**, because both back ends pin CORS to that origin, so
stop your dev server before running the suite.

## The files

| File                        | Covers                                                    |
| --------------------------- | --------------------------------------------------------- |
| `tests/pipeline.spec.ts`    | The routing contract: what earns `completed` vs. `needs_review` vs. `failed`. |
| `tests/api-contract.spec.ts`| Status codes, the review-queue filter, what the API refuses. |
| `tests/ui-queue.spec.ts`    | Uploading, live status, filtering, retry, API-down.        |
| `tests/ui-review.spec.ts`   | The side-by-side review loop and what a correction stores. |
| `tests/webhooks.spec.ts`    | Signing, verification, event routing, retry with backoff.  |
| `tests/known-gaps.spec.ts`  | Where the app does **not** yet do the right thing.          |

## known-gaps.spec.ts

Every test in that file states the behaviour the system *should* have and
is marked `test.fail()`. While the gap is open the test fails, which is
what the suite expects, so the run stays green. The moment someone fixes
the underlying issue, the test passes unexpectedly and the run goes
**red** — at which point you delete the `test.fail` and it becomes an
ordinary guarantee.

It's the difference between "the tests pass" and "the app is finished".
Two of the six are defects; the rest are limitations the top-level README
already owns, pinned here so they can't quietly drift into surprises.

## Notes for adding tests

- Tests share one queue and one database, and run with `workers: 1`. Give
  every upload a unique filename (`uniqueName()`) so assertions can find
  their own document among the others.
- There's no request to await for pipeline work — it's asynchronous by
  design. Use `waitForTerminal()`, or `expect.poll` on the record.
- `waitForTerminal` returns as soon as the *status* is terminal. If a
  review has already set the status to `completed`, poll on
  `extracted_data` instead to know the worker actually finished.
