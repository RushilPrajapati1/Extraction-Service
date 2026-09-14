/**
 * Runs the extraction worker for the duration of the suite.
 *
 * It can't be a Playwright `webServer` entry: those are identified by a
 * URL they serve, and the worker deliberately has no HTTP surface -- it
 * is a process that polls the database. So it's started in globalSetup,
 * once the API has created that database, and stopped in globalTeardown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { paths, ports, urls } from "./sandbox.mjs";

let worker: ChildProcess | undefined;

export async function startWorker(): Promise<void> {
  worker = spawn(paths.python, ["worker.py"], {
    cwd: paths.worker,
    env: {
      ...process.env,
      OLLAMA_HOST: `http://127.0.0.1:${ports.ollama}`,
      WEBHOOK_SERVICE_URL: urls.webhook,
      STORAGE_BACKEND: "local",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout?.on("data", (chunk) => process.stdout.write(`[worker] ${chunk}`));
  worker.stderr?.on("data", (chunk) => process.stderr.write(`[worker] ${chunk}`));

  // Wait for the poll loop to announce itself, so no test can upload
  // into a queue with nothing draining it.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start within 30s")), 30_000);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("polling every")) {
        clearTimeout(timer);
        worker?.stdout?.off("data", onData);
        resolve();
      }
    };
    worker?.stdout?.on("data", onData);
    worker?.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited during startup with code ${code}`));
    });
  });
}

export async function stopWorker(): Promise<void> {
  if (!worker || worker.exitCode !== null) return;

  // SIGTERM asks it to finish the document it's on rather than orphaning
  // it -- the same shutdown the worker is written for.
  worker.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      worker?.kill("SIGKILL");
      resolve();
    }, 10_000);
    worker?.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}
