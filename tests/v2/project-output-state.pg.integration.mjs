import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createProjectCreationCommand } from '../../src/v2/domain/project-creation-command.ts'
import { rebuildRetiredContractOneVersion } from '../../src/v2/domain/project-version.ts'
import { createOutputSpecRevisionBody, createOutputVariant } from '../../src/v2/domain/output-spec-revision.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { createProjectOutputState, createOutputPlanAuthority, calculateOutputBoundVersionHash, outputBoundVersionHashBody } from '../../src/v2/domain/project-output-state.ts'
import { calculateOutputCanonicalHash, serializeOutputCanonicalJson, OUTPUT_CANONICAL_POLICY_VERSION } from '../../src/v2/domain/output-canonical-policy.ts'

// Isolated schema contract, not an application cutover or media acceptance run.
// The owner must migrate/generate before execution and reset the dedicated schema
// only after this client and all other run clients have disconnected. Committed
// append-only fixtures stay intact; every ID is unique to this invocation.
// Historical-0 coverage requires owner-created pre-migration rows, then this
// migration, in the same isolated schema. Never disable triggers to seed history.
const enabled = process.env.APOLLO_RUN_W66_OUTPUT_STATE_PG === '1'
const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
const transactionOptions = { maxWait: 3000, timeout: 12_000 }
const tables = new Set(['workspaces', 'api_clients', 'projects', 'project_snapshots', 'project_versions',
  'project_creation_commands', 'edit_commands', 'output_variants', 'output_spec_revisions',
  'project_output_states', 'project_output_state_entries', 'project_output_state_overlays',
  'project_output_state_invalidations', 'renderable_plan_snapshots'])
const clone = (value) => JSON.parse(JSON.stringify(value))
const latch = () => { let release; const promise = new Promise((done) => { release = done }); return { promise, release } }
async function bounded(action, milliseconds, label) {
  let timer
  try { return await Promise.race([action(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
  })]) } finally { clearTimeout(timer) }
}
async function insert(transaction, table, data) {
  assert.ok(tables.has(table))
  const columns = Object.keys(data)
  assert.ok(columns.every((column) => /^[A-Za-z][A-Za-z0-9]*$/.test(column)))
  return transaction.$executeRawUnsafe(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
    ...Object.values(data))
}
const date = (value) => new Date(value)
async function transact(client, action) {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '5000ms'")
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '4500ms'")
    await transaction.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout = '10000ms'")
    const result = await action(transaction)
    await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    return result
  }, transactionOptions)
}
function fixtureWorld() {
  const runId = randomUUID().replaceAll('-', ''), createdAt = new Date().toISOString()
  let counter = 0
  const id = (kind) => `w66-${runId}-${kind}-${++counter}`
  const workspaceId = id('workspace'), clientId = id('actor')
  const audit = createApiAccessAuditContext({ workspaceId, clientId, credentialId: id('credential'),
    environment: 'sandbox', authenticationKind: 'bearer' })
  return { runId, createdAt, id, workspaceId, clientId, audit }
}
function rootFixture(world, { optionalSnapshots = false, forkSource = null } = {}) {
  const projectId = world.id('project'), versionId = world.id('version'), snapshotId = world.id('edit-plan-snapshot')
  const plan = { id: world.id('edit-plan'), projectVersionId: versionId, fps: 30, durationFrames: 0, videoTracks: [] }
  const brief = { schemaVersion: 1, objective: 'discovery', briefing: 'Controlled W66 persistence contract' }
  const policies = { schemaVersion: 1, evidenceScope: 'controlled-database-contract' }
  const briefId = world.id('brief'), policiesId = world.id('policies')
  const treatmentId = optionalSnapshots ? world.id('treatment') : null, storyId = optionalSnapshots ? world.id('story') : null
  const creation = createProjectCreationCommand({ id: world.id('creation-command'), workspaceId: world.workspaceId,
    projectId, versionId, action: forkSource ? 'duplicate' : 'create', audit: world.audit,
    ...(forkSource ? { sourceProjectId: forkSource.projectId, sourceVersionId: forkSource.version.id } : {}),
    requestFingerprint: calculateCanonicalHash({ projectId, brief, policies }), createdAt: world.createdAt })
  const producerDocument = { ...policy, schemaVersion: 'project-created-version/v1',
    briefHash: calculateCanonicalHash(brief), policyHash: calculateCanonicalHash(policies) }
  const input = { ...policy, id: world.id('state'), workspaceId: world.workspaceId, projectId,
    resultVersionId: versionId, parentVersionId: null, parentStateId: null, parentStateHash: null,
    transition: forkSource ? 'fork-empty' : 'initialize-empty', provenance: { kind: 'creation-command', id: creation.id, hash: creation.commandHash },
    producer: { document: producerDocument, hash: calculateOutputCanonicalHash(producerDocument) },
    editPlan: { snapshotId, hash: calculateCanonicalHash(plan), authority: createOutputPlanAuthority({ ...policy,
      kind: 'project-edit-plan', planDocument: plan }) }, renderablePlan: null,
    entries: [], overlays: [], invalidations: [], createdAt: world.createdAt }
  const state = createProjectOutputState(input, { editPlanDocument: plan, renderablePlanDocument: null })
  const version = versionFor(world, state, { sequence: 1, briefId, policiesId, treatmentId, storyId, previousBaseHash: null, forkSource })
  return { world, projectId, state, version, plan, creation, command: null, newRevisions: [], newVariants: [],
    snapshots: [snapshot(world, projectId, briefId, 'brief', brief), snapshot(world, projectId, policiesId, 'policies', policies),
      snapshot(world, projectId, snapshotId, 'edit-plan', plan),
      ...(treatmentId ? [snapshot(world, projectId, treatmentId, 'treatment', { schemaVersion: 1, evidenceScope: 'controlled-root-fact' })] : []),
      ...(storyId ? [snapshot(world, projectId, storyId, 'story', { schemaVersion: 1, evidenceScope: 'controlled-root-fact' })] : [])], base: null }
}
function versionFor(world, state, { sequence, briefId, policiesId, treatmentId, storyId, previousBaseHash, parentVersionId, commandId, forkSource }) {
  const body = state.document
  return rebuildRetiredContractOneVersion({ ...policy, id: body.resultVersionId, workspaceId: body.workspaceId, projectId: body.projectId,
    sequence, ...(parentVersionId ? { parentVersionId } : {}), ...(commandId ? { commandId } : {}),
    ...(forkSource ? { forkedFromProjectId: forkSource.projectId, forkedFromVersionId: forkSource.version.id } : {}),
    snapshotRefs: { brief: briefId, policies: policiesId, editPlan: body.editPlan.snapshotId,
      ...(treatmentId ? { treatment: treatmentId } : {}), ...(storyId ? { story: storyId } : {}) },
    baseHash: calculateOutputBoundVersionHash({ workspaceId: body.workspaceId, projectId: body.projectId,
      resultVersionId: body.resultVersionId, parentVersionId: body.parentVersionId, previousBaseHash,
      producerHash: body.producer.hash, outputStateId: body.id, outputStateHash: state.stateHash }),
    outputState: state, previousBaseHash, createdBy: world.clientId, createdAt: world.createdAt })
}
function snapshot(world, projectId, id, kind, document) {
  return { id, workspaceId: world.workspaceId, projectId, kind, schemaVersion: 1,
    contentJson: stableSerialize(document), contentHash: calculateCanonicalHash(document), createdAt: date(world.createdAt) }
}
function specFixture(world, projectId, variantId) {
  // Explicit controlled encoding selections, no renderer-derived or implicit
  // defaults. These empty-plan revisions do not claim a rendered/probed source.
  const profileId = world.id('profile')
  const encoding = (final) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true,
    width: final ? 1080 : 540, height: final ? 1920 : 960, fps: 30,
    quality: { mode: 'crf', value: final ? 18 : 23, preset: final ? 'medium' : 'veryfast' },
    audio: { codec: 'aac', bitrateKbps: final ? 192 : 160, sampleRateHz: 48000, channels: 1 } })
  return createOutputSpecRevisionBody({ ...policy, id: world.id('revision'), variantId, workspaceId: world.workspaceId,
    projectId, revisionNumber: 1, output: { schemaVersion: 1, id: variantId, locale: 'pt-BR', aspectRatio: '9:16',
      width: 1080, height: 1920, fps: 30, safeArea: { top: .08, right: .06, bottom: .06, left: .06 }, deliveryProfileId: profileId },
    profile: { schemaVersion: 'materialized-delivery-profile/v1', id: profileId, version: 1,
      rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding(true), proxy: encoding(false),
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 2, scaleY: 2 },
      subtitles: { mode: 'none', configuration: null, fontAssets: [] } }, preset: null, createdAt: world.createdAt })
}
function variantFixture(base, reviseVariantId = null) {
  const { world, projectId } = base, variantId = reviseVariantId ?? world.id('variant')
  const previous = reviseVariantId ? base.state.document.entries.find((member) => member.variantId === variantId) : null
  assert.ok(!reviseVariantId || previous)
  const revision = previous ? createOutputSpecRevisionBody({ ...previous.spec, id: world.id('revision'),
    revisionNumber: previous.spec.revisionNumber + 1, createdAt: world.createdAt }) : specFixture(world, projectId, variantId)
  const command = createOutputVariantCommand({ command: { id: world.id('command'), workspaceId: world.workspaceId,
    projectId, baseVersionId: base.version.id, baseHash: base.version.baseHash, author: { type: 'api-client', id: world.clientId },
    type: previous ? 'revise-output-spec' : 'create-output-variant', idempotencyKey: world.id('key'), createdAt: world.createdAt }, audit: world.audit,
    base: base.version, baseState: base.state, historicalBaselineRequested: false, revision,
    expectedRevisionId: previous?.outputSpecRevisionId ?? null, expectedSpecHash: previous?.specHash ?? null, durationFrames: 0 })
  const versionId = world.id('version'), snapshotId = world.id('edit-plan-snapshot')
  const plan = { ...base.plan, id: world.id('edit-plan'), projectVersionId: versionId }
  const provenance = { kind: 'edit-command', id: command.command.id, hash: command.command.commandHash }
  const variant = previous ? null : createOutputVariant({ id: variantId, projectId, workspaceId: world.workspaceId,
    createdCommand: provenance, createdAt: world.createdAt })
  const member = { ...policy, variantId, outputSpecRevisionId: revision.id, spec: revision,
    specHash: calculateOutputCanonicalHash(revision), geometry: { status: 'unmaterialized', projection: null, projectionHash: null } }
  const state = createProjectOutputState({ ...policy, id: world.id('state'), projectId, workspaceId: world.workspaceId,
    resultVersionId: versionId, parentVersionId: base.version.id, parentStateId: base.state.document.id,
    parentStateHash: base.state.stateHash, transition: previous ? 'revise-output' : 'create-variant', provenance, producer: command.producer,
    editPlan: { snapshotId, hash: calculateCanonicalHash(plan), authority: createOutputPlanAuthority({ ...policy,
      kind: 'project-edit-plan', planDocument: plan }) }, renderablePlan: null,
    entries: [...base.state.document.entries.filter((entry) => entry.variantId !== variantId), member], overlays: [], invalidations: [], createdAt: world.createdAt },
  { editPlanDocument: plan, renderablePlanDocument: null })
  const version = versionFor(world, state, { sequence: base.version.sequence + 1,
    briefId: base.version.snapshotRefs.brief, policiesId: base.version.snapshotRefs.policies,
    treatmentId: base.version.snapshotRefs.treatment, storyId: base.version.snapshotRefs.story,
    parentVersionId: base.version.id, previousBaseHash: base.version.baseHash, commandId: command.command.id })
  return { world, projectId, state, version, plan, creation: null, command,
    newVariants: variant ? [variant] : [], newRevisions: [revision], snapshots: [snapshot(world, projectId, snapshotId, 'edit-plan', plan)], base }
}
function stateRow(bundle) {
  const { document: body, stateHash } = bundle.state
  return { id: body.id, projectId: body.projectId, workspaceId: body.workspaceId, resultVersionId: body.resultVersionId,
    parentVersionId: body.parentVersionId, parentStateId: body.parentStateId, parentStateHash: body.parentStateHash,
    schemaVersion: body.schemaVersion, canonicalPolicyVersion: body.canonicalPolicyVersion, transition: body.transition,
    transitionPolicyVersion: body.transitionPolicyVersion, producerKind: body.provenance.kind, producerId: body.provenance.id,
    provenanceHash: body.provenance.hash, producerEditCommandId: body.provenance.kind === 'edit-command' ? body.provenance.id : null,
    producerHash: body.producer.hash, producerJson: serializeOutputCanonicalJson(body.producer.document),
    editPlanSnapshotId: body.editPlan.snapshotId, editPlanHash: body.editPlan.hash,
    editPlanAuthorityJson: serializeOutputCanonicalJson(body.editPlan.authority.document), editPlanAuthorityHash: body.editPlan.authority.hash,
    renderablePlanSnapshotId: null, renderablePlanId: null, renderablePlanHash: null,
    renderablePlanAuthorityJson: null, renderablePlanAuthorityHash: null,
    stateJson: serializeOutputCanonicalJson(body), stateHash, createdAt: date(body.createdAt) }
}
function versionRow(bundle) {
  const v = bundle.version, body = bundle.state.document
  const hashDocument = bundle.outputBaseHashDocumentOverride ?? outputBoundVersionHashBody({ workspaceId: body.workspaceId,
    projectId: body.projectId, resultVersionId: body.resultVersionId, parentVersionId: body.parentVersionId,
    previousBaseHash: bundle.base?.version.baseHash ?? null, producerHash: body.producer.hash,
    outputStateId: body.id, outputStateHash: bundle.state.stateHash })
  return { id: v.id, workspaceId: v.workspaceId, projectId: v.projectId, sequence: v.sequence,
    parentVersionId: v.parentVersionId ?? null, briefSnapshotId: v.snapshotRefs.brief, editPlanSnapshotId: v.snapshotRefs.editPlan,
    treatmentSnapshotId: v.snapshotRefs.treatment ?? null, storySnapshotId: v.snapshotRefs.story ?? null,
    forkedFromProjectId: v.forkedFromProjectId ?? null, forkedFromVersionId: v.forkedFromVersionId ?? null,
    policiesSnapshotId: v.snapshotRefs.policies, baseHash: v.baseHash, createdBy: v.createdBy, commandId: v.commandId ?? null,
    outputContractVersion: v.outputContractVersion, outputStateId: v.outputStateId, outputStateHash: v.outputStateHash,
    outputBaseHashJson: serializeOutputCanonicalJson(hashDocument),
    createdAt: date(v.createdAt) }
}
async function persistBundle(transaction, bundle, options = {}) {
  const { world, projectId } = bundle
  if (!bundle.base) await insert(transaction, 'projects', { id: projectId, workspaceId: world.workspaceId,
    name: 'Controlled W66 PostgreSQL contract', status: 'draft', createdByType: 'api-client', createdById: world.clientId,
    createdAt: date(world.createdAt), updatedAt: date(world.createdAt) })
  if (!options.preparedSnapshot) for (const document of bundle.snapshots) await insert(transaction, 'project_snapshots', { ...document, createdAt: date(document.createdAt) })
  for (const variant of bundle.newVariants) await insert(transaction, 'output_variants', {
    id: variant.id, projectId, workspaceId: world.workspaceId, createdCommandKind: variant.createdCommand.kind,
    createdCommandId: variant.createdCommand.id, createdCommandHash: variant.createdCommand.hash, createdAt: date(variant.createdAt),
    ...options.variantOverrides })
  for (const revision of bundle.newRevisions) await insert(transaction, 'output_spec_revisions', {
    id: revision.id, variantId: revision.variantId, projectId, workspaceId: world.workspaceId, revisionNumber: revision.revisionNumber,
    schemaVersion: revision.schemaVersion, canonicalPolicyVersion: revision.canonicalPolicyVersion,
    specJson: serializeOutputCanonicalJson(revision), specHash: calculateOutputCanonicalHash(revision),
    createdCommandKind: bundle.state.document.provenance.kind, createdCommandId: bundle.state.document.provenance.id,
    createdCommandHash: bundle.state.document.provenance.hash, createdAt: date(revision.createdAt), ...options.revisionOverrides })
  if (!options.skipState) {
    try { await insert(transaction, 'project_output_states', { ...stateRow(bundle), ...options.stateOverrides }) }
    catch (error) { options.onStateInsertFailure?.(error); throw error }
  }
  for (const member of bundle.state.document.entries) if (!options.skipState) await insert(transaction, 'project_output_state_entries', {
    stateId: bundle.state.document.id, variantId: member.variantId, projectId, workspaceId: world.workspaceId,
    outputSpecRevisionId: member.outputSpecRevisionId, specHash: member.specHash, canonicalPolicyVersion: member.canonicalPolicyVersion,
    geometryStatus: member.geometry.status, geometryProjectionHash: member.geometry.projectionHash,
    entryJson: serializeOutputCanonicalJson(member), entryHash: calculateOutputCanonicalHash(member) })
  for (const overlay of bundle.state.document.overlays) if (!options.skipState) await insert(transaction, 'project_output_state_overlays', {
    id: overlay.id, stateId: bundle.state.document.id, variantId: overlay.variantId, projectId, workspaceId: world.workspaceId,
    canonicalPolicyVersion: overlay.canonicalPolicyVersion, kind: overlay.kind, clipId: overlay.clipId,
    startFrame: overlay.startFrame, endFrame: overlay.endFrame, status: overlay.status,
    originalCommandId: overlay.provenance.id, originalCommandHash: overlay.provenance.hash,
    overlayJson: serializeOutputCanonicalJson(overlay), overlayHash: calculateOutputCanonicalHash(overlay) })
  for (const issue of bundle.state.document.invalidations) if (!options.skipState) await insert(transaction, 'project_output_state_invalidations', {
    id: issue.id, stateId: bundle.state.document.id, variantId: issue.variantId, projectId, workspaceId: world.workspaceId,
    canonicalPolicyVersion: issue.canonicalPolicyVersion, overlayId: issue.overlayId, kind: issue.kind, reasonCode: issue.reasonCode,
    previousDependencyHash: issue.previousDependencyHash, nextDependencyHash: issue.nextDependencyHash,
    causedByKind: issue.provenance.kind, causedById: issue.provenance.id, causedByHash: issue.provenance.hash,
    invalidationJson: serializeOutputCanonicalJson(issue), invalidationHash: calculateOutputCanonicalHash(issue) })
  if (bundle.command && !options.skipCommand) {
    const { command: c, audit, requestFingerprint } = bundle.command, { commandHash, ...document } = c
    await insert(transaction, 'edit_commands', { id: c.id, workspaceId: c.workspaceId, projectId: c.projectId,
      baseVersionId: c.baseVersionId, baseHash: c.baseHash, type: c.type, scopeJson: stableSerialize(c.scope),
      payloadJson: stableSerialize(c.payload), actorType: c.author.type, actorId: c.author.id,
      actorCredentialId: audit.credentialId, actorEnvironment: audit.environment, actorAuthenticationKind: audit.authenticationKind,
      actorContextHash: audit.contextHash, idempotencyKey: c.idempotencyKey, requestFingerprint, commandHash,
      commandJson: stableSerialize(document),
      outputPayloadJson: ['create-output-variant', 'revise-output-spec'].includes(c.type) ? serializeOutputCanonicalJson(c.payload) : null,
      outputPayloadHash: ['create-output-variant', 'revise-output-spec'].includes(c.type) ? calculateOutputCanonicalHash(c.payload) : null,
      createdAt: date(c.createdAt), ...options.commandOverrides })
  }
  if (!options.skipVersion) await insert(transaction, 'project_versions', { ...versionRow(bundle), ...options.versionOverrides })
  if (bundle.creation && !options.skipCreation) {
    const c = bundle.creation, audit = c.audit
    await insert(transaction, 'project_creation_commands', { id: c.id, workspaceId: c.workspaceId, action: c.action,
      projectId: c.projectId, versionId: c.versionId, actorClientId: audit.clientId, actorCredentialId: audit.credentialId,
      sourceProjectId: c.sourceProjectId ?? null, sourceVersionId: c.sourceVersionId ?? null,
      actorEnvironment: audit.environment, actorAuthenticationKind: audit.authenticationKind, actorContextHash: audit.contextHash,
      requestFingerprint: c.requestFingerprint, commandHash: c.commandHash, createdAt: date(c.createdAt) })
  }
  if (!options.skipVersion) {
    const expectedHead = Object.hasOwn(options, 'expectedHead') ? options.expectedHead : bundle.base?.version.id ?? null
    const changed = await transaction.$executeRawUnsafe('UPDATE "projects" SET "currentVersionId"=$1 WHERE "id"=$2 AND "workspaceId"=$3 AND "currentVersionId" IS NOT DISTINCT FROM $4',
      bundle.version.id, projectId, world.workspaceId, expectedHead)
    assert.equal(changed, 1, 'W66 controlled CAS rejected the stale project head')
  }
}
function resealForSqlNegative(bundle, change) {
  const result = { ...clone(bundle), world: bundle.world, base: bundle.base }, body = result.state.document
  change(result, body)
  result.state.stateHash = calculateOutputCanonicalHash(body)
  result.version.outputStateHash = result.state.stateHash
  result.version.baseHash = calculateOutputBoundVersionHash({ workspaceId: body.workspaceId, projectId: body.projectId,
    resultVersionId: body.resultVersionId, parentVersionId: body.parentVersionId,
    previousBaseHash: result.base?.version.baseHash ?? null, producerHash: body.producer.hash,
    outputStateId: body.id, outputStateHash: result.state.stateHash })
  return result
}
function changeOutputCommand(bundle, body, change) {
  const c = bundle.command.command
  change(c)
  const { commandHash: _hash, ...document } = c
  c.commandHash = calculateCanonicalHash(document)
  body.provenance.hash = c.commandHash
  for (const variant of bundle.newVariants) variant.createdCommand.hash = c.commandHash
  body.producer.document = { ...body.producer.document, commandHash: c.commandHash,
    baseVersionId: c.baseVersionId, baseHash: c.baseHash, payloadHash: calculateOutputCanonicalHash(c.payload) }
  body.producer.hash = calculateOutputCanonicalHash(body.producer.document)
}
function controlledVideoGeometry(world, member, plan) {
  const video = plan.videoTracks[0].clips[0], sourceManifestId = world.id('negative-manifest')
  const identity = { sourceArtifactId: video.sourceArtifactId, sourceManifestId,
    sourceManifestHash: 'a'.repeat(64), sourceSha256: 'b'.repeat(64) }
  const seal = (document) => ({ schemaVersion: document.schemaVersion, document, hash: calculateOutputCanonicalHash(document) })
  const probe = seal({ ...policy, schemaVersion: 'observed-video-probe/v1', ...identity,
    width: 1920, height: 1080, fps: 30, durationFrames: 30, timebase: { numerator: 1, denominator: 15360 },
    orientation: { rotationDegrees: 0, displayTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1] } })
  const projection = { ...policy, schemaVersion: 'variant-reframe-geometry/v1', variantId: member.variantId,
    output: { aspectRatio: member.spec.output.aspectRatio, width: member.spec.output.width, height: member.spec.output.height,
      fps: 30, proxyToFinal: member.spec.profile.proxyToFinal },
    timeline: { fps: 30, durationFrames: 30, trackId: plan.videoTracks[0].id },
    clips: [{ ...video, ...identity, probe, normalization: seal({ ...policy,
      schemaVersion: 'observed-normalization/v1', ...identity, mode: 'verified-source', probeHash: probe.hash }) }],
    composition: { foregroundScale: { present: false, value: null }, verticalPosition: { present: false, value: null } }, globalCropPresent: false }
  return { status: 'verified', projection, projectionHash: calculateOutputCanonicalHash(projection) }
}
function changeLegacyPlan(bundle, body, change) {
  change(bundle.plan)
  const oldHash = calculateCanonicalHash(bundle.plan)
  body.editPlan.hash = oldHash
  body.editPlan.authority = { schemaVersion: 'output-plan-authority/v1', document: {
    ...policy, schemaVersion: 'output-plan-authority/v1', kind: 'project-edit-plan',
    legacyCanonicalJson: stableSerialize(bundle.plan), legacyHash: oldHash } }
  body.editPlan.authority.hash = calculateOutputCanonicalHash(body.editPlan.authority.document)
  const row = bundle.snapshots.find((document) => document.id === body.editPlan.snapshotId)
  row.contentJson = stableSerialize(bundle.plan); row.contentHash = oldHash
}
async function assertAbsent(client, bundle) {
  const [states, versions, commands, variants, revisions, snapshots, creation, overlays, issues] = await Promise.all([
    client.v2ProjectOutputState.count({ where: { id: bundle.state.document.id } }),
    client.v2ProjectVersion.count({ where: { id: bundle.version.id } }),
    client.v2EditCommand.count({ where: { id: bundle.command?.command.id ?? bundle.world.id('unused') } }),
    client.v2OutputVariant.count({ where: { id: { in: bundle.newVariants.map((variant) => variant.id) } } }),
    client.v2OutputSpecRevision.count({ where: { id: { in: bundle.newRevisions.map((revision) => revision.id) } } }),
    client.v2ProjectSnapshot.count({ where: { id: { in: bundle.snapshots.map((document) => document.id) } } }),
    client.v2ProjectCreationCommand.count({ where: { id: bundle.creation?.id ?? bundle.world.id('unused') } }),
    client.v2ProjectOutputStateOverlay.count({ where: { stateId: bundle.state.document.id } }),
    client.v2ProjectOutputStateInvalidation.count({ where: { stateId: bundle.state.document.id } }),
  ])
  assert.deepEqual([states, versions, commands, variants, revisions, snapshots, creation, overlays, issues], [0, 0, 0, 0, 0, 0, 0, 0, 0])
  if (!bundle.base) assert.equal(await client.v2Project.count({ where: { id: bundle.projectId } }), 0)
}
async function awaitLock(client, pid) {
  const deadline = Date.now() + 2500
  do {
    const [activity] = await client.$queryRawUnsafe('SELECT "wait_event_type" FROM pg_stat_activity WHERE pid=$1', pid)
    if (activity?.wait_event_type === 'Lock') return
    await new Promise((done) => setTimeout(done, 25))
  } while (Date.now() < deadline)
  assert.fail(`W66 expected backend ${pid} to be blocked by the actual dependency lock`)
}
async function snapshotLockRace(client, base, order) {
  const candidate = variantFixture(base), snapshotRow = candidate.snapshots[0]
  await transact(client, (transaction) => insert(transaction, 'project_snapshots', snapshotRow))
  const writerReady = latch(), mutatorReady = latch(), releaseWriter = latch(), releaseMutator = latch()
  let writer, mutator, primaryError, cleanupError
  const capture = (promise) => promise.then(() => ({ ok: true }), (error) => ({ ok: false, error }))
  const startWriter = () => capture(transact(client, async (transaction) => {
    const [{ pid }] = await transaction.$queryRawUnsafe('SELECT pg_backend_pid() AS pid')
    if (order === 'dependency-first') writerReady.release(pid)
    await persistBundle(transaction, candidate, { preparedSnapshot: true })
    // Force the real deferred guards/FK row locks, then hold the transaction.
    await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    if (order === 'state-first') { writerReady.release(pid); await bounded(() => releaseWriter.promise, 7000, 'State-held latch') }
  }))
  const startMutator = () => capture(transact(client, async (transaction) => {
    const [{ pid }] = await transaction.$queryRawUnsafe('SELECT pg_backend_pid() AS pid')
    if (order === 'state-first') mutatorReady.release(pid)
    await transaction.$queryRawUnsafe('SELECT "id" FROM "project_snapshots" WHERE "id"=$1 FOR UPDATE', snapshotRow.id)
    if (order === 'dependency-first') { mutatorReady.release(pid); await bounded(() => releaseMutator.promise, 7000, 'Dependency-held latch') }
    await transaction.$executeRawUnsafe('UPDATE "project_snapshots" SET "contentHash"=$1 WHERE "id"=$2', 'c'.repeat(64), snapshotRow.id)
  }))
  try {
    if (order === 'dependency-first') {
      mutator = startMutator(); await bounded(() => mutatorReady.promise, 2500, 'Dependency owner entered')
      writer = startWriter(); const writerPid = await bounded(() => writerReady.promise, 2500, 'State writer entered')
      await awaitLock(client, writerPid); releaseMutator.release()
    } else {
      writer = startWriter(); await bounded(() => writerReady.promise, 2500, 'State writer sealed')
      mutator = startMutator(); const mutatorPid = await bounded(() => mutatorReady.promise, 2500, 'Dependency mutator entered')
      await awaitLock(client, mutatorPid); releaseWriter.release()
    }
  } catch (error) { primaryError = error }
  finally {
    releaseWriter.release(); releaseMutator.release()
    // Always release both latches and await both transaction outcomes, including
    // an assertion failure before wait-event observation. No orphan SQL clients.
    let outcomes
    try { outcomes = await bounded(() => Promise.all([writer, mutator]), 10_000, 'Snapshot race terminal transactions') }
    catch (error) { cleanupError = error }
    if (!primaryError && !cleanupError) {
      assert.equal(outcomes[0]?.ok, true, `State writer failed: ${outcomes[0]?.error}`)
      assert.equal(outcomes[1]?.ok, false)
      assert.match(outcomes[1].error.message, /W66 immutable dependency: project_snapshots UPDATE/)
    }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Snapshot race failed; transaction cleanup is inconclusive')
  if (cleanupError) throw cleanupError
  if (primaryError) throw primaryError
  const persisted = await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: snapshotRow.id } })
  assert.equal(persisted.contentHash, snapshotRow.contentHash)
  assert.equal((await client.v2ProjectOutputState.findUniqueOrThrow({ where: { id: candidate.state.document.id } })).stateHash,
    candidate.state.stateHash)
  return candidate
}

test('W66 real PostgreSQL output-state contract and immutable dependency races', { skip: !enabled, timeout: 120_000 }, async (t) => {
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.match(url.searchParams.get('application_name') ?? '', /^apollo-video-e2e-/)
  assert.ok(Number(url.searchParams.get('connection_limit')) >= 3 && Number(url.searchParams.get('connection_limit')) <= 5)
  for (const key of ['pool_timeout', 'connect_timeout']) assert.ok(Number(url.searchParams.get(key)) > 0 && Number(url.searchParams.get(key)) <= 10)
  const { PrismaClient } = await import('../../generated/prisma-v2/index.js')
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } }), world = fixtureWorld()
  try {
    const [authority] = await client.$queryRawUnsafe("SELECT to_regprocedure('w66_assert_plan_authority(text,text,text,text,jsonb)') IS NOT NULL AS ready")
    assert.equal(authority.ready, true, 'W66 reviewed migration must exist before this suite runs')
    await transact(client, async (transaction) => {
      await insert(transaction, 'workspaces', { id: world.workspaceId, slug: `w66-${world.runId}`, name: 'W66 isolated PG contract',
        createdAt: date(world.createdAt), updatedAt: date(world.createdAt) })
      await insert(transaction, 'api_clients', { id: world.clientId, workspaceId: world.workspaceId,
        name: 'Controlled W66 DB actor', allowedEnvironmentsJson: '["sandbox"]', scopeGrantsJson: '["projects:write"]',
        createdBy: world.clientId, createdAt: date(world.createdAt), updatedAt: date(world.createdAt) })
    })
    let root, first, second, revised
    await t.test('root State/Version/CreationCommand commit atomically through initially deferred constraints', async () => {
      root = rootFixture(world, { optionalSnapshots: true })
      await transact(client, async (transaction) => { await persistBundle(transaction, root) })
      const persisted = await client.v2ProjectOutputState.findUniqueOrThrow({ where: { id: root.state.document.id } })
      assert.deepEqual(JSON.parse(persisted.stateJson), root.state.document)
      const version = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: root.version.id } })
      assert.equal(version.outputStateId, persisted.id); assert.equal(version.outputStateHash, persisted.stateHash)
      assert.equal(version.outputContractVersion, 1)
      assert.equal(version.treatmentSnapshotId, root.version.snapshotRefs.treatment)
      assert.equal(version.storySnapshotId, root.version.snapshotRefs.story)
    })
    await t.test('empty fork binds its own scoped facts and exact CreationCommand actor/time', async () => {
      const fork = rootFixture(world, { forkSource: root })
      await transact(client, (transaction) => persistBundle(transaction, fork))
      const persisted = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: fork.version.id } })
      assert.equal(persisted.forkedFromProjectId, root.projectId)
      assert.equal(persisted.forkedFromVersionId, root.version.id)
      assert.equal(persisted.createdBy, fork.creation.audit.clientId)
      assert.equal(persisted.createdAt.toISOString(), fork.creation.createdAt)
      assert.equal(persisted.treatmentSnapshotId, null)
      assert.equal(persisted.storySnapshotId, null)
      assert.equal((await client.v2ProjectOutputState.findUniqueOrThrow({ where: { id: fork.state.document.id } })).transition, 'fork-empty')
    })
    await t.test('two same-format variants preserve distinct immutable IDs and exact revisions', async () => {
      first = variantFixture(root); await transact(client, (transaction) => persistBundle(transaction, first))
      second = variantFixture(first); await transact(client, (transaction) => persistBundle(transaction, second))
      const persisted = await client.v2ProjectOutputState.findUniqueOrThrow({ where: { id: second.state.document.id } })
      const members = JSON.parse(persisted.stateJson).entries
      assert.equal(members.length, 2)
      assert.equal(members[0].spec.output.aspectRatio, members[1].spec.output.aspectRatio)
      assert.notEqual(members[0].variantId, members[1].variantId)
      assert.notEqual(members[0].outputSpecRevisionId, members[1].outputSpecRevisionId)
      assert.equal(await client.v2OutputVariant.count({ where: { projectId: root.projectId } }), 2)
    })
    await t.test('stale CAS rolls back the whole newly allocated output bundle', async () => {
      const candidate = variantFixture(second)
      await assert.rejects(transact(client, (transaction) => persistBundle(transaction, candidate, { expectedHead: root.version.id })),
        /controlled CAS rejected/)
      await assertAbsent(client, candidate)
      assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: root.projectId } })).currentVersionId, second.version.id)
    })
    await t.test('revision selects the exact base State member while retaining the sibling revision', async () => {
      revised = variantFixture(second, first.newVariants[0].id)
      await transact(client, (transaction) => persistBundle(transaction, revised))
      const members = JSON.parse((await client.v2ProjectOutputState.findUniqueOrThrow({ where: { id: revised.state.document.id } })).stateJson).entries
      assert.equal(members.find((member) => member.variantId === first.newVariants[0].id).outputSpecRevisionId, revised.newRevisions[0].id)
      assert.equal(members.find((member) => member.variantId === second.newVariants[0].id).outputSpecRevisionId, second.newRevisions[0].id)
      assert.equal(await client.v2OutputSpecRevision.count({ where: { variantId: first.newVariants[0].id } }), 2)
    })
    await t.test('create/revise preserve every non-output snapshot reference, including optional presence', async () => {
      const noOptionals = rootFixture(world)
      await transact(client, (transaction) => persistBundle(transaction, noOptionals))
      const noOptionalsChild = variantFixture(noOptionals)
      await transact(client, (transaction) => persistBundle(transaction, noOptionalsChild))
      const deny = async (candidate, base) => {
        let callbackCompleted = false
        await assert.rejects(transact(client, async (transaction) => {
          await persistBundle(transaction, candidate); callbackCompleted = true
        }), (error) => error.code === 'P2010' && error.meta?.code === '23514' &&
          /changed preserved non-output snapshot references/.test(error.message))
        assert.equal(callbackCompleted, true)
        await assertAbsent(client, candidate)
        assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: base.projectId } })).currentVersionId, base.version.id)
      }
      for (const operation of ['create', 'revise']) {
        for (const kind of ['brief', 'policies', 'treatment', 'story']) {
          const candidate = resealForSqlNegative(variantFixture(revised, operation === 'revise' ? second.newVariants[0].id : null), (bundle) => {
            const snapshotId = world.id(`replacement-${kind}`)
            bundle.version.snapshotRefs[kind] = snapshotId
            bundle.snapshots.push(snapshot(world, bundle.projectId, snapshotId, kind, { schemaVersion: 1, controlledReplacement: kind }))
          })
          await deny(candidate, revised)
        }
        for (const kind of ['treatment', 'story']) {
          const removed = resealForSqlNegative(variantFixture(revised, operation === 'revise' ? second.newVariants[0].id : null), (bundle) => {
            delete bundle.version.snapshotRefs[kind]
          })
          await deny(removed, revised)
          const base = noOptionalsChild
          const added = resealForSqlNegative(variantFixture(base, operation === 'revise' ? noOptionalsChild.newVariants[0].id : null), (bundle) => {
            const snapshotId = world.id(`added-${kind}`)
            bundle.version.snapshotRefs[kind] = snapshotId
            bundle.snapshots.push(snapshot(world, bundle.projectId, snapshotId, kind, { schemaVersion: 1, controlledAdded: kind }))
          })
          await deny(added, base)
        }
      }
    })
    await t.test('output author/time columns cannot diverge from the sealed authenticated Command', async () => {
      const changedAt = new Date(Date.parse(world.createdAt) + 1000)
      for (const operation of ['create', 'revise']) for (const scenario of [
        'version-author', 'version-state-time', 'command-actor', 'command-kind', 'command-delegation', 'command-time', 'revision-time',
        ...(operation === 'create' ? ['variant-time'] : []),
      ]) {
        const candidate = resealForSqlNegative(variantFixture(revised, operation === 'revise' ? second.newVariants[0].id : null), (bundle, body) => {
          if (scenario === 'version-author') bundle.version.createdBy = world.id('uncommanded-author')
          if (scenario === 'version-state-time') { bundle.version.createdAt = changedAt.toISOString(); body.createdAt = changedAt.toISOString() }
        })
        const delegatedAudit = scenario === 'command-delegation' ? createApiAccessAuditContext({ ...world.audit,
          authenticationKind: 'ui-session', delegatedUserId: world.id('unsealed-delegate'),
          delegatedIdentityId: world.id('unsealed-identity'), workspaceRole: 'operator' }) : null
        const options = {
          ...(scenario === 'command-actor' ? { commandOverrides: { actorId: world.id('unsealed-actor') } } : {}),
          ...(scenario === 'command-kind' ? { commandOverrides: { actorType: 'system', actorCredentialId: null,
            actorEnvironment: null, actorAuthenticationKind: null, actorContextHash: null,
            actorDelegatedIdentityId: null, actorWorkspaceRole: null, delegatedUserId: null } } : {}),
          ...(delegatedAudit ? { commandOverrides: { delegatedUserId: delegatedAudit.delegatedUserId,
            actorAuthenticationKind: delegatedAudit.authenticationKind, actorDelegatedIdentityId: delegatedAudit.delegatedIdentityId,
            actorWorkspaceRole: delegatedAudit.workspaceRole, actorContextHash: delegatedAudit.contextHash } } : {}),
          ...(scenario === 'command-time' ? { commandOverrides: { createdAt: changedAt } } : {}),
          ...(scenario === 'revision-time' ? { revisionOverrides: { createdAt: changedAt } } : {}),
          ...(scenario === 'variant-time' ? { variantOverrides: { createdAt: changedAt } } : {}),
        }
        let callbackCompleted = false
        await assert.rejects(transact(client, async (transaction) => {
          await persistBundle(transaction, candidate, options); callbackCompleted = true
        }), (error) => error.code === 'P2010' && error.meta?.code === '23514' &&
          /output Command author\/time authority mismatch/.test(error.message), `${operation}/${scenario}`)
        assert.equal(callbackCompleted, true, `${operation}/${scenario} must reach the deferred authority guard`)
        await assertAbsent(client, candidate)
        assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: revised.projectId } })).currentVersionId, revised.version.id)
      }
    })
    await t.test('root producer hashes bind actual historical brief/policies facts and CreationCommand author/time', async () => {
      for (const scenario of ['brief-claim', 'policies-claim', 'extra-producer-field', 'brief-kind', 'policies-kind', 'brief-schema', 'policies-schema',
        'brief-raw-hash', 'policies-raw-hash', 'version-author', 'version-state-time']) {
        const candidate = resealForSqlNegative(rootFixture(world), (bundle, body) => {
          const producer = body.producer.document
          if (scenario === 'brief-claim') producer.briefHash = 'f'.repeat(64)
          if (scenario === 'policies-claim') producer.policyHash = 'f'.repeat(64)
          if (scenario === 'extra-producer-field') producer.uncommanded = true
          if (scenario.endsWith('-kind') || scenario.endsWith('-raw-hash') || scenario.endsWith('-schema')) {
            const kind = scenario.startsWith('brief') ? 'brief' : 'policies'
            const fact = bundle.snapshots.find((row) => row.id === bundle.version.snapshotRefs[kind])
            if (scenario.endsWith('-kind')) fact.kind = kind === 'brief' ? 'policies' : 'brief'
            else if (scenario.endsWith('-schema')) {
              fact.schemaVersion = 2
              const document = { ...JSON.parse(fact.contentJson), schemaVersion: 2 }
              fact.contentJson = stableSerialize(document); fact.contentHash = calculateCanonicalHash(document)
              producer[kind === 'brief' ? 'briefHash' : 'policyHash'] = fact.contentHash
            }
            else {
              fact.contentHash = 'f'.repeat(64)
              producer[kind === 'brief' ? 'briefHash' : 'policyHash'] = fact.contentHash
            }
          }
          if (scenario === 'version-author') bundle.version.createdBy = world.id('uncommanded-root-author')
          if (scenario === 'version-state-time') {
            const changedAt = new Date(Date.parse(world.createdAt) + 1000).toISOString()
            bundle.version.createdAt = changedAt; body.createdAt = changedAt
          }
          body.producer.hash = calculateOutputCanonicalHash(producer)
        })
        const guard = scenario.endsWith('-kind') || scenario.endsWith('-raw-hash') || scenario.endsWith('-schema')
          ? /non-output snapshot kind\/scope\/historical digest mismatch/
          : scenario.startsWith('version-') ? /root Version author\/time differs/ : /root producer differs from actual brief\/policies facts/
        let callbackCompleted = false
        await assert.rejects(transact(client, async (transaction) => {
          await persistBundle(transaction, candidate); callbackCompleted = true
        }), (error) => error.code === 'P2010' && error.meta?.code === '23514' && guard.test(error.message), scenario)
        assert.equal(callbackCompleted, true)
        await assertAbsent(client, candidate)
      }
    })
    await t.test('deferred provenance, authority and scoped binding negatives roll back at the database', async () => {
      const cases = [
        ['missing-creation', null, { skipCreation: true }, /W66 creation Command provenance mismatch/, true],
        ['orphan-state', null, { skipVersion: true, skipCreation: true }, /query returned no rows|W66 state has no exact consuming Version/, true],
        ['missing-state', null, { skipState: true }, /Foreign key|foreign key/, false],
        ['version-state-hash', null, { versionOverrides: { outputStateHash: 'a'.repeat(64) } }, /Foreign key|foreign key/, false],
        ['version-base-hash', null, { versionOverrides: { baseHash: 'a'.repeat(64) } }, /project_versions_output_contract_check/, false],
        ['version-date', null, { versionOverrides: { createdAt: new Date(Date.parse(world.createdAt) + 1000) } }, /state has no exact consuming Version/, true],
        ['version-false-base-dependencies', (b, body) => {
          b.outputBaseHashDocumentOverride = { ...outputBoundVersionHashBody({ workspaceId: body.workspaceId, projectId: body.projectId,
            resultVersionId: body.resultVersionId, parentVersionId: null, previousBaseHash: null,
            producerHash: body.producer.hash, outputStateId: body.id, outputStateHash: b.state.stateHash }), producerHash: 'f'.repeat(64) }
        }, {}, /Version base-hash authority dependencies mismatch/, true],
        ['contract-zero-new-insert', null, { versionOverrides: { outputContractVersion: 0, outputStateId: null, outputStateHash: null } }, /contract 0 is migration audit history only/, false],
        ['scope', (_b, body) => { body.projectId = root.projectId }, {}, /Foreign key|foreign key/, false],
        ['old-hash', (_b, body) => { body.editPlan.hash = 'b'.repeat(64) }, {}, /Foreign key|foreign key|snapshot seal mismatch/, true],
        ['missing-version-id', (b, body) => changeLegacyPlan(b, body, (plan) => { delete plan.projectVersionId }), {}, /EditPlan snapshot seal mismatch/, true],
        ['sister-version-id', (b, body) => changeLegacyPlan(b, body, (plan) => { plan.projectVersionId = root.version.id }), {}, /EditPlan snapshot seal mismatch/, true],
        ['authority-kind', (_b, body) => { body.editPlan.authority.document.kind = 'renderable-edit-plan'; body.editPlan.authority.hash = calculateOutputCanonicalHash(body.editPlan.authority.document) }, {}, /plan authority policy\/kind\/document mismatch/, true],
        ['authority-policy', (_b, body) => { delete body.editPlan.authority.document.canonicalPolicyVersion; body.editPlan.authority.hash = calculateOutputCanonicalHash(body.editPlan.authority.document) }, {}, /plan authority policy\/kind\/document mismatch/, true],
        ['authority-text', (_b, body) => { body.editPlan.authority.document.legacyCanonicalJson += '\n'; body.editPlan.authority.hash = calculateOutputCanonicalHash(body.editPlan.authority.document) }, {}, /historical plan authority digest\/body mismatch/, true],
        ['nonempty-bootstrap', (b, body) => changeLegacyPlan(b, body, (plan) => { plan.durationFrames = 1 }), {}, /empty bootstrap\/fork contract mismatch/, true],
        ['nullable-edit-authority', null, { stateOverrides: { editPlanAuthorityJson: null } },
          (error) => error.code === 'P2010' && error.meta?.code === '23502', false],
        ['partial-renderable-authority', null, { stateOverrides: { renderablePlanAuthorityHash: 'a'.repeat(64) } }, /constraint|Constraint/, false],
      ]
      for (const [name, mutate, options, expected, deferred] of cases) {
        const valid = rootFixture(world), candidate = mutate ? resealForSqlNegative(valid, mutate) : valid
        if (candidate.outputBaseHashDocumentOverride) candidate.version.baseHash = calculateOutputCanonicalHash(candidate.outputBaseHashDocumentOverride)
        let callbackCompleted = false
        let stateInsertFailure
        const nullableAuthority = name === 'nullable-edit-authority'
        const persistenceOptions = nullableAuthority
          ? { ...options, onStateInsertFailure: (error) => { stateInsertFailure = error } } : options
        await assert.rejects(transact(client, async (transaction) => {
          await persistBundle(transaction, candidate, persistenceOptions); callbackCompleted = true
        }), nullableAuthority ? (error) => error === stateInsertFailure && expected(error) : expected, name)
        if (nullableAuthority) assert.equal(callbackCompleted, false, `${name} must fail at its State INSERT before later bundle writes`)
        if (deferred) assert.equal(callbackCompleted, true, `${name} must exercise the deferred database guard`)
        await assertAbsent(client, candidate)
      }
    })
    await t.test('create and revise cannot remove or rewrite siblings, plans, overlays or issues after complete resealing', async () => {
      const siblingId = first.newVariants[0].id, reviseTarget = second.newVariants[0].id
      const originalSibling = first.state.document.entries.find((member) => member.variantId === siblingId)
      const originalCommand = first.command.command
      const provenance = { kind: 'edit-command', id: originalCommand.id, hash: originalCommand.commandHash }
      const seal = (document) => ({ schemaVersion: document.schemaVersion, document, hash: calculateOutputCanonicalHash(document) })
      for (const operation of ['create', 'revise']) for (const scenario of [
        'remove-sibling', 'restore-old-sibling', 'plan-semantics', 'add-sibling-overlay', 'add-sibling-issue',
      ]) {
        const valid = variantFixture(revised, operation === 'revise' ? reviseTarget : null)
        const candidate = resealForSqlNegative(valid, (bundle, body) => {
          if (scenario === 'remove-sibling') body.entries = body.entries.filter((member) => member.variantId !== siblingId)
          if (scenario === 'restore-old-sibling') body.entries = body.entries.map((member) =>
            member.variantId === siblingId ? clone(originalSibling) : member)
          if (scenario === 'plan-semantics') changeLegacyPlan(bundle, body, (plan) => {
            plan.markers = ['Controlled uncommanded plan change']
          })
          if (scenario === 'add-sibling-overlay' || scenario === 'add-sibling-issue') {
            const overlayId = scenario === 'add-sibling-overlay' ? world.id('negative-overlay') : null
            if (overlayId) body.overlays.push({ ...policy, id: overlayId, variantId: siblingId, kind: 'crop',
              clipId: world.id('negative-clip'), startFrame: 0, endFrame: 1, status: 'invalidated', provenance,
              dependencyHash: 'a'.repeat(64), document: seal({ ...policy, schemaVersion: 'project-output-crop/v1',
                authority: 'editorial-preference', crop: { x: .1, y: .1, width: .8, height: .8 } }) })
            body.invalidations.push({ ...policy, id: world.id('negative-issue'), variantId: siblingId,
              overlayId, kind: overlayId ? 'crop' : 'render', reasonCode: 'CONTROLLED_SCOPE_CHANGE',
              previousDependencyHash: 'a'.repeat(64), nextDependencyHash: 'b'.repeat(64), provenance,
              document: seal({ ...policy, schemaVersion: 'output-invalidation/v1', reasonCode: 'CONTROLLED_SCOPE_CHANGE' }) })
          }
        })
        // All allocated revisions/Commands and their typed origin remain valid;
        // mutation is confined to a separately sealed sibling/plan/overlay effect.
        assert.equal(candidate.state.document.entries.find((member) => member.variantId === candidate.newRevisions[0].variantId)
          .outputSpecRevisionId, candidate.newRevisions[0].id)
        assert.equal(candidate.state.stateHash, calculateOutputCanonicalHash(candidate.state.document))
        assert.equal(candidate.state.document.producer.hash, calculateOutputCanonicalHash(candidate.state.document.producer.document))
        const expected = scenario.includes('sibling') && !scenario.includes('overlay') && !scenario.includes('issue')
          ? /W66 output Command changed a non-target State member/
          : scenario === 'plan-semantics' ? /W66 output Command changed plan semantics or Renderable presence/
            : /W66 output Command changed preserved overlays or invalidations/
        let writesCompleted = false
        await assert.rejects(transact(client, async (transaction) => {
          await persistBundle(transaction, candidate); writesCompleted = true
          await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
        }), (error) => error.code === 'P2010' && error.meta?.code === '23514' &&
          expected.test(String(error.meta?.message ?? error.message)), `${operation}: ${scenario}`)
        assert.equal(writesCompleted, true, `${operation}: ${scenario} must reach the actual deferred SQL guard`)
        await assertAbsent(client, candidate)
        assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: root.projectId } })).currentVersionId, revised.version.id)
      }
    })
    await t.test('SQL member preservation ignores entry-array permutation while retaining every sibling', async () => {
      const candidate = resealForSqlNegative(variantFixture(revised), (_bundle, body) => { body.entries.reverse() })
      const rollback = Object.assign(new Error('Controlled order-only rollback'), { code: 'W66_CONTROLLED_ROLLBACK' })
      let constraintsPassed = false
      await assert.rejects(transact(client, async (transaction) => {
        await persistBundle(transaction, candidate)
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
        constraintsPassed = true
        throw rollback
      }), (error) => error === rollback)
      assert.equal(constraintsPassed, true, 'actual SQL guards must admit order-only member permutation')
      await assertAbsent(client, candidate)
      assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: root.projectId } })).currentVersionId, revised.version.id)
    })
    await t.test('fully sealed wrong-kind, inherit, payload and nonmember predecessor forgeries fail at deferred origin validation', async () => {
      for (const scenario of ['manual-edit', 'inherit', 'scope', 'revision-payload', 'producer-payload', 'nonmember-predecessor']) {
        const valid = variantFixture(revised, scenario === 'nonmember-predecessor' ? first.newVariants[0].id : null)
        const candidate = resealForSqlNegative(valid, (bundle, body) => {
          if (scenario === 'inherit') body.transition = 'inherit'
          else if (scenario === 'producer-payload') {
            body.producer.document.payloadHash = 'e'.repeat(64)
            body.producer.hash = calculateOutputCanonicalHash(body.producer.document)
          } else changeOutputCommand(bundle, body, (command) => {
            if (scenario === 'manual-edit') command.type = 'manual-edit'
            if (scenario === 'scope') command.scope = { project: true }
            if (scenario === 'revision-payload') command.payload.revision.output.width = 720
            if (scenario === 'nonmember-predecessor') {
              // Revision2 exists globally, but base first still references only
              // Revision1. Rebind every lineage/hash without changing that fact.
              command.baseVersionId = first.version.id; command.baseHash = first.version.baseHash
              body.parentVersionId = first.version.id; body.parentStateId = first.state.document.id
              body.parentStateHash = first.state.stateHash; bundle.version.parentVersionId = first.version.id
              bundle.base = first
            }
          })
        })
        let callbackCompleted = false
        await assert.rejects(transact(client, async (transaction) => {
          await persistBundle(transaction, candidate, { expectedHead: revised.version.id }); callbackCompleted = true
        }), scenario === 'nonmember-predecessor' ? /predecessor is not a member of the exact base State/
          : /output revision Command type\/scope\/payload mismatch|output revision has no exact typed origin State|output transition Command mismatch/, scenario)
        assert.equal(callbackCompleted, true, `${scenario} must fail at the deferred database origin guard`)
        await assertAbsent(client, candidate)
      }
      const candidate = variantFixture(revised)
      await assert.rejects(transact(client, (transaction) => persistBundle(transaction, candidate,
        { commandOverrides: { outputPayloadJson: null, outputPayloadHash: null } })), /edit_commands_output_payload_seal_check/)
      await assertAbsent(client, candidate)
      const noRevision = resealForSqlNegative(variantFixture(revised), (bundle, body) => {
        body.entries = clone(revised.state.document.entries)
        bundle.newVariants = []; bundle.newRevisions = []
      })
      let callbackCompleted = false
      await assert.rejects(transact(client, async (transaction) => {
        await persistBundle(transaction, noRevision); callbackCompleted = true
      }), /output transition must consume exactly its Command revision/)
      assert.equal(callbackCompleted, true, 'reusing only existing revisions must still reach the deferred State guard')
      await assertAbsent(client, noRevision)
    })
    await t.test('fully rehashed same-format siblings cannot hide unmaterialized geometry beside a verified video entry', async () => {
      const valid = variantFixture(revised)
      const candidate = resealForSqlNegative(valid, (bundle, body) => {
        changeLegacyPlan(bundle, body, (plan) => {
          plan.durationFrames = 30
          plan.videoTracks = [{ id: world.id('negative-video-track'), kind: 'base-video', clips: [{
            id: world.id('negative-video-clip'), sourceArtifactId: world.id('negative-source'), rate: 1,
            sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30 }] }]
        })
        const retained = body.entries.find((member) => member.variantId === first.newVariants[0].id)
        retained.geometry = controlledVideoGeometry(world, retained, bundle.plan)
        body.entries = [retained, body.entries.find((member) => member.variantId === bundle.newVariants[0].id)]
        assert.equal(body.entries.length, 2)
        assert.equal(body.entries[0].spec.output.aspectRatio, body.entries[1].spec.output.aspectRatio)
      })
      let callbackCompleted = false
      await assert.rejects(transact(client, async (transaction) => {
        await persistBundle(transaction, candidate); callbackCompleted = true
      }), /unmaterialized output has geometry\/active overlay/)
      assert.equal(callbackCompleted, true)
      await assertAbsent(client, candidate)
    })
    await t.test('append-only State/Version/spec/variant/Command and snapshot reject actual UPDATE/DELETE', async () => {
      for (const [table, id] of [['project_output_states', second.state.document.id], ['project_versions', second.version.id],
        ['output_spec_revisions', second.newRevisions[0].id], ['output_variants', second.newVariants[0].id],
        ['edit_commands', second.command.command.id], ['project_creation_commands', root.creation.id],
        ['project_snapshots', second.state.document.editPlan.snapshotId]]) {
        for (const statement of [`UPDATE "${table}" SET "id"="id" WHERE "id"=$1`, `DELETE FROM "${table}" WHERE "id"=$1`]) {
          await assert.rejects(transact(client, (transaction) => transaction.$executeRawUnsafe(statement, id)), /W66 immutable/)
        }
      }
      assert.equal((await client.v2ProjectOutputState.findUniqueOrThrow({ where: { id: second.state.document.id } })).stateHash, second.state.stateHash)
    })
    await t.test('snapshot seal survives dependency-first and State-first real lock ordering', async () => {
      const afterDependencyFirst = await snapshotLockRace(client, revised, 'dependency-first')
      await snapshotLockRace(client, afterDependencyFirst, 'state-first')
    })
    // Additional scoped ingest/lifecycle and historical-upgrade gates are kept
    // explicit below as prerequisites; no passing snapshot race claims them.
    t.diagnostic(JSON.stringify({ scope: 'controlled-database-contract', runId: world.runId,
      workspaceId: world.workspaceId, retainedAppendOnlyFixtures: true,
      historicalUpgradePrerequisite: 'pre-migration contract-0 fixture supplied by owner',
      pending: ['ingest scoped seal/lifecycle races', 'historical upgrade fixture'] }))
  } finally {
    await bounded(() => client.$disconnect(), 5000, 'W66 client disconnect')
  }
})
