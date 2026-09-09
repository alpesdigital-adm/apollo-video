import { createHash, randomUUID } from "node:crypto";
import { assertDomain } from "../domain/errors.ts";
import {
  failLocalizationMediaRun,
  recordLocalizationMediaEvidence,
  type LocalizationMediaEvidence,
  type LocalizationMediaRun,
} from "../domain/localization-media-run.ts";
import type { LocalizationMediaRunRepository } from "./ports/localization-media-run-repository.ts";

export interface LocalizationMediaProcessor {
  process(
    run: Readonly<LocalizationMediaRun>,
    signal: AbortSignal,
  ): Promise<Readonly<LocalizationMediaEvidence>>;
}

export function runNextLocalizationMediaService(deps: {
  runs: LocalizationMediaRunRepository;
  processor: LocalizationMediaProcessor;
  workerId: string;
  clock?: () => Date;
  createLeaseToken?: () => string;
  leaseMs?: number;
  executionTimeoutMs?: number;
  heartbeatMs?: number;
}) {
  return async (externalSignal?: AbortSignal) => {
    const clock = deps.clock ?? (() => new Date()),
      leaseMs = deps.leaseMs ?? 10 * 60_000,
      timeoutMs = deps.executionTimeoutMs ?? 8 * 60_000,
      heartbeatMs = deps.heartbeatMs ?? 20_000;
    assertDomain(
      Number.isSafeInteger(leaseMs) &&
        leaseMs >= 60_000 &&
        leaseMs <= 15 * 60_000 &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs >= 10_000 &&
        timeoutMs < leaseMs &&
        Number.isSafeInteger(heartbeatMs) &&
        heartbeatMs >= 5_000 &&
        heartbeatMs < leaseMs / 2,
      "INVALID_ARGUMENT",
      "Localization media worker budget is invalid",
    );
    if (externalSignal?.aborted) throw externalSignal.reason ?? new Error("Localization media worker aborted");
    const started = clock(),
      leaseTokenHash = createHash("sha256")
        .update((deps.createLeaseToken ?? randomUUID)())
        .digest("hex");
    const run = await deps.runs.claim({
      workerId: deps.workerId,
      leaseTokenHash,
      now: started.toISOString(),
      leaseExpiresAt: new Date(started.getTime() + leaseMs).toISOString(),
    });
    if (!run) return null;
    const controller = new AbortController();
    const propagateAbort = () => controller.abort(externalSignal?.reason ?? new Error("Localization media worker aborted"));
    externalSignal?.addEventListener("abort", propagateAbort, { once: true });
    let leaseLost = false;
    let heartbeatInFlight: Promise<void> | null = null;
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error("Localization media execution budget expired"),
        ),
      timeoutMs,
    );
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      const now = clock();
      heartbeatInFlight = (async () => { try {
        const held = await deps.runs.heartbeat({
          runId: run.id,
          workspaceId: run.workspaceId,
          runHash: run.runHash,
          leaseTokenHash,
          now: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        });
        if (!held) {
          leaseLost = true;
          controller.abort(new Error("Localization media lease was fenced"));
        }
      } catch {
        leaseLost = true;
        controller.abort(new Error("Localization media heartbeat failed"));
      } finally { heartbeatInFlight = null; } })();
    }, heartbeatMs);
    try {
      const evidence = await deps.processor.process(run, controller.signal);
      assertDomain(
        !leaseLost && !controller.signal.aborted,
        "VERSION_CONFLICT",
        "Localization media lease was lost before settlement",
      );
      const settled = recordLocalizationMediaEvidence(
        run,
        evidence,
        clock().toISOString(),
      );
      return await deps.runs.settle({
        previousRunHash: run.runHash,
        run: settled,
        leaseTokenHash,
        settledAt: settled.updatedAt,
      });
    } catch (error) {
      if (leaseLost) throw error;
      const at = clock().toISOString(),
        blocked = controller.signal.aborted;
      const failed = failLocalizationMediaRun(
        run,
        blocked ? "blocked" : "failed",
        {
          code: blocked ? "EXECUTION_TIMEOUT" : "LOCALIZATION_MEDIA_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Localization media processing failed",
          retryable: !blocked,
        },
        at,
      );
      await deps.runs.settle({
        previousRunHash: run.runHash,
        run: failed,
        leaseTokenHash,
        settledAt: at,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      await heartbeatInFlight;
      externalSignal?.removeEventListener("abort", propagateAbort);
      controller.abort();
    }
  };
}
