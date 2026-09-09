import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as importedFactory from "../src/v2/infrastructure/repository-factory.ts";
const factory = importedFactory.createMusicAnalysisRuntime
  ? importedFactory
  : importedFactory.default;
const once = process.argv.includes("--once"),
  pollMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1000);
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000)
  throw new Error(
    "APOLLO_V2_WORKER_POLL_MS must be an integer between 100ms and 60000ms",
  );
const controller = new AbortController(),
  workerId = `music-analysis:${hostname().slice(0, 32)}:${process.pid}:${randomUUID()}`;
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const runtime = factory.createMusicAnalysisRuntime();
try {
  if (once) {
    const outcome = await runtime.runNext(workerId, controller.signal);
    process.stdout.write(
      `APOLLO_MUSIC_ANALYSIS_OUTCOME=${JSON.stringify(outcome)}\n`,
    );
    process.exitCode = outcome?.status === "failed" ? 1 : 0;
  } else
    while (!controller.signal.aborted) {
      try {
        const outcome = await runtime.runNext(workerId, controller.signal);
        if (outcome)
          console.info(
            JSON.stringify({
              runId: outcome.id,
              status: outcome.status,
              analysisId: outcome.analysisId,
            }),
          );
        else
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
      } catch (error) {
        if (!controller.signal.aborted)
          console.error(
            error instanceof Error
              ? error.message
              : "Music analysis worker iteration failed",
          );
      }
    }
} finally {
  await runtime.close();
}
