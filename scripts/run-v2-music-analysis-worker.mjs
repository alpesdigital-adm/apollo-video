import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as importedFactory from "../src/v2/infrastructure/repository-factory.ts";
import * as importedLifecycle from "../src/v2/application/worker-lifecycle.ts";
import * as importedOpsState from "../src/v2/infrastructure/ops-state/file-admission-gate.ts";
import * as importedPrismaClient from "../src/v2/infrastructure/prisma-postgres/client.ts";

const factory = importedFactory.createMusicAnalysisRuntime
  ? importedFactory
  : importedFactory.default;
const lifecycle = importedLifecycle.createWorkerShutdown
  ? importedLifecycle
  : importedLifecycle.default;
const { createWorkerShutdown, runWithCleanup } = lifecycle;
const opsState = importedOpsState.createFileAdmissionGate
  ? importedOpsState
  : importedOpsState.default;
const { createFileAdmissionGate } = opsState;
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default;
const { disconnectV2PostgresClient } = prismaClient;

process.env.APOLLO_PROCESS_ROLE ??= "music-analysis-worker";

const once = process.argv.includes("--once"),
  pollMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1000);
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000)
  throw new Error(
    "APOLLO_V2_WORKER_POLL_MS must be an integer between 100ms and 60000ms",
  );
const workerId = `music-analysis:${hostname().slice(0, 32)}:${process.pid}:${randomUUID()}`;
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: "music-analysis", ...event })),
});
const runtime = factory.createMusicAnalysisRuntime();

function waitForPoll() {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      shutdown.signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, pollMs);
    shutdown.signal.addEventListener("abort", finish, { once: true });
  });
}

await runWithCleanup(
  async () => {
    if (once) {
      const admission = await shutdown.admits();
      const outcome = admission.admits
        ? await runtime.runNext(workerId, shutdown.signal)
        : null;
      process.stdout.write(
        `APOLLO_MUSIC_ANALYSIS_OUTCOME=${JSON.stringify(outcome)}\n`,
      );
      process.exitCode = outcome?.status === "failed" ? 1 : 0;
      return;
    }
    while (!shutdown.stopping()) {
      try {
        const admission = await shutdown.admits();
        if (!admission.admits) {
          if (!shutdown.stopping()) await waitForPoll();
          continue;
        }
        const outcome = await runtime.runNext(workerId, shutdown.signal);
        if (outcome)
          console.info(
            JSON.stringify({
              runId: outcome.id,
              status: outcome.status,
              analysisId: outcome.analysisId,
            }),
          );
        else if (!shutdown.stopping()) await waitForPoll();
      } catch (error) {
        if (!shutdown.stopping()) {
          console.error(
            error instanceof Error
              ? error.message
              : "Music analysis worker iteration failed",
          );
          // Wave 23: this branch had no wait at all, so a claim that kept throwing
          // spun the loop as fast as PostgreSQL would answer.
          await waitForPoll();
        }
      }
    }
  },
  [
    { name: "shutdown-listeners", run: () => shutdown.dispose() },
    { name: "runtime-close", run: () => runtime.close() },
    { name: "prisma-disconnect", run: () => disconnectV2PostgresClient() },
  ],
  (event) =>
    console.error(
      JSON.stringify({ worker: "music-analysis", ...event, error: String(event.error) }),
    ),
);
