import assert from 'node:assert/strict'
import test from 'node:test'

import { materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { buildOperationalOutputVersionBundleV3, operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { validateOperationalOutputOriginV3 } from '../../src/v2/domain/output-version-origin.ts'
import { createProjectSnapshot } from '../../src/v2/domain/project-snapshot.ts'
import { transitionManualEditOutputState, transitionProjectOutputState } from '../../src/v2/domain/project-output-state-transition.ts'
import { ingestedRecordings, recompiledChild, rightsEvidenceFor, worldActor } from './helpers/output-world.mjs'

/**
 * A child Command may adopt the persisted, observed ingest receipts of the project's other recordings.
 *
 * State3 keeps one ingest's recording in the head State, but every ingest persisted its own receipt. A Command
 * whose plan consumes several recordings (a multicam cut, a selected insert, music, a replaced asset) therefore
 * seals its Version over the head's observation plus the adopted receipts. Adoption is fail-closed: only a
 * receipt of this workspace and project, sealed and observed, with the rights it was adopted under, and only for
 * a source the plan actually consumes and the parent does not already observe. The adoption is part of the
 * sealed origin and of the State's producer, so it is hash-bound and checked again by the database guard.
 */
const SLUGS = ['cam-a', 'cam-b', 'master']
let worldPromise
const world = () => (worldPromise ??= ingestedRecordings(SLUGS))
const sorted = (items) => [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** A plan that cuts `slugs` with the head's own recording (`master`) as the audio bed. */
function cutOver(w, slugs) {
  return (plan) => {
    const audio = w.names('master').sourceArtifactId
    const clips = slugs.map((slug, index) => ({
      id: `clip-adopt-${index + 1}`, sourceArtifactId: w.names(slug).sourceArtifactId, audioSourceArtifactId: audio,
      sourceInFrame: index * 30, sourceOutFrame: index * 30 + 30, timelineInFrame: index * 30, timelineOutFrame: index * 30 + 30, rate: 1,
    }))
    const ids = [...new Set([...slugs.map((slug) => w.names(slug).sourceArtifactId), audio])]
    return {
      ...plan, durationFrames: clips.length * 30, videoTracks: [{ ...plan.videoTracks[0], clips }], subtitleTracks: [],
      sources: ids.map((id) => ({ id, artifactId: id, kind: 'video', durationSeconds: 2 })), lineageRefs: ids,
    }
  }
}

const adopted = (bundle) => bundle.origin.adoptions.map((item) => item.sourceArtifactId)
const observedIds = (bundle) => sorted(new Set(bundle.state.document.entries.flatMap((entry) =>
  entry.consumption.status === 'materialized' ? entry.consumption.materialization.document.normalizations.map((n) => n.document.source.artifactId) : [])))

/** The proposal a bundle was built from, so a test can alter one fact and rebuild it. */
function proposalOf(bundle, parent) {
  const normalizations = [...new Map(bundle.state.document.entries.flatMap((entry) =>
    entry.consumption.status === 'materialized' ? entry.consumption.materialization.document.normalizations : []).map((n) => [n.document.id, n])).values()]
  return {
    allocation: { workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, resultVersionId: bundle.version.id,
      stateId: bundle.state.document.id, parentVersionId: parent.version.id, sequence: bundle.version.sequence, createdBy: bundle.version.createdBy,
      createdAt: bundle.version.createdAt },
    parent, origin: structuredClone(bundle.origin), restoreTarget: null, editPlanSnapshot: bundle.editPlanSnapshot, normalizations,
    materializationIds: Object.fromEntries(bundle.state.document.entries.map((entry) => [entry.variantId, entry.consumption.materialization.document.id])),
  }
}

test('a child Command adopts exactly the receipts its plan consumes and the parent does not observe', async () => {
  const w = await world()
  assert.deepEqual(observedIds(w.parent), ['artifact-master'], 'the head State holds only the latest recording')
  const bundle = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a', 'cam-b']), { suffix: 'adopt-two', adoptable: w.adoptable })

  assert.deepEqual(observedIds(bundle), ['artifact-cam-a', 'artifact-cam-b', 'artifact-master'])
  assert.deepEqual(adopted(bundle), ['artifact-cam-a', 'artifact-cam-b'], 'the head recording is not adopted; it is already observed')
  for (const item of bundle.origin.adoptions) {
    const receipt = w.receipts.get(item.sourceArtifactId.replace('artifact-', ''))
    assert.equal(item.receiptId, receipt.document.id)
    assert.equal(item.receiptHash, receipt.receiptHash)
    assert.equal(item.sourceManifestId, receipt.document.source.manifestId)
    assert.equal(item.sourceManifestHash, receipt.document.source.manifest.manifestHash)
    assert.deepEqual(item.rights, rightsEvidenceFor(item.sourceArtifactId.replace('artifact-', '')))
  }
  assert.deepEqual(adopted(bundle), sorted(bundle.origin.adoptions.map((item) => item.sourceArtifactId)))
  assert.deepEqual(bundle.origin.adoptions.map((item) => item.receiptId), sorted(bundle.origin.adoptions.map((item) => item.receiptId)))

  // The adoption is bound into the State: it is part of its producer and therefore of the Version's base hash.
  assert.deepEqual(bundle.state.document.producer.document.adoptions, bundle.origin.adoptions)
  assert.equal(bundle.state.document.parentStateHash, w.parent.state.stateHash)
  for (const entry of bundle.state.document.entries) assert.equal(entry.consumption.status, 'materialized')
})

test('an offered receipt the plan does not consume is not adopted', async () => {
  const w = await world()
  const bundle = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-one', adoptable: w.adoptable })
  assert.deepEqual(adopted(bundle), ['artifact-cam-a'])
  assert.deepEqual(observedIds(bundle), ['artifact-cam-a', 'artifact-master'])
  const none = recompiledChild(w.parent, w.actor, (plan) => structuredClone(plan), { suffix: 'adopt-none', adoptable: w.adoptable })
  assert.deepEqual(none.origin.adoptions, [], 'a Command that consumes only the parent observation adopts nothing')
  assert.deepEqual(none.state.document.producer.document.adoptions, [])
})

test('the adoption and the rights it was made under are sealed into the Version hash', async () => {
  const w = await world()
  const first = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-seal', adoptable: w.adoptable })
  const again = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-seal', adoptable: w.adoptable })
  assert.equal(again.version.baseHash, first.version.baseHash, 'sealing is deterministic')
  assert.equal(again.state.stateHash, first.state.stateHash)

  const moved = w.adoptable.map((item) => item.normalization.document.source.artifactId === 'artifact-cam-a'
    ? { ...item, rights: { ...item.rights, revision: item.rights.revision + 1 } } : item)
  const revised = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-seal', adoptable: moved })
  assert.notEqual(revised.state.stateHash, first.state.stateHash, 'other rights evidence is another State')
  assert.notEqual(revised.version.baseHash, first.version.baseHash)

  const rebuilt = buildOperationalOutputVersionBundleV3(proposalOf(first, w.parent))
  assert.equal(rebuilt.version.baseHash, first.version.baseHash, 'the stored origin alone rebuilds the same Version')
})

test('a plan that consumes a recording nobody observed or offered is refused, naming it', async () => {
  const w = await world()
  const offeredOnlyCamA = w.adoptable.filter((item) => item.normalization.document.source.artifactId === 'artifact-cam-a')
  assert.throws(() => recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a', 'cam-b']), { suffix: 'adopt-unobserved', adoptable: offeredOnlyCamA }),
    (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.sourceArtifactIds.length === 1 && error.details.sourceArtifactIds[0] === 'artifact-cam-b')
  assert.throws(() => recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-none-offered' }),
    (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.sourceArtifactIds.includes('artifact-cam-a'))
})

test('a receipt of another project or workspace is never adopted', async () => {
  const w = await world()
  const foreignProject = await ingestedRecordings(['cam-b', 'other'], { ids: { project: 'project-foreign' } })
  const foreignWorkspace = await ingestedRecordings(['cam-b', 'other'], { actor: worldActor({ workspaceId: 'workspace-foreign' }) })
  const camA = w.adoptable.filter((item) => item.normalization.document.source.artifactId === 'artifact-cam-a')
  for (const [label, other] of [['project', foreignProject], ['workspace', foreignWorkspace]]) {
    const offered = [...camA, { normalization: other.receipts.get('cam-b'), rights: rightsEvidenceFor('cam-b') }]
    assert.throws(() => recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a', 'cam-b']), { suffix: 'adopt-foreign-' + label, adoptable: offered }),
      (error) => error.code === 'INVALID_COMMAND', label)
  }
})

test('a tampered receipt is refused before it can be sealed into a State', async () => {
  const w = await world()
  const original = w.adoptable.find((item) => item.normalization.document.source.artifactId === 'artifact-cam-a')
  const forged = [
    { ...original, normalization: { ...original.normalization, receiptHash: 'f'.repeat(64) } },
    { ...original, normalization: { ...original.normalization, document: { ...original.normalization.document, attempt: 2 } } },
  ]
  for (const [index, item] of forged.entries()) {
    assert.throws(() => recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-forged-' + index, adoptable: [item] }),
      (error) => error.code === 'INVALID_RENDER_INPUT', 'forgery ' + index)
  }
})

test('a recording without current rights evidence cannot be adopted', async () => {
  const w = await world()
  const withoutRights = w.adoptable.map((item) => (item.normalization.document.source.artifactId === 'artifact-cam-a' ? { ...item, rights: null } : item))
  assert.throws(() => recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-no-rights', adoptable: withoutRights }),
    (error) => error.code === 'ASSET_RIGHTS_BLOCKED' && error.details.artifactIds.includes('artifact-cam-a'))
  // Rights evidence that is not needed does not block the Command.
  assert.deepEqual(adopted(recompiledChild(w.parent, w.actor, cutOver(w, ['cam-b']), { suffix: 'adopt-other-no-rights', adoptable: withoutRights })), ['artifact-cam-b'])
})

test('two receipts for one source artifact are ambiguous and refused', async () => {
  const w = await world()
  const camA = w.adoptable.find((item) => item.normalization.document.source.artifactId === 'artifact-cam-a')
  assert.throws(() => recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-duplicate', adoptable: [camA, camA] }),
    (error) => error.code === 'INVALID_COMMAND')
})

test('the sealed origin refuses an adoption that is missing, surplus, forged, misordered or already observed', async () => {
  const w = await world()
  const both = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a', 'cam-b']), { suffix: 'adopt-origin', adoptable: w.adoptable })
  const one = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-origin-one', adoptable: w.adoptable })
  const rebuild = (base, mutate) => {
    const proposal = proposalOf(base, w.parent)
    mutate(proposal)
    return () => buildOperationalOutputVersionBundleV3(proposal)
  }
  const refused = (error) => error.code === 'INVALID_COMMAND'
  assert.doesNotThrow(rebuild(both, () => {}))
  assert.throws(rebuild(both, (p) => { p.origin.adoptions = [] }), refused, 'an observation outside the parent without its adoption')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions = p.origin.adoptions.slice(0, 1) }), refused, 'one adoption missing')
  assert.throws(rebuild(one, (p) => { p.origin.adoptions = [...p.origin.adoptions, both.origin.adoptions[1]] }), refused, 'an adoption nothing consumes')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions = [...p.origin.adoptions].reverse() }), refused, 'adoptions are sorted')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions = [p.origin.adoptions[0], p.origin.adoptions[0]] }), refused, 'adoptions are unique')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions[0].receiptHash = 'f'.repeat(64) }), refused, 'receipt hash is the receipt seal')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions[0].sourceManifestHash = 'f'.repeat(64) }), refused, 'manifest hash is the receipt manifest')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions[0].sourceArtifactId = 'artifact-elsewhere' }), refused, 'artifact is the receipt source')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions[0].rights.snapshotId = '' }), (error) => error.code === 'INVALID_COMMAND' || error.code === 'INVALID_OUTPUT_SPEC', 'rights evidence is mandatory')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions[0].rights.extra = true }), refused, 'rights evidence has exactly its fields')
  assert.throws(rebuild(both, (p) => { p.origin.adoptions[0].extra = true }), refused, 'an adoption has exactly its fields')
  assert.throws(rebuild(both, (p) => { delete p.origin.adoptions }), refused, 'the origin always states its adoptions')

  // The head's own recording is observed already; adopting it is a second receipt for one source.
  const masterReceipt = w.receipts.get('master')
  const asAdoption = { receiptId: masterReceipt.document.id, receiptHash: masterReceipt.receiptHash, sourceArtifactId: masterReceipt.document.source.artifactId,
    sourceManifestId: masterReceipt.document.source.manifestId, sourceManifestHash: masterReceipt.document.source.manifest.manifestHash,
    rights: rightsEvidenceFor('master') }
  assert.throws(rebuild(one, (p) => { p.origin.adoptions = sorted([...p.origin.adoptions.map((a) => a.receiptId), asAdoption.receiptId])
    .map((id) => [...p.origin.adoptions, asAdoption].find((a) => a.receiptId === id)) }), refused, 'an observation the parent already holds is not adopted')
})

test('only a child-command origin carries adoptions: inherit, restore and ingest keep the parent observations exactly', async () => {
  const w = await world()
  const { parent } = w, audit = materializeActorAuditContext(w.actor)
  const scope = { workspaceId: parent.version.workspaceId, projectId: parent.version.projectId }
  const command = createEditCommand({ ...scope, id: 'command-adopt-origin', baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
    author: { type: 'api-client', id: audit.clientId }, type: 'set-project-lut-selection', scope: { project: true },
    payload: { schemaVersion: 2, mode: 'none', intensity: 1 }, idempotencyKey: 'adopt-origin-key', createdAt: '2026-10-16T09:00:00.000Z' })
  const allocation = { ...scope, resultVersionId: 'version-adopt-origin', stateId: 'state-adopt-origin', parentVersionId: parent.version.id,
    sequence: parent.version.sequence + 1, createdBy: audit.clientId, createdAt: '2026-10-16T09:00:00.000Z' }
  const origin = { kind: 'child-command', command, audit, requestFingerprint: calculateCanonicalHash({ adopt: 'origin' }), replaces: [], adoptions: [] }
  assert.ok(validateOperationalOutputOriginV3(origin, parent, allocation))
  assert.throws(() => validateOperationalOutputOriginV3({ ...origin, kind: 'inherit-command', adoptions: [] }, parent, allocation), (error) => error.code === 'INVALID_COMMAND')
})

test('a manual edit that replaces an asset adopts the replacement recording through the same transition', async () => {
  const w = await world()
  const { parent } = w, audit = materializeActorAuditContext(w.actor)
  const scope = { workspaceId: parent.version.workspaceId, projectId: parent.version.projectId }
  const plan = cutOver(w, ['cam-a'])(JSON.parse(operationalBundlePlanV3(parent).contentJson))
  const createdAt = '2026-10-16T09:00:00.000Z', resultVersionId = 'version-adopt-manual'
  const next = { ...plan, id: `edit-plan-${resultVersionId}`, projectVersionId: resultVersionId, createdAt }
  const command = createEditCommand({ ...scope, id: 'command-adopt-manual', baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
    author: { type: 'api-client', id: audit.clientId }, type: 'manual-edit', scope: { project: true },
    payload: { schemaVersion: 2, action: 'apply', operation: { kind: 'replace', clipId: 'clip-source-1', sourceId: 'artifact-cam-a' } },
    idempotencyKey: 'adopt-manual-key', createdAt })
  const base = operationalBundlePlanV3(parent)
  let counter = 0
  const bundle = transitionManualEditOutputState({
    parent, restoreTarget: null, command, audit, requestFingerprint: calculateCanonicalHash({ adopt: 'manual' }),
    allocation: { ...scope, resultVersionId, stateId: 'state-adopt-manual', parentVersionId: parent.version.id, sequence: parent.version.sequence + 1,
      createdBy: audit.clientId, createdAt },
    editPlanSnapshot: createProjectSnapshot({ ...scope, id: 'snapshot-adopt-manual', kind: 'edit-plan', contentSchemaVersion: base.contentSchemaVersion,
      contentJson: stableSerialize(next), contentHash: calculateCanonicalHash(next), createdAt }),
    createMaterializationId: () => `materialization-adopt-manual-${++counter}`, adoptable: w.adoptable,
  })
  assert.equal(bundle.origin.kind, 'child-command')
  assert.deepEqual(adopted(bundle), ['artifact-cam-a'])
  assert.throws(() => transitionManualEditOutputState({
    parent, restoreTarget: null, command, audit, requestFingerprint: calculateCanonicalHash({ adopt: 'manual' }),
    allocation: { ...scope, resultVersionId, stateId: 'state-adopt-manual', parentVersionId: parent.version.id, sequence: parent.version.sequence + 1,
      createdBy: audit.clientId, createdAt },
    editPlanSnapshot: bundle.editPlanSnapshot, createMaterializationId: () => 'materialization-adopt-manual-x',
  }), (error) => error.code === 'PRECONDITION_REQUIRED', 'without an offer the same replacement is refused')
})

test('transitionProjectOutputState is the only door: it takes the offer as data and adopts nothing it was not offered', async () => {
  const w = await world()
  assert.equal(typeof transitionProjectOutputState, 'function')
  const offered = w.adoptable.slice(0, 1)
  const bundle = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a']), { suffix: 'adopt-door', adoptable: offered })
  assert.deepEqual(adopted(bundle), ['artifact-cam-a'])
  assert.deepEqual(w.adoptable.map((item) => item.normalization.document.source.artifactId), ['artifact-cam-a', 'artifact-cam-b'], 'the offer is not consumed or mutated')
})
