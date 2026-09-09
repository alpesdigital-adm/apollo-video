import { calculateCanonicalHash } from "../domain/canonical-hash.ts";
import type { DirectedEditPlan } from "../domain/director-run.ts";
import { assertDomain } from "../domain/errors.ts";
import type { LocalizationMediaEvidence, LocalizationMediaRun } from "../domain/localization-media-run.ts";
import type { CanonicalScriptVersion, LocalizationVariant, MeasuredWord } from "../domain/localization.ts";
import { compileLocalizationMedia } from "./compile-localization-media.ts";
import type { LocalizationMediaProcessor } from "./localization-media-worker.ts";
import type { RenderablePlanSnapshotRepository } from "./ports/renderable-plan-snapshot-repository.ts";
import { renderablePlanSnapshotOf } from "./renderable-edit-plan.ts";
import type { PublicOperationRepository } from "./ports/public-operation-repository.ts";
import { requireScope, type AuthenticatedExternalActor } from "./authenticate-api-client.ts";

export interface LocalizationMediaProcessingContext {
  variant: Readonly<LocalizationVariant>;
  canonical: Readonly<CanonicalScriptVersion>;
  basePlan: Readonly<DirectedEditPlan>;
  audio: Readonly<{
    artifactId: string;
    sha256: string;
    rightsSnapshotId: string;
    durationMs: number;
    words: readonly MeasuredWord[];
    alignmentArtifactId: string;
    alignmentSha256: string;
  }>;
  blockWordRanges: readonly Readonly<{ blockId: string; startWord: number; endWord: number }>[];
}

export interface LocalizationMediaContextLoader {
  load(run: Readonly<LocalizationMediaRun>): Promise<Readonly<LocalizationMediaProcessingContext>>;
}

export interface LocalizationProxyRuntime {
  render(input: {
    run: Readonly<LocalizationMediaRun>;
    format: string;
    snapshotId: string;
    plan: Readonly<DirectedEditPlan>;
    planHash: string;
    sourceHash: string;
    signal: AbortSignal;
  }): Promise<Readonly<{ operationId: string; artifactId: string }>>;
}

export function createLocalizationSnapshotProxyRuntime(deps: {
  revalidateActor: (run: Readonly<LocalizationMediaRun>) => Promise<Readonly<AuthenticatedExternalActor>>;
  enqueue: ReturnType<typeof import("./enqueue-project-proxy-render.ts").enqueueRenderableSnapshotProxyRenderService>;
  operations: Pick<PublicOperationRepository, "findById">;
  runProxyWorker: (leaseOwner: string, target: Readonly<{ workspaceId: string; operationId: string; signal: AbortSignal }>) => Promise<unknown>;
}): LocalizationProxyRuntime {
  return Object.freeze({
    async render(input: Parameters<LocalizationProxyRuntime["render"]>[0]) {
      const actor = await deps.revalidateActor(input.run);
      requireScope(actor, 'localization:run');
      const queued = await deps.enqueue({
        workspaceId: input.run.workspaceId, projectId: input.run.projectId,
        planId: input.snapshotId, planHash: input.planHash, origin: "localization",
        sourceId: input.run.id, sourceHash: input.sourceHash, variantId: input.run.variantId,
        format: input.format, actor,
        idempotencyKey: `localization-proxy-${input.run.id}-${input.format}`.slice(0, 128),
      });
      while (!input.signal.aborted) {
        const record = await deps.operations.findById(input.run.workspaceId, queued.operation.id);
        if (!record) throw new Error("Localization proxy operation disappeared");
        if (record.operation.status === "succeeded") return Object.freeze({ operationId: record.operation.id, artifactId: record.operation.target.id });
        if (["failed", "canceled"].includes(record.operation.status)) {
          const detail = record.operation.error ? `: ${record.operation.error.code} ${record.operation.error.message}` : '';
          throw new Error(`Localization proxy operation ${record.operation.status}${detail}`);
        }
        const worked = await deps.runProxyWorker(`localization-${input.run.id}-${input.format}`.slice(0, 128), {
          workspaceId: input.run.workspaceId, operationId: queued.operation.id, signal: input.signal,
        });
        if (!worked && !input.signal.aborted) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { input.signal.removeEventListener('abort', abort); resolve(); }, 25);
          const abort = () => { clearTimeout(timer); reject(input.signal.reason ?? new Error('Localization proxy rendering aborted')); };
          input.signal.addEventListener('abort', abort, { once: true });
        });
      }
      throw input.signal.reason ?? new Error("Localization proxy rendering aborted");
    },
  });
}

/**
 * The vertical composition for subtitles-only localization. It does not report
 * evidence until the immutable plan is stored and the renderer returns a real,
 * persisted artifact identity.
 */
export function createLocalizationMediaProcessor(deps: {
  contexts: LocalizationMediaContextLoader;
  snapshots: RenderablePlanSnapshotRepository;
  proxy: LocalizationProxyRuntime;
  clock?: () => Date;
  createId?: (kind: "plan") => string;
}): LocalizationMediaProcessor {
  const clock = deps.clock ?? (() => new Date());
  return Object.freeze({
    async process(run: Readonly<LocalizationMediaRun>, signal: AbortSignal) {
      const context = await deps.contexts.load(run);
      assertDomain(
        context.variant.id === run.variantId &&
          context.variant.revision === run.variantRevision &&
          context.variant.variantHash === run.variantHash &&
          context.canonical.contentHash === run.canonicalContentHash &&
          context.variant.mode === "subtitles-only",
        "VERSION_CONFLICT",
        "Localization media authority changed before processing",
      );
      const renderedPlans: LocalizationMediaEvidence["renderablePlans"][number][] = [];
      const lineageHashes: string[] = [];
      let blockDurations: LocalizationMediaEvidence["blockDurations"] = [];
      let durationDeviation!: LocalizationMediaEvidence["durationDeviation"];
      for (const format of context.variant.formats) {
        if (signal.aborted) throw signal.reason ?? new Error("Localization media processing aborted");
        const compiled = compileLocalizationMedia({
          ...context,
          format,
          planId: deps.createId?.("plan") ?? `plan-localization-${calculateCanonicalHash({ runId: run.id, format, variantHash: run.variantHash }).slice(0, 32)}`,
          createdAt: clock().toISOString(),
        });
        const persisted = await deps.snapshots.persist({
          snapshot: renderablePlanSnapshotOf({
            workspaceId: run.workspaceId,
            projectId: run.projectId,
            origin: "localization",
            sourceId: run.id,
            sourceHash: compiled.lineageHash,
            sourceVersion: run.revision,
            plan: compiled.plan,
          }),
          createdAt: clock().toISOString(),
        });
        const proxy = await deps.proxy.render({
          run,
          format,
          snapshotId: persisted.snapshot.planId,
          plan: persisted.snapshot.plan,
          planHash: persisted.snapshot.planHash,
          sourceHash: persisted.snapshot.sourceHash,
          signal,
        });
        assertDomain(
          proxy.operationId.trim().length > 0 && proxy.artifactId.trim().length > 0,
          "PERSISTENCE_CONFLICT",
          "Localization renderer did not persist an artifact",
        );
        renderedPlans.push(Object.freeze({
          format,
          snapshotId: persisted.snapshot.planId,
          planHash: persisted.snapshot.planHash,
          proxyOperationId: proxy.operationId,
          proxyArtifactId: proxy.artifactId,
        }));
        lineageHashes.push(compiled.lineageHash);
        blockDurations = compiled.blockDurations;
        durationDeviation = compiled.durationDeviation;
      }
      return Object.freeze({
        audioArtifactId: context.audio.artifactId,
        audioSha256: context.audio.sha256,
        durationMs: context.audio.durationMs,
        alignmentArtifactId: context.audio.alignmentArtifactId,
        alignmentSha256: context.audio.alignmentSha256,
        words: context.audio.words,
        blockDurations,
        durationDeviation,
        renderablePlans: Object.freeze(renderedPlans),
        lineageHash: calculateCanonicalHash({ runId: run.id, lineageHashes }),
      });
    },
  });
}
