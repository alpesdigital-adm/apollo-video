import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createWorkspaceRow,
  issueApiClient,
  createProjectRow,
  registerRecording,
  seedBaseProjectVersion,
} from "./capture-journey.mjs";

const { createMediaTranscript } =
  await import("../../../src/v2/domain/media-transcript.ts");
const { createProductionBrief } =
  await import("../../../src/v2/domain/production-brief.ts");
const { createProductionBatch, deriveBatchStatus } =
  await import("../../../src/v2/domain/production-batch.ts");
const {
  createScriptAlignmentRun,
  importScriptDocument,
  reviewScriptAlignmentRun,
} = await import("../../../src/v2/domain/script-alignment.ts");
const { createApiAccessAuditContext } =
  await import("../../../src/v2/domain/api-access-control.ts");
const { stableSerialize, calculateCanonicalHash } =
  await import("../../../src/v2/domain/canonical-hash.ts");
const { transitionLocalizationVariant } =
  await import("../../../src/v2/domain/localization.ts");
const { batchActorAuditData } =
  await import("../../../src/v2/infrastructure/prisma/batch-actor-audit.ts");
const { PrismaScriptAlignmentRepository } =
  await import("../../../src/v2/infrastructure/prisma/script-alignment-repository.ts");
const { PrismaLocalizationRepository } =
  await import("../../../src/v2/infrastructure/prisma/localization-repository.ts");
const { PrismaProjectLutSelectionRepository } =
  await import("../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts");
const { setProjectLutSelectionService } =
  await import("../../../src/v2/application/project-lut-selections.ts");
const { PrismaAssetRightsRepository } =
  await import("../../../src/v2/infrastructure/prisma/asset-rights-repository.ts");
const { setAssetRightsService } =
  await import("../../../src/v2/application/set-asset-rights.ts");
const {
  createCanonicalLocalizationService,
  createLocalizationProfileService,
  createLocalizationVariantService,
} = await import("../../../src/v2/application/localization-persistence.ts");

/**
 * Self-contained repository fixture. Source descriptors/transcript and upstream
 * alignment review are ARRANGED using real domain factories and PostgreSQL.
 * No file is rendered here and no provider is called. A browser/media E2E must
 * replace the descriptor with measured media, not call this an ingest proof.
 * Test-owned downstream runs/preflights must be deleted before cleanup().
 */
export async function createLocalizationPgFixture(
  prisma,
  { stage = "draft", sourceMedia = null, explicitNoLut = false } = {},
) {
  const suffix = randomUUID(),
    now = new Date();
  const workspaceId = `locale-pg-${suffix}`,
    projectId = `project-${suffix}`,
    baseVersionId = `version-${suffix}`;
  let versionId = baseVersionId;
  const clientId = `client-${suffix}`,
    artifactId = `video-${suffix}`,
    transcriptId = `transcript-${suffix}`,
    batchId = `batch-${suffix}`;
  const where = { workspaceId };
  const cleanup = async () => {
    await prisma.v2LocalizationVariantAction.deleteMany({ where });
    await prisma.v2LocalizationVariantRevision.deleteMany({ where });
    await prisma.v2LocalizationVariantHead.deleteMany({ where });
    await prisma.v2LocalizationCanonicalScript.deleteMany({ where });
    await prisma.v2LocalizationProfile.deleteMany({ where });
    await prisma.v2ScriptAlignmentReview.deleteMany({ where });
    await prisma.v2ScriptAlignmentRun.deleteMany({ where });
    await prisma.v2ProductionBatch.deleteMany({ where });
    await prisma.v2MediaTranscript.deleteMany({ where });
    await prisma.v2ProjectLutSelectionHead.deleteMany({ where });
    await prisma.v2CommandArtifactInvalidation.deleteMany({ where });
    await prisma.v2ProjectLutSelection.deleteMany({ where });
    await prisma.v2Project.updateMany({
      where,
      data: { currentVersionId: null },
    });
    await prisma.v2ProjectVersion.updateMany({
      where,
      data: { commandId: null },
    });
    await prisma.v2EditCommand.deleteMany({ where });
    await prisma.v2ProjectVersion.deleteMany({ where });
    await prisma.v2ProjectSnapshot.deleteMany({ where });
    await prisma.v2ProjectMediaAsset.deleteMany({ where });
    await prisma.v2Project.deleteMany({ where });
    await prisma.v2MediaArtifact.updateMany({
      where,
      data: { currentRightsSnapshotId: null },
    });
    await prisma.v2AssetRightsChange.deleteMany({ where });
    await prisma.v2AssetRightsSnapshot.deleteMany({ where });
    await prisma.v2MediaColorProbe.deleteMany({ where });
    await prisma.v2MediaArtifactManifest.deleteMany({ where });
    await prisma.v2MediaArtifact.deleteMany({ where });
    await prisma.v2ApiCredential.deleteMany({ where });
    await prisma.v2ApiClient.deleteMany({ where });
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } });
  };
  try {
    await createWorkspaceRow({
      prisma,
      workspaceId,
      name: "Localization repository proof",
      createdAt: now,
    });
    const issued = await issueApiClient({
      prisma,
      workspaceId,
      clientId,
      name: "Localization proof",
      createdAt: now,
      scopes: [
        "projects:read",
        "projects:write",
        "projects:approve",
        "localization:read",
        "localization:run",
      ],
    });
    const audit = createApiAccessAuditContext({
      workspaceId,
      clientId,
      credentialId: issued.credential.id,
      environment: "production",
      authenticationKind: "bearer",
    });
    const auditData = batchActorAuditData(audit, workspaceId, clientId);
    await createProjectRow({
      prisma,
      workspaceId,
      projectId,
      name: "Localization proof",
      objective: "awareness",
      format: "16:9",
      clientId,
      createdAt: now,
    });
    const descriptor = sourceMedia ?? {
      artifactKey: `fixtures/${suffix}.mp4`,
      sha256: "a".repeat(64),
      byteSize: 100,
      probe: { width: 320, height: 180, duration: 4, fps: 25 },
      originalFileName: "repository-descriptor.mp4",
    };
    const media = await registerRecording({
      prisma,
      workspaceId,
      projectId,
      artifactId,
      mediaType: "video",
      container: "mp4",
      role: "source-master",
      createdAt: now,
      recipeId: sourceMedia
        ? "measured-localization-fixture"
        : "controlled-repository-fixture",
      ...descriptor,
    });
    const rights = new PrismaAssetRightsRepository(prisma);
    const previousRights = await rights.findCurrent(workspaceId, artifactId);
    const rightsResult = await setAssetRightsService({
      repository: rights,
      clock: () => now,
      createId: () => `rights-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: previousRights.revision,
      actor: { type: "api-client", id: clientId },
      draft: {
        status: "approved",
        allowedUses: [
          "localization",
          "localization-subtitles-only",
          "subtitles-only",
          "translation",
          "project-render",
          "script-alignment",
          "editorial-reuse",
        ],
        prohibitedUses: [],
        consent: { status: "not-required", allowedUses: [] },
      },
    });
    const text = "Nina tem 10 exemplos.";
    const transcript = createMediaTranscript({
      language: "pt-BR",
      text,
      words: text
        .split(" ")
        .map((word, index) => ({
          word,
          start: index * 0.8,
          end: index * 0.8 + 0.6,
          confidence: 0.97,
        })),
      segments: [{ id: 1, start: 0, end: 3, text, confidence: 0.97 }],
      provider: "controlled-repository-fixture",
      model: "declared-not-provider-evidence",
    });
    await prisma.v2MediaTranscript.create({
      data: {
        id: transcriptId,
        workspaceId,
        projectId,
        sourceArtifactId: artifactId,
        sourceManifestId: media.manifestId,
        schemaVersion: transcript.schemaVersion,
        language: transcript.language,
        provider: transcript.provider,
        model: transcript.model,
        transcriptHash: transcript.transcriptHash,
        transcriptJson: stableSerialize(transcript),
        createdAt: now,
      },
    });
    await seedBaseProjectVersion({
      prisma,
      workspaceId,
      projectId,
      versionId: baseVersionId,
      clientId,
      objective: "awareness",
      sourceArtifactId: artifactId,
      fps: descriptor.probe.fps,
      durationFrames: Math.round(
        descriptor.probe.duration * descriptor.probe.fps,
      ),
      transcriptId,
      createdAt: now,
    });
    const brief = {
      schemaVersion: 1,
      productionBrief: createProductionBrief({
        ownerText:
          "Público: operadores. Oferta: vídeo localizado. Tom: direto.",
      }),
    };
    await prisma.v2ProjectSnapshot.update({
      where: { id: `${projectId}-snapshot-brief` },
      data: {
        contentJson: stableSerialize(brief),
        contentHash: calculateCanonicalHash(brief),
      },
    });
    if (explicitNoLut) {
      const baseVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({
        where: { id: baseVersionId },
      });
      const selected = await setProjectLutSelectionService({
        repository: new PrismaProjectLutSelectionRepository(prisma),
        clock: () => now,
        createId: (kind) => `${kind}-no-lut-${suffix}`,
        createEventId: randomUUID,
      })({
        workspaceId,
        projectId,
        baseVersionId,
        baseHash: baseVersion.baseHash,
        selection: { mode: "none" },
        actor: { type: "system", id: "localization-pg-fixture" },
        idempotencyKey: `no-lut-${suffix}`,
      });
      versionId = selected.version.id;
    }
    const batch = createProductionBatch({
      id: batchId,
      workspaceId,
      projectId,
      name: "Alignment fixture",
      objective: "content-distribution",
      sourceGroups: [
        { id: "source-group", name: "Source", sourceArtifactIds: [artifactId] },
      ],
      recipes: [
        { id: "recipe-body", name: "Body", sourceGroupIds: ["source-group"] },
      ],
      variants: [
        {
          id: "variant-base",
          name: "Base",
          outputSpecId: "16:9",
          locale: "pt-BR",
        },
      ],
      budget: {
        currency: "USD",
        maxCostMinorUnits: 100,
        reservedCostMinorUnits: 0,
      },
      itemDefinitions: [
        {
          id: `item-${suffix}`,
          key: "body/base",
          sourceGroupId: "source-group",
          recipeId: "recipe-body",
          variantId: "variant-base",
        },
      ],
      createdBy: { type: "api-client", id: clientId },
      createdAt: now.toISOString(),
    });
    await prisma.v2ProductionBatch.create({
      data: {
        id: batch.id,
        workspaceId,
        projectId,
        schemaVersion: batch.schemaVersion,
        policyVersion: batch.policyVersion,
        name: batch.name,
        objective: batch.objective,
        aggregateStatus: deriveBatchStatus(batch),
        revision: batch.revision,
        sourceGroupsJson: stableSerialize(batch.sourceGroups),
        recipesJson: stableSerialize(batch.recipes),
        variantsJson: stableSerialize(batch.variants),
        budgetJson: stableSerialize(batch.budget),
        maxCostMinorUnits: batch.budget.maxCostMinorUnits,
        reservedCostMinorUnits: 0,
        itemCount: batch.items.length,
        definitionHash: batch.definitionHash,
        requestFingerprint: calculateCanonicalHash(batch),
        idempotencyKey: `batch-${suffix}`,
        createdByClientId: clientId,
        ...auditData,
        createdAt: now,
        updatedAt: now,
      },
    });
    const initialAlignment = createScriptAlignmentRun({
      id: `alignment-${suffix}`,
      workspaceId,
      projectId,
      batchId,
      document: importScriptDocument({
        title: "Reviewed script",
        locale: "pt-BR",
        rawText: `CORPO 1: ${text}`,
      }),
      sources: [
        {
          transcriptId,
          sourceArtifactId: artifactId,
          transcriptHash: transcript.transcriptHash,
          language: transcript.language,
          transcript,
        },
      ],
      createdByClientId: clientId,
      createdAt: now.toISOString(),
    });
    const alignment = reviewScriptAlignmentRun({
      run: initialAlignment,
      expectedRevision: initialAlignment.revision,
      reviewId: `review-${suffix}`,
      actorClientId: clientId,
      decisions: [
        ...initialAlignment.alignments.map((block) => ({
          targetKind: "block",
          blockId: block.blockId,
          resolution: "accept",
          note: "Controlled upstream human review fixture",
        })),
        ...initialAlignment.extraTakes.map((extra) => ({
          targetKind: "extra-take",
          extraTakeId: extra.id,
          resolution: "reject-extra",
          note: "Outside selected canonical block",
        })),
      ],
      createdAt: now.toISOString(),
    });
    assert.equal(alignment.status, "reviewed");
    await new PrismaScriptAlignmentRepository(prisma).create({
      run: alignment,
      requestFingerprint: calculateCanonicalHash(alignment),
      idempotencyKey: `alignment-${suffix}`,
      authenticationAudit: audit,
    });
    const repository = new PrismaLocalizationRepository(prisma);
    const { canonical } = await createCanonicalLocalizationService({
      repository,
      clock: () => now,
    })({
      id: `canonical-${suffix}`,
      workspaceId,
      projectId,
      projectVersionId: versionId,
      alignmentId: alignment.id,
      expectedAlignmentHash: alignment.runHash,
      actorClientId: clientId,
      idempotencyKey: `canonical-${suffix}`,
      authenticationAudit: audit,
    });
    const { profile } = await createLocalizationProfileService({
      repository,
      clock: () => now,
    })({
      id: `profile-${suffix}`,
      workspaceId,
      targetLocale: "en-US",
      allowedModes: ["subtitles-only"],
      actorClientId: clientId,
      idempotencyKey: `profile-${suffix}`,
      authenticationAudit: audit,
    });
    let { variant } = await createLocalizationVariantService({
      repository,
      clock: () => now,
    })({
      id: `variant-${suffix}`,
      workspaceId,
      projectId,
      canonicalId: canonical.id,
      profileId: profile.id,
      sourceArtifactId: artifactId,
      expectedSourceSha256: descriptor.sha256,
      preferredMode: "subtitles-only",
      formats: ["16:9"],
      actorClientId: clientId,
      idempotencyKey: `variant-${suffix}`,
      authenticationAudit: audit,
    });
    if (stage === "audio") {
      for (const [status, patch] of [
        ["translating", { stage: "awaiting-human-translation-review" }],
        [
          "audio",
          {
            stage: "translation-reviewed",
            localizedBlocks: canonical.blocks.map((block) => ({
              blockId: block.id,
              text: "Nina has 10 examples.",
              protectedValues: {},
              reviewStatus: "human-approved",
            })),
          },
        ],
      ]) {
        const next = transitionLocalizationVariant(variant, status, {
          ...patch,
          updatedAt: now.toISOString(),
        });
        await repository.appendVariantRevision({
          previous: variant,
          next,
          action: status === "audio" ? "review" : "advance",
          requestFingerprint: calculateCanonicalHash(next),
          idempotencyKey: `fixture-${status}-${suffix}`,
          authenticationAudit: audit,
        });
        variant = next;
      }
    }
    return {
      suffix,
      now,
      workspaceId,
      projectId,
      versionId,
      clientId,
      artifactId,
      transcriptId,
      issued,
      audit,
      repository,
      canonical,
      profile,
      variant,
      alignment,
      rights: rightsResult,
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Localization fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}
