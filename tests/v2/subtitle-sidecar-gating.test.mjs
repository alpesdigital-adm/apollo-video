import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { exportProjectSubtitleSidecarService } from '../../src/v2/application/export-subtitle-sidecar.ts'
import { buildRenderElementMap, renderElementMapHash } from '../../src/v2/domain/review-system.ts'

const WORKSPACE = 'workspace-gating'
const sha = (character) => character.repeat(64)

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-gating', credentialId: 'credential-gating', workspaceId: WORKSPACE, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function alignment(review) {
  const map = buildRenderElementMap({
    proxyHash: sha('a'), fps: 30, durationFrames: 90,
    canvas: { width: 1080, height: 1920 }, source: { width: 1920, height: 1080 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 90 }],
    subtitleCues: [{ id: 'cue-1', startFrame: 0, endFrame: 36, text: 'Ação' }],
  })
  return {
    projectId: 'project-gating', projectVersionId: 'version-gating', projectVersionSequence: 3, isCurrentVersion: true,
    variantId: '9:16', outputKind: 'proxy', outputArtifactId: 'artifact-output', outputManifestId: 'manifest-output',
    outputArtifactKey: 'proxies/output.mp4', outputSha256: sha('a'), renderInputHash: sha('b'),
    editPlanSnapshotId: 'snapshot-plan', editPlanHash: sha('c'), renderElementMapId: 'map-1',
    renderElementMapHash: renderElementMapHash(map), map, cueTexts: { 'cue-1': 'Ação' }, cueFrames: { 'cue-1': { startFrame: 0, endFrame: 36 } }, subtitleOverridesHash: null, review,
  }
}

function service(review) {
  const effects = { artifactReads: 0, staging: 0, promotion: 0, artifactPersistence: 0, sidecarPersistence: 0 }
  const exportSidecar = exportProjectSubtitleSidecarService({
    sidecars: {
      async readRenderedAlignment() { return alignment(review) },
      async findIdempotent() { return null },
      async persistOrReplay() { effects.sidecarPersistence += 1; throw new Error('must not persist') },
      async list() { return [] },
    },
    // The artifact lookup is the first step after the gate: reaching it proves the gate let the render through.
    artifacts: { async findById() { effects.artifactReads += 1; return null } },
    persistence: { async persistOrReplay() { effects.artifactPersistence += 1; throw new Error('must not persist') } },
    storage: { async promoteDerived() { effects.promotion += 1; throw new Error('must not promote') } },
    staging: { async stage() { effects.staging += 1; throw new Error('must not stage') } },
  })
  const call = () => exportSidecar({ workspaceId: WORKSPACE, actor: actor(), projectId: 'project-gating', variantId: '9:16',
    format: 'srt', idempotencyKey: 'gating-key' })
  return { call, effects }
}

test('a render blocked by its review gets no sidecar: refused before any lookup, byte or row', async () => {
  const { call, effects } = service({ status: 'blocked', finalAllowed: false, reviewHash: sha('d') })
  await assert.rejects(call(), (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH' &&
    error.details.reason === 'render-blocked' && error.details.reviewStatus === 'blocked' && error.details.reviewHash === sha('d'))
  assert.deepEqual(effects, { artifactReads: 0, staging: 0, promotion: 0, artifactPersistence: 0, sidecarPersistence: 0 })
})

test('a render no review ever judged gets no sidecar either', async () => {
  const { call, effects } = service(null)
  await assert.rejects(call(), (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH' && error.details.reason === 'review-missing')
  assert.deepEqual(effects, { artifactReads: 0, staging: 0, promotion: 0, artifactPersistence: 0, sidecarPersistence: 0 })
})

test('ready and warning-pending renders pass the gate and continue to the artifact checks', async () => {
  for (const status of ['ready-for-final', 'warning-ack-required']) {
    const { call, effects } = service({ status, finalAllowed: status === 'ready-for-final', reviewHash: sha('d') })
    await assert.rejects(call(), (error) => error.code === 'MEDIA_ARTIFACT_NOT_FOUND', status)
    assert.equal(effects.artifactReads, 1, status)
    assert.equal(effects.staging + effects.promotion + effects.artifactPersistence + effects.sidecarPersistence, 0, status)
  }
})
