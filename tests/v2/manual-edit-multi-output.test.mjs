import assert from 'node:assert/strict'
import test from 'node:test'

import { applyManualEditService } from '../../src/v2/application/manual-edit.ts'
import { createCommandArtifactInvalidations } from '../../src/v2/domain/command-impact.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { PrismaManualEditRepository } from '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'
import { assertManualOutputReferencesV3 } from '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
import { readVersionRenderReferences } from '../../src/v2/infrastructure/prisma/version-render-references.ts'
import { twoOutputIngestedWorld } from './helpers/m1b-two-output-world.mjs'
import { recompiledChild } from './helpers/output-world.mjs'
import { persistedOutputQueries } from './helpers/persisted-output-client.mjs'
import { reviewedTimeline } from './helpers/review-timeline.mjs'

/**
 * A project with TWO outputs (16:9 and 9:16). A manual edit changes the ONE EditPlan both outputs re-materialize from, so the
 * `variantId` of the request is the VIEW the edit was made on (a stable State variant) and the impact is the renders of EVERY output.
 * The single-output behaviour of the same service is covered by manual-edit-apply.test.mjs.
 */
const two = await twoOutputIngestedWorld({ sourceDurationSeconds: 6 })
const head = recompiledChild(two.parent, two.actor, reviewedTimeline, { suffix: 'manual-base-two' })
const WIDE = two.wideVariantId
const VERTICAL = two.verticalVariantId
const BOTH = [WIDE, VERTICAL].toSorted()
const crop = { kind: 'crop', clipId: 'clip-1', crop: { x: 0.2, y: 0, width: 0.6, height: 1 } }

const rendersOf = (versionId) => [
  { artifactId: 'artifact-proxy-wide', kind: 'proxy', sourceVersionId: versionId, variantId: WIDE },
  { artifactId: 'artifact-final-wide', kind: 'final', sourceVersionId: versionId, variantId: WIDE },
  { artifactId: 'artifact-proxy-vertical', kind: 'proxy', sourceVersionId: versionId, variantId: VERTICAL },
  { artifactId: 'artifact-final-vertical', kind: 'final', sourceVersionId: versionId, variantId: VERTICAL },
]

function recordOf(bundle) {
  const snapshot = operationalBundlePlanV3(bundle)
  return { version: bundle.version, editPlan: JSON.parse(snapshot.contentJson), editPlanHash: snapshot.contentHash, bundle }
}

/** The repository double a service run needs: the sealed head (and an optional target) as the context, the commits captured. */
function managedRepository(bundle, { target, references = rendersOf(bundle.version.id) } = {}) {
  const captured = { commits: [] }
  const repository = {
    async findIdempotentResult() { return null },
    async readAdoptableObservations() { return [] },
    async readContext() {
      return { ...recordOf(bundle), availableAssetIds: ['artifact-source3'], outputReferences: references, history: [],
        ...(target ? { targetVersion: recordOf(target) } : {}) }
    },
    async commitOrReplay(input) {
      captured.commits.push(input)
      const origin = input.bundle.origin
      return { command: origin.command, version: input.bundle.version, editPlan: JSON.parse(input.bundle.editPlanSnapshot.contentJson),
        timeline: { versionId: input.bundle.version.id }, comparison: input.comparison, impact: input.impact,
        invalidations: createCommandArtifactInvalidations({ impact: input.impact, createdAt: origin.command.createdAt }), replayed: false }
    },
  }
  return { repository, captured }
}

let counter = 0
const serviceFor = (repository) => applyManualEditService({
  repository,
  clock: () => new Date('2026-07-31T19:01:00.000Z'),
  createId: (kind) => `${kind}-manual-two-${++counter}`,
  createEventId: () => '8c196f8c-5da2-4ac7-9c51-7a4cf42575f1',
})

const requestFor = (bundle, overrides) => ({
  workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId,
  baseVersionId: bundle.version.id, baseHash: bundle.version.baseHash, expectedRevision: bundle.version.sequence,
  variantId: VERTICAL, actor: two.actor, ...overrides,
})
const refusalOf = (reason) => (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === reason

test('W66 multi-output a manual edit made on one output stales the renders of EVERY output and seals one child Version', async () => {
  const { repository, captured } = managedRepository(head)
  const service = serviceFor(repository)
  const result = await service(requestFor(head, { action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-two-crop-vertical' }))
  const committed = captured.commits[0], { bundle } = committed, command = bundle.origin.command
  // The view is recorded as the stable variant of the output the edit was made on; the plan the edit changes is shared.
  assert.equal(command.payload.variantId, VERTICAL)
  assert.deepEqual([command.scope.clipIds, command.scope.outputSpecIds], [['clip-1'], [VERTICAL]])
  assert.equal(bundle.origin.kind, 'child-command')
  assert.equal(bundle.state.document.entries.length, 2)
  for (const entry of bundle.state.document.entries) assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)
  assert.deepEqual(result.impact.affectedVariantIds, BOTH)
  assert.deepEqual(result.impact.minimalRenders.map((render) => render.variantId), BOTH)
  assert.deepEqual(result.impact.affectedArtifacts.map((item) => [item.kind, item.artifactId, item.variantId]), [
    ['final', 'artifact-final-vertical', VERTICAL], ['final', 'artifact-final-wide', WIDE],
    ['proxy', 'artifact-proxy-vertical', VERTICAL], ['proxy', 'artifact-proxy-wide', WIDE],
  ])
  assert.deepEqual(result.invalidations.map((row) => row.variantId).toSorted(), [VERTICAL, VERTICAL, WIDE, WIDE])
  assert.equal(committed.event.data.invalidatedArtifactCount, 4)
  assert.equal(committed.event.data.minimalRenderCount, 2)

  // The same edit made from the other output's view: the view is the only difference, the impact lists the same renders.
  const fromWide = await service(requestFor(head, { variantId: WIDE, action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-two-crop-wide' }))
  assert.equal(captured.commits[1].bundle.origin.command.payload.variantId, WIDE)
  for (const field of ['affectedVariantIds', 'affectedArtifacts', 'minimalRenders', 'affectedRanges', 'changeKinds'])
    assert.deepEqual(fromWide.impact[field], result.impact[field], field)
})

test('W66 multi-output a manual edit names an output of its State, or is refused with the published reason and writes nothing', async () => {
  const { repository, captured } = managedRepository(head)
  const service = serviceFor(repository)
  // A stranger, and the two aspect ratios the world's outputs have: the variant is the stable State id, never the format string.
  for (const variantId of ['variant-m1b-stranger', '9:16', '16:9']) {
    await assert.rejects(service(requestFor(head, { variantId, action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: `manual-two-view-${variantId}` })),
      refusalOf('output-variant-unknown'), variantId)
  }
  assert.equal(captured.commits.length, 0)

  // Two outputs of one aspect ratio cannot be told apart by the render pipeline: the view is refused as ambiguous.
  const twin = await twoOutputIngestedWorld({ sourceDurationSeconds: 6, specs: [
    { key: 'wide', variantId: 'variant-m1b-wide', aspectRatio: '16:9', width: 640, height: 360 },
    { key: 'vertical', variantId: 'variant-m1b-twin', aspectRatio: '16:9', width: 640, height: 360 },
  ] })
  const twinHead = recompiledChild(twin.parent, twin.actor, reviewedTimeline, { suffix: 'manual-base-twin' })
  const twinRepository = managedRepository(twinHead, { references: [] })
  await assert.rejects(serviceFor(twinRepository.repository)(requestFor(twinHead, { actor: twin.actor, variantId: 'variant-m1b-twin', action: 'apply',
    targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-twin-view' })), refusalOf('output-variant-ambiguous'))
  assert.equal(twinRepository.captured.commits.length, 0)
})

test('W66 multi-output a render-free selection lists no output, and undo/restore stale the renders of every output', async () => {
  const selected = managedRepository(head)
  const selection = await serviceFor(selected.repository)(requestFor(head, { action: 'apply', targetId: 'clip-1',
    operation: { kind: 'select', clipId: 'clip-1' }, idempotencyKey: 'manual-two-select' }))
  assert.equal(selected.captured.commits[0].bundle.origin.kind, 'inherit-command')
  assert.deepEqual([selection.impact.affectedVariantIds, selection.impact.affectedArtifacts, selection.impact.minimalRenders], [[], [], []])
  assert.deepEqual(selection.invalidations, [])

  const cropped = managedRepository(head)
  await serviceFor(cropped.repository)(requestFor(head, { action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-two-crop-for-undo' }))
  const afterCrop = cropped.captured.commits[0].bundle
  // The sealed restore Version re-derives its own impact from its parent's State, so the bundle builder proves the service's impact.
  const undone = managedRepository(afterCrop, { target: head })
  const undo = await serviceFor(undone.repository)(requestFor(afterCrop, { action: 'undo', targetId: 'clip-1', targetVersionId: head.version.id,
    idempotencyKey: 'manual-two-undo' }))
  const restoreBundle = undone.captured.commits[0].bundle
  assert.equal(restoreBundle.origin.kind, 'restore-command')
  assert.equal(restoreBundle.state.document.entries.length, 2)
  assert.deepEqual(undo.impact.affectedVariantIds, BOTH)
  assert.equal(undo.impact.affectedArtifacts.length, 4)
  assert.deepEqual(undo.invalidations.map((row) => row.variantId).toSorted(), [VERTICAL, VERTICAL, WIDE, WIDE])
})

function contextOf(rows) {
  return new PrismaManualEditRepository({
    $queryRawUnsafe: persistedOutputQueries([...two.chain, head]),
    v2Project: { async findFirst() { return {
      id: head.version.projectId, workspaceId: head.version.workspaceId, format: null, currentVersionId: head.version.id,
      mediaAssets: [{ artifactId: 'artifact-source3' }], versions: [],
    } } },
    v2ProjectProxyRenderOperation: { async findMany() { return rows.proxies } },
    v2ProjectFinalExportOperation: { async findMany() { return rows.finals } },
  }).readContext({ workspaceId: head.version.workspaceId, projectId: head.version.projectId })
}

test('W66 multi-output the context attributes every render of the head to its own output, and refuses a render it cannot attribute exactly', async () => {
  const context = await contextOf({
    proxies: [{ outputArtifactId: 'artifact-proxy-wide', outputVariantId: WIDE }, { outputArtifactId: 'artifact-proxy-vertical', outputVariantId: VERTICAL }],
    finals: [{ outputArtifactId: 'artifact-final-wide', outputVariantId: WIDE, outputAspectRatio: '16:9' },
      // written before the column existed: it names its ratio, which is the 9:16 output's alone
      { outputArtifactId: 'artifact-final-legacy-vertical', outputVariantId: null, outputAspectRatio: '9:16' }],
  })
  assert.deepEqual(context.outputReferences.map((item) => [item.kind, item.artifactId, item.variantId]), [
    ['final', 'artifact-final-legacy-vertical', VERTICAL], ['final', 'artifact-final-wide', WIDE],
    ['proxy', 'artifact-proxy-vertical', VERTICAL], ['proxy', 'artifact-proxy-wide', WIDE],
  ])
  const conflict = (error) => error.code === 'PERSISTENCE_CONFLICT'
  // A proxy written before the column existed names nothing: with two outputs it belongs to neither, so the edit is refused.
  await assert.rejects(contextOf({ proxies: [{ outputArtifactId: 'artifact-proxy-legacy', outputVariantId: null }], finals: [] }), conflict)
  // A final whose ratio matches no output of the State, and a render that names an output the State does not carry, are conflicts too.
  await assert.rejects(contextOf({ proxies: [], finals: [{ outputArtifactId: 'artifact-final-odd', outputVariantId: null, outputAspectRatio: '4:5' }] }), conflict)
  await assert.rejects(contextOf({ proxies: [{ outputArtifactId: 'artifact-proxy-stranger', outputVariantId: 'variant-m1b-stranger' }], finals: [] }), conflict)
})

test('W66 multi-output concurrent render drift on ANY output is refused before anything is written', async () => {
  const { repository, captured } = managedRepository(head)
  await serviceFor(repository)(requestFor(head, { action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-two-drift' }))
  const committed = captured.commits[0]
  const drift = (proxies, finals) => new PrismaManualEditRepository({
    async $transaction(callback) {
      return callback({
        v2EditCommand: { async findUnique() { return null } },
        v2Project: { async findFirst() { return { format: null,
          currentVersion: { id: head.version.id, baseHash: head.version.baseHash, sequence: head.version.sequence, outputStateHash: head.state.stateHash } } } },
        v2ProjectProxyRenderOperation: { async findMany() { return proxies } },
        v2ProjectFinalExportOperation: { async findMany() { return finals } },
      })
    },
  }).commitOrReplay(committed)
  const proxies = [{ outputArtifactId: 'artifact-proxy-wide', outputVariantId: WIDE }, { outputArtifactId: 'artifact-proxy-vertical', outputVariantId: VERTICAL }]
  const finals = [{ outputArtifactId: 'artifact-final-wide', outputVariantId: WIDE, outputAspectRatio: '16:9' },
    { outputArtifactId: 'artifact-final-vertical', outputVariantId: VERTICAL, outputAspectRatio: '9:16' }]
  const outputsChanged = (error) => error.code === 'VERSION_CONFLICT' && /outputs changed/.test(error.message)
  // a new render of one output appeared after the impact was computed
  await assert.rejects(drift([...proxies, { outputArtifactId: 'artifact-proxy-wide-2', outputVariantId: WIDE }], finals), outputsChanged)
  // a published final disappeared
  await assert.rejects(drift(proxies, finals.slice(1)), outputsChanged)
  // the same artifact moved to the other output
  await assert.rejects(drift([{ outputArtifactId: 'artifact-proxy-wide', outputVariantId: VERTICAL }, proxies[1]], finals), outputsChanged)
})

// ---- the persistence checks of a restore (no database: a client that answers the sealed State read of the base Version) ---------

/** A client answering `readStoredOutputStateV3` for the bundles it knows, and the two render tables with the given rows. */
function persistenceClient(bundles, rows) {
  return {
    async $queryRawUnsafe(sql, versionId) {
      assert.ok(sql.startsWith('SELECT v."outputContractVersion",v."baseHash"'), `unexpected raw query: ${sql.slice(0, 80)}`)
      const bundle = bundles.find((candidate) => candidate.version.id === versionId)
      if (!bundle) return []
      return [{ outputContractVersion: bundle.version.outputContractVersion, baseHash: bundle.version.baseHash, outputStateId: bundle.state.document.id,
        outputStateHash: bundle.version.outputStateHash, stateJson: serializeOutputCanonicalJson(bundle.state.document), stateHash: bundle.state.stateHash,
        schemaVersion: bundle.state.document.schemaVersion }]
    },
    v2ProjectProxyRenderOperation: { async findMany() { return rows.proxies } },
    v2ProjectFinalExportOperation: { async findMany() { return rows.finals } },
  }
}

test('W66 multi-output a restore over a Version with published finals of both outputs is no longer refused: every render goes stale', async () => {
  const cropped = managedRepository(head)
  await serviceFor(cropped.repository)(requestFor(head, { action: 'apply', targetId: 'clip-1', operation: crop, idempotencyKey: 'manual-two-crop-for-restore-check' }))
  const afterCrop = cropped.captured.commits[0].bundle
  const undone = managedRepository(afterCrop, { target: head })
  await serviceFor(undone.repository)(requestFor(afterCrop, { action: 'undo', targetId: 'clip-1', targetVersionId: head.version.id, idempotencyKey: 'manual-two-undo-check' }))
  const restoreBundle = undone.captured.commits[0].bundle
  const rows = {
    proxies: [{ outputArtifactId: 'artifact-proxy-wide', outputVariantId: WIDE }, { outputArtifactId: 'artifact-proxy-vertical', outputVariantId: VERTICAL }],
    finals: [{ outputArtifactId: 'artifact-final-wide', outputVariantId: WIDE, outputAspectRatio: '16:9' },
      { outputArtifactId: 'artifact-final-vertical', outputVariantId: VERTICAL, outputAspectRatio: '9:16' }],
  }
  // The base Version of the undo is the cropped one: its renders are what the sealed impact lists.
  const impactOf = restoreBundle.origin.command.payload.impact
  assert.equal(impactOf.affectedArtifacts.length, 4)
  assert.ok(impactOf.affectedArtifacts.every((item) => item.sourceVersionId === afterCrop.version.id))
  await assertManualOutputReferencesV3(persistenceClient([afterCrop], rows), restoreBundle)
  // What is on the database must be exactly what the Command sealed: a render that appeared, or one attributed elsewhere, is refused.
  const invalid = (error) => error.code === 'INVALID_COMMAND' && /differ from persisted base outputs/.test(error.message)
  await assert.rejects(assertManualOutputReferencesV3(persistenceClient([afterCrop], { ...rows, proxies: [...rows.proxies, { outputArtifactId: 'artifact-proxy-late', outputVariantId: WIDE }] }), restoreBundle), invalid)
  await assert.rejects(assertManualOutputReferencesV3(persistenceClient([afterCrop], { ...rows, finals: rows.finals.slice(1) }), restoreBundle), invalid)
  // A render that cannot be attributed exactly is a conflict, not a guess.
  await assert.rejects(assertManualOutputReferencesV3(persistenceClient([afterCrop], { ...rows, proxies: [{ outputArtifactId: 'artifact-proxy-legacy', outputVariantId: null }] }), restoreBundle),
    (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('W66 multi-output the renders of a Version are read in the State that Version seals, or in the State the caller proves carries the same outputs', async () => {
  const rows = { proxies: [{ outputArtifactId: 'artifact-proxy-wide', outputVariantId: WIDE }], finals: [{ outputArtifactId: 'artifact-final-vertical', outputVariantId: null, outputAspectRatio: '9:16' }] }
  const scope = { workspaceId: head.version.workspaceId, projectId: head.version.projectId, versionId: head.version.id }
  const fromStored = await readVersionRenderReferences(persistenceClient([head], rows), scope)
  const fromState = await readVersionRenderReferences(persistenceClient([], rows), { ...scope, state: head.state })
  assert.deepEqual(fromStored, fromState)
  assert.deepEqual(fromStored.map((item) => [item.kind, item.artifactId, item.variantId, item.sourceVersionId]), [
    ['final', 'artifact-final-vertical', VERTICAL, head.version.id], ['proxy', 'artifact-proxy-wide', WIDE, head.version.id],
  ])
  await assert.rejects(readVersionRenderReferences(persistenceClient([], rows), scope), (error) => error.code === 'PERSISTENCE_CONFLICT')
})
