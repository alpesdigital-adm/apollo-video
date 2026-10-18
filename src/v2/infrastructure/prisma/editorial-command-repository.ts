import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { EditorialCommandCommit, EditorialCommandContext, EditorialCommandRepository, EditorialCommandResult } from '../../application/ports/editorial-command-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { forkAuthorityPendingV3, operationalBundlePlanV3, type CreationOutputVersionBundleV2, type OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import { createEditorialCutInvalidations } from '../../domain/editorial-cut-impact.ts'
import { readEditorialMaterializedPlanV3 } from '../../domain/editorial-cut-impact.ts'
import type { EditorialSourceBindingBodyV1, SealedOutputNormalizationV3 } from '../../domain/output-materialization.ts'
import { PrismaOperationalOutputBundleRepositoryV3 } from './output-version-bundle-repository.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { readOutputNormalizationsV3, RENDER_OUTPUT_LINK_ROLES } from './output-version-materializer.ts'
import { readVersionRenderReferences } from './version-render-references.ts'
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
    // The variant is the VIEW the cut was made on; the cut itself is project-wide, so it only has to be an exact member of the State. A copy
    // still waiting for its cut is a Creation fork: its State lists the outputs it will take (it has no consumption yet) and the cut is the very
    // Command that gives them one, so the membership is read from the State document itself.
    if(!parent.state.document.entries.some(e=>e.variantId===input.variantId))
      throw new DomainError('PRECONDITION_REQUIRED','Editorial stable variant is absent from exact State',{reason:'output-variant-unknown'})
    const plan=JSON.parse(operationalBundlePlanV3(parent).contentJson)
    if(plan.retimedTranscript?.sourceTranscriptId!==input.transcriptId)throw new DomainError('PRECONDITION_REQUIRED','Editorial transcript is not the actual parent alignment')
    let authority:EditorialSourceBindingBodyV1['authority'];let observations:readonly SealedOutputNormalizationV3[];let manifestRefs:ReadonlyMap<string,{id:string;hash:string}>
    // A copy whose children only configured it is still waiting for this cut: its authority is the Creation fork it descends from.
    let forkRoot:Readonly<CreationOutputVersionBundleV2>|null=parent.schemaVersion==='project-creation-output-bundle/v2'?parent:null
    if(forkRoot===null&&forkAuthorityPendingV3(parent)) {
      const first=await this.client.v2ProjectVersion.findFirst({where:{workspaceId:input.workspaceId,projectId:input.projectId,sequence:1},select:{id:true}})
      const root=first?await readPersistedOperationalOutputBundleV3(this.client,{workspaceId:input.workspaceId,projectId:input.projectId,versionId:first.id}):null
      if(root?.schemaVersion!=='project-creation-output-bundle/v2')throw new DomainError('PRECONDITION_REQUIRED','A copy needs its Creation fork to take the editorial authority')
      forkRoot=root
    }
    if(forkRoot!==null) {
      const fork=forkRoot.command.payload.forkDerivation
      if(fork?.schemaVersion!=='project-fork-derivation/v3'||fork.document.kernel.document.source.bundle.schemaVersion!=='operational-output-version-bundle/v3')
        throw new DomainError('PRECONDITION_REQUIRED','Creation2 editorial requires a real observed source3 fork derivation')
      const source=fork.document.kernel.document.source
      authority={kind:'fork-derivation3',sourceProjectId:source.version.projectId,sourceVersionId:source.version.id,sourceBaseHash:source.version.baseHash,
        sourceStateId:source.state.document.id,sourceStateHash:source.state.stateHash,forkRootVersionId:forkRoot.version.id,
        forkRootStateId:forkRoot.state.document.id,forkRootStateHash:forkRoot.state.stateHash,derivationId:fork.document.id,derivationHash:fork.derivationHash}
      observations=source.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[])
      manifestRefs=new Map(fork.document.sourceReferences.map(r=>[r.artifactId,{id:r.manifestFacts.id,hash:r.manifestFacts.manifestHash}]))
    } else {
      // No fork root means the parent is an operational State3 (a Creation parent is its own fork root above).
      const operational=parent as Readonly<OperationalOutputVersionBundleV3>
      const previous=operational.origin.kind==='editorial-cut-command'?operational.origin.command.payload.sourceBinding.document:null
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
    // The inventory of a cut of the project itself is its editorial sources: the proxies and finals rendered from the plan are what the cut
    // invalidates, not what it consumes (a copy's inventory is its fork derivation's, which names every link it copied).
    const links=(await this.client.v2ProjectMediaAsset.findMany({where:{workspaceId:input.workspaceId,projectId:input.projectId},orderBy:{id:'asc'}}))
      .filter(link=>authority.kind!=='same-project-state3'||!RENDER_OUTPUT_LINK_ROLES.includes(link.role))
    const inventory:EditorialSourceBindingBodyV1['inventory'][number][]=[]
    for(const link of links) {
      const artifact=await this.client.v2MediaArtifact.findFirst({where:{id:link.artifactId,workspaceId:input.workspaceId},include:{currentRightsSnapshot:true}}),manifest=manifestRefs.get(link.artifactId)
      if(!artifact||!manifest)throw new DomainError('PRECONDITION_REQUIRED','Editorial inventory has no explicit immutable manifest authority')
      inventory.push({linkId:link.id,artifactId:link.artifactId,role:link.role,manifestId:manifest.id,manifestHash:manifest.hash,
        artifactSha256:artifact.sha256,rightsSnapshotId:artifact.currentRightsSnapshotId,rightsHash:artifact.currentRightsSnapshot?.snapshotHash??null,rightsRevision:artifact.rightsRevision})
    }
    // The cut changes the shared plan, so every render of the current Version goes stale: every output's proxies and its published
    // finals, each attributed to its own output (a row that cannot be attributed exactly is a PERSISTENCE_CONFLICT, never a guess).
    const outputReferences=await readVersionRenderReferences(this.client,{workspaceId:input.workspaceId,projectId:input.projectId,
      versionId:parent.version.id,state:parent.state})
    return Object.freeze({projectId:input.projectId,workspaceId:input.workspaceId,currentVersion:parent.version,parent,
      ...(forkRoot!==null&&forkRoot!==parent?{forkRoot}:{}),transcriptId:t.id,transcript,
      sourceArtifactId:t.sourceArtifactId,sourceDurationSeconds,sourceFps:plan.fps,currentDurationFrames:plan.durationFrames,variantId:input.variantId,
      normalizations,sourceBindingFacts:{schemaVersion:'editorial-source-binding/v1' as const,canonicalPolicyVersion:'output-canonical-json/v1' as const,
        workspaceId:input.workspaceId,projectId:input.projectId,authority,
        transcript:{id:t.id,workspaceId:t.workspaceId,projectId:t.projectId,sourceArtifactId:t.sourceArtifactId,sourceManifestId:t.sourceManifestId,document:transcript,createdAt:t.createdAt.toISOString()},
        normalizationRefs:normalizations.map(n=>({id:n.document.id,projectId:n.document.projectId,receiptHash:n.receiptHash})),inventory},
      outputReferences})
  }
  async commitOrReplay(input:EditorialCommandCommit):Promise<EditorialCommandResult> {
    const committed=await new PrismaOperationalOutputBundleRepositoryV3(this.client).persistChild({proposal:input.proposal,
      audit:input.authenticationAudit,versionEventId:input.event.id,operationEventId:null,ingestFacts:null,
      recompose:({parent,normalizations})=>({...input.proposal,parent,normalizations})})
    return editorialResultV3(committed.bundle,committed.replayed)
  }
}
