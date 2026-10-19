import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { prepareRenderableCompileVersion } from '../../src/v2/application/compile-renderable-plan-version.ts'
import { assembleDirectedEditPlan, renderablePlanSnapshotOf } from '../../src/v2/application/renderable-edit-plan.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { EDIT_COMMAND_TYPES, editCommandPolicy } from '../../src/v2/domain/edit-command-registry.ts'
import { calculateRenderablePlanHash } from '../../src/v2/domain/renderable-plan-authority.ts'
import {
  RENDERABLE_COMPILE_COMMAND_TYPE, createRenderableCompileImpact, parseRenderableCompileImpact, renderableCompileIdentity,
} from '../../src/v2/domain/renderable-compile-command.ts'
import { transitionRenderableCompileOutputState } from '../../src/v2/domain/renderable-compile-transition.ts'
import { buildOperationalOutputVersionBundleV3, operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { forkCopyConfigurationChild } from './helpers/operational-editorial-fixture.mjs'
import { ingestedWorld, recompiledChild } from './helpers/output-world.mjs'

/**
 * A renderable plan reaches a project only as the State of a Version born with it. These are the pure rules of that
 * Version: its identity, the Command that makes it, the reciprocal State binding the database dispatch guard asks for,
 * and every shape that must stay refused. The PostgreSQL proof is the second test of project-child-adoption.pg.
 */
const createdAt = '2026-10-16T09:00:00.000Z'
const sourceHash = 'a'.repeat(64)
let worldPromise
const world = () => (worldPromise ??= ingestedWorld())

function compiled(parent, { origin = 'react-playback', sourceId = 'playback-map-rc-1', hash = sourceHash, fps = 30, planId = 'plan-renderable-rc-1', clipFrames = 60 } = {}) {
  const key = { workspaceId: parent.version.workspaceId, projectId: parent.version.projectId, origin, sourceId, sourceHash: hash, baseVersionId: parent.version.id }
  const identity = renderableCompileIdentity(key)
  const plan = assembleDirectedEditPlan({
    planId, projectVersionId: identity.versionId, derivedFrom: { origin, id: sourceId, hash }, objective: 'discovery', fps,
    sources: [{ id: 'source-rc-1', artifactId: 'artifact-rc-1', kind: 'video', durationSeconds: 10 }],
    clips: [{ id: 'clip-rc-1', sourceArtifactId: 'artifact-rc-1', sourceInFrame: 0, sourceOutFrame: clipFrames, timelineInFrame: 0, timelineOutFrame: clipFrames, rate: 1 }],
    seams: [], lineageRefs: [`playback-map:${sourceId}:v1`], assumptions: ['Controlled renderable compile'], createdAt })
  const snapshot = renderablePlanSnapshotOf({ workspaceId: key.workspaceId, projectId: key.projectId, origin, sourceId, sourceHash: hash, sourceVersion: 1, plan })
  return { key, identity, plan, snapshot }
}

function prepare(w, parent, overrides = {}, planOverrides = {}) {
  const made = compiled(parent, planOverrides)
  let counter = 0
  return { made, ...prepareRenderableCompileVersion({
    parent, snapshot: made.snapshot, snapshotRowId: 'renderable-row-' + (planOverrides.planId ?? 'rc-1'), createdAt,
    author: { type: 'api-client', id: materializeActorAuditContext(w.actor).clientId }, audit: materializeActorAuditContext(w.actor),
    createMaterializationId: () => `materialization-rc-${++counter}`, ...overrides }) }
}

test('the Command type is registered as a render-free Command with its own impact schema', () => {
  assert.equal(RENDERABLE_COMPILE_COMMAND_TYPE, 'compile-renderable-plan')
  assert.ok(EDIT_COMMAND_TYPES.includes('compile-renderable-plan'))
  const policy = editCommandPolicy('compile-renderable-plan')
  assert.deepEqual([policy.renderPolicy, policy.impactSchema, policy.requiresImpact, policy.supportsRenderFreeImpact, policy.deferralReason],
    ['no-render', 'renderable-compile-impact/v1', true, true, null])
})

test('identities are derived from the natural key: a retry lands on the same rows, another base or source on others', async () => {
  const w = await world(), { key, identity } = compiled(w.parent)
  assert.deepEqual(renderableCompileIdentity(key), identity)
  for (const value of Object.values(identity)) assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/)
  assert.equal(new Set(Object.values(identity)).size, Object.values(identity).length)
  for (const change of [{ baseVersionId: 'version-elsewhere' }, { sourceId: 'playback-map-other' }, { sourceHash: 'b'.repeat(64) }, { origin: 'multi-range-synthesis' }, { projectId: 'project-other' }, { workspaceId: 'workspace-other' }]) {
    const other = renderableCompileIdentity({ ...key, ...change })
    for (const [field, value] of Object.entries(identity)) assert.notEqual(other[field], value, `${Object.keys(change)[0]} must move ${field}`)
  }
})

test('a renderable compile yields a Version3 whose State3 binds the snapshot with the reciprocal fields', async () => {
  const w = await world(), parent = w.parent, { made, bundle, renderableSnapshot, command } = prepare(w, parent)
  const state = bundle.state.document, version = bundle.version
  assert.equal(bundle.schemaVersion, 'operational-output-version-bundle/v3')
  assert.equal(bundle.origin.kind, 'renderable-compile-command')
  assert.equal(version.outputContractVersion, 3)
  assert.equal(version.id, made.identity.versionId)
  assert.equal(version.parentVersionId, parent.version.id)
  assert.equal(version.sequence, parent.version.sequence + 1)
  assert.equal(version.commandId, command.id)
  assert.equal(command.type, 'compile-renderable-plan')
  assert.equal(command.baseVersionId, parent.version.id)
  assert.equal(command.baseHash, parent.version.baseHash)
  assert.equal(command.idempotencyKey, made.identity.idempotencyKey)
  // The reciprocal binding: the State names the row, and the row names the Version whose State this is.
  assert.deepEqual({ snapshotId: state.renderablePlan.snapshotId, planId: state.renderablePlan.planId, hash: state.renderablePlan.hash },
    { snapshotId: renderableSnapshot.id, planId: made.plan.id, hash: calculateRenderablePlanHash(made.plan) })
  assert.equal(renderableSnapshot.projectVersionId, version.id)
  assert.equal(JSON.parse(renderableSnapshot.planJson).projectVersionId, version.id)
  assert.equal(state.renderablePlan.authority.document.kind, 'renderable-edit-plan')
  assert.equal(state.renderablePlan.authority.document.legacyHash, state.renderablePlan.hash)
  assert.equal(renderableSnapshot.createdAt, version.createdAt)
  assert.equal(state.transition, 'inherit')
  assert.equal(state.provenance.kind, 'edit-command')
  assert.equal(state.provenance.id, command.id)
  assert.equal(state.provenance.hash, command.commandHash)
  assert.equal(state.parentStateHash, parent.state.stateHash)
  // The producer names the Command and the row it publishes.
  const producer = state.producer.document
  assert.equal(producer.schemaVersion, 'output-renderable-compile-producer/v1')
  assert.equal(producer.kind, 'renderable-compile-command')
  assert.equal(producer.renderablePlanSnapshotId, renderableSnapshot.id)
  assert.equal(producer.renderablePlanHash, state.renderablePlan.hash)
  // The Command payload carries the same identity, and its impact is an explicit zero.
  assert.equal(command.payload.snapshot.id, renderableSnapshot.id)
  assert.equal(command.payload.snapshot.planHash, renderableSnapshot.planHash)
  assert.equal(command.payload.impact.renderSemanticsChanged, false)
  assert.deepEqual([command.payload.impact.affectedArtifacts, command.payload.impact.affectedRanges, command.payload.impact.minimalRenders], [[], [], []])
})

test('the EditPlan is the parent plan under the new identity and every entry re-materializes from the parent observations', async () => {
  const w = await world(), parent = w.parent, { bundle } = prepare(w, parent)
  const strip = ({ id, projectVersionId, createdAt: at, ...rest }) => rest
  assert.deepEqual(strip(JSON.parse(bundle.editPlanSnapshot.contentJson)), strip(JSON.parse(operationalBundlePlanV3(parent).contentJson)))
  assert.equal(JSON.parse(bundle.editPlanSnapshot.contentJson).projectVersionId, bundle.version.id)
  assert.notEqual(bundle.editPlanSnapshot.id, operationalBundlePlanV3(parent).id)
  assert.ok(bundle.state.document.entries.length > 0)
  for (const [index, entry] of bundle.state.document.entries.entries()) {
    const before = parent.state.document.entries[index]
    assert.equal(entry.variantId, before.variantId)
    assert.equal(entry.outputSpecRevisionId, before.outputSpecRevisionId)
    assert.equal(entry.consumption.status, 'materialized')
    assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)
    assert.deepEqual(entry.consumption.materialization.document.normalizations, before.consumption.materialization.document.normalizations)
  }
  assert.deepEqual(bundle.state.document.overlays, parent.state.document.overlays)
  assert.deepEqual(bundle.state.document.invalidations, parent.state.document.invalidations)
  for (const kind of ['brief', 'policies']) assert.equal(bundle.version.snapshotRefs[kind], parent.version.snapshotRefs[kind])
  // An empty variant head compiles too: its entries stay blocked on the empty EditPlan, the renderable plan is the alternate.
  const empty = prepare(w, w.chain[1], {}, { planId: 'plan-renderable-rc-empty' }).bundle
  assert.ok(empty.state.document.entries.every((entry) => entry.consumption.status === 'blocked' && entry.consumption.reasons[0] === 'empty-project'))
  assert.notEqual(empty.state.document.renderablePlan, null)
})

test('the bundle is reproducible from its stored origin and the stored snapshot row alone', async () => {
  const w = await world(), parent = w.parent, { bundle, renderableSnapshot } = prepare(w, parent)
  let counter = 0
  const rebuilt = buildOperationalOutputVersionBundleV3({
    allocation: { workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, resultVersionId: bundle.version.id, stateId: bundle.state.document.id,
      parentVersionId: parent.version.id, sequence: bundle.version.sequence, createdBy: bundle.version.createdBy, createdAt: bundle.version.createdAt },
    parent, origin: bundle.origin, restoreTarget: null, editPlanSnapshot: bundle.editPlanSnapshot, renderableSnapshot,
    normalizations: bundle.state.document.entries.flatMap((entry) => entry.consumption.status === 'materialized' ? entry.consumption.materialization.document.normalizations : []).filter((n, i, all) => all.findIndex((m) => m.document.id === n.document.id) === i),
    materializationIds: Object.fromEntries(bundle.state.document.entries.map((entry) => [entry.variantId, entry.consumption.materialization.document.id])) })
  void counter
  assert.equal(stableSerialize(rebuilt), stableSerialize(bundle))
})

test('only the renderable-compile origin may bind a renderable plan, and it must', async () => {
  const w = await world(), parent = w.parent, { made, bundle, renderableSnapshot } = prepare(w, parent)
  // The other origins always produce a State without a renderable plan.
  const child = recompiledChild(parent, w.actor, (plan) => plan, { suffix: 'rc-child' })
  assert.equal(child.state.document.renderablePlan, null)
  assert.equal(child.origin.kind, 'child-command')
  // A row handed to any other origin is refused rather than ignored.
  assert.throws(() => buildOperationalOutputVersionBundleV3({
    allocation: { workspaceId: child.version.workspaceId, projectId: child.version.projectId, resultVersionId: child.version.id, stateId: child.state.document.id,
      parentVersionId: parent.version.id, sequence: child.version.sequence, createdBy: child.version.createdBy, createdAt: child.version.createdAt },
    parent, origin: child.origin, restoreTarget: null, editPlanSnapshot: child.editPlanSnapshot, renderableSnapshot,
    normalizations: [], materializationIds: {} }), (error) => error.code === 'INVALID_COMMAND')
  // The renderable-compile origin without its row is refused.
  const allocation = { workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, resultVersionId: bundle.version.id, stateId: bundle.state.document.id,
    parentVersionId: parent.version.id, sequence: bundle.version.sequence, createdBy: bundle.version.createdBy, createdAt: bundle.version.createdAt }
  const input = { allocation, parent, origin: bundle.origin, restoreTarget: null, editPlanSnapshot: bundle.editPlanSnapshot, renderableSnapshot,
    normalizations: bundle.state.document.entries.flatMap((entry) => entry.consumption.materialization.document.normalizations).filter((n, i, all) => all.findIndex((m) => m.document.id === n.document.id) === i),
    materializationIds: Object.fromEntries(bundle.state.document.entries.map((entry) => [entry.variantId, entry.consumption.materialization.document.id])) }
  assert.doesNotThrow(() => buildOperationalOutputVersionBundleV3(input))
  const { renderableSnapshot: _row, ...withoutRow } = input
  assert.throws(() => buildOperationalOutputVersionBundleV3(withoutRow), (error) => error.code === 'INVALID_COMMAND')
  assert.ok(made)
})

test('a row that does not belong to this Version, this derivation or this plan is refused', async () => {
  const w = await world(), parent = w.parent, ok = prepare(w, parent)
  const refuse = (mutate, label) => assert.throws(() => {
    const row = mutate({ ...ok.renderableSnapshot })
    transitionRenderableCompileOutputState({ ...ok.transition, renderableSnapshot: row })
  }, (error) => ['INVALID_COMMAND', 'INVALID_PROJECT_VERSION', 'INVALID_ARGUMENT'].includes(error.code), label)
  refuse((row) => ({ ...row, projectVersionId: 'version-elsewhere' }), 'another Version')
  refuse((row) => ({ ...row, planHash: 'c'.repeat(64) }), 'another plan hash')
  refuse((row) => ({ ...row, sourceHash: 'd'.repeat(64) }), 'another derivation hash')
  refuse((row) => ({ ...row, clipCount: row.clipCount + 1 }), 'another measurement')
  refuse((row) => ({ ...row, createdAt: '2026-10-16T09:00:01.000Z' }), 'another clock')
  refuse((row) => ({ ...row, planJson: row.planJson.replace('clip-rc-1', 'clip-tampered') }), 'a tampered document')
  refuse((row) => ({ ...row, id: 'renderable-row-other' }), 'another row id')
})

test('a plan compiled into another Version, a changed EditPlan or a non-head parent is refused before anything is built', async () => {
  const w = await world(), parent = w.parent, made = compiled(parent)
  const wrongVersion = renderablePlanSnapshotOf({ ...made.key, sourceVersion: 1, plan: { ...made.plan, projectVersionId: 'version-not-the-result' } })
  assert.throws(() => prepareRenderableCompileVersion({ parent, snapshot: wrongVersion, snapshotRowId: 'renderable-row-wrong', createdAt,
    author: { type: 'api-client', id: materializeActorAuditContext(w.actor).clientId }, audit: materializeActorAuditContext(w.actor), createMaterializationId: () => 'm' }),
  (error) => ['INVALID_COMMAND', 'INVALID_PROJECT_VERSION'].includes(error.code))
  // The effect is declared: the EditPlan may only change identity.
  const { bundle } = prepare(w, parent)
  const plan = JSON.parse(bundle.editPlanSnapshot.contentJson)
  const changed = { ...plan, durationFrames: plan.durationFrames + 30 }
  assert.throws(() => transitionRenderableCompileOutputState({ ...prepare(w, parent).transition,
    editPlanSnapshot: { ...bundle.editPlanSnapshot, contentJson: stableSerialize(changed), contentHash: calculateCanonicalHash(changed) } }),
  (error) => error.code === 'INVALID_COMMAND')
})

test('a parent that is not an operational State3 head with an explicit variant refuses the compile', async () => {
  const w = await world()
  assert.throws(() => prepare(w, w.root.bundle, {}, { planId: 'plan-renderable-rc-root' }), (error) => error.code === 'PRECONDITION_REQUIRED')
  const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { createMediaTranscript } = await import('../../src/v2/domain/media-transcript.ts')
  const { createEditorialForkFixture } = await import('./helpers/operational-editorial-fixture.mjs')
  const context = createExternalAuditContext({ clientId: 'client-1', credentialId: 'credential-copy-rc', workspaceId: 'workspace-1', environment: 'production' })
  const actor = Object.freeze({ ...context, auditContext: context, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' })
  const transcript = createMediaTranscript({ language: 'pt-BR', text: 'Primeiro remover último.',
    words: [{ word: 'Primeiro', start: 0, end: 1 }, { word: 'remover', start: 1, end: 2 }, { word: 'último.', start: 2, end: 3 }],
    segments: [{ id: 0, start: 0, end: 3, text: 'Primeiro remover último.' }], provider: 'controlled', model: 'explicit-domain-fixture' })
  const copy = await createEditorialForkFixture({ actor, transcript, sourceDurationSeconds: 3, fps: 30, sibling: false })
  // A copy has no target authority until its editorial cut: it renders nothing, so it cannot compile a renderable plan either.
  const copyChild = forkCopyConfigurationChild(copy.fork.bundle, { actor, suffix: 'rc-copy' })
  for (const pending of [copy.fork.bundle, copyChild]) {
    assert.throws(() => prepare({ actor }, pending, {}, { planId: 'plan-renderable-rc-copy-' + pending.version.sequence }), (error) => error.code === 'PRECONDITION_REQUIRED', `sequence ${pending.version.sequence}`)
  }
})

test('the impact is an explicit zero that parses back byte for byte and refuses anything else', async () => {
  const w = await world(), { command } = prepare(w, w.parent)
  const impact = command.payload.impact
  assert.equal(impact.schemaVersion, 'renderable-compile-impact/v1')
  assert.equal(impact.commandType, 'compile-renderable-plan')
  assert.deepEqual(parseRenderableCompileImpact(JSON.parse(JSON.stringify(impact))), impact)
  assert.deepEqual(createRenderableCompileImpact({ commandId: impact.commandId, baseVersionId: impact.baseVersionId, resultVersionId: impact.resultVersionId,
    preservedEditPlanSnapshotId: impact.preservedEditPlanSnapshotId, renderablePlanSnapshotId: impact.renderablePlanSnapshotId, renderablePlanHash: impact.renderablePlanHash }), impact)
  assert.throws(() => parseRenderableCompileImpact({ ...impact, renderSemanticsChanged: true }))
  assert.throws(() => parseRenderableCompileImpact({ ...impact, affectedArtifacts: [{ artifactId: 'artifact-x' }] }))
  assert.throws(() => parseRenderableCompileImpact({ ...impact, renderablePlanHash: 'e'.repeat(64) }))
})

test('the database guard and the dispatch name exactly what the domain declares, and weaken nothing', async () => {
  const sql = await readFile(new URL('../../prisma/v2/migrations/20261017140000_renderable_compile_state_v1/migration.sql', import.meta.url), 'utf8')
  const quoted = (text) => [...text.matchAll(/'([A-Za-z0-9-]+)'/g)].map((match) => match[1])
  const w = await world(), { bundle, command } = prepare(w, w.parent)
  // Only these functions are defined; no trigger is dropped, disabled or created, and no immutability is touched.
  assert.deepEqual([...sql.matchAll(/CREATE (?:OR REPLACE )?(?:FUNCTION|CONSTRAINT TRIGGER|TRIGGER) (\w+)/g)].map((match) => match[1]),
    ['w66_assert_renderable_compile_state_v1', 'w66_assert_operational_state_v3', 'w66_renderable_dispatch_v2'])
  assert.ok(!/DROP TRIGGER|DISABLE|w66_output_immutable|DROP FUNCTION/.test(sql))
  assert.deepEqual([...new Set([...sql.matchAll(/ALTER TABLE (\S+)/g)].map((match) => match[1]))], ['"edit_commands"'])
  // The Command type list of the table constraint is the registry, including the new type.
  const constraint = quoted(sql.match(/CHECK \("type" IN \(([\s\S]*?)\)\)/)[1]).sort()
  assert.deepEqual(constraint, [...EDIT_COMMAND_TYPES].sort())
  assert.ok(constraint.includes(command.type))
  // The origin: exact keys, the kind and the Command type.
  assert.deepEqual(quoted(sql.match(/w66_v3_exact_keys\(o,ARRAY\[([^\]]*)\]\)/)[1]).sort(), Object.keys(bundle.origin).sort())
  assert.ok(sql.includes(`o->>'kind' IS DISTINCT FROM '${bundle.origin.kind}'`) && sql.includes(`origin_kind='${bundle.origin.kind}'`))
  assert.ok(sql.includes(`cmd.type IS DISTINCT FROM '${command.type}'`))
  // The payload: exact keys of the Command payload and of the snapshot identity it carries.
  assert.deepEqual(quoted(sql.match(/w66_v3_exact_keys\(cmd_payload,ARRAY\[([^\]]*)\]\)/)[1]).sort(), Object.keys(command.payload).sort())
  assert.deepEqual(quoted(sql.match(/w66_v3_exact_keys\(cmd_payload->'snapshot',ARRAY\[([^\]]*)\]\)/)[1]).sort(), Object.keys(command.payload.snapshot).sort())
  // The producer.
  const producer = bundle.state.document.producer.document, body = sql.match(/expected_producer:=jsonb_build_object\(([^;]*)\);/)[1]
  assert.deepEqual([...new Set(quoted(body).filter((token) => Object.keys(producer).includes(token)))].sort(), Object.keys(producer).sort())
  assert.ok(body.includes(`'${producer.schemaVersion}'`) && body.includes(`'kind','${producer.kind}'`))
  // The reciprocal binding and the authority of the row, both directions.
  for (const marker of ['s."renderablePlanSnapshotId" IS DISTINCT FROM r.id', 's."renderablePlanId" IS DISTINCT FROM r."planId"', 's."renderablePlanHash" IS DISTINCT FROM r."planHash"',
    'r."projectVersionId" IS DISTINCT FROM v.id', 'r."createdAt" IS DISTINCT FROM v."createdAt"', 'renderable-edit-plan', 'w66_assert_plan_authority(s."renderablePlanAuthorityJson"', 'renderable-edit-plan-hash/v2', 'renderable-edit-plan/2026-09-05-v1',
    'W66v3 renderable snapshot differs from the State it is bound to', 'W66v3 renderable compile Command origin authority differs', 'w66_fork_copy_pending_v1',
    'W66v3 child Command changed a plan it declared unchanged'.replace('child Command', 'renderable compile'), 'apollo.w66_state_verified']) {
    assert.ok(sql.includes(marker), marker)
  }
  // The dispatch: contract 1 as before, contract 2 refused as before, contract 3 only with the reciprocal columns and the operational guard.
  const dispatch = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION w66_renderable_dispatch_v2'))
  assert.ok(dispatch.includes('Creation renderable is a blocked candidate'))
  assert.ok(dispatch.includes('outputContractVersion"=3') && dispatch.includes('PERFORM w66_assert_operational_state_v3(version."outputStateId")'))
  assert.ok(dispatch.includes('W66 new renderable snapshot lacks reciprocal state binding'))
  assert.ok(dispatch.includes('PERFORM w66_assert_output_state(version."outputStateId")'))
  // The dispatcher routes the new origin to its own guard and keeps the other three exactly.
  const dispatcher = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION w66_assert_operational_state_v3'), sql.indexOf('CREATE OR REPLACE FUNCTION w66_renderable_dispatch_v2'))
  for (const route of ["origin_kind='editorial-cut-command' THEN PERFORM w66_assert_editorial_state_v1", "origin_kind='child-command' THEN PERFORM w66_assert_child_command_state_v1",
    "origin_kind='renderable-compile-command' THEN PERFORM w66_assert_renderable_compile_state_v1", 'ELSE PERFORM w66_assert_operational_state_v3_historical']) assert.ok(dispatcher.includes(route), route)
})

test('a project whose head holds a renderable plan is a valid fork source: the row is the one its State binds, and no other', async () => {
  const { createProjectForkSourceV3 } = await import('../../src/v2/domain/project-fork-derivation.ts')
  const w = await world(), prepared = prepare(w, w.parent, {}, { planId: 'plan-renderable-rc-fork' }), { renderableSnapshot } = prepared
  // A fork reads the head the way every reader does: from the stored JSON, which has no undefined members.
  const bundle = JSON.parse(JSON.stringify(prepared.bundle))
  const source = createProjectForkSourceV3({ bundle, snapshots: bundle.snapshots, renderablePlanSnapshot: renderableSnapshot })
  assert.equal(source.state.document.renderablePlan.snapshotId, renderableSnapshot.id)
  // Without its row, or with another, the source is refused rather than forked without the plan it binds.
  assert.throws(() => createProjectForkSourceV3({ bundle, snapshots: bundle.snapshots, renderablePlanSnapshot: null }), (error) => error.code === 'INVALID_PROJECT_VERSION')
  assert.throws(() => createProjectForkSourceV3({ bundle, snapshots: bundle.snapshots, renderablePlanSnapshot: { ...renderableSnapshot, id: 'renderable-row-other' } }),
    (error) => error.code === 'INVALID_PROJECT_VERSION')
})

test('the author of a compile is its actor: an external client only with its own credential audit, an internal one without any', async () => {
  const { renderableCompileAuthor } = await import('../../src/v2/application/compile-renderable-plan-version.ts')
  const w = await world(), audit = materializeActorAuditContext(w.actor), workspaceId = audit.workspaceId
  const external = renderableCompileAuthor({ workspaceId, actor: { kind: 'api-client', id: audit.clientId }, audit })
  assert.deepEqual([external.author.type, external.author.id, external.audit], ['api-client', audit.clientId, audit])
  for (const bad of [{ actor: { kind: 'api-client', id: audit.clientId } }, { actor: { kind: 'api-client', id: 'client-other' }, audit },
    { actor: { kind: 'human', id: 'operator-ana' }, audit }]) {
    assert.throws(() => renderableCompileAuthor({ workspaceId, ...bad }), (error) => error.code === 'AUTH_INVALID')
  }
  assert.throws(() => renderableCompileAuthor({ workspaceId: 'workspace-other', actor: { kind: 'api-client', id: audit.clientId }, audit }), (error) => error.code === 'AUTH_INVALID')
  assert.deepEqual(renderableCompileAuthor({ workspaceId, actor: { kind: 'human', id: 'operator-ana' } }),
    { author: { type: 'user', id: 'operator-ana' }, audit: null })
  assert.equal(renderableCompileAuthor({ workspaceId, actor: { kind: 'system', id: 'worker' } }).author.type, 'system')
  // A Version made by an internal actor carries no credential audit, and the bundle says so.
  const internal = prepare(w, w.parent, { author: { type: 'user', id: 'operator-ana' }, audit: null }, { planId: 'plan-renderable-rc-internal' })
  assert.equal(internal.bundle.origin.audit, null)
  assert.equal(internal.bundle.version.createdBy, 'operator-ana')
})
