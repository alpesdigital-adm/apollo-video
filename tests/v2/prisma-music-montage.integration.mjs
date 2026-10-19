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
import { registerPlayableVideo } from "./helpers/misc-pg-sources.mjs";
import { commitSealedChild, testActor } from "./helpers/pg-output-world.mjs";

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
      // The music is an available audio artifact the analysis reads; the base video is a real observed recording (its ingest
      // receipt and approved rights), because a sealed Version only plays sources an ingest persisted.
      await prisma.v2MediaArtifact.create({
        data: {
          id: musicId,
          workspaceId,
          artifactKey: `${musicId}.wav`,
          mediaType: "audio",
          container: "wav",
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
          artifactId: musicId,
          role: "source-audio",
          originalFileName: `${musicId}.wav`,
          createdAt: now,
        },
      });
      await registerPlayableVideo(prisma, {
        workspaceId,
        projectId,
        clientId,
        artifactId: videoId,
        sha256: "a".repeat(64),
        byteSize: 100,
        probe: { width: 320, height: 180, duration: 8, fps: 25 },
        createdAt: now,
      });
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
      // A sealed project always has a head, so "the head moved" is a real move: to a sibling Version committed on the head the first
      // publication left (stored, head left where it was), and back to the base the run was authorized on.
      const moveHead = (currentVersionId) =>
        prisma.v2Project.update({ where: { id: projectId }, data: { currentVersionId } });
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
      // The renderable plan is born with its Version: the child of the head the run was authorized on, which became the head, and
      // whose sealed State binds the very row the publication stored.
      const published = await prisma.v2RenderablePlanSnapshot.findFirstOrThrow({ where });
      const publishedVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: published.projectVersionId } });
      assert.equal(publishedVersion.parentVersionId, versionId);
      assert.equal(first.run.projectVersionId, versionId, "the run records the base it was authorized on");
      assert.equal(first.run.editPlan.projectVersionId, publishedVersion.id, "the plan names the Version it was born with");
      assert.equal((await prisma.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId, publishedVersion.id);
      const publishedState = await prisma.v2ProjectOutputState.findUniqueOrThrow({ where: { id: publishedVersion.outputStateId } });
      assert.deepEqual([publishedState.renderablePlanSnapshotId, publishedState.renderablePlanHash], [published.id, published.planHash]);
      const sibling = await commitSealedChild(prisma, {
        workspaceId,
        projectId,
        actor: testActor({ workspaceId, clientId, credentialId: `${clientId}-seed`, environment: "production" }),
        suffix: `${suffix}-moved-head`,
        moveHead: false,
      });
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
      await moveHead(sibling.version.id);
      assert.equal(
        (await compile({ ...request, runId: "ignored-new-server-id" }))
          .replayed,
        true,
      );
      await assert.rejects(
        compile({ ...request, idempotencyKey: "stale-new-request" }),
      );
      await moveHead(versionId);
      const authority = new PrismaMusicMontagePlanningAuthority(prisma);
      const racingCompile = compileMusicLedMontageService({
        runs,
        clock: () => now,
        authority: {
          async resolveCurrent(input) {
            const resolved = await authority.resolveCurrent(input);
            await moveHead(sibling.version.id);
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
      await moveHead(versionId);
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
    } finally {
      await prisma.$disconnect();
    }
  },
);
