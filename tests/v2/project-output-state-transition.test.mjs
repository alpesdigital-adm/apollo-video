import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'
import { CHILD_COMMAND_TRANSITIONS, COPY_REQUIRES_EDITORIAL_CUT_REASON, FORK_INHERITABLE_COMMAND_TYPES, FORK_TARGET_MATERIALIZATION_REASON } from '../../src/v2/domain/output-child-command.ts'
import { EDIT_COMMAND_TYPES } from '../../src/v2/domain/edit-command-registry.ts'
import { validateOperationalOutputOriginV3 } from '../../src/v2/domain/output-version-origin.ts'
import { createProjectSnapshot } from '../../src/v2/domain/project-snapshot.ts'
import { parentNormalizationsV3, reidentifiedEditPlanSnapshot, transitionProjectOutputState } from '../../src/v2/domain/project-output-state-transition.ts'
import { buildOperationalOutputVersionBundleV3, forkAuthorityPendingV3, operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { forkCopyConfigurationChild } from './helpers/operational-editorial-fixture.mjs'
import { ingestedWorld, outputWorld, creationRequest, variantRequest } from './helpers/output-world.mjs'

const createdAt = '2026-10-15T09:00:00.000Z'
let worldPromise
const world = () => (worldPromise ??= ingestedWorld())

function childInput(parentWorld, overrides = {}) {
  const parent = parentWorld.parent, audit = materializeActorAuditContext(parentWorld.actor)
  const scope = { workspaceId: parent.version.workspaceId, projectId: parent.version.projectId }
  const resultVersionId = 'version-child-' + (overrides.suffix ?? 'lut'), plan = JSON.parse(parent.editPlanSnapshot.contentJson)
  const type = overrides.type ?? 'set-project-lut-selection'
  const command = createEditCommand({ ...scope, id: 'command-child-' + (overrides.suffix ?? 'lut'), baseVersionId: parent.version.id,
    baseHash: parent.version.baseHash, author: { type: 'api-client', id: audit.clientId }, type, scope: { project: true },
    payload: overrides.payload ?? { schemaVersion: 2, mode: 'none', intensity: 1 }, idempotencyKey: 'child-key-' + (overrides.suffix ?? 'lut'), createdAt })
  const editPlan = { ...plan, id: 'edit-plan-child-' + (overrides.suffix ?? 'lut'), projectVersionId: resultVersionId, ...(overrides.planPatch ?? {}) }
  const snapshot = (id, kind, document) => createProjectSnapshot({ ...scope, id, kind, contentSchemaVersion: document.schemaVersion,
    contentJson: stableSerialize(document), contentHash: calculateCanonicalHash(document), createdAt })
  let counter = 0
  return {
    parent, audit, scope, command,
    input: { parent, allocation: { ...scope, resultVersionId, stateId: 'state-child-' + (overrides.suffix ?? 'lut'), parentVersionId: parent.version.id,
      sequence: parent.version.sequence + 1, createdBy: audit.clientId, createdAt }, command, audit,
    requestFingerprint: calculateCanonicalHash({ child: overrides.suffix ?? 'lut' }),
    editPlanSnapshot: snapshot('snapshot-child-' + (overrides.suffix ?? 'lut'), 'edit-plan', editPlan),
    createMaterializationId: () => `materialization-child-${overrides.suffix ?? 'lut'}-${++counter}`, ...(overrides.input ?? {}) },
    snapshot,
  }
}

test('every registered Command type is either a dedicated output origin or declares a child transition', () => {
  // 'compile-renderable-plan' is the origin of a renderable plan's Version (renderable-compile-command), proven in renderable-compile-output-state.test.mjs.
  const dedicated = new Set(['create-output-variant', 'revise-output-spec', 'remove-spoken-content', 'compare-action', 'compile-renderable-plan'])
  const declared = new Set(Object.keys(CHILD_COMMAND_TRANSITIONS))
  assert.deepEqual([...EDIT_COMMAND_TYPES].filter((type) => !dedicated.has(type) && !declared.has(type)), [])
  assert.deepEqual([...declared].filter((type) => dedicated.has(type)), [])
  for (const [type, transition] of Object.entries(CHILD_COMMAND_TRANSITIONS)) {
    assert.ok(['preserves-plan', 'recompiles-plan'].includes(transition.planEffect), type)
    assert.ok(Object.isFrozen(transition), type)
  }
})

test('a child Command yields a sealed Version3 and State3 that re-materializes every entry from the exact parent observations', async () => {
  const w = await world(), { parent, input } = childInput(w)
  const bundle = transitionProjectOutputState(input)
  assert.equal(bundle.schemaVersion, 'operational-output-version-bundle/v3')
  assert.equal(bundle.origin.kind, 'child-command')
  assert.equal(bundle.version.outputContractVersion, 3)
  assert.equal(bundle.version.parentVersionId, parent.version.id)
  assert.equal(bundle.version.sequence, parent.version.sequence + 1)
  assert.equal(bundle.version.commandId, input.command.id)
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.equal(bundle.state.document.parentStateHash, parent.state.stateHash)
  assert.equal(bundle.state.document.provenance.id, input.command.id)
  assert.equal(bundle.state.document.provenance.hash, input.command.commandHash)
  assert.equal(bundle.state.document.producer.document.kind, 'child-command')
  assert.equal(bundle.state.document.entries.length, parent.state.document.entries.length)
  assert.ok(bundle.state.document.entries.length > 0)
  for (const [index, entry] of bundle.state.document.entries.entries()) {
    const before = parent.state.document.entries[index]
    assert.equal(entry.variantId, before.variantId)
    assert.equal(entry.outputSpecRevisionId, before.outputSpecRevisionId)
    assert.equal(entry.consumption.status, 'materialized')
    assert.notEqual(entry.consumption.materialization.materializationHash, before.consumption.materialization.materializationHash)
    assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)
  }
  assert.deepEqual(bundle.state.document.overlays, parent.state.document.overlays)
  assert.equal(bundle.version.snapshotRefs.brief, parent.version.snapshotRefs.brief)
  assert.equal(bundle.version.snapshotRefs.policies, parent.version.snapshotRefs.policies)
  assert.equal(bundle.version.snapshotRefs.editPlan, bundle.editPlanSnapshot.id)
})

test('a Command that replaces a non-output snapshot declares and supplies exactly that kind', async () => {
  const w = await world(), base = childInput(w, { suffix: 'policy', type: 'set-project-policy-overrides', payload: { schemaVersion: 1 } })
  const policies = JSON.parse(base.parent.snapshots.find((s) => s.kind === 'policies').contentJson)
  const replacement = base.snapshot('snapshot-policies-child', 'policies', { ...policies, note: 'overridden' })
  const bundle = transitionProjectOutputState({ ...base.input, replacementSnapshots: [replacement] })
  assert.deepEqual(bundle.origin.replaces, ['policies'])
  assert.equal(bundle.version.snapshotRefs.policies, 'snapshot-policies-child')
  assert.ok(bundle.snapshots.some((s) => s.id === 'snapshot-policies-child'))
  assert.ok(!bundle.snapshots.some((s) => s.id === base.parent.version.snapshotRefs.policies))
  const unchanged = transitionProjectOutputState({ ...base.input, replacementSnapshots: [] })
  assert.deepEqual(unchanged.origin.replaces, [])
  assert.equal(unchanged.version.snapshotRefs.policies, base.parent.version.snapshotRefs.policies)
  const lut = childInput(w, { suffix: 'lutreplace' })
  assert.throws(() => transitionProjectOutputState({ ...lut.input, replacementSnapshots: [replacement] }),
    (e) => e.code === 'INVALID_COMMAND', 'LUT selection cannot replace policies')
})

test('a Command declared as preserving the plan cannot change its semantics; recompiling Commands can', async () => {
  const w = await world()
  const changed = childInput(w, { suffix: 'plan', planPatch: { fps: 24 } })
  assert.throws(() => transitionProjectOutputState(changed.input), (e) => e.code === 'INVALID_COMMAND')
  const review = childInput(w, { suffix: 'review', type: 'apply-review-patch', payload: { schemaVersion: 1 } })
  const bundle = transitionProjectOutputState(review.input)
  assert.equal(bundle.origin.command.type, 'apply-review-patch')
})

test('the child origin rejects undeclared types, forged commands, actor audits and dedicated manual operations', async () => {
  const w = await world(), base = childInput(w, { suffix: 'neg' })
  const origin = (patch) => ({ kind: 'child-command', command: base.command, audit: base.audit, requestFingerprint: base.input.requestFingerprint, replaces: [], adoptions: [], ...patch })
  const allocation = base.input.allocation, parent = base.parent
  const validate = (o) => validateOperationalOutputOriginV3(o, parent, allocation)
  assert.ok(validate(origin({})))
  assert.throws(() => validate(origin({ audit: null })), (e) => e.code === 'INVALID_COMMAND')
  assert.throws(() => validate(origin({ requestFingerprint: 'nope' })), (e) => e.code === 'INVALID_OUTPUT_SPEC' || e.code === 'INVALID_COMMAND')
  assert.throws(() => validate(origin({ command: { ...base.command, reason: 'forged after sealing' } })), (e) => e.code === 'INVALID_COMMAND')
  assert.throws(() => validate(origin({ replaces: ['policies'] })), (e) => e.code === 'INVALID_COMMAND')
  assert.throws(() => validate({ ...origin({}), extra: true }), (e) => e.code === 'INVALID_COMMAND')
  const dedicated = childInput(w, { suffix: 'dedicated', type: 'remove-spoken-content', payload: { schemaVersion: 3 } })
  assert.throws(() => transitionProjectOutputState(dedicated.input), (e) => e.code === 'INVALID_COMMAND')
  const select = childInput(w, { suffix: 'select', type: 'manual-edit', payload: { schemaVersion: 2, action: 'apply', operation: { kind: 'select', clipId: 'clip-x' } } })
  assert.throws(() => transitionProjectOutputState(select.input), (e) => e.code === 'INVALID_COMMAND')
  const internal = childInput(w, { suffix: 'internal' })
  const author = { type: 'system', id: base.audit.clientId }
  const systemCommand = createEditCommand({ ...base.scope, id: 'command-child-system', baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
    author, type: 'set-project-lut-selection', scope: { project: true }, payload: { schemaVersion: 2, mode: 'none', intensity: 1 }, idempotencyKey: 'child-key-system', createdAt })
  assert.throws(() => transitionProjectOutputState({ ...internal.input, command: systemCommand }), (e) => e.code === 'INVALID_COMMAND', 'system author must not carry a credential audit')
  assert.ok(transitionProjectOutputState({ ...internal.input, command: systemCommand, audit: null }).version.createdBy === base.audit.clientId)
})

test('a parent without an explicit output variant cannot receive a child Command', async () => {
  const empty = outputWorld(), root = await empty.create(creationRequest(empty))
  const audit = materializeActorAuditContext(empty.actor), scope = { workspaceId: root.bundle.version.workspaceId, projectId: root.bundle.version.projectId }
  const plan = JSON.parse(root.bundle.command.payload.snapshots.find((s) => s.kind === 'edit-plan').contentJson)
  const command = createEditCommand({ ...scope, id: 'command-child-empty', baseVersionId: root.bundle.version.id, baseHash: root.bundle.version.baseHash,
    author: { type: 'api-client', id: audit.clientId }, type: 'set-project-lut-selection', scope: { project: true },
    payload: { schemaVersion: 2, mode: 'none', intensity: 1 }, idempotencyKey: 'child-key-empty', createdAt })
  const editPlan = { ...plan, id: 'edit-plan-child-empty', projectVersionId: 'version-child-empty' }
  const snapshot = createProjectSnapshot({ ...scope, id: 'snapshot-child-empty', kind: 'edit-plan', contentSchemaVersion: editPlan.schemaVersion,
    contentJson: stableSerialize(editPlan), contentHash: calculateCanonicalHash(editPlan), createdAt })
  assert.throws(() => transitionProjectOutputState({ parent: root.bundle, command, audit, requestFingerprint: calculateCanonicalHash({ empty: true }),
    editPlanSnapshot: snapshot, createMaterializationId: () => 'never',
    allocation: { ...scope, resultVersionId: 'version-child-empty', stateId: 'state-child-empty', parentVersionId: root.bundle.version.id,
      sequence: 2, createdBy: audit.clientId, createdAt } }), (e) => e.code === 'PRECONDITION_REQUIRED')
  // a variant makes the same Command admissible and, with an empty plan, keeps every entry blocked
  const withVariant = (await empty.variant(variantRequest(empty, root.bundle))).bundle
  const next = createEditCommand({ ...scope, id: 'command-child-variant', baseVersionId: withVariant.version.id, baseHash: withVariant.version.baseHash,
    author: { type: 'api-client', id: audit.clientId }, type: 'set-project-lut-selection', scope: { project: true },
    payload: { schemaVersion: 2, mode: 'none', intensity: 1 }, idempotencyKey: 'child-key-variant', createdAt })
  const variantPlan = JSON.parse(withVariant.editPlanSnapshot.contentJson)
  const childPlan = { ...variantPlan, id: 'edit-plan-child-variant', projectVersionId: 'version-child-variant' }
  const childSnapshot = createProjectSnapshot({ ...scope, id: 'snapshot-child-variant', kind: 'edit-plan', contentSchemaVersion: childPlan.schemaVersion,
    contentJson: stableSerialize(childPlan), contentHash: calculateCanonicalHash(childPlan), createdAt })
  const bundle = transitionProjectOutputState({ parent: withVariant, command: next, audit, requestFingerprint: calculateCanonicalHash({ variant: true }),
    editPlanSnapshot: childSnapshot, createMaterializationId: () => 'never',
    allocation: { ...scope, resultVersionId: 'version-child-variant', stateId: 'state-child-variant', parentVersionId: withVariant.version.id,
      sequence: withVariant.version.sequence + 1, createdBy: audit.clientId, createdAt } })
  assert.deepEqual(bundle.state.document.entries.map((e) => e.consumption), [{ status: 'blocked', reasons: ['empty-project'] }])
})

/**
 * The guard function is redefined by every migration that adds a Command type. The first definition names the types that existed then; the
 * definition in force (W66r added `apply-variant-reframe-override`) names the registry as it is now. Both are pinned to the domain, so the
 * history cannot be edited and the guard in force cannot drift from the table.
 */
async function pinChildCommandGuard(migration, table, { dispatch }) {
  const sql = await readFile(new URL(`../../prisma/v2/migrations/${migration}/migration.sql`, import.meta.url), 'utf8')
  const quoted = (text) => [...text.matchAll(/'([A-Za-z-]+)'/g)].map((match) => match[1])
  assert.deepEqual(quoted(sql.match(/cmd\.type NOT IN \(([^)]*)\)/)[1]), table.map(([type]) => type))
  assert.deepEqual(quoted(sql.match(/cmd\.type IN \(([^)]*)\) AND pj-ARRAY/)[1]), table.filter(([, t]) => t.planEffect === 'preserves-plan').map(([type]) => type))
  assert.deepEqual([...sql.matchAll(/WHEN '([a-z-]+)' THEN ARRAY\[([^\]]*)\]/g)].map((match) => [match[1], quoted(match[2])]),
    table.filter(([, t]) => t.replaces.length > 0).map(([type, t]) => [type, [...t.replaces]]))
  const bundle = transitionProjectOutputState(childInput(await world(), { suffix: 'sync' }).input)
  assert.deepEqual(quoted(sql.match(/w66_v3_exact_keys\(o,ARRAY\[([^\]]*)\]\)/)[1]).sort(), Object.keys(bundle.origin).sort())
  // The dispatch on the origin kind belongs to the first definition; a later one redefines the child guard alone and must not redefine the dispatch.
  assert.ok(sql.includes(`o->>'kind' IS DISTINCT FROM '${bundle.origin.kind}'`))
  assert.equal(sql.includes('w66_assert_operational_state_v3'), dispatch)
  if (dispatch) assert.ok(sql.includes(`origin_kind='${bundle.origin.kind}'`))
  const producer = bundle.state.document.producer.document, body = sql.match(/expected_producer:=jsonb_build_object\(([^;]*)\);/)[1]
  assert.deepEqual([...new Set(quoted(body).filter((token) => Object.keys(producer).includes(token)))].sort(), Object.keys(producer).sort())
  assert.ok(body.includes(`'${producer.schemaVersion}'`) && body.includes(`'kind','${producer.kind}'`))
  assert.equal(producer.target, null)
  // Adoption is verified by the same guard: listed, sorted, unique, exactly the observations outside the parent, persisted and rights-current.
  assert.deepEqual(producer.adoptions, [])
  for (const marker of ["jsonb_typeof(o->'adoptions')", "'adoptions',o->'adoptions'", 'W66v3 child adoption shape/order differs', 'W66v3 child normalization lineage differs',
    'w66_assert_normalization_v3(adopted_receipt.id', 'W66v3 adopted observation rights differ from the snapshot they name', 'written_now', 'W66v3 adopted observation rights are not current',
    'W66v3 adopted observation has no project media association',
    // the verdict cache lives in the dispatch, which only the first definition carries
    ...(dispatch ? ['apollo.w66_state_verified', 'pg_stat_xact_all_tables'] : [])]) {
    assert.ok(sql.includes(marker), marker)
  }
}

test('the database guard names exactly the types, plan effects, replacements, origin keys and producer the domain declares', async () => {
  const table = Object.entries(CHILD_COMMAND_TRANSITIONS)
  await pinChildCommandGuard('20261016120000_project_child_command_state_v1', table.filter(([type]) => type !== 'apply-variant-reframe-override'), { dispatch: true })
  await pinChildCommandGuard('20261019100000_variant_reframe_v1', table, { dispatch: false })
})

test('a child plan is materialized only from observed sources: an unobserved source is refused, an emptied plan blocks', async () => {
  const w = await world(), plan = JSON.parse(w.parent.editPlanSnapshot.contentJson)
  const elsewhere = childInput(w, { suffix: 'unobserved', type: 'apply-review-patch', payload: { schemaVersion: 1 }, planPatch: {
    videoTracks: [{ ...plan.videoTracks[0], clips: plan.videoTracks[0].clips.map((clip) => ({ ...clip, sourceArtifactId: 'artifact-elsewhere' })) }] } })
  assert.throws(() => transitionProjectOutputState(elsewhere.input), (error) =>
    error.code === 'PRECONDITION_REQUIRED' && error.details.sourceArtifactIds.includes('artifact-elsewhere'))
  const emptied = childInput(w, { suffix: 'emptied', type: 'apply-review-patch', payload: { schemaVersion: 1 }, planPatch: { durationFrames: 0, videoTracks: [] } })
  const bundle = transitionProjectOutputState(emptied.input)
  assert.ok(bundle.state.document.entries.length > 0)
  assert.ok(bundle.state.document.entries.every((entry) => entry.consumption.status === 'blocked' && entry.consumption.reasons[0] === 'empty-project'))
})

// ---- A copy (a Creation fork that carries content) before any editorial cut gives it target authority ----
let copyWorldPromise
const copyWorld = () => (copyWorldPromise ??= (async () => {
  const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { createMediaTranscript } = await import('../../src/v2/domain/media-transcript.ts')
  const { createEditorialForkFixture } = await import('./helpers/operational-editorial-fixture.mjs')
  const context = createExternalAuditContext({ clientId: 'client-1', credentialId: 'credential-copy-1', workspaceId: 'workspace-1', environment: 'production' })
  const actor = Object.freeze({ ...context, auditContext: context, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' })
  const transcript = createMediaTranscript({ language: 'pt-BR', text: 'Primeiro remover último.',
    words: [{ word: 'Primeiro', start: 0, end: 1 }, { word: 'remover', start: 1, end: 2 }, { word: 'último.', start: 2, end: 3 }],
    segments: [{ id: 0, start: 0, end: 3, text: 'Primeiro remover último.' }], provider: 'controlled', model: 'explicit-domain-fixture' })
  return { actor, ...(await createEditorialForkFixture({ actor, transcript, sourceDurationSeconds: 3, fps: 30, sibling: false })) }
})())
const FORK_REASON = 'fork-target-materialization-required'
const planOf = (bundle) => JSON.parse(operationalBundlePlanV3(bundle).contentJson)
const withoutIdentity = ({ id, projectVersionId, createdAt, ...rest }) => rest

test('a copy accepts every configuration Command as its first child and inherits the fork posture: blocked, nothing observed or materialized', async () => {
  const w = await copyWorld(), root = w.fork.bundle
  assert.equal(root.schemaVersion, 'project-creation-output-bundle/v2')
  assert.equal(root.state.document.transition, 'fork-with-content')
  assert.equal(forkAuthorityPendingV3(root), true)
  assert.ok(root.state.document.entries.length > 0 && planOf(root).durationFrames > 0)
  for (const type of FORK_INHERITABLE_COMMAND_TYPES) {
    const policies = type === 'set-project-policy-overrides' ? [createProjectSnapshot({ workspaceId: root.version.workspaceId, projectId: root.version.projectId,
      id: 'snapshot-copy-policies-' + type, kind: 'policies', contentSchemaVersion: 1, createdAt: '2026-07-18T20:09:00.000Z',
      contentJson: stableSerialize({ schemaVersion: 1, state: 'configured' }), contentHash: calculateCanonicalHash({ schemaVersion: 1, state: 'configured' }) })] : []
    const child = forkCopyConfigurationChild(root, { actor: w.actor, suffix: type, type, replacementSnapshots: policies })
    assert.equal(child.origin.kind, 'child-command')
    assert.equal(child.version.outputContractVersion, 3)
    assert.equal(child.version.sequence, root.version.sequence + 1)
    assert.equal(child.version.parentVersionId, root.version.id)
    assert.equal(child.state.document.transition, 'inherit')
    assert.deepEqual(child.state.document.entries.map((e) => [e.variantId, e.outputSpecRevisionId, e.specHash]),
      root.state.document.entries.map((e) => [e.variantId, e.outputSpecRevisionId, e.specHash]))
    for (const entry of child.state.document.entries) {
      assert.deepEqual(entry.consumption, { status: 'blocked', reasons: [FORK_REASON] }, type)
      assert.equal(entry.spec.schemaVersion, 'output-spec-revision/v3', 'the literal fork revision is kept, never upgraded')
    }
    assert.deepEqual(child.state.document.producer.document.adoptions, [])
    assert.deepEqual(child.state.document.sourceDependencies, root.state.document.sourceDependencies)
    assert.deepEqual(child.state.document.overlays, root.state.document.overlays)
    assert.deepEqual(withoutIdentity(planOf(child)), withoutIdentity(planOf(root)), 'the plan is preserved byte for byte under a new identity')
    assert.equal(forkAuthorityPendingV3(child), true, 'the child is still a copy without target authority')
    assert.deepEqual(parentNormalizationsV3(child), [])
    assert.equal(child.version.snapshotRefs.policies !== root.version.snapshotRefs.policies, type === 'set-project-policy-overrides')
  }
})

test('configuration children of a copy chain, each keeping every entry blocked', async () => {
  const w = await copyWorld()
  const first = forkCopyConfigurationChild(w.fork.bundle, { actor: w.actor, suffix: 'chain-lut' })
  const second = forkCopyConfigurationChild(first, { actor: w.actor, suffix: 'chain-color', type: 'set-project-color-plan', payload: { schemaVersion: 1 } })
  const third = forkCopyConfigurationChild(second, { actor: w.actor, suffix: 'chain-subtitle', type: 'set-project-subtitle-mode', payload: { schemaVersion: 1 } })
  assert.deepEqual([first, second, third].map((b) => b.version.sequence), [2, 3, 4])
  assert.deepEqual([second, third].map((b) => b.version.parentVersionId), [first.version.id, second.version.id])
  for (const bundle of [first, second, third]) {
    assert.ok(bundle.state.document.entries.every((e) => e.consumption.status === 'blocked' && e.consumption.reasons.join() === FORK_REASON))
    assert.deepEqual(withoutIdentity(planOf(bundle)), withoutIdentity(planOf(w.fork.bundle)))
  }
})

test('a copy still refuses every Command that changes geometry, transcript, media or plan, naming the reason the operator can act on', async () => {
  const w = await copyWorld(), first = forkCopyConfigurationChild(w.fork.bundle, { actor: w.actor, suffix: 'refusal-base' })
  const refused = Object.keys(CHILD_COMMAND_TRANSITIONS).filter((type) => !FORK_INHERITABLE_COMMAND_TYPES.includes(type))
  assert.ok(refused.length >= 6, refused.join())
  for (const parent of [w.fork.bundle, first]) {
    for (const type of refused) {
      assert.throws(() => forkCopyConfigurationChild(parent, { actor: w.actor, suffix: `refused-${type}-${parent.version.sequence}`, type, payload: { schemaVersion: 1 } }),
        (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === COPY_REQUIRES_EDITORIAL_CUT_REASON, `${type} on sequence ${parent.version.sequence}`)
    }
  }
  assert.equal(COPY_REQUIRES_EDITORIAL_CUT_REASON, 'copy-requires-editorial-cut')
})

test('a copy child cannot hide an observation, an adoption or a materialization', async () => {
  const w = await copyWorld(), root = w.fork.bundle, audit = materializeActorAuditContext(w.actor)
  const scope = { workspaceId: root.version.workspaceId, projectId: root.version.projectId }, createdAt = '2026-07-18T20:10:00.000Z', versionId = 'version-copy-hidden'
  const command = createEditCommand({ ...scope, id: 'command-copy-hidden', baseVersionId: root.version.id, baseHash: root.version.baseHash,
    author: { type: 'api-client', id: audit.clientId }, type: 'set-project-lut-selection', scope: { project: true },
    payload: { schemaVersion: 2, mode: 'none', intensity: 1 }, idempotencyKey: 'copy-child-hidden', createdAt })
  const build = (extra) => buildOperationalOutputVersionBundleV3({
    allocation: { ...scope, resultVersionId: versionId, stateId: 'state-copy-hidden', parentVersionId: root.version.id, sequence: 2, createdBy: audit.clientId, createdAt },
    parent: root, restoreTarget: null, normalizations: [], materializationIds: {},
    origin: { kind: 'child-command', command, audit, requestFingerprint: calculateCanonicalHash({ hidden: true }), replaces: [], adoptions: [] },
    editPlanSnapshot: reidentifiedEditPlanSnapshot(root, { snapshotId: 'snapshot-copy-hidden', versionId, createdAt }), ...extra })
  assert.equal(build({}).version.sequence, 2)
  assert.throws(() => build({ normalizations: [w.prepared.n] }), (error) => error.code === 'INVALID_COMMAND' && /observes and adopts no recording/.test(error.message))
  assert.throws(() => build({ materializationIds: { [root.state.document.entries[0].variantId]: 'materialization-hidden' } }),
    (error) => error.code === 'INVALID_PROJECT_VERSION' && /cannot hide materialization/.test(error.message))
})

test('the database guard admits exactly the configuration Commands and the fork reason the domain declares', async () => {
  const sql = await readFile(new URL('../../prisma/v2/migrations/20261017120000_fork_copy_configuration_children_v1/migration.sql', import.meta.url), 'utf8')
  const quoted = (text) => [...text.matchAll(/'([A-Za-z-]+)'/g)].map((match) => match[1])
  assert.deepEqual(quoted(sql.match(/pending_parent AND \(cmd\.type NOT IN \(([^)]*)\)/)[1]), [...FORK_INHERITABLE_COMMAND_TYPES])
  assert.equal(sql.split(`["${FORK_TARGET_MATERIALIZATION_REASON}"]`).length - 1, 3, 'parent probe, helper and entry check name the same reason')
  assert.ok(sql.includes('W66v3 a copy without target authority cannot materialize') && sql.includes('w66_fork_copy_pending_v1'))
  // Only the two guards (and their helper) are defined: nothing weakens the immutability triggers.
  assert.deepEqual([...sql.matchAll(/CREATE (?:OR REPLACE )?(?:FUNCTION|CONSTRAINT TRIGGER|TRIGGER) (\w+)/g)].map((match) => match[1]),
    ['w66_fork_copy_pending_v1', 'w66_assert_editorial_binding_v1', 'w66_assert_child_command_state_v1'])
  assert.ok(!/DROP |DISABLE|ALTER TABLE/.test(sql))
})
