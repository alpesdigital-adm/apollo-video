import assert from 'node:assert/strict'
import test from 'node:test'

import { applyReviewPatchService } from '../../src/v2/application/review-patch.ts'
import { createCommandArtifactInvalidations } from '../../src/v2/domain/command-impact.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { PrismaReviewPatchRepository } from '../../src/v2/infrastructure/prisma/review-patch-repository.ts'
import { ingestedWorld, recompiledChild } from './helpers/output-world.mjs'
import { reviewedTimeline } from './helpers/review-timeline.mjs'

const createdAt = '2026-07-31T19:00:00.000Z'

test('T-FR-233 applied review patch persists impact v2, a sealed Version and normalized invalidations', async () => {
  // The parent is a real sealed Version3/State3 whose EditPlan is the reviewed timeline.
  const world = await ingestedWorld({ sourceDurationSeconds: 6 })
  const parent = recompiledChild(world.parent, world.actor, reviewedTimeline, { suffix: 'review-base' })
  const { workspaceId, projectId } = parent.version, baseVersionId = parent.version.id
  const planSnapshot = operationalBundlePlanV3(parent)
  // The renders of the head, each attributed to the stable variant of the world's ONE output.
  const VARIANT = parent.state.document.entries[0].variantId
  const outputs = [
    { artifactId: 'artifact-final-9x16', kind: 'final', sourceVersionId: baseVersionId, variantId: VARIANT },
    { artifactId: 'artifact-proxy-9x16', kind: 'proxy', sourceVersionId: baseVersionId, variantId: VARIANT },
  ]
  const annotation = {
    id: 'annotation-impact-1', projectVersionId: baseVersionId, frame: 30,
    timeRangeMs: [1000, 1000], screenshotRef: 'screenshot-impact-1', scope: 'point',
    targetIds: ['subtitle:cue-1'], applicationScope: { kind: 'frame', targetIds: ['subtitle:cue-1'], formatIds: [VARIANT], localeIds: ['pt-BR'], recipeIds: [], global: false },
    affectedCount: 1, text: 'Mover legenda', author: { id: world.actor.clientId, name: 'Client', type: 'api-client' }, status: 'open', createdAt,
  }
  const proposal = {
    id: 'review-proposal-impact-1', workspaceId, projectId, annotationId: annotation.id, baseVersionId,
    status: 'ready', interpretationVersion: 'review-patch-interpreter/1.0.0', choices: [],
    patch: { id: 'patch-impact-1', baseVersionId, operations: [{ op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1000] }], annotationIds: [annotation.id], estimatedCost: 0, invalidatedRanges: [[1000, 1000]] },
    impact: { operationCount: 1, cost: 0, invalidatedRanges: [[1000, 1000]], changedTargets: ['subtitle:cue-1'], expectedScoreDelta: 3, invalidatedArtifacts: ['proxy', 'final'] },
    gates: [], createdAt, updatedAt: createdAt,
  }
  let committed, materializations = 0
  const service = applyReviewPatchService({
    repository: {
      async readApplyContext() {
        return {
          annotation, parent, currentVersion: parent.version,
          editPlan: JSON.parse(planSnapshot.contentJson), editPlanHash: planSnapshot.contentHash, policies: {}, availableAssetIds: ['artifact-source3'],
          outputReferences: outputs, proposal,
        }
      },
      async commitOrReplay(input) {
        committed = input
        const { bundle } = input, command = bundle.origin.command
        return {
          proposal: { id: input.proposalId }, command, version: bundle.version,
          editPlan: JSON.parse(bundle.editPlanSnapshot.contentJson), comparison: input.comparison,
          impact: input.impact,
          invalidations: createCommandArtifactInvalidations({ impact: input.impact, createdAt: command.createdAt }),
          replayed: false,
        }
      },
    },
    clock: () => new Date('2026-08-01T01:00:00.000Z'),
    createId: (kind) => ({
      'edit-command': 'edit-command-review-impact-4',
      'project-version': 'version-review-impact-2',
      'project-snapshot': 'project-snapshot-review-impact-2',
      'project-output-state': 'state-review-impact-2',
    })[kind] ?? `materialization-review-impact-${++materializations}`,
    createEventId: () => '3e0a7962-5347-4bef-a810-95ab71340456',
  })
  const result = await service({
    workspaceId, projectId, proposalId: proposal.id, confirmed: true,
    actor: world.actor, idempotencyKey: 'review-impact-apply-1',
  })
  const { bundle } = committed, command = bundle.origin.command
  assert.equal(command.payload.schemaVersion, 2)
  assert.equal(command.payload.impact.impactHash, result.impact.impactHash)
  assert.equal(committed.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(committed.event.data.artifactInvalidationCount, 2)
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 30, endFrame: 31 }])
  assert.equal(result.invalidations.length, 2)
  // The Version is bound to a sealed State: the patched plan is the Command's own snapshot and every
  // member re-materialized from it and from the parent's exact observations.
  assert.equal(result.version.outputContractVersion, 3)
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.equal(bundle.state.document.parentStateHash, parent.state.stateHash)
  assert.equal(bundle.version.snapshotRefs.editPlan, bundle.editPlanSnapshot.id)
  assert.equal(bundle.origin.requestFingerprint, committed.applyRequestFingerprint)
  assert.equal(JSON.parse(bundle.editPlanSnapshot.contentJson).subtitleTracks[0].cues[0].anchor, 'bottom')
  for (const entry of bundle.state.document.entries) assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)

  // Concurrent output drift is refused before anything is written.
  const driftRepository = new PrismaReviewPatchRepository({
    v2ReviewPatchProposal: { async findFirst() { return null } },
    async $transaction(callback) {
      return callback({
        v2ReviewPatchProposal: { async findFirst() { return { id: committed.proposalId, status: 'ready', baseVersionId } } },
        v2Project: { async findFirst() { return { format: null, currentVersion: { id: baseVersionId, sequence: parent.version.sequence, outputStateHash: parent.state.stateHash } } } },
        v2ProjectProxyRenderOperation: { async findMany() { return [
          { outputArtifactId: 'artifact-proxy-9x16', outputVariantId: VARIANT }, { outputArtifactId: 'artifact-proxy-concurrent', outputVariantId: VARIANT },
        ] } },
        v2ProjectFinalExportOperation: { async findMany() { return [{ outputArtifactId: 'artifact-final-9x16', outputVariantId: VARIANT, outputAspectRatio: '16:9' }] } },
      })
    },
  })
  await assert.rejects(
    () => driftRepository.commitOrReplay(committed),
    (error) => error.code === 'VERSION_CONFLICT' && /outputs changed/.test(error.message),
  )
  // A Version that does not belong to its Command is refused before a transaction opens.
  await assert.rejects(
    () => new PrismaReviewPatchRepository({ async $transaction() { throw new Error('must not run') } }).commitOrReplay({
      ...committed, bundle: { ...bundle, version: { ...bundle.version, commandId: 'edit-command-of-another-version' } },
    }),
    /does not belong to its Command/,
  )
})
