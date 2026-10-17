import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { EditorialCommandCommit, EditorialCommandContext, EditorialCommandRepository, EditorialCommandResult } from '../../application/ports/editorial-command-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { operationalBundlePlanV3, type OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import { createEditorialCutInvalidations } from '../../domain/editorial-cut-impact.ts'
import { readEditorialMaterializedPlanV3 } from '../../domain/editorial-cut-impact.ts'
import type { EditorialSourceBindingBodyV1, SealedOutputNormalizationV3 } from '../../domain/output-materialization.ts'
import { PrismaOperationalOutputBundleRepositoryV3 } from './output-version-bundle-repository.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { readOutputNormalizationsV3 } from './output-version-materializer.ts'
import { hydrateEditCommandExternalActorAudit } from './edit-command-actor-audit.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

export function editorialResultV3(bundle:OperationalOutputVersionBundleV3,replayed:boolean):EditorialCommandResult {
  if(bundle.origin.kind!=='editorial-cut-command')throw new DomainError('PERSISTENCE_CONFLICT','Editorial result requires its explicit Command3 producer')
  const command=bundle.origin.command,editPlan=readEditorialMaterializedPlanV3(JSON.parse(bundle.editPlanSnapshot.contentJson))
  return Object.freeze({command,version:bundle.version,editPlan,exclusions:command.payload.exclusions,
    retainedSourceRanges:editPlan.editorial.retainedSourceRanges,impact:command.payload.impact,
    invalidations:createEditorialCutInvalidations({impact:command.payload.impact,createdAt:command.createdAt}),outputBundle:bundle,replayed})
}
/** Exactly one writer: complete State/Version/Command/CAS/outbox in the shared
 * operational owner. Historical unsealed Commands remain audit-only. */
export class PrismaEditorialCommandRepository implements EditorialCommandRepository {
  private readonly client:PrismaClient
  constructor(client:PrismaClient=getV2PostgresClient()){this.client=client}
  async findIdempotentResult(input:Parameters<EditorialCommandRepository['findIdempotentResult']>[0]) {
    const row=await this.client.v2EditCommand.findUnique({where:{workspaceId_projectId_idempotencyKey:{
      workspaceId:input.workspaceId,projectId:input.projectId,idempotencyKey:input.idempotencyKey}}})
    if(!row)return null
    if(row.type!=='remove-spoken-content'||hydrateEditCommandExternalActorAudit(row).contextHash!==input.actorContextHash)
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH','Editorial replay key belongs to another actor or Command')
    const children=await this.client.v2ProjectVersion.findMany({where:{commandId:row.id,workspaceId:input.workspaceId,projectId:input.projectId},take:2,select:{id:true}})
    if(children.length!==1)throw new DomainError('PERSISTENCE_CONFLICT','Editorial replay lacks one exact committed child')
    const bundle=await readPersistedOperationalOutputBundleV3(this.client,{workspaceId:input.workspaceId,projectId:input.projectId,versionId:children[0]!.id})
    if(bundle?.schemaVersion!=='operational-output-version-bundle/v3'||bundle.origin.kind!=='editorial-cut-command'||bundle.origin.command.id!==row.id||
      bundle.origin.requestFingerprint!==row.requestFingerprint)throw new DomainError('PERSISTENCE_CONFLICT','Editorial replay stored receipt differs')
    return {requestFingerprint:row.requestFingerprint,result:editorialResultV3(bundle,true)}
  }
  async readContext(input:Parameters<EditorialCommandRepository['readContext']>[0]):Promise<Readonly<EditorialCommandContext>|null> {
    const project=await this.client.v2Project.findFirst({where:{id:input.projectId,workspaceId:input.workspaceId}})
    if(!project?.currentVersionId)return null
    if(project.status==='archived')throw new DomainError('PRECONDITION_REQUIRED','Editorial target is archived')
    const parent=await readPersistedOperationalOutputBundleV3(this.client,{workspaceId:input.workspaceId,projectId:input.projectId,versionId:project.currentVersionId})
    if(!parent)return null
    if(!parent.state.document.entries.some(e=>e.variantId===input.variantId))throw new DomainError('PRECONDITION_REQUIRED','Editorial stable variant is absent from exact State')
    const plan=JSON.parse(operationalBundlePlanV3(parent).contentJson)
    if(plan.retimedTranscript?.sourceTranscriptId!==input.transcriptId)throw new DomainError('PRECONDITION_REQUIRED','Editorial transcript is not the actual parent alignment')
    let authority:EditorialSourceBindingBodyV1['authority'];let observations:readonly SealedOutputNormalizationV3[];let manifestRefs:ReadonlyMap<string,{id:string;hash:string}>
    if(parent.schemaVersion==='project-creation-output-bundle/v2') {
      const fork=parent.command.payload.forkDerivation
      if(fork?.schemaVersion!=='project-fork-derivation/v3'||fork.document.kernel.document.source.bundle.schemaVersion!=='operational-output-version-bundle/v3')
        throw new DomainError('PRECONDITION_REQUIRED','Creation2 editorial requires a real observed source3 fork derivation')
      const source=fork.document.kernel.document.source
      authority={kind:'fork-derivation3',sourceProjectId:source.version.projectId,sourceVersionId:source.version.id,sourceBaseHash:source.version.baseHash,
        sourceStateId:source.state.document.id,sourceStateHash:source.state.stateHash,forkRootVersionId:parent.version.id,
        forkRootStateId:parent.state.document.id,forkRootStateHash:parent.state.stateHash,derivationId:fork.document.id,derivationHash:fork.derivationHash}
      observations=source.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[])
      manifestRefs=new Map(fork.document.sourceReferences.map(r=>[r.artifactId,{id:r.manifestFacts.id,hash:r.manifestFacts.manifestHash}]))
    } else {
      const previous=parent.origin.kind==='editorial-cut-command'?parent.origin.command.payload.sourceBinding.document:null
      authority=previous?.authority??{kind:'same-project-state3',sourceProjectId:parent.version.projectId,sourceVersionId:parent.version.id,
        sourceBaseHash:parent.version.baseHash,sourceStateId:parent.state.document.id,sourceStateHash:parent.state.stateHash,
        forkRootVersionId:null,forkRootStateId:null,forkRootStateHash:null,derivationId:null,derivationHash:null}
      observations=parent.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[])
      manifestRefs=previous?new Map(previous.inventory.map(i=>[i.artifactId,{id:i.manifestId,hash:i.manifestHash}])):
        new Map(observations.flatMap(n=>[n.document.source,n.document.derivative]).map(f=>[f.artifactId,{id:f.manifestId,hash:f.manifest.manifestHash}]))
    }
    const originals=new Map(observations.map(n=>[n.document.id,n]))
    if(!originals.size)throw new DomainError('PRECONDITION_REQUIRED','Editorial source normalization authority is absent')
    const normalizations:SealedOutputNormalizationV3[]=[]
    for(const n of originals.values()) {
      const actual=await readOutputNormalizationsV3(this.client,{workspaceId:input.workspaceId,projectId:n.document.projectId,ids:[n.document.id],lock:false})
      if(actual[0]!.receiptHash!==n.receiptHash)throw new DomainError('PERSISTENCE_CONFLICT','Editorial original receipt changed')
      normalizations.push(actual[0]!)
    }
    const t=await this.client.v2MediaTranscript.findFirst({where:{id:input.transcriptId,projectId:authority.sourceProjectId,workspaceId:input.workspaceId}})
    if(!t)throw new DomainError('PRECONDITION_REQUIRED','Editorial original transcript producer is absent')
    const transcript=JSON.parse(t.transcriptJson),{schemaVersion:_schema,transcriptHash:_hash,...body}=transcript
    if(createMediaTranscript(body).transcriptHash!==t.transcriptHash||transcript.transcriptHash!==plan.retimedTranscript.sourceTranscriptHash)
      throw new DomainError('PERSISTENCE_CONFLICT','Editorial original transcript seal differs')
    const sourceNormalization=normalizations.find(n=>n.document.source.artifactId===t.sourceArtifactId&&n.document.source.manifestId===t.sourceManifestId)
    if(!sourceNormalization)throw new DomainError('PRECONDITION_REQUIRED','Editorial transcript lacks its exact observed source clock')
    const probe=sourceNormalization.document.sourceProbe
    const sourceDurationSeconds=Number(probe.endPts)*Number(probe.timeBase.numerator)/Number(probe.timeBase.denominator)-
      Number(probe.originSeconds.numerator)/Number(probe.originSeconds.denominator)
    if(!Number.isFinite(sourceDurationSeconds)||sourceDurationSeconds<=0||!Number.isFinite(plan.fps)||plan.fps<=0)
      throw new DomainError('PERSISTENCE_CONFLICT','Editorial source clock is invalid')
    const links=await this.client.v2ProjectMediaAsset.findMany({where:{workspaceId:input.workspaceId,projectId:input.projectId},orderBy:{id:'asc'}})
    const inventory:EditorialSourceBindingBodyV1['inventory'][number][]=[]
    for(const link of links) {
      const artifact=await this.client.v2MediaArtifact.findFirst({where:{id:link.artifactId,workspaceId:input.workspaceId},include:{currentRightsSnapshot:true}}),manifest=manifestRefs.get(link.artifactId)
      if(!artifact||!manifest)throw new DomainError('PRECONDITION_REQUIRED','Editorial inventory has no explicit immutable manifest authority')
      inventory.push({linkId:link.id,artifactId:link.artifactId,role:link.role,manifestId:manifest.id,manifestHash:manifest.hash,
        artifactSha256:artifact.sha256,rightsSnapshotId:artifact.currentRightsSnapshotId,rightsHash:artifact.currentRightsSnapshot?.snapshotHash??null,rightsRevision:artifact.rightsRevision})
    }
    const finals=await this.client.v2ProjectFinalExportOperation.count({where:{projectId:input.projectId,workspaceId:input.workspaceId,projectVersionId:parent.version.id,operation:{status:'succeeded'}}})
    if(finals)throw new DomainError('PRECONDITION_REQUIRED','Editorial final invalidation lacks explicit stable variant authority')
    const outputs=await this.client.v2ProjectProxyRenderOperation.findMany({where:{projectId:input.projectId,workspaceId:input.workspaceId,
      projectVersionId:parent.version.id,operation:{status:'succeeded'}},select:{outputArtifactId:true,renderableVariantId:true}})
    if(outputs.some(o=>!o.renderableVariantId))throw new DomainError('PRECONDITION_REQUIRED','Editorial proxy lacks explicit stable variant authority')
    return Object.freeze({projectId:input.projectId,workspaceId:input.workspaceId,currentVersion:parent.version,parent,transcriptId:t.id,transcript,
      sourceArtifactId:t.sourceArtifactId,sourceDurationSeconds,sourceFps:plan.fps,currentDurationFrames:plan.durationFrames,variantId:input.variantId,
      normalizations,sourceBindingFacts:{schemaVersion:'editorial-source-binding/v1' as const,canonicalPolicyVersion:'output-canonical-json/v1' as const,
        workspaceId:input.workspaceId,projectId:input.projectId,authority,
        transcript:{id:t.id,workspaceId:t.workspaceId,projectId:t.projectId,sourceArtifactId:t.sourceArtifactId,sourceManifestId:t.sourceManifestId,document:transcript,createdAt:t.createdAt.toISOString()},
        normalizationRefs:normalizations.map(n=>({id:n.document.id,projectId:n.document.projectId,receiptHash:n.receiptHash})),inventory},
      outputReferences:outputs.map(o=>({artifactId:o.outputArtifactId,kind:'proxy' as const,sourceVersionId:parent.version.id,variantId:o.renderableVariantId!}))})
  }
  async commitOrReplay(input:EditorialCommandCommit):Promise<EditorialCommandResult> {
    const committed=await new PrismaOperationalOutputBundleRepositoryV3(this.client).persistChild({proposal:input.proposal,
      audit:input.authenticationAudit,versionEventId:input.event.id,operationEventId:null,ingestFacts:null,
      recompose:({parent,normalizations})=>({...input.proposal,parent,normalizations})})
    return editorialResultV3(committed.bundle,committed.replayed)
  }
}
