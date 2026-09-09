import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/prisma-v2/index.js";
import { assertIsolatedDatabase } from './helpers/capture-journey.mjs';
import { createLocalizationPgFixture } from './helpers/localization-pg.mjs';
const { PrismaLocalizationMediaRunRepository } = await import("../../src/v2/infrastructure/prisma/localization-media-run-repository.ts");
const {
  createLocalizationMediaRun,
  recordLocalizationMediaEvidence,
  approveLocalizationMediaRun,
} = await import("../../src/v2/domain/localization-media-run.ts");

const enabled = process.env.APOLLO_RUN_LOCALIZATION_MEDIA_PG_E2E === "1";
test(
  "T-FR-190..195 PostgreSQL fences media intent and refuses fabricated final-render evidence",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    assertIsolatedDatabase();
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.V2_DATABASE_URL } },
    });
    const createdIds = [];
    let fixture, testFailure;
    try {
      fixture = await createLocalizationPgFixture(prisma, { stage: 'audio' });
      const head = await prisma.v2LocalizationVariantHead.findUniqueOrThrow({
        where: { id: fixture.variant.id },
        include: {
          sourceArtifact: true,
          sourceRightsSnapshot: true,
          createdBy: true,
          revisions: { orderBy: { revision: "desc" }, take: 1 },
        },
      });
      const revision = head.revisions[0];
      const variant = JSON.parse(revision.variantJson);
      const repository = new PrismaLocalizationMediaRunRepository(prisma);
      const suffix = randomUUID(),
        now = new Date().toISOString();
      const run = createLocalizationMediaRun({
        id: `localization-media-e2e-${suffix}`,
        workspaceId: head.workspaceId,
        projectId: head.projectId,
        variantId: head.id,
        variantRevision: head.currentRevision,
        variantHash: head.currentVariantHash,
        canonicalContentHash: variant.canonicalContentHash,
        source: {
          kind: "original-audio",
          artifactId: head.sourceArtifactId,
          artifactSha256: head.sourceArtifact.sha256,
          rightsSnapshotId: head.sourceRightsSnapshotId,
        },
        requestedByClientId: head.createdByClientId,
        at: now,
      });
      createdIds.push(run.id);
      const audit = fixture.audit;
      const first = await repository.create({
        run,
        requestFingerprint: "b".repeat(64),
        idempotencyKey: `media-e2e-${suffix}`,
        authenticationAudit: audit,
      });
      assert.equal(first.replayed, false);
      const duplicate = createLocalizationMediaRun({
        ...run,
        id: `localization-media-e2e-duplicate-${suffix}`,
        at: now,
      });
      await assert.rejects(
        () =>
          repository.create({
            run: duplicate,
            requestFingerprint: "c".repeat(64),
            idempotencyKey: `media-e2e-duplicate-${suffix}`,
            authenticationAudit: audit,
          }),
        /active media intent/,
      );
      const claimed = await repository.claim({
        workerId: `worker-${suffix}`,
        leaseTokenHash: "d".repeat(64),
        now: new Date(Date.now() + 1).toISOString(),
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      assert.equal(claimed.id, run.id);
      const words = [
        {
          word: variant.localizedBlocks[0].text.split(/\s+/)[0],
          startMs: 0,
          endMs: 500,
          confidence: 1,
        },
      ];
      const evidence = {
        audioArtifactId: head.sourceArtifactId,
        audioSha256: head.sourceArtifact.sha256,
        durationMs: 500,
        alignmentArtifactId: `alignment-e2e-${suffix}`,
        alignmentSha256: "e".repeat(64),
        words,
        blockDurations: [
          { blockId: variant.localizedBlocks[0].blockId, durationMs: 500 },
        ],
        durationDeviation: {
          totalRatio: 1,
          threshold: 0.15,
          thresholdExceeded: false,
          byBlock: [
            {
              blockId: variant.localizedBlocks[0].blockId,
              ratio: 1,
              requiresReflow: false,
            },
          ],
        },
        renderablePlans: [
          {
            format: variant.formats[0],
            snapshotId: `snapshot-e2e-${suffix}`,
            planHash: "f".repeat(64),
            proxyOperationId: `operation-e2e-${suffix}`,
            proxyArtifactId: head.sourceArtifactId,
          },
        ],
        lineageHash: "9".repeat(64),
      };
      const awaiting = recordLocalizationMediaEvidence(
        claimed,
        evidence,
        new Date(Date.now() + 2).toISOString(),
      );
      await repository.settle({
        previousRunHash: claimed.runHash,
        run: awaiting,
        leaseTokenHash: "d".repeat(64),
        settledAt: awaiting.updatedAt,
      });
      const approved = approveLocalizationMediaRun(awaiting, {
        clientId: head.createdByClientId,
        at: new Date(Date.now() + 3).toISOString(),
      });
      // An available SOURCE artifact plus invented snapshot/operation IDs is
      // not rendered output. This must never approve the variant.
      await assert.rejects(repository.approve({
        previousRunHash: awaiting.runHash,
        run: approved,
        authenticationAudit: audit,
        idempotencyKey: `media-approval-${suffix}`,
        requestFingerprint: "8".repeat(64),
      }), (error) => error.code === 'PRECONDITION_REQUIRED');
      assert.equal(
        (
          await repository.read({
            workspaceId: head.workspaceId,
            projectId: head.projectId,
            runId: run.id,
          })
        ).status,
        "awaiting-human-approval",
      );
      assert.equal(
        (
          await prisma.v2LocalizationVariantHead.findUniqueOrThrow({
            where: { id: head.id },
          })
        ).status,
        "audio",
      );
    } catch (error) {
      testFailure = error;
      throw error;
    } finally {
      try {
      for (const id of createdIds) {
        await prisma.v2LocalizationMediaRunRevision.deleteMany({
          where: { runId: id },
        });
        await prisma.v2LocalizationMediaRun.deleteMany({ where: { id } });
      }
      if (fixture) await fixture.cleanup();
      } catch (cleanupError) {
        if (testFailure) throw new AggregateError([testFailure, cleanupError], 'Localization media proof and cleanup both failed');
        throw cleanupError;
      } finally { await prisma.$disconnect(); }
    }
  },
);
