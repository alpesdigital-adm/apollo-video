import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import { createHash } from 'node:crypto'
import type { CreationOutputBundleRepositoryV2, CreationOutputBundleWriteV2, CreationSourceFactsV2, CreationSourceFactsV3 } from '../../application/ports/output-version-bundle-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { forkOwnedIdentities, forkCreationSourceBaselineV3, validateProjectForkCallerRequestV3 } from '../../domain/project-fork-derivation.ts'
import { creationProjectMetadataV2, validateProjectCreationOutputCommandV2 } from '../../domain/project-creation-command.ts'
import { buildCreationOutputVersionBundleV2, type CreationOutputVersionBundleV2 } from '../../domain/output-version-bundle.ts'
import { serializeOutputCanonicalJson, calculateOutputCanonicalHash } from '../../domain/output-canonical-policy.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import { PrismaAssetRightsRepository } from './asset-rights-repository.ts'
import { readPersistedCreationOutputBundleV2, readPersistedForkCreationOutputBundleV3 } from './output-state-consumption.ts'
import { readCompletedIdempotencyResponse } from './idempotency-record-persistence.ts'
import { normalizeProjectName, projectStatusTransitionPath } from '../../domain/project.ts'

type Tx = Prisma.TransactionClient
const encode = serializeOutputCanonicalJson
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const identical = (a: unknown, b: unknown) => encode(a) === encode(b)
const retryable = (error: unknown) => error !== null && typeof error === 'object' &&
  ('code' in error && (error.code === 'P2034' || error.code === 'P2010' && 'meta' in error &&
    error.meta !== null && typeof error.meta === 'object' && 'code' in error.meta && error.meta.code === '40001'))
// A declaration (not an arrow const) so that calls narrow control flow like `throw`.
function conflict(message: string): never { throw new DomainError('PERSISTENCE_CONFLICT',message) }
export function assertForkCallerBindingV3(command: CreationOutputBundleWriteV2['proposal'],
  caller: Readonly<import('../../domain/project-fork-derivation.ts').ProjectForkCallerRequestV3>|null): void {
  const fork=command.payload.forkDerivation
  if(fork?.schemaVersion!=='project-fork-derivation/v3') {
    if(caller!==null)return conflict('Non-fork3 Creation cannot carry a fork3 caller request')
    return
  }
  if(caller===null)return conflict('Fork3 persistence requires its explicit caller request')
  const source=fork.document.kernel.document.source.version
  if(caller.workspaceId!==command.workspaceId || caller.sourceProjectId!==source.projectId || caller.sourceVersionId!==source.id ||
    caller.sourceVersionHash!==source.baseHash || caller.actorContextHash!==command.actorContextHash ||
    command.payload.callerIntent.kind!=='fork-with-content' || command.payload.callerIntent.name!==
      (caller.requestedName??normalizeProjectName(fork.document.sourceProject.name+' (cópia)')))
    throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH','Fork3 caller request differs from the exact recorded source/actor/intent')
}
export function assertCreationRecompositionV2(proposal: CreationOutputBundleWriteV2['proposal'], command: CreationOutputBundleWriteV2['proposal']): void {
  if (command.id!==proposal.id || command.projectId!==proposal.projectId || command.versionId!==proposal.versionId || command.createdAt!==proposal.createdAt ||
    command.requestFingerprint!==proposal.requestFingerprint || !identical(command.audit,proposal.audit) || !identical(command.payload.allocations,proposal.payload.allocations) ||
    !identical(command.payload.snapshots.map(s=>({kind:s.kind,id:s.id,planId:s.kind==='edit-plan'?JSON.parse(s.contentJson).id:null})),
      proposal.payload.snapshots.map(s=>({kind:s.kind,id:s.id,planId:s.kind==='edit-plan'?JSON.parse(s.contentJson).id:null}))) ||
    !identical(command.payload.renderableCandidate?{id:command.payload.renderableCandidate.id,planId:command.payload.renderableCandidate.planId}:null,
      proposal.payload.renderableCandidate?{id:proposal.payload.renderableCandidate.id,planId:proposal.payload.renderableCandidate.planId}:null) ||
    !identical(command.payload.callerIntent,proposal.payload.callerIntent) || !identical(command.payload.forkDerivation?.document.sourceReferences ?? [],proposal.payload.forkDerivation?.document.sourceReferences ?? []) ||
    command.payload.forkDerivation?.document.id !== proposal.payload.forkDerivation?.document.id ||
    !identical(command.payload.forkDerivation?.document.kernel.document.target ?? null,proposal.payload.forkDerivation?.document.kernel.document.target ?? null) ||
    !identical(command.payload.forkDerivation?.document.kernel.document.identityMap ?? [],proposal.payload.forkDerivation?.document.kernel.document.identityMap ?? []) ||
    !identical(command.payload.forkDerivation?.document.kernel.document.cropDecisions ?? [],proposal.payload.forkDerivation?.document.kernel.document.cropDecisions ?? []))
    conflict('Creation recomposition changed caller/actor/allocation/clock/source request')
}
function protectedMetadata(row: {ref:string;workspaceId:string;canonicalByteSize:number;algorithm:string;keyId:string;nonce:string;ciphertext:string;authTag:string;createdAt:Date;parametersHash?:string;inputHash?:string} | null) {
  return row===null ? null : {ref:row.ref,workspaceId:row.workspaceId,canonicalByteSize:row.canonicalByteSize,algorithm:row.algorithm,keyId:row.keyId,nonce:row.nonce,
    ciphertextSha256:sha(row.ciphertext),ciphertextByteSize:Buffer.byteLength(row.ciphertext,'utf8'),authTag:row.authTag,createdAt:row.createdAt.toISOString(),
    ...(row.parametersHash!==undefined?{parametersHash:row.parametersHash}:{inputHash:row.inputHash!})}
}
async function clock(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT clock_timestamp() AS now')
  if (rows.length !== 1 || !Number.isFinite(rows[0].now.getTime())) return conflict('Creation authority clock unavailable')
  return rows[0].now
}
async function insert(tx: Tx, table: string, data: Record<string, unknown>) {
  // Call sites below pass fixed identifiers; values always use bind parameters.
  const names = Object.keys(data)
  return tx.$executeRawUnsafe('INSERT INTO "'+table+'" ('+names.map((n) => '"'+n+'"').join(',')+') VALUES ('+
    names.map((name,i) => '$'+(i+1)+(table==='project_media_assets' && (name==='id'||name==='uploadId')?'::uuid':'')).join(',')+')',...Object.values(data))
}
async function sourceFacts(tx: Tx, command: CreationOutputBundleWriteV2['proposal']): Promise<Readonly<CreationSourceFactsV2 | CreationSourceFactsV3> | null> {
  const fork = command.payload.forkDerivation
  if (!fork) return null
  const d = fork.document, expected = d.kernel.document.source, projectId = expected.version.projectId
  const currentSource = fork.schemaVersion === 'project-fork-derivation/v3' ? fork.document.kernel.document.source : null
  if (currentSource !== null) {
    const client = await tx.v2ApiClient.findUnique({where:{id:command.author.id}})
    if (!client || client.workspaceId !== command.workspaceId || client.status !== 'active')
      throw new DomainError('AUTH_INVALID','Active duplication client was not found')
  }
  // Project first, then all artifacts in UTF8/C order, then immutable snapshots
  // and State/Version rows. No lock on an output alone before other sources.
  const locked = await tx.$queryRawUnsafe<{ id: string }[]>('SELECT id FROM projects WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE',projectId,command.workspaceId)
  if (locked.length !== 1) throw new DomainError('VERSION_CONFLICT','Creation source Project missing')
  const project = await tx.v2Project.findUnique({where:{id:projectId}})
  if (!project || project.workspaceId !== command.workspaceId || project.currentVersionId !== expected.version.id || project.status === 'archived')
    throw new DomainError('VERSION_CONFLICT','Creation source head/lifecycle changed')
  const projectFact = { id:project.id,workspaceId:project.workspaceId,currentVersionId:project.currentVersionId,
    name:project.name,status:project.status,format:project.format,ownerId:project.ownerId,
    administrationRevision:project.administrationRevision,updatedAt:project.updatedAt.toISOString(),objective:project.objective!,locale:project.locale!,
    createdByType:project.createdByType,createdById:project.createdById,createdAt:project.createdAt.toISOString() }
  if (!identical(projectFact,d.sourceProject)) throw new DomainError('VERSION_CONFLICT','Creation source metadata changed')
  const ids = [...new Set(d.sourceReferences.map((r) => r.artifactId))].sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)))
  if (ids.length) {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>('SELECT id FROM media_artifacts WHERE "workspaceId"=$1 AND id IN ('+ids.map((_,i) => '$'+(i+2)).join(',')+') ORDER BY id COLLATE "C" FOR UPDATE',command.workspaceId,...ids)
    if (!identical(rows.map((r)=>r.id),ids)) return conflict('Creation source artifact scope/count differs')
  }
  const snapshotIds = Object.values(expected.version.snapshotRefs).filter((id): id is string => typeof id === 'string').sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)))
  await tx.$queryRawUnsafe('SELECT id FROM project_versions WHERE id=$1 AND "projectId"=$2 AND "workspaceId"=$3 FOR SHARE',expected.version.id,projectId,command.workspaceId)
  await tx.$queryRawUnsafe('SELECT id FROM project_output_states WHERE id=$1 AND "projectId"=$2 AND "workspaceId"=$3 FOR SHARE',expected.state.document.id,projectId,command.workspaceId)
  await tx.$queryRawUnsafe('SELECT id FROM project_snapshots WHERE id IN ('+snapshotIds.map((_,i)=>'$'+(i+1)).join(',')+') ORDER BY id COLLATE "C" FOR SHARE',...snapshotIds)
  await tx.$queryRawUnsafe('SELECT id FROM project_media_assets WHERE "projectId"=$1 AND "workspaceId"=$2 ORDER BY id::text COLLATE "C" FOR SHARE',projectId,command.workspaceId)
  const links = await tx.v2ProjectMediaAsset.findMany({where:{projectId,workspaceId:command.workspaceId}})
  if (links.length !== d.sourceReferences.length) return conflict('Creation source media links differ')
  const version = await tx.v2ProjectVersion.findUnique({where:{id:expected.version.id}})
  const states = await tx.$queryRawUnsafe<{ stateJson: string; stateHash: string }[]>('SELECT "stateJson","stateHash" FROM project_output_states WHERE id=$1 AND "resultVersionId"=$2 AND "workspaceId"=$3 AND "projectId"=$4',expected.state.document.id,expected.version.id,command.workspaceId,projectId)
  if (!version || version.outputContractVersion !== (currentSource?.version.outputContractVersion ?? 1) || version.projectId !== projectId || version.workspaceId !== command.workspaceId ||
    version.baseHash !== expected.version.baseHash || version.outputStateId !== expected.state.document.id || version.outputStateHash !== expected.state.stateHash ||
    version.outputBaseHashJson !== expected.outputBaseHashJson || version.sequence !== expected.version.sequence || version.parentVersionId !== ('parentVersionId' in expected.version ? expected.version.parentVersionId ?? null : null) ||
    version.commandId !== ('commandId' in expected.version ? expected.version.commandId ?? null : null) || version.createdBy !== expected.version.createdBy || version.createdAt.toISOString() !== expected.version.createdAt ||
    version.briefSnapshotId !== expected.version.snapshotRefs.brief || version.policiesSnapshotId !== expected.version.snapshotRefs.policies ||
    version.editPlanSnapshotId !== expected.version.snapshotRefs.editPlan || version.treatmentSnapshotId !== (expected.version.snapshotRefs.treatment ?? null) ||
    version.storySnapshotId !== (expected.version.snapshotRefs.story ?? null) || states.length !== 1 || states[0].stateJson !== encode(expected.state.document) || states[0].stateHash !== expected.state.stateHash)
    return conflict('Creation exact operational source Version/State differs')
  const actualBundle = currentSource === null ? null : await readPersistedOperationalOutputBundleV3(tx,{workspaceId:command.workspaceId,projectId,versionId:expected.version.id})
  if (currentSource !== null && (!actualBundle || !identical(actualBundle,currentSource.bundle)))
    return conflict('Creation exact source2/3 receipt differs')
  if (currentSource !== null) await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_fork_source_v3($1::jsonb,true)',encode(currentSource))
  const snapshots = await tx.v2ProjectSnapshot.findMany({where:{id:{in:snapshotIds},projectId,workspaceId:command.workspaceId}})
  const actualSnapshots = snapshots.map((r)=>({schemaVersion:1 as const,id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,
    kind:r.kind as typeof d.sourceEditPlanSnapshot.kind,contentSchemaVersion:r.schemaVersion,contentJson:r.contentJson,contentHash:r.contentHash,createdAt:r.createdAt.toISOString()}))
  const sourceSnapshots = [d.sourceEditPlanSnapshot,...Object.values(expected.nonOutputSnapshotFacts).filter((r)=>r!==null)]
  if (actualSnapshots.length !== sourceSnapshots.length || sourceSnapshots.some((r)=> !actualSnapshots.some((a)=>identical(a,r) && sha(a.contentJson)===a.contentHash)))
    return conflict('Creation actual source snapshot facts differ')
  const sourceRenderable = d.kernel.document.sourceRenderablePlanSnapshot
  if (sourceRenderable) {
    await tx.$queryRawUnsafe('SELECT id FROM renderable_plan_snapshots WHERE id=$1 AND "workspaceId"=$2 ORDER BY id COLLATE "C" FOR SHARE',sourceRenderable.id,command.workspaceId)
    const row=await tx.v2RenderablePlanSnapshot.findUnique({where:{id:sourceRenderable.id}})
    if (!row || !identical({...row,createdAt:row.createdAt.toISOString()},sourceRenderable)) return conflict('Creation actual source Renderable facts differ')
  }
  for (const ref of d.sourceReferences.toSorted((a,b)=>Buffer.compare(Buffer.from(a.manifestFacts.id),Buffer.from(b.manifestFacts.id)))) {
    await tx.$queryRawUnsafe('SELECT id FROM media_artifact_manifests WHERE id=$1 AND "workspaceId"=$2 ORDER BY id COLLATE "C" FOR SHARE',ref.manifestFacts.id,command.workspaceId)
    if(ref.manifestFacts.recipeParametersRef!==null) await tx.$queryRawUnsafe('SELECT ref FROM recipe_parameter_payloads WHERE ref=$1 AND "workspaceId"=$2 FOR SHARE',ref.manifestFacts.recipeParametersRef,command.workspaceId)
    if(ref.manifestFacts.renderInputRef!==null) await tx.$queryRawUnsafe('SELECT ref FROM render_input_payloads WHERE ref=$1 AND "workspaceId"=$2 FOR SHARE',ref.manifestFacts.renderInputRef,command.workspaceId)
    const row=await tx.v2MediaArtifactManifest.findUnique({where:{id:ref.manifestFacts.id},include:{recipeParameters:true,renderInput:true}})
    if (!row || !identical({id:row.id,artifactId:row.artifactId,workspaceId:row.workspaceId,schemaVersion:row.schemaVersion,manifestJson:row.manifestJson,manifestHash:row.manifestHash,createdAt:row.createdAt.toISOString(),recipeId:row.recipeId,recipeVersion:row.recipeVersion,parametersHash:row.parametersHash,
      recipeParametersRef:row.recipeParametersRef,renderInputRef:row.renderInputRef,renderInputHash:row.renderInputHash,
      recipeParameters:protectedMetadata(row.recipeParameters),renderInput:protectedMetadata(row.renderInput)},ref.manifestFacts))
      return conflict('Creation source manifest factual row differs')
  }
  const artifacts = await tx.v2MediaArtifact.findMany({where:{id:{in:ids},workspaceId:command.workspaceId},include:{currentRightsSnapshot:true}})
  for (const r of d.sourceReferences) {
    const link=links.find((l)=>l.id===r.sourceLinkId), artifact=artifacts.find((a)=>a.id===r.artifactId)
    if (!link || !artifact || link.artifactId!==r.artifactId || link.role!==r.role || link.originalFileName!==r.originalFileName ||
      link.createdAt.toISOString()!==r.sourceLinkCreatedAt || artifact.status!=='available' || artifact.artifactKey!==r.artifactKey || artifact.sha256!==r.artifactSha256 || artifact.byteSize.toString()!==r.artifactByteSize ||
      artifact.mediaType!==r.artifactMediaType || artifact.container!==r.artifactContainer || artifact.lifecycleRevision!==r.artifactLifecycleRevision)
      return conflict('Creation actual artifact/link/lifecycle facts differ')
  }
  // All queries precede the clock. Rights evaluation and comparisons below are
  // synchronous; a blocked/expired/revoked grant cannot authorize an enqueue.
  const rights=await new PrismaAssetRightsRepository(tx).findCurrentForArtifacts(command.workspaceId,ids)
  const now=await clock(tx)
  for (const r of d.sourceReferences) {
    const artifact=artifacts.find((a)=>a.id===r.artifactId)!
    const snapshot=rights.get(artifact.id) ?? null
    // A later audited rights change can restore an existing immutable snapshot.
    // Its birth sequence does not become the current pointer revision. The
    // rights repository verifies the latest change against that exact revision.
    if ((snapshot?.id ?? null)!==artifact.currentRightsSnapshotId || snapshot &&
      (snapshot.artifactId!==artifact.id || snapshot.workspaceId!==artifact.workspaceId ||
        snapshot.snapshotHash!==artifact.currentRightsSnapshot?.snapshotHash || snapshot.sequence>artifact.rightsRevision))
      return conflict('Creation current rights snapshot scope/revision differs')
    const decision=evaluateAssetUse(snapshot,
      {workspaceId:command.workspaceId,use:r.purpose,locale:projectFact.locale},now)
    if (decision.outcome!=='allow') throw new DomainError('ASSET_RIGHTS_BLOCKED','Current rights block copying this inactive reference',
      {artifactId:r.artifactId,use:r.purpose,reasonCodes:decision.reasonCodes})
  }
  if (currentSource !== null) return Object.freeze({schemaVersion:'project-creation-source-facts/v3' as const,
    project:Object.freeze(projectFact),bundle:actualBundle!,snapshots:actualSnapshots,editPlanSnapshot:actualSnapshots.find(r=>r.kind==='edit-plan')!,
    renderablePlanSnapshot:sourceRenderable,references:d.sourceReferences})
  assertDomainHistoricalSource(expected)
  return Object.freeze({project:Object.freeze(projectFact),bundle:expected,editPlanSnapshot:actualSnapshots.find((r)=>r.kind==='edit-plan')!,
    renderablePlanSnapshot:sourceRenderable,references:d.sourceReferences})
}
function assertDomainHistoricalSource(source: import('../../domain/output-version-bundle.ts').OutputVersionBundle | import('../../domain/project-fork-derivation.ts').ProjectForkSourceV3): asserts source is import('../../domain/output-version-bundle.ts').OutputVersionBundle {
  if ('schemaVersion' in source) return conflict('Historical source1 cannot receive a source3 container')
}
export class PrismaCreationOutputBundleRepositoryV2 implements CreationOutputBundleRepositoryV2 {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client=client }
  async read(input: Readonly<{workspaceId:string;projectId:string;versionId:string}>) {
    const anchor=await readPersistedOperationalOutputBundleV3(this.client,input)
    if(!anchor)return null
    if(anchor.schemaVersion!=='project-creation-output-bundle/v2')return conflict('Creation read requested a non-creation Version')
    // Root membership is immutable; later ingest legitimately adds Project
    // links. The reviewed anchor verifies creation-owned facts without treating
    // subsequent media as a mutation of the empty root Command/State.
    if(anchor.command.payload.forkDerivation?.schemaVersion==='project-fork-derivation/v3')return readPersistedForkCreationOutputBundleV3(this.client,input)
    return anchor.command.payload.callerIntent.kind==='initialize-empty'?anchor:
      readPersistedCreationOutputBundleV2(this.client,input)
  }
  async persist(input: CreationOutputBundleWriteV2): Promise<Readonly<{bundle:CreationOutputVersionBundleV2;replayed:boolean}>> {
    const proposal=validateProjectCreationOutputCommandV2(input.proposal)
    const caller=input.forkCallerRequest===undefined?null:validateProjectForkCallerRequestV3(input.forkCallerRequest)
    assertForkCallerBindingV3(proposal,caller)
    const replayFingerprint=caller===null?proposal.requestFingerprint:calculateOutputCanonicalHash(caller)
    if(input.expiresAt!==undefined && (caller===null || !Number.isFinite(Date.parse(input.expiresAt)) ||
      new Date(input.expiresAt).toISOString()!==input.expiresAt || Date.parse(input.expiresAt)-Date.parse(proposal.createdAt)<60000 ||
      Date.parse(input.expiresAt)-Date.parse(proposal.createdAt)>604800000))
      throw new DomainError('INVALID_ARGUMENT','Fork idempotency expiry requires a canonical bounded lifetime')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(input.idempotencyKey) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(input.idempotencyRecordId) ||
      input.eventIds.length!==2 || input.eventIds.some((id)=>typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ||
      new Set(input.eventIds.map((id)=>id.toLowerCase())).size!==2)
      throw new DomainError('INVALID_ARGUMENT','Creation idempotency/event allocation invalid')
    let committed: {projectId:string;versionId:string;replayed:boolean} | undefined
    for (let attempt=0;attempt<3;attempt++) {
      try {
        committed=await this.client.$transaction(async(tx)=>{
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'")
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8000ms'")
          await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',encode([proposal.workspaceId,proposal.author.id,input.idempotencyKey]))
          const existing=await tx.v2IdempotencyRecord.findUnique({where:{workspaceId_clientId_key:{workspaceId:proposal.workspaceId,clientId:proposal.author.id,key:input.idempotencyKey}}})
          if (existing) {
            const ids=readCompletedIdempotencyResponse(existing,replayFingerprint)
            if (Object.keys(ids).sort().join('|')!=='projectId|versionId'||
              typeof ids.projectId!=='string'||typeof ids.versionId!=='string'||
              !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(ids.projectId)||
              !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(ids.versionId))return conflict('Creation replay identity invalid')
            return {projectId:ids.projectId,versionId:ids.versionId,replayed:true}
          }
          const facts=await sourceFacts(tx,proposal)
          const command=validateProjectCreationOutputCommandV2(input.recompose(facts))
          assertCreationRecompositionV2(proposal,command)
          // Validate the reconstituted facts again; no obsolete prepared bundle
          // survives retry and no provider/compiler executes inside this callback.
          await sourceFacts(tx,command)
          const bundle=buildCreationOutputVersionBundleV2(command), s=bundle.state.document, v=bundle.version, p=command.payload,
            fork=p.forkDerivation, kernel=fork?.document.kernel.document, date=new Date(command.createdAt), policy='output-canonical-json/v1'
          const metadata=creationProjectMetadataV2(command)
          await insert(tx,'projects',{id:command.projectId,workspaceId:command.workspaceId,...metadata,status:'draft',currentVersionId:null,
            duplicatedFromProjectId:kernel?.source.version.projectId ?? null,creationContractVersion:2,createdByType:'api-client',createdById:command.author.id,createdAt:date,updatedAt:date})
          for (const snapshot of p.snapshots) await insert(tx,'project_snapshots',{id:snapshot.id,workspaceId:snapshot.workspaceId,projectId:snapshot.projectId,kind:snapshot.kind,
            schemaVersion:snapshot.contentSchemaVersion,contentJson:snapshot.contentJson,contentHash:snapshot.contentHash,createdAt:new Date(snapshot.createdAt)})
          const snapshotRefs=p.allocations.snapshotRefs
          await persistCreationVersionV2(tx,bundle,kernel?{projectId:kernel.source.version.projectId,versionId:kernel.source.version.id}:null)
          const {commandHash:_commandHash,payload:_payload,audit:_audit,author:_author,...commandBody}=command
          void _commandHash;void _payload;void _audit;void _author
          const historicOwned=fork?.schemaVersion==='project-fork-derivation/v2'?forkOwnedIdentities(fork.document.kernel.document.source,fork.document.kernel.document.sourceRenderablePlanSnapshot):[]
          const sourceBaseline = fork?.schemaVersion==='project-fork-derivation/v3'?forkCreationSourceBaselineV3(fork):kernel ? {workspaceId:kernel.source.version.workspaceId,projectId:kernel.source.version.projectId,versionId:kernel.source.version.id,
            baseHash:kernel.source.version.baseHash,stateId:kernel.source.state.document.id,stateHash:kernel.source.state.stateHash,
            snapshots:[kernel.source.nonOutputSnapshotFacts.brief,kernel.source.nonOutputSnapshotFacts.policies,kernel.source.nonOutputSnapshotFacts.treatment,kernel.source.nonOutputSnapshotFacts.story,fork!.document.sourceEditPlanSnapshot]
              .filter((r)=>r!==null).map((r)=>({kind:r.kind,id:r.id,hash:r.contentHash})),
            renderablePlanSnapshot:kernel.sourceRenderablePlanSnapshot,ownedIdentities:historicOwned.toSorted((a,b)=>Buffer.compare(Buffer.from(a.kind+':'+a.id),Buffer.from(b.kind+':'+b.id))),sourceProject:fork!.document.sourceProject,
            sourceReferences:fork!.document.sourceReferences.map(({targetLinkId,...fact})=>{void targetLinkId;return fact})} : null
          const requestBody={canonicalPolicyVersion:policy,schemaVersion:'project-creation-output-request/v2',workspaceId:command.workspaceId,
            callerIntent:p.callerIntent,actorContextHash:command.actorContextHash,sourceBaseline}
          if (calculateOutputCanonicalHash(requestBody)!==command.requestFingerprint) return conflict('Creation request body differs from constructor authority')
          await insert(tx,'project_creation_commands',{id:command.id,workspaceId:command.workspaceId,projectId:command.projectId,versionId:v.id,action:kernel?'duplicate':'create',
            sourceProjectId:kernel?.source.version.projectId ?? null,sourceVersionId:kernel?.source.version.id ?? null,actorClientId:command.audit.clientId,actorCredentialId:command.audit.credentialId,
            actorEnvironment:command.audit.environment,actorAuthenticationKind:command.audit.authenticationKind,actorContextHash:command.actorContextHash,
            actorDelegatedUserId:command.audit.delegatedUserId ?? null,actorDelegatedIdentityId:command.audit.delegatedIdentityId ?? null,actorWorkspaceRole:command.audit.workspaceRole ?? null,
            requestFingerprint:command.requestFingerprint,commandHash:command.commandHash,createdAt:date,schemaVersion:2,canonicalPolicyVersion:policy,commandJson:encode(command),
            commandBodyJson:encode(commandBody),payloadJson:encode(p),payloadHash:command.payloadHash,requestJson:encode(requestBody),forkDerivationId:fork?.document.id ?? null,forkDerivationHash:fork?.derivationHash ?? null})
          if (fork && kernel) {
            await insert(tx,'project_fork_derivations',{id:fork.document.id,workspaceId:command.workspaceId,sourceProjectId:kernel.source.version.projectId,sourceVersionId:kernel.source.version.id,
              sourceStateId:kernel.source.state.document.id,sourceStateHash:kernel.source.state.stateHash,sourceBaseHash:kernel.source.version.baseHash,targetProjectId:command.projectId,targetVersionId:v.id,
              targetStateId:s.id,creationCommandId:command.id,schemaVersion:fork.schemaVersion,canonicalPolicyVersion:policy,derivationJson:encode(fork.document),derivationHash:fork.derivationHash,createdAt:date})
            for (const r of fork.document.sourceReferences) await insert(tx,'project_media_assets',{id:r.targetLinkId,workspaceId:command.workspaceId,projectId:command.projectId,artifactId:r.artifactId,
              uploadId:null,role:r.role,originalFileName:r.originalFileName,createdAt:date})
          }
          if (p.renderableCandidate) {
            const r=p.renderableCandidate
            await insert(tx,'project_fork_renderable_candidates',{id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,projectVersionId:r.projectVersionId,derivationId:r.derivationRef.id,
              derivationHash:r.derivationRef.hash,planId:r.planId,planHash:r.planHash,planHashJson:r.planHashJson,candidateJson:encode(r),candidateHash:calculateOutputCanonicalHash(r),createdAt:date})
          }
          await insert(tx,'project_output_states',{id:s.id,workspaceId:s.workspaceId,projectId:s.projectId,resultVersionId:v.id,schemaVersion:s.schemaVersion,canonicalPolicyVersion:policy,
            transition:s.transition,transitionPolicyVersion:s.transitionPolicyVersion,producerKind:s.provenance.kind,producerId:command.id,provenanceHash:command.commandHash,producerHash:s.producer.hash,producerJson:encode(s.producer.document),
            editPlanSnapshotId:s.editPlan.snapshotId,editPlanHash:s.editPlan.hash,editPlanAuthorityJson:encode(s.editPlan.authority.document),editPlanAuthorityHash:s.editPlan.authority.hash,
            creationCommandV2Id:command.id,forkRenderableCandidateId:p.renderableCandidate?.id ?? null,consumptionStatus:'blocked',consumptionJson:encode(s.consumption),stateJson:encode(s),stateHash:bundle.state.stateHash,createdAt:date})
          for (const entry of s.entries) {
            const spec=entry.spec
            await insert(tx,'output_variants',{id:entry.variantId,workspaceId:s.workspaceId,projectId:s.projectId,createdCommandKind:s.provenance.kind,createdCommandId:command.id,createdCommandHash:command.commandHash,createdAt:date})
            await insert(tx,'output_spec_revisions',{id:spec.id,variantId:spec.variantId,workspaceId:spec.workspaceId,projectId:spec.projectId,revisionNumber:1,schemaVersion:spec.schemaVersion,
              canonicalPolicyVersion:policy,specJson:encode(spec),specHash:entry.specHash,createdCommandKind:s.provenance.kind,createdCommandId:command.id,createdCommandHash:command.commandHash,createdAt:date})
            await insert(tx,'project_output_state_entries',{stateId:s.id,variantId:entry.variantId,projectId:s.projectId,workspaceId:s.workspaceId,outputSpecRevisionId:entry.outputSpecRevisionId,specHash:entry.specHash,
              canonicalPolicyVersion:policy,geometryStatus:'blocked-v2',geometryProjectionHash:null,entryJson:encode(entry),entryHash:calculateOutputCanonicalHash(entry)})
          }
          for (const crop of s.overlays) await insert(tx,'project_fork_crop_decisions',{id:crop.id,stateId:s.id,workspaceId:s.workspaceId,projectId:s.projectId,variantId:crop.variantId,clipId:crop.clipId,creationCommandId:command.id,
            sourceOverlayId:crop.sourceOverlayId,sourceOverlayHash:crop.sourceOverlayHash,status:crop.status,decisionJson:encode(crop),decisionHash:calculateOutputCanonicalHash(crop),createdAt:date})
          for (const issue of s.invalidations) await insert(tx,'project_fork_invalidation_lineage',{id:issue.id,stateId:s.id,workspaceId:s.workspaceId,projectId:s.projectId,variantId:issue.variantId,
            sourceId:issue.sourceId,sourceHash:issue.sourceHash,lineageJson:encode(issue),lineageHash:calculateOutputCanonicalHash(issue)})
          const moved=await tx.$executeRawUnsafe('UPDATE projects SET "currentVersionId"=$1 WHERE id=$2 AND "workspaceId"=$3 AND "currentVersionId" IS NULL AND "creationContractVersion"=2',v.id,s.projectId,s.workspaceId)
          if (moved!==1) throw new DomainError('VERSION_CONFLICT','Creation head CAS failed')
          for (const [i,type] of ['project.created','project.version.created'].entries()) {
            const event=createPublicEvent({id:input.eventIds[i],workspaceId:command.workspaceId,type,version:'1.0.0',occurredAt:command.createdAt,
              ...(i===1?{sequence:v.sequence}:{}),actor:{clientId:command.author.id,...(command.audit.delegatedUserId?{userId:command.audit.delegatedUserId}:{})},
              resource:{type:i===0?'project':'project-version',id:i===0?command.projectId:v.id},data:{projectId:command.projectId,versionId:v.id}})
            await tx.v2PublicEventOutbox.create({data:{id:event.id,workspaceId:event.workspaceId,type:event.type,version:event.version,occurredAt:new Date(event.occurredAt),
              sequence:event.sequence,actorClientId:event.actor?.clientId,actorUserId:event.actor?.userId,resourceType:event.resource.type,resourceId:event.resource.id,dataJson:JSON.stringify(event.data)}})
          }
          await insert(tx,'idempotency_records',{id:input.idempotencyRecordId,workspaceId:command.workspaceId,clientId:command.author.id,key:input.idempotencyKey,requestFingerprint:replayFingerprint,
            status:'completed',responseStatus:201,responseJson:JSON.stringify({projectId:command.projectId,versionId:v.id}),createdAt:date,updatedAt:date,expiresAt:new Date(input.expiresAt??date.getTime()+86400000)})
          // ALL is the LAST write/constraint mode operation after every audit,
          // CAS, outbox and idempotency write. Nothing can re-defer afterwards.
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
          // A potentially expensive deferred flush is also a query: read the
          // last PG authority clock afterwards. These are read/lock operations
          // only; no write or re-defer can occur after ALL.
          await sourceFacts(tx,command)
          return {projectId:command.projectId,versionId:v.id,replayed:false}
        },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:10000,timeout:30000})
        break
      } catch(error) {
        if (retryable(error) && attempt<2) continue
        if (retryable(error)) return conflict('Creation full bundle serialization retries exhausted')
        throw error
      }
    }
    if (!committed) return conflict('Creation full bundle did not commit')
    // Resolving the transaction callback is not COMMIT. This read occurs only
    // after the real Prisma transaction promise resolves, outside its callback.
    const bundle=await this.read({workspaceId:proposal.workspaceId,projectId:committed.projectId,versionId:committed.versionId})
    if (!bundle) return conflict('Creation committed bundle readback missing')
    if(caller!==null)assertForkCallerBindingV3(bundle.command,caller)
    else if (bundle.command.requestFingerprint!==proposal.requestFingerprint) return conflict('Creation committed request identity differs')
    return Object.freeze({bundle,replayed:committed.replayed})
  }
}


import type { OperationalOutputBundleRepositoryV3, OperationalOutputBundleWriteV3 } from '../../application/ports/output-version-bundle-repository.ts'
import { buildOperationalOutputVersionBundleV3, type OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import { persistCreationVersionV2, persistOutputVersionBundleInTransactionV3, persistOperationalIngestFactsInTransactionV3 } from './output-version-bundle-persistence.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { readOutputNormalizationsV3, assertCurrentOutputSourceUseV3, readEditorialSourceBindingV1 } from './output-version-materializer.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { createEditorialCutInvalidations } from '../../domain/editorial-cut-impact.ts'
import { createCommandArtifactInvalidations } from '../../domain/command-impact.ts'
import { externalActorAuditData } from './external-actor-audit.ts'
import { persistPublicEvents } from './public-event-outbox.ts'
import { readVersionRenderReferences } from './version-render-references.ts'

function fixedRecompositionV3(before:OperationalOutputBundleWriteV3['proposal'],after:OperationalOutputBundleWriteV3['proposal']) {
  if(!identical(before.allocation,after.allocation) || !identical(before.materializationIds,after.materializationIds) ||
    before.editPlanSnapshot.id!==after.editPlanSnapshot.id || before.editPlanSnapshot.createdAt!==after.editPlanSnapshot.createdAt ||
    stableSerialize(before.origin)!==stableSerialize(after.origin))
    conflict('Operational recomposition changed allocations/actor/clock/origin')
}
async function assertIngestFenceV3(tx:Tx,input:OperationalOutputBundleWriteV3['proposal']) {
  if(input.origin.kind!=='ingest-operation')return
  const o=input.origin.operation
  const rows=await tx.$queryRawUnsafe<Array<{status:string;phase:string;attempt:number;leaseOwner:string|null;leaseExpiresAt:Date|null;
    requestFingerprint:string;clientId:string;targetType:string;targetId:string;sourceArtifactId:string;sourceManifestId:string;uploadId:string}>>(
    'SELECT o.status,o.phase,o.attempt,o."leaseOwner",o."leaseExpiresAt",o."requestFingerprint",o."clientId",o."targetType",o."targetId",i."sourceArtifactId",i."sourceManifestId",i."uploadId"::text FROM public_operations o JOIN media_ingest_operations i ON i."operationId"=o.id AND i."workspaceId"=o."workspaceId" AND i."projectId"=o."projectId" WHERE o.id=$1 AND o."projectId"=$2 AND o."workspaceId"=$3',
    o.id,o.projectId,o.workspaceId)
  const now=await clock(tx),r=rows[0]
  if(o.target.type!=='media-artifact' || rows.length!==1 || r.status!=='running' || r.phase!=='persisting' || r.attempt!==o.attempt ||
    r.leaseOwner!==input.origin.leaseOwner || !r.leaseExpiresAt || r.leaseExpiresAt<=now ||
    r.requestFingerprint!==input.origin.requestFingerprint || r.clientId!==o.clientId || r.targetType!==o.target.type || r.targetId!==o.target.id ||
    r.sourceArtifactId!==input.origin.detail.sourceArtifactId || r.sourceManifestId!==input.origin.detail.sourceManifestId ||
    r.sourceManifestId!==o.target.manifestId ||
    r.uploadId!==input.origin.detail.uploadId)throw new DomainError('VERSION_CONFLICT','Operational ingest fence lost')
}

export async function assertManualOutputReferencesV3(tx:Tx,b:OperationalOutputVersionBundleV3) {
  if(b.origin.kind!=='inherit-command'&&b.origin.kind!=='restore-command')return
  const c=b.origin.command,impact=c.payload.impact
  if(b.origin.kind==='inherit-command')return // Real select impact contains no affected outputs.
  // A restore, undo or redo returns the plan to an earlier one, and the plan is shared: the renders of EVERY output of the base
  // Version go stale, proxies and published finals alike. Each is attributed to its own output by the stable variant it was enqueued
  // with (a legacy row that cannot be attributed exactly is a PERSISTENCE_CONFLICT, never a guess), in the State that Version seals:
  // the child of a restore carries the outputs of its target, which are not necessarily its parent's.
  const actual=await readVersionRenderReferences(tx,{workspaceId:b.version.workspaceId,projectId:b.version.projectId,
    versionId:c.baseVersionId})
  const texts=(values:readonly unknown[])=>values.map(v=>stableSerialize(v)).sort()
  if(stableSerialize(texts(actual))!==stableSerialize(texts(impact!.affectedArtifacts)))
    throw new DomainError('INVALID_COMMAND','Manual output references differ from persisted base outputs')
}
async function persistManualInvalidationsV3(tx:Tx,b:OperationalOutputVersionBundleV3) {
  if(b.origin.kind!=='inherit-command'&&b.origin.kind!=='restore-command')return
  const c=b.origin.command,rows=createCommandArtifactInvalidations({impact:c.payload.impact!,createdAt:c.createdAt})
  if(!rows.length)return
  await tx.v2CommandArtifactInvalidation.createMany({data:rows.map(r=>({id:r.id,workspaceId:b.version.workspaceId,projectId:b.version.projectId,
    commandId:r.commandId,baseVersionId:r.baseVersionId,resultVersionId:r.resultVersionId,artifactId:r.artifactId,kind:r.kind,variantId:r.variantId,
    status:r.status,dependencyTypesJson:stableSerialize(r.dependencyTypes),affectedRangesJson:stableSerialize(r.affectedRanges),
    impactHash:r.impactHash,createdAt:new Date(r.createdAt)}))})
}
async function persistEditorialInvalidationsV3(tx:Tx,b:OperationalOutputVersionBundleV3) {
  if(b.origin.kind!=='editorial-cut-command')return
  const c=b.origin.command
  // The cut changes the shared plan: every render of the base Version, every output's proxies and published finals, goes stale.
  const actual=(await readVersionRenderReferences(tx,{workspaceId:b.version.workspaceId,projectId:b.version.projectId,
    versionId:c.baseVersionId})).map(o=>stableSerialize(o)).sort()
  if(stableSerialize(actual)!==stableSerialize(c.payload.impact.affectedArtifacts.map(o=>stableSerialize(o)).sort()))
    throw new DomainError('VERSION_CONFLICT','Editorial output inventory changed')
  const rows=createEditorialCutInvalidations({impact:c.payload.impact,createdAt:c.createdAt})
  if(rows.length)await tx.v2CommandArtifactInvalidation.createMany({data:rows.map(r=>({id:r.id,workspaceId:b.version.workspaceId,projectId:b.version.projectId,
    commandId:r.commandId,baseVersionId:r.baseVersionId,resultVersionId:r.resultVersionId,artifactId:r.artifactId,kind:r.kind,variantId:r.variantId,
    status:r.status,dependencyTypesJson:stableSerialize(r.dependencyTypes),affectedRangesJson:stableSerialize(r.affectedRanges),impactHash:r.impactHash,createdAt:new Date(r.createdAt)}))})
}
/** Dedicated child owner for the reviewed slice. The sixteen product writers
 * must call the transaction helper within their existing complete owners; this
 * class never wraps a partly committed writer or claims rollback of earlier TXs. */
export class PrismaOperationalOutputBundleRepositoryV3 implements OperationalOutputBundleRepositoryV3 {
  private readonly client:PrismaClient
  constructor(client:PrismaClient) {this.client=client}
  read(input:Parameters<OperationalOutputBundleRepositoryV3['read']>[0]) {
    return readPersistedOperationalOutputBundleV3(this.client,input)
  }
  async persistChild(input:OperationalOutputBundleWriteV3) {
    const initial=input.proposal,a=initial.allocation
    externalActorAuditData(input.audit,a.workspaceId,a.createdBy)
    const createEvent=(id:string,type:string,resourceType:string,resourceId:string,data:Record<string,string|number>)=>
      createPublicEvent({id,type,version:'1.0.0',workspaceId:a.workspaceId,occurredAt:a.createdAt,sequence:a.sequence,
        actor:{clientId:a.createdBy,...(input.audit.delegatedUserId?{userId:input.audit.delegatedUserId}:{})},resource:{type:resourceType,id:resourceId},data})
    const versionEvent=createEvent(input.versionEventId,'project.version.created','project-version',a.resultVersionId,
      {projectId:a.projectId,versionId:a.resultVersionId,sequence:a.sequence})
    if((initial.origin.kind==='ingest-operation')!==(input.operationEventId!==null)||
      (initial.origin.kind==='ingest-operation')!==(input.ingestFacts!==null))
      conflict('Operational event allocation differs from typed origin')
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const result=await this.client.$transaction(async(tx)=>{
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10000ms'")
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout='8000ms'")
          if(initial.origin.kind==='editorial-cut-command') {
            const o=initial.origin,c=o.command
            await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',
              encode([a.workspaceId,a.projectId,c.idempotencyKey]))
            const prior=await tx.v2EditCommand.findUnique({where:{workspaceId_projectId_idempotencyKey:{
              workspaceId:a.workspaceId,projectId:a.projectId,idempotencyKey:c.idempotencyKey}}})
            if(prior) {
              if(prior.requestFingerprint!==o.requestFingerprint||prior.actorContextHash!==input.audit.contextHash||prior.type!==c.type)
                throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH','Editorial key belongs to a different intent or actor')
              const children=await tx.v2ProjectVersion.findMany({where:{workspaceId:a.workspaceId,projectId:a.projectId,commandId:prior.id},select:{id:true},take:2})
              if(children.length!==1)conflict('Editorial replay lacks one committed child')
              const replay=await this.readWithTransaction(tx,{workspaceId:a.workspaceId,projectId:a.projectId,versionId:children[0]!.id})
              if(replay?.schemaVersion!=='operational-output-version-bundle/v3'||replay.origin.kind!=='editorial-cut-command'||
                replay.origin.requestFingerprint!==o.requestFingerprint||replay.origin.command.id!==prior.id)conflict('Editorial replay receipt differs')
              return {bundle:replay,replayed:true}
            }
            // Both project locks precede every source/artifact lock. Immutable
            // source Version is exact; mutable source head is never substituted.
            const projects=[...new Set([a.projectId,o.command.payload.sourceBinding.document.authority.sourceProjectId])]
              .sort((x,y)=>Buffer.compare(Buffer.from(x),Buffer.from(y)))
            const locked=await tx.$queryRawUnsafe<Array<{id:string;status:string}>>('SELECT id,status FROM projects WHERE "workspaceId"=$1 AND id IN ('+
              projects.map((_,i)=>'$'+(i+2)).join(',')+') ORDER BY id COLLATE "C" FOR UPDATE',a.workspaceId,...projects)
            if(locked.length!==projects.length||locked.some(p=>p.status==='archived'))throw new DomainError('VERSION_CONFLICT','Editorial source/target lifecycle changed')
          }
          if(initial.origin.kind==='create-output-variant'||initial.origin.kind==='revise-output-spec') {
            const result=initial.origin.result,c=result.command
            // HTTP retries allocate fresh child identities. Serialize by the
            // existing Command key BEFORE head admission, never by allocation.
            await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',
              encode([a.workspaceId,a.projectId,c.idempotencyKey]))
            const prior=await tx.v2EditCommand.findUnique({where:{workspaceId_projectId_idempotencyKey:{
              workspaceId:a.workspaceId,projectId:a.projectId,idempotencyKey:c.idempotencyKey}}})
            if(prior) {
              if(prior.requestFingerprint!==result.requestFingerprint||prior.actorContextHash!==input.audit.contextHash||prior.type!==c.type)
                throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH','Output Command idempotency key belongs to different intent or actor')
              const children=await tx.v2ProjectVersion.findMany({where:{workspaceId:a.workspaceId,projectId:a.projectId,
                commandId:prior.id},select:{id:true},take:2})
              if(children.length!==1)conflict('Output Command replay lacks one committed child')
              const replay=await this.readWithTransaction(tx,{workspaceId:a.workspaceId,projectId:a.projectId,versionId:children[0]!.id})
              if(!replay||replay.schemaVersion!=='operational-output-version-bundle/v3'||
                replay.origin.kind!==initial.origin.kind||
                !('result' in replay.origin)||replay.origin.result.requestFingerprint!==result.requestFingerprint||
                replay.origin.result.command.id!==prior.id)conflict('Output Command replay seal differs')
              return {bundle:replay,replayed:true}
            }
          }
          if(initial.origin.kind==='ingest-operation') {
            const op=initial.origin.operation
            const locked=await tx.$queryRawUnsafe<Array<{id:string}>>(
              'SELECT id FROM public_operations WHERE id=$1 AND "projectId"=$2 AND "workspaceId"=$3 FOR UPDATE',
              op.id,a.projectId,a.workspaceId)
            if(locked.length!==1)throw new DomainError('VERSION_CONFLICT','Operational ingest operation missing')
            await tx.$queryRawUnsafe('SELECT "operationId" FROM media_ingest_operations WHERE "operationId"=$1 AND "workspaceId"=$2 FOR UPDATE',op.id,a.workspaceId)
          }
          const held=await tx.$queryRawUnsafe<Array<{id:string;currentVersionId:string|null}>>(
            'SELECT id,"currentVersionId" FROM projects WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE',a.projectId,a.workspaceId)
          if(held.length!==1)throw new DomainError('VERSION_CONFLICT','Operational project missing')
          const existing=await this.readWithTransaction(tx,{workspaceId:a.workspaceId,projectId:a.projectId,versionId:a.resultVersionId})
          if(existing) {
            if(existing.schemaVersion!=='operational-output-version-bundle/v3' ||
              stableSerialize(existing.origin)!==stableSerialize(initial.origin) || existing.state.document.id!==a.stateId)
              conflict('Operational allocation collided with another bundle')
            return {bundle:existing,replayed:true}
          }
          if(held[0].currentVersionId!==a.parentVersionId)throw new DomainError('VERSION_CONFLICT','Operational head changed')
          const parent=await this.readWithTransaction(tx,{workspaceId:a.workspaceId,projectId:a.projectId,versionId:a.parentVersionId!})
          if(!parent)throw new DomainError('VERSION_CONFLICT','Operational parent missing')
          const target=initial.restoreTarget?await this.readWithTransaction(tx,{workspaceId:a.workspaceId,projectId:a.projectId,
            versionId:initial.restoreTarget.version.id}):null
          await assertIngestFenceV3(tx,initial)
          if(input.ingestFacts)await persistOperationalIngestFactsInTransactionV3(tx,input.ingestFacts)
          if(initial.origin.kind==='editorial-cut-command') {
            await readEditorialSourceBindingV1(tx,initial.origin.command.payload.sourceBinding,{lock:true,currentRights:true})
            const binding=initial.origin.command.payload.sourceBinding.document
            const original=await this.readWithTransaction(tx,{workspaceId:a.workspaceId,projectId:binding.authority.sourceProjectId,versionId:binding.authority.sourceVersionId})
            if(!original||original.version.baseHash!==binding.authority.sourceBaseHash||original.state.stateHash!==binding.authority.sourceStateHash||
              original.state.document.id!==binding.authority.sourceStateId)conflict('Editorial immutable source receipt differs')
          }
          const normalizations=[] as import('../../domain/output-materialization.ts').SealedOutputNormalizationV3[]
          if(initial.origin.kind==='editorial-cut-command') {
            for(const ref of initial.origin.command.payload.sourceBinding.document.normalizationRefs)normalizations.push(...await readOutputNormalizationsV3(tx,{
              workspaceId:a.workspaceId,projectId:ref.projectId,ids:[ref.id],lock:false}))
          } else normalizations.push(...await readOutputNormalizationsV3(tx,{workspaceId:a.workspaceId,projectId:a.projectId,ids:initial.normalizations.map(n=>n.document.id),lock:true}))
          await assertIngestFenceV3(tx,initial)
          const recomposed=input.recompose({parent,restoreTarget:target,normalizations})
          fixedRecompositionV3(initial,recomposed)
          const bundle=buildOperationalOutputVersionBundleV3(recomposed)
          await assertCurrentOutputSourceUseV3(tx,bundle)
          await assertManualOutputReferencesV3(tx,bundle)
          if(bundle.origin.kind!=='ingest-operation') {
            const result=bundle.origin.kind==='create-output-variant'||bundle.origin.kind==='revise-output-spec'?bundle.origin.result:null
            const c=result?.command??('command' in bundle.origin?bundle.origin.command:null)
            if(!c)return conflict('Operational Command missing')
            const {commandHash:_hash,...body}=c,audit=externalActorAuditData(input.audit,a.workspaceId,c.author.id)
            await tx.v2EditCommand.create({data:{id:c.id,workspaceId:c.workspaceId,projectId:c.projectId,baseVersionId:c.baseVersionId,
              baseHash:c.baseHash,type:c.type,scopeJson:stableSerialize(c.scope),payloadJson:stableSerialize(c.payload),reason:c.reason??null,
              actorType:c.author.type,actorId:c.author.id,delegatedUserId:c.author.delegatedUserId??null,
              actorCredentialId:audit.actorCredentialId,actorEnvironment:audit.actorEnvironment,actorAuthenticationKind:audit.actorAuthenticationKind,
              actorContextHash:audit.actorContextHash,actorDelegatedIdentityId:audit.delegatedIdentityId??null,actorWorkspaceRole:audit.workspaceRole??null,
              idempotencyKey:c.idempotencyKey,requestFingerprint:result?.requestFingerprint??('requestFingerprint' in bundle.origin?bundle.origin.requestFingerprint:conflict('Manual request authority missing')),commandHash:c.commandHash,commandJson:stableSerialize(body),
              outputPayloadJson:result||bundle.origin.kind==='editorial-cut-command'?encode(c.payload):null,outputPayloadHash:result||bundle.origin.kind==='editorial-cut-command'?calculateOutputCanonicalHash(c.payload):null,
              createdAt:new Date(c.createdAt)}})
          }
          await persistOutputVersionBundleInTransactionV3(tx,bundle)
          await persistManualInvalidationsV3(tx,bundle)
          if(bundle.origin.kind==='editorial-cut-command')await persistEditorialInvalidationsV3(tx,bundle)
          // A video ingest took the project to `ingesting` when it was admitted; the Version that records its result is also what
          // returns it to `draft` (the head is already known to be the parent: only the status can make this CAS miss).
          const completesIngest=bundle.origin.kind==='ingest-operation'
          const cas=await tx.v2Project.updateMany({where:{id:a.projectId,workspaceId:a.workspaceId,currentVersionId:a.parentVersionId,
            ...(completesIngest?{status:{in:projectStatusTransitionPath('ingesting','draft',{includeSame:true})}}:{})},
            data:{currentVersionId:a.resultVersionId,...(completesIngest?{status:'draft'}:{})}})
          if(cas.count!==1)throw completesIngest?new DomainError('PROJECT_TRANSITION_REJECTED','Project cannot complete ingest from its current status'):
            new DomainError('VERSION_CONFLICT','Operational head CAS failed')
          const editorialEvent=bundle.origin.kind==='editorial-cut-command'?createPublicEvent({id:input.versionEventId,
            type:'project.version.created',version:'1.0.0',workspaceId:a.workspaceId,occurredAt:a.createdAt,sequence:bundle.version.sequence,
            actor:{clientId:a.createdBy,...(input.audit.delegatedUserId?{userId:input.audit.delegatedUserId}:{})},
            resource:{type:'project-version',id:bundle.version.id},data:{projectId:a.projectId,sequence:bundle.version.sequence,
              parentVersionId:bundle.version.parentVersionId,baseHash:bundle.version.baseHash,commandId:bundle.origin.command.id,
              commandType:bundle.origin.command.type,commandImpactHash:bundle.origin.command.payload.impact.impactHash,
              invalidatedArtifactCount:bundle.origin.command.payload.impact.affectedArtifacts.length,snapshotRefs:bundle.version.snapshotRefs,createdAt:a.createdAt}}):null
          await persistPublicEvents(tx,[editorialEvent??versionEvent])
          // Read all authority first; clock_timestamp is acquired immediately
          // before the synchronous fence evaluation, after the final writes.
          await assertIngestFenceV3(tx,recomposed)
          if(bundle.origin.kind==='ingest-operation') {
            const o=bundle.origin.operation,now=await clock(tx)
            const changed=await tx.v2PublicOperation.updateMany({where:{id:o.id,workspaceId:a.workspaceId,projectId:a.projectId,
              status:'running',phase:'persisting',attempt:o.attempt,leaseOwner:bundle.origin.leaseOwner,leaseExpiresAt:{gt:now}},
              data:{status:'succeeded',phase:'completed',progressCompleted:6,progressTotal:6,progressUnit:'stage',
                cancelable:false,retryable:false,completedAt:now,updatedAt:now,leaseOwner:null,leaseExpiresAt:null,
                heartbeatAt:null,
                resultJson:stableSerialize({resource:o.target})}})
            if(changed.count!==1)throw new DomainError('VERSION_CONFLICT','Operational ingest terminal fence lost')
            await persistPublicEvents(tx,[createEvent(input.operationEventId!,'operation.succeeded','operation',o.id,
              {projectId:a.projectId,versionId:a.resultVersionId})])
          }
          // LAST write in this owner. No re-DEFER or write follows it.
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
          await assertCurrentOutputSourceUseV3(tx,bundle)
          if(bundle.origin.kind==='editorial-cut-command')await readEditorialSourceBindingV1(tx,bundle.origin.command.payload.sourceBinding,{lock:false,currentRights:true})
          return {bundle,replayed:false}
        },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:3000,timeout:30000})
        const actual=await this.read({workspaceId:a.workspaceId,projectId:a.projectId,versionId:result.bundle.version.id})
        if(!actual || actual.schemaVersion!=='operational-output-version-bundle/v3' ||
          actual.version.baseHash!==result.bundle.version.baseHash || actual.state.stateHash!==result.bundle.state.stateHash)
          return conflict('Operational committed bundle readback missing')
        return Object.freeze({bundle:actual,replayed:result.replayed})
      } catch(error) {if(retryable(error)&&attempt<2)continue;throw error}
    }
    return conflict('Operational serialization retry exhausted')
  }
  private readWithTransaction(tx:Tx,input:Parameters<OperationalOutputBundleRepositoryV3['read']>[0]) {
    return readPersistedOperationalOutputBundleV3(tx,input)
  }
}
