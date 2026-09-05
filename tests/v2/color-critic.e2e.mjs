import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * F4.014 against real PostgreSQL.
 *
 * Four things a fake cannot prove, and this does:
 *
 * 1. A colour critic report survives a round trip through columns and child
 *    rows, and the read re-verifies its hash — a row edited underneath the
 *    aggregate is refused rather than believed.
 * 2. A `reject` verdict, carried through the existing gate, leaves the proxy
 *    review `blocked` with `finalAllowed = false`.
 * 3. A blocked review cannot be talked round: acknowledging warnings on it is
 *    refused by the repository, in a transaction, with the reason.
 * 4. A `human-review` verdict does not block but does not disappear either —
 *    it holds the review at `warning-ack-required` until a person acknowledges
 *    it, and that acknowledgement is what sets `finalAllowed = true`.
 *
 * The database is a throwaway cluster; `V2_DATABASE_URL` must already be
 * migrated. Everything this test writes it deletes, before and after.
 */

const RUN = process.env.APOLLO_COLOR_CRITIC_E2E === '1'

test(
  'E2E-FR-184 the colour verdict is stored, re-verified and enforced at the proxy gate',
  { skip: RUN ? false : 'set APOLLO_COLOR_CRITIC_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { acknowledgeProxyWarningsService } = await import('../../src/v2/application/proxy-review.ts')
    const { colorCriticProxyIssues } = await import('../../src/v2/application/color-critic.ts')
    const { evaluateRenderedProxy } = await import('../../src/v2/application/render-workflow.ts')
    const { createCameraColorMeasurement } = await import('../../src/v2/domain/color-measurement.ts')
    const { evaluateColorCritic } = await import('../../src/v2/domain/color-critic-report.ts')
    const { createTickInterval } = await import('../../src/v2/domain/session-time.ts')
    const { PrismaColorCriticReportRepository } = await import(
      '../../src/v2/infrastructure/prisma/color-critic-report-repository.ts'
    )
    const { PrismaProxyReviewRepository } = await import(
      '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'
    )
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { PrismaApiClientRepository } = await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

    const client = new PrismaClient()
    const suffix = 'cce2e'
    const workspaceId = `color-critic-workspace-${suffix}`
    const projectId = `color-critic-project-${suffix}`
    const projectVersionId = `color-critic-version-${suffix}`
    const clientId = `color-critic-client-${suffix}`
    const artifactId = `color-critic-artifact-${suffix}`
    const manifestId = `color-critic-manifest-${suffix}`
    const sourceArtifactId = `color-critic-source-${suffix}`
    const sourceManifestId = `color-critic-source-manifest-${suffix}`
    const createdAt = new Date('2029-06-01T18:00:00.000Z')
    const completedAt = new Date(createdAt.getTime() + 65_000)
    const proxySha256 = calculateVersionHash({ artifactId })
    const reports = new PrismaColorCriticReportRepository(client)
    const reviews = new PrismaProxyReviewRepository(client)

    const clean = async () => {
      await client.v2ProxyReviewDecision.deleteMany({ where: { workspaceId } })
      await client.v2ProxyReview.deleteMany({ where: { workspaceId } })
      for (const table of [
        client.v2ColorCriticProposedDelta, client.v2ColorCriticIssue,
        client.v2ColorCriticDimensionResult, client.v2ColorCriticReportMeasurement,
        client.v2ColorCriticReport,
        client.v2ColorMeasurementComponent, client.v2ColorMeasurementDimension,
        client.v2CameraColorMeasurement,
      ]) {
        await table.deleteMany({ where: { workspaceId } })
      }
      await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
      await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
      await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
      await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
      await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
      await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
      await client.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId } })
      await client.v2Project.deleteMany({ where: { workspaceId } })
      await client.v2ApiClient.deleteMany({ where: { workspaceId } })
      await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    }

    t.after(async () => {
      // Reported rather than rethrown: a cleanup failure that masks the real
      // assertion turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })

    await clean()

    // ---- seed ---------------------------------------------------------------
    await client.v2Workspace.create({
      data: { id: workspaceId, slug: workspaceId, name: 'Colour critic E2E', status: 'active', createdAt, updatedAt: createdAt },
    })
    await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: clientId,
      workspaceId,
      name: 'Colour critic E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write', 'projects:approve'],
    })
    await client.v2Project.create({
      data: {
        id: projectId, workspaceId, name: 'Colour critic E2E', status: 'reviewing-proxy',
        objective: 'discovery', format: '9:16', locale: 'pt-BR',
        createdByType: 'api-client', createdById: clientId, createdAt, updatedAt: createdAt,
      },
    })
    const snapshots = [
      { id: `${projectId}-brief`, kind: 'brief', schemaVersion: 1, content: { schemaVersion: 1 } },
      { id: `${projectId}-policies`, kind: 'policies', schemaVersion: 1, content: { schemaVersion: 1, state: 'configured' } },
      {
        id: `${projectId}-edit-plan`, kind: 'edit-plan', schemaVersion: 2,
        content: { schemaVersion: 2, id: `edit-plan-${suffix}`, projectVersionId, state: 'compiled', fps: 30, durationFrames: 60 },
      },
    ]
    for (const snapshot of snapshots) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: snapshot.id, workspaceId, projectId, kind: snapshot.kind,
          schemaVersion: snapshot.schemaVersion,
          contentJson: stableSerialize(snapshot.content),
          contentHash: calculateVersionHash(snapshot.content),
          createdAt,
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: projectVersionId, workspaceId, projectId, sequence: 1,
        briefSnapshotId: snapshots[0].id, editPlanSnapshotId: snapshots[2].id, policiesSnapshotId: snapshots[1].id,
        baseHash: calculateVersionHash({ projectId, projectVersionId }),
        createdBy: clientId, createdAt,
      },
    })
    await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: projectVersionId } })
    /** An artifact plus the one manifest every FK to it needs. */
    const seedArtifact = async (id, manifest, sha256) => {
      await client.v2MediaArtifact.create({
        data: {
          id, workspaceId, artifactKey: `color-critic/${id}.mp4`,
          sha256, byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', createdAt,
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: manifest, workspaceId, artifactId: id, schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: calculateVersionHash({ manifest }), recipeId: 'editorial-proxy', recipeVersion: '1.0.0',
          parametersHash: calculateVersionHash({ manifest, parameters: true }),
          manifestJson: stableSerialize({ artifact: { artifactKey: `color-critic/${id}.mp4` } }),
          createdAt,
        },
      })
    }
    await seedArtifact(artifactId, manifestId, proxySha256)
    await seedArtifact(sourceArtifactId, sourceManifestId, calculateVersionHash({ source: suffix }))
    await client.v2ProjectMediaAsset.create({
      data: { id: randomUUID(), workspaceId, projectId, artifactId, role: 'editorial-proxy', originalFileName: 'proxy.mp4', createdAt },
    })

    /** One rendered proxy operation and the review that judged it. */
    const seedOperation = async (name, inputHash) => {
      const operationId = `${projectId}-${name}`
      await client.v2PublicOperation.create({
        data: {
          id: operationId, workspaceId, projectId, clientId, type: 'project-proxy-render',
          status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: artifactId,
          cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
          // `public_operations_progress_check` ties progress to status, phase
          // and type: a succeeded proxy render is 4 of 4 render steps.
          progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
          resultJson: stableSerialize({ resource: { type: 'media-artifact', id: artifactId, manifestId } }),
          idempotencyKey: `${operationId}-key`, requestFingerprint: inputHash,
          createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt,
        },
      })
      await client.v2ProjectProxyRenderOperation.create({
        data: {
          operationId, workspaceId, projectId, projectVersionId,
          editPlanSnapshotId: snapshots[2].id,
          sourceArtifactId, sourceManifestId,
          inputHash, outputArtifactId: artifactId, outputManifestId: manifestId,
          colorPipelineBindingsJson: stableSerialize([]),
          originalFileName: 'proxy.mp4', createdAt,
        },
      })
      return operationId
    }

    // ---- the evidence -------------------------------------------------------
    const EVALUATOR = { id: 'ffmpeg-rgb24-statistics', kind: 'measured', version: '1.0.0' }
    const measurement = (id, cameraId, sourceAssetId, sourceSha256, overrides = {}) => {
      const evidenceRef = `rawvideo-rgb24:${id}`
      const measured = (value, unit, components) => ({
        status: 'measured', value, unit, evaluator: EVALUATOR, evidenceRef,
        ...(components ? { components } : {}),
      })
      const values = { exposure: 0.5, rOverG: 1, bOverG: 0.9, highlights: 0.001, blacks: 0.001, ...overrides }
      return createCameraColorMeasurement({
        measurementId: id,
        sessionId: null,
        sourceAssetId,
        sourceSha256,
        cameraId,
        range: createTickInterval(0n, 120n),
        sourceRange: { startFrame: 0, endFrame: 120 },
        sampledFrames: 8,
        technical: {
          metadata: { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 },
          pixelFormat: 'yuv420p',
          hdrMode: 'sdr',
        },
        dimensions: {
          whiteBalance: measured(values.bOverG / values.rOverG, 'ratio', { rOverG: values.rOverG, bOverG: values.bOverG, bOverR: values.bOverG / values.rOverG }),
          exposure: measured(values.exposure, 'normalized-luma'),
          contrast: measured(0.2, 'normalized-luma', { p5: 0.1, p95: 0.9, spread: 0.8 }),
          blacks: measured(values.blacks, 'ratio', { threshold: 4 / 255 }),
          highlights: measured(values.highlights, 'ratio', { threshold: 251 / 255 }),
          saturation: measured(0.1, 'normalized-chroma'),
          tonalResponse: measured(0.5, 'normalized-luma', { p1: 0.02, p5: 0.1, p25: 0.3, p50: 0.5, p75: 0.7, p95: 0.9, p99: 0.98 }),
          skin: { status: 'not-applicable', reason: 'fewer than 2% of sampled pixels fall in the skin band; no skin-band region to measure' },
        },
        confidence: 1,
        issues: [],
      })
    }

    const before = [measurement(`ccm-before-${suffix}`, 'cam-a', sourceArtifactId, calculateVersionHash({ before: suffix }))]
    // The delivered frames clip 6% of their pixels — a destroyed sample, which
    // no confidence band and no declared look can turn into an approval.
    const rejectedAfter = [measurement(`ccm-after-reject-${suffix}`, 'cam-a', artifactId, proxySha256, { highlights: 0.06 })]
    // A cast big enough to warn but not to reject, and one dimension nobody
    // could read: that combination is what sends a report to a human.
    const reviewedAfter = [measurement(`ccm-after-review-${suffix}`, 'cam-a', artifactId, proxySha256, { bOverG: 0.945 })]

    const criticReport = (reportId, after) => evaluateColorCritic({
      reportId,
      workspaceId,
      projectId,
      projectVersionId,
      subject: { kind: 'output', artifactId },
      before,
      after,
      creativeIntent: { declared: false, brandColorsDeclared: true },
      evaluatedAt: completedAt.toISOString(),
    })

    // ---- 1. the report round trips and re-verifies itself -------------------
    const rejection = criticReport(`ccr-reject-${suffix}`, rejectedAfter)
    assert.equal(rejection.action, 'reject', `expected a rejection, got ${rejection.action}/${rejection.cause}`)
    const stored = await reports.persist({ report: rejection, createdAt: completedAt.toISOString() })
    assert.equal(stored.replayed, false)
    const reread = await reports.read({ workspaceId, reportId: rejection.reportId })
    assert.equal(reread?.reportHash, rejection.reportHash)
    assert.equal(reread.issues.length, rejection.issues.length)
    assert.equal(reread.dimensions.length, rejection.dimensions.length)
    // The same verdict about the same bytes collapses into one row.
    const replay = await reports.persist({ report: rejection, createdAt: completedAt.toISOString() })
    assert.equal(replay.replayed, true)

    // A row edited underneath the aggregate is refused, not believed. The
    // instant is chosen because the schema's own CHECKs already refuse most
    // internally inconsistent edits — `confidence` is tied to
    // `confidenceBand` by `color_critic_reports_confidence_check`, so that
    // tamper never reaches the hash. `evaluatedAt` is inside the hashed body
    // and constrained by nothing, which is exactly the edit only a hash catches.
    await client.v2ColorCriticReport.updateMany({
      where: { workspaceId, reportId: rejection.reportId },
      data: { evaluatedAt: new Date(completedAt.getTime() + 1_000) },
    })
    await assert.rejects(
      () => reports.read({ workspaceId, reportId: rejection.reportId }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
      'a report whose stored content no longer hashes to its recorded hash must be refused on read',
    )
    await client.v2ColorCriticReport.updateMany({
      where: { workspaceId, reportId: rejection.reportId },
      data: { evaluatedAt: completedAt },
    })
    assert.equal((await reports.read({ workspaceId, reportId: rejection.reportId }))?.reportHash, rejection.reportHash)

    // ---- 2/3. a rejection blocks the gate and cannot be acknowledged --------
    const proxyReview = (inputHash, criticIssues) => evaluateRenderedProxy({
      projectVersionId,
      proxyArtifactId: artifactId,
      proxyManifestId: manifestId,
      proxySha256,
      inputHash,
      format: '9:16',
      sourceSha256: calculateVersionHash({ source: suffix }),
      editPlanHash: calculateVersionHash(snapshots[2].content),
      expectedDurationMs: 2_000,
      uploadReceivedAt: createdAt.toISOString(),
      renderCompletedAt: completedAt.toISOString(),
      probe: { width: 540, height: 960, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
      map: {
        schemaVersion: 'render-element-map/v1',
        mapHash: calculateVersionHash({ map: suffix }),
        proxyHash: proxySha256,
        fps: 30,
        durationFrames: 60,
        canvas: { width: 540, height: 960 },
        elements: [],
      },
      criticIssues,
    })

    const rejectHash = calculateVersionHash({ kind: 'proxy', name: 'reject' })
    const rejectOperation = await seedOperation('reject', rejectHash)
    const rejectIssues = colorCriticProxyIssues({ report: reread, fps: 30 })
    assert.ok(rejectIssues.some((issue) => issue.severity === 'hard'))
    assert.ok(rejectIssues.every((issue) => issue.evidenceIds.some((ref) => ref.includes(rejection.reportId))))
    const blocked = proxyReview(rejectHash, rejectIssues)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.finalAllowed, false)
    const blockedRow = await reviews.persistGenerated({
      id: `proxy-review-reject-${suffix}`,
      workspaceId, projectId, operationId: rejectOperation,
      review: blocked, createdAt: completedAt.toISOString(),
    })
    assert.equal(blockedRow.finalAllowed, false)
    assert.equal(blockedRow.status, 'blocked')
    // The citation is durable, not merely computed: the review that comes back
    // out of PostgreSQL still names the report and its hash, so somebody
    // reading the block next month can find the verdict behind it.
    assert.ok(blockedRow.criticIssues.some((issue) =>
      issue.evidenceIds?.includes(`color-critic-report:${rejection.reportId}@${rejection.reportHash}`)))

    const auditContext = createExternalAuditContext({
      workspaceId, clientId, credentialId: `credential-${suffix}`, environment: 'production',
      delegatedUserId: `user-${suffix}`, delegatedIdentityId: `identity-${suffix}`, workspaceRole: 'director',
    })
    const actor = Object.freeze({
      ...auditContext,
      scopes: new Set(['projects:write']),
      authenticationKind: 'ui-session',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active',
      auditContext,
    })
    const acknowledge = acknowledgeProxyWarningsService({
      repository: reviews,
      clock: () => completedAt,
      createId: () => `decision-${randomUUID()}`,
    })
    await assert.rejects(
      () => acknowledge({
        workspaceId, projectId, projectVersionId,
        proxyReviewId: blockedRow.id,
        baseReviewHash: blockedRow.reviewHash,
        expectedRevision: blockedRow.revision,
        action: 'acknowledge-warnings',
        actor,
        idempotencyKey: `ack-blocked-${suffix}`,
      }),
      (error) => error.code === 'PRECONDITION_REQUIRED' && /never be acknowledged/.test(error.message),
      'a blocked colour verdict must not be clearable by acknowledging warnings',
    )
    assert.equal((await reviews.findCurrent({ workspaceId, projectId, projectVersionId }))?.finalAllowed, false)

    // ---- 4. a human-review verdict appears, does not block, and is cleared --
    const humanReview = criticReport(`ccr-review-${suffix}`, reviewedAfter)
    assert.equal(humanReview.action, 'human-review', `expected human-review, got ${humanReview.action}/${humanReview.cause}`)
    await reports.persist({ report: humanReview, createdAt: completedAt.toISOString() })
    const warnIssues = colorCriticProxyIssues({ report: humanReview, fps: 30 })
    assert.ok(warnIssues.length > 0, 'a human-review verdict must still appear on the review')
    assert.ok(warnIssues.every((issue) => issue.severity === 'warning'))

    // The blocked review holds the version's `findCurrent`, so the warning
    // review is written against its own operation and read by id.
    await client.v2ProxyReview.deleteMany({ where: { workspaceId, id: blockedRow.id } })
    const warnHash = calculateVersionHash({ kind: 'proxy', name: 'human-review' })
    const warnOperation = await seedOperation('human-review', warnHash)
    const warned = proxyReview(warnHash, warnIssues)
    assert.equal(warned.status, 'warning-ack-required')
    assert.equal(warned.finalAllowed, false)
    const warnedRow = await reviews.persistGenerated({
      id: `proxy-review-warn-${suffix}`,
      workspaceId, projectId, operationId: warnOperation,
      review: warned, createdAt: completedAt.toISOString(),
    })
    const cleared = await acknowledge({
      workspaceId, projectId, projectVersionId,
      proxyReviewId: warnedRow.id,
      baseReviewHash: warnedRow.reviewHash,
      expectedRevision: warnedRow.revision,
      action: 'acknowledge-warnings',
      actor,
      idempotencyKey: `ack-warned-${suffix}`,
    })
    assert.equal(cleared.replayed, false)
    assert.equal(cleared.review.status, 'ready-for-final')
    assert.equal(cleared.review.finalAllowed, true)
    assert.equal(cleared.review.warningsAcknowledged, true)
    assert.equal(cleared.decision.action, 'acknowledge-warnings')

    console.log(`E2E-FR-184 reject=${rejection.cause}/${rejection.action} hardIssues=${rejectIssues.filter((issue) => issue.severity === 'hard').length} blockedFinalAllowed=${blockedRow.finalAllowed} humanReview=${humanReview.cause}/${humanReview.action} warnings=${warnIssues.length} clearedFinalAllowed=${cleared.review.finalAllowed}`)
  },
)
