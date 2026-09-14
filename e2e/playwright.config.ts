import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { isTestWorker, paths, ports, prepareSandbox, urls } from "./fixtures/sandbox.mjs";

/** Quote a path for the shell Playwright runs webServer commands through.
 *  The repo lives under a directory with a space in it. */
const q = (value: string) => JSON.stringify(value);

/**
 * The whole stack runs for real: FastAPI, the worker process, the Node
 * webhook service, and the Vite UI. Only two things are substituted.
 *
 *   1. The databases and upload directory, via a throwaway copy of the
 *      services in e2e/.tmp (see fixtures/sandbox.mjs). Your dev data is
 *      untouched, and every run starts empty.
 *   2. Ollama, via fixtures/stub_ollama.py. The worker still runs the
 *      real llm_extract.py -- schema, prompt, retry, JSON parsing -- it
 *      just gets a fixed answer back instead of a 7B model's guess. A
 *      suite that asserted on what Mistral said would be asserting on
 *      the weather.
 *
 * Everything else -- claiming, validation, routing, signing, retries,
 * the review round trip -- is the production code path.
 */

// Runs at config load, which is before Playwright launches any server:
// the copies have to exist before the commands that run them do.
prepareSandbox();
if (!isTestWorker()) {
  execFileSync(paths.python, [paths.makePdfs, paths.pdfs], { stdio: "inherit" });
}

const pythonEnv = {
  OLLAMA_HOST: `http://127.0.0.1:${ports.ollama}`,
  WEBHOOK_SERVICE_URL: urls.webhook,
  STORAGE_BACKEND: "local",
  PYTHONUNBUFFERED: "1",
};

export default defineConfig({
  testDir: "./tests",
  // The worker is a polling process, not a server, so it can't be a
  // webServer entry -- it starts here, once the API has created the
  // database it drains.
  globalSetup: "./fixtures/global-setup.ts",
  globalTeardown: "./fixtures/global-teardown.ts",
  outputDir: "./test-results",
  fullyParallel: false, // one worker queue, one database -- tests share a pipeline
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  // Documents take a couple of poll cycles to move through the worker,
  // so the default 5s expect timeout is too tight for status assertions.
  expect: { timeout: 20_000 },
  timeout: 90_000,

  use: {
    baseURL: urls.ui,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: `${q(paths.python)} ${q(paths.stubOllama)} ${ports.ollama}`,
      url: `http://127.0.0.1:${ports.ollama}/api/version`,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `${q(paths.python)} -m uvicorn ingest:app --port ${ports.api}`,
      cwd: paths.worker,
      url: `${urls.api}/documents`,
      env: pythonEnv,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: "node src/index.ts",
      cwd: paths.webhook,
      url: `${urls.webhook}/health`,
      env: { ...pythonEnv, PORT: String(ports.webhook) },
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `npm run dev -- --port ${ports.ui} --strictPort`,
      cwd: paths.frontEnd,
      url: urls.ui,
      env: {
        VITE_API_BASE: urls.api,
        VITE_WEBHOOK_BASE: urls.webhook,
      },
      reuseExistingServer: false,
      stdout: "pipe",
    },
  ],
});
