import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createPublicEvent } from '../../src/v2/domain/public-event.ts'
import { calculateCanonicalHash,stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createProjectCreationCommand,createProjectCreationOutputCommandV2,normalizeProjectCreationIntentV2 } from '../../src/v2/domain/project-creation-command.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { createOutputSpecRevisionBody,createOutputVariant } from '../../src/v2/domain/output-spec-revision.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { createProjectOutputState,createOutputPlanAuthority,calculateOutputBoundVersionHash,outputBoundVersionHashBody } from '../../src/v2/domain/project-output-state.ts'
import { calculateOutputCanonicalHash,serializeOutputCanonicalJson,OUTPUT_CANONICAL_POLICY_VERSION } from '../../src/v2/domain/output-canonical-policy.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { assembleDirectedEditPlan } from '../../src/v2/application/renderable-edit-plan.ts'
import { validateDirectedEditPlan,createDirectedAudioTimelineHash } from '../../src/v2/domain/director-run.ts'
import { calculateRenderablePlanHash } from '../../src/v2/domain/renderable-plan-authority.ts'
import { createProjectForkDerivation,createProjectForkDerivationV2,forkOwnedIdentities,materializeForkEditPlanV2,buildForkRenderablePlanCandidateV2,PROJECT_FORK_COMPILE_POLICY_VERSION } from '../../src/v2/domain/project-fork-derivation.ts'
import { buildCreationOutputVersionBundleV2 } from '../../src/v2/domain/output-version-bundle.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { setAssetRightsService } from '../../src/v2/application/set-asset-rights.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { PrismaCreationOutputBundleRepositoryV2 } from '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
import { requirePersistedOutputConsumptionV2 } from '../../src/v2/infrastructure/prisma/output-state-consumption.ts'

// Full-bundle SQL/adapter contract only. Metadata-controlled source rows are not
// physical source normalization, rendering, critic approval or product cutover.
// Owner migrates/generates the dedicated database; append-only committed rows
// remain until owner reset after both clients and their backends are terminal.
const enabled=process.env.APOLLO_RUN_W66_CREATION_BUNDLE_PG==='1'
const policy={canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION}
const encode=serializeOutputCanonicalJson,date=(v)=>new Date(v),clone=(v)=>JSON.parse(JSON.stringify(v))
const transactionOptions={maxWait:3000,timeout:12000}
const tables=new Set(['projects','project_snapshots','project_versions','project_creation_commands','project_output_states','project_output_state_entries',
 'project_output_state_overlays','project_output_state_invalidations','output_variants','output_spec_revisions','edit_commands','renderable_plan_snapshots','media_artifacts','media_artifact_manifests','project_media_assets'])
async function insert(transaction, table, data) {
  assert.ok(tables.has(table))
  const columns = Object.keys(data)
  assert.ok(columns.every((column) => /^[A-Za-z][A-Za-z0-9]*$/.test(column)))
  return transaction.$executeRawUnsafe(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
    ...Object.values(data))
}

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
  const id = (kind) => `w66full-${runId}-${kind}-${++counter}`
  const workspaceId = id('workspace'), clientId = id('actor')
  const audit = createApiAccessAuditContext({ workspaceId, clientId, credentialId: id('credential'),
    environment: 'sandbox', authenticationKind: 'bearer' })
  return { runId, createdAt, id, workspaceId, clientId, audit }
}

function rootFixture(world, { optionalSnapshots = false, forkSource = null } = {}) {
  const projectId = world.id('project'), versionId = world.id('version'), snapshotId = world.id('edit-plan-snapshot')
  const plan = { schemaVersion:2,state:'uncompiled',id:world.id('edit-plan'),projectVersionId:versionId,fps:30,durationFrames:0,sources:[],videoTracks:[],subtitleTracks:[],audioTracks:[],overlayTracks:[],effectTracks:[],createdAt:world.createdAt }
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
  return createProjectVersion({ ...policy, id: body.resultVersionId, workspaceId: body.workspaceId, projectId: body.projectId,
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
  return { id, workspaceId: world.workspaceId, projectId, kind, schemaVersion: Number(document.schemaVersion ?? 1),
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
    name:'Controlled W66 PostgreSQL contract',status:'draft',objective:'discovery',format:'9:16',locale:'pt-BR',createdByType: 'api-client', createdById: world.clientId,
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

async function metadataMedia(client,world,kind) {
  const artifactId=world.id('artifact-'+kind),manifestId=world.id('manifest-'+kind),linkId=randomUUID(),mediaType=kind==='master'?'video':'audio',sha256=kind==='master'?'a'.repeat(64):'b'.repeat(64)
  const manifest=createMediaArtifactManifestV2({artifactKey:'w66-full/'+world.runId+'/'+kind+(mediaType==='video'?'.mp4':'.wav'),artifactSha256:sha256,
    byteSize:1000,mediaType,container:mediaType==='video'?'mp4':'wav',recipe:{id:'controlled-metadata-source',version:'1',parameters:{evidenceScope:'metadata-only-no-physical-render'}},sources:[]})
  await client.v2MediaArtifact.create({data:{id:artifactId,workspaceId:world.workspaceId,artifactKey:manifest.artifact.artifactKey,sha256,byteSize:1000n,mediaType,container:manifest.artifact.container,status:'available',createdAt:date(world.createdAt)}})
  await client.v2MediaArtifactManifest.create({data:{id:manifestId,workspaceId:world.workspaceId,artifactId,schemaVersion:manifest.schemaVersion,
    manifestHash:manifest.manifestHash,recipeId:manifest.recipe.id,recipeVersion:manifest.recipe.version,parametersHash:manifest.recipe.parametersHash,manifestJson:JSON.stringify(manifest),createdAt:date(world.createdAt)}})
  const rightsRepo=new PrismaAssetRightsRepository(client),setRights=setAssetRightsService({repository:rightsRepo,clock:()=>new Date(),createId:()=>world.id('rights')})
  const current=await rightsRepo.findCurrent(world.workspaceId,artifactId)
  const granted=await setRights({workspaceId:world.workspaceId,artifactId,baseRevision:current.revision,actor:{type:'api-client',id:world.clientId},
    draft:{owner:'Controlled W66 fixture',license:'Synthetic fixture metadata only',status:'approved',allowedUses:['editing'],prohibitedUses:[],consent:{status:'not-required',allowedUses:[]}}})
  return {artifactId,manifestId,linkId,manifest,rightsSnapshotId:granted.snapshot.id,rightsRepo,setRights}
}
function contentFixture(base,master,music) {
  const {world,projectId}=base,versionId=world.id('content-version'),snapshotId=world.id('content-snapshot'),clipId=world.id('clip'),sourceId=world.id('reference'),trackId=world.id('track')
  const clip={id:clipId,sourceArtifactId:master.artifactId,sourceId,sourceInFrame:0,sourceOutFrame:30,timelineInFrame:0,timelineOutFrame:30,rate:1,
    audioSourceArtifactId:music.artifactId,audioSourceInFrame:0,audioSourceOutFrame:30}
  const plan={...base.plan,id:world.id('edit-plan'),projectVersionId:versionId,state:'compiled',durationFrames:30,sources:[{id:sourceId,artifactId:master.artifactId,kind:'video',durationSeconds:1},{id:world.id('speech-reference'),artifactId:music.artifactId,kind:'audio',durationSeconds:1}],
    videoTracks:[{id:trackId,kind:'base-video',clips:[clip]}],subtitleTracks:[{id:world.id('caption-track'),kind:'captions',cues:[{id:world.id('cue'),clipId,startFrame:0,endFrame:30,text:'Controlled caption'}]}],
    markers:[{id:world.id('marker'),clipId,atFrame:10}]}
  const crop={x:.1,y:.1,width:.8,height:.8}
  const edit=createEditCommand({id:world.id('crop-command'),workspaceId:world.workspaceId,projectId,baseVersionId:base.version.id,baseHash:base.version.baseHash,
    author:{type:'api-client',id:world.clientId},type:'manual-edit',scope:{clipIds:[clipId],outputVariantIds:[base.state.document.entries[0].variantId]},
    payload:{schemaVersion:2,action:'apply',operation:{kind:'crop',clipId,crop}},idempotencyKey:world.id('crop-key'),createdAt:world.createdAt})
  const provenance={kind:'edit-command',id:edit.id,hash:edit.commandHash},member=clone(base.state.document.entries[0]),identity={sourceArtifactId:master.artifactId,
    sourceManifestId:master.manifestId,sourceManifestHash:master.manifest.manifestHash,sourceSha256:master.manifest.artifact.sha256}
  const seal=(document)=>({schemaVersion:document.schemaVersion,document,hash:calculateOutputCanonicalHash(document)})
  const probe=seal({...policy,schemaVersion:'observed-video-probe/v1',...identity,width:1920,height:1080,fps:30,durationFrames:30,timebase:{numerator:1,denominator:15360},
    orientation:{rotationDegrees:0,displayTransform:[1,0,0,0,1,0,0,0,1]}})
  const origin={origin:'react-playback',id:world.id('playback'),hash:'c'.repeat(64),version:1}
  const assembled=assembleDirectedEditPlan({planId:world.id('renderable'),projectVersionId:versionId,derivedFrom:origin,
    objective:'discovery',fps:30,sources:plan.sources,clips:[clip],seams:[],markers:[],lineageRefs:[master.artifactId],assumptions:['Metadata-controlled compiler fixture; no Director acceptance or physical MP4'],createdAt:world.createdAt})
  const musicTracks=[{id:world.id('music-track'),kind:'background-music',artifactId:music.artifactId,analysisId:world.id('analysis'),analysisHash:'d'.repeat(64),rightsSnapshotId:music.rightsSnapshotId,
    sourceInFrame:0,sourceOutFrame:30,timelineInFrame:0,timelineOutFrame:30,gainDb:-24,fadeInFrames:0,fadeOutFrames:0}]
  const renderable=validateDirectedEditPlan({...assembled,audioTracks:musicTracks,audioTimelineHash:createDirectedAudioTimelineHash({fps:30,clips:assembled.videoTracks[0].clips,musicTracks}),
    subtitleTracks:[{id:world.id('compiled-caption-track'),kind:'captions',presetId:'clean-color',anchor:'bottom',faceProtection:true,maxLines:2,maxCharactersPerBlock:32,desiredActionRef:assembled.desiredActionRef,
      cues:[{id:world.id('compiled-cue'),startFrame:0,endFrame:30,clipId,text:'Controlled caption',anchor:'bottom',wordIds:[],desiredActionRef:assembled.desiredActionRef}]}],formatVariantRefs:[member.variantId]})
  const renderableRow={id:world.id('renderable-snapshot'),workspaceId:world.workspaceId,projectId,projectVersionId:versionId,planId:renderable.id,
    origin:'react-playback',sourceId:origin.id,sourceHash:origin.hash,sourceVersion:origin.version,
    fps:30,durationFrames:30,clipCount:1,planJson:JSON.stringify(renderable),planHash:calculateRenderablePlanHash(renderable),createdAt:world.createdAt}
  const projection={...policy,schemaVersion:'variant-reframe-geometry/v1',variantId:member.variantId,
    output:{aspectRatio:member.spec.output.aspectRatio,width:1080,height:1920,fps:30,proxyToFinal:member.spec.profile.proxyToFinal},timeline:{fps:30,durationFrames:30,trackId:renderable.videoTracks[0].id},
    clips:[{...clip,...identity,probe,normalization:seal({...policy,schemaVersion:'observed-normalization/v1',...identity,mode:'verified-source',probeHash:probe.hash})}],
    composition:{foregroundScale:{present:true,value:1},verticalPosition:{present:true,value:.5}},globalCropPresent:false}
  member.geometry={status:'verified',projection,projectionHash:calculateOutputCanonicalHash(projection)}
  const producerDocument={...policy,schemaVersion:'controlled-source-command/v1',commandId:edit.id,commandHash:edit.commandHash}
  const state=createProjectOutputState({...policy,id:world.id('content-state'),projectId,workspaceId:world.workspaceId,resultVersionId:versionId,
    parentVersionId:base.version.id,parentStateId:base.state.document.id,parentStateHash:base.state.stateHash,transition:'set-overlay',provenance,
    producer:{document:producerDocument,hash:calculateOutputCanonicalHash(producerDocument)},editPlan:{snapshotId,hash:calculateCanonicalHash(plan),authority:createOutputPlanAuthority({...policy,kind:'project-edit-plan',planDocument:plan})},
    renderablePlan:{snapshotId:renderableRow.id,planId:renderable.id,hash:renderableRow.planHash,authority:createOutputPlanAuthority({...policy,kind:'renderable-edit-plan',planDocument:renderable})},entries:[member],
    overlays:[{...policy,id:world.id('crop-overlay'),variantId:member.variantId,kind:'crop',clipId,startFrame:0,endFrame:30,status:'active',provenance,dependencyHash:member.geometry.projectionHash,
      document:seal({...policy,schemaVersion:'project-output-crop/v1',authority:'editorial-preference',crop})}],invalidations:[],createdAt:world.createdAt},{editPlanDocument:plan,renderablePlanDocument:renderable})
  const version=versionFor(world,state,{sequence:base.version.sequence+1,briefId:base.version.snapshotRefs.brief,policiesId:base.version.snapshotRefs.policies,parentVersionId:base.version.id,
    previousBaseHash:base.version.baseHash,commandId:edit.id})
  const editRow=snapshot(world,projectId,snapshotId,'edit-plan',plan)
  editRow.createdAt=new Date(Date.parse(world.createdAt)-1000)
  return {world,projectId,state,version,plan,creation:null,command:{command:edit,audit:world.audit,requestFingerprint:calculateCanonicalHash(edit)},newVariants:[],newRevisions:[],snapshots:[editRow],base,renderable,renderableRow}
}
function operationalEmpty(world,suffix='root') {
  const projectId=world.id(suffix+'-project'),versionId=world.id(suffix+'-version'),createdAt=world.createdAt,callerIntent=normalizeProjectCreationIntentV2({schemaVersion:'project-creation-intent/v2',kind:'initialize-empty',
    name:'Explicit controlled empty root',objective:'discovery',locale:'pt-BR',briefing:null,desiredAction:{}})
  const documents=[['brief',{schemaVersion:1,objective:callerIntent.objective,desiredAction:callerIntent.desiredAction,productionBrief:createProductionBrief({}),createdAt}],
    ['policies',{schemaVersion:1,workspaceId:world.workspaceId,state:'unconfigured',brandKitMode:'inherit',guardrails:[],createdAt}],
    ['edit-plan',{schemaVersion:2,state:'uncompiled',id:world.id('plan'),projectVersionId:versionId,fps:30,durationFrames:0,sources:[],videoTracks:[],subtitleTracks:[],audioTracks:[],overlayTracks:[],effectTracks:[],createdAt}]]
  const snapshots=documents.map(([kind,document])=>({schemaVersion:1,id:world.id('snapshot-'+kind),workspaceId:world.workspaceId,projectId,kind,contentSchemaVersion:document.schemaVersion,
    contentJson:stableSerialize(document),contentHash:calculateCanonicalHash(document),createdAt}))
  return createProjectCreationOutputCommandV2({...policy,id:world.id('creation'),workspaceId:world.workspaceId,projectId,versionId,audit:world.audit,createdAt,
    payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent,allocations:{stateId:world.id('state'),snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:null},snapshots,forkDerivation:null,renderableCandidate:null}})
}
async function forkCommand(client,source,sourceRoot,media) {
  const world=source.world,projectId=world.id('fork-project'),versionId=world.id('fork-version'),stateId=world.id('fork-state'),commandId=world.id('fork-command'),createdAt=world.createdAt
  const snapshotFact=(r)=>({schemaVersion:1,id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,kind:r.kind,contentSchemaVersion:r.schemaVersion,contentJson:r.contentJson,contentHash:r.contentHash,createdAt:new Date(r.createdAt).toISOString()})
  const nonOutputSnapshotFacts={brief:snapshotFact(sourceRoot.snapshots.find(s=>s.kind==='brief')),policies:snapshotFact(sourceRoot.snapshots.find(s=>s.kind==='policies')),treatment:null,story:null}
  const outputBaseHashJson=encode(outputBoundVersionHashBody({workspaceId:world.workspaceId,projectId:source.projectId,resultVersionId:source.version.id,parentVersionId:source.version.parentVersionId,
    previousBaseHash:source.base.version.baseHash,producerHash:source.state.document.producer.hash,outputStateId:source.state.document.id,outputStateHash:source.state.stateHash}))
  const bundle={version:source.version,state:source.state,facts:{editPlanDocument:source.plan,renderablePlanDocument:source.renderable},nonOutputSnapshotFacts,previousBaseHash:source.base.version.baseHash,editCommandSeal:null,outputBaseHashJson}
  const target={commandId,workspaceId:world.workspaceId,projectId,resultVersionId:versionId,stateId,parentVersionId:null,sequence:1,createdBy:world.clientId,createdAt}
  const identityMap=forkOwnedIdentities(bundle,source.renderableRow).map(({kind,id})=>({kind,sourceId:id,targetId:kind==='version'?versionId:kind==='state'?stateId:world.id('copy-'+kind)})),mapped=(kind,id)=>identityMap.find(x=>x.kind===kind&&x.sourceId===id).targetId
  const cropDecisions=source.state.document.overlays.map(o=>({sourceOverlayId:o.id,sourceOverlayHash:calculateOutputCanonicalHash(o),newOverlayId:mapped('overlay',o.id),newVariantId:mapped('variant',o.variantId),newClipId:mapped('clip',o.clipId),
    copiedDocument:o.document,author:{type:'api-client',id:world.clientId},createdAt,geometryStatus:'requires-target-materialization'}))
  const callerIntent=normalizeProjectCreationIntentV2({schemaVersion:'project-creation-intent/v2',kind:'fork-with-content',name:'Full content copy, no acceptance inherited'})
  const kernel=createProjectForkDerivation({...policy,schemaVersion:'project-fork-derivation/v1',id:world.id('derivation'),callerIntent,audit:world.audit,target,source:bundle,
    sourceRenderablePlanSnapshot:source.renderableRow,identityMap,cropDecisions,compilePolicyVersion:PROJECT_FORK_COMPILE_POLICY_VERSION})
  const sourceProject=await client.v2Project.findUniqueOrThrow({where:{id:source.projectId}})
  const sourceReferences=media.map((m,index)=>({sourceLinkId:m.linkId,targetLinkId:randomUUID(),workspaceId:world.workspaceId,sourceProjectId:source.projectId,artifactId:m.artifactId,
    role:index?'source-audio':'source-master',originalFileName:index?'controlled-music.wav':'controlled-source.mp4',sourceLinkCreatedAt:world.createdAt,artifactSha256:m.manifest.artifact.sha256,
    artifactKey:m.manifest.artifact.artifactKey,artifactByteSize:'1000',artifactMediaType:m.manifest.artifact.mediaType,artifactContainer:m.manifest.artifact.container,artifactLifecycleRevision:1,purpose:'editing',
    manifestFacts:{id:m.manifestId,workspaceId:world.workspaceId,artifactId:m.artifactId,schemaVersion:m.manifest.schemaVersion,manifestJson:JSON.stringify(m.manifest),manifestHash:m.manifest.manifestHash,createdAt:world.createdAt,recipeId:m.manifest.recipe.id,recipeVersion:m.manifest.recipe.version,parametersHash:m.manifest.recipe.parametersHash,recipeParametersRef:null,renderInputRef:null,renderInputHash:null,recipeParameters:null,renderInput:null}}))
  const derivation=createProjectForkDerivationV2({...policy,schemaVersion:'project-fork-derivation/v2',id:kernel.document.id,kernel,kernelCanonicalJson:serializeOutputCanonicalJson(kernel.document),sourceEditPlanSnapshot:snapshotFact(source.snapshots[0]),sourceReferences,
    sourceProject:{id:sourceProject.id,workspaceId:sourceProject.workspaceId,currentVersionId:sourceProject.currentVersionId,name:sourceProject.name,status:sourceProject.status,format:sourceProject.format,ownerId:sourceProject.ownerId,
      administrationRevision:sourceProject.administrationRevision,updatedAt:sourceProject.updatedAt.toISOString(),objective:sourceProject.objective,locale:sourceProject.locale,createdByType:sourceProject.createdByType,createdById:sourceProject.createdById,createdAt:sourceProject.createdAt.toISOString()}})
  const edit=materializeForkEditPlanV2(derivation),snapshots=[nonOutputSnapshotFacts.brief,nonOutputSnapshotFacts.policies,derivation.document.sourceEditPlanSnapshot].map(r=>{
    const document=r.kind==='edit-plan'?edit:JSON.parse(r.contentJson)
    return {schemaVersion:1,id:mapped('snapshot',r.id),workspaceId:world.workspaceId,projectId,kind:r.kind,contentSchemaVersion:r.contentSchemaVersion,contentJson:stableSerialize(document),contentHash:calculateCanonicalHash(document),createdAt}
  }),candidate=buildForkRenderablePlanCandidateV2(derivation)
  return createProjectCreationOutputCommandV2({...policy,id:commandId,workspaceId:world.workspaceId,projectId,versionId,audit:world.audit,createdAt,
    payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent,allocations:{stateId,snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:candidate.id},
      snapshots,forkDerivation:derivation,renderableCandidate:candidate}})
}

const allocation=(world,proposal)=>({proposal,idempotencyKey:world.id('request'),idempotencyRecordId:world.id('idem'),eventIds:[randomUUID(),randomUUID()],
 recompose:(facts)=>{if(proposal.payload.forkDerivation)assert.equal(facts.bundle.version.baseHash,proposal.payload.forkDerivation.document.kernel.document.source.version.baseHash);else assert.equal(facts,null);return proposal}})
function operationalRequestBody(c) {
 const d=c.payload.forkDerivation?.document,k=d?.kernel.document
 const sourceBaseline=k?{workspaceId:k.source.version.workspaceId,projectId:k.source.version.projectId,versionId:k.source.version.id,baseHash:k.source.version.baseHash,
  stateId:k.source.state.document.id,stateHash:k.source.state.stateHash,
  snapshots:[k.source.nonOutputSnapshotFacts.brief,k.source.nonOutputSnapshotFacts.policies,k.source.nonOutputSnapshotFacts.treatment,k.source.nonOutputSnapshotFacts.story,d.sourceEditPlanSnapshot].filter(r=>r!==null).map(r=>({kind:r.kind,id:r.id,hash:r.contentHash})),
  renderablePlanSnapshot:k.sourceRenderablePlanSnapshot,ownedIdentities:forkOwnedIdentities(k.source,k.sourceRenderablePlanSnapshot).toSorted((a,b)=>Buffer.compare(Buffer.from(a.kind+':'+a.id),Buffer.from(b.kind+':'+b.id))),
  sourceProject:d.sourceProject,sourceReferences:d.sourceReferences.map(({targetLinkId,...fact})=>{void targetLinkId;return fact})}:null
 return {...policy,schemaVersion:'project-creation-output-request/v2',workspaceId:c.workspaceId,callerIntent:c.payload.callerIntent,actorContextHash:c.actorContextHash,sourceBaseline}
}
function resealForgery(commandInput,change) {
 const command=clone(commandInput),bundle=clone(buildCreationOutputVersionBundleV2(commandInput))
 change(command,bundle)
 if(command.payload.forkDerivation) {
  const d=command.payload.forkDerivation;d.derivationHash=calculateOutputCanonicalHash(d.document)
  const edit=command.payload.snapshots.find(s=>s.kind==='edit-plan'),plan=JSON.parse(edit.contentJson)
  plan.forkDerivationRef.hash=d.derivationHash;edit.contentJson=stableSerialize(plan);edit.contentHash=calculateCanonicalHash(plan)
  const r=command.payload.renderableCandidate
  if(r){const render=JSON.parse(r.planJson);render.forkDerivationRef.hash=d.derivationHash;r.derivationRef.hash=d.derivationHash
   r.planJson=encode(render);const body={...policy,schemaVersion:'project-fork-renderable-plan-hash/v2',compilePolicyVersion:PROJECT_FORK_COMPILE_POLICY_VERSION,plan:render}
   r.planHashJson=encode(body);r.planHash=calculateOutputCanonicalHash(body)
   bundle.state.document.renderablePlan.planHash=r.planHash;bundle.state.document.renderablePlan.derivationHash=d.derivationHash}
 }
 command.requestFingerprint=calculateOutputCanonicalHash(operationalRequestBody(command))
 command.payloadHash=calculateOutputCanonicalHash(command.payload)
 command.commandHash=calculateOutputCanonicalHash({...policy,schemaVersion:2,id:command.id,workspaceId:command.workspaceId,projectId:command.projectId,versionId:command.versionId,
  actorContextHash:command.actorContextHash,payloadHash:command.payloadHash,requestFingerprint:command.requestFingerprint,createdAt:command.createdAt})
 bundle.command=command;bundle.state.document.provenance.hash=command.commandHash
 bundle.state.document.producer.document.commandHash=command.commandHash;bundle.state.document.producer.document.payloadHash=command.payloadHash;bundle.state.document.producer.document.requestFingerprint=command.requestFingerprint
 bundle.state.document.producer.hash=calculateOutputCanonicalHash(bundle.state.document.producer.document)
 const snapshot=command.payload.snapshots.find(s=>s.kind==='edit-plan')
 bundle.state.document.editPlan={snapshotId:snapshot.id,hash:snapshot.contentHash,authority:createOutputPlanAuthority({...policy,kind:'project-edit-plan',planDocument:JSON.parse(snapshot.contentJson)})}
 bundle.state.stateHash=calculateOutputCanonicalHash(bundle.state.document)
 bundle.version.outputStateHash=bundle.state.stateHash
 const body={...policy,schemaVersion:'project-output-bound-version-hash/v2',workspaceId:command.workspaceId,projectId:command.projectId,resultVersionId:command.versionId,
  parentVersionId:null,previousBaseHash:null,producerHash:bundle.state.document.producer.hash,outputStateId:bundle.state.document.id,outputStateHash:bundle.state.stateHash}
 bundle.outputBaseHashJson=encode(body);bundle.version.baseHash=calculateOutputCanonicalHash(body)
 return bundle
}
function forensicClient(client,bad,{omitFlush=false,omitHeadCAS=false,rowChange=null,beforeFlush=null}={}) {
 let callbackCompleted=false
 const trace=[]
 const observe=phase=>{assert.ok(trace.length<16,'bounded driver/readback trace');trace.push(phase)}
 const wrapped=new Proxy(client,{get(target,key){
  if(key==='$transaction')return async(action,options)=>{
   try {
    const committed=await target.$transaction(async(tx)=>{
   const port=new Proxy(tx,{get(transaction,member){
    if(member==='$executeRawUnsafe')return async(sql,...values)=>{
     if(sql==='SET CONSTRAINTS ALL IMMEDIATE'){if(beforeFlush)await beforeFlush(transaction);if(omitFlush)return 0}
     if(omitHeadCAS&&sql==='UPDATE projects SET "currentVersionId"=$1 WHERE id=$2 AND "workspaceId"=$3 AND "currentVersionId" IS NULL AND "creationContractVersion"=2') {
      assert.deepEqual(values,[bad.command.versionId,bad.command.projectId,bad.command.workspaceId])
      return 1 // Controlled omission of this exact write; real deferred constraints must reject the absent final head.
     }
     const match=sql.match(/^INSERT INTO "([a-z_]+)" \(([^)]+)\) VALUES/)
     if(match){
      const table=match[1],columns=[...match[2].matchAll(/"([A-Za-z0-9]+)"/g)].map(m=>m[1]),data=Object.fromEntries(columns.map((name,i)=>[name,values[i]])),c=bad.command,b=bad.state.document
      if(table==='project_media_assets'&&c.payload.forkDerivation&&!c.payload.forkDerivation.document.sourceReferences.some(r=>r.targetLinkId===data.id))return 0
      if(table==='project_snapshots'){const r=c.payload.snapshots.find(s=>s.id===data.id);if(r){data.contentJson=r.contentJson;data.contentHash=r.contentHash;data.schemaVersion=r.contentSchemaVersion}}
      if(table==='project_versions'){data.baseHash=bad.version.baseHash;data.outputStateHash=bad.state.stateHash;data.outputBaseHashJson=bad.outputBaseHashJson;data.outputVersionJson=encode(bad.version)}
      if(table==='project_creation_commands'){data.commandJson=encode(c);data.commandHash=c.commandHash;data.payloadJson=encode(c.payload);data.payloadHash=c.payloadHash
       const {commandHash:_hash,payload:_payload,audit:_audit,author:_author,...body}=c;void _hash;void _payload;void _audit;void _author;data.commandBodyJson=encode(body);data.requestJson=encode(operationalRequestBody(c));data.requestFingerprint=c.requestFingerprint;data.forkDerivationHash=c.payload.forkDerivation?.derivationHash??null}
      if(table==='project_fork_derivations'){const d=c.payload.forkDerivation;data.derivationJson=encode(d.document);data.derivationHash=d.derivationHash}
      if(table==='project_fork_renderable_candidates'){const r=c.payload.renderableCandidate;data.derivationHash=r.derivationRef.hash;data.planHash=r.planHash;data.planHashJson=r.planHashJson;data.candidateJson=encode(r);data.candidateHash=calculateOutputCanonicalHash(r)}
      if(table==='project_output_states'){data.stateJson=encode(b);data.stateHash=bad.state.stateHash;data.provenanceHash=c.commandHash;data.producerHash=b.producer.hash;data.producerJson=encode(b.producer.document)
       data.editPlanHash=b.editPlan.hash;data.editPlanAuthorityJson=encode(b.editPlan.authority.document);data.editPlanAuthorityHash=b.editPlan.authority.hash;
       data.consumptionStatus=b.consumption.status;data.consumptionJson=encode(b.consumption)}
      if(table==='output_variants'||table==='output_spec_revisions'){data.createdCommandHash=c.commandHash;if(!b.entries.some(e=>e.variantId===data.variantId||e.variantId===data.id))return 0}
      if(table==='project_output_state_entries'){const entry=b.entries.find(e=>e.variantId===data.variantId);if(!entry)return 0;data.entryJson=encode(entry);data.entryHash=calculateOutputCanonicalHash(entry)}
      if(table==='project_fork_crop_decisions'){const crop=b.overlays.find(e=>e.id===data.id);if(!crop)return 0;data.decisionJson=encode(crop);data.decisionHash=calculateOutputCanonicalHash(crop)}
      if(table==='idempotency_records')data.requestFingerprint=c.requestFingerprint
      if(rowChange)rowChange(table,data)
      return transaction.$executeRawUnsafe(sql,...columns.map(name=>data[name]))
     }
     return transaction.$executeRawUnsafe(sql,...values)
    }
    const value=transaction[member];return typeof value==='function'?value.bind(transaction):value
   }})
   const result=await action(port);callbackCompleted=true;observe('callback-completed');return result
    },options)
    observe('real-transaction-promise-resolved');return committed
   } catch(error) {observe('real-transaction-promise-rejected');throw error}
  }
  const value=target[key];return typeof value==='function'?value.bind(target):value
 }})
 return {client:wrapped,callbackCompleted:()=>callbackCompleted,trace:()=>[...trace],observe}
}
async function assertCommittedCreationEvents(client,input,proposal) {
 const rows=await client.v2PublicEventOutbox.findMany({where:{workspaceId:proposal.workspaceId,id:{in:input.eventIds.map(id=>id.toLowerCase())}},orderBy:{type:'asc'}})
 assert.equal(rows.length,2,'both canonical events commit in the bundle transaction')
 for(const [index,row] of rows.entries()) {
  const type=index===0?'project.created':'project.version.created',resourceType=index===0?'project':'project-version',resourceId=index===0?proposal.projectId:proposal.versionId
  assert.equal(row.id,input.eventIds[index].toLowerCase());assert.equal(row.type,type);assert.equal(row.version,'1.0.0')
  assert.equal(row.workspaceId,proposal.workspaceId);assert.equal(row.occurredAt.toISOString(),proposal.createdAt)
  assert.equal(row.sequence,index===0?null:1);assert.equal(row.actorClientId,proposal.author.id)
  assert.equal(row.actorUserId,proposal.audit.delegatedUserId??null)
  assert.equal(row.resourceType,resourceType);assert.equal(row.resourceId,resourceId);assert.equal(row.publishedAt,null)
  assert.deepEqual(JSON.parse(row.dataJson),{projectId:proposal.projectId,versionId:proposal.versionId})
  const event=createPublicEvent({id:row.id,workspaceId:row.workspaceId,type:row.type,version:row.version,occurredAt:row.occurredAt.toISOString(),
   ...(row.sequence!==null?{sequence:row.sequence}:{}),actor:{clientId:row.actorClientId,...(row.actorUserId?{userId:row.actorUserId}:{})},
   resource:{type:row.resourceType,id:row.resourceId},data:JSON.parse(row.dataJson)})
  assert.equal(event.version,'1.0.0','readback satisfies the existing public-event authority')
 }
}

async function targetCounts(client,command) {
 const p=command.projectId,s=command.payload.allocations.stateId
 const queries=[['projects','id'],['project_versions','projectId'],['project_creation_commands','projectId'],['project_snapshots','projectId'],['project_output_states','projectId'],
  ['output_variants','projectId'],['output_spec_revisions','projectId'],['project_fork_derivations','targetProjectId'],['project_fork_renderable_candidates','projectId'],['project_media_assets','projectId']]
 const counts=[]
 for(const [table,column] of queries){const [row]=await client.$queryRawUnsafe('SELECT count(*)::integer AS count FROM "'+table+'" WHERE "'+column+'"=$1',p);counts.push(row.count)}
 for(const table of ['project_output_state_entries','project_fork_crop_decisions','project_fork_invalidation_lineage']){const [row]=await client.$queryRawUnsafe('SELECT count(*)::integer AS count FROM "'+table+'" WHERE "stateId"=$1',s);counts.push(row.count)}
 const [events]=await client.$queryRawUnsafe('SELECT count(*)::integer AS count FROM public_event_outbox WHERE "resourceId"=$1 OR "resourceId"=$2',p,command.versionId);counts.push(events.count)
 return counts
}
async function denySql(client,world,proposal,bad,label,literal,{omitFlush=false,omitHeadCAS=false,rowChange=null,beforeFlush=null}={}) {
 const fixture=forensicClient(client,bad,{omitFlush,omitHeadCAS,rowChange,beforeFlush}),repository=new PrismaCreationOutputBundleRepositoryV2(fixture.client),input=allocation(world,proposal)
 const realRead=repository.read.bind(repository)
 repository.read=async(scope)=>{
  fixture.observe('external-read-start')
  try {const result=await realRead(scope);fixture.observe(result===null?'external-read-missing':'external-read-present');return result}
  catch(error){fixture.observe('external-read-rejected');throw error}
 }
 let error
 try{await repository.persist(input)}catch(caught){error=caught}
 assert.ok(error,label+' must return no successful repository response')
 if(omitFlush) {
  assert.equal(error.code,'PERSISTENCE_CONFLICT',label)
  assert.equal(error.message,'Creation committed bundle readback missing',label)
  assert.deepEqual(fixture.trace(),['callback-completed','real-transaction-promise-resolved','external-read-start','external-read-missing'],
   label+' transparently records the unresolved driver contract and actual missing readback')
 } else {
  assert.equal(error.code,'P2010',label);assert.equal(error.meta?.code,'23514',label)
  assert.equal(typeof error.meta?.message==='string'&&error.meta.message.includes(literal),true,label+' must reach its specific SQL guard')
  assert.deepEqual(fixture.trace(),['real-transaction-promise-rejected'],label+' required flush rejects before any external readback')
 }
 assert.equal(fixture.callbackCompleted(),omitFlush,label+' callback return is not COMMIT')
 assert.deepEqual(await targetCounts(client,proposal),Array(14).fill(0),label+' rollback leaves no new bundle/member/map/event rows')
 assert.equal(await client.v2IdempotencyRecord.count({where:{id:input.idempotencyRecordId}}),0)
 if(omitFlush) {
  const diagnostic=JSON.stringify({event:'w66-deferred-commit-driver-diagnostic',driverContractOutcome:'failed',productOutcome:'fail-closed',omitFlush:true,
   trace:fixture.trace(),errorCode:error.code,zeroNewAggregates:14,idempotencyRows:0,
   source:'real Prisma5.22 transaction promise and bound repository.read; only fixture omits mandatory ALL',
   proofScope:'isolated PostgreSQL full-bundle diagnostic; no driver correction or operational cutover claim'})
  assert.ok(Buffer.byteLength(diagnostic,'utf8')<=1024,'bounded driver diagnostic stdout')
  console.log(diagnostic)
 }
}
async function waitBlocked(observer,label) {
 const end=performance.now()+5000
 while(performance.now()<end){const rows=await observer.$queryRawUnsafe('SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type=$2 AND wait_event=$3',label,'Lock','transactionid')
  if(rows.length)return;await new Promise(done=>setTimeout(done,20))}
 throw new Error('Expected real PostgreSQL lock wait was not observed')
}

test('W66 Creation2 full bundle COMMIT/readback and immutable nonempty fork facts', {skip:!enabled,timeout:120000},async(t)=>{
 const url=new URL(process.env.V2_DATABASE_URL??'')
 assert.ok((url.searchParams.get('application_name')??'').startsWith('apollo-video-e2e-'))
 assert.ok(Number(url.searchParams.get('connection_limit'))>=1&&Number(url.searchParams.get('connection_limit'))<=5)
 const db=new PrismaClient(),peer=new PrismaClient(),observer=new PrismaClient(),world=fixtureWorld(),repository=new PrismaCreationOutputBundleRepositoryV2(db)
 let primaryError,source,sourceRoot,master,music
 try{
  const [ready]=await db.$queryRawUnsafe("SELECT to_regprocedure('w66_assert_creation_bundle_v2(text)') IS NOT NULL AS ready")
  assert.equal(ready.ready,true,'owner must apply both migrations and regenerate before this isolated gate')
  await db.v2Workspace.create({data:{id:world.workspaceId,slug:'w66full-'+world.runId,name:'W66 full bundle PG fixture',createdAt:date(world.createdAt),updatedAt:date(world.createdAt)}})
  await db.v2ApiClient.create({data:{id:world.clientId,workspaceId:world.workspaceId,name:'W66 full bundle synthetic actor',allowedEnvironmentsJson:'["sandbox"]',scopeGrantsJson:'["projects:write"]',createdBy:world.clientId,createdAt:date(world.createdAt),updatedAt:date(world.createdAt)}})
  await t.test('contract1 root/variant remains valid in this same migrated database',async()=>{
   sourceRoot=rootFixture(world);await transact(db,tx=>persistBundle(tx,sourceRoot));const variant=variantFixture(sourceRoot);await transact(db,tx=>persistBundle(tx,variant))
   master=await metadataMedia(db,world,'master');music=await metadataMedia(db,world,'music')
   for(const [index,m] of [master,music].entries())await db.v2ProjectMediaAsset.create({data:{id:m.linkId,workspaceId:world.workspaceId,projectId:sourceRoot.projectId,artifactId:m.artifactId,role:index?'source-audio':'source-master',originalFileName:index?'controlled-music.wav':'controlled-source.mp4',createdAt:date(world.createdAt)}})
   source=contentFixture(variant,master,music)
   await transact(db,async(tx)=>{
    // Its reciprocal factual Renderable anchor is inserted in the SAME TX.
    const row=stateRow(source);row.renderablePlanSnapshotId=source.renderableRow.id;row.renderablePlanId=source.renderableRow.planId;row.renderablePlanHash=source.renderableRow.planHash;
    row.renderablePlanAuthorityJson=encode(source.state.document.renderablePlan.authority.document);row.renderablePlanAuthorityHash=source.state.document.renderablePlan.authority.hash
    await persistBundle(tx,source,{stateOverrides:row})
    await insert(tx,'renderable_plan_snapshots',{...source.renderableRow,createdAt:date(source.renderableRow.createdAt)})
   })
   const persisted=await db.v2ProjectVersion.findUniqueOrThrow({where:{id:source.version.id}})
   assert.equal(persisted.outputContractVersion,1);assert.equal(persisted.baseHash,source.version.baseHash)
   assert.equal((await master.rightsRepo.findCurrent(world.workspaceId,master.artifactId)).snapshot.allowedUses.includes('rendering'),false,'editing intent copy does not require/infer rendering permission')
  })
  await t.test('root2 commits all reciprocal rows and replays without duplicate allocations',async()=>{
   const proposal=operationalEmpty(world),input=allocation(world,proposal)
   for(const [label,eventIds] of [
    ['malformed UUID',['-'.repeat(36),'123e4567-e89b-42d3-a456-426614174000']],
    ['UUID is not v4',['123e4567-e89b-12d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000']],
    ['same UUID in different case',['123e4567-e89b-42d3-a456-426614174000','123E4567-E89B-42D3-A456-426614174000']]]) {
    await assert.rejects(()=>repository.persist({...input,eventIds}),e=>e.code==='INVALID_ARGUMENT',label)
    assert.deepEqual(await targetCounts(db,proposal),Array(14).fill(0),label+' leaves zero new bundle/outbox effects')
   }
   const result=await repository.persist(input),counts=await targetCounts(db,proposal)
   assert.equal(result.replayed,false);assert.equal(result.bundle.version.outputContractVersion,2)
   const stored=await db.v2Project.findUniqueOrThrow({where:{id:proposal.projectId}})
   assert.equal(stored.creationContractVersion,2);assert.equal(stored.ownerId,proposal.author.id);assert.equal(stored.format,null);assert.equal(stored.currentVersionId,proposal.versionId)
   await assertCommittedCreationEvents(db,input,proposal)
   const replay=await repository.persist(input);assert.equal(replay.replayed,true);assert.deepEqual(await targetCounts(db,proposal),counts)
   await assertCommittedCreationEvents(db,input,proposal)
   for(const purpose of ['render','critic','final'])await assert.rejects(()=>requirePersistedOutputConsumptionV2(db,{workspaceId:world.workspaceId,projectId:proposal.projectId,versionId:proposal.versionId,purpose}),e=>e.code==='PRECONDITION_REQUIRED')
  })
  await t.test('nonempty fork commits candidate clip cue music crop with actual source rows and zero acceptance transfer',async(forkTest)=>{
   const proposal=await forkCommand(db,source,sourceRoot,[master,music]),sourceBefore=await db.v2ProjectVersion.findUniqueOrThrow({where:{id:source.version.id}}),snapshotsBefore=await db.v2ProjectSnapshot.findMany({where:{projectId:source.projectId}})
   const input=allocation(world,proposal),result=await repository.persist(input),b=result.bundle
   await assertCommittedCreationEvents(db,input,proposal)
   const project=await db.v2Project.findUniqueOrThrow({where:{id:proposal.projectId}})
   assert.equal(project.ownerId,proposal.author.id);assert.equal(project.format,proposal.payload.forkDerivation.document.sourceProject.format,'fork format is administrative metadata, never geometry authority')
   assert.equal(b.version.sequence,1);assert.equal(b.version.forkedFromVersionId,source.version.id);assert.equal(b.state.document.overlays[0].status,'inactive-requires-target-materialization')
   const plan=JSON.parse(b.command.payload.renderableCandidate.planJson),oldClip=source.plan.videoTracks[0].clips[0]
   assert.notEqual(plan.videoTracks[0].clips[0].id,oldClip.id);assert.equal(plan.videoTracks[0].clips[0].sourceArtifactId,master.artifactId)
   assert.equal(plan.subtitleTracks[0].cues[0].clipId,plan.videoTracks[0].clips[0].id);assert.equal(plan.subtitleTracks[0].cues[0].text,source.renderable.subtitleTracks[0].cues[0].text,'fork preserves the actual source cue text')
   assert.equal(plan.videoTracks[0].clips[0].audioSourceArtifactId,music.artifactId,'secondary speech artifact is preserved and explicitly covered by its audited link/manifest/rights')
   assert.equal(plan.audioTracks[0].artifactId,music.artifactId);assert.equal('directorRunId' in plan,false);assert.equal('approval' in plan,false);assert.equal('critic' in plan,false)
   assert.equal(b.command.payload.forkDerivation.document.sourceEditPlanSnapshot.createdAt,new Date(Date.parse(world.createdAt)-1000).toISOString())
   assert.deepEqual(await db.v2ProjectVersion.findUniqueOrThrow({where:{id:source.version.id}}),sourceBefore)
   assert.deepEqual(await db.v2ProjectSnapshot.findMany({where:{projectId:source.projectId}}),snapshotsBefore)
   assert.equal(await db.v2ProxyReview.count({where:{projectId:proposal.projectId}}),0);assert.equal(await db.v2RenderElementMap.count({where:{projectId:proposal.projectId}}),0)
   await forkTest.test('a committed Project2 cannot downgrade its discriminator and clear its head',async()=>{
    const before=await db.v2Project.findUniqueOrThrow({where:{id:proposal.projectId}})
    assert.equal(before.creationContractVersion,2);assert.equal(before.currentVersionId,proposal.versionId)
    assert.equal(before.format,'9:16','actual administrative format prevents an unrelated format CHECK from masking this trigger')
    const eventsBefore=await db.v2PublicEventOutbox.findMany({where:{workspaceId:world.workspaceId,id:{in:input.eventIds}},orderBy:{id:'asc'}})
    assert.equal(eventsBefore.length,2)
    const countsBefore=await targetCounts(db,proposal)
    await assert.rejects(()=>transact(db,async tx=>{
     const updated=await tx.$executeRawUnsafe('UPDATE projects SET "creationContractVersion"=1,"currentVersionId"=NULL WHERE id=$1 AND "workspaceId"=$2',proposal.projectId,world.workspaceId)
     assert.equal(updated,1)
    }),e=>e.code==='P2010'&&e.meta?.code==='23514'&&typeof e.meta?.message==='string'&&e.meta.message.includes('W66v2 head requires explicit Project discriminator'))
    assert.deepEqual(await db.v2Project.findUniqueOrThrow({where:{id:proposal.projectId}}),before,'rollback restores the entire committed Project row including head/discriminator')
    assert.deepEqual(await db.v2PublicEventOutbox.findMany({where:{workspaceId:world.workspaceId,id:{in:input.eventIds}},orderBy:{id:'asc'}}),eventsBefore)
    assert.deepEqual(await targetCounts(db,proposal),countsBefore)
   })
   for(const purpose of ['render','critic','final'])await assert.rejects(()=>requirePersistedOutputConsumptionV2(db,{workspaceId:world.workspaceId,projectId:proposal.projectId,versionId:proposal.versionId,purpose}),e=>e.code==='PRECONDITION_REQUIRED')
  })
  await t.test('missing final head: required flush rejects; omitted flush diagnoses failed driver and fail-closed product',async()=>{
   for(const omitFlush of [false,true]) {
    const proposal=operationalEmpty(world,'missing-head'),valid=buildCreationOutputVersionBundleV2(proposal)
    await denySql(db,world,proposal,valid,omitFlush?'driver diagnostic/product fail-closed missing head':'flush missing final head',
     'W66v2 reciprocal bundle missing at COMMIT',{omitHeadCAS:true,omitFlush})
   }
  })
  await t.test('root intent mismatch: required flush rejects SQL; omitted flush exposes driver failure and fail-closed readback',async()=>{
   for(const omitFlush of [false,true]){
    const proposal=operationalEmpty(world,'forged-root'),bad=resealForgery(proposal,c=>{const row=c.payload.snapshots.find(s=>s.kind==='brief'),doc=JSON.parse(row.contentJson);doc.objective='sale';row.contentJson=stableSerialize(doc);row.contentHash=calculateCanonicalHash(doc)})
    await denySql(db,world,proposal,bad,omitFlush?'driver diagnostic/product fail-closed root mismatch':'flush root mismatch','W66v2 root brief caller intent mismatch',{omitFlush})
   }
  })
  await t.test('fully resealed fork removes a member or changes a mapped cue; SQL rejects with exact guards and rollback',async()=>{
   const proposal=await forkCommand(db,source,sourceRoot,[master,music]),sourceBefore=await db.v2Project.findUniqueOrThrow({where:{id:source.projectId}})
   await denySql(db,world,proposal,resealForgery(proposal,(_c,b)=>{b.state.document.entries=[];b.state.document.overlays=[]}), 'removed member','W66v2 fork lost source member or intent lineage')
   await denySql(db,world,proposal,resealForgery(proposal,c=>{const row=c.payload.snapshots.find(s=>s.kind==='edit-plan'),doc=JSON.parse(row.contentJson);doc.subtitleTracks[0].cues[0].clipId=source.plan.videoTracks[0].clips[0].id;row.contentJson=stableSerialize(doc);row.contentHash=calculateCanonicalHash(doc)}),'source cue ID reused','W66v2 typed snapshot remap mismatch')
   assert.deepEqual(await db.v2Project.findUniqueOrThrow({where:{id:source.projectId}}),sourceBefore)
  })
  await t.test('fully resealed missing secondary speech fact is rejected even when link counts were forged consistently',async()=>{
   const proposal=await forkCommand(db,source,sourceRoot,[master,music]),linksBefore=await db.v2ProjectMediaAsset.findMany({where:{projectId:source.projectId},orderBy:{id:'asc'}})
   const bad=resealForgery(proposal,c=>{c.payload.forkDerivation.document.sourceReferences=c.payload.forkDerivation.document.sourceReferences.filter(r=>r.artifactId!==music.artifactId)})
   await denySql(db,world,proposal,bad,'missing referenced secondary audio','W66v2 referenced media artifact facts incomplete',
    {beforeFlush:tx=>tx.$executeRawUnsafe('DELETE FROM project_media_assets WHERE id=$1::uuid AND "projectId"=$2 AND "workspaceId"=$3',music.linkId,source.projectId,world.workspaceId)})
   assert.deepEqual(await db.v2ProjectMediaAsset.findMany({where:{projectId:source.projectId},orderBy:{id:'asc'}}),linksBefore,'same failed TX rolls back its adversarial source-link write too')
  })
  await t.test('valid resealed source manifest cannot substitute artifact key or stored recipe columns',async()=>{
   const proposal=await forkCommand(db,source,sourceRoot,[master,music])
   for(const field of ['key','recipe']) {
    const bad=resealForgery(proposal,c=>{
     const fact=c.payload.forkDerivation.document.sourceReferences[0],old=JSON.parse(fact.manifestFacts.manifestJson)
     const changed=createMediaArtifactManifestV2({artifactKey:field==='key'?'controlled/other-key.mp4':old.artifact.artifactKey,artifactSha256:old.artifact.sha256,
      byteSize:old.artifact.byteSize,mediaType:old.artifact.mediaType,container:old.artifact.container,
      recipe:{id:field==='recipe'?'other-valid-recipe':old.recipe.id,version:old.recipe.version,parameters:{evidenceScope:'metadata-only-no-physical-render'}},sources:[]})
     fact.manifestFacts.manifestJson=JSON.stringify(changed);fact.manifestFacts.manifestHash=changed.manifestHash
     if(field==='key')fact.artifactKey=changed.artifact.artifactKey
     else fact.manifestFacts.recipeId=changed.recipe.id
     assert.notEqual(changed.manifestHash,old.manifestHash)
    })
    await denySql(db,world,proposal,bad,field+' resealed manifest row substitution','W66v2 actual media source/target link facts mismatch')
   }
  })
  await t.test('fully resealed fork source owner or display-format facts cannot replace the actual source Project',async()=>{
   const proposal=await forkCommand(db,source,sourceRoot,[master,music])
   for(const [field,value] of [['ownerId','unrelated-source-owner'],['format','1:1']]) {
    const bad=resealForgery(proposal,c=>{c.payload.forkDerivation.document.sourceProject[field]=value})
    await denySql(db,world,proposal,bad,field+' fully resealed source metadata','W66v2 fork source/target facts or head authority mismatch',
     {rowChange:(table,row)=>{if(table==='projects'&&field==='format')row.format=value}})
   }
  })
  await t.test('row-only administrative metadata and canonical policy substitutions fail SQL and rollback',async()=>{
   const root=operationalEmpty(world,'metadata-root'),rootBundle=buildCreationOutputVersionBundleV2(root)
   await denySql(db,world,root,rootBundle,'root format without caller intent','W66v2 initialize requires an actual empty project and explicit caller intent',
    {rowChange:(table,row)=>{if(table==='projects')row.format='16:9'}})
   const fork=await forkCommand(db,source,sourceRoot,[master,music]),valid=buildCreationOutputVersionBundleV2(fork)
   for(const [label,column,value,literal] of [
    ['fork owner','ownerId','unrelated-owner','W66v2 project/Version/State/Creation reciprocity mismatch'],
    ['fork format','format','1:1','W66v2 fork source/target facts or head authority mismatch']])
    await denySql(db,world,fork,valid,label,literal,{rowChange:(table,row)=>{if(table==='projects')row[column]=value}})
   for(const tableName of ['output_spec_revisions','project_output_state_entries'])
    await denySql(db,world,fork,valid,tableName+' policy column',tableName,
     {rowChange:(table,row)=>{if(table===tableName)row.canonicalPolicyVersion='output-canonical-json/forged'}})
  })
  for(const rightChange of ['revoke','expire']) await t.test(rightChange+' during a real source-project lock wait revalidates current rights after waiting/retry',async()=>{
   const before=await db.v2Project.findUniqueOrThrow({where:{id:source.projectId}})
   let expiresAt
   if(rightChange==='expire') {
    expiresAt=new Date(Date.now()+2000).toISOString()
    const current=await master.rightsRepo.findCurrent(world.workspaceId,master.artifactId)
    await master.setRights({workspaceId:world.workspaceId,artifactId:master.artifactId,baseRevision:current.revision,actor:{type:'api-client',id:world.clientId},
     draft:{status:'approved',owner:'Controlled fixture',license:'Metadata only',allowedUses:['editing'],prohibitedUses:[],expiresAt,consent:{status:'not-required',allowedUses:[]}}})
   }
   const proposal=await forkCommand(db,source,sourceRoot,[master,music])
   let release,entered;const hold=new Promise(done=>{release=done}),ready=new Promise(done=>{entered=done})
   const blocker=peer.$transaction(async(tx)=>{await tx.$queryRawUnsafe('SELECT id FROM projects WHERE id=$1 FOR UPDATE',source.projectId);entered();await hold},{maxWait:3000,timeout:12000})
   let outcome,run,latchError
   try {
    await Promise.race([ready,blocker.then(()=>{throw new Error('Blocker ended before lock readiness')})])
    run=repository.persist(allocation(world,proposal)).then(result=>({result}),error=>({error}))
    await waitBlocked(observer,url.searchParams.get('application_name'))
    if(rightChange==='revoke') {
     const rightsRepo=new PrismaAssetRightsRepository(observer),setRights=setAssetRightsService({repository:rightsRepo,clock:()=>new Date(),createId:()=>world.id('revoked-rights')})
     const current=await rightsRepo.findCurrent(world.workspaceId,master.artifactId)
     await setRights({workspaceId:world.workspaceId,artifactId:master.artifactId,baseRevision:current.revision,actor:{type:'api-client',id:world.clientId},draft:{status:'revoked',allowedUses:[],prohibitedUses:[],consent:{status:'not-required',allowedUses:[]}}})
    } else {
     const end=performance.now()+5000;let expired=false
     while(performance.now()<end) {
      const [observed]=await observer.$queryRawUnsafe('SELECT clock_timestamp() >= $1::timestamptz AS expired',expiresAt)
      if(observed.expired){expired=true;break}await new Promise(done=>setTimeout(done,20))
     }
     assert.equal(expired,true,'actual PostgreSQL clock must cross the audited grant expiry while source lock is still held')
    }
   } catch(error){latchError=error}
   finally {
    release()
    const settlements=await Promise.allSettled([blocker,...(run?[run]:[])])
    if(run&&settlements[1].status==='fulfilled')outcome=settlements[1].value
    const failure=settlements.find(s=>s.status==='rejected')
    if(failure){if(latchError)console.error(JSON.stringify({diagnostic:'w66-latch-secondary',code:failure.reason?.code??null}));else latchError=failure.reason}
   }
   try {
    if(latchError)throw latchError
    assert.ok(outcome?.error,rightChange+' must return an actual denied transaction, not publish')
    assert.equal(outcome.error.code,'ASSET_RIGHTS_BLOCKED',rightChange)
    assert.deepEqual(await targetCounts(db,proposal),Array(14).fill(0),rightChange+' leaves zero new target bundle effects')
    assert.deepEqual(await db.v2Project.findUniqueOrThrow({where:{id:source.projectId}}),before)
   } catch(error){latchError=error;throw error}
   finally {
    try {
     const current=await master.rightsRepo.findCurrent(world.workspaceId,master.artifactId)
     await master.setRights({workspaceId:world.workspaceId,artifactId:master.artifactId,baseRevision:current.revision,actor:{type:'api-client',id:world.clientId},
      draft:{status:'approved',owner:'Controlled fixture',license:'Metadata only',allowedUses:['editing'],prohibitedUses:[],consent:{status:'not-required',allowedUses:[]}}})
    }catch(error){if(latchError)console.error(JSON.stringify({diagnostic:'w66-rights-restore-secondary',code:error?.code??null}));else throw error}
   }
  })

 }catch(error){primaryError=error;throw error}
 finally{
  const settlements=await Promise.allSettled([db.$disconnect(),peer.$disconnect(),observer.$disconnect()])
  const failures=settlements.filter(s=>s.status==='rejected')
  if(failures.length){if(primaryError)Object.defineProperty(primaryError,'disconnectFailed',{value:true});else throw failures[0].reason}
 }
})
