import assert from 'node:assert/strict'
import test from 'node:test'

import { canvasBandSourceAreas, createCaptionProjection } from '../../src/v2/domain/caption-canvas-projection.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { collectFaceSourceEvidenceStream } from '../../src/v2/domain/face-source-evidence-stream.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { deriveSubtitleAnchorBands, subtitleAnchorDecisionFor } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { createSubtitleAnchorPlanV3, validateSubtitleAnchorPlanV3 } from '../../src/v2/domain/subtitle-anchor-plan-v3.ts'
import { applyAssCasing, assPresetStyle } from '../../src/v2/domain/subtitle-ass-preset-style.ts'
import { deriveSubtitleRegion } from '../../src/v2/domain/subtitle-region.ts'
import { readSubtitleSegmentsService } from '../../src/v2/application/subtitle-segment-overrides.ts'
import {
  createSubtitleSegmentOverride,
  describeSubtitleSegments,
  resolveSubtitleOverridesForRender,
  subtitleOverrideSetHash,
} from '../../src/v2/domain/subtitle-segment-override.ts'
import { subtitlePresetHash } from '../../src/v2/domain/subtitle-system.ts'
import { buildAssSubtitles } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { sealedSourceWindow, sourceExpectation } from './helpers/face-source-envelope-v3.mjs'

/**
 * W68. The per-segment subtitle exceptions reach the pixels of the editorial render, and they do it through the same evidence that
 * decides every other caption: a pinned band is a REQUEST that the anchor plan grants or refuses, the neighbours of a pinned cue are
 * decided as if it were not there, and a render without any exception keeps the ASS and the plan it always had.
 */
const FPS = 30
const DURATION = 300
const SOURCE = Object.freeze({ artifactId: 'source-1', width: 1280, height: 720 })
const world = (() => {
  const preset = readOutputFormatPreset('16:9')
  const region = deriveSubtitleRegion({ spec: preset.spec, presetId: 'kinetic' })
  const canvas = { width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height }
  const projection = createCaptionProjection({ layout: { canvas }, sources: [SOURCE],
    clips: [{ id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: DURATION, sourceInFrame: 0, sourceOutFrame: DURATION, rate: 1 }] })
  return { preset, region, canvas, projection, bands: deriveSubtitleAnchorBands({ region, safeArea: preset.spec.safeArea }) }
})()
const FAR = [0.9, 0.0, 0.0, 0.03, 0.05]
const stream = (rowsAt) => collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: DURATION, rowsAt })], sourceExpectation({ sourceDurationFrames: DURATION }))
const evidenceOf = (built) => [{ sourceArtifactId: 'source-1', stream: built }]
const plan = (cues, evidence, policy) => createSubtitleAnchorPlanV3({
  spec: world.preset.spec, format: '16:9', canvas: world.canvas, fps: FPS, durationFrames: DURATION,
  region: world.region, cues, projection: world.projection, faceEvidence: evidence, ...(policy ? { policy } : {}),
})
const expected = { region: world.region, safeArea: world.preset.spec.safeArea, outputSpecId: world.preset.spec.id, format: '16:9', canvas: world.canvas, durationFrames: DURATION }
function rowUnder(anchor, cue) {
  const [segment] = canvasBandSourceAreas(world.projection, world.bands[anchor], cue)
  const cx = segment.area.x + segment.area.width / 2, cy = segment.area.y + segment.area.height / 2
  return [0.9, cx - 0.02, cy - 0.03, cx + 0.02, cy + 0.03]
}
const A = { id: 'cue-a', startFrame: 20, endFrame: 50 }
const B = { id: 'cue-b', startFrame: 100, endFrame: 130 }
const C = { id: 'cue-c', startFrame: 180, endFrame: 210 }
const clean = evidenceOf(stream(() => [FAR]))

test('a pinned band that the evidence certifies is drawn, recorded as pinned, and validated', () => {
  const result = plan([A, { ...B, pinnedAnchor: 'top' }, C], clean)
  const decision = subtitleAnchorDecisionFor(result, 'cue-b')
  assert.equal(decision.disposition, 'placed')
  assert.equal(decision.anchor, 'top')
  assert.equal(decision.pinnedAnchor, 'top')
  assert.deepEqual(decision.bounds, world.bands.top)
  assert.equal(decision.stable, false); assert.equal(decision.changedFromPrevious, false)
  assert.deepEqual(decision.issues, [])
  validateSubtitleAnchorPlanV3(result, expected)
})

test('pinning one cue never moves another: the neighbours are decided as if it were not there', () => {
  const free = plan([A, B, C], clean)
  const pinned = plan([A, { ...B, pinnedAnchor: 'center' }, C], clean)
  for (const id of ['cue-a', 'cue-c']) {
    assert.deepEqual(subtitleAnchorDecisionFor(pinned, id), subtitleAnchorDecisionFor(free, id), `${id} is byte for byte what it was`)
  }
  assert.equal(subtitleAnchorDecisionFor(free, 'cue-c').anchor, 'bottom')
  assert.equal(subtitleAnchorDecisionFor(free, 'cue-c').stable, true)
  assert.equal(subtitleAnchorDecisionFor(pinned, 'cue-c').stable, true, 'the third cue is still kept where the first one was, not where the pinned one is')
  assert.notEqual(pinned.anchorPlanHash, free.anchorPlanHash, 'but the plan that has a pin is another plan')
})

test('a plan whose cues carry no pin is the plan it always was', () => {
  const withKey = plan([{ ...A, pinnedAnchor: undefined }, B], clean)
  const without = plan([A, B], clean)
  assert.equal(withKey.anchorPlanHash, without.anchorPlanHash)
  assert.ok(withKey.decisions.every((decision) => !('pinnedAnchor' in decision)))
})

test('a pinned band that a face occupies is NOT drawn: the cue is blocked with the reason, and the veto is not an option', () => {
  const row = rowUnder('top', B)
  const evidence = evidenceOf(stream((frame) => (frame === 115 ? [row] : [FAR])))
  const result = plan([A, { ...B, pinnedAnchor: 'top' }, C], evidence, { onNoSafeRegion: 'omit-and-list' })
  const decision = subtitleAnchorDecisionFor(result, 'cue-b')
  assert.equal(decision.bandAssessments.top.face.state, 'occupied')
  assert.equal(decision.disposition, 'blocked'); assert.equal(decision.anchor, null); assert.equal(decision.suppressed, true)
  assert.deepEqual(decision.issues.map((issue) => [issue.code, issue.severity]), [['NO_SAFE_SUBTITLE_REGION', 'warning']])
  assert.match(decision.issues[0].message, /top band requested for cue cue-b/)
  assert.deepEqual(decision.issues[0].evidenceRange, { startFrame: 100, endFrame: 130 })
  assert.deepEqual(decision.issues[0].elementIds, ['subtitle:cue-b'])
  assert.ok(decision.issues[0].evidenceIds.some((id) => id.startsWith('face-clearance:')))
  // the same cue without the pin is simply placed in the first free band
  assert.equal(subtitleAnchorDecisionFor(plan([A, B, C], evidence), 'cue-b').disposition, 'placed')
  // under the proxy's strict policy the same refusal is a hard issue
  const strict = plan([A, { ...B, pinnedAnchor: 'top' }, C], evidence)
  assert.deepEqual(subtitleAnchorDecisionFor(strict, 'cue-b').issues.map((issue) => issue.severity), ['hard'])
  validateSubtitleAnchorPlanV3(result, expected); validateSubtitleAnchorPlanV3(strict, expected)
})

test('a pinned band whose face coverage cannot be certified is review-required, never drawn', () => {
  const result = plan([{ ...B, pinnedAnchor: 'lower-third' }], [])
  const decision = subtitleAnchorDecisionFor(result, 'cue-b')
  assert.equal(decision.disposition, 'review-required'); assert.equal(decision.anchor, null)
  assert.deepEqual(decision.issues.map((issue) => issue.code), ['FACE_PERCEPTION_UNAVAILABLE'])
  assert.match(decision.issues[0].message, /lower-third band requested for cue cue-b/)
  validateSubtitleAnchorPlanV3(result, expected)
})

test('a recorded pin cannot be rewritten: moving it, removing it or adding one breaks validation', () => {
  const result = plan([A, { ...B, pinnedAnchor: 'top' }], clean)
  const rewrite = (mutate) => {
    const copy = JSON.parse(JSON.stringify(result))
    mutate(copy.decisions.find((decision) => decision.cueId === 'cue-b'))
    const { anchorPlanHash: _hash, ...body } = copy
    return { ...copy, anchorPlanHash: calculateCanonicalHash(body) }
  }
  assert.throws(() => validateSubtitleAnchorPlanV3(rewrite((decision) => { decision.pinnedAnchor = 'center' }), expected), /does not follow from its band assessments/)
  assert.throws(() => validateSubtitleAnchorPlanV3(rewrite((decision) => { delete decision.pinnedAnchor }), expected), /does not follow from its band assessments/)
  assert.throws(() => validateSubtitleAnchorPlanV3(rewrite((decision) => { decision.pinnedAnchor = 'sideways' }), expected), /not a subtitle band/)
})

// ---------------------------------------------------------------------------------------------------------------------------------

const VARIANT = 'variant-tall-0001'
let counter = 0
function exception(segmentId, range, dimensions, extra = {}) {
  counter += 1
  return createSubtitleSegmentOverride({
    id: `override-${counter}-${segmentId}`, workspaceId: 'workspace-w68', projectId: 'project-w68', baseVersionId: 'version-base', resultVersionId: `version-${counter}`,
    commandId: `command-${counter}`, variantId: VARIANT, segmentId, range, action: 'set', dimensions, protected: false, previousOverrideId: null,
    createdAt: '2026-10-20T10:00:00.000Z', ...extra,
  })
}
const CUES = [
  { id: 'cue-a', startFrame: 20, endFrame: 50, text: 'primeira fala' },
  { id: 'cue-b', startFrame: 100, endFrame: 130, text: 'segunda fala' },
  { id: 'cue-c', startFrame: 180, endFrame: 210, text: 'terceira fala' },
]

test('the render applies text, visibility, style and a pin to the cues of ITS output only, and records what it did', () => {
  const overrides = [
    exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'text', text: 'fala corrigida' }, { kind: 'position', anchor: 'top' }]),
    exception('cue-b', { startFrame: 100, endFrame: 130 }, [{ kind: 'visibility', visible: false }]),
    exception('cue-c', { startFrame: 180, endFrame: 210 }, [{ kind: 'style', presetId: 'caps-stroke', presetVersion: 1, presetHash: subtitlePresetHash('caps-stroke') }]),
  ]
  const { cues, receipt } = resolveSubtitleOverridesForRender({ cues: CUES, overrides, variantId: VARIANT })
  assert.deepEqual(cues.map((cue) => [cue.id, cue.text]), [['cue-a', 'fala corrigida'], ['cue-c', 'terceira fala']])
  assert.deepEqual(receipt.hiddenCueIds, ['cue-b'])
  assert.deepEqual({ ...receipt.pinnedAnchors }, { 'cue-a': 'top' })
  assert.deepEqual({ ...receipt.stylePresets }, { 'cue-c': 'caps-stroke' })
  assert.deepEqual(receipt.applied.map((entry) => [entry.segmentId, [...entry.kinds]]), [['cue-a', ['position', 'text']], ['cue-b', ['visibility']], ['cue-c', ['style']]])
  assert.equal(receipt.overridesHash, subtitleOverrideSetHash(overrides, VARIANT))
  // the input list is not touched
  assert.equal(CUES[0].text, 'primeira fala')
  // another output reads none of it
  const other = resolveSubtitleOverridesForRender({ cues: CUES, overrides, variantId: 'variant-wide-0001' })
  assert.equal(other.receipt, null); assert.deepEqual(other.cues, CUES)
  assert.equal(subtitleOverrideSetHash(overrides, 'variant-wide-0001'), null)
})

test('an exception whose segment or exact range the EditPlan no longer has is a recorded no-op, and a reset changes nothing', () => {
  const overrides = [
    exception('cue-a', { startFrame: 21, endFrame: 50 }, [{ kind: 'text', text: 'outra janela' }]),
    exception('cue-gone', { startFrame: 5, endFrame: 9 }, [{ kind: 'text', text: 'sem cue' }]),
    exception('cue-c', { startFrame: 180, endFrame: 210 }, [], { action: 'reset', previousOverrideId: 'override-previous-0001' }),
  ]
  assert.equal(subtitleOverrideSetHash(overrides, VARIANT), calculateCanonicalHash({ schemaVersion: 'subtitle-override-set/v1', variantId: VARIANT, overrideHashes: [overrides[0].overrideHash, overrides[1].overrideHash].toSorted() }))
  const { cues, receipt } = resolveSubtitleOverridesForRender({ cues: CUES, overrides, variantId: VARIANT })
  assert.deepEqual(cues, CUES)
  assert.deepEqual(receipt.applied, [])
  assert.deepEqual(receipt.skipped.map((entry) => [entry.segmentId, entry.reason]).toSorted(), [['cue-a', 'range-mismatch'], ['cue-c', 'inherited'], ['cue-gone', 'segment-missing']])
  // every head reset: the output is identified as one that never had an exception
  const onlyReset = [overrides[2]]
  assert.equal(subtitleOverrideSetHash(onlyReset, VARIANT), null)
  assert.equal(resolveSubtitleOverridesForRender({ cues: CUES, overrides: onlyReset, variantId: VARIANT }).receipt, null)
})

test('a tampered stored exception cannot reach a frame', () => {
  const stored = exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'text', text: 'verdadeira' }])
  const forged = { ...stored, dimensions: [{ kind: 'text', text: 'forjada' }] }
  assert.throws(() => resolveSubtitleOverridesForRender({ cues: CUES, overrides: [forged], variantId: VARIANT }), /does not match its hash/)
})

// ---------------------------------------------------------------------------------------------------------------------------------

const ASS_BASE = {
  width: 540, height: 960, fps: FPS, durationFrames: 300,
  cues: [{ id: 'cue-a', startFrame: 20, endFrame: 50, text: 'primeira fala', anchor: 'bottom' }],
}
function ass(cues, anchors = {}) {
  const planned = plan(cues.map((cue) => ({ id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame, ...(anchors[cue.id] ? { pinnedAnchor: anchors[cue.id] } : {}) })), clean)
  return buildAssSubtitles({ ...ASS_BASE, width: world.canvas.width, height: world.canvas.height, cues, anchorPlan: planned })
}

test('ASS: a cue without a style exception is emitted exactly as before, a cue with one gets that preset\'s style and casing', () => {
  const plain = ass(ASS_BASE.cues)
  assert.ok(!plain.includes('Preset-'), 'no preset style appears when no cue asks for one')
  assert.match(plain, /Dialogue: 0,[^,]+,[^,]+,Default,,0,0,0,,\{\\an5\\pos\(\d+,\d+\)\}primeira fala/)
  const styled = ass([{ ...ASS_BASE.cues[0], presetId: 'caps-stroke' }])
  assert.match(styled, /^Style: Preset-caps-stroke,Arial,\d+,&H00FFFFFF,&H00FFFFFF,&H00000000,/m)
  assert.match(styled, /,Preset-caps-stroke,,0,0,0,,\{\\an5\\pos\(\d+,\d+\)\}PRIMEIRA FALA/)
  assert.equal(styled.split('\n').filter((line) => line.startsWith('Style: Preset-')).length, 1)
  // the Default and CTA styles are untouched
  for (const line of plain.split('\n').filter((entry) => entry.startsWith('Style: Default') || entry.startsWith('Style: CTA'))) assert.ok(styled.includes(line))
})

test('ASS: the position the plan decided is the position drawn (a pinned band moves the event, nothing else does)', () => {
  const at = (text) => /\\pos\((\d+),(\d+)\)/.exec(text)
  const bottom = at(ass(ASS_BASE.cues))
  const top = at(ass(ASS_BASE.cues, { 'cue-a': 'top' }))
  assert.equal(top[1], bottom[1], 'the same horizontal centre')
  assert.ok(Number(top[2]) < Number(bottom[2]), 'the pinned top band is above the bottom band')
})

test('preset styles: box presets draw a container, outline presets an outline, colours convert to libass order', () => {
  const metrics = { fontSize: 40, marginHorizontal: 20, marginVertical: 30 }
  const pill = assPresetStyle('karaoke-pill', metrics)
  assert.match(pill.line, /^Style: Preset-karaoke-pill,Arial,40,&H00FFFFFF,&H0048C9F7,&H14[0-9A-F]{6},/)
  assert.match(pill.line, /,3,1,0,2,20,20,30,1$/)
  const caps = assPresetStyle('caps-stroke', metrics)
  assert.match(caps.line, /,1,5,0,2,20,20,30,1$/)
  assert.equal(caps.casing, 'uppercase')
  assert.equal(applyAssCasing('ação já', 'uppercase'), 'AÇÃO JÁ')
  assert.equal(applyAssCasing('Ação Já', 'none'), 'Ação Já')
})

// ---------------------------------------------------------------------------------------------------------------------------------

test('the editor lists each segment with its head exception and what the render draws for it', () => {
  const overrides = [
    exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'text', text: 'fala corrigida' }, { kind: 'position', anchor: 'top' }], { protected: true }),
    exception('cue-b', { startFrame: 101, endFrame: 130 }, [{ kind: 'visibility', visible: false }]),
    exception('cue-c', { startFrame: 180, endFrame: 210 }, [], { action: 'reset', previousOverrideId: 'override-previous-0002' }),
  ]
  const described = describeSubtitleSegments({ segments: CUES, overrides, variantId: VARIANT })
  assert.deepEqual(described.map((entry) => [entry.segmentId, entry.state]), [['cue-a', 'overridden'], ['cue-b', 'stale'], ['cue-c', 'inherited']])
  assert.deepEqual({ ...described[0].effective }, { text: 'fala corrigida', visible: true, pinnedAnchor: 'top', presetId: null })
  assert.equal(described[0].override.protected, true)
  assert.deepEqual({ ...described[1].effective }, { text: 'segunda fala', visible: true, pinnedAnchor: null, presetId: null }, 'a stale exception draws nothing')
  assert.equal(described[1].override.overrideId, overrides[1].id, 'but it is still shown, so the editor can say why')
  assert.equal(described[2].override.action, 'reset'); assert.deepEqual([...described[2].override.dimensions], [])
  assert.deepEqual({ ...described[2].effective }, { text: 'terceira fala', visible: true, pinnedAnchor: null, presetId: null })
  // an exception of another output is never listed here
  assert.deepEqual(describeSubtitleSegments({ segments: CUES, overrides, variantId: 'variant-wide-0001' }).map((entry) => entry.state), ['inherited', 'inherited', 'inherited'])
})

test('the segments read refuses a stranger and answers from the repository view', async () => {
  const view = { version: { id: 'version-head', sequence: 3, baseHash: 'a'.repeat(64) }, variantId: VARIANT, fps: 30, durationFrames: 300, segments: CUES, overrides: [] }
  const calls = []
  const repository = { async readSegments(input) { calls.push(input); return input.projectId === 'project-w68' ? view : null } }
  const read = readSubtitleSegmentsService({ repository })
  const result = await read({ workspaceId: 'workspace-w68', projectId: 'project-w68', variantId: VARIANT })
  assert.equal(result.version.id, 'version-head'); assert.equal(result.segments.length, 3)
  await assert.rejects(read({ workspaceId: 'workspace-other', projectId: 'project-elsewhere', variantId: VARIANT }), (error) => error.code === 'PROJECT_NOT_FOUND')
  await assert.rejects(read({ workspaceId: 'workspace-w68', projectId: 'project-w68', variantId: 'ab' }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.equal(calls.length, 2, 'a malformed variant never reaches the repository')
})

// ---------------------------------------------------------------------------------------------------------------------------------

const { deriveEditorialRenderGeometry } = await import('../../src/v2/application/derive-editorial-render-geometry.ts')
const { projectProxyRenderInputHash } = await import('../../src/v2/application/project-render-sources.ts')

const sealedSource = (overrides) => ({
  projectId: 'project-w68', projectVersionId: 'version-1', editPlanSnapshotId: 'snapshot-1', editPlanHash: 'a'.repeat(64),
  editPlan: {
    fps: 30, durationFrames: 300, overlayTracks: [], videoTracks: [],
    subtitleTracks: [{ id: 'track-1', presetId: 'kinetic', cues: CUES.map((cue) => ({ ...cue, anchor: 'bottom' })) }],
  },
  format: '16:9', outputConsumption: { seal: { variantId: VARIANT }, sealHash: 'b'.repeat(64) },
  sourceArtifactId: 'source-1', sourceManifestId: 'manifest-1', sourceArtifactKey: 'k', sourceSha256: 'c'.repeat(64),
  renderSources: [{ artifactId: 'source-1', manifestId: 'manifest-1', artifactKey: 'k', sha256: 'c'.repeat(64), byteSize: 10, mediaType: 'video', container: 'mp4', role: 'source-master', probe: { width: 1280, height: 720 } }],
  originalFileName: 'f.mp4', uploadReceivedAt: '2026-10-19T00:00:00.000Z', criticIssues: [],
  ...(overrides ? { subtitleOverrides: overrides, subtitleOverridesHash: subtitleOverrideSetHash(overrides, VARIANT) } : {}),
})
const geometryOf = (source) => deriveEditorialRenderGeometry({
  source, canvas: { width: 960, height: 540 }, workspaceId: 'workspace-w68', projectId: 'project-w68', clips: [], clock: () => new Date('2026-10-19T00:00:00.000Z'),
})

test('the one geometry derivation draws the exceptions: hidden cues leave the render and its plan, text and style travel with the cue, a pin is recorded', async () => {
  const overrides = [
    exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'text', text: 'fala corrigida' }, { kind: 'position', anchor: 'top' }, { kind: 'style', presetId: 'caps-stroke', presetVersion: 1, presetHash: subtitlePresetHash('caps-stroke') }]),
    exception('cue-b', { startFrame: 100, endFrame: 130 }, [{ kind: 'visibility', visible: false }]),
  ]
  const plain = await geometryOf(sealedSource())
  const drawn = await geometryOf(sealedSource(overrides))
  assert.equal(plain.subtitleOverrideReceipt, null)
  assert.deepEqual(plain.subtitleCues.map((cue) => cue.id), ['cue-a', 'cue-b', 'cue-c'])
  assert.deepEqual(drawn.subtitleCues.map((cue) => [cue.id, cue.text, cue.presetId ?? null]), [['cue-a', 'fala corrigida', 'caps-stroke'], ['cue-c', 'terceira fala', null]])
  assert.deepEqual(drawn.placementPlan.subtitleAnchorPlan.decisions.map((decision) => decision.cueId), ['cue-a', 'cue-c'], 'a hidden cue is not planned either')
  assert.equal(drawn.placementPlan.subtitleAnchorPlan.decisions.find((decision) => decision.cueId === 'cue-a').pinnedAnchor, 'top')
  assert.ok(!('pinnedAnchor' in drawn.placementPlan.subtitleAnchorPlan.decisions.find((decision) => decision.cueId === 'cue-c')))
  assert.deepEqual(drawn.subtitleOverrideReceipt.hiddenCueIds, ['cue-b'])
  assert.equal(drawn.subtitleOverrideReceipt.overridesHash, subtitleOverrideSetHash(overrides, VARIANT))
  assert.notEqual(drawn.placementPlan.placementPlanHash, plain.placementPlan.placementPlanHash)
  // exceptions that were all reset are the render that never had one
  const reset = [exception('cue-a', { startFrame: 20, endFrame: 50 }, [], { action: 'reset', previousOverrideId: 'override-previous-0003' })]
  const afterReset = await geometryOf(sealedSource(reset))
  assert.equal(afterReset.subtitleOverrideReceipt, null)
  assert.equal(afterReset.placementPlan.placementPlanHash, plain.placementPlan.placementPlanHash)
  assert.deepEqual(afterReset.subtitleCues, plain.subtitleCues)
})

test('the exceptions that carry a value are part of what a render is; none, or all reset, keeps the identity of every earlier render', () => {
  const live = [exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'text', text: 'outra fala' }])]
  const reset = [exception('cue-a', { startFrame: 20, endFrame: 50 }, [], { action: 'reset', previousOverrideId: 'override-previous-0004' })]
  const hashes = {
    none: projectProxyRenderInputHash({ source: sealedSource(), colorPipelineBindings: [] }),
    live: projectProxyRenderInputHash({ source: sealedSource(live), colorPipelineBindings: [] }),
    other: projectProxyRenderInputHash({ source: sealedSource([exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'text', text: 'mais outra fala' }])]), colorPipelineBindings: [] }),
  }
  assert.equal(new Set(Object.values(hashes)).size, 3)
  assert.equal(subtitleOverrideSetHash(reset, VARIANT), null)
  assert.equal(projectProxyRenderInputHash({ source: sealedSource(reset), colorPipelineBindings: [] }), hashes.none)
})

test('the final export refuses an approval that was given for another set of subtitle exceptions (and counts "none" on both sides as the same)', async () => {
  const { subtitleOverridesMatchApproval } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const hash = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  assert.equal(subtitleOverridesMatchApproval({}, { approvedSubtitleOverridesHash: null }), true, 'drawn and exported without exceptions')
  assert.equal(subtitleOverridesMatchApproval({ subtitleOverridesHash: hash }, { approvedSubtitleOverridesHash: hash }), true, 'the same set')
  assert.equal(subtitleOverridesMatchApproval({ subtitleOverridesHash: hash }, { approvedSubtitleOverridesHash: null }), false, 'exceptions the reviewer never saw')
  assert.equal(subtitleOverridesMatchApproval({}, { approvedSubtitleOverridesHash: hash }), false, 'exceptions the reviewer saw that the final no longer has')
  assert.equal(subtitleOverridesMatchApproval({ subtitleOverridesHash: other }, { approvedSubtitleOverridesHash: hash }), false, 'another set')
})
