import { startWorker } from "./worker-process";

export default async function globalSetup(): Promise<void> {
  await startWorker();
}
