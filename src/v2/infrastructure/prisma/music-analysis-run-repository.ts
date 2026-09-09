import {
  Prisma,
  type PrismaClient,
} from "../../../../generated/prisma-v2/index.js";
import type {
  MusicAnalysisRun,
  MusicAnalysisRunRepository,
} from "../../application/ports/music-led-montage.ts";
import { DomainError } from "../../domain/errors.ts";
import { evaluateAssetUse } from "../../domain/asset-rights.ts";
import { hydrateAssetRights } from "./asset-rights-repository.ts";
import {
  batchActorAuditData,
  hydrateBatchActorAudit,
} from "./batch-actor-audit.ts";
import { childRowId } from "./child-row-id.ts";

function hydrate(row: any): Readonly<MusicAnalysisRun> {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactKey: row.sourceArtifactKey,
    sourceSha256: row.sourceSha256,
    sourceByteSize: Number(row.sourceByteSize),
    rightsSnapshotId: row.rightsSnapshotId,
    locale: row.locale,
    status: row.status,
    attempt: row.attempt,
    analysisId: row.analysisId,
    analysisHash: row.analysisHash,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    requestedByClientId: row.requestedByClientId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export class PrismaMusicAnalysisRunRepository implements MusicAnalysisRunRepository {
  private readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }
  async resolveRequestAuthority(
    input: Parameters<MusicAnalysisRunRepository["resolveRequestAuthority"]>[0],
  ) {
    const project = await this.prisma.v2Project.findFirst({
      where: {
        id: input.projectId,
        workspaceId: input.workspaceId,
        currentVersionId: input.projectVersionId,
      },
      select: { locale: true },
    });
    const link = await this.prisma.v2ProjectMediaAsset.findFirst({
      where: {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
      },
      include: { artifact: { include: { currentRightsSnapshot: true } } },
    });
    const artifact = link?.artifact,
      rights = artifact?.currentRightsSnapshot;
    if (!project || !project.locale)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Music analysis requires the current localized project version",
      );
    if (
      !artifact ||
      artifact.status !== "available" ||
      artifact.mediaType !== "audio" ||
      artifact.byteSize <= BigInt(0) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
      throw new DomainError(
        "ASSET_NOT_USABLE",
        "Music artifact is not an available project audio source",
      );
    const decision = rights
      ? evaluateAssetUse(
          hydrateAssetRights(rights),
          {
            workspaceId: input.workspaceId,
            use: "music-led-montage",
            locale: project.locale,
          },
          new Date(input.at),
        )
      : null;
    if (
      !rights ||
      artifact.currentRightsSnapshotId !== rights.id ||
      decision?.outcome !== "allow"
    )
      throw new DomainError(
        "ASSET_RIGHTS_BLOCKED",
        "Current music rights do not authorize analysis for montage",
        { reasons: decision?.reasonCodes ?? ["RIGHTS_MISSING"] },
      );
    return Object.freeze({
      artifactKey: artifact.artifactKey,
      sha256: artifact.sha256,
      byteSize: Number(artifact.byteSize),
      rightsSnapshotId: rights.id,
      locale: project.locale,
    });
  }
  async findRequestReplay(
    input: Parameters<MusicAnalysisRunRepository["findRequestReplay"]>[0],
  ) {
    const row = await this.prisma.v2MusicAnalysisRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        requestedByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (!row) return null;
    if (
      row.requestFingerprint !== input.requestFingerprint ||
      hydrateBatchActorAudit(row, row.requestedByClientId).contextHash !==
        input.actorContextHash
    )
      throw new DomainError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "Music analysis idempotency key belongs to another request or actor context",
      );
    return hydrate(row);
  }
  async create(input: Parameters<MusicAnalysisRunRepository["create"]>[0]) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const replay = await tx.v2MusicAnalysisRun.findFirst({
            where: {
              workspaceId: input.run.workspaceId,
              requestedByClientId: input.run.requestedByClientId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          if (replay) {
            if (
              replay.requestFingerprint !== input.requestFingerprint ||
              hydrateBatchActorAudit(replay, replay.requestedByClientId)
                .contextHash !== input.authenticationAudit.contextHash
            )
              throw new DomainError(
                "IDEMPOTENCY_PAYLOAD_MISMATCH",
                "Music analysis idempotency key belongs to another request or actor context",
              );
            return Object.freeze({ run: hydrate(replay), replayed: true });
          }
          const existing = await tx.v2MusicAnalysisRun.findFirst({
            where: {
              workspaceId: input.run.workspaceId,
              sourceFingerprint: input.sourceFingerprint,
              status: { in: ["queued", "running", "completed"] },
            },
            orderBy: { createdAt: "desc" },
          });
          if (existing)
            return Object.freeze({ run: hydrate(existing), replayed: true });
          const authority = await new PrismaMusicAnalysisRunRepository(
            tx as unknown as PrismaClient,
          ).resolveRequestAuthority({
            workspaceId: input.run.workspaceId,
            projectId: input.run.projectId,
            projectVersionId: input.run.projectVersionId,
            artifactId: input.run.sourceArtifactId,
            at: input.run.createdAt,
          });
          if (
            authority.sha256 !== input.run.sourceSha256 ||
            authority.rightsSnapshotId !== input.run.rightsSnapshotId
          )
            throw new DomainError(
              "VERSION_CONFLICT",
              "Music source authority changed before request persistence",
            );
          const actor = await tx.v2ApiClient.findFirst({
            where: {
              id: input.run.requestedByClientId,
              workspaceId: input.run.workspaceId,
              status: "active",
            },
            select: { id: true },
          });
          if (!actor)
            throw new DomainError(
              "API_CLIENT_NOT_FOUND",
              "Music analysis requester is inactive",
            );
          const row = await tx.v2MusicAnalysisRun.create({
            data: {
              id: input.run.id,
              workspaceId: input.run.workspaceId,
              projectId: input.run.projectId,
              projectVersionId: input.run.projectVersionId,
              sourceArtifactId: input.run.sourceArtifactId,
              sourceArtifactKey: input.run.sourceArtifactKey,
              sourceSha256: input.run.sourceSha256,
              sourceByteSize: BigInt(input.run.sourceByteSize),
              rightsSnapshotId: input.run.rightsSnapshotId,
              locale: input.run.locale,
              status: input.run.status,
              attempt: input.run.attempt,
              analysisId: null,
              analysisHash: null,
              failureCode: null,
              failureMessage: null,
              requestFingerprint: input.requestFingerprint,
              sourceFingerprint: input.sourceFingerprint,
              idempotencyKey: input.idempotencyKey,
              requestedByClientId: input.run.requestedByClientId,
              ...batchActorAuditData(
                input.authenticationAudit,
                input.run.workspaceId,
                input.run.requestedByClientId,
              ),
              createdAt: new Date(input.run.createdAt),
              updatedAt: new Date(input.run.updatedAt),
            },
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
        (error.code === "P2002" || error.code === "P2034")
      )
        throw new DomainError(
          "PERSISTENCE_CONFLICT",
          "Music analysis request conflicted",
        );
      throw error;
    }
  }
  async read(input: Parameters<MusicAnalysisRunRepository["read"]>[0]) {
    const row = await this.prisma.v2MusicAnalysisRun.findFirst({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
    });
    return row ? hydrate(row) : null;
  }
  async claim(input: Parameters<MusicAnalysisRunRepository["claim"]>[0]) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.v2MusicAnalysisRun.updateMany({
          where: {
            status: "running",
            attempt: { gte: 3 },
            leaseExpiresAt: { lte: new Date(input.now) },
          },
          data: {
            status: "failed",
            failureCode: "ATTEMPTS_EXHAUSTED",
            failureMessage: "Music analysis exhausted its bounded attempts",
            updatedAt: new Date(input.now),
            leaseOwner: null,
            leaseTokenHash: null,
            leaseExpiresAt: null,
          },
        });
        for (let skipped = 0; skipped < 100; skipped += 1) {
          const candidate = await tx.v2MusicAnalysisRun.findFirst({
            where: {
              OR: [
                { status: "queued" },
                {
                  status: "running",
                  leaseExpiresAt: { lte: new Date(input.now) },
                },
              ],
              attempt: { lt: 3 },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
          if (!candidate) return null;
          let authority;
          try {
            authority = await new PrismaMusicAnalysisRunRepository(
              tx as unknown as PrismaClient,
            ).resolveRequestAuthority({
              workspaceId: candidate.workspaceId,
              projectId: candidate.projectId,
              projectVersionId: candidate.projectVersionId,
              artifactId: candidate.sourceArtifactId,
              at: input.now,
            });
          } catch (error) {
            await tx.v2MusicAnalysisRun.update({
              where: { id: candidate.id },
              data: {
                status: "failed",
                failureCode:
                  error instanceof DomainError
                    ? error.code
                    : "SOURCE_AUTHORITY_CHANGED",
                failureMessage:
                  "Music source authority was unavailable before analysis",
                updatedAt: new Date(input.now),
                leaseOwner: null,
                leaseTokenHash: null,
                leaseExpiresAt: null,
              },
            });
            continue;
          }
          if (
            authority.sha256 !== candidate.sourceSha256 ||
            authority.byteSize !== Number(candidate.sourceByteSize) ||
            authority.artifactKey !== candidate.sourceArtifactKey ||
            authority.rightsSnapshotId !== candidate.rightsSnapshotId
          ) {
            await tx.v2MusicAnalysisRun.update({
              where: { id: candidate.id },
              data: {
                status: "failed",
                failureCode: "SOURCE_AUTHORITY_CHANGED",
                failureMessage:
                  "Music source bytes, project version, or rights changed before analysis",
                updatedAt: new Date(input.now),
                leaseOwner: null,
                leaseTokenHash: null,
                leaseExpiresAt: null,
              },
            });
            continue;
          }
          const changed = await tx.v2MusicAnalysisRun.updateMany({
            where: {
              id: candidate.id,
              status: candidate.status,
              attempt: candidate.attempt,
              ...(candidate.status === "running"
                ? { leaseExpiresAt: { lte: new Date(input.now) } }
                : {}),
            },
            data: {
              status: "running",
              attempt: { increment: 1 },
              leaseOwner: input.workerId,
              leaseTokenHash: input.leaseTokenHash,
              leaseExpiresAt: new Date(input.leaseExpiresAt),
              heartbeatAt: new Date(input.now),
              updatedAt: new Date(input.now),
              failureCode: null,
              failureMessage: null,
            },
          });
          if (changed.count !== 1) continue;
          return hydrate(
            await tx.v2MusicAnalysisRun.findUniqueOrThrow({
              where: { id: candidate.id },
            }),
          );
        }
        return null;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  async heartbeat(
    input: Parameters<MusicAnalysisRunRepository["heartbeat"]>[0],
  ) {
    const result = await this.prisma.v2MusicAnalysisRun.updateMany({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        status: "running",
        leaseTokenHash: input.leaseTokenHash,
        leaseExpiresAt: { gt: new Date(input.now) },
      },
      data: {
        heartbeatAt: new Date(input.now),
        leaseExpiresAt: new Date(input.leaseExpiresAt),
        updatedAt: new Date(input.now),
      },
    });
    return result.count === 1;
  }
  async settle(input: Parameters<MusicAnalysisRunRepository["settle"]>[0]) {
    const changed = await this.prisma.v2MusicAnalysisRun.updateMany({
      where: {
        id: input.run.id,
        workspaceId: input.run.workspaceId,
        status: "running",
        leaseTokenHash: input.leaseTokenHash,
        leaseExpiresAt: { gt: new Date(input.now) },
      },
      data: {
        status: input.run.status,
        analysisId: input.run.analysisId,
        analysisHash: input.run.analysisHash,
        failureCode: input.run.failureCode,
        failureMessage: input.run.failureMessage,
        leaseOwner: null,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        heartbeatAt: new Date(input.now),
        updatedAt: new Date(input.now),
      },
    });
    if (changed.count !== 1)
      throw new DomainError(
        "VERSION_CONFLICT",
        "Music analysis lease expired or was fenced before settlement",
      );
    return (await this.read({
      workspaceId: input.run.workspaceId,
      projectId: input.run.projectId,
      runId: input.run.id,
    }))!;
  }
  async cancel(input: Parameters<MusicAnalysisRunRepository["cancel"]>[0]) {
    return this.prisma.$transaction(
      async (tx) => {
        if (input.authenticationAudit.workspaceId !== input.workspaceId)
          throw new DomainError(
            "AUTH_INVALID",
            "Music analysis cancel audit belongs to another workspace",
          );
        const current = await tx.v2MusicAnalysisRun.findFirst({
          where: {
            id: input.runId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
          },
        });
        if (!current)
          throw new DomainError(
            "MEDIA_ARTIFACT_NOT_FOUND",
            "Music analysis run was not found",
          );
        if (current.status === "canceled") return hydrate(current);
        if (!["queued", "running"].includes(current.status))
          throw new DomainError(
            "VERSION_CONFLICT",
            "Only an active music analysis can be canceled",
          );
        const changed = await tx.v2MusicAnalysisRun.updateMany({
          where: {
            id: current.id,
            status: current.status,
            attempt: current.attempt,
          },
          data: {
            status: "canceled",
            leaseOwner: null,
            leaseTokenHash: null,
            leaseExpiresAt: null,
            updatedAt: new Date(input.now),
          },
        });
        if (changed.count !== 1)
          throw new DomainError(
            "PERSISTENCE_CONFLICT",
            "Music analysis changed while it was being canceled",
          );
        await tx.v2MusicAnalysisRunAction.create({
          data: {
            id: childRowId(
              [
                input.workspaceId,
                current.id,
                "cancel",
                String(current.attempt),
                current.status,
              ],
              160,
            ),
            workspaceId: input.workspaceId,
            runId: current.id,
            action: "cancel",
            previousStatus: current.status,
            resultStatus: "canceled",
            attempt: current.attempt,
            actorClientId: input.authenticationAudit.clientId,
            ...batchActorAuditData(
              input.authenticationAudit,
              input.workspaceId,
              input.authenticationAudit.clientId,
            ),
            createdAt: new Date(input.now),
          },
        });
        return hydrate(
          await tx.v2MusicAnalysisRun.findUniqueOrThrow({
            where: { id: current.id },
          }),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  async retry(input: Parameters<MusicAnalysisRunRepository["retry"]>[0]) {
    return this.prisma.$transaction(
      async (tx) => {
        if (input.authenticationAudit.workspaceId !== input.workspaceId)
          throw new DomainError(
            "AUTH_INVALID",
            "Music analysis retry audit belongs to another workspace",
          );
        const current = await tx.v2MusicAnalysisRun.findFirst({
          where: {
            id: input.runId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
          },
        });
        if (!current)
          throw new DomainError(
            "MEDIA_ARTIFACT_NOT_FOUND",
            "Music analysis run was not found",
          );
        if (current.status === "queued") {
          const replay = await tx.v2MusicAnalysisRunAction.findFirst({
            where: {
              workspaceId: input.workspaceId,
              runId: current.id,
              action: "retry",
              attempt: current.attempt,
              actorContextHash: input.authenticationAudit.contextHash,
            },
          });
          if (replay) return hydrate(current);
        }
        if (current.status !== "failed" || current.attempt >= 3)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Only a failed music analysis below its attempt limit can be retried",
          );
        const changed = await tx.v2MusicAnalysisRun.updateMany({
          where: { id: current.id, status: "failed", attempt: current.attempt },
          data: {
            status: "queued",
            failureCode: null,
            failureMessage: null,
            updatedAt: new Date(input.now),
          },
        });
        if (changed.count !== 1)
          throw new DomainError(
            "PERSISTENCE_CONFLICT",
            "Music analysis changed while it was being retried",
          );
        await tx.v2MusicAnalysisRunAction.create({
          data: {
            id: childRowId(
              [
                input.workspaceId,
                current.id,
                "retry",
                String(current.attempt),
                current.status,
              ],
              160,
            ),
            workspaceId: input.workspaceId,
            runId: current.id,
            action: "retry",
            previousStatus: current.status,
            resultStatus: "queued",
            attempt: current.attempt,
            actorClientId: input.authenticationAudit.clientId,
            ...batchActorAuditData(
              input.authenticationAudit,
              input.workspaceId,
              input.authenticationAudit.clientId,
            ),
            createdAt: new Date(input.now),
          },
        });
        return hydrate(
          await tx.v2MusicAnalysisRun.findUniqueOrThrow({
            where: { id: current.id },
          }),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
