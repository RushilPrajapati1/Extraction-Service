/**
 * Builds a throwaway copy of the services so the suite never touches the
 * databases or uploads you develop against.
 *
 * Both `extraction-worker/db.py` and `webhook-service/src/db.ts` resolve
 * their sqlite file relative to their own source file, and neither takes
 * an override. So the way to get an isolated database without changing
 * the app is to run an isolated *copy* of the source -- which is what
 * this does, fresh on every run, into e2e/.tmp/.
 *
 * Only the source is copied. node_modules is symlinked (it's large, and
 * nothing writes to it).
 */

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const paths = {
  repoRoot,
  tmp: join(repoRoot, "e2e", ".tmp"),
  worker: join(repoRoot, "e2e", ".tmp", "worker"),
  webhook: join(repoRoot, "e2e", ".tmp", "webhook"),
  frontEnd: join(repoRoot, "front-end"),
  pdfs: join(here, "pdfs"),
  python: join(repoRoot, ".venv", "bin", "python"),
  stubOllama: join(here, "stub_ollama.py"),
  makePdfs: join(here, "make_pdfs.py"),
};

/** Ports the suite runs on. Deliberately not the dev ports -- except the
 *  UI, which must be 5173 because both back ends pin CORS to that origin. */
export const ports = {
  api: 8001,
  webhook: 8788,
  ui: 5173,
  ollama: 11500,
};

export const urls = {
  api: `http://localhost:${ports.api}`,
  webhook: `http://localhost:${ports.webhook}`,
  ui: `http://localhost:${ports.ui}`,
};

/** True inside a Playwright test worker, false in the process that runs the config. */
export function isTestWorker() {
  return process.env.TEST_WORKER_INDEX !== undefined;
}

/**
 * Stage the sandbox. Called at config load, which is before Playwright
 * starts any web server -- the copies have to exist before the commands
 * that run them do.
 */
export function prepareSandbox() {
  // Playwright re-imports the config in every test worker process, and
  // this is called at config load. Only the main process may stage --
  // otherwise a worker starting up wipes the database the API is already
  // serving from.
  if (isTestWorker()) return paths;

  rmSync(paths.tmp, { recursive: true, force: true });
  mkdirSync(paths.worker, { recursive: true });
  mkdirSync(join(paths.webhook, "src"), { recursive: true });

  // The pipeline modules import each other flatly (`import db`), so a
  // flat copy of the .py files is a working package on its own.
  cpSync(join(repoRoot, "extraction-worker"), paths.worker, {
    recursive: true,
    filter: (src) =>
      !/(__pycache__|\.pytest_cache|uploads|ingestion\.db|\.venv)/.test(src),
  });

  cpSync(join(repoRoot, "webhook-service", "src"), join(paths.webhook, "src"), {
    recursive: true,
  });
  cpSync(join(repoRoot, "webhook-service", "package.json"), join(paths.webhook, "package.json"));

  const realModules = join(repoRoot, "webhook-service", "node_modules");
  if (!existsSync(realModules)) {
    throw new Error(
      "webhook-service/node_modules is missing -- run `npm install` in webhook-service first.",
    );
  }
  symlinkSync(realModules, join(paths.webhook, "node_modules"), "dir");

  return paths;
}
