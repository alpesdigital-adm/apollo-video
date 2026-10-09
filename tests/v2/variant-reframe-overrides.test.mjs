import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  createVariantReframeOverrideSet,
  parseVariantReframeOverrideSet,
  selectVariantReframeOverrides,
} from '../../src/v2/domain/variant-reframe-overrides.ts'

const sourceClips = Object.freeze([{
  clipId: 'clip-main-1', sourceArtifactId: 'artifact-main-1', sourceSha256: 'a'.repeat(64),
  sourceWidth: 1920, sourceHeight: 1080, sourceFps: 30,
  sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1,
}])

function input(extra = {}) {
  return {
    id: 'override-set-1', workspaceId: 'workspace-1', projectId: 'project-1',
    baseVersionId: 'version-1', resultVersionId: 'version-2', commandId: 'command-1',
    editPlanHash: 'b'.repeat(64), timelineFps: 30, sourceClips,
    override: { id: 'override-1', variantId: '9:16', clipId: 'clip-main-1',
      startFrame: 10, endFrame: 30,
      crop: { x: 0.35, y: 0, width: 0.31640625, height: 1 } },
    createdAt: '2026-10-08T12:00:00.000Z', ...extra,
  }
}

test('W66 manual override is content-addressed, variant/range scoped and never detector evidence', () => {
  const set = createVariantReframeOverrideSet(input())
  assert.equal(set.schemaVersion, 'variant-reframe-overrides/v1')
  assert.equal(set.sourceMapHash, calculateCanonicalHash({ timelineFps: 30, sourceClips }))
  assert.equal(set.overrides[0].provenance, 'manual-command')
  assert.deepEqual(set.overrides.filter((item) => item.variantId === '16:9'), [])
  const context = { set, workspaceId: 'workspace-1', projectId: 'project-1',
    projectVersionId: 'version-2', editPlanHash: 'b'.repeat(64), sourceMapHash: set.sourceMapHash }
  assert.deepEqual(selectVariantReframeOverrides({ ...context, variantId: '16:9' }), [])
  assert.deepEqual(selectVariantReframeOverrides({ ...context, variantId: '9:16' }).map((item) => item.id), ['override-1'])
  assert.throws(() => selectVariantReframeOverrides({ ...context, projectVersionId: 'version-3', variantId: '9:16' }), /stale/)
  assert.throws(() => selectVariantReframeOverrides({ ...context, workspaceId: 'workspace-other', variantId: '9:16' }), /another rendering context/)
  assert.equal(parseVariantReframeOverrideSet(JSON.parse(JSON.stringify(set))).contentHash, set.contentHash)
  assert.throws(() => parseVariantReframeOverrideSet({ ...set, workspaceId: 'workspace-other' }), /content hash/)
  assert.throws(() => parseVariantReframeOverrideSet({ ...set, sourceClips: [{ ...sourceClips[0], sourceSha256: 'c'.repeat(64) }] }), /source map hash/)
  assert.throws(() => parseVariantReframeOverrideSet({ ...set, unknown: true }), /fields are invalid/)
})

test('W66 newer Command can replace exact range but cannot overlap or leak into sibling variant', () => {
  const first = createVariantReframeOverrideSet(input())
  const second = createVariantReframeOverrideSet(input({
    id: 'override-set-2', baseVersionId: 'version-2', resultVersionId: 'version-3',
    commandId: 'command-2', previous: first,
    override: { id: 'override-2', variantId: '16:9', clipId: 'clip-main-1',
      startFrame: 10, endFrame: 30, crop: { x: 0, y: 0, width: 1, height: 1 } },
  }))
  assert.deepEqual(second.overrides.map((item) => item.variantId), ['16:9', '9:16'])
  assert.equal(second.overrides.find((item) => item.variantId === '9:16').commandId, 'command-1')
  const replacement = createVariantReframeOverrideSet(input({
    id: 'override-set-3', baseVersionId: 'version-2', resultVersionId: 'version-3',
    commandId: 'command-3', previous: first,
    override: { id: 'override-3', variantId: '9:16', clipId: 'clip-main-1',
      startFrame: 10, endFrame: 30, crop: { x: 0.36, y: 0, width: 0.31640625, height: 1 } },
  }))
  assert.deepEqual(replacement.overrides.map((item) => item.id), ['override-3'])
  assert.throws(() => createVariantReframeOverrideSet(input({
    id: 'override-set-4', baseVersionId: 'version-2', resultVersionId: 'version-3',
    commandId: 'command-4', previous: first,
    override: { id: 'override-4', variantId: '9:16', clipId: 'clip-main-1',
      startFrame: 20, endFrame: 40, crop: { x: 0.35, y: 0, width: 0.31640625, height: 1 } },
  })), /overlap/)
})

test('W66 inheritance rejects stale version, changed plan/map/source and unsupported timing', () => {
  const first = createVariantReframeOverrideSet(input())
  const next = { id: 'override-set-2', baseVersionId: 'version-2', resultVersionId: 'version-3',
    commandId: 'command-2', previous: first,
    override: { id: 'override-2', variantId: '16:9', clipId: 'clip-main-1',
      startFrame: 10, endFrame: 30, crop: { x: 0, y: 0, width: 1, height: 1 } } }
  assert.throws(() => createVariantReframeOverrideSet(input({ ...next, baseVersionId: 'version-stale' })), /cross version/)
  assert.throws(() => createVariantReframeOverrideSet(input({ ...next, editPlanHash: 'c'.repeat(64) })), /EditPlan/)
  assert.throws(() => createVariantReframeOverrideSet(input({ ...next, sourceClips: [{ ...sourceClips[0], sourceSha256: 'c'.repeat(64) }] })), /source map/)
  assert.throws(() => createVariantReframeOverrideSet(input({ ...next, timelineFps: 24 })), /source map/)
  assert.throws(() => createVariantReframeOverrideSet(input({ sourceClips: [{ ...sourceClips[0], sourceFps: 24 }] })), /source FPS equal/)
  assert.throws(() => createVariantReframeOverrideSet(input({ sourceClips: [{ ...sourceClips[0], rate: 1.25 }] })), /source rate/)
  assert.throws(() => createVariantReframeOverrideSet(input({
    override: { ...input().override, variantId: '16:9' },
  })), /aspect/)
  assert.throws(() => createVariantReframeOverrideSet(input({
    override: { ...input().override, startFrame: 89, endFrame: 100 },
  })), /end frame/)
})
