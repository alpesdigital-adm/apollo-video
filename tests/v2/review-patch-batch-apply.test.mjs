import assert from 'node:assert/strict'
import test from 'node:test'

import { applyReviewPatchBatchService } from '../../src/v2/application/review-patch-batch.ts'
import { createCommandArtifactInvalidations } from '../../src/v2/domain/command-impact.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { PrismaReviewPatchBatchRepository } from '../../src/v2/infrastructure/prisma/review-patch-batch-repository.ts'
import { ingestedWorld, recompiledChild } from './helpers/output-world.mjs'
import { reviewedTimeline } from './helpers/review-timeline.mjs'

const createdAt = '2026-07-31T19:00:00.000Z'

test('T-FR-233 applied review batch persists impact v2, a sealed Version and normalized invalidations', async () => {
  // The parent is a real sealed Version3/State3 whose EditPlan is the reviewed timeline.
  const world = await ingestedWorld({ sourceDurationSeconds: 6 })
  const parent = recompiledChild(world.parent, world.actor, reviewedTimeline, { suffix: 'review-batch-base' })
  const { workspaceId, projectId } = parent.version, baseVersionId = parent.version.id
  const planSnapshot = operationalBundlePlanV3(parent)
  const outputs = [
    { artifactId: 'artifact-final-9x16', kind: 'final', sourceVersionId: baseVersionId, variantId: '9:16' },
    { artifactId: 'artifact-proxy-9x16', kind: 'proxy', sourceVersionId: baseVersionId, variantId: '9:16' },
    { artifactId: 'artifact-final-16x9', kind: 'final', sourceVersionId: baseVersionId, variantId: '16:9' },
  ]
  const patch = {
    id: 'patch-batch-impact-1', baseVersionId,
    operations: [
      { op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1500] },
      { op: 'update-text', targetId: 'subtitle:cue-1', value: { text: 'Texto revisado' }, rangeMs: [4000, 4500] },
    ],
    annotationIds: ['annotation-batch-impact-1', 'annotation-batch-impact-2'],
    estimatedCost: 0,
    invalidatedRanges: [[1000, 1500], [4000, 4500]],
  }
  const batch = {
    id: 'review-patch-batch-impact-1', workspaceId, projectId, baseVersionId,
    mode: 'all-or-nothing', status: 'ready', patch,
    impact: { operationCount: 2, cost: 0, invalidatedRanges: patch.invalidatedRanges, changedTargets: ['subtitle:cue-1'], expectedScoreDelta: 2, invalidatedArtifacts: ['proxy', 'final'] },
    conflicts: [],
    items: patch.annotationIds.map((annotationId, index) => ({
      id: `review-patch-batch-item-impact-${index + 1}`, annotationId,
      proposalId: `review-patch-proposal-impact-${index + 1}`, status: 'included',
      operation: patch.operations[index], conflictIds: [], createdAt, updatedAt: createdAt,
    })),
    createdAt, updatedAt: createdAt,
  }
  let committed, materializations = 0
  const service = applyReviewPatchBatchService({
    repository: {
      async readApplyContext() {
        return {
          parent, currentVersion: parent.version,
          editPlan: JSON.parse(planSnapshot.contentJson), editPlanHash: planSnapshot.contentHash, availableAssetIds: ['artifact-source3'],
          renderVariantIds: ['9:16'], outputReferences: outputs,
          entries: [], batch,
        }
      },
      async commitOrReplay(input) {
        committed = input
        const { bundle } = input, command = bundle.origin.command
        return {
          batch: { id: input.batchId }, command, version: bundle.version,
          editPlan: JSON.parse(bundle.editPlanSnapshot.contentJson), comparison: input.comparison,
          impact: input.impact,
          invalidations: createCommandArtifactInvalidations({ impact: input.impact, createdAt: command.createdAt }),
          replayed: false,
        }
      },
    },
    clock: () => new Date('2026-08-01T02:00:00.000Z'),
    createId: (kind) => ({
      'edit-command': 'edit-command-review-batch-impact-2',
      'project-version': 'version-review-batch-impact-2',
      'project-snapshot': 'project-snapshot-review-batch-impact-2',
      'project-output-state': 'state-review-batch-impact-2',
    })[kind] ?? `materialization-review-batch-impact-${++materializations}`,
    createEventId: () => '4e0a7962-5347-4bef-a810-95ab71340456',
  })
  const result = await service({
    workspaceId, projectId, batchId: batch.id, confirmed: true,
    actor: world.actor, idempotencyKey: 'review-batch-impact-apply-1',
  })
  const { bundle } = committed, command = bundle.origin.command
  assert.equal(command.payload.schemaVersion, 2)
  assert.equal(result.impact.commandType, 'apply-review-patch-batch')
  assert.equal(command.payload.impact.impactHash, result.impact.impactHash)
  assert.equal(committed.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(committed.event.data.artifactInvalidationCount, 2)
  assert.deepEqual(result.impact.affectedRanges, [
    { startFrame: 30, endFrame: 45 },
    { startFrame: 120, endFrame: 135 },
  ])
  assert.equal(result.invalidations.length, 2)
  // The Version is bound to a sealed State: the patched plan is the Command's own snapshot and every member
  // re-materialized from it and from the parent's exact observations.
  assert.equal(result.version.outputContractVersion, 3)
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.equal(bundle.state.document.parentStateHash, parent.state.stateHash)
  assert.equal(bundle.version.snapshotRefs.editPlan, bundle.editPlanSnapshot.id)
  assert.equal(bundle.origin.requestFingerprint, committed.applyRequestFingerprint)
  assert.equal(JSON.parse(bundle.editPlanSnapshot.contentJson).subtitleTracks[0].cues[0].text, 'Texto revisado')
  for (const entry of bundle.state.document.entries) assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)

  // A Version that does not belong to its Command is refused before a transaction opens.
  await assert.rejects(
    () => new PrismaReviewPatchBatchRepository({ async $transaction() { throw new Error('must not run') } }).commitOrReplay({
      ...committed, bundle: { ...bundle, version: { ...bundle.version, commandId: 'edit-command-of-another-version' } },
    }),
    /does not belong to its Command/,
  )
})
