import {
  Prisma,
  type PrismaClient,
} from "../../../../generated/prisma-v2/index.js";
import type { LocalizationMediaRunRepository } from "../../application/ports/localization-media-run-repository.ts";
import {
  calculateCanonicalHash,
  stableSerialize,
} from "../../domain/canonical-hash.ts";
import { DomainError } from "../../domain/errors.ts";
import {
  beginLocalizationMediaRun,
  LOCALIZATION_MEDIA_RUN_SCHEMA_VERSION,
  type LocalizationMediaRun,
} from "../../domain/localization-media-run.ts";
import {
  assertLocalizationVariantIntegrity,
  transitionLocalizationVariant,
  type LocalizationVariant,
} from "../../domain/localization.ts";
import { getV2PostgresClient } from "../prisma-postgres/client.ts";
import { batchActorAuditData, hydrateBatchActorAudit } from "./batch-actor-audit.ts";
import { childRowId } from "./child-row-id.ts";
import { evaluateAssetUse } from "../../domain/asset-rights.ts";
import { hydrateAssetRights } from "./asset-rights-repository.ts";
import { calculateProxyReviewHash, type ProxyQualityIssue } from "../../application/render-workflow.ts";
import { calculateRenderablePlanHash } from "../../application/renderable-edit-plan.ts";
import type { DirectedEditPlan } from "../../domain/director-run.ts";

function hydrate(row: {
  runJson: string;
  runHash: string;
}): Readonly<LocalizationMediaRun> {
  const run = JSON.parse(row.runJson) as LocalizationMediaRun;
  if (
    run.schemaVersion !== LOCALIZATION_MEDIA_RUN_SCHEMA_VERSION ||
    run.runHash !== row.runHash ||
    calculateCanonicalHash({ ...run, runHash: undefined }) !== run.runHash
  )
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Stored localization media run hash is inconsistent",
    );
  return Object.freeze(run);
}
const revisionData = (run: Readonly<LocalizationMediaRun>, at: string) => ({
  id: childRowId([run.workspaceId, run.id, String(run.revision)], 160),
  workspaceId: run.workspaceId,
  runId: run.id,
  revision: run.revision,
  status: run.status,
  runJson: stableSerialize(run),
  runHash: run.runHash,
  createdAt: new Date(at),
});

export class PrismaLocalizationMediaRunRepository implements LocalizationMediaRunRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient = getV2PostgresClient()) {
    this.prisma = prisma;
  }
  async readAuthenticationAudit(input: { workspaceId: string; runId: string }) {
    const row = await this.prisma.v2LocalizationMediaRun.findFirst({ where: { id: input.runId, workspaceId: input.workspaceId } });
    if (!row) throw new DomainError("LOCALIZATION_VARIANT_NOT_FOUND", "Localization media run was not found");
    return hydrateBatchActorAudit(row, row.requestedByClientId);
  }
  async findReplay(
    input: Parameters<LocalizationMediaRunRepository["findReplay"]>[0],
  ) {
    const row = await this.prisma.v2LocalizationMediaRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        requestedByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (!row) return null;
    if (
      row.actorContextHash !== input.actorContextHash ||
      row.requestFingerprint !== input.requestFingerprint
    )
      throw new DomainError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "Localization media key belongs to another request",
      );
    return hydrate(row);
  }
  async create(input: Parameters<LocalizationMediaRunRepository["create"]>[0]) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const replay = await tx.v2LocalizationMediaRun.findFirst({
            where: {
              workspaceId: input.run.workspaceId,
              requestedByClientId: input.run.requestedByClientId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          if (replay)
            return Object.freeze({ run: hydrate(replay), replayed: true });
          const [variant, artifact, rights] = await Promise.all([
            tx.v2LocalizationVariantHead.findFirst({
              where: {
                id: input.run.variantId,
                workspaceId: input.run.workspaceId,
                projectId: input.run.projectId,
                currentRevision: input.run.variantRevision,
                currentVariantHash: input.run.variantHash,
                status: "audio",
              },
            }),
            tx.v2MediaArtifact.findFirst({
              where: {
                id: input.run.source.artifactId,
                workspaceId: input.run.workspaceId,
                sha256: input.run.source.artifactSha256,
                status: "available",
              },
            }),
            tx.v2AssetRightsSnapshot.findFirst({
              where: {
                id: input.run.source.rightsSnapshotId,
                workspaceId: input.run.workspaceId,
                artifactId: input.run.source.artifactId,
                status: "approved",
              },
            }),
          ]);
          if (!variant || !artifact || !rights)
            throw new DomainError(
              "VERSION_CONFLICT",
              "Localization media source authority changed",
            );
          const row = await tx.v2LocalizationMediaRun.create({
            data: {
              id: input.run.id,
              workspaceId: input.run.workspaceId,
              projectId: input.run.projectId,
              variantId: input.run.variantId,
              variantRevision: input.run.variantRevision,
              variantHash: input.run.variantHash,
              canonicalContentHash: input.run.canonicalContentHash,
              sourceArtifactId: input.run.source.artifactId,
              sourceSha256: input.run.source.artifactSha256,
              sourceRightsSnapshotId: input.run.source.rightsSnapshotId,
              status: input.run.status,
              revision: input.run.revision,
              attempt: input.run.attempt,
              runJson: stableSerialize(input.run),
              runHash: input.run.runHash,
              requestFingerprint: input.requestFingerprint,
              idempotencyKey: input.idempotencyKey,
              requestedByClientId: input.run.requestedByClientId,
              ...batchActorAuditData(input.authenticationAudit, input.run.workspaceId, input.run.requestedByClientId),
              createdAt: new Date(input.run.createdAt),
              updatedAt: new Date(input.run.updatedAt),
            },
          });
          await tx.v2LocalizationMediaRunRevision.create({
            data: revisionData(input.run, input.run.createdAt),
          });
          return Object.freeze({ run: hydrate(row), replayed: false });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "P2002"
      )
        throw new DomainError(
          "VERSION_CONFLICT",
          "An active media intent already exists for this localization revision",
        );
      throw error;
    }
  }
  async read(input: Parameters<LocalizationMediaRunRepository["read"]>[0]) {
    const row = await this.prisma.v2LocalizationMediaRun.findFirst({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
    });
    return row ? hydrate(row) : null;
  }

  async findApprovalReplay(input: Parameters<LocalizationMediaRunRepository["findApprovalReplay"]>[0]) {
    const [row, action] = await Promise.all([
      this.prisma.v2LocalizationMediaRun.findFirst({ where: { id: input.runId, workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId, status: "approved" } }),
      this.prisma.v2LocalizationVariantAction.findFirst({ where: { workspaceId: input.workspaceId, action: "review", idempotencyKey: input.idempotencyKey, actorClientId: input.actorClientId } }),
    ]);
    if (!row && !action) return null;
    if (!row || !action || action.variantId !== row.variantId || action.resultVariantHash === null || action.requestFingerprint !== input.requestFingerprint || hydrateBatchActorAudit(action, action.actorClientId).contextHash !== input.actorContextHash)
      throw new DomainError("IDEMPOTENCY_PAYLOAD_MISMATCH", "Localization media approval key belongs to another request or actor context");
    return hydrate(row);
  }
  async claim(input: Parameters<LocalizationMediaRunRepository["claim"]>[0]) {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.v2LocalizationMediaRun.findFirst({
          where: { status: "requested" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (!row) return null;
        const current = hydrate(row),
          next = beginLocalizationMediaRun(current, input.now);
        const authority = await tx.v2LocalizationVariantHead.findFirst({
          where: {
            id: current.variantId,
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            currentRevision: current.variantRevision,
            currentVariantHash: current.variantHash,
            status: "audio",
          },
        });
        if (!authority)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Localization variant changed before media claim",
          );
        const changed = await tx.v2LocalizationMediaRun.updateMany({
          where: { id: row.id, status: "requested", runHash: row.runHash },
          data: {
            status: next.status,
            revision: next.revision,
            attempt: next.attempt,
            runJson: stableSerialize(next),
            runHash: next.runHash,
            leaseOwner: input.workerId,
            leaseTokenHash: input.leaseTokenHash,
            leaseExpiresAt: new Date(input.leaseExpiresAt),
            heartbeatAt: new Date(input.now),
            updatedAt: new Date(input.now),
          },
        });
        if (changed.count !== 1) return null;
        await tx.v2LocalizationMediaRunRevision.create({
          data: revisionData(next, input.now),
        });
        return next;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  async heartbeat(
    input: Parameters<LocalizationMediaRunRepository["heartbeat"]>[0],
  ) {
    const result = await this.prisma.v2LocalizationMediaRun.updateMany({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        status: "processing",
        runHash: input.runHash,
        leaseTokenHash: input.leaseTokenHash,
        leaseExpiresAt: { gt: new Date(input.now) },
      },
      data: {
        heartbeatAt: new Date(input.now),
        leaseExpiresAt: new Date(input.leaseExpiresAt),
      },
    });
    return result.count === 1;
  }
  async settle(input: Parameters<LocalizationMediaRunRepository["settle"]>[0]) {
    return this.prisma.$transaction(
      async (tx) => {
        const authority = await tx.v2LocalizationVariantHead.findFirst({
          where: {
            id: input.run.variantId,
            workspaceId: input.run.workspaceId,
            currentRevision: input.run.variantRevision,
            currentVariantHash: input.run.variantHash,
            status: "audio",
          },
        });
        if (!authority)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Localization variant changed during media processing",
          );
        const changed = await tx.v2LocalizationMediaRun.updateMany({
          where: {
            id: input.run.id,
            workspaceId: input.run.workspaceId,
            status: "processing",
            runHash: input.previousRunHash,
            leaseTokenHash: input.leaseTokenHash,
            leaseExpiresAt: { gt: new Date(input.settledAt) },
          },
          data: {
            status: input.run.status,
            revision: input.run.revision,
            runJson: stableSerialize(input.run),
            runHash: input.run.runHash,
            leaseOwner: null,
            leaseTokenHash: null,
            leaseExpiresAt: null,
            heartbeatAt: new Date(input.settledAt),
            updatedAt: new Date(input.settledAt),
          },
        });
        if (changed.count !== 1)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Localization media lease expired or was fenced",
          );
        await tx.v2LocalizationMediaRunRevision.create({
          data: revisionData(input.run, input.settledAt),
        });
        return input.run;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  async approve(
    input: Parameters<LocalizationMediaRunRepository["approve"]>[0],
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.v2LocalizationMediaRun.findFirst({
          where: { id: input.run.id, workspaceId: input.run.workspaceId },
        });
        if (!row)
          throw new DomainError(
            "LOCALIZATION_VARIANT_NOT_FOUND",
            "Localization media run was not found",
          );
        if (row.status === "approved") {
          const replay = hydrate(row);
          const action = await tx.v2LocalizationVariantAction.findFirst({ where: { workspaceId: input.run.workspaceId, variantId: input.run.variantId, action: "review", idempotencyKey: input.idempotencyKey, actorClientId: input.run.approval?.clientId } });
          if (!action || action.requestFingerprint !== input.requestFingerprint || hydrateBatchActorAudit(action, action.actorClientId).contextHash !== input.authenticationAudit.contextHash)
            throw new DomainError(
              "IDEMPOTENCY_PAYLOAD_MISMATCH",
              "Approval key belongs to another request or actor context",
            );
          return replay;
        }
        const authority = await tx.v2LocalizationVariantHead.findFirst({
          where: {
            id: input.run.variantId,
            workspaceId: input.run.workspaceId,
            currentRevision: input.run.variantRevision,
            currentVariantHash: input.run.variantHash,
            status: "audio",
          },
        });
        if (!authority)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Localization changed before approval",
          );
        const variantRow =
          await tx.v2LocalizationVariantRevision.findFirstOrThrow({
            where: {
              variantId: input.run.variantId,
              workspaceId: input.run.workspaceId,
              revision: input.run.variantRevision,
              variantHash: input.run.variantHash,
            },
          });
        const currentVariant = assertLocalizationVariantIntegrity(
          JSON.parse(variantRow.variantJson) as LocalizationVariant,
        );
        const evidence = input.run.evidence!;
        const expectedFormats = [...new Set(currentVariant.formats)].sort();
        const evidenceFormats = [...new Set(evidence.renderablePlans.map((item) => item.format))].sort();
        if (!expectedFormats.length || evidenceFormats.length !== evidence.renderablePlans.length || expectedFormats.join("\u0000") !== evidenceFormats.join("\u0000"))
          throw new DomainError("PRECONDITION_REQUIRED", "Localization approval requires exactly one rendered proof for every variant format");
        const source = await tx.v2MediaArtifact.findFirst({ where: { id: input.run.source.artifactId, workspaceId: input.run.workspaceId, sha256: input.run.source.artifactSha256, currentRightsSnapshotId: input.run.source.rightsSnapshotId, status: "available" }, include: { currentRightsSnapshot: true } });
        const sourceDecision = source?.currentRightsSnapshot ? evaluateAssetUse(hydrateAssetRights(source.currentRightsSnapshot), { workspaceId: input.run.workspaceId, use: "localization", locale: currentVariant.targetLocale, ...(currentVariant.market ? { market: currentVariant.market } : {}) }, new Date(input.run.updatedAt)) : null;
        if (!sourceDecision || sourceDecision.outcome !== "allow") throw new DomainError("ASSET_RIGHTS_BLOCKED", "Localization media source rights changed before approval");
        const semanticIds = { captionIds: [] as string[], clipIds: [] as string[], brollIds: [] as string[], eventIds: [] as string[] };
        const proxyProofs = await Promise.all(evidence.renderablePlans.map(async (item) => {
          const operation = await tx.v2ProjectProxyRenderOperation.findFirst({
            where: {
              operationId: item.proxyOperationId,
              workspaceId: input.run.workspaceId,
              projectId: input.run.projectId,
              outputArtifactId: item.proxyArtifactId,
              renderablePlanId: item.snapshotId,
              renderablePlanHash: item.planHash,
              renderableOrigin: "localization",
              renderableSourceId: input.run.id,
              renderableVariantId: input.run.variantId,
              renderableFormat: item.format,
              operation: { status: "succeeded", phase: "completed" },
            },
            include: { review: true, renderableSnapshot: true },
          });
          if (!operation?.review || !operation.renderableSnapshot) return null;
          const review = operation.review, technicalIssues = JSON.parse(review.technicalIssuesJson) as ProxyQualityIssue[], criticIssues = JSON.parse(review.criticIssuesJson) as ProxyQualityIssue[];
          const spec = JSON.parse(review.specJson), formatQuality = review.formatQualityJson === null ? undefined : JSON.parse(review.formatQualityJson);
          const reviewBody = { schemaVersion: "proxy-review/v1" as const, projectVersionId: review.projectVersionId, proxyArtifactId: review.proxyArtifactId, proxyManifestId: review.proxyManifestId, inputHash: review.inputHash, outputSpecId: review.outputSpecId, rangeCacheKey: review.rangeCacheKey, spec, status: review.status, technicalIssues, criticIssues, ...(formatQuality ? { formatQuality } : {}), warningsAcknowledged: review.warningsAcknowledged, finalAllowed: review.finalAllowed, uploadReceivedAt: review.uploadReceivedAt.toISOString(), renderCompletedAt: review.renderCompletedAt.toISOString(), timeToFirstProxyMs: Number(review.timeToFirstProxyMs) };
          if (review.projectVersionId !== operation.renderableSnapshot.projectVersionId || review.proxyArtifactId !== operation.outputArtifactId || review.proxyManifestId !== operation.outputManifestId || review.status !== "ready-for-final" || !review.finalAllowed || [...technicalIssues, ...criticIssues].some((issue) => issue.severity === "hard") || calculateProxyReviewHash(reviewBody as Parameters<typeof calculateProxyReviewHash>[0]) !== review.reviewHash) return null;
          const plan = JSON.parse(operation.renderableSnapshot.planJson) as DirectedEditPlan;
          if (calculateRenderablePlanHash(plan) !== operation.renderableSnapshot.planHash || plan.projectVersionId !== review.projectVersionId || (plan.formatVariantRefs as readonly string[]).length !== 1 || (plan.formatVariantRefs as readonly string[])[0] !== item.format || plan.subtitleTracks.length === 0 || plan.videoTracks.every((track) => track.clips.length === 0)) return null;
          semanticIds.captionIds.push(...plan.subtitleTracks.flatMap((track) => track.cues.map((cue) => cue.id)));
          semanticIds.clipIds.push(...plan.videoTracks.filter((track) => track.kind === "base-video").flatMap((track) => track.clips.map((clip) => clip.id)));
          semanticIds.brollIds.push(...plan.videoTracks.filter((track) => track.kind !== "base-video").flatMap((track) => track.clips.map((clip) => clip.id)));
          semanticIds.eventIds.push(...plan.transitions.map((event) => event.id));
          return tx.v2MediaArtifact.findFirst({
            where: { id: operation.outputArtifactId, workspaceId: input.run.workspaceId, status: "available" },
            select: { manifests: { where: { id: operation.outputManifestId }, select: { id: true }, take: 1 } },
          });
        }));
        if (proxyProofs.some((proof) => !proof || proof.manifests.length !== 1)) {
          throw new DomainError(
            "PRECONDITION_REQUIRED",
            "Localization approval requires completed snapshot-bound proxy renders",
          );
        }
        if (semanticIds.captionIds.length === 0 || semanticIds.clipIds.length === 0) throw new DomainError("PRECONDITION_REQUIRED", "Localization approval requires persisted caption and clip identities");
        const mediaPatch = {
          updatedAt: input.run.updatedAt,
          localizedAudioAssetId: evidence.audioArtifactId,
          alignment: evidence.words,
          durationDeviation: { totalRatio: evidence.durationDeviation.totalRatio, byBlock: evidence.durationDeviation.byBlock },
          dependentPlan: {
            captionIds: [...new Set(semanticIds.captionIds)].sort(),
            clipIds: [...new Set(semanticIds.clipIds)].sort(),
            brollIds: [...new Set(semanticIds.brollIds)].sort(),
            eventIds: [...new Set(semanticIds.eventIds)].sort(),
          },
        };
        const visualVariant = transitionLocalizationVariant(currentVariant, "visual", { ...mediaPatch, stage: "media-rendered" });
        const reviewVariant = transitionLocalizationVariant(visualVariant, "review", { ...mediaPatch, stage: "media-proxy-reviewed" });
        const approvedVariant = transitionLocalizationVariant(
          reviewVariant,
          "approved",
          {
            ...mediaPatch,
            stage: "media-approved",
            approval: {
              clientId: input.run.approval!.clientId,
              at: input.run.approval!.at,
              revision: reviewVariant.revision + 1,
            },
          },
        );
        const variantChanged = await tx.v2LocalizationVariantHead.updateMany({
          where: {
            id: currentVariant.id,
            workspaceId: currentVariant.workspaceId,
            currentRevision: currentVariant.revision,
            currentVariantHash: currentVariant.variantHash,
            status: "audio",
          },
          data: {
            currentRevision: approvedVariant.revision,
            currentVariantHash: approvedVariant.variantHash,
            status: approvedVariant.status,
            updatedAt: new Date(input.run.updatedAt),
          },
        });
        if (variantChanged.count !== 1)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Localization variant approval lost its compare-and-swap fence",
          );
        await tx.v2LocalizationVariantRevision.createMany({
          data: [visualVariant, reviewVariant, approvedVariant].map((variant) => ({
            id: childRowId(
              [
                variant.workspaceId,
                variant.id,
                String(variant.revision),
              ],
              160,
            ),
            workspaceId: variant.workspaceId,
            variantId: variant.id,
            revision: variant.revision,
            canonicalScriptVersionId: variant.canonicalScriptVersionId,
            localizedAudioAssetId: variant.localizedAudioAssetId,
            status: variant.status,
            stage: variant.stage,
            variantJson: stableSerialize(variant),
            variantHash: variant.variantHash,
            createdAt: new Date(input.run.updatedAt),
          })),
        });
        const auditData = batchActorAuditData(input.authenticationAudit, approvedVariant.workspaceId, input.run.approval!.clientId);
        const actionRows = [
          { phase: "media-rendered", action: "advance", previous: currentVariant, next: visualVariant, idempotencyKey: childRowId([input.run.id, input.run.runHash, "media-rendered"], 128) },
          { phase: "media-proxy-reviewed", action: "advance", previous: visualVariant, next: reviewVariant, idempotencyKey: childRowId([input.run.id, input.run.runHash, "media-proxy-reviewed"], 128) },
          { phase: "media-approved", action: "review", previous: reviewVariant, next: approvedVariant, idempotencyKey: input.idempotencyKey },
        ];
        await tx.v2LocalizationVariantAction.createMany({ data: actionRows.map((action) => ({
          id: childRowId([approvedVariant.workspaceId, approvedVariant.id, action.phase, action.idempotencyKey], 160),
          workspaceId: approvedVariant.workspaceId,
          variantId: approvedVariant.id,
          action: action.action,
          expectedRevision: action.previous.revision,
          resultRevision: action.next.revision,
          resultVariantHash: action.next.variantHash,
          requestFingerprint: action.phase === "media-approved" ? input.requestFingerprint : calculateCanonicalHash({ mediaRunId: input.run.id, mediaRunHash: input.run.runHash, phase: action.phase, previousVariantHash: action.previous.variantHash, resultVariantHash: action.next.variantHash }),
          idempotencyKey: action.idempotencyKey,
          actorClientId: input.run.approval!.clientId,
          ...auditData,
          createdAt: new Date(input.run.updatedAt),
        })) });
        const changed = await tx.v2LocalizationMediaRun.updateMany({
          where: {
            id: input.run.id,
            status: "awaiting-human-approval",
            runHash: input.previousRunHash,
          },
          data: {
            status: input.run.status,
            revision: input.run.revision,
            runJson: stableSerialize(input.run),
            runHash: input.run.runHash,
            updatedAt: new Date(input.run.updatedAt),
          },
        });
        if (changed.count !== 1)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Localization media changed before approval",
          );
        await tx.v2LocalizationMediaRunRevision.create({
          data: revisionData(input.run, input.run.updatedAt),
        });
        return input.run;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
