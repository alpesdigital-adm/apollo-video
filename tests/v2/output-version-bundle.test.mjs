import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createProjectCreationOutputCommandV2, normalizeProjectCreationIntentV2, createProjectCreationCommand } from '../../src/v2/domain/project-creation-command.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { createOutputSpecRevisionBody } from '../../src/v2/domain/output-spec-revision.ts'
import { createOutputPlanAuthority, outputBoundVersionHashBody,
  calculateOutputBoundVersionHash } from '../../src/v2/domain/project-output-state.ts'
import { calculateOutputCanonicalHash, serializeOutputCanonicalJson,
  OUTPUT_CANONICAL_POLICY_VERSION } from '../../src/v2/domain/output-canonical-policy.ts'
import { buildCreationOutputVersionBundleV2, validateCreationOutputVersionBundleV2, buildOutputVersionBundle } from '../../src/v2/domain/output-version-bundle.ts'

// Contract fixtures only: no PG, renderer, source truth or API acceptance claim.
const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
const hash = 'a'.repeat(64), at = '2026-10-11T12:00:00.000Z'
const scope = { workspaceId: 'workspace-bundle', projectId: 'project-bundle' }
const audit = createApiAccessAuditContext({ workspaceId: scope.workspaceId, clientId: 'client-bundle',
  credentialId: 'credential-bundle', environment: 'sandbox', authenticationKind: 'bearer' })
const plan = (versionId, createdAt) => ({ schemaVersion: 2, state: 'uncompiled', id: `edit-plan-${versionId}`,
  projectVersionId: versionId, fps: 30, durationFrames: 0, sources: [], videoTracks: [],
  overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [], createdAt })
const anchor = (document, snapshotId) => ({ snapshotId, hash: calculateCanonicalHash(document),
  authority: createOutputPlanAuthority({ ...policy, kind: 'project-edit-plan', planDocument: document }) })
const producer = (document) => ({ document, hash: calculateOutputCanonicalHash(document) })
function nonOutputSnapshot(kind, id) {
  const document = { schemaVersion: 1, evidenceScope: 'controlled-domain-contract', kind }
  return { schemaVersion: 1, ...scope, id, kind, contentSchemaVersion: 1,
    contentJson: stableSerialize(document), contentHash: calculateCanonicalHash(document), createdAt: at }
}
function rootInput({ optionalSnapshots = false, fork = false } = {}) {
  const versionId = 'version-bundle-root', stateId = 'state-bundle-root', snapshotId = 'snapshot-bundle-root'
  const edit = plan(versionId, at)
  const nonOutputSnapshotFacts = { brief: nonOutputSnapshot('brief', 'snapshot-bundle-brief'),
    policies: nonOutputSnapshot('policies', 'snapshot-bundle-policies'),
    treatment: optionalSnapshots ? nonOutputSnapshot('treatment', 'snapshot-bundle-treatment') : null,
    story: optionalSnapshots ? nonOutputSnapshot('story', 'snapshot-bundle-story') : null }
  const source = fork ? { sourceProjectId: 'project-bundle-source', sourceVersionId: 'version-bundle-source' } : {}
  const command = createProjectCreationCommand({ ...scope, id: 'creation-bundle-root', action: fork ? 'duplicate' : 'create',
    versionId, audit, requestFingerprint: hash, createdAt: at, ...source })
  return { version: { ...policy, ...scope, id: versionId, sequence: 1,
    ...(fork ? { forkedFromProjectId: source.sourceProjectId, forkedFromVersionId: source.sourceVersionId } : {}),
    snapshotRefs: { brief: nonOutputSnapshotFacts.brief.id, editPlan: snapshotId, policies: nonOutputSnapshotFacts.policies.id,
      ...(optionalSnapshots ? { treatment: nonOutputSnapshotFacts.treatment.id, story: nonOutputSnapshotFacts.story.id } : {}) },
    createdBy: audit.clientId, createdAt: at },
  state: { ...policy, ...scope, id: stateId, resultVersionId: versionId,
    parentVersionId: null, parentStateId: null, parentStateHash: null, transition: fork ? 'fork-empty' : 'initialize-empty',
    provenance: { kind: 'creation-command', id: command.id, hash: command.commandHash },
    producer: producer({ ...policy, schemaVersion: 'project-created-version/v1',
      briefHash: nonOutputSnapshotFacts.brief.contentHash, policyHash: nonOutputSnapshotFacts.policies.contentHash }),
    editPlan: anchor(edit, snapshotId), renderablePlan: null, entries: [], overlays: [], invalidations: [], createdAt: at },
  facts: { editPlanDocument: edit, renderablePlanDocument: null }, nonOutputSnapshotFacts, parent: null,
  expectedBaseHash: null, origin: { kind: 'creation-command', command } }
}
const encoding = (kind) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true,
  width: kind === 'final' ? 1080 : 540, height: kind === 'final' ? 1920 : 960, fps: 30,
  quality: { mode: 'crf', value: kind === 'final' ? 18 : 23, preset: kind === 'final' ? 'medium' : 'veryfast' },
  audio: { codec: 'aac', bitrateKbps: kind === 'final' ? 192 : 160, sampleRateHz: 48000, channels: 1 } })
function revision(variantId, revisionNumber, createdAt) {
  return createOutputSpecRevisionBody({ ...policy, ...scope, id: `revision-${variantId}-${revisionNumber}`, variantId,
    revisionNumber, createdAt, output: { schemaVersion: 1, id: variantId, locale: 'pt-BR', aspectRatio: '9:16',
      width: 1080, height: 1920, fps: 30, safeArea: { top: .08, right: .06, bottom: .06, left: .06 }, deliveryProfileId: 'profile-bundle' },
    profile: { schemaVersion: 'materialized-delivery-profile/v1', id: 'profile-bundle', version: 1,
      rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding('final'), proxy: encoding('proxy'),
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 2, scaleY: 2 },
      subtitles: { mode: 'none', configuration: null, fontAssets: [] } }, preset: null })
}
function childInput(parent, { suffix = 'child', variantId = 'variant-bundle-alpha', type = 'create-output-variant' } = {}) {
  const versionId = `version-bundle-${suffix}`, snapshotId = `snapshot-bundle-${suffix}`
  const createdAt = new Date(Date.parse(at) + parent.version.sequence * 60_000).toISOString()
  const previous = parent.state.document.entries.find((entry) => entry.variantId === variantId)
  const spec = revision(variantId, type === 'create-output-variant' ? 1 : previous.spec.revisionNumber + 1, createdAt)
  const result = createOutputVariantCommand({ command: { ...scope, id: `command-bundle-${suffix}`,
    baseVersionId: parent.version.id, baseHash: parent.version.baseHash, type,
    author: { type: 'api-client', id: audit.clientId }, idempotencyKey: `request-bundle-${suffix}`, createdAt }, audit,
  base: parent.version, baseState: parent.state, historicalBaselineRequested: false, revision: spec,
  expectedRevisionId: type === 'create-output-variant' ? null : previous.outputSpecRevisionId,
  expectedSpecHash: type === 'create-output-variant' ? null : previous.specHash, durationFrames: 0 })
  const edit = { ...parent.facts.editPlanDocument, id: `edit-plan-${versionId}`, projectVersionId: versionId, createdAt }
  const entry = { ...policy, variantId, outputSpecRevisionId: spec.id, specHash: calculateOutputCanonicalHash(spec), spec,
    geometry: { status: 'unmaterialized', projection: null, projectionHash: null } }
  return { version: { ...policy, ...scope, id: versionId, sequence: parent.version.sequence + 1,
    parentVersionId: parent.version.id, snapshotRefs: { ...parent.version.snapshotRefs, editPlan: snapshotId },
    createdBy: audit.clientId, createdAt, commandId: result.command.id },
  state: { ...policy, ...scope, id: `state-bundle-${suffix}`, resultVersionId: versionId,
    parentVersionId: parent.version.id, parentStateId: parent.state.document.id, parentStateHash: parent.state.stateHash,
    transition: type === 'create-output-variant' ? 'create-variant' : 'revise-output',
    provenance: { kind: 'edit-command', id: result.command.id, hash: result.command.commandHash }, producer: result.producer,
    editPlan: anchor(edit, snapshotId), renderablePlan: null,
    entries: [...parent.state.document.entries.filter((item) => item.variantId !== variantId), entry],
    overlays: parent.state.document.overlays, invalidations: parent.state.document.invalidations, createdAt },
  facts: { editPlanDocument: edit, renderablePlanDocument: null }, nonOutputSnapshotFacts: structuredClone(parent.nonOutputSnapshotFacts),
  parent, expectedBaseHash: null,
  origin: { kind: 'output-variant-command', result } }
}
function expectCode(input, code) { assert.throws(() => buildOutputVersionBundle(input), (error) => error.code === code) }

test('W66 Version hash body preserves the independently captured pre-extraction golden', () => {
  const input = { ...scope, resultVersionId: 'version-bundle-root', parentVersionId: null, previousBaseHash: null,
    producerHash: 'a'.repeat(64), outputStateId: 'state-bundle-root', outputStateHash: 'b'.repeat(64) }
  // Literal order is independent of both authority and serializer helpers.
  const literal = '{"canonicalPolicyVersion":"output-canonical-json/v1","outputStateHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","outputStateId":"state-bundle-root","parentVersionId":null,"previousBaseHash":null,"producerHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","projectId":"project-bundle","resultVersionId":"version-bundle-root","schemaVersion":"project-version-output-state/v1","workspaceId":"workspace-bundle"}'
  const expected = '7c0b73d7ae76611de4583c5464688e3e0b9f53a1adca3628801983df2e593e44'
  assert.equal(createHash('sha256').update(literal, 'utf8').digest('hex'), expected)
  assert.equal(serializeOutputCanonicalJson(outputBoundVersionHashBody(input)), literal)
  assert.equal(calculateOutputBoundVersionHash(input), expected)
})

test('W66 root with actual snapshot facts matches the independent Python literal golden', () => {
  // Captured by the owner with Python stdlib, independently spelled ASCII
  // documents and SHA256; no JS imports or builder calls generated this vector.
  // w66-root-facts-independent-golden-v1.json receipt SHA256:
  // 4dad69c2195ec565f0fa519ef76dee7775cf8d9bf1bad6f96f41f04d500c02c7.
  const expectedStateHash = 'c9a6e074134fcb23da8962090cc13b7ec1cec5c3030288ee3b18c264b0ae0f17'
  const expectedBaseHash = '8412b79267e07a397f0c6e76754ec6a2c9c8f315ba54cad93a04cdff32175ab9'
  const literal = '{"canonicalPolicyVersion":"output-canonical-json/v1","outputStateHash":"c9a6e074134fcb23da8962090cc13b7ec1cec5c3030288ee3b18c264b0ae0f17","outputStateId":"state-bundle-root","parentVersionId":null,"previousBaseHash":null,"producerHash":"ed979ba2121c195344719018ea0c61a1bc25a9a652f651a3bab996658d0e0e8a","projectId":"project-bundle","resultVersionId":"version-bundle-root","schemaVersion":"project-version-output-state/v1","workspaceId":"workspace-bundle"}'
  assert.equal(createHash('sha256').update(literal, 'utf8').digest('hex'), expectedBaseHash)
  const bundle = buildOutputVersionBundle({ ...rootInput(), expectedBaseHash })
  assert.equal(bundle.state.stateHash, expectedStateHash)
  assert.equal(bundle.version.baseHash, expectedBaseHash)
  assert.equal(bundle.outputBaseHashJson, literal)
})

test('W66 pure bundle creates a scoped empty root without a State/Version hash cycle', () => {
  const input = rootInput(), bundle = buildOutputVersionBundle(input)
  assert.equal(bundle.version.id, input.version.id)
  assert.equal(bundle.state.document.resultVersionId, bundle.version.id)
  assert.equal(bundle.version.outputStateHash, bundle.state.stateHash)
  assert.equal(bundle.previousBaseHash, null)
  assert.equal(bundle.editCommandSeal, null)
  assert.equal('baseHash' in bundle.state.document, false)
  assert.equal(createHash('sha256').update(bundle.outputBaseHashJson, 'utf8').digest('hex'), bundle.version.baseHash)
  assert.equal(JSON.parse(bundle.outputBaseHashJson).outputStateHash, bundle.state.stateHash)
  assert.equal('outputBaseHashJson' in bundle.version, false, 'authority text belongs to persistence bundle only')
  assert.equal(Object.isFrozen(bundle.facts.editPlanDocument), true)
  assert.equal(buildOutputVersionBundle({ ...input, expectedBaseHash: bundle.version.baseHash }).version.baseHash, bundle.version.baseHash)
})

test('W66 child bundle binds the exact output Command, new payload seal and historical Command authority', () => {
  const parent = buildOutputVersionBundle(rootInput()), request = childInput(parent), child = buildOutputVersionBundle(request)
  const seal = child.editCommandSeal
  const { commandHash: _commandHash, ...body } = request.origin.result.command
  assert.equal(seal.commandJson, stableSerialize(body))
  assert.equal(child.previousBaseHash, parent.version.baseHash)
  assert.equal(child.state.document.parentStateHash, parent.state.stateHash)
  assert.equal(child.state.document.entries[0].variantId, 'variant-bundle-alpha')
  assert.notEqual(child.state.document.entries[0].variantId, child.state.document.entries[0].spec.output.aspectRatio)
  assert.equal(createHash('sha256').update(seal.commandJson, 'utf8').digest('hex'), seal.commandHash)
  assert.equal(createHash('sha256').update(seal.outputPayloadJson, 'utf8').digest('hex'), seal.outputPayloadHash)
  assert.equal(JSON.parse(seal.commandJson).commandHash, undefined)
  assert.deepEqual(JSON.parse(seal.outputPayloadJson), JSON.parse(seal.commandJson).payload)
  assert.equal(child.state.document.producer.document.payloadHash, seal.outputPayloadHash)
  assert.equal(child.state.document.producer.document.commandHash, seal.commandHash)
  assert.equal(JSON.parse(child.outputBaseHashJson).previousBaseHash, parent.version.baseHash)
  const revised = buildOutputVersionBundle(childInput(child, { suffix: 'revision', type: 'revise-output-spec' }))
  assert.equal(revised.state.document.entries[0].spec.revisionNumber, 2)
  assert.equal(JSON.parse(revised.editCommandSeal.outputPayloadJson).expectedRevisionId, child.state.document.entries[0].outputSpecRevisionId)
})

test('W66 bundle refuses missing policy, missing authority, contract zero and incoherent allocated bases', () => {
  for (const mutate of [
    (i) => { delete i.version.canonicalPolicyVersion }, (i) => { delete i.state.canonicalPolicyVersion },
    (i) => { delete i.state.editPlan.authority },
  ]) { const input = rootInput(); mutate(input); expectCode(input, 'INVALID_OUTPUT_SPEC') }
  for (const mutate of [
    (i) => { i.version.id = 'version-bundle-sister' }, (i) => { i.state.workspaceId = 'workspace-sister' },
    (i) => { i.version.snapshotRefs.editPlan = 'snapshot-sister' }, (i) => { i.expectedBaseHash = 'f'.repeat(64) },
    (i) => { i.version.baseHash = 'f'.repeat(64) }, (i) => { i.origin.command = { ...i.origin.command, commandHash: 'f'.repeat(64) } },
    (i) => { i.state.transition = 'create-variant' },
  ]) { const input = rootInput(); mutate(input); expectCode(input, 'INVALID_PROJECT_VERSION') }
  const parent = buildOutputVersionBundle(rootInput())
  for (const mutate of [
    (i) => { i.parent.version.outputContractVersion = 0 }, (i) => { i.parent.version.baseHash = 'f'.repeat(64) },
    (i) => { i.parent.outputBaseHashJson += ' ' }, (i) => { i.parent.previousBaseHash = 'f'.repeat(64) },
    (i) => { i.state.parentStateHash = 'f'.repeat(64) }, (i) => { i.version.parentVersionId = 'version-ancestor' },
  ]) { const input = structuredClone(childInput(parent)); mutate(input); expectCode(input, 'INVALID_PROJECT_VERSION') }
})

test('W66 bundle rejects fully resealed producer, format aliases, hidden plan edits and invented member effects', () => {
  const parent = buildOutputVersionBundle(rootInput())
  for (const mutate of [
    (i) => { i.state.producer.document.payloadHash = 'f'.repeat(64); i.state.producer.hash = calculateOutputCanonicalHash(i.state.producer.document) },
    (i) => { i.origin.result.producer.document.commandHash = 'f'.repeat(64); i.origin.result.producer.hash = calculateOutputCanonicalHash(i.origin.result.producer.document) },
    (i) => { i.origin.result.requestFingerprint = 'f'.repeat(64) },
    (i) => { i.state.provenance.hash = 'f'.repeat(64) }, (i) => { i.state.entries[0].variantId = '9:16' },
    (i) => { i.state.transition = 'inherit' },
    (i) => { i.state.entries.push({ ...i.state.entries[0], variantId: 'variant-bundle-sister' }) },
    (i) => { i.facts.editPlanDocument.markers = ['uncommanded']; i.state.editPlan = anchor(i.facts.editPlanDocument, i.version.snapshotRefs.editPlan) },
    (i) => { i.origin.result.command.type = 'manual-edit'; const { commandHash: _old, ...body } = i.origin.result.command;
      i.origin.result.command.commandHash = calculateCanonicalHash(body) },
  ]) { const input = structuredClone(childInput(parent)); mutate(input); expectCode(input, 'INVALID_COMMAND') }
  const child = buildOutputVersionBundle(childInput(parent))
  const ancestor = childInput(child, { suffix: 'ancestor-denied', type: 'revise-output-spec' })
  ancestor.parent = parent
  expectCode(ancestor, 'INVALID_PROJECT_VERSION')
  const sister = structuredClone(childInput(child, { suffix: 'sister-denied', type: 'revise-output-spec' }))
  sister.state.entries[0].outputSpecRevisionId = 'revision-sister'
  sister.state.entries[0].spec = { ...sister.state.entries[0].spec, id: 'revision-sister' }
  sister.state.entries[0].specHash = calculateOutputCanonicalHash(sister.state.entries[0].spec)
  expectCode(sister, 'INVALID_COMMAND')
})

test('W66 pure helper requires a plan materialized for the new Version rather than an inherited ancestor', () => {
  const parent = buildOutputVersionBundle(rootInput()), input = childInput(parent)
  input.facts = parent.facts
  input.state.editPlan = anchor(parent.facts.editPlanDocument, input.version.snapshotRefs.editPlan)
  expectCode(input, 'INVALID_OUTPUT_SPEC')
})

test('W66 a fully rehashed Command cannot replace its real parent ID or base hash', () => {
  const parent = buildOutputVersionBundle(rootInput())
  for (const [field, replacement] of [['baseHash', 'f'.repeat(64)], ['baseVersionId', 'version-ancestor']]) {
    const input = structuredClone(childInput(parent)), result = input.origin.result
    result.command[field] = replacement
    const { commandHash: _oldHash, ...body } = result.command
    result.command.commandHash = calculateCanonicalHash(body)
    result.producer.document[field] = replacement
    result.producer.document.commandHash = result.command.commandHash
    result.producer.hash = calculateOutputCanonicalHash(result.producer.document)
    input.state.provenance.hash = result.command.commandHash
    assert.equal(input.state.producer.hash, result.producer.hash)
    expectCode(input, 'VERSION_CONFLICT')
  }
})

test('W66 roots bind historical snapshot facts; output children preserve all non-output references and presence', () => {
  for (const optionalSnapshots of [false, true]) {
    const parent = buildOutputVersionBundle(rootInput({ optionalSnapshots }))
    const child = buildOutputVersionBundle(childInput(parent))
    const revised = buildOutputVersionBundle(childInput(child, { suffix: 'facts-revised', type: 'revise-output-spec' }))
    for (const bundle of [parent, child, revised]) {
      assert.deepEqual(bundle.nonOutputSnapshotFacts, parent.nonOutputSnapshotFacts)
      assert.equal(Object.isFrozen(bundle.nonOutputSnapshotFacts), true)
      for (const kind of ['brief', 'policies', 'treatment', 'story']) {
        assert.equal(Object.hasOwn(bundle.version.snapshotRefs, kind), Object.hasOwn(parent.version.snapshotRefs, kind))
        assert.equal(bundle.version.snapshotRefs[kind], parent.version.snapshotRefs[kind])
      }
    }
  }
  const fork = buildOutputVersionBundle(rootInput({ fork: true }))
  assert.equal(fork.state.document.transition, 'fork-empty')
  assert.equal(fork.version.forkedFromVersionId, 'version-bundle-source')
})

test('W66 create and revise reject coherent non-target snapshots and optional presence changes', () => {
  const root = buildOutputVersionBundle(rootInput({ optionalSnapshots: true }))
  const child = buildOutputVersionBundle(childInput(root))
  for (const type of ['create-output-variant', 'revise-output-spec']) {
    const parent = type === 'create-output-variant' ? root : child
    for (const kind of ['brief', 'policies', 'treatment', 'story']) {
      const input = structuredClone(childInput(parent, { suffix: `replace-${kind}`, type }))
      const parentBefore = structuredClone(input.parent)
      input.version.snapshotRefs[kind] = `snapshot-bundle-other-${kind}`
      input.nonOutputSnapshotFacts[kind].id = input.version.snapshotRefs[kind]
      expectCode(input, 'INVALID_COMMAND')
      assert.deepEqual(input.parent, parentBefore, 'Coherent child replacement must preserve its valid parent')
    }
    for (const kind of ['treatment', 'story']) {
      const input = structuredClone(childInput(parent, { suffix: `remove-${kind}`, type }))
      const parentBefore = structuredClone(input.parent)
      delete input.version.snapshotRefs[kind]
      input.nonOutputSnapshotFacts[kind] = null
      expectCode(input, 'INVALID_COMMAND')
      assert.deepEqual(input.parent, parentBefore, 'Optional removal must preserve its valid parent')
    }
  }
  const empty = buildOutputVersionBundle(rootInput())
  for (const kind of ['treatment', 'story']) {
    const input = structuredClone(childInput(empty, { suffix: `add-${kind}` }))
    const parentBefore = structuredClone(input.parent)
    input.nonOutputSnapshotFacts[kind] = nonOutputSnapshot(kind, `snapshot-bundle-added-${kind}`)
    input.version.snapshotRefs[kind] = input.nonOutputSnapshotFacts[kind].id
    expectCode(input, 'INVALID_COMMAND')
    assert.deepEqual(input.parent, parentBefore, 'Optional addition must preserve its valid parent')
  }
})

test('W66 root snapshot facts reject missing, hidden, wrong scope/kind and resealed producer assertions', () => {
  for (const mutate of [
    (i) => { delete i.nonOutputSnapshotFacts },
    (i) => { delete i.nonOutputSnapshotFacts.story },
    (i) => { delete i.version.snapshotRefs.brief },
    (i) => { i.nonOutputSnapshotFacts.treatment = nonOutputSnapshot('treatment', 'snapshot-hidden') },
    (i) => { i.nonOutputSnapshotFacts.brief.kind = 'policies' },
    (i) => { i.nonOutputSnapshotFacts.brief.schemaVersion = 2 },
    (i) => { i.nonOutputSnapshotFacts.policies.projectId = 'project-sister' },
    (i) => { i.nonOutputSnapshotFacts.brief.workspaceId = 'workspace-sister' },
    (i) => { i.nonOutputSnapshotFacts.brief.contentHash = 'f'.repeat(64) },
    (i) => { i.nonOutputSnapshotFacts.policies.contentJson += '\n' },
    (i) => { i.nonOutputSnapshotFacts.brief.contentJson = stableSerialize({ altered: true });
      i.nonOutputSnapshotFacts.brief.contentHash = calculateCanonicalHash({ altered: true }) },
    (i) => { i.state.producer.document.briefHash = 'f'.repeat(64); i.state.producer = producer(i.state.producer.document) },
    (i) => { i.state.producer.document.policyHash = 'f'.repeat(64); i.state.producer = producer(i.state.producer.document) },
    (i) => { i.state.producer.document.invented = true; i.state.producer = producer(i.state.producer.document) },
  ]) { const input = structuredClone(rootInput()); mutate(input); expectCode(input, 'INVALID_PROJECT_VERSION') }
})

test('W66 child author and time remain tied to the exact authenticated Command after State resealing', () => {
  const parent = buildOutputVersionBundle(rootInput())
  for (const mutate of [
    (i) => { i.version.createdBy = 'client-bundle-other' },
    (i) => { const changed = new Date(Date.parse(i.version.createdAt) + 1000).toISOString();
      i.version.createdAt = changed; i.state.createdAt = changed },
  ]) { const input = structuredClone(childInput(parent)); mutate(input); expectCode(input, 'INVALID_COMMAND') }
  for (const mutate of [
    (i) => { i.version.createdBy = 'client-bundle-other' },
    (i) => { const changed = new Date(Date.parse(i.version.createdAt) + 1000).toISOString();
      i.version.createdAt = changed; i.state.createdAt = changed },
  ]) { const input = structuredClone(rootInput()); mutate(input); expectCode(input, 'INVALID_PROJECT_VERSION') }
})

import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { PrismaCreationOutputBundleRepositoryV2 } from '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
function isolatedCreation2Root() {
  const intent=normalizeProjectCreationIntentV2({schemaVersion:'project-creation-intent/v2',kind:'initialize-empty',name:'Creation2 contract',objective:'discovery',locale:'pt-BR',briefing:null,desiredAction:{}})
  const projectId='project-creation2-bundle',versionId='version-creation2-bundle'
  const documents=[['brief',{schemaVersion:1,objective:intent.objective,desiredAction:intent.desiredAction,productionBrief:createProductionBrief({}),createdAt:at}],
    ['policies',{schemaVersion:1,workspaceId:scope.workspaceId,state:'unconfigured',brandKitMode:'inherit',guardrails:[],createdAt:at}],
    ['edit-plan',plan(versionId,at)]]
  const snapshots=documents.map(([kind,document])=>({schemaVersion:1,id:'snapshot-creation2-'+kind,workspaceId:scope.workspaceId,projectId,kind,contentSchemaVersion:document.schemaVersion,
    contentJson:stableSerialize(document),contentHash:calculateCanonicalHash(document),createdAt:at}))
  return createProjectCreationOutputCommandV2({...policy,id:'command-creation2-bundle',workspaceId:scope.workspaceId,projectId,versionId,audit,createdAt:at,
    payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent:intent,allocations:{stateId:'state-creation2-bundle',snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:null},
      snapshots,forkDerivation:null,renderableCandidate:null}})
}
test('Creation2 base authority uses a declared new wrapper and does not reinterpret contract1 golden',()=>{
  const command=isolatedCreation2Root(),bundle=buildCreationOutputVersionBundleV2(command)
  const expected={...policy,schemaVersion:'project-output-bound-version-hash/v2',workspaceId:scope.workspaceId,projectId:command.projectId,resultVersionId:command.versionId,
    parentVersionId:null,previousBaseHash:null,producerHash:bundle.state.document.producer.hash,outputStateId:bundle.state.document.id,outputStateHash:bundle.state.stateHash}
  assert.equal(bundle.outputBaseHashJson,serializeOutputCanonicalJson(expected))
  assert.equal(bundle.version.baseHash,createHash('sha256').update(bundle.outputBaseHashJson).digest('hex'))
  const bad=structuredClone(bundle);bad.outputBaseHashJson=serializeOutputCanonicalJson({...expected,schemaVersion:'project-output-bound-version-hash/v1'})
  bad.version.baseHash=createHash('sha256').update(bad.outputBaseHashJson).digest('hex')
  assert.throws(()=>validateCreationOutputVersionBundleV2(bad),e=>e.code==='INVALID_PROJECT_VERSION')
})
test('Creation2 transaction retry recognizes only P2034 or raw P2010 SQLSTATE40001 and exhausts at three',async()=>{
  const proposal=isolatedCreation2Root()
  for(const [label,error,attempts] of [
    ['Prisma serialization',{code:'P2034'},3],['raw serialization',{code:'P2010',meta:{code:'40001'}},3],
    ['other SQLSTATE',{code:'P2010',meta:{code:'23505'}},1],['misplaced SQLSTATE',{code:'P2010',meta:{sqlstate:'40001'}},1],
    ['message is not authority',new Error('40001 serialization'),1],
  ]){
    let calls=0,recompositions=0
    const client={$transaction:async()=>{calls++;throw error}},repository=new PrismaCreationOutputBundleRepositoryV2(client)
    await assert.rejects(()=>repository.persist({proposal,idempotencyKey:'request-creation2',idempotencyRecordId:'idem-creation2',eventIds:['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'],
      recompose:()=>{recompositions++;return proposal}}),e=>attempts===3?e.code==='PERSISTENCE_CONFLICT':e===error,label)
    assert.equal(calls,attempts,label);assert.equal(recompositions,0,'a pre-callback fault creates no bundle or provider work')
  }
})
