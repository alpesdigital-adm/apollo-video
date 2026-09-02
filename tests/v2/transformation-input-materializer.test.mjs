import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createProviderJob } from '../../src/v2/domain/provider-job.ts'
import { AuthorizedProviderSubmissionInputMaterializer } from '../../src/v2/infrastructure/provider-submission-input-materializer.ts'

const HASH = (value) => value.repeat(64)
function authorization() {
  const body = {
    id: 'authorization-transformation-mask', profileSnapshotId: 'brief-transformation-mask', profileSnapshotHash: HASH('1'),
    artifactDecisions: [{ artifactId: 'artifact-transformation-source', rightsSnapshotId: 'rights-transformation-mask', rightsSnapshotHash: HASH('2'), validUntil: '2026-09-02T01:00:00.000Z' }],
    evaluatedAt: '2026-09-01T21:00:00.000Z', expiresAt: '2026-09-02T01:00:00.000Z',
  }
  return Object.freeze({ ...body, authorizationHash: calculateCanonicalHash(body) })
}
function job() {
  return createProviderJob({
    id: 'provider-job-transformation-mask', workspaceId: 'workspace-transformation-mask', projectId: 'project-transformation-mask',
    originProjectVersionId: 'version-transformation-mask', operation: 'video-to-video', adapterId: 'provider-transformation-mask', adapterVersion: '1.0.0',
    providerInput: { schemaVersion: 'transformation-provider-input/v1', sourceArtifactHash: HASH('3'), cleanupMask: { maskId: 'mask-transformation-reviewed', maskHash: HASH('4') } },
    idempotencyKey: 'transformation-mask-0001', authorization: authorization(), createdAt: '2026-09-01T21:00:00.000Z', transport: 'polling',
    transformation: { briefId: 'brief-transformation-mask', briefHash: HASH('1'), selectionId: 'selection-transformation-mask', selectionHash: HASH('5'), providerId: 'provider-transformation-mask', capabilityId: 'capability-transformation-mask' },
  })
}
function materializer(sha256 = HASH('3')) {
  return new AuthorizedProviderSubmissionInputMaterializer({
    profiles: {}, sources: {}, clock: () => new Date('2026-09-01T21:30:00.000Z'),
    artifacts: { async findById(workspaceId, artifactId) { return { id: artifactId, workspaceId, sha256, status: 'available', mediaType: 'video', container: 'mp4' } } },
  })
}

test('T-FR-218 transformation materializer revalidates source and preserves sealed mask projection', async () => {
  const source = job()
  const input = await materializer().materialize({ job: source })
  assert.deepEqual(input, source.input)
  assert.notEqual(input, source.input)
  assert.equal(input.cleanupMask.maskHash, HASH('4'))
})

test('T-FR-218 transformation materializer rejects source drift before provider submission', async () => {
  await assert.rejects(() => materializer(HASH('9')).materialize({ job: job() }), /source changed after job authorization/)
})
