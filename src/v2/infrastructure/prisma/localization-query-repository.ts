import type { PrismaClient } from "../../../../generated/prisma-v2/index.js";
import type {
  LocalizationCandidate,
  LocalizationProfileSummary,
  LocalizationQueryRepository,
  LocalizationVariantView,
} from "../../application/ports/localization-query-repository.ts";
import { DomainError } from "../../domain/errors.ts";
import {
  assertLocalizationVariantIntegrity,
  createCanonicalScriptVersion,
  LOCALIZED_AUDIO_MODES,
  type CanonicalScriptVersion,
  type LocalizationVariant,
  type LocalizedAudioMode,
} from "../../domain/localization.ts";
import { hydrateScriptAlignmentRun } from "../../domain/script-alignment.ts";
import { getV2PostgresClient } from "../prisma-postgres/client.ts";

function parse<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      `Stored ${label} is invalid JSON`,
    );
  }
}
function canonical(row: { snapshotJson: string; contentHash: string }) {
  const raw = parse<CanonicalScriptVersion>(
    row.snapshotJson,
    "canonical localization",
  );
  const { contentHash: _contentHash, blocks, ...identity } = raw;
  const value = createCanonicalScriptVersion({
    ...identity,
    blocks: blocks.map(({ blockHash: _hash, ...block }) => block),
  });
  if (value.contentHash !== row.contentHash)
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Canonical localization hash is inconsistent",
    );
  return value;
}
function variant(row: { variantJson: string; variantHash: string }) {
  const value = assertLocalizationVariantIntegrity(
    Object.freeze(
      parse<LocalizationVariant>(row.variantJson, "localization variant"),
    ),
  );
  if (value.variantHash !== row.variantHash)
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Localization variant hash is inconsistent",
    );
  return value;
}
function rightsModes(json: string | null): readonly LocalizedAudioMode[] {
  const values = json ? parse<string[]>(json, "localization rights modes") : [];
  const result: LocalizedAudioMode[] = [
    "uploaded",
    "local-voice",
    "subtitles-only",
  ];
  if (values.includes("tts")) result.push("authorized-tts");
  if (values.includes("audio-avatar"))
    result.push("lip-sync", "regenerated-avatar");
  return Object.freeze(result);
}
function presentVariant(
  value: Readonly<LocalizationVariant>,
  profileModesJson: string,
  rightsModesJson: string | null,
  latestCanonicalId?: string,
): LocalizationVariantView {
  const profileModes = parse<string[]>(
    profileModesJson,
    "localization profile modes",
  );
  if (
    !Array.isArray(profileModes) ||
    profileModes.some(
      (mode) => !LOCALIZED_AUDIO_MODES.includes(mode as LocalizedAudioMode),
    )
  )
    throw new DomainError(
      "PERSISTENCE_CONFLICT",
      "Localization profile modes are invalid",
    );
  const rights = rightsModes(rightsModesJson);
  return Object.freeze({
    ...value,
    allowedModes: Object.freeze(
      LOCALIZED_AUDIO_MODES.map((mode) => {
        const reasons = [
          ...(!profileModes.includes(mode) ? ["PROFILE_DISALLOWS_MODE"] : []),
          ...(!rights.includes(mode) ? ["RIGHTS_DISALLOW_MODE"] : []),
        ];
        return Object.freeze({
          mode,
          allowed: reasons.length === 0,
          reasons: Object.freeze(reasons),
        });
      }),
    ),
    stale: Object.freeze({
      isStale: Boolean(
        latestCanonicalId &&
        latestCanonicalId !== value.canonicalScriptVersionId,
      ),
      ...(latestCanonicalId
        ? { latestCanonicalScriptVersionId: latestCanonicalId }
        : {}),
    }),
  });
}

export class PrismaLocalizationQueryRepository implements LocalizationQueryRepository {
  private readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient = getV2PostgresClient()) {
    this.prisma = prisma;
  }
  async listCanonicals(input: { workspaceId: string; projectId: string }) {
    return Promise.all(
      (
        await this.prisma.v2LocalizationCanonicalScript.findMany({
          where: input,
          orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
        })
      ).map(canonical),
    );
  }
  async listCandidates(input: { workspaceId: string; projectId: string }) {
    const [versions, rows] = await Promise.all([
      this.prisma.v2ProjectVersion.findMany({
        where: input,
        include: { editPlanSnapshot: { select: { contentJson: true } } },
        orderBy: [{ sequence: "desc" }, { id: "desc" }],
      }),
      this.prisma.v2ScriptAlignmentRun.findMany({
        where: { ...input, status: "reviewed", reviewRequiredCount: 0 },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    const versionSources = versions.map((version) => {
      const editPlan = parse<{ sources?: readonly { artifactId?: unknown }[] }>(
        version.editPlanSnapshot.contentJson,
        "project version edit plan",
      );
      const artifactIds = new Set(
        (editPlan.sources ?? [])
          .map((source) => source.artifactId)
          .filter((id): id is string => typeof id === "string"),
      );
      return { id: version.id, artifactIds };
    });
    const candidates: LocalizationCandidate[] = rows.flatMap((row) => {
      const run = hydrateScriptAlignmentRun(
        parse(row.resultJson, "script alignment candidate"),
      );
      if (
        run.runHash !== row.runHash ||
        run.status !== "reviewed" ||
        run.summary.reviewRequiredCount !== 0
      )
        throw new DomainError(
          "PERSISTENCE_CONFLICT",
          "Reviewed alignment candidate is inconsistent",
        );
      const sourceArtifactIds = new Set(
        run.sourceRefs.map((source) => source.sourceArtifactId),
      );
      const matchingVersions = versionSources.filter(
        (version) =>
          sourceArtifactIds.size > 0 &&
          [...sourceArtifactIds].every((id) => version.artifactIds.has(id)),
      );
      return matchingVersions.map(({ id: projectVersionId }) =>
        Object.freeze({
          alignmentId: run.id,
          alignmentHash: run.runHash,
          batchId: row.batchId,
          projectVersionId,
          sourceLocale: run.document.locale,
          blocks: Object.freeze(
            run.alignments.map((alignment) => {
              const source = run.document.blocks.find(
                (block) => block.id === alignment.blockId,
              );
              if (!source || !alignment.selectedCandidate)
                throw new DomainError(
                  "PERSISTENCE_CONFLICT",
                  "Reviewed alignment candidate lacks a selected source range",
                );
              return Object.freeze({
                sourceScriptBlockId: source.id,
                role: source.role,
                text: source.plannedText,
                sourceRangeMs: alignment.selectedCandidate.sourceRangeMs,
                reviewStatus: alignment.reviewStatus,
              });
            }),
          ),
        }),
      );
    });
    return Object.freeze(candidates);
  }
  async listProfiles(input: { workspaceId: string }) {
    const rows = await this.prisma.v2LocalizationProfile.findMany({
      where: input,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return Object.freeze(
      rows.map((row): LocalizationProfileSummary => {
        const modes = parse<string[]>(
          row.allowedModesJson,
          "localization profile modes",
        );
        if (
          !Array.isArray(modes) ||
          modes.some(
            (mode) =>
              !LOCALIZED_AUDIO_MODES.includes(mode as LocalizedAudioMode),
          )
        )
          throw new DomainError(
            "PERSISTENCE_CONFLICT",
            "Localization profile modes are invalid",
          );
        return Object.freeze({
          id: row.id,
          targetLocale: row.targetLocale,
          ...(row.market ? { market: row.market } : {}),
          allowedModes: Object.freeze(modes as LocalizedAudioMode[]),
          profileHash: row.profileHash,
        });
      }),
    );
  }
  async listVariants(input: { workspaceId: string; projectId: string }) {
    const [latest, heads] = await Promise.all([
      this.prisma.v2LocalizationCanonicalScript.findFirst({
        where: input,
        orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
        select: { id: true },
      }),
      this.prisma.v2LocalizationVariantHead.findMany({
        where: input,
        include: {
          profile: { select: { allowedModesJson: true } },
          sourceRightsSnapshot: {
            select: { allowedSyntheticOperationsJson: true },
          },
          revisions: { orderBy: { revision: "desc" }, take: 1 },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    return Object.freeze(
      heads.map((head) => {
        const row = head.revisions[0];
        if (
          !row ||
          row.revision !== head.currentRevision ||
          row.variantHash !== head.currentVariantHash
        )
          throw new DomainError(
            "PERSISTENCE_CONFLICT",
            "Localization head does not address its immutable revision",
          );
        return presentVariant(
          variant(row),
          head.profile.allowedModesJson,
          head.sourceRightsSnapshot.allowedSyntheticOperationsJson,
          latest?.id,
        );
      }),
    );
  }
  async readVariant(input: {
    workspaceId: string;
    projectId: string;
    variantId: string;
  }) {
    const [latest, head] = await Promise.all([
      this.prisma.v2LocalizationCanonicalScript.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId },
        orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
        select: { id: true },
      }),
      this.prisma.v2LocalizationVariantHead.findFirst({
        where: {
          id: input.variantId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
        },
        include: {
          profile: { select: { allowedModesJson: true } },
          sourceRightsSnapshot: {
            select: { allowedSyntheticOperationsJson: true },
          },
          revisions: { orderBy: { revision: "desc" }, take: 1 },
        },
      }),
    ]);
    return head?.revisions[0]
      ? presentVariant(
          variant(head.revisions[0]),
          head.profile.allowedModesJson,
          head.sourceRightsSnapshot.allowedSyntheticOperationsJson,
          latest?.id,
        )
      : null;
  }
}
