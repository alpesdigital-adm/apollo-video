import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { exportProjectSubtitleSidecarService } from '../../src/v2/application/export-subtitle-sidecar.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { presentPublicDomainError } from '../../src/v2/public-api/error-presenter.ts'
import { buildRenderElementMap, renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { deriveRenderedSubtitleCues, subtitleSidecarLineageHash } from '../../src/v2/domain/subtitle-sidecar.ts'

/**
 * W69 tail. The sidecar of an output is derived ONLY from the cues the render drew: the effective cues (compiled text with the subtitle
 * exceptions applied, hidden cues gone) of which the cue map shows pixels, with the text the render burned. A cue the render did not draw
 * is absent from the file and listed; a rendered cue nobody wrote is a conflict. No FFmpeg here; the physical proof against a real MP4 is
 * tests/v2/subtitle-sidecar-override.e2e.mjs.
 */
const WORKSPACE = 'workspace-rendered-cues'
const PROJECT = 'project-rendered-cues'
const sha = (character) => character.repeat(64)

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-rendered-cues', credentialId: 'credential-rendered-cues', workspaceId: WORKSPACE, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

/** An independent reader of SRT and VTT: it shares no code with the product writer or the product parser. */
function readCues(bytes, format) {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte order mark')
  const text = bytes.subarray(3).toString('utf8')
  const eol = format === 'srt' ? '\r\n' : '\n'
  assert.ok(format === 'srt' ? !/[^\r]\n/.test(text) : !text.includes('\r'), `${format} line terminators`)
  const stamp = format === 'srt' ? /^(\d\d):(\d\d):(\d\d),(\d{3})$/ : /^(\d\d):(\d\d):(\d\d)\.(\d{3})$/
  const ms = (value) => { const m = stamp.exec(value); assert.ok(m, `timestamp ${value}`); return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) }
  const body = format === 'vtt' ? text.replace(/^WEBVTT\n\n/, '') : text
  return body.trimEnd().split(eol + eol).map((block) => {
    const lines = block.split(eol)
    if (format === 'srt') lines.shift()
    const [start, end] = lines[0].split(' --> ')
    return { start: ms(start), end: ms(end), text: lines.slice(1).join('\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }
  })
}

const FPS = 30
const CUE_FRAMES = Object.freeze({ 'cue-1': [10, 40], 'cue-2': [50, 90], 'cue-3': [105, 140] })
function alignmentOf({ drawn, effective, overridesHash = null, review = { status: 'ready-for-final', finalAllowed: true, reviewHash: sha('d') } }) {
  const map = buildRenderElementMap({
    proxyHash: sha('a'), fps: FPS, durationFrames: 150,
    canvas: { width: 960, height: 540 }, source: { width: 1280, height: 720 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 150 }],
    subtitleCues: drawn.map((id) => ({ id, startFrame: CUE_FRAMES[id][0], endFrame: CUE_FRAMES[id][1], text: effective[id] })),
  })
  return {
    projectId: PROJECT, projectVersionId: 'version-3', projectVersionSequence: 3, isCurrentVersion: true,
    variantId: 'variant-wide', outputKind: 'proxy', outputArtifactId: 'artifact-proxy', outputManifestId: 'manifest-proxy',
    outputArtifactKey: 'proxies/proxy.mp4', outputSha256: sha('a'), renderInputHash: sha('b'),
    editPlanSnapshotId: 'snapshot-plan', editPlanHash: sha('c'), renderElementMapId: 'map-1', renderElementMapHash: renderElementMapHash(map), map,
    cueTexts: effective,
    cueFrames: Object.fromEntries(Object.keys(effective).map((id) => [id, { startFrame: CUE_FRAMES[id][0], endFrame: CUE_FRAMES[id][1] }])),
    subtitleOverridesHash: overridesHash, review,
  }
}

function harness(alignment, { prior = null } = {}) {
  const effects = { staged: [], manifests: [], sidecarRows: [] }
  const exportSidecar = exportProjectSubtitleSidecarService({
    sidecars: {
      async readRenderedAlignment() { return alignment },
      async findIdempotent() { return prior },
      async persistOrReplay(input) { effects.sidecarRows.push(input.record); return { record: input.record, replayed: false } },
      async list() { return [] },
    },
    artifacts: {
      async findById() {
        return { id: alignment.outputArtifactId, workspaceId: WORKSPACE, artifactKey: alignment.outputArtifactKey, sha256: alignment.outputSha256, status: 'available',
          manifests: [{ id: alignment.outputManifestId, recipe: { id: 'editorial-proxy' }, renderInput: { inputHash: alignment.renderInputHash } }] }
      },
    },
    persistence: { async persistOrReplay(bundle) { effects.manifests.push(bundle); return { artifactId: bundle.artifactId, manifestId: bundle.manifestId, replayed: false } } },
    storage: {
      async promoteDerived(input) {
        const bytes = effects.staged.at(-1)
        return { key: `${input.workspaceId}/${input.prefix}/${input.sha256}.${input.extension}`, sha256: input.sha256, byteSize: bytes.byteLength }
      },
    },
    staging: { async stage(input) { effects.staged.push(input.bytes); return { path: 'staged', dispose: async () => {} } } },
    clock: () => new Date('2026-10-20T12:00:00.000Z'),
  })
  const call = (overrides = {}) => exportSidecar({ workspaceId: WORKSPACE, actor: actor(), projectId: PROJECT, variantId: 'variant-wide', format: 'srt', idempotencyKey: 'idem-1', ...overrides })
  return { call, effects }
}
/** The sidecar manifest commits to its parameters by hash (the payload itself is not retained), so the test compares commitments. */
const commitmentOf = (bundle) => bundle.manifest.recipe.parametersHash

test('a text exception shows in the sidecar: the cue carries the text the render burned, NFC, and the timing of the pixels', async () => {
  // "Ação" arrives decomposed (c + combining cedilla, a + combining tilde); the render burned the effective text of cue-1.
  const alignment = alignmentOf({ drawn: ['cue-1', 'cue-2'], effective: { 'cue-1': 'Ação', 'cue-2': 'Última cue.' }, overridesHash: sha('7') })
  const { call, effects } = harness(alignment)
  const result = await call()
  const cues = readCues(effects.staged[0], 'srt')
  assert.deepEqual(cues.map((cue) => cue.text), ['Ação', 'Última cue.'])
  assert.equal(cues[0].text, cues[0].text.normalize('NFC'))
  // [10, 40) and [50, 90) at 30 fps in exact milliseconds (floor of k/fps)
  assert.deepEqual(cues.map((cue) => [cue.start, cue.end]), [[333, 1333], [1666, 3000]])
  for (let index = 1; index < cues.length; index += 1) assert.ok(cues[index].start >= cues[index - 1].end, 'monotonic, no overlap')
  assert.equal(cues.at(-1).text, 'Última cue.', 'the last cue is present')
  assert.equal(result.alignment.subtitleOverridesHash, sha('7'))
  assert.deepEqual(result.alignment.omittedCueIds, [])
})

test('a cue the render did not draw is absent from the file and listed; a cue an exception hid is simply not there', async () => {
  // cue-3 is an effective cue the plan suppressed (no safe region): no pixel, so no sidecar cue - and it is named.
  const omitted = alignmentOf({ drawn: ['cue-1', 'cue-2'], effective: { 'cue-1': 'Primeira', 'cue-2': 'Segunda', 'cue-3': 'Terceira' } })
  const first = harness(omitted)
  const result = await first.call({ format: 'vtt' })
  assert.deepEqual(readCues(first.effects.staged[0], 'vtt').map((cue) => cue.text), ['Primeira', 'Segunda'])
  assert.deepEqual(result.alignment.omittedCueIds, ['cue-3'])
  assert.equal(result.alignment.cueCount, 2)
  // the omission is committed to by the manifest of the sidecar: the same drawn cues with nothing omitted commit to something else
  const complete = harness(alignmentOf({ drawn: ['cue-1', 'cue-2'], effective: { 'cue-1': 'Primeira', 'cue-2': 'Segunda' } }))
  await complete.call({ format: 'vtt' })
  assert.deepEqual(readCues(complete.effects.staged[0], 'vtt'), readCues(first.effects.staged[0], 'vtt'), 'the same file')
  assert.notEqual(commitmentOf(first.effects.manifests[0]), commitmentOf(complete.effects.manifests[0]))
  // an exception hid cue-2: it is not an effective cue any more, so it is neither drawn nor listed
  const hidden = alignmentOf({ drawn: ['cue-1'], effective: { 'cue-1': 'Primeira', 'cue-3': 'Terceira' } })
  const second = harness(hidden)
  const hiddenResult = await second.call()
  assert.deepEqual(readCues(second.effects.staged[0], 'srt').map((cue) => cue.text), ['Primeira'])
  assert.deepEqual(hiddenResult.alignment.omittedCueIds, ['cue-3'])
})

test('a rendered cue that is not an effective cue, or a render with no rendered cue, is refused with the reason', () => {
  const map = alignmentOf({ drawn: ['cue-1'], effective: { 'cue-1': 'Primeira' } }).map
  assert.throws(() => deriveRenderedSubtitleCues({ map, effectiveCues: [{ id: 'cue-9', text: 'Outra', startFrame: 10, endFrame: 40 }] }),
    (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH' && error.details.reason === 'rendered-cue-not-effective' && error.details.unwritten[0] === 'cue-1')
  assert.throws(() => deriveRenderedSubtitleCues({ map, effectiveCues: [{ id: 'cue-1', text: 'Primeira', startFrame: 20, endFrame: 30 }] }), /outside the frames of its cue/)
  const none = alignmentOf({ drawn: [], effective: { 'cue-1': 'Primeira', 'cue-2': 'Segunda' } }).map
  assert.throws(() => deriveRenderedSubtitleCues({ map: none, effectiveCues: [{ id: 'cue-1', text: 'Primeira', startFrame: 10, endFrame: 40 }, { id: 'cue-2', text: 'Segunda', startFrame: 50, endFrame: 90 }] }),
    (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH' && error.details.reason === 'no-rendered-cue' && error.details.omittedCueIds.join() === 'cue-1,cue-2')
})

test('the lineage names the exceptions the render was drawn with; a render drawn with none keeps the lineage shape it had', () => {
  const lineage = {
    schemaVersion: 'subtitle-sidecar/v1', workspaceId: WORKSPACE, projectId: PROJECT, projectVersionId: 'version-3', variantId: 'variant-wide',
    outputArtifactId: 'artifact-proxy', outputSha256: sha('a'), outputKind: 'proxy', renderInputHash: sha('b'), editPlanSnapshotId: 'snapshot-plan',
    editPlanHash: sha('c'), renderElementMapHash: sha('e'), format: 'srt', locale: 'pt-BR',
  }
  const plain = subtitleSidecarLineageHash(lineage)
  assert.equal(subtitleSidecarLineageHash({ ...lineage }), plain)
  const withSet = subtitleSidecarLineageHash({ ...lineage, subtitleOverridesHash: sha('7') })
  assert.notEqual(withSet, plain)
  assert.notEqual(withSet, subtitleSidecarLineageHash({ ...lineage, subtitleOverridesHash: sha('8') }))
  assert.throws(() => subtitleSidecarLineageHash({ ...lineage, subtitleOverridesHash: 'not-a-hash' }), /lineage is incomplete/)
})

test('two outputs of one project each reference their own MP4, RenderInput and variant', async () => {
  const wide = alignmentOf({ drawn: ['cue-1'], effective: { 'cue-1': 'Primeira' } })
  const tall = { ...alignmentOf({ drawn: ['cue-1'], effective: { 'cue-1': 'Primeira' } }), variantId: 'variant-tall', outputArtifactId: 'artifact-proxy-tall',
    outputManifestId: 'manifest-proxy-tall', outputArtifactKey: 'proxies/tall.mp4', outputSha256: sha('1'), renderInputHash: sha('2') }
  const map = buildRenderElementMap({
    proxyHash: sha('1'), fps: FPS, durationFrames: 150, canvas: { width: 540, height: 960 }, source: { width: 1280, height: 720 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 150 }],
    subtitleCues: [{ id: 'cue-1', startFrame: 10, endFrame: 40, text: 'Primeira' }],
  })
  tall.map = map
  tall.renderElementMapHash = renderElementMapHash(map)
  const [a, b] = await Promise.all([harness(wide).call({ idempotencyKey: 'idem-wide' }), harness(tall).call({ variantId: 'variant-tall', idempotencyKey: 'idem-tall' })])
  assert.equal(a.sidecar.variantId, 'variant-wide')
  assert.equal(b.sidecar.variantId, 'variant-tall')
  assert.notEqual(a.sidecar.outputSha256, b.sidecar.outputSha256)
  assert.notEqual(a.sidecar.renderInputHash, b.sidecar.renderInputHash)
  assert.equal(a.sidecar.outputSha256, sha('a')); assert.equal(b.sidecar.outputSha256, sha('1'))
  assert.equal(a.sidecar.renderInputHash, sha('b')); assert.equal(b.sidecar.renderInputHash, sha('2'))
  assert.notEqual(a.sidecar.lineageHash, b.sidecar.lineageHash)
  // the cue text is the same, so the two files are the same bytes: each sidecar is bound to its output by its lineage, not by its content
  assert.equal(a.sidecar.sha256, b.sidecar.sha256)
})

test('a refused sidecar publishes its reason and the identifiers a client acts on, and nothing else', () => {
  const present = (details) => presentPublicDomainError(new DomainError('SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH', 'internal wording', details), 'req-12345678').error
  const stale = present({ reason: 'render-stale', requestedVersionId: 'version-5', renderedVersionId: 'version-4', variantId: 'variant-wide', secret: 'x', artifactKey: 'workspace/p.mp4' })
  assert.deepEqual(stale.details, { reason: 'render-stale', requestedVersionId: 'version-5', renderedVersionId: 'version-4', variantId: 'variant-wide' })
  assert.equal(stale.code, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH')
  assert.deepEqual(present({ reason: 'render-blocked', reviewStatus: 'blocked', reviewHash: sha('d') }).details, { reason: 'render-blocked', reviewStatus: 'blocked', reviewHash: sha('d') })
  assert.equal(present({ reason: 'something-internal' }).details, undefined)
  assert.equal(present({}).details, undefined)
  assert.equal(present({ reason: 'render-stale', requestedVersionId: 'has spaces and /slashes' }).details.requestedVersionId, undefined)
})

test('an Idempotency-Key that already names another sidecar request is refused before a byte is staged, even when the lineage of this request exists', async () => {
  const alignment = alignmentOf({ drawn: ['cue-1'], effective: { 'cue-1': 'Primeira' } })
  const { call, effects } = harness(alignment, { prior: { requestFingerprint: sha('9'), record: {} } })
  await assert.rejects(call(), (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  assert.deepEqual([effects.staged.length, effects.manifests.length, effects.sidecarRows.length], [0, 0, 0])
  // the same request under the same key is not a mismatch: it is the replay
  const first = harness(alignment)
  const exported = await first.call()
  const replay = harness(alignment, { prior: { requestFingerprint: calculateFingerprintOf(first.effects), record: exported.sidecar } })
  assert.equal((await replay.call()).sidecar.sha256, exported.sidecar.sha256)
})

/** The fingerprint the service computes: the lineage of the persisted record and the bytes it staged. */
function calculateFingerprintOf(effects) {
  const record = effects.sidecarRows[0]
  return calculateVersionHash({ schemaVersion: 'subtitle-sidecar-export/v1', lineageHash: record.lineageHash, sha256: record.sha256 })
}
