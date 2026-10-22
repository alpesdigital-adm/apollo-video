import assert from 'node:assert/strict'
import test from 'node:test'

import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createSubtitleSegmentOverride } from '../../src/v2/domain/subtitle-segment-override.ts'
import { readSubtitleSegmentOverrideHeadsAsOf } from '../../src/v2/infrastructure/prisma/subtitle-segment-override-repository.ts'

/**
 * W70 readiness. The subtitle exceptions in force AS OF a Version (what a sidecar of a historical render is checked against) are those of the
 * line the Version descends from - the override of the NEAREST ancestor for each segment - never one of a Version that is not an ancestor,
 * whatever its sequence number.
 */
const scope = { workspaceId: 'workspace-heads', projectId: 'project-heads', variantId: 'variant-wide' }
const versions = [
  { id: 'version-1', parentVersionId: null },
  { id: 'version-2', parentVersionId: 'version-1' },
  { id: 'version-3', parentVersionId: 'version-2' },
  // a Version made from version-2 while version-3 existed: version-3 is not one of its ancestors
  { id: 'version-4', parentVersionId: 'version-2' },
  { id: 'version-5', parentVersionId: 'version-3' },
]
function overrideRow({ id, segmentId, resultVersionId, baseVersionId, text, previousOverrideId = null }) {
  const subtitleOverride = createSubtitleSegmentOverride({
    id, ...scope, baseVersionId, resultVersionId, commandId: `command-${id}`, segmentId,
    range: { startFrame: segmentId === 'cue-1' ? 10 : 50, endFrame: segmentId === 'cue-1' ? 40 : 90 },
    action: 'set', dimensions: [{ kind: 'text', text }], protected: false, previousOverrideId, createdAt: '2026-10-21T12:00:00.000Z',
  })
  return {
    overrideJson: stableSerialize(subtitleOverride), overrideHash: subtitleOverride.overrideHash, ...scope, segmentId, resultVersionId,
    startFrame: subtitleOverride.range.startFrame, endFrame: subtitleOverride.range.endFrame, action: 'set', dimensionKinds: 'text',
    isProtected: false, previousOverrideId,
  }
}
const rows = [
  overrideRow({ id: 'override-a2', segmentId: 'cue-1', baseVersionId: 'version-1', resultVersionId: 'version-2', text: 'Na versão 2' }),
  overrideRow({ id: 'override-a3', segmentId: 'cue-1', baseVersionId: 'version-2', resultVersionId: 'version-3', text: 'Na versão 3', previousOverrideId: 'override-a2' }),
  overrideRow({ id: 'override-b4', segmentId: 'cue-2', baseVersionId: 'version-2', resultVersionId: 'version-4', text: 'Só na versão 4' }),
]
const client = {
  v2ProjectVersion: { async findMany({ where }) { assert.deepEqual(where, { workspaceId: scope.workspaceId, projectId: scope.projectId }); return versions } },
  v2SubtitleSegmentOverride: {
    async findMany({ where }) {
      assert.equal(where.workspaceId, scope.workspaceId); assert.equal(where.variantId, scope.variantId)
      return rows.filter((row) => where.resultVersionId.in.includes(row.resultVersionId))
    },
  },
}
const textsAsOf = async (versionId) => Object.fromEntries((await readSubtitleSegmentOverrideHeadsAsOf(client, { ...scope, versionId }))
  .map((item) => [item.segmentId, item.dimensions[0].text]))

test('the exceptions in force as of a Version are the nearest ancestor\'s for each segment', async () => {
  assert.deepEqual(await textsAsOf('version-1'), {})
  assert.deepEqual(await textsAsOf('version-2'), { 'cue-1': 'Na versão 2' })
  assert.deepEqual(await textsAsOf('version-3'), { 'cue-1': 'Na versão 3' }, 'the newer exception of the same segment, on the same line')
  assert.deepEqual(await textsAsOf('version-4'), { 'cue-1': 'Na versão 2', 'cue-2': 'Só na versão 4' }, 'version-3 is not an ancestor of version-4: its exception does not apply')
  assert.deepEqual(await textsAsOf('version-5'), { 'cue-1': 'Na versão 3' },
    'version-4 has a lower sequence than version-5 but is not its ancestor: its exception does not apply (by sequence alone it would)')
})

test('a Version that is not stored has no exception set', async () => {
  await assert.rejects(() => readSubtitleSegmentOverrideHeadsAsOf(client, { ...scope, versionId: 'version-9' }), /is not stored/)
})
