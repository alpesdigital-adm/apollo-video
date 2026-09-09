import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "../../generated/prisma-v2/index.js";
import {
  assertIsolatedDatabase,
  createWorkspaceRow,
  issueApiClient,
  createProjectRow,
  seedBaseProjectVersion,
} from "./helpers/capture-journey.mjs";

const {
  PrismaMusicAnalysisRepository,
  PrismaMusicMontagePlanningAuthority,
  PrismaMusicMontageRunRepository,
} =
  await import("../../src/v2/infrastructure/prisma/music-led-montage-repository.ts");
const { PrismaAssetRightsRepository } =
  await import("../../src/v2/infrastructure/prisma/asset-rights-repository.ts");
const { setAssetRightsService } =
  await import("../../src/v2/application/set-asset-rights.ts");
const { createMusicAnalysis } =
  await import("../../src/v2/domain/music-led-montage.ts");
const { compileMusicLedMontageService } =
  await import("../../src/v2/application/compile-music-led-montage.ts");
const { createApiAccessAuditContext } =
  await import("../../src/v2/domain/api-access-control.ts");

// Repository integration, not an ingest/render E2E. Artifact descriptors and
// measured-analysis output are arranged here; real PCM/MP4 tests are separate.
test(
  "music montage PostgreSQL: atomic publication, actor-bound replay, rights and stale fences",
  {
    skip: process.env.APOLLO_RUN_MUSIC_MONTAGE_PG_E2E !== "1",
    timeout: 60_000,
  },
  async () => {
    assertIsolatedDatabase();
    const prisma = new PrismaClient();
    const suffix = randomUUID(),
      workspaceId = `music-pg-${suffix}`,
      clientId = `client-${suffix}`;
    const projectId = `project-${suffix}`,
      versionId = `version-${suffix}`;
    const musicId = `music-${suffix}`,
      videoId = `video-${suffix}`,
      now = new Date();
    const where = { workspaceId };
    let testFailure;
    try {
      await createWorkspaceRow({
        prisma,
        workspaceId,
        name: "Music repository proof",
        createdAt: now,
      });
      await issueApiClient({
        prisma,
        workspaceId,
        clientId,
        name: "Music proof",
        createdAt: now,
        scopes: ["projects:read", "projects:write"],
      });
      await createProjectRow({
        prisma,
        workspaceId,
        projectId,
        name: "Music proof",
        objective: "awareness",
        format: "16:9",
        clientId,
        createdAt: now,
      });
      for (const [id, mediaType, container] of [
        [musicId, "audio", "wav"],
        [videoId, "video", "mp4"],
      ]) {
        await prisma.v2MediaArtifact.create({
          data: {
            id,
            workspaceId,
            artifactKey: `${id}.${container}`,
            mediaType,
            container,
            sha256: "a".repeat(64),
            byteSize: 100n,
            status: "available",
            createdAt: now,
          },
        });
        await prisma.v2ProjectMediaAsset.create({
          data: {
            id: randomUUID(),
            workspaceId,
            projectId,
            artifactId: id,
            role: mediaType === "video" ? "source-master" : "source-audio",
            originalFileName: `${id}.${container}`,
            createdAt: now,
          },
        });
      }
      await seedBaseProjectVersion({
        prisma,
        workspaceId,
        projectId,
        versionId,
        clientId,
        objective: "awareness",
        sourceArtifactId: videoId,
        fps: 25,
        durationFrames: 200,
        transcriptId: `transcript-${suffix}`,
        createdAt: now,
      });
      const rightsRepository = new PrismaAssetRightsRepository(prisma);
      const setRights = setAssetRightsService({
        repository: rightsRepository,
        clock: () => now,
        createId: () => `rights-${randomUUID()}`,
      });
      const initialRights = await rightsRepository.findCurrent(
        workspaceId,
        musicId,
      );
      const granted = await setRights({
        workspaceId,
        artifactId: musicId,
        baseRevision: initialRights.revision,
        actor: { type: "api-client", id: clientId },
        draft: {
          status: "approved",
          allowedUses: ["music-led-montage"],
          prohibitedUses: [],
          consent: { status: "not-required", allowedUses: [] },
        },
      });
      const analyses = new PrismaMusicAnalysisRepository(prisma);
      const analysis = createMusicAnalysis({
        id: `analysis-${suffix}`,
        sourceArtifactId: musicId,
        sourceSha256: "a".repeat(64),
        sourceByteSize: 100,
        analyzer: {
          id: "test-measurement",
          version: "1.0.0",
          sampleRate: 22050,
          windowSize: 1024,
          hopSize: 512,
        },
        durationMs: 4000,
        tempo: { bpm: 120, confidence: 0.9 },
        beats: [{ atMs: 2000, strength: 0.9, confidence: 0.9, kind: "beat" }],
        sections: [
          {
            id: "section",
            rangeMs: [0, 4000],
            energy: 0.7,
            confidence: 0.4,
            role: "unknown",
          },
        ],
        energyCurve: [{ atMs: 0, value: 0.5 }],
        confidence: 0.9,
        limitations: ["controlled-analysis-repository-test"],
      });
      await analyses.save({
        workspaceId,
        projectVersionId: versionId,
        rightsSnapshotId: granted.snapshot.id,
        analysis,
      });
      const runs = new PrismaMusicMontageRunRepository(prisma);
      const compile = compileMusicLedMontageService({
        runs,
        authority: new PrismaMusicMontagePlanningAuthority(prisma),
        clock: () => now,
      });
      const authenticationAudit = createApiAccessAuditContext({
        clientId,
        credentialId: `credential-${suffix}`,
        workspaceId,
        environment: "production",
        authenticationKind: "bearer",
      });
      const request = {
        workspaceId,
        projectId,
        projectVersionId: versionId,
        runId: `run-${suffix}`,
        planId: `plan-${suffix}`,
        analysisId: analysis.id,
        fps: 25,
        objective: "awareness",
        locale: "pt-BR",
        sources: [{ id: videoId, artifactId: videoId, durationSeconds: 8 }],
        visualSegments: [
          {
            id: "clip-a",
            sourceId: videoId,
            sourceArtifactId: videoId,
            sourceRangeMs: [0, 2100],
            preferredDurationMs: 1920,
          },
          {
            id: "clip-b",
            sourceId: videoId,
            sourceArtifactId: videoId,
            sourceRangeMs: [3000, 6100],
            preferredDurationMs: 2080,
          },
        ],
        actorClientId: clientId,
        authenticationAudit,
        idempotencyKey: `request-${suffix}`,
      };
      const first = await compile(request);
      assert.equal(first.replayed, false);
      assert.equal(first.run.editPlan.durationFrames, 100);
      assert.equal(await prisma.v2MusicMontageRun.count({ where }), 1);
      assert.equal(await prisma.v2RenderablePlanSnapshot.count({ where }), 1);
      assert.equal(
        (await runs.findById(workspaceId, projectId, first.run.id)).runHash,
        first.run.runHash,
      );
      assert.equal(
        await runs.findById("another-workspace", projectId, first.run.id),
        null,
      );
      assert.equal(
        await runs.findById(workspaceId, "another-project", first.run.id),
        null,
      );
      await assert.rejects(
        compile({ ...request, locale: "en-US" }),
        (error) => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      await assert.rejects(
        compile({
          ...request,
          authenticationAudit: createApiAccessAuditContext({
            clientId,
            credentialId: `different-${suffix}`,
            workspaceId,
            environment: "production",
            authenticationKind: "bearer",
          }),
        }),
        (error) => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      await prisma.v2Project.update({
        where: { id: projectId },
        data: { currentVersionId: null },
      });
      assert.equal(
        (await compile({ ...request, runId: "ignored-new-server-id" }))
          .replayed,
        true,
      );
      await assert.rejects(
        compile({ ...request, idempotencyKey: "stale-new-request" }),
      );
      await prisma.v2Project.update({
        where: { id: projectId },
        data: { currentVersionId: versionId },
      });
      const authority = new PrismaMusicMontagePlanningAuthority(prisma);
      const racingCompile = compileMusicLedMontageService({
        runs,
        clock: () => now,
        authority: {
          async resolveCurrent(input) {
            const resolved = await authority.resolveCurrent(input);
            await prisma.v2Project.update({
              where: { id: projectId },
              data: { currentVersionId: null },
            });
            return resolved;
          },
        },
      });
      await assert.rejects(
        racingCompile({
          ...request,
          runId: `race-${suffix}`,
          idempotencyKey: "changed-after-read",
        }),
        (error) => error.code === "VERSION_CONFLICT",
      );
      assert.equal(
        await prisma.v2RenderablePlanSnapshot.count({ where }),
        1,
        "a stale publication must not leave a renderable snapshot behind",
      );
      await prisma.v2Project.update({
        where: { id: projectId },
        data: { currentVersionId: versionId },
      });
      await setRights({
        workspaceId,
        artifactId: musicId,
        baseRevision: granted.revision,
        actor: { type: "api-client", id: clientId },
        draft: {
          status: "revoked",
          allowedUses: [],
          prohibitedUses: ["music-led-montage"],
          consent: { status: "not-required", allowedUses: [] },
        },
      });
      await assert.rejects(
        compile({
          ...request,
          runId: `denied-${suffix}`,
          idempotencyKey: "revoked-new-request",
        }),
        (error) => error.code === "ASSET_RIGHTS_BLOCKED",
      );
      assert.equal(await prisma.v2MusicMontageRun.count({ where }), 1);
      assert.equal(await prisma.v2RenderablePlanSnapshot.count({ where }), 1);
      const stored = await prisma.v2MusicMontageRun.findUnique({
        where: { id: first.run.id },
      });
      await prisma.v2MusicMontageRun.update({
        where: { id: first.run.id },
        data: { runJson: JSON.stringify({ ...first.run, locale: "tampered" }) },
      });
      await assert.rejects(
        runs.findById(workspaceId, projectId, first.run.id),
        (error) => error.code === "PERSISTENCE_CONFLICT",
      );
      await prisma.v2MusicMontageRun.update({
        where: { id: first.run.id },
        data: { runJson: stored.runJson },
      });
    } catch (error) {
      testFailure = error;
      throw error;
    } finally {
      try {
        await prisma.v2MusicMontageRun.deleteMany({ where });
        await prisma.v2RenderablePlanSnapshot.deleteMany({ where });
        await prisma.v2MusicAnalysisAuthorization.deleteMany({ where });
        await prisma.v2MusicAnalysis.deleteMany({ where });
        await prisma.v2Project.updateMany({
          where,
          data: { currentVersionId: null },
        });
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
        await prisma.v2MediaArtifact.deleteMany({ where });
        await prisma.v2ApiCredential.deleteMany({ where });
        await prisma.v2ApiClient.deleteMany({ where });
        await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } });
      } catch (cleanupError) {
        if (testFailure)
          throw new AggregateError(
            [testFailure, cleanupError],
            "Music PostgreSQL proof and cleanup both failed",
          );
        throw cleanupError;
      } finally {
        await prisma.$disconnect();
      }
    }
  },
);
