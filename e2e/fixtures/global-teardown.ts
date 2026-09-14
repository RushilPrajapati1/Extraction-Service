import { stopWorker } from "./worker-process";

export default async function globalTeardown(): Promise<void> {
  await stopWorker();
}
