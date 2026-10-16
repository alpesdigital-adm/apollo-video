import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { calculateCanonicalHash,stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createProjectCreationOutputCommandV2,normalizeProjectCreationIntentV2 } from '../../src/v2/domain/project-creation-command.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { buildCreationOutputVersionBundleV2,buildOperationalOutputVersionBundleV3,validateCreationOutputVersionBundleV2 } from '../../src/v2/domain/output-version-bundle.ts'
import { createProjectSnapshot } from '../../src/v2/domain/project-snapshot.ts'
import { createOutputSpecRevisionBody,freezeOutputJson } from '../../src/v2/domain/output-spec-revision.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { createQueuedPublicOperation,startPublicOperationAttempt,advancePublicOperationPhase } from '../../src/v2/domain/public-operation.ts'
import { createMediaArtifactManifest,createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { compileInitialSourceEditPlan } from '../../src/v2/application/apply-editorial-cut-command.ts'
import { validateOutputObservedProbeV3,sealOutputNormalizationV3,materializeObservedOutputRangeV3,materializeOutputV3 } from '../../src/v2/domain/output-materialization.ts'
import { materializeManualEditPlan,materializeManualRestorePlan } from '../../src/v2/domain/manual-editing.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'
import { createManualCommandImpact } from '../../src/v2/domain/command-impact.ts'
import { observedAudioFromVideoProbeV3 } from '../../src/v2/infrastructure/media/video-probe.ts'
import { createProjectForkSourceV3, forkOwnedIdentitiesV3, createProjectForkKernelV3,
 createProjectForkDerivationV3, materializeForkEditPlanV3, buildForkRenderablePlanCandidateV3,
 remapForkSnapshotDocumentV3,validateProjectForkSourceV3,validateProjectForkDerivationV3 } from '../../src/v2/domain/project-fork-derivation.ts'
import { serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { requireOutputStateConsumableV2 } from '../../src/v2/domain/project-output-state.ts'

// Synthetic observations for domain invariants ONLY. These executable SHA
// literals do not attest a binary, pixels, subprocess, persisted facts or rights.
const policy={canonicalPolicyVersion:'output-canonical-json/v1'},at='2026-10-14T12:00:00.000Z',scope={workspaceId:'workspace-operational',projectId:'project-operational'}
const audit=createApiAccessAuditContext({workspaceId:scope.workspaceId,clientId:'client-operational',credentialId:'credential-operational',environment:'sandbox',authenticationKind:'bearer'})
const sha=text=>createHash('sha256').update(text).digest('hex'),clone=value=>structuredClone(value)
function snapshot(id,kind,document,createdAt=at) {
 return createProjectSnapshot({...scope,id,kind,contentSchemaVersion:document.schemaVersion,contentJson:stableSerialize(document),contentHash:calculateCanonicalHash(document),createdAt})
}
function root() {
 const versionId='version-root2',callerIntent=normalizeProjectCreationIntentV2({schemaVersion:'project-creation-intent/v2',kind:'initialize-empty',name:'Explicit root',objective:'discovery',locale:'pt-BR',briefing:null,desiredAction:{}})
 const documents=[['brief',{schemaVersion:1,objective:callerIntent.objective,desiredAction:callerIntent.desiredAction,productionBrief:createProductionBrief({}),createdAt:at}],
  ['policies',{schemaVersion:1,workspaceId:scope.workspaceId,state:'unconfigured',brandKitMode:'inherit',guardrails:[],createdAt:at}],
  ['edit-plan',{schemaVersion:2,state:'uncompiled',id:'edit-plan-root2',projectVersionId:versionId,fps:30,durationFrames:0,sources:[],videoTracks:[],subtitleTracks:[],audioTracks:[],overlayTracks:[],effectTracks:[],createdAt:at}]]
 const snapshots=documents.map(([kind,doc])=>snapshot('snapshot-root-'+kind,kind,doc))
 return buildCreationOutputVersionBundleV2(createProjectCreationOutputCommandV2({...policy,...scope,id:'creation-root2',versionId,audit,createdAt:at,
  payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent,allocations:{stateId:'state-root2',snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:null},snapshots,forkDerivation:null,renderableCandidate:null}}))
}
function spec(createdAt) {
 const encoding=final=>({codec:'h264',encoder:'libx264',pixelFormat:'yuv420p',container:'mp4',faststart:true,width:final?640:320,height:final?360:180,fps:30,
  quality:{mode:'crf',value:final?18:23,preset:final?'medium':'veryfast'},audio:{codec:'aac',bitrateKbps:final?192:160,sampleRateHz:48000,channels:1}})
 return createOutputSpecRevisionBody({...policy,...scope,id:'revision-output-alpha',variantId:'output-alpha',revisionNumber:1,createdAt,
  output:{schemaVersion:1,id:'output-alpha',locale:'pt-BR',aspectRatio:'16:9',width:640,height:360,fps:30,safeArea:{top:.08,right:.06,bottom:.06,left:.06},deliveryProfileId:'profile-explicit'},
  profile:{schemaVersion:'materialized-delivery-profile/v1',id:'profile-explicit',version:1,rendererContractVersion:'ffmpeg-editorial-output/v1',final:encoding(true),proxy:encoding(false),
   proxyToFinal:{schemaVersion:'output-canvas-transform/v1',scaleX:2,scaleY:2},subtitles:{mode:'none',configuration:null,fontAssets:[]}},preset:null})
}
function variantInput(parent=root()) {
 const createdAt='2026-10-14T12:00:01.000Z',revision=spec(createdAt)
 const result=createOutputVariantCommand({command:{...scope,id:'command-create-variant3',baseVersionId:parent.version.id,baseHash:parent.version.baseHash,
  type:'create-output-variant',author:{type:'api-client',id:audit.clientId},idempotencyKey:'explicit-variant-request',createdAt},audit,base:parent.version,baseState:parent.state,
  historicalBaselineRequested:false,revision,expectedRevisionId:null,expectedSpecHash:null,durationFrames:0})
 const p=clone(JSON.parse(parent.command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson));p.id='edit-plan-variant3';p.projectVersionId='version-variant3';p.createdAt=createdAt
 return {allocation:{...scope,resultVersionId:'version-variant3',stateId:'state-variant3',parentVersionId:parent.version.id,sequence:2,createdBy:audit.clientId,createdAt},
  parent,origin:{kind:'create-output-variant',result},restoreTarget:null,editPlanSnapshot:snapshot('snapshot-variant3','edit-plan',p,createdAt),normalizations:[],materializationIds:{}}
}
function observed({derivative=false,nativeFps=30,gapAt=-1,gapPts=0,initialPts=0}={}) {
 const step=90000/nativeFps;assert.ok(Number.isSafeInteger(step))
 const video=Array.from({length:nativeFps*2},(_,i)=>({media_type:'video',stream_index:0,best_effort_timestamp:initialPts+i*step+(i>=gapAt&&gapAt>=0?gapPts:0),duration:step}))
 const audio=Array.from({length:60},(_,i)=>({media_type:'audio',stream_index:1,best_effort_timestamp:i*1600,duration:1600}))
 const raw={format:{start_time:'0.000000',duration:'2.000000',format_name:'mov,mp4,m4a,3gp,3g2,mj2'},streams:[
  {index:0,codec_type:'video',codec_name:'h264',width:derivative?1280:320,height:derivative?720:180,avg_frame_rate:nativeFps+'/1',time_base:'1/90000',start_time:'0.000000'},
  {index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:1,time_base:'1/48000',start_time:'0.000000'}],frames:[...video,...audio]}
 const rawJson=JSON.stringify(raw),timeBase={numerator:'1',denominator:'90000'}
 return validateOutputObservedProbeV3({schemaVersion:'output-observed-probe/v3',binarySha256:'e'.repeat(64),rawJson,rawSha256:sha(rawJson),streamIndex:0,mediaType:'video',sampleRateHz:null,channels:null,
  originSource:'format-start-time',originSeconds:{numerator:'0',denominator:'1'},width:raw.streams[0].width,height:raw.streams[0].height,fps:{numerator:String(nativeFps),denominator:'1'},rotationDegrees:0,timeBase,
  frames:video.map((v,frame)=>({frame,pts:String(v.best_effort_timestamp),timeBase})),frameEndPts:video.map(v=>String(v.best_effort_timestamp+v.duration)),endPts:String(video.at(-1).best_effort_timestamp+step)})
}
function normalization(options={}) {
 const sourceProbe=observed(options),derivativeProbe=observed({...options,derivative:true})
 const sourceManifest=createMediaArtifactManifest({artifactKey:'controlled/source.mp4',artifactSha256:'a'.repeat(64),byteSize:1000,mediaType:'video',container:'mp4',recipe:{id:'direct-upload',version:'1.0.0',parameters:{mimeType:'video/mp4'}},
  probe:{width:sourceProbe.width,height:sourceProbe.height,duration:2,fps:options.nativeFps??30}})
 const derivativeManifest=createMediaArtifactManifestV2({artifactKey:'controlled/derivative.mp4',artifactSha256:'b'.repeat(64),byteSize:2000,mediaType:'video',container:'mp4',
  recipe:{id:'editing-proxy',version:'1.2.0',parameters:{normalizationPolicy:'output-normalization-receipt/v3',maxWidth:1280,maxHeight:1280,videoCodec:'h264',audioCodec:'aac'}},
  sources:[{artifactKey:sourceManifest.artifact.artifactKey,sha256:sourceManifest.artifact.sha256,role:'source-master',execution:{tool:{id:'ffmpeg',version:'static',digest:'f'.repeat(64)}}}],
  probe:{width:derivativeProbe.width,height:derivativeProbe.height,duration:2,fps:options.nativeFps??30}})
 return sealOutputNormalizationV3({...policy,schemaVersion:'output-normalization-receipt/v3',id:'normalization-ingest3',kind:'ffmpeg-video-derivative',...scope,operationId:'operation-ingest3',attempt:1,leaseOwner:'worker-ingest3',
  source:{artifactId:'artifact-source3',manifestId:'manifest-source3',manifest:sourceManifest},derivative:{artifactId:'artifact-derivative3',manifestId:'manifest-derivative3',manifest:derivativeManifest},
  sourceProbe,derivativeProbe,audioProbes:{source:observedAudioFromVideoProbeV3(sourceProbe),derivative:observedAudioFromVideoProbeV3(derivativeProbe)},
  execution:{provider:'ffmpeg',recipeVersion:'media-normalization-execution/2026-10-14-v3',binarySha256:'f'.repeat(64),argv:['-hide_banner','-loglevel','error','-y','-i','/controlled/source.mp4','-map','0:v:0','-map','0:a:0?',
   '-vf','scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-movflags','+faststart','/controlled/derivative.mp4'],
   spawnObserved:true,closeObserved:true,exitCode:0,sourceSha256Before:'a'.repeat(64),sourceSha256After:'a'.repeat(64),derivativeSha256:'b'.repeat(64),autorotate:true},createdAt:'2026-10-14T12:00:02.000Z'})
}
function ingestInput() {
 const parent=buildOperationalOutputVersionBundleV3(variantInput()),createdAt='2026-10-14T12:00:02.000Z'
 const transcript=createMediaTranscript({language:'pt-BR',text:'Fonte controlada.',words:[{word:'Fonte',start:0,end:1},{word:'controlada.',start:1,end:2}],segments:[{id:0,start:0,end:2,text:'Fonte controlada.'}],provider:'controlled',model:'explicit-domain-fixture'})
 let operation=startPublicOperationAttempt(createQueuedPublicOperation({...scope,id:'operation-ingest3',clientId:audit.clientId,type:'media-ingest',target:{type:'media-artifact',id:'artifact-source3',manifestId:'manifest-source3'},createdAt:at}),createdAt)
 operation=advancePublicOperationPhase(operation,'persisting',createdAt)
 const plan=compileInitialSourceEditPlan({id:'edit-plan-ingest3',projectVersionId:'version-ingest3',transcriptId:'transcript-ingest3',transcript,sourceArtifactId:'artifact-source3',sourceDurationSeconds:2,fps:30,createdAt})
 return {allocation:{...scope,resultVersionId:'version-ingest3',stateId:'state-ingest3',parentVersionId:parent.version.id,sequence:3,createdBy:audit.clientId,createdAt},parent,
  origin:{kind:'ingest-operation',operation,requestFingerprint:calculateCanonicalHash({controlled:'explicit-ingest-request'}),leaseOwner:'worker-ingest3',detail:{uploadId:'00000000-0000-4000-a000-000000000001',sourceArtifactId:'artifact-source3',sourceManifestId:'manifest-source3'},
   transcript:{...scope,id:'transcript-ingest3',sourceArtifactId:'artifact-source3',sourceManifestId:'manifest-source3',document:transcript,createdAt}},
  restoreTarget:null,editPlanSnapshot:snapshot('snapshot-ingest3','edit-plan',plan,createdAt),normalizations:[normalization()],materializationIds:{'output-alpha':'materialization-ingest3'}}
}
const invalid=action=>assert.throws(action,e=>e.code==='INVALID_RENDER_INPUT')

test('W66 immutable JSON identity reuse rejects unfamiliar frozen accessors hidden symbols cycles and mutable descendants',()=>{
 let getterCalls=0
 const accessor={};Object.defineProperty(accessor,'text',{enumerable:true,get(){getterCalls++;throw new Error('getter must not execute')}})
 const hidden={};Object.defineProperty(hidden,'text',{value:'hidden'})
 const symbol={[Symbol('text')]:'hidden'},cycle={};cycle.self=cycle
 const hiddenArray=[1];Object.defineProperty(hiddenArray,'hidden',{value:true})
 for(const value of [accessor,hidden,symbol,cycle,hiddenArray,{text:undefined}]) {
  Object.freeze(value)
  assert.throws(()=>freezeOutputJson(value),e=>e.code==='INVALID_OUTPUT_SPEC')
 }
 assert.equal(getterCalls,0)
 const caller={nested:{text:'original'},members:[{id:'member-1'}]},frozen=freezeOutputJson(caller)
 caller.nested.text='changed';caller.members[0].id='changed'
 assert.deepEqual(frozen,{nested:{text:'original'},members:[{id:'member-1'}]})
 assert.equal(Object.isFrozen(frozen.nested),true);assert.equal(Object.isFrozen(frozen.members[0]),true)
 assert.equal(Reflect.set(frozen.nested,'text','forged'),false)
 assert.equal(freezeOutputJson(frozen),frozen)
 assert.equal(freezeOutputJson(frozen),frozen)
 const unfamiliar=Object.freeze({nested:{text:'first'}}),first=freezeOutputJson(unfamiliar)
 unfamiliar.nested.text='second'
 assert.equal(first.nested.text,'first');assert.equal(freezeOutputJson(unfamiliar).nested.text,'second')
})

function currentForkFixture({empty=false}={}) {
 const input=empty?null:ingestInput()
 if(input) {
  // Persisted operational receipts contain JSON operation facts, not the
  // explicit undefined terminal/retry properties of startPublicOperationAttempt.
  const {completedAt,nextAttemptAt,deadLetteredAt,result,error,...runningOperation}=input.origin.operation
  for(const value of [completedAt,nextAttemptAt,deadLetteredAt,result,error])assert.equal(value,undefined)
  input.origin.operation=runningOperation
  assert.equal(Object.hasOwn(input.origin.operation,'completedAt'),false)
  const plan=JSON.parse(input.editPlanSnapshot.contentJson)
  plan.videoTracks[0].clips[0].crop={x:.1,y:.15,width:.7,height:.75}
  plan.subtitleTracks=[{id:'track-source-captions',kind:'captions',cues:[{id:'cue-source-transcript',
   startFrame:0,endFrame:plan.durationFrames,clipId:plan.videoTracks[0].clips[0].id,
   text:input.origin.transcript.document.text}]}]
  plan.metadata={external:{id:'external-record',clips:[{id:'external-clip'}],cues:[{id:'external-cue'}]}}
  input.editPlanSnapshot=snapshot('snapshot-ingest3','edit-plan',plan,input.allocation.createdAt)
 }
 const bundle=empty?root():buildOperationalOutputVersionBundleV3(input),rootFacts=root().command.payload.snapshots
 const source=createProjectForkSourceV3({bundle,snapshots:empty?rootFacts:[...rootFacts.filter(s=>s.kind!=='edit-plan'),bundle.editPlanSnapshot],renderablePlanSnapshot:null})
 const target={...scope,projectId:'project-full-fork3',resultVersionId:'version-full-fork3',stateId:'state-full-fork3',commandId:'creation-full-fork3',
  parentVersionId:null,sequence:1,createdBy:audit.clientId,createdAt:'2026-10-14T12:00:04.000Z'}
 const identityMap=forkOwnedIdentitiesV3(source,null).map(member=>({kind:member.kind,sourceId:member.id,
  targetId:member.kind==='version'?target.resultVersionId:member.kind==='state'?target.stateId:'fork-'+member.id}))
 const kernel=createProjectForkKernelV3({...policy,schemaVersion:'project-fork-kernel/v3',id:'derivation-full-fork3',callerIntent:{schemaVersion:'project-creation-intent/v2',kind:'fork-with-content',name:'Content fork'},
  audit,target,source,sourceRenderablePlanSnapshot:null,identityMap,cropDecisions:[],compilePolicyVersion:'project-fork-typed-remap/2026-10-12-v1'})
 const refs=empty?[]:[input.normalizations[0].document.source,input.normalizations[0].document.derivative].map((fact,i)=>{
  const manifest=fact.manifest,link=i?'11111111-1111-4111-8111-111111111112':'11111111-1111-4111-8111-111111111111'
  return {sourceLinkId:link,targetLinkId:i?'22222222-2222-4222-8222-222222222223':'22222222-2222-4222-8222-222222222222',
   ...scope,sourceProjectId:scope.projectId,artifactId:fact.artifactId,role:i?'editing-proxy':'source-master',originalFileName:i?'proxy.mp4':'source.mp4',
   sourceLinkCreatedAt:at,artifactKey:manifest.artifact.artifactKey,artifactSha256:manifest.artifact.sha256,artifactByteSize:String(manifest.artifact.byteSize),
   artifactMediaType:manifest.artifact.mediaType,artifactContainer:manifest.artifact.container,artifactLifecycleRevision:1,purpose:'editing',
   manifestFacts:{id:fact.manifestId,artifactId:fact.artifactId,workspaceId:scope.workspaceId,schemaVersion:manifest.schemaVersion,manifestJson:JSON.stringify(manifest),manifestHash:manifest.manifestHash,
    createdAt:at,recipeId:manifest.recipe.id,recipeVersion:manifest.recipe.version,parametersHash:manifest.recipe.parametersHash,
    recipeParametersRef:null,renderInputRef:null,renderInputHash:null,recipeParameters:null,renderInput:null}}
 })
 const derivationInput={...policy,schemaVersion:'project-fork-derivation/v3',id:kernel.document.id,kernel,kernelCanonicalJson:serializeOutputCanonicalJson(kernel.document),
  sourceEditPlanSnapshot:empty?rootFacts.find(s=>s.kind==='edit-plan'):bundle.editPlanSnapshot,sourceReferences:refs,
  sourceProject:{id:scope.projectId,workspaceId:scope.workspaceId,currentVersionId:bundle.version.id,name:'Current factual source',status:'draft',format:null,ownerId:audit.clientId,
   administrationRevision:1,updatedAt:bundle.version.createdAt,objective:'discovery',locale:'pt-BR',createdByType:'api-client',createdById:audit.clientId,createdAt:at}}
 // Project ID is only on the administrative row; link facts have their own
 // explicit sourceProjectId. No unknown field is dropped by the constructor.
 for(const ref of refs)delete ref.projectId
 return {bundle,source,kernel,derivationInput}
}

test('W66 fork3 retains actual source3 receipts and remaps clips/cues/crop without inheriting materialization',()=>{
 const fixture=currentForkFixture(),before=stableSerialize(fixture.bundle),derivation=createProjectForkDerivationV3(fixture.derivationInput)
 assert.equal(validateProjectForkSourceV3(fixture.source,null),fixture.source)
 assert.equal(validateProjectForkSourceV3(fixture.source,null),fixture.source)
 assert.equal(validateProjectForkDerivationV3(derivation),derivation)
 assert.equal(validateProjectForkDerivationV3(derivation),derivation)
 assert.equal(Object.isFrozen(fixture.source.bundle.origin.operation),true)
 const original=JSON.parse(fixture.bundle.editPlanSnapshot.contentJson),copied=materializeForkEditPlanV3(derivation)
 assert.equal(derivation.document.kernel.document.source.bundle.version.outputContractVersion,3)
 assert.equal(derivation.document.kernel.document.source.bundle.version.baseHash,fixture.bundle.version.baseHash)
 assert.equal(copied.projectVersionId,'version-full-fork3');assert.notEqual(copied.id,original.id)
 assert.ok(original.videoTracks[0].clips.length>0);assert.ok(original.subtitleTracks[0].cues.length>0)
 assert.deepEqual(copied.videoTracks[0].clips[0].crop,{x:.1,y:.15,width:.7,height:.75})
 assert.notEqual(copied.videoTracks[0].id,original.videoTracks[0].id)
 assert.notEqual(copied.videoTracks[0].clips[0].id,original.videoTracks[0].clips[0].id)
 assert.notEqual(copied.subtitleTracks[0].cues[0].id,original.subtitleTracks[0].cues[0].id)
 assert.equal(copied.subtitleTracks[0].cues[0].text,original.subtitleTracks[0].cues[0].text)
 assert.equal(copied.durationFrames,original.durationFrames);assert.deepEqual(copied.metadata,original.metadata)
 assert.equal(Object.hasOwn(copied,'manualEditing'),false);assert.equal(Object.hasOwn(copied,'approval'),false)
 assert.equal(Object.hasOwn(copied,'qualityReport'),false);assert.equal(stableSerialize(fixture.bundle),before)
})

test('W66 fork3 admits actual Creation2 source without converting it to contract1',()=>{
 const fixture=currentForkFixture({empty:true}),derivation=createProjectForkDerivationV3(fixture.derivationInput)
 assert.equal(validateCreationOutputVersionBundleV2(fixture.bundle),fixture.bundle)
 assert.equal(validateCreationOutputVersionBundleV2(fixture.bundle),fixture.bundle)
 const callerClone=clone(fixture.bundle)
 assert.notEqual(validateCreationOutputVersionBundleV2(callerClone),callerClone)
 callerClone.version.baseHash='0'.repeat(64)
 assert.throws(()=>validateCreationOutputVersionBundleV2(callerClone))
 assert.equal(derivation.document.kernel.document.source.bundle.schemaVersion,'project-creation-output-bundle/v2')
 assert.equal(derivation.document.kernel.document.source.version.outputContractVersion,2)
 assert.equal(materializeForkEditPlanV3(derivation).durationFrames,0)
})

test('W66 full-content fork3 seals a new sequence1 Creation2 with explicit revision3 and uniformly blocked consumption',()=>{
 const fixture=currentForkFixture(),derivation=createProjectForkDerivationV3(fixture.derivationInput),k=derivation.document.kernel.document
 const members=new Map(k.identityMap.map(m=>[m.kind+':'+m.sourceId,m.targetId]))
 const originals=[...Object.values(k.source.nonOutputSnapshotFacts).filter(Boolean),derivation.document.sourceEditPlanSnapshot]
 const snapshots=originals.map(original=>{
  const document=original.kind==='edit-plan'?materializeForkEditPlanV3(derivation):remapForkSnapshotDocumentV3(JSON.parse(original.contentJson),original.kind,k.source,k.target,k.identityMap,null)
  return createProjectSnapshot({schemaVersion:1,workspaceId:k.target.workspaceId,projectId:k.target.projectId,id:members.get('snapshot:'+original.id),kind:original.kind,
   contentSchemaVersion:original.contentSchemaVersion,contentJson:stableSerialize(document),contentHash:calculateCanonicalHash(document),createdAt:k.target.createdAt})
 })
 const command=createProjectCreationOutputCommandV2({...policy,id:k.target.commandId,workspaceId:k.target.workspaceId,projectId:k.target.projectId,
  versionId:k.target.resultVersionId,createdAt:k.target.createdAt,audit,payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent:k.callerIntent,
   allocations:{stateId:k.target.stateId,snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:null},snapshots,forkDerivation:derivation,
   renderableCandidate:buildForkRenderablePlanCandidateV3(derivation)}})
 const bundle=buildCreationOutputVersionBundleV2(command),entry=bundle.state.document.entries[0]
 assert.equal(bundle.version.sequence,1);assert.equal(Object.hasOwn(bundle.version,'parentVersionId'),false)
 assert.equal(bundle.version.forkedFromProjectId,fixture.bundle.version.projectId)
 assert.equal(bundle.version.forkedFromVersionId,fixture.bundle.version.id)
 assert.notEqual(bundle.state.document.id,fixture.bundle.state.document.id);assert.notEqual(bundle.version.baseHash,fixture.bundle.version.baseHash)
 assert.equal(entry.spec.schemaVersion,'output-spec-revision/v3');assert.equal(entry.spec.source.outputContractVersion,3)
 assert.deepEqual(entry.spec.effectiveSpec.profile,fixture.bundle.state.document.entries[0].spec.profile)
 assert.notEqual(entry.variantId,fixture.bundle.state.document.entries[0].variantId)
 assert.deepEqual(entry.consumption,{status:'blocked',reason:'fork-target-geometry-unmaterialized'})
 for(const purpose of ['render','critic','final'])assert.throws(()=>requireOutputStateConsumableV2(bundle.state,purpose),e=>e.code==='PRECONDITION_REQUIRED')
 const plan=JSON.parse(command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson)
 assert.equal(plan.durationFrames,60);assert.ok(plan.videoTracks[0].clips.length>0);assert.ok(plan.subtitleTracks[0].cues.length>0)
 assert.deepEqual(plan.videoTracks[0].clips[0].crop,{x:.1,y:.15,width:.7,height:.75})
})

test('W66 fork3 rejects missing/tampered actual source receipts, incomplete typed map and foreign source scope',()=>{
 const fixture=currentForkFixture(),derivation=createProjectForkDerivationV3(fixture.derivationInput)
 const callerSource=Object.freeze(clone(fixture.source))
 callerSource.bundle.version.outputStateHash='0'.repeat(64)
 assert.throws(()=>validateProjectForkSourceV3(callerSource,null))
 const callerDerivation=clone(derivation)
 assert.notEqual(validateProjectForkDerivationV3(callerDerivation),callerDerivation)
 callerDerivation.document.sourceProject.workspaceId='workspace-foreign'
 assert.throws(()=>validateProjectForkDerivationV3(callerDerivation))
 for(const [label,mutate]of [
  ['map omits cue',d=>{d.kernel.document.identityMap=d.kernel.document.identityMap.filter(m=>m.kind!=='cue')}],
  ['source contract conversion',d=>{d.kernel.document.source.version.outputContractVersion=1}],
  ['source receipt absent',d=>{delete d.kernel.document.source.bundle}],
  ['source bytes tamper',d=>{d.sourceEditPlanSnapshot.contentJson+=' '}],
  ['manifest absent',d=>{d.sourceReferences.pop()}],
  ['manifest tamper',d=>{d.sourceReferences[0].manifestFacts.manifestHash='0'.repeat(64)}],
  ['foreign source Project',d=>{d.sourceProject.workspaceId='workspace-foreign'}],
 ]) {
  const changed=clone(fixture.derivationInput);mutate(changed)
  assert.throws(()=>createProjectForkDerivationV3(changed),label)
 }
})

test('W66 operational root2 requires explicit variant3 then factual ingest3, with video/audio derivative bindings',()=>{
 const first=buildOperationalOutputVersionBundleV3(variantInput())
 assert.equal(first.version.outputContractVersion,3);assert.deepEqual(first.state.document.entries[0].consumption,{status:'blocked',reasons:['empty-project']})
 const b=buildOperationalOutputVersionBundleV3(ingestInput()),m=b.state.document.entries[0].consumption.materialization.document
 assert.equal(b.version.sequence,3);assert.equal(m.durationFrames,60);assert.equal(m.clips.length,1)
 assert.deepEqual(m.clips[0].range.startSeconds,{numerator:'0',denominator:'1'});assert.deepEqual(m.clips[0].range.endSeconds,{numerator:'2',denominator:'1'})
 assert.equal(m.clips[0].range.source.endExclusivePts,'180000');assert.equal(m.clips[0].audio.range.source.endExclusivePts,'96000')
 assert.equal(m.clips[0].renderSource.artifactId,'artifact-derivative3');assert.equal(m.clips[0].audio.renderSource.artifactId,'artifact-derivative3')
 assert.equal(m.emission.subtitles,'suppressed-missing-visual-clock-authority');assert.equal(m.emission.cta,'suppressed-missing-visual-clock-authority')
})
test('W66 observed ranges retain different native FPS and explicit measured gaps',()=>{
 const n=normalization({nativeFps:60}),r=materializeObservedOutputRangeV3(n,0,60,30)
 assert.equal(r.source.firstFrame,0);assert.equal(r.source.lastFrame,119);assert.equal(r.source.endExclusivePts,'180000')
 const gap=normalization({gapAt:30,gapPts:3000}),g=materializeObservedOutputRangeV3(gap,0,60,30)
 assert.equal(g.source.coverage,'contains-measured-gaps');assert.deepEqual(g.source.gaps,[{startPts:'90000',endPts:'93000'}])
 invalid(()=>materializeObservedOutputRangeV3(gap,30,31,30))
 invalid(()=>materializeObservedOutputRangeV3(normalization({initialPts:3000}),0,60,30))
})
test('W66 probe rejects rehashed unsafe numeric timestamps, duplicate stream and false frame-end coverage',()=>{
 for(const [label,mutate] of [['unsafe',r=>{r.frames[0].best_effort_timestamp=9007199254740992}],['duplicate-stream',r=>{r.streams.push({...r.streams[0]})}],['duration-unsafe',r=>{r.frames[0].duration=9007199254740992}]]) {
  const p=clone(observed()),raw=JSON.parse(p.rawJson);mutate(raw);p.rawJson=JSON.stringify(raw);p.rawSha256=sha(p.rawJson)
  assert.throws(()=>validateOutputObservedProbeV3(p),e=>e.code==='INVALID_RENDER_INPUT',label)
 }
 const p=clone(observed());p.frameEndPts[0]='6000';invalid(()=>validateOutputObservedProbeV3(p))
})
test('W66 normalization rejects altered recipe/argv/bytes and omitted real audio even when newly resealed',()=>{
 for(const [label,mutate] of [['argv',d=>{d.execution.argv[11]='fps=30'}],['recipe',d=>{d.derivative.manifest.recipe.version='1.1.0'}],
  ['source-after',d=>{d.execution.sourceSha256After='c'.repeat(64)}],['audio',d=>{d.audioProbes.source=null}]]) {
  const d=clone(normalization().document);mutate(d);assert.throws(()=>sealOutputNormalizationV3(d),e=>e.code==='INVALID_RENDER_INPUT'||e.code==='INVALID_MEDIA_ARTIFACT',label)
 }
})
test('W66 ingest denies sibling/version/provenance reseals instead of inventing a format/variant',()=>{
 const input=ingestInput(),bad=clone(input);bad.origin.detail.sourceArtifactId='artifact-sister'
 assert.throws(()=>buildOperationalOutputVersionBundleV3(bad),e=>e.code==='INVALID_COMMAND')
 const missing=clone(input);missing.parent=buildCreationOutputVersionBundleV2(root().command);missing.allocation.parentVersionId=missing.parent.version.id;missing.allocation.sequence=2
 assert.throws(()=>buildOperationalOutputVersionBundleV3(missing),e=>e.code==='PRECONDITION_REQUIRED')
 const original=stableSerialize(input.parent);buildOperationalOutputVersionBundleV3(input);assert.equal(stableSerialize(input.parent),original)
})

test('W66 .25/4 rate maps and multilayer gaps are retained by materialization and real selection',()=>{
 const input=ingestInput(),p=clone(JSON.parse(input.editPlanSnapshot.contentJson)),clip=p.videoTracks[0].clips[0]
 p.durationFrames=128
 p.videoTracks=[{id:'track-slow',kind:'base-video',clips:[{...clip,id:'clip-slow',sourceInFrame:0,sourceOutFrame:32,timelineInFrame:0,timelineOutFrame:128,rate:.25}]},
  {id:'track-fast-layer',kind:'base-video',clips:[{...clip,id:'clip-fast',sourceInFrame:0,sourceOutFrame:60,timelineInFrame:40,timelineOutFrame:55,rate:4}]}]
 const m=materializeOutputV3({id:'materialization-rates',...scope,resultVersionId:p.projectVersionId,planSnapshotId:'snapshot-rates',planHash:calculateCanonicalHash(p),
  plan:p,spec:spec(input.allocation.createdAt),normalizations:input.normalizations,createdAt:input.allocation.createdAt})
 assert.equal(m.document.clips.length,2);assert.equal(m.document.clips[0].rate,.25);assert.equal(m.document.clips[1].rate,4)
 assert.equal(m.document.clips[1].timelineInFrame,40);assert.equal(m.document.clips[1].timelineOutFrame,55)
 const before=stableSerialize(p),selected=materializeManualEditPlan({editPlan:p,operation:{kind:'select',clipId:'clip-fast'},newVersionId:'version-selected-rates',
  createdAt:'2026-10-14T12:00:03.000Z',availableAssetIds:[],variantId:'output-alpha'})
 assert.deepEqual(selected.videoTracks,p.videoTracks);assert.deepEqual(selected.audioTracks,p.audioTracks);assert.equal(selected.durationFrames,128)
 assert.equal(stableSerialize(p),before)
})


function manualInput(parent,{target=null,suffix='select',action=target?'restore':'apply'}={}) {
 const createdAt=new Date(Date.parse(parent.version.createdAt)+1).toISOString(),versionId='version-'+suffix,commandId='command-'+suffix
 const before=JSON.parse(parent.editPlanSnapshot.contentJson),source=target??parent,sourcePlan=JSON.parse(source.editPlanSnapshot.contentJson)
 const variantId='output-alpha',targetId=action==='apply'?before.videoTracks[0].clips[0].id:target.version.id
 const operation=action==='apply'?{kind:'select',clipId:targetId}:undefined
 const plan=action==='apply'?materializeManualEditPlan({editPlan:before,operation,newVersionId:versionId,createdAt,availableAssetIds:[],variantId}):
  materializeManualRestorePlan({targetEditPlan:sourcePlan,action,targetVersionId:target.version.id,newVersionId:versionId,createdAt,variantId})
 const impact=createManualCommandImpact({commandId,baseVersionId:parent.version.id,resultVersionId:versionId,variantId,targetId,action,
  ...(operation?{operation}:{}),beforeEditPlan:before,afterEditPlan:plan,outputReferences:[]})
 const command=createEditCommand({...scope,id:commandId,type:'manual-edit',baseVersionId:parent.version.id,baseHash:parent.version.baseHash,
  author:{type:'api-client',id:audit.clientId},scope:{clipIds:[targetId],outputSpecIds:[variantId]},
  payload:{schemaVersion:2,action,expectedRevision:parent.version.sequence,variantId,targetId,...(operation?{operation}:{}),
   ...(target?{restoresVersionId:target.version.id}:{}),impact},reason:'explicit controlled '+suffix,idempotencyKey:'request-'+suffix,createdAt})
 const requestFingerprint=manualFingerprint(command)
 const origin={kind:target?'restore-command':'inherit-command',command,audit,requestFingerprint,...(target?{
  target:{versionId:target.version.id,baseHash:target.version.baseHash,stateId:target.state.document.id,stateHash:target.state.stateHash}}:{})}
 const norms=new Map(source.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[]).map(n=>[n.document.id,n]))
 return {allocation:{...scope,resultVersionId:versionId,stateId:'state-'+suffix,parentVersionId:parent.version.id,sequence:parent.version.sequence+1,
  createdBy:audit.clientId,createdAt},parent,origin,restoreTarget:target,editPlanSnapshot:snapshot('snapshot-'+suffix,'edit-plan',plan,createdAt),
  normalizations:[...norms.values()],materializationIds:Object.fromEntries(source.state.document.entries.map(e=>[e.variantId,'materialization-'+suffix+'-'+e.variantId]))}
}
function manualFingerprint(c) {
 const p=c.payload
 return calculateCanonicalHash({type:'manual-edit',workspaceId:c.workspaceId,projectId:c.projectId,baseVersionId:c.baseVersionId,baseHash:c.baseHash,
  expectedRevision:p.expectedRevision,action:p.action,variantId:p.variantId,targetId:p.targetId,operation:p.operation??null,
  targetVersionId:p.restoresVersionId??null,reason:c.reason?.trim()||null,actorContextHash:audit.contextHash})
}
function resealManualOrigin(input,mutate) {
 const bad=clone(input);mutate(bad)
 const {schemaVersion,commandHash,...body}=bad.origin.command
 bad.origin.command=createEditCommand(body);bad.origin.requestFingerprint=manualFingerprint(bad.origin.command)
 return bad
}
test('W66 select and explicit restore create fresh State3 materializations from the exact inherited observations',()=>{
 const ingest=buildOperationalOutputVersionBundleV3(ingestInput()),sourceText=stableSerialize(ingest)
 const selected=buildOperationalOutputVersionBundleV3(manualInput(ingest)),restored=buildOperationalOutputVersionBundleV3(manualInput(selected,{target:ingest,suffix:'restore'}))
 for(const [child,transition]of [[selected,'inherit'],[restored,'restore']]) {
  assert.equal(child.version.outputContractVersion,3);assert.equal(child.state.document.transition,transition)
  assert.deepEqual(JSON.parse(child.editPlanSnapshot.contentJson).videoTracks,JSON.parse(ingest.editPlanSnapshot.contentJson).videoTracks)
  const m=child.state.document.entries[0].consumption.materialization.document,original=ingest.state.document.entries[0].consumption.materialization.document
  assert.notEqual(m.id,original.id);assert.notEqual(child.editPlanSnapshot.id,ingest.editPlanSnapshot.id)
  assert.deepEqual(m.normalizations,original.normalizations);assert.deepEqual(m.clips,original.clips)
  assert.deepEqual(m.audioTracks,original.audioTracks);assert.deepEqual(m.emission,original.emission)
  assert.equal(m.emission.subtitles,'suppressed-missing-visual-clock-authority')
 }
 assert.equal(restored.origin.target.versionId,ingest.version.id);assert.equal(stableSerialize(ingest),sourceText)
})
test('W66 manual origin rejects fully rehashed revision, scope, selected target and impact forgeries',()=>{
 const parent=buildOperationalOutputVersionBundleV3(ingestInput()),input=manualInput(parent)
 for(const [label,mutate]of [
  ['revision',b=>{b.origin.command.payload.expectedRevision++}],['scope',b=>{b.origin.command.scope.clipIds=['clip-outside']}],
  ['variant',b=>{b.origin.command.payload.variantId='output-outside'}],['target',b=>{b.origin.command.payload.targetId='clip-outside'}],
  ['impact-range',b=>{b.origin.command.payload.impact.affectedRanges[0].endFrame--;const {impactHash,...body}=b.origin.command.payload.impact;b.origin.command.payload.impact.impactHash=calculateCanonicalHash(body)}],
  ['unknown-payload',b=>{b.origin.command.payload.extra=true}]]) {
  assert.throws(()=>buildOperationalOutputVersionBundleV3(resealManualOrigin(input,mutate)),e=>e.code==='INVALID_COMMAND',label)
 }
 const bad=clone(input),fresh=clone(bad.normalizations[0].document);fresh.id='normalization-reobserved';bad.normalizations=[sealOutputNormalizationV3(fresh)]
 assert.throws(()=>buildOperationalOutputVersionBundleV3(bad),e=>e.code==='INVALID_COMMAND'&&e.message==='Manual child must reuse exact source normalization observations')
})
test('W66 restore verifies the factual target and preserves .25/4 multilayer gaps and source audio clocks',()=>{
 const input=ingestInput(),p=clone(JSON.parse(input.editPlanSnapshot.contentJson)),clip=p.videoTracks[0].clips[0]
 p.durationFrames=128;p.videoTracks=[{id:'track-slow',kind:'base-video',clips:[{...clip,id:'clip-slow',sourceInFrame:0,sourceOutFrame:32,timelineInFrame:0,timelineOutFrame:128,rate:.25}]},
  {id:'track-fast',kind:'base-video',clips:[{...clip,id:'clip-fast',sourceInFrame:0,sourceOutFrame:60,timelineInFrame:40,timelineOutFrame:55,rate:4}]}]
 input.editPlanSnapshot=snapshot(input.editPlanSnapshot.id,'edit-plan',p,input.allocation.createdAt)
 const ingest=buildOperationalOutputVersionBundleV3(input),selected=buildOperationalOutputVersionBundleV3(manualInput(ingest,{suffix:'select-rates'}))
 const restore=manualInput(selected,{target:ingest,suffix:'restore-rates'}),restored=buildOperationalOutputVersionBundleV3(restore)
 assert.deepEqual(JSON.parse(restored.editPlanSnapshot.contentJson).videoTracks,p.videoTracks)
 assert.equal(restored.state.document.entries[0].consumption.materialization.document.clips[1].timelineInFrame,40)
 const wrong=clone(restore);wrong.origin.target.stateHash='1'.repeat(64)
 assert.throws(()=>buildOperationalOutputVersionBundleV3(wrong),e=>e.code==='INVALID_COMMAND'&&e.message==='Restore target seal/scope differs')
 const altered=clone(restore),plan=JSON.parse(altered.editPlanSnapshot.contentJson);plan.videoTracks[1].clips[0].timelineInFrame=41
 altered.editPlanSnapshot=snapshot(altered.editPlanSnapshot.id,'edit-plan',plan,altered.allocation.createdAt)
 assert.throws(()=>buildOperationalOutputVersionBundleV3(altered),e=>e.code==='INVALID_COMMAND'&&e.message==='Origin target differs from real manual constructor')
})
