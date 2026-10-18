import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * T-FR-165 PostgreSQL evidence for F1.032.
 *
 * Proves, against the real V2 schema, that the format critic verdict is stored per output:
 * two proxy reviews share one immutable project version, each carries its own `outputSpecId`,
 * its own content-addressed format verdict and its own `finalAllowed` gate, and the final
 * export approval reader only ever returns the variant it was asked for.
 *
 * Skip-gated because the host running the unit suite has no local PostgreSQL: run it with
 * `APOLLO_FORMAT_QUALITY_E2E=1` and `V2_DATABASE_URL` pointing at an isolated V2 database
 * (never a shared or remote one).
 */
test('T-FR-165 persists one independent format verdict per output and blocks only the affected variant', {
  skip: process.env.APOLLO_FORMAT_QUALITY_E2E !== '1' && 'set APOLLO_FORMAT_QUALITY_E2E=1 and use an isolated V2 database',
  timeout: 180_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')

  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { evaluateRenderedProxy } = await import('../../src/v2/application/render-workflow.ts')
  const { critiqueOutputFormat, selectExportableVariants } = await import('../../src/v2/domain/format-quality-critic.ts')
  const { readOutputFormatPreset } = await import('../../src/v2/domain/output-format-registry.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaProxyReviewRepository } = await import('../../src/v2/infrastructure/prisma/proxy-review-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { seedSealedProject, testActor } = await import('./helpers/pg-output-world.mjs')

  const client = new PrismaClient()
  const repository = new PrismaProxyReviewRepository(client)
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `format-quality-workspace-${suffix}`
  const foreignWorkspaceId = `format-quality-foreign-${suffix}`
  const projectId = `format-quality-project-${suffix}`
  const createdAt = new Date('2026-08-13T17:00:00.000Z')
  const renderCompletedAt = new Date(createdAt.getTime() + 61_000)

  // The project, its sealed Versions and the reviews are append-only: every identity is unique to this run and nothing is
  // cleaned up (the owner of the disposable schema resets it).
  try {
    for (const scope of [workspaceId, foreignWorkspaceId]) {
      await client.v2Workspace.create({ data: { id: scope, slug: scope, name: 'Format quality E2E', status: 'active', createdAt, updatedAt: createdAt } })
    }
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `format-quality-client-${suffix}`,
      workspaceId,
      name: 'Format quality E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write', 'projects:approve'],
    })
    // The project is the sealed world the product builds (creation Command, then one explicit output variant as the head
    // Version); the proxy reviews below hang off that one immutable Version. The status the review transitions start from is
    // the one the project had when the proxies were rendered.
    const actor = testActor({ workspaceId, clientId: issued.client.id, credentialId: issued.credential.id, environment: 'production',
      scopes: ['projects:read', 'projects:write', 'projects:approve'] })
    const world = await seedSealedProject(client, { workspaceId, actor, prefix: 'format-quality', ids: { project: projectId }, name: 'Format quality E2E' })
    const projectVersionId = world.head.version.id
    const editPlanSnapshotId = world.head.editPlanSnapshot.id
    const editPlan = JSON.parse(world.head.editPlanSnapshot.contentJson)
    await client.v2Project.update({ where: { id: projectId }, data: { status: 'reviewing-proxy' } })
    const variants = [
      // The approved landscape is persisted first so the project can then move to `revising`.
      { key: 'landscape', format: '16:9', width: 960, height: 540, presenter: { x: 90, y: 30, width: 780, height: 450 }, subtitle: { x: 100, y: 410, width: 760, height: 80 }, subject: { x: .35, y: .15, width: .3, height: .35 } },
      { key: 'vertical', format: '9:16', width: 540, height: 960, presenter: { x: 80, y: 100, width: 380, height: 760 }, subtitle: { x: 45, y: 700, width: 450, height: 170 }, subject: { x: .25, y: .55, width: .5, height: .3 } },
    ].map((variant) => ({
      ...variant,
      outputSpecId: readOutputFormatPreset(variant.format).spec.id,
      outputPresetHash: readOutputFormatPreset(variant.format).presetHash,
      artifactId: `format-quality-artifact-${variant.key}-${suffix}`,
      manifestId: `format-quality-manifest-${variant.key}-${suffix}`,
      operationId: `format-quality-operation-${variant.key}-${suffix}`,
      reviewId: `format-quality-review-${variant.key}-${suffix}`,
      inputHash: calculateVersionHash({ projectVersionId, variant: variant.key }),
      proxySha256: calculateVersionHash({ artifact: variant.key, suffix }),
    }))

    const persisted = []
    const reports = []
    for (const [variantIndex, variant] of variants.entries()) {
      const operationCreatedAt = new Date(createdAt.getTime() + variantIndex)
      const lease = { owner: `format-quality-worker-${suffix}`, attempt: 1, now: renderCompletedAt.toISOString() }
      await client.v2MediaArtifact.create({
        data: {
          id: variant.artifactId, workspaceId, artifactKey: `format-quality/${variant.artifactId}.mp4`, sha256: variant.proxySha256,
          byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', createdAt,
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: variant.manifestId, workspaceId, artifactId: variant.artifactId, schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: calculateVersionHash({ manifestId: variant.manifestId }), recipeId: 'format-quality', recipeVersion: '1.0.0',
          parametersHash: calculateVersionHash({ manifestId: variant.manifestId, parameters: true }),
          manifestJson: stableSerialize({ artifact: { artifactKey: `format-quality/${variant.artifactId}.mp4` }, probe: { width: variant.width, height: variant.height, duration: 2, fps: 30, codec: 'h264', container: 'mp4' } }),
          createdAt,
        },
      })
      await client.v2PublicOperation.create({
        data: {
          id: variant.operationId, workspaceId, projectId, clientId: issued.client.id, type: 'project-proxy-render',
          status: 'running', phase: 'persisting', targetType: 'media-artifact', targetId: variant.artifactId,
          cancelable: true, retryable: false, attempt: 1, maxAttempts: 3,
          progressCompleted: 3, progressTotal: 4, progressUnit: 'render',
          leaseOwner: lease.owner, leaseExpiresAt: new Date(renderCompletedAt.getTime() + 60_000), heartbeatAt: renderCompletedAt,
          idempotencyKey: `format-quality-render-${variant.key}-${suffix}`, requestFingerprint: variant.inputHash,
          createdAt: operationCreatedAt, updatedAt: operationCreatedAt, startedAt: operationCreatedAt,
        },
      })
      await client.v2ProjectProxyRenderOperation.create({
        data: {
          operationId: variant.operationId, workspaceId, projectId, projectVersionId, editPlanSnapshotId,
          sourceArtifactId: variant.artifactId, sourceManifestId: variant.manifestId, colorPipelineBindingsJson: stableSerialize([]),
          inputHash: variant.inputHash, outputArtifactId: variant.artifactId, outputManifestId: variant.manifestId,
          originalFileName: `format-quality-${variant.key}.mp4`, createdAt,
        },
      })
      const element = (elementId, type, bounds) => ({
        elementId, type, clipId: `clip-${variant.key}`, sceneId: `scene-${variant.key}`, sourceId: `source-${variant.key}`,
        frame: 30, bounds, zIndex: type === 'subtitle' ? 10 : 1, opacity: 1, priority: 1,
      })
      const map = {
        schemaVersion: 'render-element-map/v1', proxyHash: variant.proxySha256, fps: 30, durationFrames: 60,
        canvas: { width: variant.width, height: variant.height },
        elements: [element(`presenter-${variant.key}`, 'presenter', variant.presenter), element(`subtitle-${variant.key}`, 'subtitle', variant.subtitle)],
      }
      const subjects = [{ id: `face-${variant.key}`, startFrame: 0, endFrame: 60, bounds: variant.subject, critical: true }]
      reports.push(critiqueOutputFormat({ outputSpecId: variant.outputSpecId, format: variant.format, proxyHash: variant.proxySha256, map, subjects }))
      const review = evaluateRenderedProxy({
        projectVersionId, proxyArtifactId: variant.artifactId, proxyManifestId: variant.manifestId, proxySha256: variant.proxySha256,
        inputHash: variant.inputHash, format: variant.format, sourceSha256: calculateVersionHash({ source: suffix }),
        editPlanHash: calculateVersionHash(editPlan), expectedDurationMs: 2_000,
        uploadReceivedAt: createdAt.toISOString(), renderCompletedAt: renderCompletedAt.toISOString(),
        probe: { width: variant.width, height: variant.height, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
        map,
        formatCritic: { outputSpecId: variant.outputSpecId, subjects },
      })
      const stored = await repository.persistGenerated({
        id: variant.reviewId, workspaceId, projectId, operationId: variant.operationId,
        review, createdAt: renderCompletedAt.toISOString(), lease,
      })
      // Controlled persistence fixture: finish only after the authorized review commit.
      await client.v2PublicOperation.update({ where: { id: variant.operationId }, data: {
        status: 'succeeded', phase: 'completed', cancelable: false, progressCompleted: 4,
        leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, completedAt: renderCompletedAt,
        resultJson: stableSerialize({ resource: { type: 'media-artifact', id: variant.artifactId, manifestId: variant.manifestId } }),
      } })
      persisted.push({ variant, review, stored })
    }

    const [landscape, vertical] = persisted
    // Each output owns its verdict: one row is exportable, the other is blocked, on the same version.
    assert.equal(landscape.stored.outputSpecId, 'preset-16x9')
    assert.equal(landscape.stored.status, 'ready-for-final')
    assert.equal(landscape.stored.finalAllowed, true)
    assert.equal(vertical.stored.outputSpecId, 'preset-9x16')
    assert.equal(vertical.stored.status, 'blocked')
    assert.equal(vertical.stored.finalAllowed, false)
    assert.equal(landscape.stored.projectVersionId, vertical.stored.projectVersionId)

    // The verdict round-trips content-addressed through PostgreSQL without drifting the review hash.
    for (const { variant, review, stored } of persisted) {
      assert.equal(stored.formatQuality.outputPresetHash, variant.outputPresetHash)
      assert.equal(stored.formatQuality.reportHash, review.formatQuality.reportHash)
      assert.equal(stored.formatQuality.explanation, review.formatQuality.explanation)
      assert.equal(stored.reviewHash, review.reviewHash)
      const row = await client.v2ProxyReview.findUniqueOrThrow({ where: { id: variant.reviewId } })
      assert.equal(JSON.parse(row.formatQualityJson).reportHash, review.formatQuality.reportHash)
      assert.equal(row.workspaceId, workspaceId)
    }
    assert.match(vertical.stored.formatQuality.explanation, /blocked by 1 hard format reason code\(s\): SUBTITLE_SUBJECT_COLLISION/)
    assert.match(landscape.stored.formatQuality.explanation, /passed every format check/)
    assert.ok(vertical.stored.criticIssues.every((issue) => issue.outputSpecId === 'preset-9x16'))
    assert.ok(landscape.stored.criticIssues.every((issue) => issue.outputSpecId === 'preset-16x9'))

    // Tenant safety: the reviews are invisible from another workspace.
    assert.equal(await client.v2ProxyReview.count({ where: { workspaceId: foreignWorkspaceId } }), 0)
    assert.equal(await client.v2ProxyReview.count({ where: { workspaceId, projectVersionId } }), 2)
    assert.equal(
      await repository.findCurrent({ workspaceId: foreignWorkspaceId, projectId, projectVersionId, requireCurrent: false }),
      null,
    )

    // The final export gate only sees the approval of the output it asked for.
    const exportable = await client.v2ProxyReview.findMany({
      where: { workspaceId, projectVersionId, finalAllowed: true, status: 'ready-for-final' },
      select: { outputSpecId: true },
    })
    assert.deepEqual(exportable.map((row) => row.outputSpecId), ['preset-16x9'])
    for (const outputSpecId of ['preset-16x9', 'preset-9x16']) {
      const rows = await client.v2ProxyReview.findMany({
        where: { workspaceId, projectVersionId, outputSpecId, finalAllowed: true, status: 'ready-for-final' },
        select: { id: true },
      })
      assert.equal(rows.length, outputSpecId === 'preset-16x9' ? 1 : 0, `${outputSpecId} export authorization is wrong`)
    }

    // The persisted per-output gate agrees with the pure domain selection over the same reports.
    const selection = selectExportableVariants(reports)
    assert.deepEqual(selection.approvedOutputSpecIds, ['preset-16x9'])
    assert.deepEqual(selection.blockedOutputSpecIds, ['preset-9x16'])
    assert.deepEqual(
      selection.decisions.map((decision) => [decision.outputSpecId, decision.exportAllowed]),
      [['preset-16x9', true], ['preset-9x16', false]],
    )
    for (const decision of selection.decisions) {
      const stored = persisted.find(({ variant }) => variant.outputSpecId === decision.outputSpecId).stored
      assert.equal(decision.reportHash, stored.formatQuality.reportHash, 'the persisted verdict must be the same content-addressed report')
      assert.equal(decision.explanation, stored.formatQuality.explanation)
      assert.equal(decision.exportAllowed, stored.finalAllowed)
    }
  } finally {
    await client.$disconnect()
  }
})
