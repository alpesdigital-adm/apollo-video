import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { ProjectDuplicationBundle, ProjectDuplicationRepository, ProjectDuplicationResult } from '../../application/ports/project-duplication-repository.ts'
import type { ProjectForkCallerRequestV3, ForkMediaReferenceFactsV2, V2RenderablePlanSnapshotFacts } from '../../domain/project-fork-derivation.ts'
import type { CommandActor } from '../../domain/edit-command.ts'
import type { OperationalOutputParentV3, CreationOutputVersionBundleV2 } from '../../domain/output-version-bundle.ts'
import { createProject, type ProjectStatus } from '../../domain/project.ts'
import { createProjectSnapshot } from '../../domain/project-snapshot.ts'
import { creationProjectMetadataV2 } from '../../domain/project-creation-command.ts'
import { serializeOutputCanonicalJson } from '../../domain/output-canonical-policy.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { PrismaCreationOutputBundleRepositoryV2, assertForkCallerBindingV3 } from './output-version-bundle-repository.ts'
import { readPersistedOperationalOutputBundleV3, readPersistedForkCreationOutputBundleV3 } from './output-state-consumption.ts'
import { readCompletedIdempotencyResponse } from './idempotency-record-persistence.ts'

function resultFromReceipt(bundle: CreationOutputVersionBundleV2, replayed: boolean): Readonly<ProjectDuplicationResult> {
  const c=bundle.command, fork=c.payload.forkDerivation
  if(fork?.schemaVersion!=='project-fork-derivation/v3')throw new DomainError('PERSISTENCE_CONFLICT','Duplication receipt is not a content fork3')
  const metadata=creationProjectMetadataV2(c)
  const project=createProject({id:c.projectId,workspaceId:c.workspaceId,name:metadata.name,status:'draft',objective:metadata.objective,locale:metadata.locale,
    ownerId:c.author.id,duplicatedFromProjectId:fork.document.kernel.document.source.version.projectId,createdBy:c.author,createdAt:c.createdAt})
  return Object.freeze({project,version:bundle.version,bundle,sharedArtifactIds:Object.freeze([...new Set(fork.document.sourceReferences.map(r=>r.artifactId))]),copiedBytes:0,replayed})
}
function manifestBindings(bundle:OperationalOutputParentV3):Map<string,Set<string>> {
  const result=new Map<string,Set<string>>()
  const add=(artifactId:string,manifestId:string)=>{const ids=result.get(artifactId)??new Set<string>();ids.add(manifestId);result.set(artifactId,ids)}
  if(bundle.schemaVersion==='project-creation-output-bundle/v2')for(const ref of bundle.command.payload.forkDerivation?.document.sourceReferences??[])add(ref.artifactId,ref.manifestFacts.id)
  if(bundle.state.document.schemaVersion==='project-output-state/v3')for(const entry of bundle.state.document.entries)if(entry.consumption.status==='materialized')
    for(const receipt of entry.consumption.materialization.document.normalizations)for(const fact of [receipt.document.source,receipt.document.derivative])add(fact.artifactId,fact.manifestId)
  return result
}

/** The duplicate writer delegates the complete root transaction to the same
 * Creation2 owner used by public creation. No bare ProjectVersion is written. */
export class PrismaProjectDuplicationRepository implements ProjectDuplicationRepository {
  constructor(private readonly client:PrismaClient=getV2PostgresClient()){}
  async findIdempotent(input:Parameters<ProjectDuplicationRepository['findIdempotent']>[0]) {
    return this.client.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8000ms'")
      await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',serializeOutputCanonicalJson([input.workspaceId,input.clientId,input.key]))
      const record=await tx.v2IdempotencyRecord.findUnique({where:{workspaceId_clientId_key:{workspaceId:input.workspaceId,clientId:input.clientId,key:input.key}}})
      if(!record)return null
      const ids=readCompletedIdempotencyResponse(record,input.requestFingerprint)
      if(Object.keys(ids).sort().join('|')!=='projectId|versionId'||typeof ids.projectId!=='string'||typeof ids.versionId!=='string')
        throw new DomainError('PERSISTENCE_CONFLICT','Duplication idempotency receipt identity is invalid')
      const bundle=await readPersistedForkCreationOutputBundleV3(tx,{workspaceId:input.workspaceId,projectId:ids.projectId,versionId:ids.versionId})
      if(!bundle)throw new DomainError('PERSISTENCE_CONFLICT','Duplication original receipt is missing')
      assertForkCallerBindingV3(bundle.command,input.callerRequest)
      if(serializeOutputCanonicalJson(bundle.command.audit)!==serializeOutputCanonicalJson(input.audit))
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH','Duplication replay full actor differs')
      return resultFromReceipt(bundle,true)
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:10000,timeout:30000})
  }
  async readSource(input:Parameters<ProjectDuplicationRepository['readSource']>[0]) {
    const row=await this.client.v2Project.findFirst({where:{id:input.projectId,workspaceId:input.workspaceId},include:{currentVersion:{include:{briefSnapshot:true,
      treatmentSnapshot:true,storySnapshot:true,editPlanSnapshot:true,policiesSnapshot:true}},mediaAssets:{include:{artifact:true},orderBy:[{role:'asc'},{artifactId:'asc'},{id:'asc'}]}}})
    if(!row?.currentVersion)return null
    const bundle=await readPersistedOperationalOutputBundleV3(this.client,{workspaceId:input.workspaceId,projectId:input.projectId,versionId:row.currentVersion.id})
    if(!bundle)throw new DomainError('PERSISTENCE_CONFLICT','Duplication current source receipt is missing')
    const snapshots=[row.currentVersion.briefSnapshot,row.currentVersion.treatmentSnapshot,row.currentVersion.storySnapshot,row.currentVersion.editPlanSnapshot,row.currentVersion.policiesSnapshot]
      .filter(r=>r!==null).map(r=>createProjectSnapshot({id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,kind:r.kind as Parameters<typeof createProjectSnapshot>[0]['kind'],
        contentSchemaVersion:r.schemaVersion,contentJson:r.contentJson,contentHash:r.contentHash,createdAt:r.createdAt.toISOString()}))
    const projectFacts={id:row.id,workspaceId:row.workspaceId,currentVersionId:row.currentVersion.id,name:row.name,status:row.status,format:row.format,ownerId:row.ownerId,
      administrationRevision:row.administrationRevision,updatedAt:row.updatedAt.toISOString(),objective:row.objective!,locale:row.locale!,createdByType:row.createdByType,
      createdById:row.createdById,createdAt:row.createdAt.toISOString()}
    const project=createProject({id:row.id,workspaceId:row.workspaceId,name:row.name,status:row.status as ProjectStatus,objective:row.objective!,locale:row.locale!,
      ...(row.ownerId?{ownerId:row.ownerId}:{}),currentVersionId:row.currentVersion.id,createdBy:{type:row.createdByType as CommandActor['type'],id:row.createdById},createdAt:row.createdAt.toISOString()})
    let renderablePlanSnapshot:Readonly<V2RenderablePlanSnapshotFacts>|null=null
    if(bundle.state.document.schemaVersion==='project-output-state/v3'&&bundle.state.document.renderablePlan!==null) {
      const r=await this.client.v2RenderablePlanSnapshot.findUnique({where:{id:bundle.state.document.renderablePlan.snapshotId}})
      if(!r)throw new DomainError('PERSISTENCE_CONFLICT','Duplication actual Renderable snapshot is missing')
      renderablePlanSnapshot={...r,origin:r.origin as V2RenderablePlanSnapshotFacts['origin'],createdAt:r.createdAt.toISOString()}
    }
    const pinned=manifestBindings(bundle),media:Omit<ForkMediaReferenceFactsV2,'targetLinkId'>[]=[]
    for(const link of row.mediaAssets) {
      const manifests=await this.client.$queryRawUnsafe<Array<{id:string;facts:ForkMediaReferenceFactsV2['manifestFacts']}>>(
        'SELECT id,w66_fork_manifest_facts_v2(id,$2) AS facts FROM media_artifact_manifests WHERE "artifactId"=$1 AND "workspaceId"=$2 ORDER BY id COLLATE "C"',link.artifactId,input.workspaceId)
      const expected=pinned.get(link.artifactId),matches=expected?manifests.filter(m=>expected.has(m.id)):manifests
      if(matches.length!==1 || expected&&expected.size!==1)throw new DomainError('PERSISTENCE_CONFLICT','Duplication requires one exact source manifest binding; ambiguous/missing metadata is blocked')
      const a=link.artifact
      media.push({sourceLinkId:link.id,workspaceId:row.workspaceId,sourceProjectId:row.id,artifactId:a.id,role:link.role as ForkMediaReferenceFactsV2['role'],
        originalFileName:link.originalFileName,sourceLinkCreatedAt:link.createdAt.toISOString(),artifactKey:a.artifactKey,artifactSha256:a.sha256,artifactByteSize:a.byteSize.toString(),
        artifactMediaType:a.mediaType,artifactContainer:a.container,artifactLifecycleRevision:a.lifecycleRevision,purpose:link.role==='selected-insert'?'editorial-reuse':'editing',manifestFacts:matches[0].facts})
    }
    return Object.freeze({project,version:bundle.version,bundle,projectFacts,snapshots,renderablePlanSnapshot,media})
  }
  async duplicateOrReplay(input:Readonly<ProjectDuplicationBundle>) {
    const result=await new PrismaCreationOutputBundleRepositoryV2(this.client).persist(input.write)
    if(!input.write.forkCallerRequest)throw new DomainError('PERSISTENCE_CONFLICT','Duplication caller request is missing')
    assertForkCallerBindingV3(result.bundle.command,input.write.forkCallerRequest)
    return resultFromReceipt(result.bundle,result.replayed)
  }
}
