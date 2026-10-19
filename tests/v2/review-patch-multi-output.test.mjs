import assert from 'node:assert/strict'
import test from 'node:test'

import { materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { applyReviewPatchService } from '../../src/v2/application/review-patch.ts'
import { applyReviewPatchBatchService } from '../../src/v2/application/review-patch-batch.ts'
import { createCommandArtifactInvalidations } from '../../src/v2/domain/command-impact.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { externalActorAuditData } from '../../src/v2/infrastructure/prisma/external-actor-audit.ts'
import { PrismaReviewPatchBatchRepository } from '../../src/v2/infrastructure/prisma/review-patch-batch-repository.ts'
import { PrismaReviewPatchRepository } from '../../src/v2/infrastructure/prisma/review-patch-repository.ts'
import { twoOutputIngestedWorld } from './helpers/m1b-two-output-world.mjs'
import { recompiledChild } from './helpers/output-world.mjs'
import { persistedOutputQueries } from './helpers/persisted-output-client.mjs'
import { reviewedTimeline } from './helpers/review-timeline.mjs'

/**
 * A review patch (single or batch) edits the ONE EditPlan every output of a project re-materializes from: its impact is the renders of
 * EVERY output, whatever formats the annotation's application scope names. Those formats are checked to be outputs of the State the
 * patch is applied to (`output-variant-unknown` otherwise) and never narrow the impact. The single-output behaviour of the same
 * services is covered by review-patch-apply.test.mjs and review-patch-batch-apply.test.mjs.
 */
const createdAt = '2026-07-31T19:00:00.000Z'
const two = await twoOutputIngestedWorld({ sourceDurationSeconds: 6 })
const head = recompiledChild(two.parent, two.actor, reviewedTimeline, { suffix: 'review-two-base' })
const { workspaceId, projectId } = head.version
const baseVersionId = head.version.id
const WIDE = two.wideVariantId
const VERTICAL = two.verticalVariantId
const BOTH = [WIDE, VERTICAL].toSorted()
const planSnapshot = operationalBundlePlanV3(head)
const audit = materializeActorAuditContext(two.actor)

const renders = [
  { artifactId: 'artifact-proxy-wide', kind: 'proxy', sourceVersionId: baseVersionId, variantId: WIDE },
  { artifactId: 'artifact-final-wide', kind: 'final', sourceVersionId: baseVersionId, variantId: WIDE },
  { artifactId: 'artifact-proxy-vertical', kind: 'proxy', sourceVersionId: baseVersionId, variantId: VERTICAL },
  { artifactId: 'artifact-final-vertical', kind: 'final', sourceVersionId: baseVersionId, variantId: VERTICAL },
]
const annotationOf = (id, formatIds) => ({
  id, projectVersionId: baseVersionId, frame: 30, timeRangeMs: [1000, 1000], screenshotRef: `screenshot-${id}`, scope: 'point', targetIds: ['subtitle:cue-1'],
  applicationScope: { kind: 'frame', targetIds: ['subtitle:cue-1'], formatIds, localeIds: ['pt-BR'], recipeIds: [], global: false },
  affectedCount: 1, text: 'Mover legenda', author: { id: two.actor.clientId, name: two.actor.clientId, type: 'api-client' }, status: 'open', createdAt,
})
const operation = { op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1000] }
const patchOf = (annotationIds) => ({ id: 'patch-two-1', baseVersionId, operations: [operation], annotationIds, estimatedCost: 0, invalidatedRanges: [[1000, 1000]] })
const patchImpact = { operationCount: 1, cost: 0, invalidatedRanges: [[1000, 1000]], changedTargets: ['subtitle:cue-1'], expectedScoreDelta: 3, invalidatedArtifacts: ['proxy', 'final'] }

const ids = (kind, tag) => ({
  'edit-command': `edit-command-${tag}`, 'project-version': `version-${tag}`, 'project-snapshot': `project-snapshot-${tag}`, 'project-output-state': `state-${tag}`,
})[kind]

function singleService(annotation, { captured, tag }) {
  const proposal = { id: `proposal-${tag}`, workspaceId, projectId, annotationId: annotation.id, baseVersionId, status: 'ready',
    interpretationVersion: 'review-patch-interpreter/1.0.0', choices: [], patch: patchOf([annotation.id]), impact: patchImpact, gates: [], createdAt, updatedAt: createdAt }
  let materializations = 0
  return applyReviewPatchService({
    repository: {
      async readApplyContext() {
        return { annotation, parent: head, currentVersion: head.version, editPlan: JSON.parse(planSnapshot.contentJson), editPlanHash: planSnapshot.contentHash,
          policies: {}, availableAssetIds: ['artifact-source3'], outputReferences: renders, proposal }
      },
      async commitOrReplay(input) {
        captured.push(input)
        const command = input.bundle.origin.command
        return { proposal: { id: input.proposalId }, command, version: input.bundle.version, editPlan: JSON.parse(input.bundle.editPlanSnapshot.contentJson),
          comparison: input.comparison, impact: input.impact, invalidations: createCommandArtifactInvalidations({ impact: input.impact, createdAt: command.createdAt }), replayed: false }
      },
    },
    clock: () => new Date('2026-08-01T01:00:00.000Z'),
    createId: (kind) => ids(kind, tag) ?? `materialization-${tag}-${++materializations}`,
    createEventId: () => '3e0a7962-5347-4bef-a810-95ab71340456',
  })({ workspaceId, projectId, proposalId: proposal.id, confirmed: true, actor: two.actor, idempotencyKey: `apply-${tag}` })
}

const refusal = (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'output-variant-unknown'

test('W66 multi-output a review patch scoped to one format stales the renders of EVERY output', async () => {
  const captured = []
  const result = await singleService(annotationOf('annotation-two-1', [VERTICAL]), { captured, tag: 'review-two-1' })
  const { bundle } = captured[0]
  assert.equal(bundle.origin.kind, 'child-command')
  assert.equal(bundle.state.document.entries.length, 2)
  for (const entry of bundle.state.document.entries) assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)
  assert.deepEqual(result.impact.affectedVariantIds, BOTH)
  assert.deepEqual(result.impact.minimalRenders.map((render) => render.variantId), BOTH)
  assert.equal(result.impact.affectedArtifacts.length, 4)
  assert.deepEqual(result.invalidations.map((row) => row.variantId).toSorted(), [VERTICAL, VERTICAL, WIDE, WIDE])
  assert.equal(captured[0].event.data.artifactInvalidationCount, 4)
  // The formats an annotation names never narrow the impact: the same patch scoped to the other format, to both, or to none says the same.
  for (const [index, formatIds] of [[WIDE], BOTH, []].entries()) {
    const other = []
    const again = await singleService(annotationOf('annotation-two-1', formatIds), { captured: other, tag: 'review-two-1' })
    assert.equal(again.impact.impactHash, result.impact.impactHash, `scope ${index}`)
  }
})

test('W66 multi-output a review patch whose annotation names a format its State does not carry is refused and writes nothing', async () => {
  for (const formatIds of [['variant-m1b-stranger'], [VERTICAL, '9:16'], ['16:9']]) {
    const captured = []
    await assert.rejects(singleService(annotationOf('annotation-two-2', formatIds), { captured, tag: 'review-two-2' }), refusal, formatIds.join())
    assert.equal(captured.length, 0)
  }
})

function batchService(entries, patchAnnotationIds, { captured, tag }) {
  const patch = patchOf(patchAnnotationIds)
  const batch = { id: `batch-${tag}`, workspaceId, projectId, baseVersionId, mode: 'all-or-nothing', status: 'ready', patch, impact: patchImpact, conflicts: [],
    items: entries.map(({ annotation }, index) => ({ id: `item-${tag}-${index}`, annotationId: annotation.id, proposalId: `proposal-${tag}-${index}`,
      status: patchAnnotationIds.includes(annotation.id) ? 'included' : 'excluded', operation, conflictIds: [], createdAt, updatedAt: createdAt })),
    createdAt, updatedAt: createdAt }
  let materializations = 0
  return applyReviewPatchBatchService({
    repository: {
      async readApplyContext() {
        return { parent: head, currentVersion: head.version, editPlan: JSON.parse(planSnapshot.contentJson), editPlanHash: planSnapshot.contentHash,
          availableAssetIds: ['artifact-source3'], outputReferences: renders, entries, batch }
      },
      async commitOrReplay(input) {
        captured.push(input)
        const command = input.bundle.origin.command
        return { batch: { id: input.batchId }, command, version: input.bundle.version, editPlan: JSON.parse(input.bundle.editPlanSnapshot.contentJson),
          comparison: input.comparison, impact: input.impact, invalidations: createCommandArtifactInvalidations({ impact: input.impact, createdAt: command.createdAt }), replayed: false }
      },
    },
    clock: () => new Date('2026-08-01T02:00:00.000Z'),
    createId: (kind) => ids(kind, tag) ?? `materialization-${tag}-${++materializations}`,
    createEventId: () => '4e0a7962-5347-4bef-a810-95ab71340456',
  })({ workspaceId, projectId, batchId: batch.id, confirmed: true, actor: two.actor, idempotencyKey: `apply-${tag}` })
}
const entryOf = (annotation) => ({ annotation, proposal: { id: `proposal-of-${annotation.id}` } })

test('W66 multi-output a review batch stales the renders of every output; only the applied annotations are checked against the State', async () => {
  const vertical = annotationOf('annotation-batch-vertical', [VERTICAL]), wide = annotationOf('annotation-batch-wide', [WIDE])
  const captured = []
  const result = await batchService([entryOf(vertical), entryOf(wide)], [vertical.id, wide.id], { captured, tag: 'review-two-batch' })
  assert.equal(result.impact.commandType, 'apply-review-patch-batch')
  assert.deepEqual(result.impact.affectedVariantIds, BOTH)
  assert.equal(result.impact.affectedArtifacts.length, 4)
  assert.equal(result.invalidations.length, 4)
  assert.equal(captured[0].bundle.state.document.entries.length, 2)

  // An annotation the batch leaves out (a partial retry) is not applied, so the formats it names are not checked.
  const stranger = annotationOf('annotation-batch-stranger', ['variant-m1b-stranger'])
  const partial = await batchService([entryOf(vertical), entryOf(stranger)], [vertical.id], { captured: [], tag: 'review-two-partial' })
  assert.deepEqual(partial.impact.affectedVariantIds, BOTH)
  const refused = []
  await assert.rejects(batchService([entryOf(vertical), entryOf(stranger)], [vertical.id, stranger.id], { captured: refused, tag: 'review-two-refused' }), refusal)
  assert.equal(refused.length, 0)
})

// ---- the repositories, over a fake client that answers the sealed bundle reads -----------------------------------------------

const auditFields = { actorClientId: audit.clientId, ...externalActorAuditData(audit, workspaceId, audit.clientId) }
const annotationRow = (annotation) => ({
  id: annotation.id, workspaceId, projectId, projectVersionId: baseVersionId, proxyArtifactId: 'artifact-proxy-vertical', proxyHash: 'd'.repeat(64), frame: annotation.frame,
  timeStartMs: annotation.timeRangeMs[0], timeEndMs: annotation.timeRangeMs[1], screenshotRef: annotation.screenshotRef, scope: annotation.scope,
  regionX: null, regionY: null, regionWidth: null, regionHeight: null, targetIdsJson: JSON.stringify(annotation.targetIds),
  applicationScopeJson: JSON.stringify(annotation.applicationScope), affectedCount: annotation.affectedCount, text: annotation.text,
  authorId: annotation.author.id, authorName: annotation.author.name, authorType: annotation.author.type, status: 'open', createdAt: new Date(createdAt), ...auditFields,
})
const proxies = [{ outputArtifactId: 'artifact-proxy-wide', outputVariantId: WIDE }, { outputArtifactId: 'artifact-proxy-vertical', outputVariantId: VERTICAL }]
const finals = [{ outputArtifactId: 'artifact-final-wide', outputVariantId: WIDE, outputAspectRatio: '16:9' },
  // written before the column existed: it names its ratio, which is the 9:16 output's alone
  { outputArtifactId: 'artifact-final-vertical', outputVariantId: null, outputAspectRatio: '9:16' }]
const readClient = (rows) => ({
  $queryRawUnsafe: persistedOutputQueries([...two.chain, head]),
  v2ProjectProxyRenderOperation: { async findMany() { return rows.proxies } },
  v2ProjectFinalExportOperation: { async findMany() { return rows.finals } },
})

test('W66 multi-output the single review repository lists every output\'s renders and validates the annotation\'s formats at proposal time', async () => {
  const contextFor = (annotation, rows = { proxies, finals }) => new PrismaReviewPatchRepository({
    ...readClient(rows),
    v2ReviewAnnotation: { async findFirst() { return { ...annotationRow(annotation), project: {
      currentVersion: { id: baseVersionId, policiesSnapshot: { contentJson: '{}' } }, mediaAssets: [{ artifactId: 'artifact-source3' }] } } } },
  }).readProposalContext({ workspaceId, projectId, annotationId: annotation.id })
  const context = await contextFor(annotationOf('annotation-repo-1', [VERTICAL]))
  assert.equal('renderVariantIds' in context, false, 'a plan-wide Command has no single format to list')
  assert.deepEqual(context.outputReferences.map((item) => [item.kind, item.artifactId, item.variantId]), [
    ['final', 'artifact-final-vertical', VERTICAL], ['final', 'artifact-final-wide', WIDE],
    ['proxy', 'artifact-proxy-vertical', VERTICAL], ['proxy', 'artifact-proxy-wide', WIDE],
  ])
  await assert.rejects(contextFor(annotationOf('annotation-repo-2', ['9:16'])), refusal)
  await assert.rejects(contextFor(annotationOf('annotation-repo-3', [WIDE]), { proxies: [{ outputArtifactId: 'artifact-proxy-legacy', outputVariantId: null }], finals: [] }),
    (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('W66 multi-output the batch review repository lists every output\'s renders and validates every annotation\'s formats', async () => {
  const vertical = annotationOf('annotation-repo-batch-vertical', [VERTICAL]), wide = annotationOf('annotation-repo-batch-wide', [WIDE])
  const proposalRow = (annotation) => ({
    id: `proposal-of-${annotation.id}`, workspaceId, projectId, annotationId: annotation.id, baseVersionId, status: 'ready', interpretationVersion: 'review-patch-interpreter/1.0.0',
    choicesJson: '[]', patchJson: JSON.stringify(patchOf([annotation.id])), impactJson: JSON.stringify(patchImpact), gatesJson: '[]',
    resultCommandId: null, resultVersionId: null, renderOperationId: null, comparisonJson: null, createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
    annotation: annotationRow(annotation), renderOperation: null, ...auditFields,
  })
  const setFor = (annotations) => new PrismaReviewPatchBatchRepository({
    ...readClient({ proxies, finals }),
    v2Project: { async findFirst() { return { id: projectId, workspaceId, currentVersion: { id: baseVersionId }, mediaAssets: [{ artifactId: 'artifact-source3' }] } } },
    v2ReviewPatchProposal: { async findMany() { return annotations.map(proposalRow) } },
  }).readProposalSet({ workspaceId, projectId, proposalIds: annotations.map((annotation) => `proposal-of-${annotation.id}`) })
  const context = await setFor([vertical, wide])
  assert.equal('renderVariantIds' in context, false)
  assert.equal(context.outputReferences.length, 4)
  assert.deepEqual(new Set(context.outputReferences.map((item) => item.variantId)), new Set(BOTH))
  await assert.rejects(setFor([vertical, annotationOf('annotation-repo-batch-stranger', ['variant-m1b-stranger'])]), refusal)
})

test('W66 multi-output concurrent render drift on ANY output is refused by both review repositories before anything is written', async () => {
  const outputsChanged = (error) => error.code === 'VERSION_CONFLICT' && /outputs changed/.test(error.message)
  // The client answers the replay read (nothing applied yet); the transaction answers the guarded commit.
  const transaction = (rows) => ({
    v2ReviewPatchProposal: { async findFirst() { return null } },
    v2ReviewPatchBatch: { async findFirst() { return null } },
    async $transaction(callback) {
      return callback({
        v2ReviewPatchProposal: { async findFirst() { return { id: 'proposal-drift', status: 'ready', baseVersionId } } },
        v2ReviewPatchBatch: { async findFirst() { return { id: 'batch-drift', status: 'ready', mode: 'all-or-nothing', baseVersionId,
          items: [{ status: 'included', annotationId: 'annotation-drift', proposalId: 'proposal-drift' }] } } },
        v2Project: { async findFirst() { return { format: null,
          currentVersion: { id: baseVersionId, sequence: head.version.sequence, outputStateHash: head.state.stateHash } } } },
        v2ProjectProxyRenderOperation: { async findMany() { return rows.proxies } },
        v2ProjectFinalExportOperation: { async findMany() { return rows.finals } },
      })
    },
  })
  const vertical = annotationOf('annotation-drift', [VERTICAL])
  const single = []
  await singleService(vertical, { captured: single, tag: 'review-two-drift' })
  const exactFinals = [{ outputArtifactId: 'artifact-final-wide', outputVariantId: WIDE, outputAspectRatio: '16:9' },
    { outputArtifactId: 'artifact-final-vertical', outputVariantId: VERTICAL, outputAspectRatio: '9:16' }]
  const singleRepository = (rows) => new PrismaReviewPatchRepository(transaction(rows)).commitOrReplay(single[0])
  // a new render of the OTHER output appeared after the impact was computed; a final disappeared
  await assert.rejects(singleRepository({ proxies: [...proxies, { outputArtifactId: 'artifact-proxy-wide-2', outputVariantId: WIDE }], finals: exactFinals }), outputsChanged)
  await assert.rejects(singleRepository({ proxies, finals: exactFinals.slice(1) }), outputsChanged)

  const batch = []
  const wide = annotationOf('annotation-drift-wide', [WIDE])
  await batchService([entryOf(vertical), entryOf(wide)], [vertical.id, wide.id], { captured: batch, tag: 'review-two-batch-drift' })
  const batchRepository = (rows) => new PrismaReviewPatchBatchRepository(transaction(rows)).commitOrReplay(batch[0])
  await assert.rejects(batchRepository({ proxies: [...proxies, { outputArtifactId: 'artifact-proxy-vertical-2', outputVariantId: VERTICAL }], finals: exactFinals }), outputsChanged)
  await assert.rejects(batchRepository({ proxies: proxies.slice(1), finals: exactFinals }), outputsChanged)
})
