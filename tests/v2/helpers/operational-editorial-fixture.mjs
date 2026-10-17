import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { calculateCanonicalHash,stableSerialize } from '../../../src/v2/domain/canonical-hash.ts'
import { createExternalAuditContext, materializeActorAuditContext } from '../../../src/v2/application/authenticate-api-client.ts'
import { createOutputSpecRevisionBody } from '../../../src/v2/domain/output-spec-revision.ts'
import { createOutputVariantCommand } from '../../../src/v2/domain/output-variant-command.ts'
import { createQueuedPublicOperation,startPublicOperationAttempt,advancePublicOperationPhase } from '../../../src/v2/domain/public-operation.ts'
import { createMediaTranscript } from '../../../src/v2/domain/media-transcript.ts'
import { createMediaArtifactManifest,createMediaArtifactManifestV2 } from '../../../src/v2/domain/media-artifact.ts'
import { validateOutputObservedProbeV3,sealOutputNormalizationV3 } from '../../../src/v2/domain/output-materialization.ts'
import { observedAudioFromVideoProbeV3 } from '../../../src/v2/infrastructure/media/video-probe.ts'
import { compileInitialSourceEditPlan } from '../../../src/v2/application/apply-editorial-cut-command.ts'
import { createProjectSnapshot } from '../../../src/v2/domain/project-snapshot.ts'
import { buildOperationalOutputVersionBundleV3,buildCreationOutputVersionBundleV2 } from '../../../src/v2/domain/output-version-bundle.ts'
import { createProjectCreationOutputCommandV2,normalizeProjectCreationIntentV2 } from '../../../src/v2/domain/project-creation-command.ts'
import { createProductionBrief } from '../../../src/v2/domain/production-brief.ts'
import { duplicateProjectService } from '../../../src/v2/application/duplicate-project.ts'
// Fixed, payload-free diagnostics for the supervised one-case investigation.
// The synchronous fd2 sink does not retain a stream or create another process.
// Diagnostic sink failure never substitutes for the actual constructor error.
const fixturePhaseOrigin=performance.now(),fixturePhaseLimit=64
let fixturePhaseOrdinal=0
function emitFixturePhase(phase,state,started) {
 if(fixturePhaseOrdinal>=fixturePhaseLimit)return
 const now=performance.now(),fact={kind:'w66-editorial-fixture-phase',phase,state,
  ordinal:++fixturePhaseOrdinal,limit:fixturePhaseLimit,elapsedMs:Math.round((now-fixturePhaseOrigin)*1000)/1000,
  phaseElapsedMs:Math.round((now-started)*1000)/1000}
 try {writeSync(2,JSON.stringify(fact)+'\n')}catch {} // Observation only; no runtime recovery.
}
export function editorialFixturePhaseStart(phase) {
 const started=performance.now();emitFixturePhase(phase,'start',started)
 return ()=>emitFixturePhase(phase,'end',started)
}
function traceEditorialFixtureSync(phase,work) {
 const finish=editorialFixturePhaseStart(phase)
 try {return work()}finally {finish()}
}
export async function traceEditorialFixtureAsync(phase,work) {
 const finish=editorialFixturePhaseStart(phase)
 try {return await work()}finally {finish()}
}
editorialFixturePhaseStart('helper-module-enter')()
function defaultActor(){const auditContext=createExternalAuditContext({clientId:'client-1',credentialId:'credential-1',workspaceId:'workspace-1',environment:'sandbox'});return {...auditContext,scopes:new Set(['projects:write']),authenticationKind:'bearer',clientKillSwitchEngaged:false,workspaceKillSwitchEngaged:false,clientAccessStatus:'active',workspaceAccessStatus:'active',auditContext}}
// Synthetic probe/execution facts exercise domain invariants only. The actual
// native/persistence proof belongs to the PG owner, never this fixture.
const sha=text=>createHash('sha256').update(text).digest('hex')
function observed({derivative=false,nativeFps=30,durationFrames=60,gapAt=-1,gapPts=0,initialPts=0}={}) {
 const step=90000/nativeFps;assert.ok(Number.isSafeInteger(step))
 const video=Array.from({length:durationFrames},(_,i)=>({media_type:'video',stream_index:0,best_effort_timestamp:initialPts+i*step+(i>=gapAt&&gapAt>=0?gapPts:0),duration:step}))
 const audio=Array.from({length:durationFrames},(_,i)=>({media_type:'audio',stream_index:1,best_effort_timestamp:i*1600,duration:1600}))
 const raw={format:{start_time:'0.000000',duration:String(durationFrames/nativeFps),format_name:'mov,mp4,m4a,3gp,3g2,mj2'},streams:[
  {index:0,codec_type:'video',codec_name:'h264',width:derivative?1280:320,height:derivative?720:180,avg_frame_rate:nativeFps+'/1',time_base:'1/90000',start_time:'0.000000'},
  {index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:1,time_base:'1/48000',start_time:'0.000000'}],frames:[...video,...audio]}
 const rawJson=JSON.stringify(raw),timeBase={numerator:'1',denominator:'90000'}
 return traceEditorialFixtureSync(derivative?'probe-derivative':'probe-source',()=>validateOutputObservedProbeV3({schemaVersion:'output-observed-probe/v3',binarySha256:'e'.repeat(64),rawJson,rawSha256:sha(rawJson),streamIndex:0,mediaType:'video',sampleRateHz:null,channels:null,
  originSource:'format-start-time',originSeconds:{numerator:'0',denominator:'1'},width:raw.streams[0].width,height:raw.streams[0].height,fps:{numerator:String(nativeFps),denominator:'1'},rotationDegrees:0,timeBase,
  frames:video.map((v,frame)=>({frame,pts:String(v.best_effort_timestamp),timeBase})),frameEndPts:video.map(v=>String(v.best_effort_timestamp+v.duration)),endPts:String(video.at(-1).best_effort_timestamp+step)}))
}
function normalization(sourceProjectId,scope,options={}) {
 const sourceProbe=observed(options),derivativeProbe=observed({...options,derivative:true})
 const sourceManifest=createMediaArtifactManifest({artifactKey:'controlled/source.mp4',artifactSha256:'a'.repeat(64),byteSize:1000,mediaType:'video',container:'mp4',recipe:{id:'direct-upload',version:'1.0.0',parameters:{mimeType:'video/mp4'}},
  probe:{width:sourceProbe.width,height:sourceProbe.height,duration:(options.durationFrames??60)/(options.nativeFps??30),fps:options.nativeFps??30}})
 const derivativeManifest=createMediaArtifactManifestV2({artifactKey:'controlled/derivative.mp4',artifactSha256:'b'.repeat(64),byteSize:2000,mediaType:'video',container:'mp4',
  recipe:{id:'editing-proxy',version:'1.2.0',parameters:{normalizationPolicy:'output-normalization-receipt/v3',maxWidth:1280,maxHeight:1280,videoCodec:'h264',audioCodec:'aac'}},
  sources:[{artifactKey:sourceManifest.artifact.artifactKey,sha256:sourceManifest.artifact.sha256,role:'source-master',execution:{tool:{id:'ffmpeg',version:'static',digest:'f'.repeat(64)}}}],
  probe:{width:derivativeProbe.width,height:derivativeProbe.height,duration:(options.durationFrames??60)/(options.nativeFps??30),fps:options.nativeFps??30}})
 return traceEditorialFixtureSync('normalization-seal',()=>sealOutputNormalizationV3({canonicalPolicyVersion:'output-canonical-json/v1',schemaVersion:'output-normalization-receipt/v3',id:'normalization-ingest3',kind:'ffmpeg-video-derivative',workspaceId:scope.workspaceId,projectId:sourceProjectId,operationId:'operation-ingest3',attempt:1,leaseOwner:'worker-ingest3',
  source:{artifactId:'artifact-source3',manifestId:'manifest-source3',manifest:sourceManifest},derivative:{artifactId:'artifact-derivative3',manifestId:'manifest-derivative3',manifest:derivativeManifest},
  sourceProbe,derivativeProbe,audioProbes:{source:observedAudioFromVideoProbeV3(sourceProbe),derivative:observedAudioFromVideoProbeV3(derivativeProbe)},
  execution:{provider:'ffmpeg',recipeVersion:'media-normalization-execution/2026-10-14-v3',binarySha256:'f'.repeat(64),argv:['-hide_banner','-loglevel','error','-y','-i','/controlled/source.mp4','-map','0:v:0','-map','0:a:0?',
   '-vf','scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-movflags','+faststart','/controlled/derivative.mp4'],
   spawnObserved:true,closeObserved:true,exitCode:0,sourceSha256Before:'a'.repeat(64),sourceSha256After:'a'.repeat(64),derivativeSha256:'b'.repeat(64),autorotate:true},createdAt:options.createdAt??'2026-10-14T12:00:02.000Z'}))
}
export async function prepareEditorialSourceFixture(creation,receipt,options={}) {
 const finishSource=editorialFixturePhaseStart('prepare-source')
 const scope={workspaceId:receipt.bundle.version.workspaceId,projectId:receipt.projectAtCreation.id},audit=materializeActorAuditContext(options.actor??defaultActor()),policy={canonicalPolicyVersion:'output-canonical-json/v1'}
 const createdAt=options.variantAt??'2026-10-14T12:00:01.000Z',encoding=final=>({codec:'h264',encoder:'libx264',pixelFormat:'yuv420p',container:'mp4',faststart:true,width:final?640:320,height:final?360:180,fps:30,
  quality:{mode:'crf',value:final?18:23,preset:final?'medium':'veryfast'},audio:{codec:'aac',bitrateKbps:final?192:160,sampleRateHz:48000,channels:1}})
 const revision=traceEditorialFixtureSync('source-spec',()=>createOutputSpecRevisionBody({...scope,...policy,id:'revision-editorial-source',variantId:'variant-editorial-source',revisionNumber:1,createdAt,
  output:{schemaVersion:1,id:'variant-editorial-source',locale:'pt-BR',aspectRatio:'16:9',width:640,height:360,fps:30,safeArea:{top:.08,right:.06,bottom:.06,left:.06},deliveryProfileId:'profile-explicit'},
  profile:{schemaVersion:'materialized-delivery-profile/v1',id:'profile-explicit',version:1,rendererContractVersion:'ffmpeg-editorial-output/v1',final:encoding(true),proxy:encoding(false),
   proxyToFinal:{schemaVersion:'output-canvas-transform/v1',scaleX:2,scaleY:2},subtitles:{mode:'none',configuration:null,fontAssets:[]}},preset:null}))
 const root=receipt.bundle,result=traceEditorialFixtureSync('source-variant-command',()=>createOutputVariantCommand({command:{...scope,id:'command-editorial-source-variant',baseVersionId:root.version.id,baseHash:root.version.baseHash,type:'create-output-variant',author:{type:'api-client',id:audit.clientId},
  idempotencyKey:'editorial-source-variant',createdAt},audit,base:root.version,baseState:root.state,historicalBaselineRequested:false,revision,expectedRevisionId:null,expectedSpecHash:null,durationFrames:0}))
 const makeSnapshot=(id,plan,time)=>createProjectSnapshot({...scope,id,kind:'edit-plan',contentSchemaVersion:2,contentJson:stableSerialize(plan),contentHash:calculateCanonicalHash(plan),createdAt:time})
 const rootPlan=JSON.parse(root.command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson),variantPlan={...rootPlan,id:'edit-plan-editorial-source-variant',projectVersionId:'version-editorial-source-variant',createdAt}
 let variant=traceEditorialFixtureSync('variant-bundle',()=>buildOperationalOutputVersionBundleV3({allocation:{...scope,resultVersionId:variantPlan.projectVersionId,stateId:'state-editorial-source-variant',parentVersionId:root.version.id,sequence:2,createdBy:audit.clientId,createdAt},
  parent:root,origin:{kind:'create-output-variant',result},restoreTarget:null,editPlanSnapshot:makeSnapshot('snapshot-editorial-source-variant',variantPlan,createdAt),normalizations:[],materializationIds:{}}))
 if(options.sibling) {
  const r=createOutputSpecRevisionBody({...revision,id:'revision-editorial-sibling',variantId:'variant-editorial-sibling',output:{...revision.output,id:'variant-editorial-sibling'}})
  const result=traceEditorialFixtureSync('sibling-command',()=>createOutputVariantCommand({command:{...scope,id:'command-editorial-sibling',baseVersionId:variant.version.id,baseHash:variant.version.baseHash,type:'create-output-variant',author:{type:'api-client',id:audit.clientId},
   idempotencyKey:'editorial-sibling',createdAt},audit,base:variant.version,baseState:variant.state,historicalBaselineRequested:false,revision:r,expectedRevisionId:null,expectedSpecHash:null,durationFrames:0}))
  const plan={...JSON.parse(variant.editPlanSnapshot.contentJson),id:'edit-plan-editorial-sibling',projectVersionId:'version-editorial-sibling'}
  variant=traceEditorialFixtureSync('sibling-bundle',()=>buildOperationalOutputVersionBundleV3({allocation:{...scope,resultVersionId:plan.projectVersionId,stateId:'state-editorial-sibling',parentVersionId:variant.version.id,sequence:variant.version.sequence+1,createdBy:audit.clientId,createdAt},
   parent:variant,origin:{kind:'create-output-variant',result},restoreTarget:null,editPlanSnapshot:makeSnapshot('snapshot-editorial-sibling',plan,createdAt),normalizations:[],materializationIds:{}}))
 }
 const at=options.ingestAt??'2026-10-14T12:00:02.000Z',transcript=options.transcript??createMediaTranscript({language:'pt-BR',text:'Fonte controlada.',words:[{word:'Fonte',start:0,end:1},{word:'controlada.',start:1,end:2}],
  segments:[{id:0,start:0,end:2,text:'Fonte controlada.'}],provider:'controlled',model:'explicit-domain-fixture'})
 let op=advancePublicOperationPhase(startPublicOperationAttempt(createQueuedPublicOperation({...scope,id:'operation-ingest3',clientId:audit.clientId,type:'media-ingest',target:{type:'media-artifact',id:'artifact-source3',manifestId:'manifest-source3'},createdAt}),at),'persisting',at)
 const {completedAt,nextAttemptAt,deadLetteredAt,result:unusedResult,error,...operation}=op
 // Native observations use their own explicit 30/1 clock. The requested
 // timeline clock is separately supplied (including the original decimal FPS
 // vector); the measured coverage encloses the conservative compiler frames.
 const nativeFps=30,observedFrames=Math.ceil((options.sourceDurationSeconds??2)*nativeFps)
 const n=traceEditorialFixtureSync('normalization',()=>normalization(scope.projectId,scope,{createdAt:at,nativeFps,durationFrames:observedFrames})),plan=traceEditorialFixtureSync('compile-source',()=>compileInitialSourceEditPlan({id:'edit-plan-ingest3',projectVersionId:'version-ingest3',transcriptId:'transcript-ingest3',transcript,
  sourceArtifactId:'artifact-source3',sourceDurationSeconds:options.sourceDurationSeconds??2,fps:options.fps??30,createdAt:at,sourceTranscriptCueIntent:options.cueIntent===false?undefined:{schemaVersion:'source-transcript-cue-intent/v1',kind:'alignment-only',emission:'suppressed-missing-visual-clock-authority',trackId:'track-source-captions',cueIdPrefix:'cue-source'}}))
 const bundle=traceEditorialFixtureSync('ingest-bundle',()=>buildOperationalOutputVersionBundleV3({allocation:{...scope,resultVersionId:'version-ingest3',stateId:'state-ingest3',parentVersionId:variant.version.id,sequence:variant.version.sequence+1,createdBy:audit.clientId,createdAt:at},parent:variant,
  origin:{kind:'ingest-operation',operation,requestFingerprint:calculateCanonicalHash({controlled:'explicit-ingest-request'}),leaseOwner:'worker-ingest3',detail:{uploadId:'00000000-0000-4000-a000-000000000001',sourceArtifactId:'artifact-source3',sourceManifestId:'manifest-source3'},
   transcript:{...scope,id:'transcript-ingest3',sourceArtifactId:'artifact-source3',sourceManifestId:'manifest-source3',document:transcript,createdAt:at}},restoreTarget:null,editPlanSnapshot:makeSnapshot('snapshot-ingest3',plan,at),normalizations:[n],materializationIds:Object.fromEntries(variant.state.document.entries.map(e=>[e.variantId,'materialization-ingest3-'+e.variantId]))}))
 const refs=[n.document.source,n.document.derivative].map((f,i)=>({artifactId:f.artifactId,role:i?'editing-proxy':'source-master',originalFileName:i?'proxy.mp4':'source.mp4',
  sourceLinkId:i?'11111111-1111-4111-8111-111111111112':'11111111-1111-4111-8111-111111111111',workspaceId:scope.workspaceId,sourceProjectId:scope.projectId,sourceLinkCreatedAt:at,
  artifactKey:f.manifest.artifact.artifactKey,artifactSha256:f.manifest.artifact.sha256,artifactByteSize:String(f.manifest.artifact.byteSize),artifactMediaType:'video',artifactContainer:'mp4',artifactLifecycleRevision:1,purpose:'editing',
  manifestFacts:{id:f.manifestId,artifactId:f.artifactId,workspaceId:scope.workspaceId,schemaVersion:f.manifest.schemaVersion,manifestJson:JSON.stringify(f.manifest),manifestHash:f.manifest.manifestHash,createdAt:at,
   recipeId:f.manifest.recipe.id,recipeVersion:f.manifest.recipe.version,parametersHash:f.manifest.recipe.parametersHash,recipeParametersRef:null,renderInputRef:null,renderInputHash:null,recipeParameters:null,renderInput:null}}))
 assert.equal(plan.durationFrames,Math.floor((options.sourceDurationSeconds??2)*(options.fps??30)+1e-7))
 assert.equal(n.document.sourceProbe.frames.length,observedFrames)
 assert.equal(n.document.sourceProbe.fps.numerator,'30');assert.equal(n.document.sourceProbe.fps.denominator,'1')
 finishSource();return {bundle,transcript,n,refs,variant}
}

export async function createEditorialForkFixture({actor,transcript,sourceDurationSeconds,fps,sibling=true}) {
 const finishFork=editorialFixturePhaseStart('prepare-fork')
 const policy={canonicalPolicyVersion:'output-canonical-json/v1'},scope={workspaceId:actor.workspaceId,projectId:'project-editorial-source'},at='2026-07-18T20:00:00.000Z',versionId='version-editorial-source-root'
 const callerIntent=normalizeProjectCreationIntentV2({schemaVersion:'project-creation-intent/v2',kind:'initialize-empty',name:'Explicit editorial source',objective:'discovery',locale:'pt-BR',briefing:null,desiredAction:{}})
 const documents=[['brief',{schemaVersion:1,objective:callerIntent.objective,desiredAction:callerIntent.desiredAction,productionBrief:createProductionBrief({}),createdAt:at}],
  ['policies',{schemaVersion:1,workspaceId:scope.workspaceId,state:'unconfigured',brandKitMode:'inherit',guardrails:[],createdAt:at}],
  ['edit-plan',{schemaVersion:2,state:'uncompiled',id:'edit-plan-editorial-source-root',projectVersionId:versionId,fps:30,durationFrames:0,sources:[],videoTracks:[],subtitleTracks:[],audioTracks:[],overlayTracks:[],effectTracks:[],createdAt:at}]]
 const snapshots=traceEditorialFixtureSync('root-snapshots',()=>documents.map(([kind,doc])=>createProjectSnapshot({...scope,id:'snapshot-editorial-source-'+kind,kind,contentSchemaVersion:doc.schemaVersion,contentJson:stableSerialize(doc),contentHash:calculateCanonicalHash(doc),createdAt:at})))
 const rootBundle=traceEditorialFixtureSync('root-command-bundle',()=>buildCreationOutputVersionBundleV2(createProjectCreationOutputCommandV2({...policy,...scope,id:'creation-editorial-source-root',versionId,audit:materializeActorAuditContext(actor),createdAt:at,
  payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent,allocations:{stateId:'state-editorial-source-root',snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:null},snapshots,forkDerivation:null,renderableCandidate:null}})))
 const prepared=await prepareEditorialSourceFixture(null,{bundle:rootBundle,projectAtCreation:{id:scope.projectId}},
  {actor,transcript,sourceDurationSeconds,fps,sibling,cueIntent:false,variantAt:'2026-07-18T20:01:00.000Z',ingestAt:'2026-07-18T20:02:00.000Z'})
 const sourceProject={id:scope.projectId,...scope,currentVersionId:prepared.bundle.version.id,name:'Explicit editorial source',status:'draft',format:null,ownerId:actor.clientId,
  objective:'discovery',locale:'pt-BR',createdBy:{type:'api-client',id:actor.clientId},createdAt:at}
 const projectFacts={id:scope.projectId,workspaceId:scope.workspaceId,currentVersionId:prepared.bundle.version.id,name:sourceProject.name,status:'draft',format:null,ownerId:actor.clientId,
  administrationRevision:1,updatedAt:prepared.bundle.version.createdAt,objective:'discovery',locale:'pt-BR',createdByType:'api-client',createdById:actor.clientId,createdAt:at}
 let count=0;const makeId=kind=>kind==='project'?'project-1':kind==='project-version'?'project-version-1':kind==='project-media-asset'?
  '33333333-3333-4333-8333-'+String(++count).padStart(12,'0'):kind+'-editorial-source-'+(++count)
 const duplicate=duplicateProjectService({clock:()=>new Date('2026-07-18T20:03:00.000Z'),createId:makeId,createEventId:()=> '00000000-0000-4000-8000-'+String(++count).padStart(12,'0'),repository:{
  findIdempotent:async()=>null,readSource:async()=>({project:sourceProject,projectFacts,version:prepared.bundle.version,bundle:prepared.bundle,snapshots:prepared.bundle.snapshots,renderablePlanSnapshot:null,media:prepared.refs}),
  duplicateOrReplay:async input=>{const command=traceEditorialFixtureSync('fork-recompose',()=>input.write.recompose({schemaVersion:'project-creation-source-facts/v3',project:projectFacts,bundle:prepared.bundle,snapshots:prepared.bundle.snapshots,
   editPlanSnapshot:prepared.bundle.editPlanSnapshot,renderablePlanSnapshot:null,references:prepared.refs.map(r=>({...r,targetLinkId:input.write.proposal.payload.forkDerivation.document.sourceReferences.find(f=>f.sourceLinkId===r.sourceLinkId).targetLinkId}))}));
   const bundle=traceEditorialFixtureSync('fork-creation-bundle',()=>buildCreationOutputVersionBundleV2(command));return {project:input.project,version:bundle.version,bundle,sharedArtifactIds:prepared.refs.map(r=>r.artifactId),copiedBytes:0,replayed:false}},
 }})
 const fork=await traceEditorialFixtureAsync('duplicate-service',()=>duplicate({workspaceId:scope.workspaceId,projectId:scope.projectId,expectedVersionId:prepared.bundle.version.id,expectedVersionHash:prepared.bundle.version.baseHash,
  actor,idempotency:{clientId:actor.clientId,key:'editorial-fixture-fork'}}))
 const finishContext=editorialFixturePhaseStart('context')
 const derivation=fork.bundle.command.payload.forkDerivation,original=derivation.document.kernel.document.source,inventory=derivation.document.sourceReferences.map(r=>({linkId:r.targetLinkId,artifactId:r.artifactId,role:r.role,
  manifestId:r.manifestFacts.id,manifestHash:r.manifestFacts.manifestHash,artifactSha256:r.artifactSha256,rightsSnapshotId:null,rightsHash:null,rightsRevision:0}))
 const context={projectId:fork.project.id,workspaceId:scope.workspaceId,currentVersion:fork.version,parent:fork.bundle,transcriptId:prepared.bundle.origin.transcript.id,transcript,
  sourceArtifactId:prepared.n.document.source.artifactId,sourceDurationSeconds,sourceFps:fps,currentDurationFrames:JSON.parse(fork.bundle.command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson).durationFrames,
  variantId:fork.bundle.state.document.entries[0].variantId,normalizations:[prepared.n],outputReferences:[],sourceBindingFacts:{schemaVersion:'editorial-source-binding/v1',canonicalPolicyVersion:'output-canonical-json/v1',workspaceId:scope.workspaceId,projectId:fork.project.id,
   authority:{kind:'fork-derivation3',sourceProjectId:original.version.projectId,sourceVersionId:original.version.id,sourceBaseHash:original.version.baseHash,sourceStateId:original.state.document.id,sourceStateHash:original.state.stateHash,
    forkRootVersionId:fork.version.id,forkRootStateId:fork.bundle.state.document.id,forkRootStateHash:fork.bundle.state.stateHash,derivationId:derivation.document.id,derivationHash:derivation.derivationHash},
   transcript:prepared.bundle.origin.transcript,normalizationRefs:[{id:prepared.n.document.id,projectId:prepared.n.document.projectId,receiptHash:prepared.n.receiptHash}],inventory}}
 finishContext();finishFork();return {fork,prepared,context}
}
