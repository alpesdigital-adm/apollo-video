import {
  Prisma,
  type PrismaClient,
} from "../../../../generated/prisma-v2/index.js";

import type {
  MusicAnalysisRepository,
  MusicMontagePlanningAuthority,
  MusicMontageRun,
  MusicMontageRunRepository,
} from "../../application/ports/music-led-montage.ts";
import {
  createMusicAnalysis,
  type MusicAnalysisV1,
} from "../../domain/music-led-montage.ts";
import { calculateCanonicalHash } from "../../domain/canonical-hash.ts";
import { DomainError } from "../../domain/errors.ts";
import { childRowId } from "./child-row-id.ts";
import { calculateRenderablePlanHash } from "../../application/renderable-edit-plan.ts";
import { evaluateAssetUse } from "../../domain/asset-rights.ts";
import { hydrateAssetRights } from "./asset-rights-repository.ts";
import { hydrateStoredMediaTranscript } from "./speech-segment-catalog-repository.ts";
import {
  batchActorAuditData,
  hydrateBatchActorAudit,
} from "./batch-actor-audit.ts";

function hydrateAnalysis(row: {
  analysisJson: string;
  analysisHash: string;
}): MusicAnalysisV1 {
  let parsed: MusicAnalysisV1;
  try {
    parsed = JSON.parse(row.analysisJson) as MusicAnalysisV1;
  } catch {
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Stored music analysis JSON is invalid",
    );
  }
  const {
    schemaVersion: _schemaVersion,
    analysisHash: _analysisHash,
    ...body
  } = parsed;
  const hydrated = createMusicAnalysis(body);
  if (
    hydrated.analysisHash !== row.analysisHash ||
    parsed.analysisHash !== row.analysisHash
  )
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Stored music analysis hash is inconsistent",
    );
  return hydrated;
}

export class PrismaMusicAnalysisRepository implements MusicAnalysisRepository {
  private readonly client: PrismaClient;
  constructor(client: PrismaClient) {
    this.client = client;
  }
  async findBySourceFingerprint(
    input: Parameters<MusicAnalysisRepository["findBySourceFingerprint"]>[0],
  ) {
    const row = await this.client.v2MusicAnalysis.findUnique({
      where: {
        workspaceId_sourceArtifactId_sourceSha256_analyzerId_analyzerVersion:
          input,
      },
      select: { analysisJson: true, analysisHash: true },
    });
    return row ? hydrateAnalysis(row) : null;
  }
  async findById(workspaceId: string, id: string) {
    const row = await this.client.v2MusicAnalysis.findFirst({
      where: { workspaceId, id },
      select: { analysisJson: true, analysisHash: true },
    });
    return row ? hydrateAnalysis(row) : null;
  }
  async save(input: Parameters<MusicAnalysisRepository["save"]>[0]) {
    const analysis = input.analysis;
    const data = {
      id: analysis.id,
      workspaceId: input.workspaceId,
      projectVersionId: input.projectVersionId,
      sourceArtifactId: analysis.sourceArtifactId,
      sourceSha256: analysis.sourceSha256,
      sourceByteSize: BigInt(analysis.sourceByteSize),
      rightsSnapshotId: input.rightsSnapshotId,
      analyzerId: analysis.analyzer.id,
      analyzerVersion: analysis.analyzer.version,
      durationMs: analysis.durationMs,
      bpm: analysis.tempo.bpm,
      confidence: analysis.confidence,
      analysisJson: JSON.stringify(analysis),
      analysisHash: analysis.analysisHash,
      createdAt: new Date(),
    };
    const existing = await this.client.v2MusicAnalysis.findFirst({
      where: { workspaceId: input.workspaceId, id: analysis.id },
      select: { analysisJson: true, analysisHash: true },
    });
    if (existing) {
      const replay = hydrateAnalysis(existing);
      if (replay.analysisHash !== analysis.analysisHash)
        throw new DomainError(
          "PERSISTENCE_CONFLICT",
          "Music analysis id is already bound to different bytes",
        );
      await this.authorizeReuse({
        ...input,
        analysis: replay,
        authorizedAt: new Date().toISOString(),
      });
      return replay;
    }
    const row = await this.client.v2MusicAnalysis.create({
      data,
      select: { analysisJson: true, analysisHash: true },
    });
    await this.authorizeReuse({
      ...input,
      analysis,
      authorizedAt: new Date().toISOString(),
    });
    return hydrateAnalysis(row);
  }
  async authorizeReuse(input: {
    workspaceId: string;
    projectVersionId: string;
    rightsSnapshotId: string;
    analysis: MusicAnalysisV1;
    authorizedAt: string;
  }) {
    const row = await this.client.v2MusicAnalysis.findFirst({
      where: {
        id: input.analysis.id,
        workspaceId: input.workspaceId,
        sourceArtifactId: input.analysis.sourceArtifactId,
        sourceSha256: input.analysis.sourceSha256,
        analysisHash: input.analysis.analysisHash,
      },
      select: { id: true },
    });
    if (!row)
      throw new DomainError(
        "PERSISTENCE_CONFLICT",
        "Music analysis authorization does not match the immutable acoustic result",
      );
    await this.client.v2MusicAnalysisAuthorization.upsert({
      where: {
        workspaceId_analysisId_projectVersionId_rightsSnapshotId: {
          workspaceId: input.workspaceId,
          analysisId: input.analysis.id,
          projectVersionId: input.projectVersionId,
          rightsSnapshotId: input.rightsSnapshotId,
        },
      },
      create: {
        id: childRowId(
          [
            input.workspaceId,
            input.analysis.id,
            input.projectVersionId,
            input.rightsSnapshotId,
          ],
          160,
        ),
        workspaceId: input.workspaceId,
        analysisId: input.analysis.id,
        projectVersionId: input.projectVersionId,
        rightsSnapshotId: input.rightsSnapshotId,
        authorizedAt: new Date(input.authorizedAt),
      },
      update: {},
    });
    return input.analysis;
  }
}

export class PrismaMusicMontagePlanningAuthority implements MusicMontagePlanningAuthority {
  private readonly client: PrismaClient;
  constructor(client: PrismaClient) {
    this.client = client;
  }
  async resolveCurrent(
    input: Parameters<MusicMontagePlanningAuthority["resolveCurrent"]>[0],
  ) {
    const [analysisRow, version, transcriptRows, evidenceRows] =
      await Promise.all([
        this.client.v2MusicAnalysis.findFirst({
          where: { id: input.analysisId, workspaceId: input.workspaceId },
          select: {
            sourceArtifactId: true,
            rightsSnapshotId: true,
            analysisJson: true,
            analysisHash: true,
          },
        }),
        this.client.v2Project
          .findFirst({
            where: {
              id: input.projectId,
              workspaceId: input.workspaceId,
              currentVersionId: input.projectVersionId,
            },
            select: {
              currentVersion: {
                select: {
                  id: true,
                  editPlanSnapshot: { select: { contentJson: true } },
                },
              },
            },
          })
          .then((project) => project?.currentVersion ?? null),
        this.client.v2MediaTranscript.findMany({
          where: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            sourceArtifactId: { in: [...input.visualArtifactIds] },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            sourceArtifactId: true,
            transcriptJson: true,
            transcriptHash: true,
          },
        }),
        this.client.v2EvidenceSegment.findMany({
          where: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            sourceArtifactId: { in: [...input.visualArtifactIds] },
          },
          select: {
            id: true,
            sourceArtifactId: true,
            sourceStartMs: true,
            sourceEndMs: true,
            contextStartMs: true,
            contextEndMs: true,
            requiresContext: true,
            qualifiersNormalized: true,
          },
        }),
      ]);
    if (!analysisRow || !version)
      throw new DomainError(
        "MEDIA_ARTIFACT_NOT_FOUND",
        "Music analysis or project version was not found",
      );
    let versionSources: Array<{
      id: string;
      artifactId: string;
      durationSeconds: number;
    }>;
    try {
      const plan = JSON.parse(version.editPlanSnapshot.contentJson) as {
        sources?: Array<{
          id?: unknown;
          artifactId?: unknown;
          durationSeconds?: unknown;
        }>;
      };
      versionSources = (plan.sources ?? [])
        .filter((source) =>
          input.visualArtifactIds.includes(String(source.artifactId)),
        )
        .map((source) => ({
          id: String(source.id),
          artifactId: String(source.artifactId),
          durationSeconds: Number(source.durationSeconds),
        }));
    } catch {
      throw new DomainError(
        "PERSISTENCE_CONFLICT",
        "Current project version sources are invalid",
      );
    }
    const visualLinks = await this.client.v2ProjectMediaAsset.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        artifactId: { in: [...input.visualArtifactIds] },
      },
      include: { artifact: true },
    });
    if (
      versionSources.length !== input.visualArtifactIds.length ||
      visualLinks.length !== input.visualArtifactIds.length ||
      visualLinks.some(
        (item) =>
          item.artifact.status !== "available" ||
          item.artifact.mediaType !== "video",
      )
    )
      throw new DomainError(
        "ASSET_NOT_USABLE",
        "Visual montage source is not an available asset of the current project version",
      );
    const asset = await this.client.v2ProjectMediaAsset.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        artifactId: analysisRow.sourceArtifactId,
      },
      include: { artifact: { include: { currentRightsSnapshot: true } } },
    });
    const rights = asset?.artifact.currentRightsSnapshot;
    const at = new Date(input.at);
    const decision = rights
      ? evaluateAssetUse(
          hydrateAssetRights(rights),
          {
            workspaceId: input.workspaceId,
            use: "music-led-montage",
            locale: input.locale,
            ...(input.market ? { market: input.market } : {}),
          },
          at,
        )
      : null;
    const authorization = rights
      ? await this.client.v2MusicAnalysisAuthorization.findUnique({
          where: {
            workspaceId_analysisId_projectVersionId_rightsSnapshotId: {
              workspaceId: input.workspaceId,
              analysisId: input.analysisId,
              projectVersionId: input.projectVersionId,
              rightsSnapshotId: rights.id,
            },
          },
          select: { id: true },
        })
      : null;
    if (
      !asset ||
      asset.artifact.status !== "available" ||
      asset.artifact.mediaType !== "audio" ||
      asset.artifact.sha256 !== hydrateAnalysis(analysisRow).sourceSha256 ||
      !rights ||
      !authorization ||
      decision?.outcome !== "allow"
    )
      throw new DomainError(
        "ASSET_RIGHTS_BLOCKED",
        "Music is unavailable or its current rights no longer authorize montage",
        { reasons: decision?.reasonCodes ?? ["RIGHTS_MISSING"] },
      );
    const latestTranscriptByArtifact = new Map<
      string,
      (typeof transcriptRows)[number]
    >();
    for (const row of transcriptRows)
      if (!latestTranscriptByArtifact.has(row.sourceArtifactId))
        latestTranscriptByArtifact.set(row.sourceArtifactId, row);
    const protectedSpeechRanges: Array<
      Readonly<
        import("../../domain/music-led-montage.ts").ProtectedSpeechRange & {
          sourceArtifactId: string;
        }
      >
    > = [...latestTranscriptByArtifact.values()].flatMap((row) => {
      const transcript = hydrateStoredMediaTranscript(row);
      return transcript.words.map((word, index) =>
        Object.freeze({
          id: `${row.id}:word:${index}`,
          sourceArtifactId: row.sourceArtifactId,
          rangeMs: Object.freeze([
            Math.round(word.start * 1000),
            Math.round(word.end * 1000),
          ] as [number, number]),
          reason: "word" as const,
        }),
      );
    });
    for (const evidence of evidenceRows)
      protectedSpeechRanges.push(
        Object.freeze({
          id: `${evidence.id}:${evidence.requiresContext ? "context" : "claim"}`,
          sourceArtifactId: evidence.sourceArtifactId,
          rangeMs: Object.freeze([
            evidence.requiresContext
              ? evidence.contextStartMs
              : evidence.sourceStartMs,
            evidence.requiresContext
              ? evidence.contextEndMs
              : evidence.sourceEndMs,
          ] as [number, number]),
          reason: (evidence.qualifiersNormalized.trim()
            ? "qualifier"
            : evidence.requiresContext
              ? "narrative-dependency"
              : "claim") as "qualifier" | "narrative-dependency" | "claim",
        }),
      );
    return Object.freeze({
      analysis: hydrateAnalysis(analysisRow),
      musicArtifactId: analysisRow.sourceArtifactId,
      rightsSnapshotId: rights.id,
      visualSources: Object.freeze(
        versionSources.map((source) => Object.freeze(source)),
      ),
      protectedSpeechRanges: Object.freeze(protectedSpeechRanges),
    });
  }
}

function hydrateRun(row: {
  runJson: string;
  runHash: string;
}): MusicMontageRun {
  let run: MusicMontageRun;
  try {
    run = JSON.parse(row.runJson) as MusicMontageRun;
  } catch {
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Stored music montage run JSON is invalid",
    );
  }
  const { runHash: _runHash, ...body } = run;
  if (
    calculateCanonicalHash(body) !== row.runHash ||
    run.runHash !== row.runHash
  )
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Stored music montage run hash is inconsistent",
    );
  return Object.freeze(run);
}

export class PrismaMusicMontageRunRepository implements MusicMontageRunRepository {
  private readonly client: PrismaClient;
  constructor(client: PrismaClient) {
    this.client = client;
  }
  async findRequestReplay(
    input: Parameters<MusicMontageRunRepository["findRequestReplay"]>[0],
  ) {
    const row = await this.client.v2MusicMontageRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (!row) return null;
    if (
      row.createdByClientId !== input.actorClientId ||
      hydrateBatchActorAudit(row, row.createdByClientId).contextHash !==
        input.actorContextHash ||
      row.requestFingerprint !== input.requestFingerprint
    )
      throw new DomainError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "Music montage idempotency key belongs to another request or actor context",
      );
    return hydrateRun(row);
  }
  async findById(workspaceId: string, projectId: string, id: string) {
    const row = await this.client.v2MusicMontageRun.findFirst({
      where: { workspaceId, projectId, id },
      select: { runJson: true, runHash: true },
    });
    return row ? hydrateRun(row) : null;
  }
  async saveWithRenderablePlan(
    input: Parameters<MusicMontageRunRepository["saveWithRenderablePlan"]>[0],
  ) {
    const { run, renderablePlan: snapshot } = input;
    if (
      !run.critic.eligibleForAutomaticRender ||
      snapshot.sourceHash !== run.montagePlan.planHash ||
      snapshot.planHash !== calculateRenderablePlanHash(snapshot.plan)
    )
      throw new DomainError(
        "PERSISTENCE_CONFLICT",
        "Music run and renderable plan are not the same eligible derivation",
      );
    const snapshotId = childRowId(
      [
        snapshot.workspaceId,
        snapshot.origin,
        snapshot.sourceId,
        snapshot.sourceHash.slice(0, 16),
        snapshot.plan.projectVersionId,
        String(snapshot.fps),
      ],
      200,
    );
    try {
      return await this.client.$transaction(
        async (transaction) => {
          const replay = await transaction.v2MusicMontageRun.findFirst({
            where: {
              workspaceId: run.workspaceId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          if (replay) {
            if (
              replay.createdByClientId !== input.actorClientId ||
              hydrateBatchActorAudit(replay, replay.createdByClientId)
                .contextHash !== input.authenticationAudit.contextHash ||
              replay.requestFingerprint !== input.requestFingerprint
            )
              throw new DomainError(
                "IDEMPOTENCY_PAYLOAD_MISMATCH",
                "Music montage idempotency key belongs to another request or actor context",
              );
            return Object.freeze({ run: hydrateRun(replay), replayed: true });
          }
          const [analysisRow, musicAsset, visualAssets, actor, currentProject] =
            await Promise.all([
              transaction.v2MusicAnalysis.findFirst({
                where: {
                  id: run.musicAnalysis.id,
                  workspaceId: run.workspaceId,
                },
                select: {
                  sourceSha256: true,
                  rightsSnapshotId: true,
                  analysisHash: true,
                },
              }),
              transaction.v2ProjectMediaAsset.findFirst({
                where: {
                  workspaceId: run.workspaceId,
                  projectId: run.projectId,
                  artifactId: run.musicAnalysis.sourceArtifactId,
                },
                include: {
                  artifact: { include: { currentRightsSnapshot: true } },
                },
              }),
              transaction.v2ProjectMediaAsset.findMany({
                where: {
                  workspaceId: run.workspaceId,
                  projectId: run.projectId,
                  artifactId: {
                    in: run.editPlan.sources.map((source) => source.artifactId),
                  },
                },
                include: { artifact: true },
              }),
              transaction.v2ApiClient.findFirst({
                where: {
                  id: input.actorClientId,
                  workspaceId: run.workspaceId,
                  status: "active",
                },
                select: { id: true },
              }),
              transaction.v2Project.findFirst({
                where: {
                  id: run.projectId,
                  workspaceId: run.workspaceId,
                  currentVersionId: run.projectVersionId,
                },
                select: { id: true },
              }),
            ]);
          if (!actor)
            throw new DomainError(
              "API_CLIENT_NOT_FOUND",
              "Music montage requester is inactive",
            );
          if (!currentProject)
            throw new DomainError(
              "VERSION_CONFLICT",
              "Project version changed before music montage publication",
            );
          const currentRights = musicAsset?.artifact.currentRightsSnapshot;
          const currentAuthorization = currentRights
            ? await transaction.v2MusicAnalysisAuthorization.findUnique({
                where: {
                  workspaceId_analysisId_projectVersionId_rightsSnapshotId: {
                    workspaceId: run.workspaceId,
                    analysisId: run.musicAnalysis.id,
                    projectVersionId: run.projectVersionId,
                    rightsSnapshotId: currentRights.id,
                  },
                },
                select: { id: true },
              })
            : null;
          const rightsDecision = currentRights
            ? evaluateAssetUse(
                hydrateAssetRights(currentRights),
                {
                  workspaceId: run.workspaceId,
                  use: "music-led-montage",
                  locale: run.locale,
                  ...(run.market ? { market: run.market } : {}),
                },
                new Date(run.createdAt),
              )
            : null;
          if (
            !analysisRow ||
            analysisRow.analysisHash !== run.musicAnalysis.analysisHash ||
            analysisRow.sourceSha256 !== run.musicAnalysis.sourceSha256 ||
            !currentAuthorization ||
            !musicAsset ||
            musicAsset.artifact.sha256 !== run.musicAnalysis.sourceSha256 ||
            currentRights?.id !== run.rightsSnapshotId ||
            rightsDecision?.outcome !== "allow"
          )
            throw new DomainError(
              "ASSET_RIGHTS_BLOCKED",
              "Music authority changed before montage publication",
            );
          if (
            visualAssets.length !== run.editPlan.sources.length ||
            visualAssets.some(
              (item) =>
                item.artifact.status !== "available" ||
                item.artifact.mediaType !== "video",
            )
          )
            throw new DomainError(
              "ASSET_NOT_USABLE",
              "Visual source authority changed before montage publication",
            );
          await transaction.v2RenderablePlanSnapshot.create({
            data: {
              id: snapshotId,
              workspaceId: snapshot.workspaceId,
              projectId: snapshot.projectId,
              projectVersionId: snapshot.plan.projectVersionId,
              planId: snapshot.planId,
              origin: snapshot.origin,
              sourceId: snapshot.sourceId,
              sourceHash: snapshot.sourceHash,
              sourceVersion: snapshot.sourceVersion,
              fps: snapshot.fps,
              durationFrames: snapshot.durationFrames,
              clipCount: snapshot.clipCount,
              planJson: JSON.stringify(snapshot.plan),
              planHash: snapshot.planHash,
              createdAt: new Date(run.createdAt),
            },
          });
          const row = await transaction.v2MusicMontageRun.create({
            data: {
              id: run.id,
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              projectVersionId: run.projectVersionId,
              rightsSnapshotId: run.rightsSnapshotId,
              musicAnalysisId: run.musicAnalysis.id,
              musicAnalysisHash: run.musicAnalysis.analysisHash,
              montagePlanJson: JSON.stringify(run.montagePlan),
              montagePlanHash: run.montagePlan.planHash,
              editPlanId: run.editPlan.id,
              editPlanHash: snapshot.planHash,
              criticJson: JSON.stringify(run.critic),
              eligibleForRender: true,
              runJson: JSON.stringify(run),
              runHash: run.runHash,
              requestFingerprint: input.requestFingerprint,
              idempotencyKey: input.idempotencyKey,
              createdByClientId: input.actorClientId,
              ...batchActorAuditData(
                input.authenticationAudit,
                run.workspaceId,
                input.actorClientId,
              ),
              createdAt: new Date(run.createdAt),
            },
            select: { runJson: true, runHash: true },
          });
          return Object.freeze({ run: hydrateRun(row), replayed: false });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error.code === "P2002" || error.code === "P2034")
      ) {
        const replay = await this.findRequestReplay({
          workspaceId: run.workspaceId,
          actorClientId: input.actorClientId,
          actorContextHash: input.authenticationAudit.contextHash,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        });
        if (replay) return Object.freeze({ run: replay, replayed: true });
        throw new DomainError(
          "PERSISTENCE_CONFLICT",
          "Music montage publication conflicted",
        );
      }
      throw error;
    }
  }
}
