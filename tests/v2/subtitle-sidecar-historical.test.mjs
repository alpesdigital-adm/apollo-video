import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { exportProjectSubtitleSidecarService } from '../../src/v2/application/export-subtitle-sidecar.ts'
import { buildRenderElementMap, renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { parseSubtitleSidecar } from '../../src/v2/domain/subtitle-sidecar.ts'

/**
 * A historical ProjectVersion may have a sidecar of its own, and only of its own: the request that names it is answered
 * from that version's render (its variant, RenderInput, EditPlan snapshot, cue map and MP4), the result says
 * `projectVersion.current === false`, and any disagreement between the request, the resolved render and the stored
 * artifact is refused before a byte is staged, stored or persisted. No ffmpeg here; the physical round trip with a real
 * MP4 is tests/v2/subtitle-sidecar-pipeline.integration.mjs.
 */
const WORKSPACE = 'workspace-historical'
const PROJECT = 'project-historical'
const HEAD = 'version-head-5'
const OLD = 'version-old-4'
const sha = (character) => character.repeat(64)

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-historical', credentialId: 'credential-historical', workspaceId: WORKSPACE, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

/** One persisted render: its MP4 identity, RenderInput, cue map and the cue texts of its own EditPlan snapshot. */
function render({ versionId, sequence, current, text, proxyChar, renderInputChar, planChar }) {
  const map = buildRenderElementMap({
    proxyHash: sha(proxyChar), fps: 30, durationFrames: 90,
    canvas: { width: 1080, height: 1920 }, source: { width: 1920, height: 1080 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 90 }],
    subtitleCues: [{ id: 'cue-1', startFrame: 0, endFrame: 30, text }],
  })
  return {
    projectId: PROJECT, projectVersionId: versionId, projectVersionSequence: sequence, isCurrentVersion: current,
    variantId: '9:16', outputKind: 'proxy', outputArtifactId: `artifact-proxy-${versionId}`,
    outputManifestId: `manifest-proxy-${versionId}`, outputArtifactKey: `proxies/${versionId}.mp4`,
    outputSha256: sha(proxyChar), renderInputHash: sha(renderInputChar),
    editPlanSnapshotId: `snapshot-plan-${versionId}`, editPlanHash: sha(planChar),
    renderElementMapId: `map-${versionId}`, renderElementMapHash: renderElementMapHash(map), map,
    cueTexts: { 'cue-1': text }, cueFrames: { 'cue-1': { startFrame: 0, endFrame: 30 } }, subtitleOverridesHash: null, review: { status: 'ready-for-final', finalAllowed: true, reviewHash: sha('d') },
  }
}

function artifactOf(alignment, overrides = {}) {
  return {
    id: alignment.outputArtifactId, workspaceId: WORKSPACE, artifactKey: alignment.outputArtifactKey,
    sha256: alignment.outputSha256, status: 'available',
    manifests: [{ id: alignment.outputManifestId, recipe: { id: 'editorial-proxy' },
      renderInput: { inputHash: alignment.renderInputHash }, ...(overrides.manifest ?? {}) }],
    ...overrides.artifact,
  }
}

function harness({ resolve, artifacts }) {
  const effects = { staged: [], promoted: 0, artifactRows: 0, sidecarRows: [] }
  const exportSidecar = exportProjectSubtitleSidecarService({
    sidecars: {
      async readRenderedAlignment(input) { return resolve(input) },
      async findIdempotent() { return null },
      async persistOrReplay(input) { effects.sidecarRows.push(input.record); return { record: input.record, replayed: false } },
      async list() { return [] },
    },
    artifacts: { async findById(_workspaceId, artifactId) { return artifacts.get(artifactId) ?? null } },
    persistence: {
      async persistOrReplay(bundle) { effects.artifactRows += 1; return { artifactId: bundle.artifactId, manifestId: bundle.manifestId, replayed: false } },
    },
    storage: {
      async promoteDerived(input) {
        effects.promoted += 1
        const bytes = effects.staged.at(-1)
        return { key: `${input.workspaceId}/${input.prefix}/${input.sha256}.${input.extension}`, sha256: input.sha256, byteSize: bytes.byteLength }
      },
    },
    staging: { async stage(input) { effects.staged.push(input.bytes); return { path: 'staged-sidecar', dispose: async () => {} } } },
    clock: () => new Date('2026-10-18T12:00:00.000Z'),
  })
  const call = (overrides = {}) => exportSidecar({ workspaceId: WORKSPACE, actor: actor(), projectId: PROJECT, variantId: '9:16',
    format: 'srt', idempotencyKey: 'idem-historical', ...overrides })
  const untouched = () => assert.deepEqual([effects.staged.length, effects.promoted, effects.artifactRows, effects.sidecarRows.length], [0, 0, 0, 0],
    'nothing is staged, promoted or persisted for a refused request')
  return { call, effects, untouched }
}

function world() {
  const head = render({ versionId: HEAD, sequence: 5, current: true, text: 'Texto novo', proxyChar: 'a', renderInputChar: 'b', planChar: 'c' })
  const old = render({ versionId: OLD, sequence: 4, current: false, text: 'Texto antigo', proxyChar: '1', renderInputChar: '2', planChar: '3' })
  const renders = new Map([[`${HEAD}:9:16`, head], [`${OLD}:9:16`, old]])
  const artifacts = new Map([head, old].map((alignment) => [alignment.outputArtifactId, artifactOf(alignment)]))
  const resolve = (input) => renders.get(`${input.projectVersionId ?? HEAD}:${input.variantId}`) ?? null
  return { head, old, renders, artifacts, resolve }
}

test('a historical version gets a sidecar of its own render, flagged current:false, never the head\'s', async () => {
  const { head, old, artifacts, resolve } = world()
  const { call, effects } = harness({ resolve, artifacts })

  const current = await call({ idempotencyKey: 'idem-head' })
  const historical = await call({ projectVersionId: OLD, idempotencyKey: 'idem-old' })

  assert.equal(current.projectVersion.current, true)
  assert.equal(historical.projectVersion.current, false)
  assert.deepEqual([historical.projectVersion.id, historical.projectVersion.sequence], [OLD, 4])

  // bound to that render's own identity: MP4, RenderInput, EditPlan snapshot, cue map and variant
  assert.equal(historical.sidecar.projectVersionId, OLD)
  assert.equal(historical.sidecar.variantId, '9:16')
  assert.equal(historical.sidecar.outputArtifactId, old.outputArtifactId)
  assert.equal(historical.sidecar.outputSha256, old.outputSha256)
  assert.equal(historical.sidecar.renderInputHash, old.renderInputHash)
  assert.equal(historical.sidecar.editPlanSnapshotId, old.editPlanSnapshotId)
  assert.equal(historical.sidecar.renderElementMapHash, old.renderElementMapHash)
  assert.equal(historical.alignment.renderInputHash, old.renderInputHash)
  for (const field of ['renderInputHash', 'outputSha256', 'editPlanSnapshotId', 'renderElementMapHash', 'outputArtifactId']) {
    assert.notEqual(historical.sidecar[field], current.sidecar[field], `${field} must not be borrowed from the head`)
  }
  assert.notEqual(historical.sidecar.lineageHash, current.sidecar.lineageHash)
  assert.notEqual(historical.sidecar.sha256, current.sidecar.sha256)

  // the cue text is the historical snapshot's, not the head's
  assert.equal(parseSubtitleSidecar(effects.staged[1], 'srt')[0].text, 'Texto antigo')
  assert.equal(parseSubtitleSidecar(effects.staged[0], 'srt')[0].text, 'Texto novo')
  assert.equal(head.cueTexts['cue-1'], 'Texto novo')
})

test('a resolution that is not the render the request names is refused, current or historical', async () => {
  const { head, old, artifacts } = world()
  const cases = [
    ['another version than the one named', { projectVersionId: OLD }, () => head, { requestedVersionId: OLD, resolvedVersionId: HEAD }],
    ['another variant than the one named', { variantId: '9:16' }, () => ({ ...head, variantId: '16:9' }), { requestedVariantId: '9:16', resolvedVariantId: '16:9' }],
    ['another project than the one named', {}, () => ({ ...head, projectId: 'project-other' }), {}],
    ['the head when a historical version is named', { projectVersionId: OLD }, () => ({ ...head, isCurrentVersion: true }), { resolvedVersionId: HEAD }],
  ]
  for (const [label, request, resolved, expected] of cases) {
    const { call, untouched } = harness({ resolve: () => resolved(), artifacts })
    await assert.rejects(call(request), (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH' &&
      error.details.reason === 'render-binding-mismatch' && Object.entries(expected).every(([key, value]) => error.details[key] === value), label)
    untouched()
  }
  // control: the same request resolved to the render it names passes the binding
  const { call } = harness({ resolve: () => old, artifacts })
  assert.equal((await call({ projectVersionId: OLD })).projectVersion.current, false)
})

test('a historical render whose artifact, manifest, RenderInput or cue map no longer agree is refused', async () => {
  const { old } = world()
  const tampered = [
    ['MP4 checksum moved', () => artifactOf(old, { artifact: { sha256: sha('f') } }), old, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
    ['MP4 storage key moved', () => artifactOf(old, { artifact: { artifactKey: 'proxies/other.mp4' } }), old, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
    ['manifest carries another RenderInput', () => artifactOf(old, { manifest: { renderInput: { inputHash: sha('e') } } }), old, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
    ['manifest was written by another recipe', () => artifactOf(old, { manifest: { recipe: { id: 'editorial-final' } } }), old, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
    ['artifact is no longer available', () => artifactOf(old, { artifact: { status: 'deleted' } }), old, 'MEDIA_ARTIFACT_NOT_FOUND'],
    ['manifest is gone', () => ({ ...artifactOf(old), manifests: [] }), old, 'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND'],
    ['cue map hash differs from its stored hash', () => artifactOf(old), { ...old, renderElementMapHash: sha('9') }, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
    ['cue map is bound to another MP4', () => artifactOf(old), { ...old, outputSha256: sha('8') }, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
    ['a rendered cue has no effective cue of its own', () => artifactOf(old), { ...old, cueTexts: { 'cue-2': 'Intruso' }, cueFrames: { 'cue-2': { startFrame: 0, endFrame: 30 } } }, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
    ['the render is drawn outside the frames of its cue', () => artifactOf(old), { ...old, cueFrames: { 'cue-1': { startFrame: 5, endFrame: 20 } } }, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'],
  ]
  for (const [label, artifact, alignment, code] of tampered) {
    const stored = artifact()
    const { call, untouched } = harness({ resolve: () => alignment,
      artifacts: new Map([[old.outputArtifactId, stored], [alignment.outputArtifactId, artifactOf(alignment, { artifact: stored })]]) })
    await assert.rejects(call({ projectVersionId: OLD }), (error) => error.code === code, label)
    untouched()
  }
})

test('a historical render its review blocked or never judged gets no sidecar, like a current one', async () => {
  const { old, artifacts } = world()
  for (const [review, reason] of [[{ status: 'blocked', finalAllowed: false, reviewHash: sha('d') }, 'render-blocked'], [null, 'review-missing']]) {
    const { call, untouched } = harness({ resolve: () => ({ ...old, review }), artifacts })
    await assert.rejects(call({ projectVersionId: OLD }), (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH' && error.details.reason === reason)
    untouched()
  }
})

test('the currentness flag is read at export time and is never part of the sidecar lineage', async () => {
  const { old, artifacts } = world()
  const asHistorical = harness({ resolve: () => ({ ...old, isCurrentVersion: false }), artifacts })
  const asCurrent = harness({ resolve: () => ({ ...old, isCurrentVersion: true }), artifacts })
  const first = await asHistorical.call({ projectVersionId: OLD })
  const second = await asCurrent.call({ projectVersionId: OLD })
  assert.equal(first.projectVersion.current, false)
  assert.equal(second.projectVersion.current, true)
  // the same render yields the same content-addressed sidecar whether or not its version is the head today
  assert.equal(first.sidecar.lineageHash, second.sidecar.lineageHash)
  assert.equal(first.sidecar.sha256, second.sidecar.sha256)
  assert.equal(createHash('sha256').update(asHistorical.effects.staged[0]).digest('hex'), first.sidecar.sha256)
})
