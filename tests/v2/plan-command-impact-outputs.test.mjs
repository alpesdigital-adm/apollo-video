import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertReviewFormatsAreOutputs,
  createCommandArtifactInvalidations,
  createManualCommandImpact,
  createReviewPatchCommandImpact,
  parseCommandImpact,
} from '../../src/v2/domain/command-impact.ts'
import { materializeManualEditPlan } from '../../src/v2/domain/manual-editing.ts'

/**
 * A plan-editing Command (a manual edit, a review patch) changes the ONE EditPlan every output of a project re-materializes from:
 * its impact is the renders of EVERY output, whatever output the edit was made on. These tests pin that for a project with two
 * outputs (9:16 and 16:9) and prove a project with one output keeps the shape it always had.
 */
const workspaceId = 'workspace-plan-outputs'
const baseVersionId = 'version-plan-outputs-1'
const resultVersionId = 'version-plan-outputs-2'
const createdAt = '2026-10-18T10:00:00.000Z'
const WIDE = 'variant-plan-wide'
const VERTICAL = 'variant-plan-vertical'
const BOTH = [WIDE, VERTICAL]

const reference = (artifactId, kind, variantId, sourceVersionId = baseVersionId) => ({ artifactId, kind, sourceVersionId, variantId })
const renders = [
  reference('artifact-proxy-wide', 'proxy', WIDE),
  reference('artifact-final-wide', 'final', WIDE),
  reference('artifact-proxy-vertical', 'proxy', VERTICAL),
  reference('artifact-final-vertical', 'final', VERTICAL),
]

function plan(versionId = baseVersionId) {
  return {
    schemaVersion: 2, state: 'compiled', id: `edit-plan-${versionId}`, projectVersionId: versionId, fps: 30, durationFrames: 180,
    sources: [{ id: 'source-1', artifactId: 'source-1', kind: 'video', durationSeconds: 6 }],
    videoTracks: [{ id: 'base-video', kind: 'base-video', clips: [
      { id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1 },
      { id: 'clip-2', sourceArtifactId: 'source-1', sourceInFrame: 90, sourceOutFrame: 180, timelineInFrame: 90, timelineOutFrame: 180, rate: 1 },
    ] }],
    overlayTracks: [], subtitleTracks: [{ id: 'captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom', faceProtection: true, maxLines: 2,
      maxCharactersPerBlock: 32, cues: [{ id: 'cue-1', startFrame: 15, endFrame: 45, text: 'Texto original', anchor: 'bottom' }] }],
    audioTracks: [], effectTracks: [], markers: [], transitions: [], protectedElements: [], localeVariantRefs: [], formatVariantRefs: [],
    lineageRefs: ['source-1'], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
    composition: { layout: 'fit', background: 'black', foregroundScale: 1, verticalPosition: 0.5 },
    director: { plannerVersion: 'impact-test', decisions: [], assumptions: [] }, createdAt,
  }
}

const crop = { kind: 'crop', clipId: 'clip-1', crop: { x: 0.2, y: 0, width: 0.6, height: 1 } }
function manual(overrides = {}) {
  const operation = overrides.operation ?? crop
  const afterEditPlan = materializeManualEditPlan({ editPlan: plan(), operation, newVersionId: resultVersionId, createdAt,
    availableAssetIds: ['source-1'], variantId: overrides.variantId ?? VERTICAL })
  return createManualCommandImpact({ commandId: 'edit-command-plan-outputs-1', baseVersionId, resultVersionId, variantId: VERTICAL, outputVariantIds: BOTH,
    targetId: 'clip-1', action: 'apply', operation, beforeEditPlan: plan(), afterEditPlan, outputReferences: renders, ...overrides })
}

const refusal = (reason, code = 'PRECONDITION_REQUIRED') => (error) => error?.code === code && error.details?.reason === reason

test('a manual edit made on one output stales the renders of EVERY output, one minimal proxy render per output', () => {
  const view = manual()
  assert.equal(view.renderSemanticsChanged, true)
  assert.deepEqual(view.affectedVariantIds, BOTH.toSorted())
  assert.deepEqual(view.affectedArtifacts.map((item) => [item.kind, item.artifactId, item.variantId]), [
    ['final', 'artifact-final-vertical', VERTICAL], ['final', 'artifact-final-wide', WIDE],
    ['proxy', 'artifact-proxy-vertical', VERTICAL], ['proxy', 'artifact-proxy-wide', WIDE],
  ])
  assert.deepEqual(view.minimalRenders.map((render) => [render.kind, render.variantId]), BOTH.toSorted().map((variantId) => ['proxy', variantId]))
  for (const render of view.minimalRenders) assert.deepEqual(render.ranges, view.affectedRanges)
  assert.deepEqual(parseCommandImpact(JSON.parse(JSON.stringify(view))), view)
  const invalidations = createCommandArtifactInvalidations({ impact: view, createdAt })
  assert.equal(invalidations.length, 4, 'a stale row for each render of each output')
  assert.deepEqual(invalidations.map((row) => row.variantId).toSorted(), [VERTICAL, VERTICAL, WIDE, WIDE])
  // The output the edit was made on is the same edit as seen from the other output: the view does not change the impact.
  const fromOther = manual({ variantId: WIDE })
  assert.equal(fromOther.impactHash, view.impactHash)
})

test('a project with one output keeps its impact: that output, its renders, one minimal render', () => {
  const only = manual({ outputVariantIds: [VERTICAL], outputReferences: renders.filter((item) => item.variantId === VERTICAL) })
  assert.deepEqual(only.affectedVariantIds, [VERTICAL])
  assert.deepEqual(only.affectedArtifacts.map((item) => item.artifactId), ['artifact-final-vertical', 'artifact-proxy-vertical'])
  assert.deepEqual(only.minimalRenders.map((render) => render.variantId), [VERTICAL])
})

test('a render-free manual action (a selection) lists no output, however many the project has', () => {
  const selection = manual({ operation: { kind: 'select', clipId: 'clip-1' } })
  assert.equal(selection.renderSemanticsChanged, false)
  assert.deepEqual([selection.affectedVariantIds, selection.affectedArtifacts, selection.minimalRenders], [[], [], []])
  assert.deepEqual(createCommandArtifactInvalidations({ impact: selection, createdAt }), [])
})

test('restore, undo and redo are plan-wide too: every output, from frame zero to the longest plan', () => {
  for (const action of ['restore', 'undo', 'redo']) {
    const value = createManualCommandImpact({ commandId: 'edit-command-plan-outputs-2', baseVersionId, resultVersionId, variantId: WIDE, outputVariantIds: BOTH,
      targetId: 'version-target-1', action, beforeEditPlan: plan(), afterEditPlan: { ...plan(resultVersionId), durationFrames: 120 }, outputReferences: renders })
    assert.deepEqual(value.affectedVariantIds, BOTH.toSorted(), action)
    assert.deepEqual(value.affectedRanges, [{ startFrame: 0, endFrame: 180 }], action)
    assert.equal(value.affectedArtifacts.length, 4, action)
    assert.equal(value.minimalRenders.length, 2, action)
  }
})

test('a manual edit names an output of its State or is refused with the published reason', () => {
  assert.throws(() => manual({ variantId: 'variant-plan-stranger' }), refusal('output-variant-unknown'))
  assert.throws(() => manual({ outputVariantIds: [] }), (error) => error?.code === 'INVALID_ARGUMENT')
  assert.throws(() => manual({ outputVariantIds: [WIDE, WIDE] }), (error) => error?.code === 'INVALID_ARGUMENT')
  // The selection is validated too: the database guard requires the view to be a State entry for every manual Command.
  assert.throws(() => manual({ variantId: 'variant-plan-stranger', operation: { kind: 'select', clipId: 'clip-1' } }), refusal('output-variant-unknown'))
})

test('a render attributed to a stranger output is never absorbed into the impact', () => {
  assert.throws(() => manual({ outputReferences: [...renders, reference('artifact-proxy-stranger', 'proxy', 'variant-plan-stranger')] }),
    (error) => error?.code === 'INVALID_ARGUMENT' && /not an output/.test(error.message))
})

function patch(overrides = {}) {
  return createReviewPatchCommandImpact({ commandId: 'edit-command-plan-outputs-3', baseVersionId, resultVersionId, outputVariantIds: BOTH,
    operations: [{ op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1000] }], invalidatedRangesMs: [[1000, 1000]],
    beforeEditPlan: plan(), afterEditPlan: plan(resultVersionId), outputReferences: renders, ...overrides })
}

test('a review patch stales the renders of every output, whatever formats its annotation names', () => {
  const everything = patch()
  assert.equal(everything.commandType, 'apply-review-patch')
  assert.deepEqual(everything.affectedVariantIds, BOTH.toSorted())
  assert.equal(everything.affectedArtifacts.length, 4)
  assert.deepEqual(everything.minimalRenders.map((render) => render.variantId), BOTH.toSorted())
  assert.deepEqual(parseCommandImpact(JSON.parse(JSON.stringify(everything))), everything)
  // An annotation scoped to ONE of the formats edits the shared plan all the same: the scope never narrows the impact.
  const scoped = patch({ annotationFormatIds: [VERTICAL] })
  assert.equal(scoped.impactHash, everything.impactHash)
  assert.deepEqual(scoped.affectedVariantIds, BOTH.toSorted())
  const batch = patch({ commandType: 'apply-review-patch-batch', annotationFormatIds: [WIDE, VERTICAL, WIDE] })
  assert.equal(batch.commandType, 'apply-review-patch-batch')
  assert.deepEqual(batch.affectedVariantIds, BOTH.toSorted())
  assert.equal(createCommandArtifactInvalidations({ impact: scoped, createdAt }).length, 4)
})

test('a review patch whose annotation names a format its State does not carry is refused as an unknown output', () => {
  assert.throws(() => patch({ annotationFormatIds: [VERTICAL, '4:5'] }), refusal('output-variant-unknown'))
  assert.throws(() => patch({ outputVariantIds: [] }), (error) => error?.code === 'INVALID_ARGUMENT')
  assert.throws(() => patch({ outputReferences: [...renders, reference('artifact-proxy-stranger', 'proxy', 'variant-plan-stranger')] }),
    (error) => error?.code === 'INVALID_ARGUMENT' && /not an output/.test(error.message))
  assert.doesNotThrow(() => assertReviewFormatsAreOutputs(BOTH, [WIDE]))
  assert.doesNotThrow(() => assertReviewFormatsAreOutputs(BOTH, []))
  assert.throws(() => assertReviewFormatsAreOutputs(BOTH, ['variant-plan-stranger']), refusal('output-variant-unknown'))
})
