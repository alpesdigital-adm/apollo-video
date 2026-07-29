import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  createAssetRightsSnapshot,
} from '../../src/v2/domain/asset-rights.ts'
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import {
  createSourceCleanupPlan,
  defaultSourceCleanupPolicy,
} from '../../src/v2/domain/source-cleanup.ts'
import {
  runNextSourceCleanupOperationService,
} from '../../src/v2/application/run-source-cleanup-worker.ts'

const sourceSha =
  'dfefeece888b706f3cff0ebe7a4d420e28ef84ae721b30771db590d52c0fc04f'
const outputSha = 'f'.repeat(64)
const createdAt = '2026-07-28T22:00:00.000Z'
const workspaceId = 'workspace-source-cleanup-worker'
const projectId = 'project-source-cleanup-worker'
const sourceArtifactId = 'artifact-source-cleanup-worker'
const sourceManifestId = 'manifest-source-cleanup-worker'

function sourceRights() {
  return createAssetRightsSnapshot({
    id: 'rights-source-cleanup-worker',
    workspaceId,
    artifactId: sourceArtifactId,
    sequence: 1,
    draft: {
      status: 'approved',
      allowedUses: ['editing'],
      prohibitedUses: [],
      allowedLocales: ['pt-BR'],
      consent: {
        status: 'not-required',
        allowedUses: [],
      },
    },
    createdBy: { type: 'system', id: 'test-system' },
    createdAt,
  })
}

function cleanupPlan() {
  const rights = sourceRights()
  const finding = Object.freeze({
    id: 'finding-source-cleanup-worker',
    observationId: 'observation-source-cleanup-worker',
    kind: 'logo-watermark',
    rangeMs: [500, 1_500],
    region: { x: 0.4, y: 0.82, width: 0.1, height: 0.08 },
    confidence: 0.99,
    detector: {
      provider: 'apollo',
      model: 'worker-test',
      version: '1.0.0',
    },
    signals: {
      label: 'TEST',
      logoMatch: 0.99,
      frameCoverage: 0.5,
      opacity: 1,
    },
    overlapsEssentialTime: false,
    essentialOverlapRatio: 0,
    protectedRegionIds: [],
    protectedRegionIntersectionRatio: 0,
    removalImpact: 'safe',
    removalWouldDestroyEssential: false,
    requiresHumanReview: false,
    reasonCodes: [],
    observationHash: 'a'.repeat(64),
    findingHash: 'b'.repeat(64),
  })
  const report = Object.freeze({
    schemaVersion: 'contamination-report/v1',
    id: 'contamination-report-source-cleanup-worker',
    workspaceId,
    projectId,
    sourceArtifactId,
    sourceArtifactSha256: sourceSha,
    sourceDurationMs: 2_000,
    protectedRegions: [],
    findings: [finding],
    reportHash: 'c'.repeat(64),
  })
  return createSourceCleanupPlan({
    id: 'source-cleanup-plan-worker',
    report,
    expectedReportHash: report.reportHash,
    findingId: finding.id,
    sourceManifestId,
    policy: defaultSourceCleanupPolicy(),
    rights: {
      outcome: 'allow',
      reasonCodes: [],
      rightsSnapshotId: rights.id,
      rightsSnapshotHash: rights.snapshotHash,
    },
    createdByClientId: 'client-source-cleanup-worker',
    createdAt,
  })
}

function operationStore(plan) {
  let operation = createQueuedPublicOperation({
    id: plan.operationId,
    workspaceId,
    clientId: plan.createdByClientId,
    type: 'source-cleanup',
    target: {
      type: 'media-artifact',
      id: plan.outputArtifactId,
      manifestId: plan.outputManifestId,
    },
    createdAt,
  })
  let lease
  const context = {
    kind: 'source-cleanup',
    projectId,
    cleanupPlanId: plan.id,
    cleanupPlanHash: plan.planHash,
    sourceArtifactId,
    sourceArtifactSha256: sourceSha,
    sourceManifestId,
    outputArtifactId: plan.outputArtifactId,
    outputManifestId: plan.outputManifestId,
    strategy: plan.selectedStrategy,
  }
  const matches = (input) =>
    lease &&
    lease.owner === input.leaseOwner &&
    lease.attempt === input.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(input.now)
  return {
    get operation() {
      return operation
    },
    repository: {
      async claimNext(input) {
        assert.equal(input.type, 'source-cleanup')
        operation = startPublicOperationAttempt(operation, input.now)
        lease = {
          owner: input.leaseOwner,
          attempt: operation.attempt,
          heartbeatAt: input.now,
          expiresAt: input.leaseUntil,
        }
        return {
          operation,
          context,
          lease: { ...lease },
        }
      },
      async heartbeat(input) {
        if (!matches(input)) return false
        lease = {
          ...lease,
          heartbeatAt: input.now,
          expiresAt: input.leaseUntil,
        }
        return true
      },
      async advancePhase(input) {
        if (!matches(input)) return false
        operation = advancePublicOperationPhase(
          operation,
          input.phase,
          input.now,
        )
        return true
      },
      async succeed(input) {
        if (!matches(input)) return null
        operation = succeedPublicOperation(operation, input.now)
        lease = undefined
        return { operation, context }
      },
      async failOrRetry(input) {
        if (!matches(input)) return null
        operation = retryOrFailPublicOperation(
          operation,
          input.error,
          input.now,
          input.nextAttemptAt,
        )
        lease = undefined
        return { operation, context }
      },
    },
  }
}

test('T-FR-122 cleanup worker publishes only after immutable-source, lineage, rights and post-review gates', async () => {
  const plan = cleanupPlan()
  assert.equal(plan.selectedStrategy, 'cover')
  const operations = operationStore(plan)
  const rights = sourceRights()
  let persistedReview
  let processorCleaned = false
  let clockMs = Date.parse(createdAt)
  const runNext = runNextSourceCleanupOperationService({
    operations: operations.repository,
    cleanups: {
      async read() {
        return { plan, operation: operations.operation }
      },
      async persistReview({ review }) {
        persistedReview = review
        return { plan, operation: operations.operation, review }
      },
    },
    mediaArtifacts: {
      async findById() {
        return {
          id: sourceArtifactId,
          workspaceId,
          artifactKey: 'contamination/logo-watermark.mp4',
          sha256: sourceSha,
          byteSize: 7_563n,
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
          manifests: [{
            id: sourceManifestId,
            schemaVersion: 'media-artifact-manifest/v2',
            manifestHash: 'd'.repeat(64),
            recipe: {
              id: 'test',
              version: '1.0.0',
              parametersHash: 'e'.repeat(64),
            },
            sources: [],
            createdAt,
          }],
          createdAt,
        }
      },
    },
    artifacts: {
      async persistOrReplay(bundle) {
        assert.equal(bundle.artifactId, plan.outputArtifactId)
        assert.equal(bundle.manifestId, plan.outputManifestId)
        assert.equal(bundle.manifest.sources[0].sha256, sourceSha)
        return {
          artifactId: bundle.artifactId,
          manifestId: bundle.manifestId,
          replayed: false,
        }
      },
    },
    rights: {
      async findCurrent() {
        return {
          artifactId: sourceArtifactId,
          revision: 'revision-source',
          snapshot: rights,
        }
      },
      async setCurrent(snapshot) {
        assert.equal(snapshot.artifactId, plan.outputArtifactId)
        return {
          artifactId: snapshot.artifactId,
          revision: 'revision-output',
          snapshot,
          replayed: false,
        }
      },
    },
    projects: {
      async read() {
        return {
          project: {
            id: projectId,
            workspaceId,
            name: 'Cleanup worker',
            status: 'draft',
            locale: 'pt-BR',
            createdAt,
          },
          commands: [],
          directorRuns: [],
          media: [],
          transcripts: [],
          operationIds: [],
        }
      },
    },
    storage: {
      async promoteDerived(input) {
        assert.equal(input.prefix, 'cleaned')
        return {
          key: `workspaces/${workspaceId}/cleaned/${outputSha}.mp4`,
          path: input.sourcePath,
          byteSize: 9_001,
          sha256: outputSha,
        }
      },
    },
    processor: {
      async process(input) {
        assert.equal(input.action.strategy, 'cover')
        return {
          outputPath: resolve(
            'tests/fixtures/contamination/logo-watermark.mp4',
          ),
          sha256: outputSha,
          byteSize: 9_001,
          probe: {
            width: 320,
            height: 568,
            duration: 2,
            fps: 30,
            codec: 'h264',
            container: 'mp4',
          },
          visual: {
            passed: true,
            contaminationRemoved: true,
            outputPlayable: true,
            durationAligned: true,
            framingPreserved: true,
            residualQuality: 0.988,
            reasonCodes: [],
          },
        }
      },
      async cleanup() {
        processorCleaned = true
      },
    },
    artifactRoot: resolve('tests/fixtures'),
    clock: () => new Date((clockMs += 100)),
  })

  const outcome = await runNext('worker-source-cleanup-test')
  assert.deepEqual(outcome, {
    operationId: plan.operationId,
    status: 'succeeded',
  })
  assert.equal(operations.operation.status, 'succeeded')
  assert.equal(persistedReview?.passed, true)
  assert.equal(
    persistedReview?.rights.sourceRightsSnapshotHash,
    rights.snapshotHash,
  )
  assert.equal(processorCleaned, true)
})
