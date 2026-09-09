import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ffmpegStatic from "ffmpeg-static";
import { NextRequest } from "next/server";
import { PrismaClient } from "../../generated/prisma-v2/index.js";
const exec = promisify(execFile);

test(
  "music analysis authenticated handlers + worker process, replay, audit and rights rotation",
  {
    skip: process.env.APOLLO_RUN_MUSIC_ANALYSIS_PG_E2E !== "1",
    timeout: 90_000,
  },
  async () => {
    const h = await import("./helpers/capture-journey.mjs"),
      { PrismaAssetRightsRepository } =
        await import("../../src/v2/infrastructure/prisma/asset-rights-repository.ts"),
      { setAssetRightsService } =
        await import("../../src/v2/application/set-asset-rights.ts");
    h.assertIsolatedDatabase();
    process.env.APOLLO_API_ENVIRONMENT = "production";
    const prisma = new PrismaClient(),
      suffix = randomUUID(),
      root = await mkdtemp(join(tmpdir(), "apollo-music-analysis-")),
      workspaceId = `music-${suffix}`,
      clientId = `client-${suffix}`,
      projectId = `project-${suffix}`,
      versionId = `version-${suffix}`,
      artifactId = `audio-${suffix}`,
      videoId = `video-${suffix}`,
      now = new Date();
    process.env.APOLLO_V2_ARTIFACT_ROOT = root;
    process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = "local";
    let testFailure;
    try {
      const artifactKey = "audio/beat.wav",
        path = join(root, artifactKey);
      await mkdir(join(root, "audio"), { recursive: true });
      await exec(
        ffmpegStatic ?? "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=3",
          "-ar",
          "44100",
          "-ac",
          "1",
          path,
        ],
        { timeout: 20_000, windowsHide: true },
      );
      const bytes = await readFile(path),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      await h.createWorkspaceRow({
        prisma,
        workspaceId,
        name: "Music proof",
        createdAt: now,
      });
      const issued = await h.issueApiClient({
        prisma,
        workspaceId,
        clientId,
        name: "Music proof",
        createdAt: now,
        scopes: ["projects:read", "projects:write"],
      });
      await h.createProjectRow({
        prisma,
        workspaceId,
        projectId,
        name: "Music proof",
        objective: "awareness",
        format: "16:9",
        clientId,
        createdAt: now,
      });
      await prisma.v2MediaArtifact.createMany({
        data: [
          {
            id: artifactId,
            workspaceId,
            artifactKey,
            mediaType: "audio",
            container: "wav",
            sha256,
            byteSize: bytes.length,
            status: "available",
            createdAt: now,
          },
          {
            id: videoId,
            workspaceId,
            artifactKey: "video/base.mp4",
            mediaType: "video",
            container: "mp4",
            sha256: "b".repeat(64),
            byteSize: 100,
            status: "available",
            createdAt: now,
          },
        ],
      });
      await prisma.v2ProjectMediaAsset.createMany({
        data: [
          {
            id: randomUUID(),
            workspaceId,
            projectId,
            artifactId,
            role: "source-audio",
            originalFileName: "beat.wav",
            createdAt: now,
          },
          {
            id: randomUUID(),
            workspaceId,
            projectId,
            artifactId: videoId,
            role: "source-master",
            originalFileName: "base.mp4",
            createdAt: now,
          },
        ],
      });
      await h.seedBaseProjectVersion({
        prisma,
        workspaceId,
        projectId,
        versionId,
        clientId,
        objective: "awareness",
        sourceArtifactId: videoId,
        fps: 25,
        durationFrames: 75,
        transcriptId: `transcript-${suffix}`,
        createdAt: now,
      });
      const rightsRepo = new PrismaAssetRightsRepository(prisma),
        rotate = async (status, sourceNote) => {
          const current = await rightsRepo.findCurrent(workspaceId, artifactId);
          return setAssetRightsService({
            repository: rightsRepo,
            clock: () => new Date(),
            createId: () => `rights-${randomUUID()}`,
          })({
            workspaceId,
            artifactId,
            baseRevision: current.revision,
            actor: { type: "api-client", id: clientId },
            draft: {
              status,
              allowedUses: status === "approved" ? ["music-led-montage"] : [],
              prohibitedUses: [],
              consent: { status: "not-required", allowedUses: [] },
              sourceNote,
            },
          });
        };
      const initialGrant = await rotate("approved", "initial-analysis-grant");
      const [
        { POST: create },
        { GET: get },
        { POST: cancel },
        { POST: retry },
      ] = await Promise.all([
        import("../../src/app/v1/projects/[projectId]/music-analyses/route.ts"),
        import("../../src/app/v1/projects/[projectId]/music-analyses/[runId]/route.ts"),
        import("../../src/app/v1/projects/[projectId]/music-analyses/[runId]/cancel/route.ts"),
        import("../../src/app/v1/projects/[projectId]/music-analyses/[runId]/retry/route.ts"),
      ]);
      const authorization = `Bearer ${issued.token}`,
        base = `https://apollo.test/v1/projects/${projectId}/music-analyses`,
        post = async (key) => {
          const response = await create(
            new NextRequest(base, {
              method: "POST",
              headers: {
                authorization,
                origin: "https://apollo.test",
                "content-type": "application/json",
                "idempotency-key": key,
              },
              body: JSON.stringify({ projectVersionId: versionId, artifactId }),
            }),
            { params: Promise.resolve({ projectId }) },
          );
          return { response, body: await response.json() };
        },
        read = async (id) => {
          const response = await get(
            new NextRequest(`${base}/${id}`, { headers: { authorization } }),
            { params: Promise.resolve({ projectId, runId: id }) },
          );
          return { response, body: await response.json() };
        },
        mutate = async (handler, id, action) => {
          const response = await handler(
            new NextRequest(`${base}/${id}/${action}`, {
              method: "POST",
              headers: { authorization, origin: "https://apollo.test" },
            }),
            { params: Promise.resolve({ projectId, runId: id }) },
          );
          return { response, body: await response.json() };
        },
        worker = () =>
          exec(
            process.execPath,
            [
              "--import",
              "tsx",
              "scripts/run-v2-music-analysis-worker.mjs",
              "--once",
            ],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                APOLLO_V2_ARTIFACT_ROOT: root,
                APOLLO_V2_ARTIFACT_STORAGE_DRIVER: "local",
              },
              timeout: 45_000,
              windowsHide: true,
            },
          );
      const first = await post(`first-${suffix}`);
      assert.equal(first.response.status, 202);
      await worker();
      const completed = await read(first.body.data.run.id);
      assert.equal(completed.body.data.run.status, "completed");
      const replay = await post(`first-${suffix}`);
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.data.run.id, first.body.data.run.id);
      const rotated = await rotate("approved", "equivalent-rotated-grant"),
        second = await post(`second-${suffix}`);
      assert.notEqual(rotated.snapshot.id, initialGrant.snapshot.id);
      assert.equal(second.response.status, 202);
      await worker();
      const cached = await read(second.body.data.run.id);
      assert.equal(
        cached.body.data.run.analysisId,
        completed.body.data.run.analysisId,
      );
      assert.equal(
        await prisma.v2MusicAnalysis.count({ where: { workspaceId } }),
        1,
      );
      assert.ok(
        await prisma.v2MusicAnalysisAuthorization.findFirst({
          where: {
            workspaceId,
            analysisId: cached.body.data.run.analysisId,
            rightsSnapshotId: rotated.snapshot.id,
          },
        }),
      );
      const controlGrant = await rotate("approved", "control-run-grant");
      assert.notEqual(controlGrant.snapshot.id, rotated.snapshot.id);
      const control = await post(`control-${suffix}`),
        controlId = control.body.data.run.id;
      const revoked = await rotate("revoked", "controlled-revocation");
      assert.notEqual(revoked.snapshot.id, controlGrant.snapshot.id);
      await worker();
      assert.equal((await read(controlId)).body.data.run.status, "failed");
      const restored = await rotate("approved", "retry-restored-grant");
      assert.notEqual(restored.snapshot.id, revoked.snapshot.id);
      assert.equal(
        (await mutate(retry, controlId, "retry")).body.data.run.status,
        "queued",
      );
      assert.equal(
        (await mutate(retry, controlId, "retry")).body.data.run.status,
        "queued",
      );
      const canceled = await mutate(cancel, controlId, "cancel");
      assert.equal(canceled.body.data.run.status, "canceled");
      assert.equal(
        (await mutate(cancel, controlId, "cancel")).body.data.run.status,
        "canceled",
      );
      const actions = await prisma.v2MusicAnalysisRunAction.findMany({
        where: { workspaceId, runId: controlId },
      });
      assert.deepEqual(actions.map((x) => x.action).sort(), [
        "cancel",
        "retry",
      ]);
      assert.ok(
        actions.every(
          (x) =>
            x.actorClientId === clientId && x.actorContextHash.length === 64,
        ),
      );
    } catch (error) {
      testFailure = error;
      throw error;
    } finally {
      try {
        const { disconnectV2PostgresClient } =
          await import("../../src/v2/infrastructure/prisma-postgres/client.ts");
        await disconnectV2PostgresClient();
        const where = { workspaceId };
        await prisma.v2MusicAnalysisRunAction.deleteMany({ where });
        await prisma.v2MusicAnalysisRun.deleteMany({ where });
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
            "Music analysis E2E and cleanup both failed",
          );
        throw cleanupError;
      } finally {
        await prisma.$disconnect();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
