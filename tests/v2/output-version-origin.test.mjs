import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { normalizeProjectCreationIntentV2, validateNormalizedProjectCreationIntentV2, creationProjectMetadataV2, createProjectCreationOutputCommandV2, validateProjectCreationOutputCommandV2, createProjectCreationCommand, createProjectCreationCommandV2, createV2RenderablePlanSnapshotFacts, indexForkIdentityBijectionV2 } from '../../src/v2/domain/project-creation-command.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { createOutputSpecRevisionBody } from '../../src/v2/domain/output-spec-revision.ts'
import { requireOutputStateConsumableV2, createOutputPlanAuthority, createProjectOutputState, calculateOutputBoundVersionHash, outputBoundVersionHashBody } from '../../src/v2/domain/project-output-state.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION, serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { assembleDirectedEditPlan } from '../../src/v2/application/renderable-edit-plan.ts'
import { validateDirectedEditPlan, createDirectedAudioTimelineHash } from '../../src/v2/domain/director-run.ts'
import { createProjectForkDerivationV2, materializeForkEditPlanV2, buildForkRenderablePlanCandidateV2, createProjectForkDerivation, createForkRenderablePlanCandidate, materializeForkRenderablePlan, materializeForkEditPlan, remapForkSnapshotDocument,
  createProjectForkSourceV3, forkOwnedIdentitiesV3, createProjectForkKernelV3, createProjectForkDerivationV3, buildForkRenderablePlanCandidateV3,
  PROJECT_FORK_COMPILE_POLICY_VERSION } from '../../src/v2/domain/project-fork-derivation.ts'
import { calculateRenderablePlanHash } from '../../src/v2/domain/renderable-plan-authority.ts'
import { materializeManualEditPlan } from '../../src/v2/domain/manual-editing.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'
import { rebuildRetiredContractOneVersion } from '../../src/v2/domain/project-version.ts'
import { buildCreationOutputVersionBundleV2, validateCreationOutputVersionBundleV2, buildOutputVersionBundle } from '../../src/v2/domain/output-version-bundle.ts'
import { createQueuedPublicOperation } from '../../src/v2/domain/public-operation.ts'
import { assertCreationRecompositionV2 } from '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
import { createMediaArtifactManifestV2, createMediaArtifactManifest } from '../../src/v2/domain/media-artifact.ts'
import { inspectCreationOutputOriginV2, inspectOutputVersionOriginDraft, forkOwnedIdentities, buildProjectCreationOriginCommandV2, OUTPUT_VERSION_ORIGIN_KINDS,
  OUTPUT_ORIGIN_PERSISTENCE_STATUS } from '../../src/v2/domain/output-version-origin.ts'

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
// Fixtures reuse existing public constructors. These checks are contract-only,
// not PostgreSQL/rights/lifecycle/render or caller-intent evidence.
function allocation(request) {
  return { ...scope, resultVersionId: request.version.id, stateId: request.state.id,
    parentVersionId: request.version.parentVersionId ?? null, sequence: request.version.sequence,
    createdBy: request.version.createdBy, createdAt: request.version.createdAt }
}
function outputDraft(request) {
  return { ...policy, schemaVersion: 'output-version-origin-draft/v1', kind: request.origin.result.command.type,
    allocation: allocation(request), base: request.parent, result: request.origin.result }
}
function creationDraft() {
  const request = rootInput()
  return { ...policy, schemaVersion: 'output-version-origin-draft/v1', kind: 'creation-empty',
    allocation: allocation(request), base: null, command: request.origin.command, commandV2: null }
}
function forkDraft() {
  const root = buildOutputVersionBundle(rootInput()), source = buildOutputVersionBundle(childInput(root))
  const target = { ...scope, projectId: 'project-fork-target', resultVersionId: 'version-fork-target',
    stateId: 'state-fork-target', parentVersionId: null, sequence: 1, createdBy: audit.clientId, createdAt: at }
  const command = createProjectCreationCommand({ id: 'creation-fork-target', workspaceId: target.workspaceId,
    projectId: target.projectId, versionId: target.resultVersionId, action: 'duplicate',
    sourceProjectId: source.version.projectId, sourceVersionId: source.version.id, audit,
    requestFingerprint: hash, createdAt: at })
  return { ...policy, schemaVersion: 'output-version-origin-draft/v1', kind: 'fork-with-content',
    allocation: target, base: null, command, source, sourceRenderablePlanSnapshot: null, commandV2: null, cropDecisions: [],
    identityMap: forkOwnedIdentities(source).map(({ kind, id }) => ({ kind, sourceId: id,
      targetId: kind === 'version' ? target.resultVersionId : kind === 'state' ? target.stateId : `fork-${kind}-${id}` })) }
}
const expectCode = (input, code) => assert.throws(() => inspectOutputVersionOriginDraft(input), (error) => error.code === code)

test('W66 origin proposal is exhaustive and emits no persistence or State authority', () => {
  assert.deepEqual(OUTPUT_VERSION_ORIGIN_KINDS, ['creation-empty', 'fork-with-content', 'create-output-variant',
    'revise-output-spec', 'ingest-operation', 'director-command', 'inherit-command', 'restore-command'])
  assert.equal(OUTPUT_ORIGIN_PERSISTENCE_STATUS, 'not-connected')
  const result = inspectOutputVersionOriginDraft(creationDraft())
  assert.deepEqual(result, { status: 'blocked', kind: 'creation-empty', missing: ['creation-command-v2-persisted-intent'] })
  assert.equal(Object.isFrozen(result), true)
  assert.equal('producer' in result, false)
  assert.equal('state' in result, false)
})

test('W66 origins preserve existing create/revise Command authority and exact base', () => {
  const root = buildOutputVersionBundle(rootInput()), rootBefore = stableSerialize(root)
  const create = childInput(root), created = buildOutputVersionBundle(create)
  const revise = childInput(created, { suffix: 'revision', type: 'revise-output-spec' })
  for (const request of [create, revise]) assert.deepEqual(inspectOutputVersionOriginDraft(outputDraft(request)),
    { status: 'ready-for-existing-bundle-only', kind: request.origin.result.command.type })
  assert.equal(stableSerialize(root), rootBefore, 'inspection cannot mutate its exact parent')
  // Historical scope keeps optional undefined fields; no new policy rehash.
  assert.equal(Object.hasOwn(create.origin.result.command.scope, 'clipIds'), true)
  assert.equal(create.origin.result.command.scope.clipIds, undefined)
})

test('W66 origins reject allocation, Command, policy, historical base and seal contradictions', () => {
  const root = buildOutputVersionBundle(rootInput()), request = childInput(root)
  for (const mutate of [
    (i) => { i.allocation.parentVersionId = 'version-sister' },
    (i) => { i.allocation.workspaceId = 'workspace-sister' },
    (i) => { i.allocation.sequence += 1 },
    (i) => { i.base.version.outputContractVersion = 0 },
    (i) => { i.base.state.stateHash = 'b'.repeat(64) },
  ]) { const i = structuredClone(outputDraft(request)); mutate(i); expectCode(i, 'INVALID_PROJECT_VERSION') }
  for (const mutate of [
    (i) => { i.allocation.createdAt = '2026-10-11T13:00:00.000Z' },
    (i) => { i.allocation.createdBy = 'client-sister' },
    (i) => { i.kind = 'revise-output-spec' },
    (i) => { i.result.requestFingerprint = 'b'.repeat(64) },
    (i) => { i.result.producer.hash = 'b'.repeat(64) },
    (i) => { i.extraAuthority = hash },
  ]) { const i = structuredClone(outputDraft(request)); mutate(i); expectCode(i, 'INVALID_COMMAND') }
  const badTime = outputDraft(request); badTime.allocation.createdAt = 'invalid'
  expectCode(badTime, 'INVALID_PROJECT_VERSION')
  const wrongPolicy = outputDraft(request); wrongPolicy.canonicalPolicyVersion = 'output-canonical-json/v0'
  expectCode(wrongPolicy, 'INVALID_OUTPUT_SPEC')
  const unknown = outputDraft(request); unknown.kind = 'guess-format-or-head'
  expectCode(unknown, 'INVALID_COMMAND')
})

test('W66 fork map covers actual source members and remains blocked without new persisted intent', () => {
  const input = forkDraft(), before = stableSerialize(input.source)
  assert.equal(input.identityMap.some((i) => i.kind === 'revision'), true)
  assert.equal(input.identityMap.filter((i) => i.kind === 'snapshot').length, 3)
  const expected = { status: 'blocked', kind: 'fork-with-content', missing: [
    'creation-command-v2-persisted-intent', 'fork-complete-target-rematerialization', 'fork-new-crop-command-audit'] }
  assert.deepEqual(inspectOutputVersionOriginDraft(input), expected)
  assert.deepEqual(inspectOutputVersionOriginDraft({ ...input, identityMap: [...input.identityMap].reverse() }), expected)
  assert.equal(stableSerialize(input.source), before, 'source graph remains immutable')
})

test('W66 fork rejects omissions, same-cardinality substitutions and shared identities', () => {
  for (const mutate of [
    (i) => { i.identityMap = i.identityMap.filter((m) => m.kind !== 'revision') },
    (i) => { i.identityMap.find((m) => m.kind === 'revision').sourceId = 'revision-not-in-source' },
    (i) => { i.identityMap[1] = { ...i.identityMap[0], targetId: 'distinct-but-duplicate-source' } },
    (i) => { i.identityMap.find((m) => m.kind === 'snapshot').targetId = i.source.version.snapshotRefs.brief },
    (i) => { i.identityMap.find((m) => m.kind === 'revision').targetId = i.identityMap.find((m) => m.kind === 'variant').targetId },
    (i) => { i.identityMap.find((m) => m.kind === 'version').targetId = 'version-unallocated' },
  ]) { const input = structuredClone(forkDraft()); mutate(input); expectCode(input, 'INVALID_COMMAND') }
  const input = forkDraft()
  input.command = createProjectCreationCommand({ ...input.command, sourceVersionId: 'version-sister' })
  expectCode(input, 'INVALID_COMMAND') // Rehashed real Command; wrong source binding still fails.
})

test('W66 ingest manifests and operation cannot substitute for persisted normalization clock/fence facts', () => {
  const root = buildOutputVersionBundle(rootInput()), request = childInput(root)
  const manifest = (artifactKey) => createMediaArtifactManifest({ artifactKey, artifactSha256: hash, byteSize: 10,
    mediaType: 'video', container: 'mp4', recipe: { id: 'source-ingest', version: '1', parameters: {} } })
  // The operation targets this explicit source artifact/manifest allocation.
  // These IDs are controlled fixture identities, not persisted row evidence.
  const source = { artifactId: 'artifact-origin-master', manifestId: 'manifest-origin-master',
    manifest: manifest('source/master.mp4') }
  const input = { ...policy, schemaVersion: 'output-version-origin-draft/v1', kind: 'ingest-operation',
    allocation: allocation(request), base: root,
    operation: createQueuedPublicOperation({ id: 'operation-origin-ingest', ...scope, clientId: audit.clientId,
      type: 'media-ingest', target: { type: 'media-artifact', id: source.artifactId, manifestId: source.manifestId }, createdAt: at }),
    sourceManifest: source.manifest, normalizedManifest: manifest('source/normalized.mp4') }
  assert.deepEqual(inspectOutputVersionOriginDraft(input), { status: 'blocked', kind: 'ingest-operation',
    missing: ['ingest-operation-detail-and-fence', 'original-normalized-render-source-clock-receipt'] })
  const incompatibleTarget = structuredClone(input); incompatibleTarget.operation.target = { type: 'project-version', id: root.version.id }
  expectCode(incompatibleTarget, 'INVALID_PUBLIC_OPERATION')
  const corrupted = structuredClone(input); corrupted.normalizedManifest.manifestHash = 'b'.repeat(64)
  expectCode(corrupted, 'INVALID_MEDIA_ARTIFACT')
  const crossScope = structuredClone(input); crossScope.operation.projectId = 'project-sister'
  expectCode(crossScope, 'INVALID_COMMAND')
})

function creationV2Input(suffix = 'v2', createdAt = at) {
  const allocation = { ...scope, projectId: `project-${suffix}`, resultVersionId: `version-${suffix}`,
    stateId: `state-${suffix}`, parentVersionId: null, sequence: 1, createdBy: audit.clientId, createdAt }
  const callerIntent = { schemaVersion: 'project-creation-intent/v2', kind: 'initialize-empty', name: ' New  Project ',
    objective: 'discovery', locale: 'pt-br', briefing: null, desiredAction: {} }
  const document = { schemaVersion: 1, objective: 'discovery', desiredAction: { schemaVersion: 1, kind: 'continue-viewing', disclosures: [] },
    productionBrief: createProductionBrief({}), createdAt }
  const snapshots = [
    ['brief', document],
    ['policies', { schemaVersion: 1, workspaceId: scope.workspaceId, state: 'unconfigured', brandKitMode: 'inherit', guardrails: [], createdAt }],
    ['edit-plan', plan(allocation.resultVersionId, createdAt)],
  ].map(([kind, content]) => ({ schemaVersion: 1, workspaceId: allocation.workspaceId, projectId: allocation.projectId,
    id: `snapshot-${suffix}-${kind}`, kind, contentSchemaVersion: kind === 'edit-plan' ? 2 : 1,
    contentJson: stableSerialize(content), contentHash: calculateCanonicalHash(content), createdAt }))
  return { id: `creation-${suffix}`, audit, allocation, callerIntent, snapshots, source: null, sourceRenderablePlanSnapshot: null, targetRenderablePlanCandidate: null, derivationId: null, identityMap: [], cropDecisions: [] }
}
function v2Draft(input) {
  const commandV2 = buildProjectCreationOriginCommandV2(input)
  return { ...policy, schemaVersion: 'output-version-origin-draft/v1', kind: input.callerIntent.kind === 'initialize-empty' ? 'creation-empty' : 'fork-with-content',
    allocation: input.allocation, base: null, command: null, commandV2,
    ...(input.source ? { source: input.source, sourceRenderablePlanSnapshot: input.sourceRenderablePlanSnapshot, identityMap: input.identityMap, cropDecisions: input.cropDecisions } : {}) }
}
const sealV2Again = (c) => createProjectCreationCommandV2({ ...policy, id: c.id, workspaceId: c.workspaceId,
  projectId: c.projectId, versionId: c.versionId, audit: c.audit, createdAt: c.createdAt, payload: c.payload })

test('Creation V1 independent literal remains intact and V2 fingerprint excludes allocations/time', () => {
  const vectorAudit = createApiAccessAuditContext({ workspaceId: 'workspace-v2', clientId: 'client-v2',
    credentialId: 'credential-v2', environment: 'sandbox', authenticationKind: 'bearer' })
  assert.equal(vectorAudit.contextHash, '909ef28caead99ec44f30ec8259506766eb3196c7d0c4fff86e23729a0982869')
  const v1 = createProjectCreationCommand({ id: 'creation-v1', workspaceId: 'workspace-v2', projectId: 'project-v2',
    versionId: 'version-v2', action: 'create', audit: vectorAudit, requestFingerprint: 'a'.repeat(64), createdAt: '2026-10-12T12:00:00.000Z' })
  // SHA of the declared historical wrapper bytes, computed independently; no V1/V2 constructor generated this expectation.
  assert.equal(v1.commandHash, '63f86d824c4c13c9c428d51cb0e5a2d5eb3d631a1b0a13123dd105c36694b9a8')
  const a = buildProjectCreationOriginCommandV2(creationV2Input()), b = buildProjectCreationOriginCommandV2(creationV2Input('other', '2030-01-01T00:00:00.000Z'))
  assert.equal(a.requestFingerprint, '942b3e14b7d7394cdfe764fadf53de5970ef926d9b025e54e19657c5c02887e0')
  assert.equal(a.requestFingerprint, b.requestFingerprint)
  assert.notEqual(a.payloadHash, b.payloadHash); assert.notEqual(a.commandHash, b.commandHash)
  assert.deepEqual(a.author, { type: 'api-client', id: audit.clientId })
  assert.equal('resultStateHash' in a.payload, false); assert.equal('resultBaseHash' in a.payload, false)
  assert.deepEqual(inspectOutputVersionOriginDraft(v2Draft(creationV2Input())),
    { status: 'blocked', kind: 'creation-empty', missing: ['creation-command-v2-persisted-intent'] })
})

test('Creation V2 rejects rehashed intent, actor, snapshot, allocation and unsupported authority', () => {
  for (const mutate of [
    (i) => { i.callerIntent.locale = '' }, (i) => { i.callerIntent.format = '9:16' },
    (i) => { i.callerIntent.briefing = 'changed owner intent' },
    (i) => { i.allocation.createdBy = 'client-sister' }, (i) => { i.allocation.sequence = 2 },
    (i) => { i.snapshots.pop() }, (i) => { i.snapshots[0].projectId = 'project-sister' },
    (i) => { i.snapshots[0].contentJson = stableSerialize({ schemaVersion: 1, objective: 'sale' }); i.snapshots[0].contentHash = calculateCanonicalHash(JSON.parse(i.snapshots[0].contentJson)) },
    (i) => { const p = JSON.parse(i.snapshots[2].contentJson); p.projectVersionId = 'version-sister'; i.snapshots[2].contentJson = stableSerialize(p); i.snapshots[2].contentHash = calculateCanonicalHash(p) },
  ]) { const input = structuredClone(creationV2Input()); mutate(input)
    assert.throws(() => buildProjectCreationOriginCommandV2(input), (error) => error.code === 'INVALID_COMMAND') }
  const wrongActor = structuredClone(creationV2Input()); wrongActor.audit.contextHash = 'b'.repeat(64)
  assert.throws(() => buildProjectCreationOriginCommandV2(wrongActor), (error) => error.code === 'AUTH_INVALID')
  const draft = structuredClone(v2Draft(creationV2Input()))
  draft.commandV2.payload.snapshots[0].contentHash = 'b'.repeat(64)
  expectCode(draft, 'INVALID_COMMAND')
  const added = structuredClone(buildProjectCreationOriginCommandV2(creationV2Input())); added.payload.resultBaseHash = hash
  assert.throws(() => sealV2Again(added), (error) => error.code === 'INVALID_COMMAND')
})

function contentSource(compiled = false, music = false, secondaryAudio = false) {
  const root = buildOutputVersionBundle(rootInput()), variant = buildOutputVersionBundle(childInput(root))
  const createdAt = '2026-10-11T12:02:00.000Z', versionId = 'version-content-source', stateId = 'state-content-source'
  const crop = { x: .1, y: .1, width: .8, height: .8 }
  const video = { id: 'clip-content-source', sourceArtifactId: 'artifact-content-source', sourceId: 'reference-content-source',
    sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1, ...(secondaryAudio ? {audioSourceArtifactId:'artifact-secondary-speech',audioSourceInFrame:0,audioSourceOutFrame:90} : {}) }
  const edit = { ...plan(versionId, createdAt), state: 'compiled', durationFrames: 90,
    sources: [{ id: 'reference-content-source', artifactId: video.sourceArtifactId, kind: 'video', durationSeconds: 3 }],
    videoTracks: [{ id: 'track-content-source', kind: 'base-video', clips: [video] }],
    subtitleTracks: [{ id: 'track-caption-source', kind: 'captions', cues: [{ id: 'cue-content-source', startFrame: 0,
      endFrame: 90, clipId: video.id, text: video.id }] }],
    markers: [{ id: 'marker-content-source', clipId: video.id, atFrame: 30 }] }
  const sourceCommand = createEditCommand({ ...scope, id: 'command-crop-source', baseVersionId: variant.version.id,
    baseHash: variant.version.baseHash, author: { type: 'api-client', id: audit.clientId }, type: 'manual-edit',
    scope: { clipIds: [video.id], outputVariantIds: [variant.state.document.entries[0].variantId] },
    payload: { schemaVersion: 2, action: 'apply', operation: { kind: 'crop', clipId: video.id, crop } },
    idempotencyKey: 'source-crop-request', createdAt })
  const sourceProvenance = { kind: 'edit-command', id: sourceCommand.id, hash: sourceCommand.commandHash }
  const member = structuredClone(variant.state.document.entries[0])

  const assembled = compiled ? assembleDirectedEditPlan({ planId: 'compiled-content-source', projectVersionId: versionId,
    derivedFrom: { origin: 'react-playback', id: 'playback-content-source', hash: 'd'.repeat(64), version: 1 },
    objective: 'discovery', fps: 30, sources: edit.sources, clips: [video], seams: [],
    markers: [{ kind: 'editorial-cut', atFrame: 30, sourceStartSeconds: 0, sourceEndSeconds: 3, ruleIds: ['controlled-rule'] }],
    lineageRefs: [video.sourceArtifactId], assumptions: ['Domain compilation fixture; no render or critic approval'], createdAt }) : null
  const musicTracks = music ? [{ id: 'track-music-source', kind: 'background-music', artifactId: 'artifact-music-source',
    analysisId: 'analysis-music-source', analysisHash: 'c'.repeat(64), rightsSnapshotId: 'rights-music-source',
    sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, gainDb: -24, fadeInFrames: 0, fadeOutFrames: 0 }] : []
  const renderable = assembled ? validateDirectedEditPlan({ ...assembled, audioTracks: musicTracks,
    audioTimelineHash: createDirectedAudioTimelineHash({ fps: assembled.fps, clips: assembled.videoTracks[0].clips, musicTracks }),
    subtitleTracks: [{ id: 'track-compiled-captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom',
      faceProtection: true, maxLines: 2, maxCharactersPerBlock: 32, desiredActionRef: assembled.desiredActionRef,
      cues: [{ id: 'cue-compiled-source', startFrame: 0, endFrame: 90, clipId: video.id, text: video.id,
        anchor: 'bottom', wordIds: [], desiredActionRef: assembled.desiredActionRef }] }],
    formatVariantRefs: [member.variantId] }) : null
  const renderableFacts = renderable ? { id: 'renderable-snapshot-content-source', ...scope, projectVersionId: versionId,
    planId: renderable.id, origin: 'react-playback', sourceId: 'playback-content-source', sourceHash: 'd'.repeat(64), sourceVersion: 1,
    fps: renderable.fps, durationFrames: renderable.durationFrames, clipCount: 1,
    planJson: JSON.stringify(renderable), planHash: calculateRenderablePlanHash(renderable), createdAt } : null

  const identity = { sourceArtifactId: video.sourceArtifactId, sourceManifestId: 'manifest-content-source', sourceManifestHash: hash, sourceSha256: hash }
  const seal = (document) => ({ schemaVersion: document.schemaVersion, document, hash: calculateOutputCanonicalHash(document) })
  const probe = seal({ ...policy, schemaVersion: 'observed-video-probe/v1', ...identity, width: 1920, height: 1080,
    fps: 30, durationFrames: 90, timebase: { numerator: 1, denominator: 15360 },
    orientation: { rotationDegrees: 0, displayTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1] } })
  const projection = { ...policy, schemaVersion: 'variant-reframe-geometry/v1', variantId: member.variantId,
    output: { aspectRatio: member.spec.output.aspectRatio, width: 1080, height: 1920, fps: 30, proxyToFinal: member.spec.profile.proxyToFinal },
    timeline: { fps: 30, durationFrames: 90, trackId: renderable ? renderable.videoTracks[0].id : 'track-content-source' },
    clips: [{ id: video.id, ...identity, sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1,
      probe, normalization: seal({ ...policy, schemaVersion: 'observed-normalization/v1', ...identity, mode: 'verified-source', probeHash: probe.hash }) }],
    composition: { foregroundScale: { present: compiled, value: compiled ? 1 : null }, verticalPosition: { present: compiled, value: compiled ? .5 : null } }, globalCropPresent: false }
  member.geometry = { status: 'verified', projection, projectionHash: calculateOutputCanonicalHash(projection) }
  const producerDocument = { ...policy, schemaVersion: 'controlled-source-command/v1', commandId: sourceCommand.id, commandHash: sourceCommand.commandHash }
  const state = createProjectOutputState({ ...policy, ...scope, id: stateId, resultVersionId: versionId,
    parentVersionId: variant.version.id, parentStateId: variant.state.document.id, parentStateHash: variant.state.stateHash,
    transition: 'set-overlay', provenance: sourceProvenance, producer: producer(producerDocument),
    editPlan: anchor(edit, 'snapshot-content-source'), renderablePlan: renderable ? { snapshotId: renderableFacts.id, planId: renderable.id,
      hash: renderableFacts.planHash, authority: createOutputPlanAuthority({ ...policy, kind: 'renderable-edit-plan', planDocument: renderable }) } : null, entries: [member],
    overlays: [{ ...policy, id: 'overlay-content-source', variantId: member.variantId, kind: 'crop', clipId: video.id,
      startFrame: 0, endFrame: 90, status: 'active', provenance: sourceProvenance, dependencyHash: member.geometry.projectionHash,
      document: seal({ ...policy, schemaVersion: 'project-output-crop/v1', authority: 'editorial-preference', crop }) }],
    invalidations: [], createdAt }, { editPlanDocument: edit, renderablePlanDocument: renderable })
  const body = outputBoundVersionHashBody({ ...scope, resultVersionId: versionId, parentVersionId: variant.version.id,
    previousBaseHash: variant.version.baseHash, producerHash: state.document.producer.hash, outputStateId: stateId, outputStateHash: state.stateHash })
  const version = rebuildRetiredContractOneVersion({ ...policy, ...scope, id: versionId, sequence: 3, parentVersionId: variant.version.id,
    snapshotRefs: { ...variant.version.snapshotRefs, editPlan: 'snapshot-content-source' }, commandId: sourceCommand.id,
    baseHash: calculateOutputBoundVersionHash(body), outputState: state, previousBaseHash: variant.version.baseHash,
    createdBy: audit.clientId, createdAt })
  return { version, state, facts: { editPlanDocument: edit, renderablePlanDocument: renderable }, renderableFacts, nonOutputSnapshotFacts: variant.nonOutputSnapshotFacts,
    previousBaseHash: variant.version.baseHash, editCommandSeal: null, outputBaseHashJson: serializeOutputCanonicalJson(body) }
}
// Expected documents are built explicitly here, without the production remapper
// or materializeForkRenderablePlan. Hashes use the declared new wrapper.
function independentDerivationBody(input) {
  const { version, state, facts, nonOutputSnapshotFacts, previousBaseHash, editCommandSeal, outputBaseHashJson } = input.source
  return { ...policy, schemaVersion: 'project-fork-derivation/v1', id: input.derivationId, callerIntent: input.callerIntent, audit: input.audit,
    target: { ...input.allocation, commandId: input.id }, source: { version, state, facts, nonOutputSnapshotFacts, previousBaseHash, editCommandSeal, outputBaseHashJson },
    sourceRenderablePlanSnapshot: input.sourceRenderablePlanSnapshot, identityMap: input.identityMap, cropDecisions: input.cropDecisions,
    compilePolicyVersion: 'project-fork-typed-remap/2026-10-12-v1' }
}
function independentForkReference(input) {
  return { ...policy, schemaVersion: 'project-fork-derivation-ref/v1', id: input.derivationId,
    hash: calculateOutputCanonicalHash(independentDerivationBody(input)), compilePolicyVersion: 'project-fork-typed-remap/2026-10-12-v1' }
}
const independentForkPlanHash = (plan) => calculateOutputCanonicalHash({ ...policy,
  schemaVersion: 'project-fork-renderable-plan-hash/v1', compilePolicyVersion: 'project-fork-typed-remap/2026-10-12-v1', plan })
function refreshCandidateRef(input) {
  const edit = input.snapshots.find((snapshot) => snapshot.kind === 'edit-plan'), document = JSON.parse(edit.contentJson)
  document.forkDerivationRef = independentForkReference(input)
  edit.contentJson = stableSerialize(document); edit.contentHash = calculateCanonicalHash(document)
  const row = input.targetRenderablePlanCandidate
  if (!row) return
  const plan = JSON.parse(row.planJson), ref = independentForkReference(input)
  plan.forkDerivationRef = ref; row.derivationRef = ref
  row.planJson = serializeOutputCanonicalJson(plan); row.planHash = independentForkPlanHash(plan)
}
function contentForkInput(compiled = false, music = false, secondaryAudio = false) {
  const source = contentSource(compiled, music, secondaryAudio), allocation = { ...scope, projectId: 'project-content-fork', resultVersionId: 'version-content-fork',
    stateId: 'state-content-fork', parentVersionId: null, sequence: 1, createdBy: audit.clientId, createdAt: '2026-10-11T12:03:00.000Z' }
  const identityMap = forkOwnedIdentities(source, source.renderableFacts).map(({ kind, id }) => ({ kind, sourceId: id,
    targetId: kind === 'version' ? allocation.resultVersionId : kind === 'state' ? allocation.stateId : `copy-${id}` }))
  const snapshot = (kind, old, document) => ({ schemaVersion: 1, workspaceId: allocation.workspaceId, projectId: allocation.projectId,
    id: `copy-${old}`, kind, contentSchemaVersion: kind === 'edit-plan' ? 2 : 1, contentJson: stableSerialize(document),
    contentHash: calculateCanonicalHash(document), createdAt: allocation.createdAt })
  // Explicit expected reference graph, independent of the production remapper.
  const copiedPlan = structuredClone(source.facts.editPlanDocument)
  copiedPlan.id = 'copy-edit-plan-version-content-source'; copiedPlan.projectVersionId = allocation.resultVersionId; copiedPlan.createdAt = allocation.createdAt
  copiedPlan.sources[0].id = 'copy-reference-content-source'; copiedPlan.videoTracks[0].id = 'copy-track-content-source'
  copiedPlan.videoTracks[0].clips[0].id = 'copy-clip-content-source'; copiedPlan.videoTracks[0].clips[0].sourceId = 'copy-reference-content-source'
  copiedPlan.subtitleTracks[0].id = 'copy-track-caption-source'; copiedPlan.subtitleTracks[0].cues[0].id = 'copy-cue-content-source'
  copiedPlan.subtitleTracks[0].cues[0].clipId = 'copy-clip-content-source'; copiedPlan.markers[0].id = 'copy-marker-content-source'
  copiedPlan.markers[0].clipId = 'copy-clip-content-source'
  const copiedRenderable = compiled ? structuredClone(source.facts.renderablePlanDocument) : null
  if (copiedRenderable) {
    // Independent target document: assign the expected references explicitly.
    copiedRenderable.id = 'copy-compiled-content-source'; copiedRenderable.projectVersionId = allocation.resultVersionId
    copiedRenderable.createdAt = allocation.createdAt; copiedRenderable.sources[0].id = 'copy-reference-content-source'
    copiedRenderable.videoTracks[0].id = 'copy-track-base-video'
    copiedRenderable.videoTracks[0].clips[0].id = 'copy-clip-content-source'
    copiedRenderable.videoTracks[0].clips[0].sourceId = 'copy-reference-content-source'
    copiedRenderable.subtitleTracks[0].id = 'copy-track-compiled-captions'
    copiedRenderable.subtitleTracks[0].cues[0].id = 'copy-cue-compiled-source'
    copiedRenderable.subtitleTracks[0].cues[0].clipId = 'copy-clip-content-source'
    for (const track of copiedRenderable.audioTracks) track.id = 'copy-' + track.id
    copiedRenderable.formatVariantRefs = source.facts.renderablePlanDocument.formatVariantRefs.map((id) => 'copy-' + id)
    copiedRenderable.audioTimelineHash = createDirectedAudioTimelineHash({ fps: copiedRenderable.fps,
      clips: copiedRenderable.videoTracks[0].clips, musicTracks: copiedRenderable.audioTracks })
  }
  const overlay = source.state.document.overlays[0]
  const cropDecisions = [{ sourceOverlayId: overlay.id, sourceOverlayHash: calculateOutputCanonicalHash(overlay),
    newOverlayId: 'copy-overlay-content-source', newVariantId: `copy-${overlay.variantId}`, newClipId: 'copy-clip-content-source',
    copiedDocument: overlay.document, author: { type: 'api-client', id: audit.clientId }, createdAt: allocation.createdAt,
    geometryStatus: 'requires-target-materialization' }]
  const input = { id: 'creation-content-fork', derivationId: 'derivation-content-fork', audit, allocation, callerIntent: { schemaVersion: 'project-creation-intent/v2', kind: 'fork-with-content', name: 'Fork explicit' },
    source, sourceRenderablePlanSnapshot: source.renderableFacts, targetRenderablePlanCandidate: null, identityMap, cropDecisions, snapshots: [
      snapshot('brief', source.version.snapshotRefs.brief, JSON.parse(source.nonOutputSnapshotFacts.brief.contentJson)),
      snapshot('policies', source.version.snapshotRefs.policies, JSON.parse(source.nonOutputSnapshotFacts.policies.contentJson)),
      snapshot('edit-plan', source.version.snapshotRefs.editPlan, copiedPlan) ] }
  const editRef = independentForkReference(input)
  copiedPlan.forkDerivationRef = editRef
  const copiedSnapshot = input.snapshots.find((snapshot) => snapshot.kind === 'edit-plan')
  copiedSnapshot.contentJson = stableSerialize(copiedPlan); copiedSnapshot.contentHash = calculateCanonicalHash(copiedPlan)
  if (copiedRenderable) {
    const original = source.facts.renderablePlanDocument
    delete copiedRenderable.directorRunId; delete copiedRenderable.storyPlanId; delete copiedRenderable.treatmentPlanId; delete copiedRenderable.director
    copiedRenderable.sourceDirectionLineage = { snapshotId: source.renderableFacts.id, planId: original.id, planHash: source.renderableFacts.planHash,
      origin: source.renderableFacts.origin, sourceId: source.renderableFacts.sourceId, sourceHash: source.renderableFacts.sourceHash,
      sourceVersion: source.renderableFacts.sourceVersion, directorRunId: original.directorRunId, storyPlanId: original.storyPlanId,
      treatmentPlanId: original.treatmentPlanId, director: original.director }
    copiedRenderable.reviewStatus = 'requires-target-materialization'
    const ref = independentForkReference(input)
    copiedRenderable.forkDerivationRef = ref
    input.targetRenderablePlanCandidate = { ...policy, schemaVersion: 'project-fork-renderable-candidate/v1',
      id: 'copy-renderable-snapshot-content-source', workspaceId: allocation.workspaceId, projectId: allocation.projectId,
      projectVersionId: allocation.resultVersionId, planId: copiedRenderable.id, derivationRef: ref, fps: copiedRenderable.fps,
      durationFrames: copiedRenderable.durationFrames, clipCount: 1, planJson: serializeOutputCanonicalJson(copiedRenderable),
      planHash: independentForkPlanHash(copiedRenderable), createdAt: allocation.createdAt }
  }
  return input
}

test('Creation V2 fork seals actual clip/cue/crop/reference graph and stays blocked pending persistence', () => {
  const input = contentForkInput(), before = stableSerialize(input.source), command = buildProjectCreationOriginCommandV2(input)
  assert.equal(command.payload.sourceBaseline.baseHash, input.source.version.baseHash)
  assert.equal(command.payload.sourceBaseline.stateHash, input.source.state.stateHash)
  const edit = JSON.parse(command.payload.snapshots.find((s) => s.kind === 'edit-plan').contentJson)
  assert.equal(edit.videoTracks[0].clips[0].sourceArtifactId, 'artifact-content-source')
  assert.equal(edit.subtitleTracks[0].cues[0].text, 'clip-content-source', 'literal text is not an identity reference')
  assert.equal(edit.subtitleTracks[0].cues[0].clipId, 'copy-clip-content-source')
  assert.equal(edit.videoTracks[0].clips[0].crop, undefined, 'State v1 does not attest active clip cropping')
  assert.deepEqual(command.payload.cropDecisions[0].copiedDocument.document.crop, { x: .1, y: .1, width: .8, height: .8 })
  assert.equal(command.payload.cropDecisions[0].geometryStatus, 'requires-target-materialization')
  assert.deepEqual(inspectOutputVersionOriginDraft(v2Draft(input)), { status: 'blocked', kind: 'fork-with-content', missing: [
    'creation-command-v2-persisted-intent', 'fork-complete-target-rematerialization', 'fork-new-crop-command-audit'] })
  assert.equal(stableSerialize(input.source), before)
  const other = structuredClone(input); other.id = 'creation-fork-other'; other.allocation.createdAt = '2030-01-01T00:00:00.000Z'
  other.cropDecisions[0].createdAt = other.allocation.createdAt
  for (const s of other.snapshots) { s.createdAt = other.allocation.createdAt
    if (s.kind === 'edit-plan') { const p = JSON.parse(s.contentJson); p.createdAt = s.createdAt; s.contentJson = stableSerialize(p); s.contentHash = calculateCanonicalHash(p) } }
  refreshCandidateRef(other)
  assert.equal(buildProjectCreationOriginCommandV2(other).requestFingerprint, command.requestFingerprint)
})

test('Creation V2 fork rejects fully resealed missing members, shared IDs, reference and audit substitutions', () => {
  for (const mutate of [
    (i) => { i.identityMap = i.identityMap.filter((m) => m.kind !== 'cue') },
    (i) => { i.identityMap.find((m) => m.kind === 'clip').sourceId = 'clip-sister' },
    (i) => { i.identityMap.find((m) => m.kind === 'revision').targetId = i.source.state.document.entries[0].outputSpecRevisionId },
    (i) => { i.cropDecisions[0].author.id = 'client-sister' },
    (i) => { i.cropDecisions[0].newClipId = 'clip-content-source' },
    (i) => { i.cropDecisions = [] },
    (i) => { i.snapshots.pop() },
    (i) => { const s = i.snapshots.find((s) => s.kind === 'edit-plan'), p = JSON.parse(s.contentJson)
      p.subtitleTracks[0].cues[0].clipId = 'clip-content-source'; s.contentJson = stableSerialize(p); s.contentHash = calculateCanonicalHash(p) },
  ]) { const input = structuredClone(contentForkInput()); mutate(input)
    assert.throws(() => buildProjectCreationOriginCommandV2(input), (error) => error.code === 'INVALID_COMMAND') }
  const draft = structuredClone(v2Draft(contentForkInput())); draft.commandV2.payload.sourceBaseline.baseHash = 'b'.repeat(64)
  assert.throws(() => sealV2Again(draft.commandV2), (error) => error.code === 'INVALID_COMMAND')
  expectCode(draft, 'INVALID_COMMAND')
})

test('Creation V2 seals a fork candidate separately from actual source compiled snapshot and Director authority', () => {
  const input = contentForkInput(true), before = stableSerialize(input.source), beforeRow = JSON.stringify(input.sourceRenderablePlanSnapshot)
  const command = buildProjectCreationOriginCommandV2(input)
  const compiled = command.payload.renderablePlan
  assert.ok(compiled)
  assert.equal(compiled.targetDerivationStatus, 'requires-target-materialization')
  assert.equal(compiled.sourceSnapshotId, input.sourceRenderablePlanSnapshot.id)
  assert.equal(compiled.sourcePlanHash, input.sourceRenderablePlanSnapshot.planHash)
  assert.equal(command.payload.allocations.renderablePlanSnapshotId, input.targetRenderablePlanCandidate.id)
  assert.equal(command.payload.snapshots.some((snapshot) => snapshot.kind === 'renderable-plan'), false)
  const sourcePlan = JSON.parse(input.sourceRenderablePlanSnapshot.planJson)
  const target = JSON.parse(compiled.targetCandidate.planJson)
  assert.equal(target.projectVersionId, input.allocation.resultVersionId)
  assert.equal(target.directorRunId, undefined)
  assert.equal(target.storyPlanId, undefined)
  assert.equal(target.treatmentPlanId, undefined)
  assert.equal(target.director, undefined)
  assert.equal(target.reviewStatus, 'requires-target-materialization')
  assert.equal(target.sourceDirectionLineage.directorRunId, sourcePlan.directorRunId)
  assert.equal(target.sourceDirectionLineage.origin, input.sourceRenderablePlanSnapshot.origin)
  assert.equal(target.forkDerivationRef.hash, command.payload.forkDerivation.derivationHash)
  assert.deepEqual(target.forkDerivationRef, compiled.targetCandidate.derivationRef)
  assert.deepEqual(command.payload.forkDerivation.document, independentDerivationBody(input))
  const actualSourceAuthority = calculateRenderablePlanHash(sourcePlan)
  assert.equal(actualSourceAuthority, input.sourceRenderablePlanSnapshot.planHash)
  assert.notEqual(compiled.targetCandidate.planHash, actualSourceAuthority)
  assert.equal(Object.hasOwn(compiled.targetCandidate, 'sourceId'), false)
  for (const forbidden of ['targetPlanHash', 'commandHash', 'resultStateHash', 'resultBaseHash']) {
    assert.equal(Object.hasOwn(command.payload.forkDerivation.document, forbidden), false)
  }
  assert.equal(target.videoTracks[0].clips[0].id, 'copy-clip-content-source')
  assert.equal(target.videoTracks[0].clips[0].sourceArtifactId, 'artifact-content-source')
  assert.equal(target.subtitleTracks[0].cues[0].clipId, 'copy-clip-content-source')
  assert.equal(target.subtitleTracks[0].cues[0].text, 'clip-content-source', 'text is never rewritten as an identity')
  assert.deepEqual(target.desiredActionRef, sourcePlan.desiredActionRef, 'content-addressed action is preserved')
  assert.deepEqual(target.subtitleTracks[0].desiredActionRef, sourcePlan.desiredActionRef)
  assert.equal(target.audioTimelineHash, sourcePlan.audioTimelineHash, 'clip ID reminting preserves historical audio identity when media, intervals, rate and fps are unchanged')
  assert.equal(target.audioTimelineHash, createDirectedAudioTimelineHash({
    fps: target.fps, clips: target.videoTracks[0].clips, musicTracks: target.audioTracks }))
  assert.deepEqual(target.markers, sourcePlan.markers, 'anonymous compiler data is preserved without inventing an owned ID')
  assert.deepEqual(command.payload.cropDecisions[0].copiedDocument.document.crop, { x: .1, y: .1, width: .8, height: .8 })
  assert.equal('qualityReport' in compiled, false)
  assert.equal('acceptance' in compiled, false)
  const inspected = inspectOutputVersionOriginDraft(v2Draft(input))
  assert.equal(inspected.status, 'blocked')
  assert.ok(inspected.missing.includes('fork-new-renderable-derivation-authority'))
  assert.equal(stableSerialize(input.source), before)
  assert.equal(JSON.stringify(input.sourceRenderablePlanSnapshot), beforeRow)

  const later = structuredClone(input)
  later.id = 'creation-compiled-later'
  later.allocation.createdAt = '2030-01-01T00:00:00.000Z'
  later.cropDecisions[0].createdAt = later.allocation.createdAt
  for (const snapshot of later.snapshots) {
    snapshot.createdAt = later.allocation.createdAt
    if (snapshot.kind === 'edit-plan') {
      const document = JSON.parse(snapshot.contentJson); document.createdAt = snapshot.createdAt
      snapshot.contentJson = stableSerialize(document); snapshot.contentHash = calculateCanonicalHash(document)
    }
  }
  const laterCompiled = JSON.parse(later.targetRenderablePlanCandidate.planJson)
  laterCompiled.createdAt = later.allocation.createdAt
  later.targetRenderablePlanCandidate.planJson = serializeOutputCanonicalJson(laterCompiled)
  later.targetRenderablePlanCandidate.planHash = independentForkPlanHash(laterCompiled)
  later.targetRenderablePlanCandidate.createdAt = later.allocation.createdAt
  refreshCandidateRef(later)
  assert.equal(buildProjectCreationOriginCommandV2(later).requestFingerprint, command.requestFingerprint,
    'generated Command/time/target materialization is outside the V2 request identity')
})

test('Creation V2 exact member bijection rejects duplicate, missing, extra and shared targets with linear indices', () => {
  const owned = [{ kind: 'clip', id: 'source-clip-alpha' }, { kind: 'cue', id: 'source-cue-alpha' }]
  const mapped = [{ kind: 'clip', sourceId: owned[0].id, targetId: 'target-clip-alpha' },
    { kind: 'cue', sourceId: owned[1].id, targetId: 'target-cue-alpha' }]
  assert.equal(indexForkIdentityBijectionV2(owned, mapped).get('cue:source-cue-alpha'), 'target-cue-alpha')
  for (const [members, mappings] of [
    [[...owned, owned[0]], [...mapped, { ...mapped[0], targetId: 'target-clip-beta' }]],
    [owned, mapped.slice(0, 1)],
    [owned, [...mapped, { kind: 'clip', sourceId: 'source-extra', targetId: 'target-extra' }]],
    [owned, [mapped[0], { ...mapped[1], sourceId: 'source-extra' }]],
    [owned, [mapped[0], { ...mapped[1], targetId: mapped[0].targetId }]],
    [owned, [mapped[0], { ...mapped[1], targetId: owned[0].id }]],
  ]) assert.throws(() => indexForkIdentityBijectionV2(members, mappings), (error) => error.code === 'INVALID_COMMAND')
})

test('Creation V2 refuses resealed compiled source/scope/clock/member/provenance contradictions', () => {
  const resealTarget = (input, mutate) => {
    const row = input.targetRenderablePlanCandidate, document = JSON.parse(row.planJson)
    mutate(document)
    row.planJson = serializeOutputCanonicalJson(document)
    row.planHash = independentForkPlanHash(document)
  }
  for (const [label, code, mutate] of [
    ['missing source compiled snapshot', 'INVALID_COMMAND', (input) => { input.sourceRenderablePlanSnapshot = null }],
    ['missing target compiled snapshot', 'INVALID_COMMAND', (input) => { input.targetRenderablePlanCandidate = null }],
    ['source project scope', 'INVALID_COMMAND', (input) => { input.sourceRenderablePlanSnapshot.projectId = 'project-sister' }],
    ['source snapshot identity', 'INVALID_COMMAND', (input) => { input.sourceRenderablePlanSnapshot.id = 'snapshot-sister' }],
    ['source provenance hash', 'INVALID_COMMAND', (input) => { input.sourceRenderablePlanSnapshot.sourceHash = 'e'.repeat(64) }],
    ['source clip count', 'INVALID_COMMAND', (input) => { input.sourceRenderablePlanSnapshot.clipCount = 2 }],
    ['target version scope', 'INVALID_COMMAND', (input) => { input.targetRenderablePlanCandidate.projectVersionId = 'version-sister' }],
    ['target origin substitution', 'INVALID_COMMAND', (input) => { input.targetRenderablePlanCandidate.origin = 'localization' }],
    ['missing compiled snapshot map', 'INVALID_COMMAND', (input) => { input.identityMap = input.identityMap.filter((member) => member.kind !== 'renderable-snapshot') }],
    ['shared source plan ID', 'INVALID_COMMAND', (input) => { input.identityMap.find((member) => member.kind === 'renderable-plan').targetId = input.sourceRenderablePlanSnapshot.planId }],
    ['duplicate crop decision', 'INVALID_COMMAND', (input) => { input.cropDecisions.push(structuredClone(input.cropDecisions[0])) }],
    ['unmapped cue clip reference', 'INVALID_COMMAND', (input) => { resealTarget(input, (plan) => { plan.subtitleTracks[0].cues[0].clipId = 'clip-content-source' }) }],
    ['divergent real audio timeline hash', 'INVALID_RENDER_INPUT', (input) => { resealTarget(input, (plan) => {
      const divergentHash = createDirectedAudioTimelineHash({
        fps: plan.fps,
        clips: plan.videoTracks[0].clips.map((clip) => ({ ...clip, audioSourceArtifactId: 'artifact-divergent-audio' })),
        musicTracks: plan.audioTracks,
      })
      assert.notEqual(divergentHash, plan.audioTimelineHash, 'different audio artifact must produce a different historical timeline hash')
      plan.audioTimelineHash = divergentHash
    }) }],
    ['reminted content addressed action ID', 'INVALID_RENDER_INPUT', (input) => { resealTarget(input, (plan) => {
      plan.desiredActionRef.id = 'minted-action-id'; plan.subtitleTracks[0].desiredActionRef = plan.desiredActionRef
    }) }],
  ]) {
    const input = structuredClone(contentForkInput(true)); mutate(input)
    assert.throws(() => buildProjectCreationOriginCommandV2(input), (error) => error.code === code, label)
  }
  const draft = structuredClone(v2Draft(contentForkInput(true)))
  draft.commandV2.payload.renderablePlan.targetDerivationStatus = 'persisted-and-approved'
  assert.throws(() => sealV2Again(draft.commandV2), (error) => error.code === 'INVALID_COMMAND')
})

test('Renderable facts preserve the historical full wrapper hash and reject untyped table/schema substitutions', () => {
  const input = contentForkInput(true), row = input.sourceRenderablePlanSnapshot
  const checked = createV2RenderablePlanSnapshotFacts(row)
  assert.equal(checked.planHash, row.planHash)
  assert.equal(checked.planJson, row.planJson, 'source raw JSON bytes are preserved')
  assert.throws(() => createV2RenderablePlanSnapshotFacts({ ...row, kind: 'renderable-plan' }),
    (error) => error.code === 'INVALID_COMMAND')
  assert.throws(() => createV2RenderablePlanSnapshotFacts({ ...row, planHash: calculateCanonicalHash(JSON.parse(row.planJson)) }),
    (error) => error.code === 'INVALID_COMMAND', 'plain JSON digest is not the historical renderable wrapper')
  const changedTime = JSON.parse(row.planJson); changedTime.createdAt = '2030-01-01T00:00:00.000Z'
  assert.equal(calculateRenderablePlanHash(changedTime), row.planHash, 'sole createdAt exclusion remains historical')
})

// Attack re-sealing bypasses constructors deliberately, so semantically forged
// payloads reach domain guards despite fresh syntactic SHA seals.
function resealCommandAttack(command) {
  command.payloadHash = calculateOutputCanonicalHash(command.payload)
  command.requestFingerprint = calculateOutputCanonicalHash({ ...policy, schemaVersion: 'project-creation-request/v2',
    workspaceId: command.workspaceId, callerIntent: command.payload.callerIntent,
    actorContextHash: command.audit.contextHash, sourceBaseline: command.payload.sourceBaseline })
  command.commandHash = calculateOutputCanonicalHash({ ...policy, schemaVersion: 2, id: command.id, workspaceId: command.workspaceId,
    projectId: command.projectId, versionId: command.versionId, actorContextHash: command.audit.contextHash,
    payloadHash: command.payloadHash, requestFingerprint: command.requestFingerprint, createdAt: command.createdAt })
  return command
}
function resealDerivationAttack(command) {
  const derivation = command.payload.forkDerivation
  derivation.derivationHash = calculateOutputCanonicalHash(derivation.document)
  const edit = command.payload.snapshots.find((s) => s.kind === 'edit-plan'), editDocument = JSON.parse(edit.contentJson)
  editDocument.forkDerivationRef = { ...policy, schemaVersion: 'project-fork-derivation-ref/v1', id: derivation.document.id,
    hash: derivation.derivationHash, compilePolicyVersion: derivation.document.compilePolicyVersion }
  edit.contentJson = stableSerialize(editDocument); edit.contentHash = calculateCanonicalHash(editDocument)
  const row = command.payload.renderablePlan?.targetCandidate
  if (row) {
    const ref = { ...policy, schemaVersion: 'project-fork-derivation-ref/v1', id: derivation.document.id,
      hash: derivation.derivationHash, compilePolicyVersion: derivation.document.compilePolicyVersion }
    const plan = JSON.parse(row.planJson); plan.forkDerivationRef = ref; row.derivationRef = ref
    row.planJson = serializeOutputCanonicalJson(plan); row.planHash = independentForkPlanHash(plan)
  }
  return resealCommandAttack(command)
}

test('Fork derivation reciprocates a real compiled clip/cue/audio/crop graph without transferring source authority', () => {
  const input = contentForkInput(true, true), before = stableSerialize(input.source)
  const derivation = createProjectForkDerivation(independentDerivationBody(input))
  assert.equal(PROJECT_FORK_COMPILE_POLICY_VERSION, 'project-fork-typed-remap/2026-10-12-v1')
  assert.equal(derivation.derivationHash, independentForkReference(input).hash)
  assert.deepEqual(materializeForkEditPlan(derivation), JSON.parse(input.snapshots.find((s) => s.kind === 'edit-plan').contentJson))
  assert.equal(Object.isFrozen(derivation.document.identityMap), true)
  const expected = JSON.parse(input.targetRenderablePlanCandidate.planJson)
  assert.deepEqual(materializeForkRenderablePlan(derivation), expected, 'explicit reference graph is independent of remapper')
  assert.deepEqual(createForkRenderablePlanCandidate(input.targetRenderablePlanCandidate, derivation), input.targetRenderablePlanCandidate)
  const command = buildProjectCreationOriginCommandV2(input)
  const plan = JSON.parse(command.payload.renderablePlan.targetCandidate.planJson)
  assert.equal(plan.audioTracks[0].id, 'copy-track-music-source')
  assert.equal(plan.audioTracks[0].artifactId, 'artifact-music-source')
  assert.equal(plan.audioTracks[0].analysisId, 'analysis-music-source')
  assert.equal(plan.audioTracks[0].rightsSnapshotId, 'rights-music-source')
  assert.notEqual(plan.audioTimelineHash, input.source.facts.renderablePlanDocument.audioTimelineHash, 'owned music track ID participates in historical audio seal')
  assert.equal(plan.audioTimelineHash, createDirectedAudioTimelineHash({ fps: plan.fps, clips: plan.videoTracks[0].clips, musicTracks: plan.audioTracks }))
  assert.equal(command.payload.cropDecisions[0].geometryStatus, 'requires-target-materialization')
  assert.equal(command.payload.sourceBaseline.renderablePlanSnapshot.origin, 'react-playback', 'source origin remains source facts only')
  assert.equal('origin' in command.payload.renderablePlan.targetCandidate, false)
  assert.equal(inspectOutputVersionOriginDraft(v2Draft(input)).status, 'blocked')
  assert.equal(stableSerialize(input.source), before)
})

test('Fork Command rejects fully resealed derivation identity, scope, actor, time, source and cycles', () => {
  for (const [label, code, mutate] of [
    ['unknown derivation schema', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.schemaVersion = 'project-fork-derivation/v0' }],
    ['unknown compile policy', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.compilePolicyVersion = 'fork-remap/unpinned' }],
    ['result plan hash cycle', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.targetPlanHash = c.payload.renderablePlan.targetCandidate.planHash }],
    ['result State hash cycle', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.resultStateHash = hash }],
    ['Command hash cycle', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.commandHash = c.commandHash }],
    ['derivation identity shared with target', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.id = c.versionId }],
    ['derivation Command reciprocity', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.target.commandId = 'creation-sister' }],
    ['derivation target scope', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.target.projectId = 'project-sister' }],
    ['derivation allocated Version', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.target.resultVersionId = 'version-sister' }],
    ['derivation target time', 'INVALID_COMMAND', (c) => { const d = c.payload.forkDerivation.document; d.target.createdAt = '2030-01-01T00:00:00.000Z'; d.cropDecisions[0].createdAt = d.target.createdAt }],
    ['derivation actor context', 'AUTH_INVALID', (c) => { c.payload.forkDerivation.document.audit.contextHash = 'b'.repeat(64) }],
    ['derivation missing owned cue', 'INVALID_COMMAND', (c) => { const d = c.payload.forkDerivation.document; d.identityMap = d.identityMap.filter((m) => m.kind !== 'cue') }],
    ['derivation source baseline hash', 'INVALID_PROJECT_VERSION', (c) => { c.payload.forkDerivation.document.source.version.baseHash = 'b'.repeat(64) }],
    ['source materialization extra authority', 'INVALID_COMMAND', (c) => { c.payload.forkDerivation.document.source.persistedApproval = true }],
    ['target cue fresh seal but stale ref', 'INVALID_COMMAND', (c) => { const row = c.payload.renderablePlan.targetCandidate, p = JSON.parse(row.planJson);
      p.subtitleTracks[0].cues[0].clipId = 'clip-content-source'; row.planJson = serializeOutputCanonicalJson(p); row.planHash = independentForkPlanHash(p) }],
    ['target old Director authority', 'INVALID_COMMAND', (c) => { const row = c.payload.renderablePlan.targetCandidate, p = JSON.parse(row.planJson);
      p.directorRunId = p.sourceDirectionLineage.directorRunId; row.planJson = serializeOutputCanonicalJson(p); row.planHash = independentForkPlanHash(p) }],
    ['target acceptance transfer', 'INVALID_COMMAND', (c) => { const row = c.payload.renderablePlan.targetCandidate, p = JSON.parse(row.planJson);
      p.acceptance = { approved: true }; row.planJson = serializeOutputCanonicalJson(p); row.planHash = independentForkPlanHash(p) }],
  ]) {
    const command = structuredClone(buildProjectCreationOriginCommandV2(contentForkInput(true)))
    mutate(command); resealDerivationAttack(command)
    assert.throws(() => sealV2Again(command), (error) => error.code === code, label)
  }
  const wrongPolicy = structuredClone(buildProjectCreationOriginCommandV2(contentForkInput(true)))
  wrongPolicy.payload.forkDerivation.document.canonicalPolicyVersion = 'output-canonical-json/v0'
  resealDerivationAttack(wrongPolicy)
  assert.throws(() => sealV2Again(wrongPolicy), (error) => error.code === 'INVALID_OUTPUT_SPEC')
})

test('Fork remaps only owned contract containers and preserves external/anonymous metadata and literal text', () => {
  const input = contentForkInput(true), source = input.source
  // Rebuild all source plan/State/Version seals after adding metadata. External
  // source/clip metadata uses owned-looking strings but owns no graph member.
  const edit = structuredClone(materializeManualEditPlan({ editPlan: source.facts.editPlanDocument,
    operation: { kind: 'select', clipId: 'clip-content-source' }, newVersionId: source.version.id, createdAt: source.version.createdAt,
    availableAssetIds: ['artifact-content-source'], variantId: source.state.document.entries[0].variantId })),
    renderable = structuredClone(source.facts.renderablePlanDocument)
  const metadata = { id: 'clip-content-source', clipId: 'clip-content-source', cues: [{ id: 'cue-external-metadata' }], text: 'cue-content-source' }
  edit.sources[0].metadata = metadata; edit.videoTracks[0].clips[0].metadata = metadata
  renderable.sources[0].metadata = metadata; renderable.videoTracks[0].clips[0].metadata = metadata
  const stateDocument = structuredClone(source.state.document)
  stateDocument.editPlan = anchor(edit, stateDocument.editPlan.snapshotId)
  stateDocument.renderablePlan = { snapshotId: source.renderableFacts.id, planId: renderable.id, hash: calculateRenderablePlanHash(renderable),
    authority: createOutputPlanAuthority({ ...policy, kind: 'renderable-edit-plan', planDocument: renderable }) }
  source.facts = { editPlanDocument: edit, renderablePlanDocument: renderable }
  source.state = createProjectOutputState(stateDocument, source.facts)
  const body = outputBoundVersionHashBody({ ...scope, resultVersionId: source.version.id, parentVersionId: source.version.parentVersionId,
    previousBaseHash: source.previousBaseHash, producerHash: source.state.document.producer.hash, outputStateId: source.state.document.id, outputStateHash: source.state.stateHash })
  source.version = rebuildRetiredContractOneVersion({ ...source.version, outputState: source.state, previousBaseHash: source.previousBaseHash, baseHash: calculateOutputBoundVersionHash(body) })
  source.outputBaseHashJson = serializeOutputCanonicalJson(body)
  source.renderableFacts = { ...source.renderableFacts, planJson: JSON.stringify(renderable), planHash: calculateRenderablePlanHash(renderable) }
  input.sourceRenderablePlanSnapshot = source.renderableFacts
  const before = stableSerialize(source)
  const members = forkOwnedIdentities(source, source.renderableFacts)
  assert.equal(members.some((member) => member.id === 'cue-external-metadata'), false)
  const copied = remapForkSnapshotDocument(renderable, 'renderable-plan', source, input.allocation, input.identityMap, source.renderableFacts)
  assert.deepEqual(copied.sources[0].metadata, metadata)
  assert.deepEqual(copied.videoTracks[0].clips[0].metadata, metadata)
  assert.equal(copied.videoTracks[0].clips[0].id, 'copy-clip-content-source')
  assert.deepEqual(copied.markers, renderable.markers)
  assert.equal(copied.subtitleTracks[0].cues[0].text, 'clip-content-source')
  assert.deepEqual(copied.desiredActionRef, renderable.desiredActionRef)
  assert.throws(() => remapForkSnapshotDocument({ ...renderable, durationFrames: 89 }, 'renderable-plan', source, input.allocation, input.identityMap, source.renderableFacts),
    (error) => error.code === 'INVALID_COMMAND', 'a second document cannot substitute the actual source')
  const derivation = createProjectForkDerivation(independentDerivationBody(input)), targetEdit = materializeForkEditPlan(derivation)
  assert.equal(Object.hasOwn(targetEdit, 'manualEditing'), false, 'historical operation is not a new target Command')
  assert.deepEqual(targetEdit.sourceEditingLineage.manualEditing, edit.manualEditing)
  assert.equal(targetEdit.sourceEditingLineage.manualEditing.operation.clipId, 'clip-content-source', 'source lineage stays historical')
  assert.equal(targetEdit.videoTracks[0].clips[0].id, 'copy-clip-content-source')
  assert.equal(targetEdit.forkDerivationRef.hash, derivation.derivationHash)
  assert.equal(stableSerialize(source), before)
})

test('Fork derivation enforces its envelope and candidate/EditPlan refs even after complete SHA re-sealing', () => {
  const input = contentForkInput(true), derivation = createProjectForkDerivation(independentDerivationBody(input))
  assert.throws(() => materializeForkRenderablePlan({ ...derivation, schemaVersion: 'project-fork-derivation/v0' }),
    (error) => error.code === 'INVALID_COMMAND')
  assert.throws(() => materializeForkEditPlan({ ...derivation, unexpectedAuthority: hash }),
    (error) => error.code === 'INVALID_COMMAND')
  for (const [label, mutate] of [
    ['wrong candidate derivation identity', (c) => { c.payload.renderablePlan.targetCandidate.derivationRef.id = 'derivation-sister' }],
    ['wrong candidate derivation hash', (c) => { c.payload.renderablePlan.targetCandidate.derivationRef.hash = 'b'.repeat(64) }],
    ['EditPlan derivation ref absent', (c) => { const s = c.payload.snapshots.find((s) => s.kind === 'edit-plan'), p = JSON.parse(s.contentJson);
      delete p.forkDerivationRef; s.contentJson = stableSerialize(p); s.contentHash = calculateCanonicalHash(p) }],
    ['EditPlan derivation ref wrong', (c) => { const s = c.payload.snapshots.find((s) => s.kind === 'edit-plan'), p = JSON.parse(s.contentJson);
      p.forkDerivationRef.id = 'derivation-sister'; s.contentJson = stableSerialize(p); s.contentHash = calculateCanonicalHash(p) }],
    ['fresh target inventory but shared revision', (c) => { const map = c.payload.identityMap; map.find((m) => m.kind === 'revision').targetId = map.find((m) => m.kind === 'variant').targetId }],
  ]) {
    const command = structuredClone(buildProjectCreationOriginCommandV2(input)); mutate(command); resealCommandAttack(command)
    assert.throws(() => sealV2Again(command), (error) => error.code === 'INVALID_COMMAND', label)
  }
})

function operationalRootInput(suffix='operational',createdAt=at) {
  const old=buildProjectCreationOriginCommandV2(creationV2Input(suffix,createdAt))
  return {...policy,id:old.id,workspaceId:old.workspaceId,projectId:old.projectId,versionId:old.versionId,
    createdAt:old.createdAt,audit:old.audit,payload:{...policy,schemaVersion:'project-creation-output-payload/v2',
      callerIntent:old.payload.callerIntent,allocations:old.payload.allocations,snapshots:old.payload.snapshots,
      forkDerivation:null,renderableCandidate:null}}
}
function operationalForkInput(music=true,secondaryAudio=false,compiled=true) {
  const raw=contentForkInput(compiled,music,secondaryAudio), old=buildProjectCreationOriginCommandV2(raw), source=raw.source
  const sourceManifests=new Map(['artifact-content-source',...(music?['artifact-music-source']:[]),...(secondaryAudio?['artifact-secondary-speech']:[])].map((id,index)=>{
    const manifest=createMediaArtifactManifestV2({artifactKey:'controlled/'+id+(index?'.wav':'.mp4'),artifactSha256:index?'b'.repeat(64):hash,byteSize:index?2000:1000,
      mediaType:index?'audio':'video',container:index?'wav':'mp4',recipe:{id:'controlled-metadata-source',version:'1',parameters:{evidenceScope:'metadata-only'}},sources:[]})
    return [id,{id:id==='artifact-content-source'?'manifest-content-source':id==='artifact-music-source'?'manifest-music-source':'manifest-secondary-speech',artifactId:id,workspaceId:scope.workspaceId,schemaVersion:manifest.schemaVersion,
      manifestJson:JSON.stringify(manifest),manifestHash:manifest.manifestHash,createdAt:at,recipeId:manifest.recipe.id,recipeVersion:manifest.recipe.version,parametersHash:manifest.recipe.parametersHash,recipeParametersRef:null,renderInputRef:null,renderInputHash:null,recipeParameters:null,renderInput:null}]
  }))
  // Reconstruct the declared source witness and its bound Version after using
  // the real manifest constructor. No physical probe/normalization is claimed.
  const stateInput=structuredClone(source.state.document),projection=stateInput.entries[0].geometry.projection
  for(const clip of projection.clips){const mf=sourceManifests.get(clip.sourceArtifactId);clip.sourceManifestHash=mf.manifestHash
    clip.probe.document.sourceManifestHash=mf.manifestHash;clip.probe.hash=calculateOutputCanonicalHash(clip.probe.document)
    clip.normalization.document.sourceManifestHash=mf.manifestHash;clip.normalization.document.probeHash=clip.probe.hash;clip.normalization.hash=calculateOutputCanonicalHash(clip.normalization.document)}
  stateInput.entries[0].geometry.projectionHash=calculateOutputCanonicalHash(projection);stateInput.overlays[0].dependencyHash=stateInput.entries[0].geometry.projectionHash
  source.state=createProjectOutputState(stateInput,source.facts)
  const base=outputBoundVersionHashBody({...scope,resultVersionId:source.version.id,parentVersionId:source.version.parentVersionId,previousBaseHash:source.previousBaseHash,
    producerHash:source.state.document.producer.hash,outputStateId:source.state.document.id,outputStateHash:source.state.stateHash})
  const versionInput=structuredClone(source.version);delete versionInput.schemaVersion;delete versionInput.outputContractVersion;delete versionInput.outputStateId;delete versionInput.outputStateHash
  source.version=rebuildRetiredContractOneVersion({...versionInput,baseHash:calculateOutputCanonicalHash(base),outputState:source.state,previousBaseHash:source.previousBaseHash})
  source.outputBaseHashJson=serializeOutputCanonicalJson(base)
  // Refresh the older isolated kernel under the same explicit target identities.
  raw.source=source;raw.cropDecisions[0].sourceOverlayHash=calculateOutputCanonicalHash(source.state.document.overlays[0])
  const kernel=createProjectForkDerivation(independentDerivationBody(raw))
  const sourceEditPlanSnapshot={schemaVersion:1,id:source.version.snapshotRefs.editPlan,...scope,kind:'edit-plan',contentSchemaVersion:2,
    contentJson:stableSerialize(source.facts.editPlanDocument),contentHash:source.state.document.editPlan.hash,
    createdAt:'2026-10-11T12:01:30.000Z'}
  const sourceReferences=[{sourceLinkId:'11111111-1111-4111-8111-111111111111',targetLinkId:'22222222-2222-4222-8222-222222222222',
    workspaceId:scope.workspaceId,sourceProjectId:scope.projectId,artifactId:'artifact-content-source',role:'source-master',originalFileName:'controlled-source.mp4',
    sourceLinkCreatedAt:at,artifactSha256:hash,artifactByteSize:'1000',artifactMediaType:'video',artifactContainer:'mp4',artifactLifecycleRevision:1,purpose:'editing'},
    ...(music?[{sourceLinkId:'33333333-3333-4333-8333-333333333333',targetLinkId:'44444444-4444-4444-8444-444444444444',workspaceId:scope.workspaceId,
      sourceProjectId:scope.projectId,artifactId:'artifact-music-source',role:'source-audio',originalFileName:'controlled-music.wav',sourceLinkCreatedAt:at,
      artifactSha256:'b'.repeat(64),artifactByteSize:'2000',artifactMediaType:'audio',artifactContainer:'wav',artifactLifecycleRevision:1,purpose:'editing'}]:[]),
    ...(secondaryAudio?[{sourceLinkId:'66666666-6666-4666-8666-666666666666',targetLinkId:'77777777-7777-4777-8777-777777777777',workspaceId:scope.workspaceId,
      sourceProjectId:scope.projectId,artifactId:'artifact-secondary-speech',role:'source-audio',originalFileName:'controlled-speech.wav',sourceLinkCreatedAt:at,
      artifactSha256:'b'.repeat(64),artifactByteSize:'2000',artifactMediaType:'audio',artifactContainer:'wav',artifactLifecycleRevision:1,purpose:'editing'}]:[])]
  const forkDerivation=createProjectForkDerivationV2({...policy,schemaVersion:'project-fork-derivation/v2',id:raw.derivationId,
    kernel,kernelCanonicalJson:serializeOutputCanonicalJson(kernel.document),sourceEditPlanSnapshot,sourceReferences:sourceReferences.map(r=>({...r,artifactKey:JSON.parse(sourceManifests.get(r.artifactId).manifestJson).artifact.artifactKey,manifestFacts:sourceManifests.get(r.artifactId)})),sourceProject:{id:scope.projectId,workspaceId:scope.workspaceId,
      currentVersionId:source.version.id,name:'Actual source row',status:'draft',format:'9:16',ownerId:null,administrationRevision:1,updatedAt:source.version.createdAt,
      objective:'discovery',locale:'pt-BR',createdByType:'api-client',createdById:audit.clientId,createdAt:at}})
  // Only the changed reference to derivation/v2 differs from the independent
  // nonempty clip/cue/crop vectors declared above. Media/text remain source.
  const edit=materializeForkEditPlanV2(forkDerivation)
  const snapshots=old.payload.snapshots.map((s)=>s.kind==='edit-plan'?{...s,contentJson:stableSerialize(edit),contentHash:calculateCanonicalHash(edit)}:s)
  return {...policy,id:old.id,workspaceId:old.workspaceId,projectId:old.projectId,versionId:old.versionId,createdAt:old.createdAt,audit:old.audit,
    payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent:old.payload.callerIntent,allocations:old.payload.allocations,snapshots,
      forkDerivation,renderableCandidate:buildForkRenderablePlanCandidateV2(forkDerivation)}}
}
test('Fork3 of Creation2 preserves its blocked compiled candidate as typed content rather than executable authority',()=>{
  const command=createProjectCreationOutputCommandV2(operationalForkInput()),bundle=buildCreationOutputVersionBundleV2(command)
  const source=createProjectForkSourceV3({bundle,snapshots:command.payload.snapshots,renderablePlanSnapshot:null})
  const target={workspaceId:scope.workspaceId,projectId:'project-refork3',resultVersionId:'version-refork3',stateId:'state-refork3',
    commandId:'creation-refork3',parentVersionId:null,sequence:1,createdBy:audit.clientId,createdAt:'2026-10-14T13:00:00.000Z'}
  const identityMap=forkOwnedIdentitiesV3(source,null).map(m=>({kind:m.kind,sourceId:m.id,targetId:m.kind==='version'?target.resultVersionId:m.kind==='state'?target.stateId:'refork-'+m.id}))
  const mapped=(kind,id)=>identityMap.find(m=>m.kind===kind&&m.sourceId===id).targetId
  const cropDecisions=source.state.document.overlays.map(overlay=>({sourceOverlayId:overlay.id,sourceOverlayHash:calculateOutputCanonicalHash(overlay),
    newOverlayId:mapped('overlay',overlay.id),newVariantId:mapped('variant',overlay.variantId),newClipId:mapped('clip',overlay.clipId),copiedDocument:overlay.document,
    author:command.author,createdAt:target.createdAt,geometryStatus:'requires-target-materialization'}))
  const kernel=createProjectForkKernelV3({...policy,schemaVersion:'project-fork-kernel/v3',id:'derivation-refork3',
    callerIntent:{schemaVersion:'project-creation-intent/v2',kind:'fork-with-content',name:'Copy of factual content'},audit,target,source,
    sourceRenderablePlanSnapshot:null,identityMap,cropDecisions,compilePolicyVersion:PROJECT_FORK_COMPILE_POLICY_VERSION})
  const sourceReferences=command.payload.forkDerivation.document.sourceReferences.map((ref,i)=>({...ref,sourceProjectId:bundle.version.projectId,
    sourceLinkId:ref.targetLinkId,targetLinkId:'99999999-9999-4999-8999-'+String(i+1).padStart(12,'0'),sourceLinkCreatedAt:command.createdAt}))
  const metadata=creationProjectMetadataV2(command)
  const derivation=createProjectForkDerivationV3({...policy,schemaVersion:'project-fork-derivation/v3',id:kernel.document.id,kernel,
    kernelCanonicalJson:serializeOutputCanonicalJson(kernel.document),sourceEditPlanSnapshot:command.payload.snapshots.find(s=>s.kind==='edit-plan'),sourceReferences,
    sourceProject:{id:bundle.version.projectId,workspaceId:scope.workspaceId,currentVersionId:bundle.version.id,name:metadata.name,status:'draft',
      format:metadata.format,ownerId:metadata.ownerId,administrationRevision:1,updatedAt:command.createdAt,objective:metadata.objective,locale:metadata.locale,
      createdByType:'api-client',createdById:audit.clientId,createdAt:command.createdAt}})
  const candidate=buildForkRenderablePlanCandidateV3(derivation),original=command.payload.renderableCandidate
  assert.equal(source.version.outputContractVersion,2);assert.equal(source.bundle.command.commandHash,command.commandHash)
  assert.equal(kernel.document.sourceRenderablePlanSnapshot,null)
  assert.equal(candidate.source.kind,'blocked-fork-candidate');assert.equal(candidate.source.planHash,original.planHash)
  assert.equal(candidate.clipCount,original.clipCount);assert.equal(candidate.durationFrames,original.durationFrames)
  assert.notEqual(candidate.id,original.id);assert.notEqual(candidate.planId,original.planId)
  assert.deepEqual(candidate.consumption,{status:'blocked',reason:'fork-target-materialization-required'})
  assert.equal(JSON.parse(candidate.planJson).videoTracks[0].clips.length,JSON.parse(original.planJson).videoTracks[0].clips.length)
  assert.equal(Object.hasOwn(JSON.parse(candidate.planJson),'directorRunId'),false)
})

function resealOperationalCommand(c) {
  c.payloadHash=calculateOutputCanonicalHash(c.payload)
  c.commandHash=calculateOutputCanonicalHash({...policy,schemaVersion:2,id:c.id,workspaceId:c.workspaceId,projectId:c.projectId,versionId:c.versionId,
    actorContextHash:c.actorContextHash,payloadHash:c.payloadHash,requestFingerprint:c.requestFingerprint,createdAt:c.createdAt})
  return c
}
test('Creation operational2 root full bundle binds real intent and every seal without circular result authority',()=>{
  const command=createProjectCreationOutputCommandV2(operationalRootInput()), bundle=buildCreationOutputVersionBundleV2(command)
  assert.equal(bundle.version.outputContractVersion,2);assert.equal(bundle.version.sequence,1)
  assert.equal(bundle.state.document.provenance.hash,command.commandHash)
  assert.equal(bundle.version.outputStateHash,bundle.state.stateHash)
  assert.deepEqual(bundle.state.document.consumption,{status:'blocked',reasons:['empty-project']})
  assert.equal('resultStateHash' in command.payload,false);assert.equal('resultBaseHash' in command.payload,false)
  assert.equal(bundle.state.document.sourceDependencies,null)
  assert.deepEqual(creationProjectMetadataV2(command),{name:command.payload.callerIntent.name,ownerId:audit.clientId,format:null,objective:command.payload.callerIntent.objective,locale:command.payload.callerIntent.locale})
  assert.deepEqual(validateCreationOutputVersionBundleV2(JSON.parse(serializeOutputCanonicalJson(bundle))),bundle,'canonical persisted roundtrip preserves managed seals')
  const other=createProjectCreationOutputCommandV2(operationalRootInput('other-op','2030-01-01T00:00:00.000Z'))
  assert.equal(command.requestFingerprint,other.requestFingerprint);assert.notEqual(command.commandHash,other.commandHash)
  for(const purpose of ['render','critic','final'])assert.throws(()=>requireOutputStateConsumableV2(bundle.state,purpose),e=>e.code==='PRECONDITION_REQUIRED')
})
test('Creation operational2 compiled fork preserves clip cue audio crop and source row timestamp without acceptance',()=>{
  const input=operationalForkInput(), before=serializeOutputCanonicalJson(input.payload.forkDerivation.document.kernel.document.source)
  const command=createProjectCreationOutputCommandV2(input),bundle=buildCreationOutputVersionBundleV2(command),s=bundle.state.document
  assert.deepEqual(validateCreationOutputVersionBundleV2(JSON.parse(serializeOutputCanonicalJson(bundle))),bundle)
  const edit=JSON.parse(command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson),renderable=JSON.parse(command.payload.renderableCandidate.planJson)
  assert.equal(edit.videoTracks[0].clips[0].id,'copy-clip-content-source');assert.equal(edit.subtitleTracks[0].cues[0].clipId,'copy-clip-content-source')
  assert.equal(edit.subtitleTracks[0].cues[0].text,'clip-content-source');assert.equal(edit.videoTracks[0].clips[0].sourceArtifactId,'artifact-content-source')
  assert.equal(renderable.audioTracks[0].artifactId,'artifact-music-source');assert.equal(renderable.audioTracks[0].id,'copy-track-music-source')
  assert.equal(renderable.audioTimelineHash,createDirectedAudioTimelineHash({fps:renderable.fps,clips:renderable.videoTracks[0].clips,musicTracks:renderable.audioTracks}))
  assert.equal('directorRunId' in renderable,false);assert.equal('critic' in renderable,false);assert.equal('approval' in renderable,false)
  assert.equal(renderable.sourceDirectionLineage.snapshotId,'renderable-snapshot-content-source')
  assert.equal(s.overlays[0].status,'inactive-requires-target-materialization');assert.deepEqual(s.overlays[0].document.document.crop,{x:.1,y:.1,width:.8,height:.8})
  assert.equal(s.sourceDependencies.status,'blocked-source-lineage-only');assert.equal(s.renderablePlan.status,'blocked')
  assert.equal(command.payload.forkDerivation.document.sourceEditPlanSnapshot.createdAt,'2026-10-11T12:01:30.000Z')
  assert.notEqual(command.payload.forkDerivation.document.sourceEditPlanSnapshot.createdAt,command.payload.forkDerivation.document.kernel.document.source.version.createdAt)
  assert.equal(serializeOutputCanonicalJson(input.payload.forkDerivation.document.kernel.document.source),before)
  assert.equal(inspectCreationOutputOriginV2(command).status,'blocked')
  assert.equal(creationProjectMetadataV2(command).ownerId,audit.clientId);assert.equal(creationProjectMetadataV2(command).format,'9:16')
  const changed=structuredClone(input);changed.payload.forkDerivation.document.sourceReferences[0].targetLinkId='55555555-5555-4555-8555-555555555555'
  changed.payload.forkDerivation=createProjectForkDerivationV2(changed.payload.forkDerivation.document)
  const plan=materializeForkEditPlanV2(changed.payload.forkDerivation),snapshot=changed.payload.snapshots.find(s=>s.kind==='edit-plan')
  snapshot.contentJson=stableSerialize(plan);snapshot.contentHash=calculateCanonicalHash(plan);changed.payload.renderableCandidate=buildForkRenderablePlanCandidateV2(changed.payload.forkDerivation)
  assert.equal(createProjectCreationOutputCommandV2(changed).requestFingerprint,command.requestFingerprint,'new media-link allocation is not caller intent')
})
test('Creation operational2 rejects fully resealed factual scope reference IDs audit and authority substitutions',()=>{
  for(const [label,mutate] of [
    ['target snapshot envelope schema',c=>{c.payload.snapshots[0].schemaVersion=2}],
    ['target snapshot extra key',c=>{c.payload.snapshots[0].unexpectedAuthority='unapproved'}],
    ['source snapshot envelope schema',c=>{c.payload.forkDerivation.document.sourceEditPlanSnapshot.schemaVersion=2}],
    ['source snapshot extra key',c=>{c.payload.forkDerivation.document.sourceEditPlanSnapshot.unexpectedAuthority='unapproved'}],
    ['actual edit schema',c=>{c.payload.forkDerivation.document.sourceEditPlanSnapshot.contentSchemaVersion=1}],
    ['actual edit hash',c=>{c.payload.forkDerivation.document.sourceEditPlanSnapshot.contentHash='c'.repeat(64)}],
    ['source Project scope',c=>{c.payload.forkDerivation.document.sourceProject.workspaceId='workspace-sister'}],
    ['source media link shared',c=>{const r=c.payload.forkDerivation.document.sourceReferences[0];r.targetLinkId=r.sourceLinkId}],
    ['source media link missing',c=>{c.payload.forkDerivation.document.sourceReferences=[]}],
    ['source reference wrong purpose',c=>{c.payload.forkDerivation.document.sourceReferences[0].purpose='rendering'}],
    ['clip references source',c=>{const r=c.payload.snapshots.find(s=>s.kind==='edit-plan'),p=JSON.parse(r.contentJson);p.subtitleTracks[0].cues[0].clipId='clip-content-source';r.contentJson=stableSerialize(p);r.contentHash=calculateCanonicalHash(p)}],
    ['target candidate Director',c=>{const r=c.payload.renderableCandidate,p=JSON.parse(r.planJson);p.directorRunId='forged-target-run';r.planJson=serializeOutputCanonicalJson(p);const body={...policy,schemaVersion:'project-fork-renderable-plan-hash/v2',compilePolicyVersion:PROJECT_FORK_COMPILE_POLICY_VERSION,plan:p};r.planHashJson=serializeOutputCanonicalJson(body);r.planHash=calculateOutputCanonicalHash(body)}],
  ]){
    const command=structuredClone(createProjectCreationOutputCommandV2(operationalForkInput()));mutate(command)
    command.payload.forkDerivation.derivationHash=calculateOutputCanonicalHash(command.payload.forkDerivation.document)
    resealOperationalCommand(command)
    assert.throws(()=>validateProjectCreationOutputCommandV2(command),e=>e.code==='INVALID_COMMAND',label)
  }
})
test('Creation operational2 rejects resealed State/Version/base and materialized flag without producer facts',()=>{
  const bundle=buildCreationOutputVersionBundleV2(createProjectCreationOutputCommandV2(operationalRootInput()))
  for(const [label,change] of [
    ['result sibling',b=>{b.state.document.resultVersionId='version-sister'}],
    ['producer command',b=>{b.state.document.producer.document.commandHash='c'.repeat(64);b.state.document.producer.hash=calculateOutputCanonicalHash(b.state.document.producer.document)}],
    ['materialized flag',b=>{b.state.document.consumption={status:'materialized',producerKind:'materializer',sourceStateId:b.state.document.id,sourceStateHash:b.state.stateHash}}],
  ]) {
    const bad=structuredClone(bundle);change(bad);bad.state.stateHash=calculateOutputCanonicalHash(bad.state.document);bad.version.outputStateHash=bad.state.stateHash
    const body=JSON.parse(bad.outputBaseHashJson);body.outputStateHash=bad.state.stateHash;body.producerHash=bad.state.document.producer.hash
    bad.outputBaseHashJson=serializeOutputCanonicalJson(body);bad.version.baseHash=calculateOutputCanonicalHash(body)
    assert.throws(()=>validateCreationOutputVersionBundleV2(bad),e=>e.code==='INVALID_PROJECT_VERSION',label)
  }
  const bad=structuredClone(bundle.state);bad.document.consumption={status:'materialized',producerKind:'materializer',sourceStateId:bad.document.id,sourceStateHash:bad.stateHash}
  bad.stateHash=calculateOutputCanonicalHash(bad.document)
  assert.throws(()=>requireOutputStateConsumableV2(bad,'final'),e=>e.code==='PRECONDITION_REQUIRED','a self-resealed materializer label grants nothing')
})

test('Creation2 recomposition never reallocates valid clip cue crop or media-link identities',()=>{
  const proposal=createProjectCreationOutputCommandV2(operationalForkInput())
  assert.doesNotThrow(()=>assertCreationRecompositionV2(proposal,proposal))
  const rootInput=operationalRootInput(),root=createProjectCreationOutputCommandV2(rootInput),different=structuredClone(rootInput)
  const edit=different.payload.snapshots.find(s=>s.kind==='edit-plan'),plan=JSON.parse(edit.contentJson)
  plan.id='reallocated-root-plan';edit.contentJson=stableSerialize(plan);edit.contentHash=calculateCanonicalHash(plan)
  const validRoot=createProjectCreationOutputCommandV2(different)
  assert.equal(root.requestFingerprint,validRoot.requestFingerprint)
  assert.throws(()=>assertCreationRecompositionV2(root,validRoot),e=>e.code==='PERSISTENCE_CONFLICT','root plan allocation must also stay stable')
  for(const kind of ['clip','cue','overlay','media-link']) {
    const input=structuredClone(operationalForkInput()),d=input.payload.forkDerivation.document,k=structuredClone(d.kernel.document)
    const mapping=k.identityMap.find(m=>m.kind===kind),old=mapping?.targetId,next='recomposed-'+old
    if(kind==='media-link')d.sourceReferences[0].targetLinkId='88888888-8888-4888-8888-888888888888'
    else mapping.targetId=next
    for(const crop of k.cropDecisions) {
      if(crop.newOverlayId===old)crop.newOverlayId=next
      if(crop.newClipId===old)crop.newClipId=next
    }
    d.kernel=createProjectForkDerivation(k);d.kernelCanonicalJson=serializeOutputCanonicalJson(d.kernel.document)
    input.payload.forkDerivation=createProjectForkDerivationV2(d)
    const plan=materializeForkEditPlanV2(input.payload.forkDerivation),row=input.payload.snapshots.find(s=>s.kind==='edit-plan')
    row.contentJson=stableSerialize(plan);row.contentHash=calculateCanonicalHash(plan)
    input.payload.renderableCandidate=buildForkRenderablePlanCandidateV2(input.payload.forkDerivation)
    const validChanged=createProjectCreationOutputCommandV2(input)
    assert.equal(validChanged.requestFingerprint,proposal.requestFingerprint,kind+' is an allocation, not intent')
    assert.notEqual(validChanged.commandHash,proposal.commandHash)
    assert.throws(()=>assertCreationRecompositionV2(proposal,validChanged),e=>e.code==='PERSISTENCE_CONFLICT',kind+' fully valid changed target must not survive retry')
  }
})
test('Creation2 requires separate audio facts even when sources array omits the secondary speech artifact',()=>{
  const input=operationalForkInput(false,true,false),command=createProjectCreationOutputCommandV2(input)
  const source=command.payload.forkDerivation.document.kernel.document.source.facts.editPlanDocument
  assert.equal(source.sources.some(s=>s.artifactId==='artifact-secondary-speech'),false)
  assert.equal(source.videoTracks[0].clips[0].audioSourceArtifactId,'artifact-secondary-speech')
  assert.equal(command.payload.forkDerivation.document.sourceReferences.find(r=>r.artifactId==='artifact-secondary-speech').purpose,'editing')
  const bad=structuredClone(command)
  bad.payload.forkDerivation.document.sourceReferences=bad.payload.forkDerivation.document.sourceReferences.filter(r=>r.artifactId!=='artifact-secondary-speech')
  bad.payload.forkDerivation.derivationHash=calculateOutputCanonicalHash(bad.payload.forkDerivation.document);resealOperationalCommand(bad)
  assert.throws(()=>validateProjectCreationOutputCommandV2(bad),e=>e.code==='INVALID_COMMAND')
})
test('Creation2 root snapshot envelopes cannot normalize schema or extra keys after resealing',()=>{
  for(const mutate of [s=>{s.schemaVersion=2},s=>{s.unexpectedAuthority='unapproved'}]) {
    const command=structuredClone(createProjectCreationOutputCommandV2(operationalRootInput()))
    mutate(command.payload.snapshots[0]);resealOperationalCommand(command)
    assert.throws(()=>validateProjectCreationOutputCommandV2(command),e=>e.code==='INVALID_COMMAND')
  }
})

test('Creation2 valid resealed manifest still has to match declared artifact key and recipe columns',()=>{
 for(const field of ['key','recipe']) {
  const command=structuredClone(createProjectCreationOutputCommandV2(operationalForkInput())),fact=command.payload.forkDerivation.document.sourceReferences[0]
  const old=JSON.parse(fact.manifestFacts.manifestJson)
  const changed=createMediaArtifactManifestV2({artifactKey:field==='key'?'controlled/other-key.mp4':old.artifact.artifactKey,artifactSha256:old.artifact.sha256,
   byteSize:old.artifact.byteSize,mediaType:old.artifact.mediaType,container:old.artifact.container,
   recipe:{id:field==='recipe'?'other-valid-recipe':old.recipe.id,version:old.recipe.version,parameters:{evidenceScope:'metadata-only'}},sources:[]})
  fact.manifestFacts.manifestJson=JSON.stringify(changed);fact.manifestFacts.manifestHash=changed.manifestHash
  command.payload.forkDerivation.derivationHash=calculateOutputCanonicalHash(command.payload.forkDerivation.document);resealOperationalCommand(command)
  assert.notEqual(changed.manifestHash,old.manifestHash)
  assert.throws(()=>validateProjectCreationOutputCommandV2(command),e=>e.code==='INVALID_COMMAND',field+' valid manifest contradicts unchanged factual row columns')
 }
})

function operationalRootWithNormalizedAction() {
  const input=structuredClone(operationalRootInput('normalized-action')),raw=creationV2Input('normalized-action').callerIntent
  raw.desiredAction={destination:{type:'url',value:'https://example.test/continue'},verbalCta:'Continue',visualCta:' Continue assistindo ',disclosures:[' Somente metadata ']}
  input.payload.callerIntent=normalizeProjectCreationIntentV2(raw)
  const row=input.payload.snapshots.find(s=>s.kind==='brief'),doc=JSON.parse(row.contentJson)
  doc.desiredAction=input.payload.callerIntent.desiredAction;row.contentJson=stableSerialize(doc);row.contentHash=calculateCanonicalHash(doc)
  return input
}
function isolatedCreationSealInput(input) {
  return {...policy,id:input.id,workspaceId:input.workspaceId,projectId:input.projectId,versionId:input.versionId,audit:input.audit,createdAt:input.createdAt,
    payload:{...policy,schemaVersion:'project-creation-payload/v2',callerIntent:input.payload.callerIntent,allocations:input.payload.allocations,snapshots:input.payload.snapshots,
      sourceBaseline:null,identityMap:[],cropDecisions:[],renderablePlan:null,forkDerivation:null}}
}
test('Creation2 validates full normalized DesiredAction idempotently without passing its envelope to the raw parser',()=>{
  const input=operationalRootWithNormalizedAction(),intent=input.payload.callerIntent
  assert.deepEqual(intent.desiredAction,{schemaVersion:1,kind:'continue-viewing',destination:{type:'url',value:'https://example.test/continue'},
    verbalCta:'Continue',visualCta:'Continue assistindo',disclosures:['Somente metadata']})
  assert.deepEqual(validateNormalizedProjectCreationIntentV2(intent),intent)
  assert.deepEqual(validateNormalizedProjectCreationIntentV2(validateNormalizedProjectCreationIntentV2(intent)),intent)
  const command=createProjectCreationOutputCommandV2(input),read=validateProjectCreationOutputCommandV2(JSON.parse(serializeOutputCanonicalJson(command)))
  assert.deepEqual(read,command);assert.equal(read.commandHash,command.commandHash);assert.equal(read.requestFingerprint,command.requestFingerprint)
  assert.doesNotThrow(()=>createProjectCreationCommandV2(isolatedCreationSealInput(input)))
  assert.throws(()=>normalizeProjectCreationIntentV2(intent),e=>e.code==='INVALID_ARGUMENT','raw caller normalizer still rejects a complete persisted DesiredAction envelope')
})
test('Creation2 rejects fully resealed normalized action schema kind fields and nested types in both constructors',()=>{
  for(const [label,mutate] of [
    ['schema number',a=>{a.schemaVersion=2}],['schema string',a=>{a.schemaVersion='1'}],
    ['kind/objective mismatch',a=>{a.kind='buy'}],['unknown kind',a=>{a.kind='anything'}],
    ['unknown action key',a=>{a.approved=true}],['unknown destination key',a=>{a.destination.approved=true}],
    ['destination type',a=>{a.destination.type=42}],['destination value type',a=>{a.destination.value=42}],
    ['CTA type',a=>{a.visualCta=42}],['noncanonical CTA',a=>{a.visualCta=' Continue assistindo '}],
    ['disclosures type',a=>{a.disclosures='Somente metadata'}],['disclosure item type',a=>{a.disclosures=[42]}],
    ['missing disclosures',a=>{delete a.disclosures}],
  ]) {
    const input=structuredClone(operationalRootWithNormalizedAction()),command=structuredClone(createProjectCreationOutputCommandV2(input))
    mutate(command.payload.callerIntent.desiredAction)
    const row=command.payload.snapshots.find(s=>s.kind==='brief'),doc=JSON.parse(row.contentJson)
    doc.desiredAction=command.payload.callerIntent.desiredAction;row.contentJson=stableSerialize(doc);row.contentHash=calculateCanonicalHash(doc)
    command.requestFingerprint=calculateOutputCanonicalHash({...policy,schemaVersion:'project-creation-output-request/v2',workspaceId:command.workspaceId,
      callerIntent:command.payload.callerIntent,actorContextHash:command.actorContextHash,sourceBaseline:null})
    resealOperationalCommand(command)
    assert.throws(()=>validateProjectCreationOutputCommandV2(command),e=>e.code==='INVALID_COMMAND',label+' operational')
    input.payload=command.payload
    assert.throws(()=>createProjectCreationCommandV2(isolatedCreationSealInput(input)),e=>e.code==='INVALID_COMMAND',label+' low-level')
  }
})

// This projects an unsealed controlled input only. It does not replace the
// fixture's immutable source snapshot or grant renderer/rights authority.
test('Editorial projection preserves typed CTA/music/crop through a split without transferring authority', async () => {
  const { createEditorialForkFixture } = await import('./helpers/operational-editorial-fixture.mjs')
  const { createMediaTranscript } = await import('../../src/v2/domain/media-transcript.ts')
  const { createEditorialSourceBindingV1 } = await import('../../src/v2/domain/output-materialization.ts')
  const { materializeEditorialCutPlanV3, createEditorialAudioProjectionV1 } = await import('../../src/v2/domain/editorial-cut-impact.ts')
  const {createExternalAuditContext}=await import('../../src/v2/application/authenticate-api-client.ts')
  const externalAudit=createExternalAuditContext({clientId:audit.clientId,credentialId:audit.credentialId,workspaceId:audit.workspaceId,environment:audit.environment})
  const actor = { ...externalAudit, auditContext: externalAudit, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
  const transcript = createMediaTranscript({language:'pt-BR',text:'Primeiro remover último.',
    words:[{word:'Primeiro',start:0,end:1},{word:'remover',start:1,end:2},{word:'último.',start:2,end:3}],
    segments:[{id:0,start:0,end:3,text:'Primeiro remover último.'}],provider:'controlled',model:'explicit-domain-fixture'})
  const f = await createEditorialForkFixture({actor,transcript,sourceDurationSeconds:3,fps:30,sibling:false})
  const immutableBefore = serializeOutputCanonicalJson(f.fork.bundle)
  const before = JSON.parse(f.fork.bundle.command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson)
  const typed = contentForkInput(true,true).source.facts.renderablePlanDocument
  const clip = before.videoTracks[0].clips[0], crop = {x:.1,y:.1,width:.8,height:.8}
  clip.crop = crop
  before.overlayTracks = [{id:'cta-editorial-content',kind:'cta',desiredActionRef:typed.desiredActionRef,
    startFrame:15,endFrame:75,text:'Conteúdo preservado',clipId:clip.id}]
  before.audioTracks = structuredClone(typed.audioTracks)
  assert.deepEqual(before.audioTracks.map(t=>[t.sourceInFrame,t.sourceOutFrame,t.timelineInFrame,t.timelineOutFrame,t.fadeInFrames,t.fadeOutFrames]),[[0,90,0,90,0,0]])
  before.audioTimelineHash = createDirectedAudioTimelineHash({fps:before.fps,clips:[clip],musicTracks:before.audioTracks})
  const originalAudioHash = before.audioTimelineHash
  const binding = createEditorialSourceBindingV1({...f.context.sourceBindingFacts,id:'binding-editorial-content',
    parentVersionId:f.fork.version.id,parentStateId:f.fork.bundle.state.document.id,parentStateHash:f.fork.bundle.state.stateHash,
    resultVersionId:'version-editorial-content',createdAt:'2026-07-18T20:04:00.000Z'})
  const input = {before,sourceBinding:binding,versionId:binding.document.resultVersionId,planId:'plan-editorial-content',
    commandId:'command-editorial-content',createdAt:binding.document.createdAt,
    exclusions:[{sourceStartSeconds:1,sourceEndSeconds:2,ruleIds:['rule-editorial-content']}]}
  const after = materializeEditorialCutPlanV3(input), clips = after.videoTracks[0].clips
  assert.equal(after.durationFrames,60)
  assert.deepEqual(clips.map(c=>[c.sourceInFrame,c.sourceOutFrame,c.timelineInFrame,c.timelineOutFrame]),[[0,30,0,30],[60,90,30,60]])
  assert.deepEqual(clips.map(c=>c.crop),[crop,crop]);assert.equal(clips[0].rate,clip.rate);assert.equal(clips[1].rate,clip.rate)
  assert.notEqual(clips[1].id,clip.id)
  assert.deepEqual(after.overlayTracks.map(c=>[c.startFrame,c.endFrame,c.clipId]),[[15,30,clips[0].id],[30,45,clips[1].id]])
  assert.equal(after.overlayTracks[0].id,before.overlayTracks[0].id);assert.notEqual(after.overlayTracks[1].id,before.overlayTracks[0].id)
  for(const row of after.overlayTracks) {assert.equal(row.text,before.overlayTracks[0].text);assert.deepEqual(row.desiredActionRef,typed.desiredActionRef)}
  assert.deepEqual(after.audioTracks,[{...before.audioTracks[0],timelineOutFrame:60}])
  assert.equal(after.audioTimelineHash,createDirectedAudioTimelineHash({fps:30,clips,musicTracks:after.audioTracks}))
  assert.notEqual(after.audioTimelineHash,originalAudioHash)
  assert.equal(createEditorialAudioProjectionV1(after).mixedCanonicalJson,stableSerialize({schemaVersion:'directed-audio-timeline/v1',
    speechHash:createEditorialAudioProjectionV1(after).speechHash,musicTracks:after.audioTracks}))
  assert.equal(after.retimedTranscript.sourceTranscriptId,binding.document.transcript.id)
  assert.equal(after.retimedTranscript.sourceTranscriptHash,transcript.transcriptHash)
  assert.deepEqual(after.editorial.retainedSourceRanges,[{sourceStartSeconds:0,sourceEndSeconds:1},{sourceStartSeconds:2,sourceEndSeconds:3}])
  assert.equal(serializeOutputCanonicalJson(f.fork.bundle),immutableBefore)
  const missingTiming=structuredClone(before);delete missingTiming.overlayTracks[0].endFrame
  assert.throws(()=>materializeEditorialCutPlanV3({...input,before:missingTiming}),e=>e.code==='PRECONDITION_REQUIRED')
  const missingCueAuthority=structuredClone(before)
  missingCueAuthority.subtitleTracks=[{id:'track-unattested-cue',kind:'captions',cues:[{id:'cue-unattested',clipId:clip.id,startFrame:0,endFrame:90,text:transcript.text}]}]
  assert.throws(()=>materializeEditorialCutPlanV3({...input,before:missingCueAuthority}),e=>e.code==='PRECONDITION_REQUIRED')
  const incompleteAudio=structuredClone(before);incompleteAudio.audioTracks[0].timelineOutFrame=89
  assert.throws(()=>materializeEditorialCutPlanV3({...input,before:incompleteAudio}),e=>e.code==='PRECONDITION_REQUIRED')
})
