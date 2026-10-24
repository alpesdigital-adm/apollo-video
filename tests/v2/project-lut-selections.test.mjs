import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { setProjectLutSelectionService } from '../../src/v2/application/project-lut-selections.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { createProjectLutSelection, projectLutRef } from '../../src/v2/domain/project-lut-selection.ts'
import { createWorkspaceLutVersion } from '../../src/v2/domain/workspace-lut.ts'
import { createProjectLutSelectionImpact, createProjectLutSelectionInvalidations, parseProjectLutSelectionImpact } from '../../src/v2/domain/project-lut-selection-impact.ts'
import { LocalProjectLutRenderMaterializer } from '../../src/v2/infrastructure/media/local-project-lut-render-materializer.ts'
import { PrismaProjectLutSelectionRepository } from '../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts'
import { parseSetProjectLutSelectionBody, presentProjectLutSelectionResult } from '../../src/v2/public-api/project-lut-selection-contract.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { creationRequest, ingestedWorld, outputWorld, variantRequest, worldActor } from './helpers/output-world.mjs'

const cube = `LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`

// The parent of every Command below is a real sealed Version3/State3 from the shared output world.
let ingestedPromise
const ingested = () => (ingestedPromise ??= ingestedWorld())
// The same recording ingested into a project with TWO outputs (the published variant and a sibling): one EditPlan, two State entries.
let twoOutputPromise
const twoOutputs = () => (twoOutputPromise ??= ingestedWorld({ sibling: true }))
const variantIdsOf = (parent) => parent.state.document.entries.map((entry) => entry.variantId)
async function emptyVariantParent() {
  const world = outputWorld(), root = await world.create(creationRequest(world))
  return { parent: (await world.variant(variantRequest(world, root.bundle))).bundle, actor: world.actor }
}

function lutVersion(workspaceId) {
  return createWorkspaceLutVersion({
    id: 'workspace-lut-version-project-2', workspaceId, lutId: 'workspace-lut-project', version: 2,
    name: 'Approved project look', owner: 'Apollo Studio', license: { policy: 'owned', name: 'Workspace' }, tags: ['approved'],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.65, cubeContent: cube,
    preview: { byteSize: 128, sha256: 'b'.repeat(64) }, createdByClientId: 'client-project-lut', createdAt: '2026-07-31T16:59:00.000Z',
  })
}

const durationOf = (parent) => JSON.parse(operationalBundlePlanV3(parent).contentJson).durationFrames

function memoryRepository(parent, context = {}) {
  const replays = new Map()
  let current = null
  const frames = durationOf(parent)
  return {
    commits: [],
    async findIdempotent({ idempotencyKey }) { return replays.get(idempotencyKey) ?? null },
    async readContext() {
      return {
        parent,
        currentDurationFrames: frames,
        variantIds: variantIdsOf(parent),
        outputReferences: [{ artifactId: 'artifact-project-lut-proxy-base', kind: 'proxy', sourceVersionId: parent.version.id, variantId: variantIdsOf(parent)[0] }],
        ...context,
      }
    },
    async commitOrReplay(input) {
      const command = input.bundle.origin.command
      const impact = parseProjectLutSelectionImpact(command.payload.impact)
      const invalidations = createProjectLutSelectionInvalidations({ impact, createdAt: command.createdAt })
      const result = Object.freeze({ command, version: input.bundle.version, selection: input.selection, impact, invalidations, replayed: false })
      this.commits.push(input); current = result
      replays.set(command.idempotencyKey, Object.freeze({ requestFingerprint: input.bundle.origin.requestFingerprint, result: Object.freeze({ ...result, replayed: true }) }))
      return result
    },
    async readCurrent() { return current },
  }
}

function service(repository) {
  const ids = { command: 0, version: 0, selection: 0, snapshot: 0, state: 0, materialization: 0 }
  return setProjectLutSelectionService({
    repository, createId: (kind) => `project-lut-${kind}-test-${++ids[kind]}`, createEventId: () => '00000000-0000-4000-8000-000000000181',
    clock: () => new Date('2026-10-16T17:01:00.000Z'),
  })
}

const requestFor = (parent, actor, extra = {}) => ({
  workspaceId: parent.version.workspaceId, projectId: parent.version.projectId, baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
  actor, ...extra,
})

test('T-FR-181 workspace default resolves to an exact immutable LUT in a Command and new ProjectVersion', async () => {
  const { parent, actor } = await ingested(); const lut = lutVersion(parent.version.workspaceId)
  const originalPlanJson = stableSerialize(JSON.parse(operationalBundlePlanV3(parent).contentJson))
  const repository = memoryRepository(parent, { workspaceDefaultRevision: 3, resolvedLutVersion: lut })
  const apply = service(repository)
  const request = requestFor(parent, actor, { selection: { mode: 'workspace-default' }, reason: 'Use the approved look.', idempotencyKey: 'project-lut-selection-default-1' })
  const result = await apply(request)
  const bundle = repository.commits[0].bundle

  assert.equal(result.command.type, 'set-project-lut-selection')
  assert.equal(result.command.payload.schemaVersion, 2)
  assert.equal(result.command.payload.mode, 'workspace-default')
  assert.equal(result.command.payload.intensity, 0.65)
  assert.equal(result.version.outputContractVersion, 3)
  assert.equal(result.version.sequence, parent.version.sequence + 1)
  assert.equal(result.version.parentVersionId, parent.version.id)
  assert.notEqual(result.version.snapshotRefs.editPlan, parent.version.snapshotRefs.editPlan)
  assert.deepEqual({ ...result.version.snapshotRefs, editPlan: parent.version.snapshotRefs.editPlan }, parent.version.snapshotRefs)
  // the sealed State the Version is bound to inherits every output member and re-materializes it
  assert.equal(bundle.version, result.version)
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.equal(bundle.state.document.parentStateHash, parent.state.stateHash)
  assert.deepEqual(bundle.state.document.entries.map((entry) => entry.variantId), parent.state.document.entries.map((entry) => entry.variantId))
  assert.equal(bundle.origin.kind, 'child-command')
  assert.deepEqual(bundle.origin.replaces, [])
  const committedPlan = JSON.parse(bundle.editPlanSnapshot.contentJson)
  const parentPlan = JSON.parse(operationalBundlePlanV3(parent).contentJson)
  assert.equal(committedPlan.projectVersionId, result.version.id)
  assert.equal(committedPlan.id, `edit-plan-${result.version.id}`)
  assert.deepEqual({ ...committedPlan, id: parentPlan.id, projectVersionId: parentPlan.projectVersionId, createdAt: parentPlan.createdAt }, parentPlan)
  assert.equal(bundle.editPlanSnapshot.contentHash, calculateCanonicalHash(committedPlan))
  assert.equal(bundle.editPlanSnapshot.id, result.version.snapshotRefs.editPlan)
  assert.equal(stableSerialize(parentPlan), originalPlanJson)
  assert.equal(result.version.commandId, result.command.id)
  assert.equal(result.selection.workspaceDefaultRevision, 3)
  assert.equal(result.selection.resolved.mode, 'lut-version')
  assert.deepEqual(result.selection.resolved.lut, {
    lutId: lut.lutId, versionId: lut.id, version: 2, name: lut.name, recordHash: lut.recordHash, cubeContentHash: lut.cube.contentHash,
  })
  assert.match(result.selection.selectionHash, /^[a-f0-9]{64}$/)
  assert.equal(repository.commits[0].event.type, 'project.version.created')
  assert.deepEqual(result.impact.dependencyTypes, ['visual'])
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: parentPlan.durationFrames }])
  assert.deepEqual(result.impact.minimalRenders, [{ kind: 'proxy', variantId: variantIdsOf(parent)[0], ranges: [{ startFrame: 0, endFrame: parentPlan.durationFrames }] }])
  assert.deepEqual(result.impact.affectedArtifacts.map((artifact) => artifact.variantId), [variantIdsOf(parent)[0]])
  assert.equal(result.invalidations.length, 1)
  assert.equal(repository.commits[0].event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(repository.commits[0].event.data.createdAt, result.version.createdAt)
  assert.equal(bundle.origin.audit.credentialId, 'credential-output-http')
  assert.match(bundle.origin.audit.contextHash, /^[a-f0-9]{64}$/)
  assert.equal((await apply(request)).replayed, true)
  await assert.rejects(apply({ ...request, selection: { mode: 'none' } }), /another project LUT selection/)
  await assert.rejects(
    apply({ ...request, actor: worldActor({ credentialId: 'credential-project-lut-other' }) }),
    /another project LUT selection/,
  )
})

test('T-FR-181 explicit none is version-bound and stale project bases are rejected before commit', async () => {
  const { parent } = await ingested(); const repository = memoryRepository(parent)
  const apply = service(repository)
  const common = requestFor(parent, { type: 'director', id: 'director-project-lut' }, { selection: { mode: 'none' }, intensity: 0.4, idempotencyKey: 'project-lut-selection-none-1' })
  await assert.rejects(apply({ ...common, baseHash: 'c'.repeat(64) }), /stale/)
  assert.equal(repository.commits.length, 0)
  const result = await apply(common)
  assert.deepEqual(result.selection.resolved, { mode: 'none' })
  assert.equal(result.selection.workspaceDefaultRevision, undefined)
  assert.equal(result.selection.intensity, 0.4)
  // an internal author carries no credential audit, and the Version is attributed to it
  assert.equal(repository.commits[0].bundle.origin.audit, null)
  assert.equal(result.version.createdBy, 'director-project-lut')
})

test('T-FR-233 LUT selection requests a full proxy without fabricating stale rows when no base output exists', async () => {
  const { parent, actor } = await ingested()
  const repository = memoryRepository(parent, { outputReferences: [] })
  const result = await service(repository)(requestFor(parent, actor, { selection: { mode: 'none' }, idempotencyKey: 'project-lut-selection-no-output-1' }))
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.invalidations, [])
  assert.equal(result.impact.minimalRenders.length, 1)
})

test('T-FR-233 LUT selection before a timeline defers rendering without fabricating impact', async () => {
  const { parent, actor } = await emptyVariantParent()
  const repository = memoryRepository(parent, { outputReferences: [] })
  const result = await service(repository)(requestFor(parent, actor, { selection: { mode: 'none' }, idempotencyKey: 'project-lut-selection-deferred-1' }))
  assert.equal(result.impact.renderDeferredUntilTimeline, true)
  assert.deepEqual(result.impact.affectedRanges, [])
  assert.deepEqual(result.impact.affectedVariantIds, [])
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.impact.minimalRenders, [])
  assert.deepEqual(result.invalidations, [])
  const bundle = repository.commits[0].bundle
  const persistedPlan = JSON.parse(bundle.editPlanSnapshot.contentJson)
  assert.equal(persistedPlan.durationFrames, 0)
  assert.equal(persistedPlan.projectVersionId, result.version.id)
  // an empty timeline keeps every member blocked: nothing is materialized from a plan with no content
  assert.ok(bundle.state.document.entries.length > 0)
  assert.ok(bundle.state.document.entries.every((entry) => entry.consumption.status === 'blocked'))
})

test('T-FR-181 a selection that does not belong to the Command of its Version is rejected before opening a transaction', async () => {
  const { parent, actor } = await ingested()
  const memory = memoryRepository(parent)
  await service(memory)(requestFor(parent, actor, { selection: { mode: 'none' }, idempotencyKey: 'project-lut-invalid-binding' }))
  const committed = memory.commits[0]
  let transactionOpened = false
  const repository = new PrismaProjectLutSelectionRepository({
    async $transaction() { transactionOpened = true; throw new Error('must not run') },
  })
  await assert.rejects(repository.commitOrReplay({
    ...committed,
    selection: { ...committed.selection, commandId: 'project-lut-command-of-another-version' },
  }), /does not belong to the Command that produced its Version/)
  assert.equal(transactionOpened, false)
})

test('T-FR-242 project LUT selection rejects an unauthenticated external actor', async () => {
  const { parent } = await ingested()
  const repository = memoryRepository(parent)
  await assert.rejects(service(repository)(requestFor(parent, { type: 'api-client', id: 'client-project-lut' },
    { selection: { mode: 'none' }, idempotencyKey: 'project-lut-selection-raw-client' })), /not trusted/)
  assert.equal(repository.commits.length, 0)
})

test('T-FR-242 project LUT command hydration rejects a tampered credential audit', async () => {
  const { parent, actor } = await ingested()
  const memory = memoryRepository(parent, { outputReferences: [] })
  await service(memory)(requestFor(parent, actor, { selection: { mode: 'none' }, idempotencyKey: 'project-lut-selection-audit-hydration' }))
  const committed = memory.commits[0], origin = committed.bundle.origin, command = origin.command, version = committed.bundle.version
  const commandRow = {
    id: command.id,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    baseVersionId: command.baseVersionId,
    baseHash: command.baseHash,
    type: command.type,
    scopeJson: stableSerialize(command.scope),
    payloadJson: stableSerialize(command.payload),
    reason: command.reason ?? null,
    actorType: command.author.type,
    actorId: command.author.id,
    delegatedUserId: command.author.delegatedUserId ?? null,
    actorCredentialId: origin.audit.credentialId,
    actorEnvironment: origin.audit.environment,
    actorAuthenticationKind: origin.audit.authenticationKind,
    actorContextHash: origin.audit.contextHash,
    actorDelegatedIdentityId: null,
    actorWorkspaceRole: null,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: origin.requestFingerprint,
    commandHash: command.commandHash,
    createdAt: new Date(command.createdAt),
    artifactInvalidations: [],
  }
  // the persisted Version row of contract three: columns plus the sealed document they must agree with
  const resultVersion = {
    id: version.id,
    workspaceId: version.workspaceId,
    projectId: version.projectId,
    sequence: version.sequence,
    parentVersionId: version.parentVersionId,
    forkedFromProjectId: null,
    forkedFromVersionId: null,
    briefSnapshotId: version.snapshotRefs.brief,
    treatmentSnapshotId: version.snapshotRefs.treatment ?? null,
    storySnapshotId: version.snapshotRefs.story ?? null,
    editPlanSnapshotId: version.snapshotRefs.editPlan,
    policiesSnapshotId: version.snapshotRefs.policies,
    baseHash: version.baseHash,
    createdBy: version.createdBy,
    commandId: command.id,
    createdAt: new Date(version.createdAt),
    outputContractVersion: 3,
    outputStateId: version.outputStateId,
    outputStateHash: version.outputStateHash,
    outputVersionJson: serializeOutputCanonicalJson(version),
  }
  const selection = committed.selection
  const selectionRow = {
    id: selection.id,
    workspaceId: selection.workspaceId,
    projectId: selection.projectId,
    commandId: selection.commandId,
    baseVersionId: selection.baseVersionId,
    resultVersionId: selection.resultVersionId,
    requestedMode: selection.requested.mode,
    requestedLutId: null,
    requestedLutVersion: null,
    resolvedMode: selection.resolved.mode,
    resolvedLutVersionId: null,
    workspaceDefaultRevision: null,
    intensity: selection.intensity,
    selectionJson: stableSerialize(selection),
    selectionHash: selection.selectionHash,
    createdAt: new Date(selection.createdAt),
    command: commandRow,
    resultVersion,
    resolvedLutVersion: null,
  }
  const repository = new PrismaProjectLutSelectionRepository({
    v2EditCommand: { async findUnique() { return { id: commandRow.id, requestFingerprint: commandRow.requestFingerprint } } },
    v2ProjectLutSelection: { async findUnique() { return selectionRow } },
  })
  const lookup = { workspaceId: parent.version.workspaceId, projectId: parent.version.projectId, idempotencyKey: command.idempotencyKey }
  const replay = await repository.findIdempotent(lookup)
  assert.equal(replay.result.command.author.id, actor.clientId)
  assert.deepEqual(replay.result.version, version)
  resultVersion.baseHash = 'e'.repeat(64)
  await assert.rejects(repository.findIdempotent(lookup), /columns differ from its sealed document/)
  resultVersion.baseHash = version.baseHash
  commandRow.actorCredentialId = 'credential-project-lut-tampered'
  await assert.rejects(repository.findIdempotent(lookup), /command audit/)
})

test('W66 multi-output: a LUT selection on a project with two outputs lists the renders of EVERY output and one minimal proxy render per output', async () => {
  const { parent, actor } = await twoOutputs()
  const variantIds = variantIdsOf(parent)
  assert.equal(variantIds.length, 2)
  assert.equal(new Set(variantIds).size, 2)
  const references = variantIds.map((variantId, index) => ({ artifactId: `artifact-project-lut-proxy-${index}`, kind: 'proxy', sourceVersionId: parent.version.id, variantId }))
  const repository = memoryRepository(parent, { variantIds, outputReferences: references })
  // The request names no output: the Command is project-wide.
  const request = requestFor(parent, actor, { selection: { mode: 'none' }, idempotencyKey: 'project-lut-selection-two-outputs-1' })
  assert.equal('variantId' in request, false)
  const result = await service(repository)(request)
  const frames = durationOf(parent), sorted = [...variantIds].sort()

  // the child Version carries EVERY entry, re-materialized from the one plan, with the spec of each output untouched
  const state = repository.commits[0].bundle.state.document
  assert.deepEqual(state.entries.map((entry) => entry.variantId), parent.state.document.entries.map((entry) => entry.variantId))
  for (const [index, entry] of state.entries.entries()) {
    const before = parent.state.document.entries[index]
    assert.equal(entry.outputSpecRevisionId, before.outputSpecRevisionId)
    assert.equal(entry.specHash, before.specHash)
    assert.equal(entry.consumption.status, 'materialized')
  }
  // the impact: every output, each render under its own output, one minimal proxy render per output over the whole timeline
  assert.deepEqual(result.impact.affectedVariantIds, sorted)
  assert.deepEqual(result.impact.affectedArtifacts.map((artifact) => [artifact.artifactId, artifact.variantId]).toSorted(),
    references.map((reference) => [reference.artifactId, reference.variantId]).toSorted())
  assert.deepEqual(result.impact.minimalRenders, sorted.map((variantId) => ({ kind: 'proxy', variantId, ranges: [{ startFrame: 0, endFrame: frames }] })))
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: frames }])
  assert.equal(result.invalidations.length, 2)
  assert.deepEqual(result.invalidations.map((invalidation) => invalidation.variantId).toSorted(), sorted)
  // the sealed document survives its own parser, byte for byte
  assert.equal(parseProjectLutSelectionImpact(JSON.parse(stableSerialize(result.impact))).impactHash, result.impact.impactHash)
  assert.equal(result.command.payload.impact.impactHash, result.impact.impactHash)
})

test('W66 multi-output: an output with no render yet still gets its minimal proxy render, whatever order the State lists its outputs in', async () => {
  const { parent, actor } = await twoOutputs()
  const variantIds = variantIdsOf(parent)
  const onlyFirst = [{ artifactId: 'artifact-project-lut-proxy-only', kind: 'proxy', sourceVersionId: parent.version.id, variantId: variantIds[0] }]
  const forward = await service(memoryRepository(parent, { variantIds, outputReferences: onlyFirst }))(requestFor(parent, actor, { selection: { mode: 'none' }, idempotencyKey: 'project-lut-selection-two-outputs-2' }))
  const reversed = await service(memoryRepository(parent, { variantIds: [...variantIds].reverse(), outputReferences: onlyFirst }))(requestFor(parent, actor, { selection: { mode: 'none' }, idempotencyKey: 'project-lut-selection-two-outputs-3' }))
  // a render exists for one output only: it is the only stale artifact, but BOTH outputs need rendering again
  assert.deepEqual(forward.impact.affectedVariantIds, [variantIds[0]])
  assert.equal(forward.impact.affectedArtifacts.length, 1)
  assert.deepEqual(forward.impact.minimalRenders.map((render) => render.variantId), [...variantIds].sort())
  assert.equal(forward.invalidations.length, 1)
  assert.deepEqual(reversed.impact.minimalRenders, forward.impact.minimalRenders)
})

test('W66 multi-output: the impact document refuses a render of a stranger, duplicated variants and a renderable project with no output', () => {
  const base = {
    commandId: 'command-lut-two-outputs', baseVersionId: 'version-lut-two-outputs-base', resultVersionId: 'version-lut-two-outputs-result',
    selectionId: 'selection-lut-two-outputs', selectionHash: 'e'.repeat(64), resolvedMode: 'none', intensity: 1, durationFrames: 90,
  }
  const reference = (variantId) => ({ artifactId: `artifact-${variantId}`, kind: 'proxy', sourceVersionId: base.baseVersionId, variantId })
  const ok = createProjectLutSelectionImpact({ ...base, variantIds: ['variant-wide', 'variant-vertical'], outputReferences: [reference('variant-wide'), reference('variant-vertical')] })
  assert.deepEqual(ok.minimalRenders.map((render) => render.variantId), ['variant-vertical', 'variant-wide'])
  assert.throws(() => createProjectLutSelectionImpact({ ...base, variantIds: ['variant-wide'], outputReferences: [reference('variant-vertical')] }), /not an output of the project/)
  assert.throws(() => createProjectLutSelectionImpact({ ...base, variantIds: ['variant-wide', 'variant-wide'], outputReferences: [] }), /duplicated/)
  assert.throws(() => createProjectLutSelectionImpact({ ...base, variantIds: [], outputReferences: [] }), /every output/)
  assert.throws(() => createProjectLutSelectionImpact({ ...base, variantIds: 'variant-wide', outputReferences: [] }), /must be a list/)
  // before a timeline there is nothing to render and no output may hold a render
  const deferred = createProjectLutSelectionImpact({ ...base, durationFrames: 0, variantIds: ['variant-wide', 'variant-vertical'], outputReferences: [] })
  assert.deepEqual(deferred.minimalRenders, [])
  assert.equal(parseProjectLutSelectionImpact(JSON.parse(stableSerialize(deferred))).impactHash, deferred.impactHash)
  // a stored document whose minimal renders are not one proxy render per output of the same range is not accepted
  const stored = JSON.parse(stableSerialize(ok))
  assert.throws(() => parseProjectLutSelectionImpact({ ...stored, minimalRenders: [stored.minimalRenders[0], { ...stored.minimalRenders[0] }] }), /duplicated/)
  assert.throws(() => parseProjectLutSelectionImpact({ ...stored, minimalRenders: [stored.minimalRenders[0], { ...stored.minimalRenders[1], ranges: [{ startFrame: 0, endFrame: 45 }] }] }), /invalid/)
  assert.throws(() => parseProjectLutSelectionImpact({ ...stored, minimalRenders: [] }), /invalid/)
  assert.throws(() => parseProjectLutSelectionImpact({ ...stored, minimalRenders: stored.minimalRenders.slice(0, 1) }), /not an output of the project/)
})

test('project LUT impact survives canonical persistence key ordering', () => {
  const impact = createProjectLutSelectionImpact({
    commandId: 'command-lut-persistence',
    baseVersionId: 'version-lut-persistence-base',
    resultVersionId: 'version-lut-persistence-result',
    selectionId: 'selection-lut-persistence',
    selectionHash: 'e'.repeat(64),
    resolvedMode: 'none',
    intensity: 0.75,
    durationFrames: 180,
    variantIds: ['variant-lut-persistence'],
    outputReferences: [],
  })
  const persisted = JSON.parse(stableSerialize(impact))

  assert.deepEqual(parseProjectLutSelectionImpact(persisted), persisted)
  assert.equal(parseProjectLutSelectionImpact(persisted).impactHash, impact.impactHash)
})

test('T-FR-181 public project LUT selection contract is exact and hides persistence fields', () => {
  assert.deepEqual(parseSetProjectLutSelectionBody({
    baseVersionId: 'project-version-lut-base-1', baseHash: 'a'.repeat(64), selection: { mode: 'lut-version', lutId: 'workspace-lut-project', version: 2 }, intensity: 0.5,
  }).selection, { mode: 'lut-version', lutId: 'workspace-lut-project', version: 2 })
  assert.throws(() => parseSetProjectLutSelectionBody({ baseVersionId: 'base', baseHash: 'a'.repeat(64), selection: { mode: 'none', lutId: 'hidden' } }), /cannot identify/)
  assert.throws(() => parseSetProjectLutSelectionBody({ baseVersionId: 'base', baseHash: 'a'.repeat(64), selection: { mode: 'none' }, hidden: true }), /unknown fields/)

  const base = { id: 'project-version-lut-base-1', baseHash: 'a'.repeat(64), createdAt: '2026-07-31T17:00:00.000Z' }; const selection = {
    id: 'selection', requested: { mode: 'none' }, resolved: { mode: 'none' }, intensity: 1, selectionHash: 'd'.repeat(64), createdAt: '2026-07-31T17:01:00.000Z',
  }
  const impact = createProjectLutSelectionImpact({
    commandId: 'command', baseVersionId: base.id, resultVersionId: 'result', selectionId: selection.id,
    selectionHash: selection.selectionHash, resolvedMode: 'none', intensity: selection.intensity,
    durationFrames: 180, variantIds: ['variant-lut-presented'], outputReferences: [],
  })
  const presented = presentProjectLutSelectionResult({
    command: { id: 'command', type: 'set-project-lut-selection', baseVersionId: base.id, author: { type: 'api-client', id: 'client' }, createdAt: selection.createdAt },
    version: { ...base, id: 'result', sequence: 2, parentVersionId: base.id, commandId: 'command' }, selection, impact,
    invalidations: createProjectLutSelectionInvalidations({ impact, createdAt: selection.createdAt }), replayed: false,
  })
  assert.equal('workspaceId' in presented.selection, false)
  assert.equal('payload' in presented.command, false)
  assert.equal(presented.impact.impactHash, impact.impactHash)
  assert.deepEqual(presented.invalidations, [])
  assert.equal(presented.version.visibleState.label, 'current')
  assert.equal(presented.version.visibleState.primaryAction, 'open-result')
  assert.equal(Object.isFrozen(presented.version.visibleState), true)
})

test('T-FR-236 project LUT read and set expose the current selection version state', () => {
  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
  assert.equal(capabilities.get('apollo.projects.lut-selection.read').version, '3.0.0')
  assert.equal(capabilities.get('apollo.projects.lut-selection.read').outputSchemaRef, 'apollo://schemas/project-lut-selection-response/v3')
  assert.equal(capabilities.get('apollo.projects.lut-selection.set').version, '4.0.0')
  assert.equal(capabilities.get('apollo.projects.lut-selection.set').outputSchemaRef, 'apollo://schemas/project-lut-selection-applied/v4')
  assert.equal(getPublicSchema('apollo://schemas/project-lut-selection-response/v2').ref, 'apollo://schemas/project-lut-selection-response/v2')
  assert.equal(getPublicSchema('apollo://schemas/project-lut-selection-applied/v2').ref, 'apollo://schemas/project-lut-selection-applied/v2')

  for (const ref of [
    'apollo://schemas/project-lut-selection-response/v3',
    'apollo://schemas/project-lut-selection-applied/v4',
  ]) {
    const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
      .compile(getPublicSchema(ref).schema)
    for (const example of publicSchemaExamples(getPublicSchema(ref))) {
      assert.equal(validate(example), true, `${ref}: ${JSON.stringify(validate.errors)}`)
      const mismatched = structuredClone(example)
      const version = mismatched.data.result?.version ?? mismatched.data.version
      version.visibleState.label = 'superseded'
      assert.equal(validate(mismatched), false, ref)
    }
  }
})

test('T-FR-181 worker materializes the exact selected cube and intensity outside the renderer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-project-lut-materializer-'))
  try {
    const creativeCube = `LUT_3D_SIZE 2
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
`
    const lut = createWorkspaceLutVersion({
      id: 'workspace-lut-materialized-1', workspaceId: 'workspace-project-lut', lutId: 'workspace-lut-materialized', version: 1,
      name: 'Materialized look', owner: 'Apollo Studio', license: { policy: 'owned', name: 'Workspace' },
      compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.5, cubeContent: creativeCube,
      preview: { byteSize: 128, sha256: 'e'.repeat(64) }, createdByClientId: 'client-project-lut', createdAt: '2026-07-31T17:02:00.000Z',
    })
    const alternateLut = createWorkspaceLutVersion({
      id: 'workspace-lut-alternate-1', workspaceId: lut.workspaceId, lutId: 'workspace-lut-alternate', version: 1,
      name: 'Alternate look', owner: 'Apollo Studio', license: { policy: 'licensed', name: 'Workspace' },
      compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.75,
      cubeContent: `LUT_3D_SIZE 2\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n`,
      preview: { byteSize: 128, sha256: 'd'.repeat(64) }, createdByClientId: 'client-project-lut', createdAt: '2026-07-31T17:02:00.000Z',
    })
    const selection = createProjectLutSelection({
      id: 'project-lut-materialized-selection', workspaceId: lut.workspaceId, projectId: 'project-lut-test',
      baseVersionId: 'project-version-lut-base-1', resultVersionId: 'project-version-lut-result-2', commandId: 'project-lut-command-materialized',
      requested: { mode: 'lut-version', lutId: lut.lutId, version: 1 }, resolved: { mode: 'lut-version', lut: projectLutRef(lut) }, intensity: 0.5,
      createdAt: '2026-07-31T17:03:00.000Z',
    })
    const creativeParameters = { mode: 'lut3d', intensity: 0.5 }
    const creative = { kind: 'creative-lut', enabled: true, implementation: { provider: 'apollo-lut', parameters: creativeParameters, parametersHash: calculateCanonicalHash(creativeParameters) }, lut: { artifactId: lut.id, sha256: lut.cube.contentHash } }
    const materializer = new LocalProjectLutRenderMaterializer(
      { async readEffectiveForVersion() { return { selection, resolvedLutVersion: lut } } },
      join(root, 'work'),
      { async readVersionById({ versionId }) { return versionId === alternateLut.id ? alternateLut : null } },
    )
    const result = await materializer.materialize({
      workspaceId: lut.workspaceId, projectId: selection.projectId, projectVersionId: selection.resultVersionId,
      operationId: 'operation-project-lut-materialized', compilations: [{ pipeline: { stages: [{ kind: 'technical' }, { kind: 'match' }, creative, { kind: 'output' }] } }],
    })
    const path = result.lutPaths[lut.id]
    assert.ok(path.startsWith(root))
    const content = await readFile(path, 'utf8')
    assert.match(content, /0\.5 0 0/)
    assert.match(result.materializedCubeHash, /^[a-f0-9]{64}$/)
    assert.equal(result.asset.artifactId, lut.id)
    assert.equal(result.asset.byteSize, Buffer.byteLength(content, 'utf8'))
    assert.match(result.asset.artifactKey, /^workspace-luts\//)
    await materializer.cleanup('operation-project-lut-materialized')
    await assert.rejects(access(path))

    const fullParameters = { mode: 'lut3d', intensity: 1 }
    const full = { ...creative, implementation: { ...creative.implementation, parameters: fullParameters, parametersHash: calculateCanonicalHash(fullParameters) } }
    const noneParameters = { mode: 'none' }
    const none = { ...creative, enabled: false, implementation: { ...creative.implementation, parameters: noneParameters, parametersHash: calculateCanonicalHash(noneParameters) }, lut: undefined }
    const alternateParameters = { mode: 'lut3d', intensity: 0.75 }
    const alternate = { ...creative, implementation: { ...creative.implementation, parameters: alternateParameters, parametersHash: calculateCanonicalHash(alternateParameters) }, lut: { artifactId: alternateLut.id, sha256: alternateLut.cube.contentHash } }
    const targeted = await materializer.materialize({
      workspaceId: lut.workspaceId, projectId: selection.projectId, projectVersionId: selection.resultVersionId,
      operationId: 'operation-project-lut-targeted',
      compilations: [{ pipeline: { stages: [{ kind: 'technical' }, { kind: 'match' }, creative, { kind: 'output' }] } }],
      executions: [
        { stages: [{ kind: 'technical' }, { kind: 'match' }, creative, { kind: 'output' }] },
        { stages: [{ kind: 'technical' }, { kind: 'match' }, full, { kind: 'output' }] },
        { stages: [{ kind: 'technical' }, { kind: 'match' }, none, { kind: 'output' }] },
        { stages: [{ kind: 'technical' }, { kind: 'match' }, alternate, { kind: 'output' }] },
      ],
    })
    assert.equal(targeted.assets.length, 3)
    assert.equal(targeted.materializedCubeHashes.length, 3)
    assert.equal(new Set(targeted.assets.map((asset) => asset.sha256)).size, 3)
    assert.equal(targeted.asset, undefined)
    const halfPath = targeted.lutPaths[`${lut.id}:${creative.implementation.parametersHash}`]
    const fullPath = targeted.lutPaths[`${lut.id}:${full.implementation.parametersHash}`]
    assert.notEqual(halfPath, fullPath)
    assert.match(await readFile(halfPath, 'utf8'), /0\.5 0 0/)
    assert.match(await readFile(fullPath, 'utf8'), /1 0 0/)
    assert.match(await readFile(targeted.lutPaths[`${alternateLut.id}:${alternate.implementation.parametersHash}`], 'utf8'), /0 0 1/)

    const mismatched = { ...full, lut: { ...full.lut, artifactId: 'workspace-lut-unselected-1' } }
    await assert.rejects(materializer.materialize({
      workspaceId: lut.workspaceId, projectId: selection.projectId, projectVersionId: selection.resultVersionId,
      operationId: 'operation-project-lut-mismatch', compilations: [{ pipeline: { stages: [{ kind: 'technical' }, { kind: 'match' }, mismatched, { kind: 'output' }] } }],
    }), /does not match/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
