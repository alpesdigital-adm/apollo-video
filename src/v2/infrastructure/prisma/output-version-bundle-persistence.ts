import type { Prisma } from '../../../../generated/prisma-v2/index.js'
import { createHash } from 'node:crypto'
import { DomainError } from '../../domain/errors.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { serializeOutputCanonicalJson } from '../../domain/output-canonical-policy.ts'
import type { OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'

export type OutputBundleTransactionV3=Pick<Prisma.TransactionClient,'$executeRawUnsafe'|'$queryRawUnsafe'>
const encode=serializeOutputCanonicalJson
const sha=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex')
async function insert(tx:OutputBundleTransactionV3,table:string,data:Record<string,unknown>) {
  const keys=Object.keys(data)
  await tx.$executeRawUnsafe('INSERT INTO "'+table+'" ('+keys.map(k=>'"'+k+'"').join(',')+
    ') VALUES ('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',...Object.values(data))
}
/** Inserts no head/event/audit/operation. No flush, nested transaction or commit:
 * each real writer must finish ALL of its own writes, flush once, await the
 * actual COMMIT, then read back. This helper cannot confer terminal success. */
export async function persistOutputVersionBundleInTransactionV3(tx:OutputBundleTransactionV3,b:OperationalOutputVersionBundleV3):Promise<void> {
  const v=b.version,s=b.state.document
  for(const snapshot of b.snapshots) {
    const rows=await tx.$queryRawUnsafe<Array<{contentJson:string;contentHash:string;schemaVersion:number;kind:string;createdAt:Date}>>(
      'SELECT "contentJson","contentHash","schemaVersion",kind,"createdAt" FROM project_snapshots WHERE id=$1 AND "projectId"=$2 AND "workspaceId"=$3 FOR SHARE',
      snapshot.id,v.projectId,v.workspaceId)
    if(rows.length===1) {
      const r=rows[0]
      if(r.contentJson!==snapshot.contentJson || r.contentHash!==snapshot.contentHash || r.schemaVersion!==snapshot.contentSchemaVersion ||
        r.kind!==snapshot.kind || r.createdAt.toISOString()!==snapshot.createdAt)
        throw new DomainError('PERSISTENCE_CONFLICT','Operational snapshot factual identity collided')
    } else if(rows.length===0) await insert(tx,'project_snapshots',{id:snapshot.id,workspaceId:v.workspaceId,projectId:v.projectId,
      kind:snapshot.kind,schemaVersion:snapshot.contentSchemaVersion,contentJson:snapshot.contentJson,contentHash:snapshot.contentHash,
      createdAt:new Date(snapshot.createdAt)})
    else throw new DomainError('PERSISTENCE_CONFLICT','Operational snapshot identity ambiguous')
  }
  if(b.origin.kind==='create-output-variant'||b.origin.kind==='revise-output-spec') {
    const c=b.origin.result.command,r=c.payload.revision
    if(b.origin.kind==='create-output-variant')await insert(tx,'output_variants',{id:r.variantId,projectId:v.projectId,workspaceId:v.workspaceId,
      createdCommandKind:'edit-command',createdCommandId:c.id,createdCommandHash:c.commandHash,createdAt:new Date(c.createdAt)})
    await insert(tx,'output_spec_revisions',{id:r.id,variantId:r.variantId,projectId:v.projectId,workspaceId:v.workspaceId,
      revisionNumber:r.revisionNumber,schemaVersion:r.schemaVersion,canonicalPolicyVersion:r.canonicalPolicyVersion,specJson:encode(r),
      specHash:c.payload.revisionSpecHash,createdCommandKind:'edit-command',createdCommandId:c.id,createdCommandHash:c.commandHash,
      createdAt:new Date(r.createdAt)})
  }
  for(const entry of s.entries) {
    if(entry.consumption.status!=='materialized')continue
    const m=entry.consumption.materialization,d=m.document
    await insert(tx,'output_materializations',{id:d.id,workspaceId:v.workspaceId,projectId:v.projectId,resultVersionId:v.id,
      variantId:entry.variantId,outputSpecRevisionId:entry.outputSpecRevisionId,specHash:entry.specHash,
      planSnapshotId:s.editPlan.snapshotId,planHash:s.editPlan.hash,materializationJson:encode(d),materializationHash:m.materializationHash,
      createdAt:new Date(d.createdAt)})
    // Derived observations remain in their original scoped rows. Their new
    // immutable sourceBinding carries explicit refs; never forge a target join.
    if(d.schemaVersion==='output-materialization/v3')for(const normalization of d.normalizations)await insert(tx,'output_materialization_normalizations',{
      materializationId:d.id,normalizationId:normalization.document.id,normalizationHash:normalization.receiptHash,
      workspaceId:v.workspaceId,projectId:v.projectId})
  }
  const ingest=b.origin.kind==='ingest-operation'?b.origin:null
  const source=ingest?s.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[])
    .find(n=>n.document.source.artifactId===ingest.detail.sourceArtifactId):null
  const consumed=s.entries.some(e=>e.consumption.status==='materialized')?'materialized':'blocked'
  await insert(tx,'project_output_states',{id:s.id,projectId:v.projectId,workspaceId:v.workspaceId,resultVersionId:v.id,
    parentVersionId:s.parentVersionId,parentStateId:s.parentStateId,parentStateHash:s.parentStateHash,schemaVersion:s.schemaVersion,
    canonicalPolicyVersion:s.canonicalPolicyVersion,transition:s.transition,transitionPolicyVersion:s.transitionPolicyVersion,
    producerKind:s.provenance.kind,producerId:s.provenance.id,provenanceHash:s.provenance.hash,
    producerEditCommandId:s.provenance.kind==='edit-command'?s.provenance.id:null,
    ingestOperationId:ingest?.operation.id??null,ingestSourceArtifactId:ingest?.detail.sourceArtifactId??null,
    ingestSourceManifestId:ingest?.detail.sourceManifestId??null,ingestSourceManifestHash:source?.document.source.manifest.manifestHash??null,
    ingestTranscriptId:ingest?.transcript.id??null,ingestTranscriptHash:ingest?.transcript.document.transcriptHash??null,
    producerHash:s.producer.hash,producerJson:encode(s.producer.document),editPlanSnapshotId:s.editPlan.snapshotId,
    editPlanHash:s.editPlan.hash,editPlanAuthorityJson:encode(s.editPlan.authority.document),editPlanAuthorityHash:s.editPlan.authority.hash,
    renderablePlanSnapshotId:s.renderablePlan?.snapshotId??null,renderablePlanId:s.renderablePlan?.planId??null,
    renderablePlanHash:s.renderablePlan?.hash??null,renderablePlanAuthorityJson:s.renderablePlan?encode(s.renderablePlan.authority.document):null,
    renderablePlanAuthorityHash:s.renderablePlan?.authority.hash??null,creationCommandV2Id:null,forkRenderableCandidateId:null,
    consumptionStatus:consumed,consumptionJson:encode({schemaVersion:'output-consumption/v3',canonicalPolicyVersion:s.canonicalPolicyVersion,
      status:consumed}),stateJson:encode(s),stateHash:b.state.stateHash,createdAt:new Date(s.createdAt)})
  for(const e of s.entries) {
    const materialized=e.consumption.status==='materialized'?e.consumption.materialization:null
    await insert(tx,'project_output_state_entries',{stateId:s.id,variantId:e.variantId,projectId:v.projectId,workspaceId:v.workspaceId,
      outputSpecRevisionId:e.outputSpecRevisionId,specHash:e.specHash,canonicalPolicyVersion:e.canonicalPolicyVersion,
      geometryStatus:materialized?'materialized-v3':'blocked-v3',geometryProjectionHash:materialized?.materializationHash??null,
      materializationId:materialized?.document.id??null,entryJson:encode(e),entryHash:sha(encode(e))})
  }
  await insert(tx,'project_versions',{id:v.id,workspaceId:v.workspaceId,projectId:v.projectId,sequence:v.sequence,
    parentVersionId:v.parentVersionId,briefSnapshotId:v.snapshotRefs.brief,policiesSnapshotId:v.snapshotRefs.policies,
    editPlanSnapshotId:v.snapshotRefs.editPlan,treatmentSnapshotId:v.snapshotRefs.treatment??null,storySnapshotId:v.snapshotRefs.story??null,
    baseHash:v.baseHash,createdBy:v.createdBy,createdAt:new Date(v.createdAt),commandId:v.commandId??null,outputContractVersion:3,
    outputStateId:v.outputStateId,outputStateHash:v.outputStateHash,outputBaseHashJson:b.outputBaseHashJson,outputVersionJson:encode(v)})
  // Command is stored separately with its historic serializer. Only the
  // operational envelope uses the new canonical policy.
  const origin=JSON.parse(stableSerialize(b.origin))
  const body={...b,origin}
  await insert(tx,'output_operational_bundles',{versionId:v.id,workspaceId:v.workspaceId,projectId:v.projectId,stateId:s.id,
    bundleJson:encode(body),bundleHash:sha(encode(body)),originJson:encode(origin),originHash:sha(encode(origin)),
    producerPayloadJson:b.origin.kind==='ingest-operation'?null:encode(b.origin.kind==='create-output-variant'||b.origin.kind==='revise-output-spec'?b.origin.result.command.payload:b.origin.command.payload),
    producerPayloadHash:b.origin.kind==='ingest-operation'?null:sha(encode(b.origin.kind==='create-output-variant'||b.origin.kind==='revise-output-spec'?b.origin.result.command.payload:b.origin.command.payload))})
}

import type { PreparedOperationalIngestV3 } from '../../application/ports/output-version-bundle-repository.ts'
import { validateOutputNormalizationV3 } from '../../domain/output-materialization.ts'
import { createMediaColorProbe } from '../../domain/color-and-export.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { mediaLibrarySearchField } from '../../domain/media-library.ts'
/** Called only after the owner has operation/detail/Project locks. Artifacts
 * are locked in UTF8/C order before manifest/probe/receipt publication. */
export async function persistOperationalIngestFactsInTransactionV3(tx:Prisma.TransactionClient,input:PreparedOperationalIngestV3) {
  const n=validateOutputNormalizationV3(input.normalization),d=n.document,t=input.transcript
  if(d.kind!=='ffmpeg-video-derivative'||t.workspaceId!==d.workspaceId||t.projectId!==d.projectId||
    t.sourceArtifactId!==d.source.artifactId||t.sourceManifestId!==d.source.manifestId||
    t.document.transcriptHash!==createMediaTranscript((({schemaVersion:_schema,transcriptHash:_hash,...body})=>body)(t.document)).transcriptHash||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sourceLinkId)||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.derivativeLinkId))
    throw new DomainError('PERSISTENCE_CONFLICT','Prepared ingest facts differ from producer')
  const ids=[d.source.artifactId,d.derivative.artifactId].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
  const held=await tx.$queryRawUnsafe<Array<{id:string}>>('SELECT id FROM media_artifacts WHERE "workspaceId"=$1 AND id IN ($2,$3) ORDER BY id COLLATE "C" FOR UPDATE',d.workspaceId,...ids)
  if(held.length!==2)throw new DomainError('PERSISTENCE_CONFLICT','Ingest referenced artifacts missing')
  const upload=await tx.v2MediaUpload.findFirst({where:{id:input.uploadId,workspaceId:d.workspaceId,projectId:d.projectId,
    status:'verified',inspectionStatus:'usable',kind:'video',rightsConfirmed:true}})
  if(!upload)throw new DomainError('PERSISTENCE_CONFLICT','Prepared ingest upload is not verified/usable')
  for(const fact of [d.source,d.derivative])await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_artifact_fact_v3($1::jsonb,$2)',encode(fact),d.workspaceId)
  for(const [probe,fact] of [[input.sourceColorProbe,d.source],[input.derivativeColorProbe,d.derivative]] as const) {
    const {probeHash,...body}=probe,fresh=createMediaColorProbe(body)
    if(fresh.probeHash!==probeHash||probe.workspaceId!==d.workspaceId||probe.artifactId!==fact.artifactId||probe.manifestId!==fact.manifestId)
      throw new DomainError('PERSISTENCE_CONFLICT','Prepared ingest color scope/seal differs')
    const data={id:probe.id,workspaceId:probe.workspaceId,artifactId:probe.artifactId,manifestId:probe.manifestId,
      schemaVersion:probe.schemaVersion,state:probe.detection.state,
      metadataJson:stableSerialize(probe.detection.state==='ready'?probe.detection.metadata:null),
      pixelFormat:probe.detection.pixelFormat??null,hdrMode:probe.detection.state==='ready'?probe.detection.hdrMode:null,
      reasonsJson:stableSerialize(probe.detection.state==='unavailable'?probe.detection.reasons:[]),
      producerProvider:probe.producer.provider,producerVersion:probe.producer.version,producerBinaryDigest:probe.producer.binaryDigest,
      createdAt:new Date(probe.createdAt),probeHash}
    const existing=await tx.v2MediaColorProbe.findUnique({where:{workspaceId_artifactId_manifestId:{workspaceId:d.workspaceId,
      artifactId:fact.artifactId,manifestId:fact.manifestId}}})
    if(existing) {
      if(Object.entries(data).some(([key,value])=>key!=='createdAt'&&key!=='probeHash'&&key!=='id'&&existing[key as keyof typeof existing]!==value))
        throw new DomainError('PERSISTENCE_CONFLICT','Ingest color producer/evidence collision')
    } else await tx.v2MediaColorProbe.create({data})
  }
  for(const [fact,role,id] of [[d.source,'source-master',input.sourceLinkId],[d.derivative,'editing-proxy',input.derivativeLinkId]] as const) {
    const existing=await tx.v2ProjectMediaAsset.findUnique({where:{projectId_artifactId_role:{projectId:d.projectId,artifactId:fact.artifactId,role}}})
    if(existing) {
      if(existing.workspaceId!==d.workspaceId||existing.uploadId!==input.uploadId||existing.originalFileName!==input.originalFileName)
        throw new DomainError('PERSISTENCE_CONFLICT','Ingest media-link origin collision')
    } else await tx.v2ProjectMediaAsset.create({data:{id,workspaceId:d.workspaceId,projectId:d.projectId,artifactId:fact.artifactId,
      uploadId:input.uploadId,role,originalFileName:input.originalFileName,createdAt:new Date(d.createdAt)}})
  }
  const people=mediaLibrarySearchField([],'people'),topics=mediaLibrarySearchField([],'topics')
  await tx.v2MediaLibraryEntry.upsert({where:{artifactId:d.source.artifactId},create:{artifactId:d.source.artifactId,
    workspaceId:d.workspaceId,label:input.originalFileName,peopleJson:stableSerialize(people.values),peopleSearch:people.search,
    topicsJson:stableSerialize(topics.values),topicsSearch:topics.search,originType:'upload',createdAt:new Date(d.createdAt)},update:{}})
  const transcriptData={id:t.id,workspaceId:t.workspaceId,projectId:t.projectId,sourceArtifactId:t.sourceArtifactId,
    sourceManifestId:t.sourceManifestId,schemaVersion:t.document.schemaVersion,language:t.document.language,provider:t.document.provider,
    model:t.document.model,transcriptHash:t.document.transcriptHash,transcriptJson:stableSerialize(t.document),createdAt:new Date(t.createdAt)}
  const prior=await tx.v2MediaTranscript.findUnique({where:{sourceArtifactId_transcriptHash:{sourceArtifactId:t.sourceArtifactId,
    transcriptHash:t.document.transcriptHash}}})
  if(prior) {
    if(Object.entries(transcriptData).some(([key,value])=>value instanceof Date?
      !(prior[key as keyof typeof prior] instanceof Date)||(prior[key as keyof typeof prior] as Date).getTime()!==value.getTime():
      prior[key as keyof typeof prior]!==value))throw new DomainError('PERSISTENCE_CONFLICT','Ingest transcript authority collision')
  } else await tx.v2MediaTranscript.create({data:transcriptData})
  const data={id:d.id,workspaceId:d.workspaceId,projectId:d.projectId,operationId:d.operationId,sourceArtifactId:d.source.artifactId,
    sourceManifestId:d.source.manifestId,sourceManifestHash:d.source.manifest.manifestHash,derivativeArtifactId:d.derivative.artifactId,
    derivativeManifestId:d.derivative.manifestId,derivativeManifestHash:d.derivative.manifest.manifestHash,
    receiptJson:encode(d),receiptHash:n.receiptHash,createdAt:new Date(d.createdAt)}
  const existing=await tx.v2OutputNormalizationReceipt.findUnique({where:{id:d.id}})
  if(existing) {
    if(Object.entries(data).some(([key,value])=>value instanceof Date?
      !(existing[key as keyof typeof existing] instanceof Date)||(existing[key as keyof typeof existing] as Date).getTime()!==value.getTime():
      existing[key as keyof typeof existing]!==value))throw new DomainError('PERSISTENCE_CONFLICT','Normalization receipt authority collision')
  } else await tx.v2OutputNormalizationReceipt.create({data})
}
