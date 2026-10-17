import assert from 'node:assert/strict'
import test from 'node:test'

import { applyManualEditService } from '../../src/v2/application/manual-edit.ts'
import { createCommandArtifactInvalidations } from '../../src/v2/domain/command-impact.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { PrismaManualEditRepository } from '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'
import { ingestedWorld, recompiledChild } from './helpers/output-world.mjs'
import { persistedOutputQueries } from './helpers/persisted-output-client.mjs'
import { reviewedTimeline } from './helpers/review-timeline.mjs'

const createdAt = '2026-07-31T19:00:00.000Z'

// The head every manual edit starts from: a real sealed Version3/State3 whose EditPlan is the reviewed timeline,
// one stable output variant and its materialization.
const world = await ingestedWorld({ sourceDurationSeconds: 6 })
const head = recompiledChild(world.parent, world.actor, reviewedTimeline, { suffix: 'manual-base' })
const chain = [...world.chain, head]
const VARIANT = head.state.document.entries[0].variantId
const outputsOf = (versionId) => [
  { artifactId: 'artifact-final-variant', kind: 'final', sourceVersionId: versionId, variantId: VARIANT },
  { artifactId: 'artifact-proxy-variant', kind: 'proxy', sourceVersionId: versionId, variantId: VARIANT },
  { artifactId: 'artifact-final-other', kind: 'final', sourceVersionId: versionId, variantId: '16:9' },
]

function recordOf(bundle) {
  const snapshot = operationalBundlePlanV3(bundle)
  return { version: bundle.version, editPlan: JSON.parse(snapshot.contentJson), editPlanHash: snapshot.contentHash, bundle }
}

/** The repository double a service run needs: the sealed head (and an optional target) as the context, the commit captured. */
function managedRepository(bundle, { target } = {}) {
  const captured = { commits: [] }
  const repository = {
    async findIdempotentResult() { return null },
    async readContext() {
      return { ...recordOf(bundle), availableAssetIds: ['artifact-source3'], renderVariantIds: [VARIANT],
        outputReferences: outputsOf(bundle.version.id), history: [], ...(target ? { targetVersion: recordOf(target) } : {}) }
    },
    async commitOrReplay(input) {
      captured.commits.push(input)
      const origin = input.bundle.origin, plan = JSON.parse(input.bundle.editPlanSnapshot.contentJson)
      return { command: origin.command, version: input.bundle.version, editPlan: plan, timeline: { versionId: input.bundle.version.id },
        comparison: input.comparison, impact: input.impact,
        invalidations: createCommandArtifactInvalidations({ impact: input.impact, createdAt: origin.command.createdAt }), replayed: false }
    },
  }
  return { repository, captured }
}

let counter = 0
const serviceFor = (repository) => applyManualEditService({
  repository,
  clock: () => new Date('2026-07-31T19:01:00.000Z'),
  createId: (kind) => `${kind}-manual-${++counter}`,
  createEventId: () => '8c196f8c-5da2-4ac7-9c51-7a4cf42575f1',
})

const requestFor = (bundle, overrides) => ({
  workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId,
  baseVersionId: bundle.version.id, baseHash: bundle.version.baseHash, expectedRevision: bundle.version.sequence,
  variantId: VARIANT, actor: world.actor, ...overrides,
})

const crop = { kind: 'crop', clipId: 'clip-1', crop: { x: 0.2, y: 0, width: 0.6, height: 1 } }

test('T-FR-233 manual crop persists the impact in payload v2, binds it to the outbox event and seals a child Version', async () => {
  const { repository, captured } = managedRepository(head)
  const service = serviceFor(repository)
  const result = await service(requestFor(head, { action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'command-impact-test-1' }))
  const committed = captured.commits[0], { bundle } = committed, command = bundle.origin.command
  assert.equal(command.payload.schemaVersion, 2)
  assert.equal(command.payload.impact.impactHash, result.impact.impactHash)
  assert.equal(committed.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(committed.event.data.invalidatedArtifactCount, 2)
  assert.equal(committed.event.data.minimalRenderCount, 1)
  assert.equal(command.payload.impact.changeKinds[0], 'crop')
  assert.deepEqual(JSON.parse(bundle.editPlanSnapshot.contentJson).videoTracks[0].clips[0].crop, { x: 0.2, y: 0, width: 0.6, height: 1 })
  // A crop recompiles the plan: it is a child Command and every member re-materializes from the new snapshot.
  assert.equal(bundle.origin.kind, 'child-command')
  assert.equal(result.version.outputContractVersion, 3)
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.equal(bundle.state.document.parentStateHash, head.state.stateHash)
  assert.equal(bundle.version.snapshotRefs.editPlan, bundle.editPlanSnapshot.id)
  for (const entry of bundle.state.document.entries) assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)
  await assert.rejects(
    () => service(requestFor(head, { action: 'apply', variantId: 'variant-not-configured', targetId: 'clip-1',
      operation: { kind: 'inspect', clipId: 'clip-1', patch: { layout: 'unsafe-scope' } }, idempotencyKey: 'command-impact-invalid-variant' })),
    (error) => error.code === 'INVALID_ARGUMENT' && /variant/.test(error.message),
  )

  // Concurrent output drift is refused before anything is written.
  const driftRepository = new PrismaManualEditRepository({
    async $transaction(callback) {
      return callback({
        v2EditCommand: { async findUnique() { return null } },
        v2Project: { async findFirst() { return { format: VARIANT,
          currentVersion: { id: head.version.id, baseHash: head.version.baseHash, sequence: head.version.sequence, outputStateHash: head.state.stateHash } } } },
        v2ProjectProxyRenderOperation: { async findMany() { return [{ outputArtifactId: 'artifact-proxy-variant' }, { outputArtifactId: 'artifact-proxy-concurrent' }] } },
        v2ProjectFinalExportOperation: { async findMany() { return [{ outputArtifactId: 'artifact-final-variant', outputAspectRatio: VARIANT }] } },
      })
    },
  })
  await assert.rejects(
    () => driftRepository.commitOrReplay(committed),
    (error) => error.code === 'VERSION_CONFLICT' && /outputs changed/.test(error.message),
  )
  // A head that moved to another State is refused too: the sealed bundle was built from a different parent.
  const movedRepository = new PrismaManualEditRepository({
    async $transaction(callback) {
      return callback({
        v2EditCommand: { async findUnique() { return null } },
        v2Project: { async findFirst() { return { format: VARIANT,
          currentVersion: { id: head.version.id, baseHash: head.version.baseHash, sequence: head.version.sequence, outputStateHash: 'f'.repeat(64) } } } },
      })
    },
  })
  await assert.rejects(() => movedRepository.commitOrReplay(committed), (error) => error.code === 'VERSION_CONFLICT')
  // A Version that does not belong to its Command is refused before a transaction opens.
  await assert.rejects(
    () => new PrismaManualEditRepository({ async $transaction() { throw new Error('must not run') } }).commitOrReplay({
      ...committed, bundle: { ...bundle, version: { ...bundle.version, commandId: 'edit-command-of-another-version' } } }),
    /does not belong to its Command/,
  )
})

test('T-FR-216 a render-free selection inherits and undo/restore return to an exact factual target', async () => {
  const selected = managedRepository(head)
  const selection = await serviceFor(selected.repository)(requestFor(head, {
    action: 'apply', targetId: 'clip-1', operation: { kind: 'select', clipId: 'clip-1' }, idempotencyKey: 'manual-select-1' }))
  const selectionBundle = selected.captured.commits[0].bundle
  assert.equal(selectionBundle.origin.kind, 'inherit-command')
  assert.equal(selection.impact.renderSemanticsChanged, false)
  assert.deepEqual(selection.impact.affectedArtifacts, [])
  assert.equal(selectionBundle.state.document.transition, 'inherit')
  assert.equal(selectionBundle.state.document.parentStateHash, head.state.stateHash)

  // Undo of the crop: the target is the exact direct parent, and the restored Version re-materializes the target's plan.
  const cropped = managedRepository(head)
  await serviceFor(cropped.repository)(requestFor(head, { action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-crop-for-undo' }))
  const afterCrop = cropped.captured.commits[0].bundle
  const undone = managedRepository(afterCrop, { target: head })
  const undo = await serviceFor(undone.repository)(requestFor(afterCrop, {
    action: 'undo', targetId: 'clip-1', targetVersionId: head.version.id, idempotencyKey: 'manual-undo-1' }))
  const restoreBundle = undone.captured.commits[0].bundle
  assert.equal(restoreBundle.origin.kind, 'restore-command')
  assert.equal(restoreBundle.origin.target.versionId, head.version.id)
  assert.equal(restoreBundle.origin.target.stateHash, head.state.stateHash)
  assert.equal(restoreBundle.state.document.transition, 'restore')
  assert.equal(restoreBundle.state.document.parentStateHash, afterCrop.state.stateHash)
  assert.equal(undo.version.sequence, afterCrop.version.sequence + 1)
  const restoredPlan = JSON.parse(restoreBundle.editPlanSnapshot.contentJson)
  assert.equal(restoredPlan.videoTracks[0].clips[0].crop, undefined, 'the crop is gone: the plan is the target plan')
  assert.equal(restoredPlan.manualEditing.action, 'undo')
  for (const entry of restoreBundle.state.document.entries) assert.equal(entry.consumption.materialization.document.planSnapshotId, restoreBundle.editPlanSnapshot.id)
  // Redo and restore name any earlier target; undo may only name the parent.
  await assert.rejects(serviceFor(managedRepository(afterCrop, { target: world.parent }).repository)(requestFor(afterCrop, {
    action: 'undo', targetId: 'clip-1', targetVersionId: world.parent.version.id, idempotencyKey: 'manual-undo-not-parent' })),
  (error) => error.code === 'INVALID_ARGUMENT' && /direct parent/.test(error.message))
})

test('T-FR-233 a stored manual Command is hydrated from its sealed Version and rejects any divergence', async () => {
  const { repository, captured } = managedRepository(head)
  await serviceFor(repository)(requestFor(head, { action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-replay-1' }))
  const { bundle } = captured.commits[0], origin = bundle.origin, command = origin.command, version = bundle.version
  const invalidations = createCommandArtifactInvalidations({ impact: command.payload.impact, createdAt: command.createdAt })
  const rows = {
    command: {
      id: command.id, workspaceId: command.workspaceId, projectId: command.projectId, baseVersionId: command.baseVersionId, baseHash: command.baseHash,
      type: 'manual-edit', scopeJson: stableSerialize(command.scope), payloadJson: stableSerialize(command.payload), reason: null,
      actorType: command.author.type, actorId: command.author.id, delegatedUserId: null, idempotencyKey: command.idempotencyKey,
      actorCredentialId: origin.audit.credentialId, actorEnvironment: origin.audit.environment, actorAuthenticationKind: origin.audit.authenticationKind,
      actorContextHash: origin.audit.contextHash, actorDelegatedIdentityId: null, actorWorkspaceRole: null,
      requestFingerprint: origin.requestFingerprint, commandHash: command.commandHash, createdAt: new Date(command.createdAt),
      baseVersion: { editPlanSnapshot: { contentHash: head.editPlanSnapshot.contentHash } },
      resultVersion: {
        id: version.id, workspaceId: version.workspaceId, projectId: version.projectId, sequence: version.sequence, parentVersionId: version.parentVersionId,
        forkedFromProjectId: null, forkedFromVersionId: null, briefSnapshotId: version.snapshotRefs.brief, treatmentSnapshotId: version.snapshotRefs.treatment ?? null,
        storySnapshotId: version.snapshotRefs.story ?? null, editPlanSnapshotId: version.snapshotRefs.editPlan, policiesSnapshotId: version.snapshotRefs.policies,
        baseHash: version.baseHash, createdBy: version.createdBy, commandId: command.id, createdAt: new Date(version.createdAt),
        outputContractVersion: 3, outputStateId: version.outputStateId, outputStateHash: version.outputStateHash, outputVersionJson: serializeOutputCanonicalJson(version),
        editPlanSnapshot: { contentJson: bundle.editPlanSnapshot.contentJson, contentHash: bundle.editPlanSnapshot.contentHash },
      },
      artifactInvalidations: invalidations.map((item) => ({ ...item, dependencyTypesJson: stableSerialize(item.dependencyTypes),
        affectedRangesJson: stableSerialize(item.affectedRanges), createdAt: new Date(item.createdAt), resolutions: [] })),
    },
  }
  const lookup = { workspaceId: command.workspaceId, projectId: command.projectId, idempotencyKey: command.idempotencyKey, actorContextHash: origin.audit.contextHash }
  const stored = new PrismaManualEditRepository({ v2EditCommand: { async findUnique() { return rows.command } } })
  const replay = await stored.findIdempotentResult(lookup)
  assert.equal(replay.requestFingerprint, origin.requestFingerprint)
  assert.equal(replay.result.replayed, true)
  assert.deepEqual(replay.result.version, version)
  assert.equal(replay.result.command.commandHash, command.commandHash)
  assert.deepEqual(replay.result.invalidations.map((item) => item.artifactId).toSorted(), ['artifact-final-variant', 'artifact-proxy-variant'])

  rows.command.commandHash = 'e'.repeat(64)
  await assert.rejects(stored.findIdempotentResult(lookup), /command seal is invalid/)
  rows.command.commandHash = command.commandHash
  rows.command.resultVersion.baseHash = 'e'.repeat(64)
  await assert.rejects(stored.findIdempotentResult(lookup), /columns differ from its sealed document/)
  rows.command.resultVersion.baseHash = version.baseHash
  rows.command.resultVersion.outputContractVersion = 1
  await assert.rejects(stored.findIdempotentResult(lookup), /no sealed output state/)
})

test('T-FR-233 Prisma context discovers only completed proxy/final outputs for the immutable sealed base', async () => {
  const queries = []
  const versionRows = chain.map((bundle) => ({ id: bundle.version.id, sequence: bundle.version.sequence, parentVersionId: bundle.version.parentVersionId ?? null,
    commandId: bundle.version.commandId ?? null, command: null, createdAt: new Date(bundle.version.createdAt) }))
  const repository = new PrismaManualEditRepository({
    $queryRawUnsafe: persistedOutputQueries(chain),
    v2Project: { async findFirst() { return {
      id: head.version.projectId, workspaceId: head.version.workspaceId, format: VARIANT, currentVersionId: head.version.id,
      mediaAssets: [{ artifactId: 'artifact-source3' }], versions: versionRows.toReversed(),
    } } },
    v2ProjectProxyRenderOperation: { async findMany(query) { queries.push(query); return [{ outputArtifactId: 'artifact-proxy-variant' }] } },
    v2ProjectFinalExportOperation: { async findMany(query) {
      queries.push(query)
      return [{ outputArtifactId: 'artifact-final-variant', outputAspectRatio: VARIANT }, { outputArtifactId: 'artifact-final-16x9', outputAspectRatio: '16:9' }]
    } },
  })
  const context = await repository.readContext({ workspaceId: head.version.workspaceId, projectId: head.version.projectId })
  assert.deepEqual(context.renderVariantIds, [VARIANT])
  assert.deepEqual(context.outputReferences.map((item) => item.artifactId), ['artifact-final-16x9', 'artifact-final-variant', 'artifact-proxy-variant'])
  assert.equal(context.version.id, head.version.id)
  assert.equal(context.bundle.state.stateHash, head.state.stateHash)
  assert.equal(context.editPlanHash, head.editPlanSnapshot.contentHash)
  assert.equal(queries.length, 2)
  for (const query of queries) {
    assert.equal(query.where.workspaceId, head.version.workspaceId)
    assert.equal(query.where.projectId, head.version.projectId)
    assert.equal(query.where.projectVersionId, head.version.id)
    assert.deepEqual(query.where.operation, { status: 'succeeded', phase: 'completed' })
  }
  // A restore target is read from its own sealed bundle, never from loose columns.
  const withTarget = await repository.readContext({ workspaceId: head.version.workspaceId, projectId: head.version.projectId, targetVersionId: world.parent.version.id })
  assert.equal(withTarget.targetVersion.version.id, world.parent.version.id)
  assert.equal(withTarget.targetVersion.bundle.state.stateHash, world.parent.state.stateHash)
})
