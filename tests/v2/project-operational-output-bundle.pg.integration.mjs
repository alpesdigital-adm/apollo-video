import assert from 'node:assert/strict'
import { randomUUID,createHash } from 'node:crypto'
import { join,resolve,isAbsolute,relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { Prisma, PrismaClient } from '../../generated/prisma-v2/index.js'
import { calculateCanonicalHash,stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createProjectCreationOutputCommandV2,normalizeProjectCreationIntentV2 } from '../../src/v2/domain/project-creation-command.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'
import { createEditorialCutImpactV2 } from '../../src/v2/domain/editorial-cut-impact.ts'
import { createManualCommandImpact } from '../../src/v2/domain/command-impact.ts'
import { materializeManualEditPlan,materializeManualRestorePlan } from '../../src/v2/domain/manual-editing.ts'
import { createProjectOutputStateV3 } from '../../src/v2/domain/project-output-state.ts'
import { createProjectVersionV3,outputBoundVersionHashBodyV3 } from '../../src/v2/domain/project-version.ts'
import { calculateOutputCanonicalHash,serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { externalActorAuditData } from '../../src/v2/infrastructure/prisma/external-actor-audit.ts'
import { persistOutputVersionBundleInTransactionV3 } from '../../src/v2/infrastructure/prisma/output-version-bundle-persistence.ts'
import { setAssetRightsService } from '../../src/v2/application/set-asset-rights.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { createProjectSnapshot } from '../../src/v2/domain/project-snapshot.ts'
import { createOutputSpecRevisionBody } from '../../src/v2/domain/output-spec-revision.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { createQueuedPublicOperation,startPublicOperationAttempt,advancePublicOperationPhase,succeedPublicOperation } from '../../src/v2/domain/public-operation.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createMediaUpload } from '../../src/v2/domain/media-transfer.ts'
import { createMediaUploadAuditEntry } from '../../src/v2/domain/media-upload-audit-entry.ts'
import { buildCreationOutputVersionBundleV2,buildOperationalOutputVersionBundleV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { PrismaCreationOutputBundleRepositoryV2,PrismaOperationalOutputBundleRepositoryV3 } from '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
import { PrismaProjectMediaRepository } from '../../src/v2/infrastructure/prisma/project-media-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaMediaArtifactRepository } from '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
import { PrismaMediaTransferRepository } from '../../src/v2/infrastructure/prisma/media-transfer-repository.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { assetRightsRevision } from '../../src/v2/domain/asset-rights.ts'
import { readPersistedOutputConsumptionV3 } from '../../src/v2/infrastructure/prisma/output-state-consumption.ts'
import { runNextMediaIngestOperationService } from '../../src/v2/application/run-media-ingest-worker.ts'
import { createProjectService } from '../../src/v2/application/create-project.ts'
import { applyEditorialCutCommandService } from '../../src/v2/application/apply-editorial-cut-command.ts'
import { PrismaEditorialCommandRepository } from '../../src/v2/infrastructure/prisma/editorial-command-repository.ts'
import { createEditorialSourceBindingV1 } from '../../src/v2/domain/output-materialization.ts'
import { duplicateProjectService } from '../../src/v2/application/duplicate-project.ts'
import { PrismaProjectDuplicationRepository } from '../../src/v2/infrastructure/prisma/project-duplication-repository.ts'
import { createExternalAuditContext, materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { FfmpegIngestProcessor } from '../../src/v2/infrastructure/media/ffmpeg-ingest-processor.ts'
import { resolveFfprobeBinaryPath,resolveFfmpegBinary } from '../../src/v2/infrastructure/media/ffmpeg-binary.ts'
import { observeMediaFramesV3,videoMetadataFromObservedProbeV3 } from '../../src/v2/infrastructure/media/video-probe.ts'
import { NodeOwnedFfmpegExecutor,assertOwnedFfmpegAdmission,pendingOwnedFfmpegTerminations } from '../../src/v2/infrastructure/media/ffmpeg-owned-process.ts'
import { OwnedDeadlineIo,pendingOwnedIo } from '../../src/v2/infrastructure/media/ffmpeg-owned-io.ts'

// First operational path only, controlled RGB/audio source and transcription.
// Real FFmpeg/ffprobe, Prisma repositories, rights, same-TX publish+terminal,
// deferred flush/actual COMMIT/readback. No Director/critic/ASS/final approval,
// no public-upload E2E, rational FPS support or sixteen-writer cutover claim.
const enabled=process.env.APOLLO_RUN_W66_OPERATIONAL_BUNDLE_PG==='1',policy={canonicalPolicyVersion:'output-canonical-json/v1'}
const clone=value=>structuredClone(value)
function fixture(runId,at) {
 const scope={workspaceId:'w66op-'+runId+'-workspace',projectId:'w66op-'+runId+'-project'}
 const id=kind=>'w66op-'+runId+'-'+kind
 const audit=createApiAccessAuditContext({workspaceId:scope.workspaceId,clientId:id('client'),credentialId:id('credential'),environment:'sandbox',authenticationKind:'bearer'})
function snapshot(id,kind,document,createdAt=at) {
 return createProjectSnapshot({...scope,id,kind,contentSchemaVersion:document.schemaVersion,contentJson:stableSerialize(document),contentHash:calculateCanonicalHash(document),createdAt})
}
function root() {
 const versionId=id('version-root2'),callerIntent=normalizeProjectCreationIntentV2({schemaVersion:'project-creation-intent/v2',kind:'initialize-empty',name:'Explicit root',objective:'discovery',locale:'pt-BR',briefing:null,desiredAction:{}})
 const documents=[['brief',{schemaVersion:1,objective:callerIntent.objective,desiredAction:callerIntent.desiredAction,productionBrief:createProductionBrief({}),createdAt:at}],
  ['policies',{schemaVersion:1,workspaceId:scope.workspaceId,state:'unconfigured',brandKitMode:'inherit',guardrails:[],createdAt:at}],
  ['edit-plan',{schemaVersion:2,state:'uncompiled',id:id('edit-plan-root2'),projectVersionId:versionId,fps:30,durationFrames:0,sources:[],videoTracks:[],subtitleTracks:[],audioTracks:[],overlayTracks:[],effectTracks:[],createdAt:at}]]
 const snapshots=documents.map(([kind,doc])=>snapshot(id('snapshot-root-'+kind),kind,doc))
 return buildCreationOutputVersionBundleV2(createProjectCreationOutputCommandV2({...policy,...scope,id:id('creation-root2'),versionId,audit,createdAt:at,
  payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent,allocations:{stateId:id('state-root2'),snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:null},snapshots,forkDerivation:null,renderableCandidate:null}}))
}
function spec(createdAt) {
 const encoding=final=>({codec:'h264',encoder:'libx264',pixelFormat:'yuv420p',container:'mp4',faststart:true,width:final?640:320,height:final?360:180,fps:30,
  quality:{mode:'crf',value:final?18:23,preset:final?'medium':'veryfast'},audio:{codec:'aac',bitrateKbps:final?192:160,sampleRateHz:48000,channels:1}})
 return createOutputSpecRevisionBody({...policy,...scope,id:id('revision-output-alpha'),variantId:id('output-alpha'),revisionNumber:1,createdAt,
  output:{schemaVersion:1,id:id('output-alpha'),locale:'pt-BR',aspectRatio:'16:9',width:640,height:360,fps:30,safeArea:{top:.08,right:.06,bottom:.06,left:.06},deliveryProfileId:'profile-explicit'},
  profile:{schemaVersion:'materialized-delivery-profile/v1',id:'profile-explicit',version:1,rendererContractVersion:'ffmpeg-editorial-output/v1',final:encoding(true),proxy:encoding(false),
   proxyToFinal:{schemaVersion:'output-canvas-transform/v1',scaleX:2,scaleY:2},subtitles:{mode:'none',configuration:null,fontAssets:[]}},preset:null})
}
function variantInput(parent=root()) {
 const createdAt=new Date(Date.parse(at)+1).toISOString(),revision=spec(createdAt)
 const result=createOutputVariantCommand({command:{...scope,id:id('command-create-variant3'),baseVersionId:parent.version.id,baseHash:parent.version.baseHash,
  type:'create-output-variant',author:{type:'api-client',id:audit.clientId},idempotencyKey:'explicit-variant-request',createdAt},audit,base:parent.version,baseState:parent.state,
  historicalBaselineRequested:false,revision,expectedRevisionId:null,expectedSpecHash:null,durationFrames:0})
 const p=clone(JSON.parse(parent.command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson));p.id=id('edit-plan-variant3');p.projectVersionId=id('version-variant3');p.createdAt=createdAt
 return {allocation:{...scope,resultVersionId:id('version-variant3'),stateId:id('state-variant3'),parentVersionId:parent.version.id,sequence:2,createdBy:audit.clientId,createdAt},
  parent,origin:{kind:'create-output-variant',result},restoreTarget:null,editPlanSnapshot:snapshot(id('snapshot-variant3'),'edit-plan',p,createdAt),normalizations:[],materializationIds:{}}
}
function manualInput(parent,{target=null,suffix='select',action=target?'restore':'apply'}={}) {
 const createdAt=new Date(Date.parse(parent.version.createdAt)+1).toISOString(),versionId=id('version-'+suffix),commandId=id('command-'+suffix)
 const before=JSON.parse(parent.editPlanSnapshot.contentJson),source=target??parent,sourcePlan=JSON.parse(source.editPlanSnapshot.contentJson)
 const variantId=id('output-alpha'),targetId=action==='apply'?before.videoTracks[0].clips[0].id:target.version.id
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
 return {allocation:{...scope,resultVersionId:versionId,stateId:id('state-'+suffix),parentVersionId:parent.version.id,sequence:parent.version.sequence+1,
  createdBy:audit.clientId,createdAt},parent,origin,restoreTarget:target,editPlanSnapshot:snapshot(id('snapshot-'+suffix),'edit-plan',plan,createdAt),
  normalizations:[...norms.values()],materializationIds:Object.fromEntries(source.state.document.entries.map(e=>[e.variantId,id('materialization-'+suffix)]))}
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
 return {scope,id,audit,at,root,variantInput,manualInput,manualFingerprint}
}
// Publication boundary only: artifacts/rights written by earlier worker TXs
// are recorded separately, never described as rolled back by this owner.
async function publicationSnapshot(db,scope,operationId) {
 const models=['v2ProjectVersion','v2ProjectSnapshot','v2EditCommand','v2ProjectOutputState','v2ProjectOutputStateEntry',
  'v2OutputMaterialization','v2OutputMaterializationNormalization','v2OutputOperationalBundle','v2OutputNormalizationReceipt',
  'v2ProjectMediaAsset','v2MediaTranscript','v2CommandArtifactInvalidation','v2PublicEventOutbox']
 const counts={}
 for(const model of models)counts[model]=await db[model].count({where:model==='v2PublicEventOutbox'?{workspaceId:scope.workspaceId}:{projectId:scope.projectId}})
 return {counts,project:await db.v2Project.findUnique({where:{id:scope.projectId}}),
  operation:operationId?await db.v2PublicOperation.findUnique({where:{id:operationId}}):null}
}
function boundedDate(offset=0){return new Date(Date.now()+offset)}
// Isolated SQL algorithm vectors, not probe/renderer authority. Reference body
// is literal from the historical migration, instantiated only in this PG session.
async function assertRangeCoverageEquivalence(db) {
 const probe={timeBase:{numerator:1,denominator:10},originSeconds:{numerator:'0',denominator:'1'},
  frames:['0','10','20','30'].map(pts=>({pts})),frameEndPts:['10','20','30','40'],endPts:'40'}
 const fraction=(numerator,denominator='1')=>({numerator:String(numerator),denominator:String(denominator)})
 const {frameEndPts:omittedEnds,...missingEndsProbe}=probe
 const vectors=[
  {label:'complete',probe,start:fraction(0),end:fraction(4),status:'returned'},
  {label:'internal-gap',probe:{...probe,frames:[{pts:'0'},{pts:'20'}],frameEndPts:['10','30'],endPts:'30'},start:fraction(0),end:fraction(3),status:'returned'},
  {label:'prefix-max-overlap',probe:{...probe,frames:[{pts:'0'},{pts:'10'},{pts:'30'}],frameEndPts:['30','20','40']},start:fraction(0),end:fraction(4),status:'returned'},
  {label:'duplicate-slots',probe:{...probe,frames:[{pts:'0'},{pts:'10'},{pts:'10'},{pts:'30'}]},start:fraction(0),end:fraction(4),status:'returned'},
  {label:'rational-origin-touching',probe:{timeBase:{numerator:1,denominator:6},originSeconds:{numerator:'1',denominator:'3'},
   frames:[{pts:'2'},{pts:'4'},{pts:'6'}],frameEndPts:['4','6','8'],endPts:'8'},start:fraction(1,3),end:fraction(2,3),status:'returned'},
  {label:'duplicate-json-keys',probeJson:JSON.stringify(probe).replace('"numerator":1','"numerator":7,"numerator":1'),start:fraction(0),end:fraction(4),status:'returned'},
  {label:'empty-frames',probe:{...probe,frames:[],frameEndPts:[]},start:fraction(0),end:fraction(1),status:'error',sqlstate:'23514'},
  {label:'sql-null-probe',probe:null,start:fraction(0),end:fraction(1),status:'error',sqlstate:'23514'},
  {label:'json-null-frames',probe:{...probe,frames:null},start:fraction(0),end:fraction(1),status:'error',sqlstate:'22023'},
  {label:'json-null-ends',probe:{...probe,frameEndPts:null},start:fraction(0),end:fraction(1),status:'error',sqlstate:'23514'},
  {label:'missing-ends',probe:missingEndsProbe,start:fraction(0),end:fraction(1),status:'error',sqlstate:'23514'},
  {label:'invalid-later-pts',probe:{...probe,frames:[{pts:'0'},{pts:'not-numeric'}],frameEndPts:['10','20']},start:fraction(0),end:fraction(1),status:'error',sqlstate:'22P02'},
  {label:'invalid-pts-slot-outside-selection',probe:{...probe,frames:[{pts:'0'},{pts:'not-numeric'}],frameEndPts:['20','10'],endPts:'20'},start:fraction(1),end:fraction(2),status:'returned'},
  {label:'nonarray-ends',probe:{...probe,frameEndPts:{}},start:fraction(0),end:fraction(1),status:'error',sqlstate:'23514'},
  {label:'nonarray-frames',probe:{...probe,frames:{}},start:fraction(0),end:fraction(1),status:'error',sqlstate:'22023'},
  {label:'initial-outside',probe,start:fraction(-1),end:fraction(1),status:'error',sqlstate:'23514'},
  {label:'terminal-outside',probe,start:fraction(0),end:fraction(41,10),status:'error',sqlstate:'23514'},
 ]
 return db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10000ms'")
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout='8000ms'")
  await tx.$executeRawUnsafe("CREATE FUNCTION pg_temp.w66_range_coverage_reference_v3(p_probe jsonb,p_start jsonb,p_end jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$\nDECLARE f record;first_frame integer;last_frame integer;covered_end numeric;frame_end text;segments jsonb:='[]';gaps jsonb:='[]';\nBEGIN\n IF w66_pts_compare_v3(p_probe->>'endPts',p_probe,p_end)<0 OR w66_pts_compare_v3(p_probe#>>'{frames,0,pts}',p_probe,p_start)>0 THEN\n  RAISE EXCEPTION 'W66v3 range exceeds measured initial/terminal coverage' USING ERRCODE='23514'; END IF;\n FOR f IN SELECT fi.element,fi.ordinal FROM jsonb_array_elements(p_probe->'frames') WITH ORDINALITY AS fi(element,ordinal) LOOP\n  frame_end:=p_probe->'frameEndPts'->>(f.ordinal-1)::integer;\n  IF w66_pts_compare_v3(frame_end,p_probe,p_start)>0 AND w66_pts_compare_v3(f.element->>'pts',p_probe,p_end)<0 THEN\n   IF first_frame IS NULL THEN first_frame:=f.ordinal-1;END IF;\n   IF covered_end IS NOT NULL AND (f.element->>'pts')::numeric>covered_end THEN\n    gaps:=gaps||jsonb_build_array(jsonb_build_object('startPts',trunc(covered_end)::text,'endPts',f.element->>'pts'));END IF;\n   segments:=segments||jsonb_build_array(jsonb_build_object('frame',f.ordinal-1,'startPts',f.element->>'pts','endPts',frame_end));\n   last_frame:=f.ordinal-1;covered_end:=greatest(covered_end,frame_end::numeric);\n  END IF;\n END LOOP;\n IF first_frame IS NULL OR w66_pts_compare_v3(p_probe->'frames'->first_frame->>'pts',p_probe,p_start)>0\n OR w66_pts_compare_v3(trunc(covered_end)::text,p_probe,p_end)<0 THEN\n  RAISE EXCEPTION 'W66v3 range boundary lies in an observed gap' USING ERRCODE='23514'; END IF;\n RETURN jsonb_build_object('originSeconds',p_probe->'originSeconds','firstFrame',first_frame,'lastFrame',last_frame,\n  'endExclusivePts',trunc(covered_end)::text,'timeBase',p_probe->'timeBase','coverage',CASE WHEN jsonb_array_length(gaps)=0 THEN 'complete' ELSE 'contains-measured-gaps' END,\n  'segments',segments,'gaps',gaps);\nEND $$;")
  await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.w66_capture_range_v3(p_reference boolean,p_probe jsonb,p_start jsonb,p_end jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 IF p_reference THEN result:=pg_temp.w66_range_coverage_reference_v3(p_probe,p_start,p_end);
 ELSE result:=w66_range_coverage_v3(p_probe,p_start,p_end);END IF;
 RETURN jsonb_build_object('status','returned','document',result);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','error','sqlstate',SQLSTATE,'message',SQLERRM);
END $$;`)
  const facts=[]
  for(const vector of vectors) {
   const rows=await tx.$queryRawUnsafe('SELECT pg_temp.w66_capture_range_v3(true,$1::jsonb,$2::jsonb,$3::jsonb) AS reference,pg_temp.w66_capture_range_v3(false,$1::jsonb,$2::jsonb,$3::jsonb) AS candidate',
    vector.probeJson??(vector.probe===null?null:JSON.stringify(vector.probe)),JSON.stringify(vector.start),JSON.stringify(vector.end))
   assert.equal(rows.length,1);assert.deepEqual(rows[0].candidate,rows[0].reference,vector.label+' must retain full JSON/order/error')
   assert.equal(rows[0].candidate.status,vector.status,vector.label+' expected outcome')
   if(vector.sqlstate)assert.equal(rows[0].candidate.sqlstate,vector.sqlstate)
   if(vector.label==='internal-gap')assert.deepEqual(rows[0].candidate.document.gaps,[{startPts:'10',endPts:'20'}])
   if(vector.label==='prefix-max-overlap')assert.deepEqual(rows[0].candidate.document.gaps,[])
   if(vector.label==='duplicate-slots')assert.equal(rows[0].candidate.document.segments.length,4)
   if(vector.label==='rational-origin-touching')assert.deepEqual(rows[0].candidate.document.segments,[{frame:1,startPts:'4',endPts:'6'}])
   facts.push({label:vector.label,status:vector.status,...(vector.sqlstate?{sqlstate:vector.sqlstate}:{})})
  }
  assert.equal(facts.length,17)
  return {vectors:facts,fullJsonAndErrorEquivalence:true,authority:false,referenceScope:'pg_temp test-only',productRows:0}
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:3000,timeout:30000})
}

function failureFact(error,includeActual=true) {
 const message=typeof error?.message==='string'?error.message:''
 const fact={name:error?.name??null,code:error?.code??null,sqlstate:error?.meta?.code??null,
  messageSha256:createHash('sha256').update(message).digest('hex'),messageBytes:Buffer.byteLength(message)}
 // Assertion validation may wrap the rejected Prisma error. Retain only its
 // sanitized facts, with one level and no raw SQL, arguments or credentials.
 const actual=error?.actual
 if(includeActual&&error?.name==='AssertionError'&&actual!==error&&actual&&typeof actual==='object'&&
   (typeof actual.message==='string'||typeof actual.code==='string'))fact.actual=failureFact(actual,false)
 return fact
}


function resealStoredManualBundle(proposal,mutate,fingerprint) {
 const original=buildOperationalOutputVersionBundleV3(proposal),body=clone(original.origin.command)
 mutate(body);const {schemaVersion,commandHash,...input}=body,command=createEditCommand(input)
 const origin={...original.origin,command,requestFingerprint:fingerprint(command)},document=clone(original.state.document)
 document.provenance.hash=command.commandHash;document.producer.document.commandHash=command.commandHash
 document.producer.document.payloadHash=calculateOutputCanonicalHash(command.payload);document.producer.hash=calculateOutputCanonicalHash(document.producer.document)
 const state=createProjectOutputStateV3(document,{editPlanDocument:JSON.parse(original.editPlanSnapshot.contentJson),renderablePlanDocument:null})
 const version=createProjectVersionV3({state,parent:proposal.parent.version,snapshotRefs:original.version.snapshotRefs,createdBy:original.version.createdBy,commandId:command.id})
 return {...original,origin,state,version,outputBaseHashJson:serializeOutputCanonicalJson(outputBoundVersionHashBodyV3({state,previousBaseHash:proposal.parent.version.baseHash}))}
}
async function insertManualCommandForGuard(tx,bundle,audit) {
 const c=bundle.origin.command,{commandHash,...body}=c,a=externalActorAuditData(audit,bundle.version.workspaceId,c.author.id)
 await tx.v2EditCommand.create({data:{id:c.id,workspaceId:c.workspaceId,projectId:c.projectId,baseVersionId:c.baseVersionId,baseHash:c.baseHash,type:c.type,
  scopeJson:stableSerialize(c.scope),payloadJson:stableSerialize(c.payload),reason:c.reason??null,actorType:c.author.type,actorId:c.author.id,
  delegatedUserId:c.author.delegatedUserId??null,actorCredentialId:a.actorCredentialId,actorEnvironment:a.actorEnvironment,
  actorAuthenticationKind:a.actorAuthenticationKind,actorContextHash:a.actorContextHash,actorDelegatedIdentityId:a.delegatedIdentityId??null,
  actorWorkspaceRole:a.workspaceRole??null,idempotencyKey:c.idempotencyKey,requestFingerprint:bundle.origin.requestFingerprint,
  commandHash,commandJson:stableSerialize(body),outputPayloadJson:null,outputPayloadHash:null,createdAt:new Date(c.createdAt)}})
}

function editorialCommandDataForGuard(bundle,audit) {
 const c=bundle.origin.command,{commandHash,...body}=c,a=externalActorAuditData(audit,bundle.version.workspaceId,c.author.id)
 return {id:c.id,workspaceId:c.workspaceId,projectId:c.projectId,baseVersionId:c.baseVersionId,baseHash:c.baseHash,type:c.type,
  scopeJson:stableSerialize(c.scope),payloadJson:stableSerialize(c.payload),reason:c.reason??null,actorType:c.author.type,actorId:c.author.id,
  delegatedUserId:c.author.delegatedUserId??null,actorCredentialId:a.actorCredentialId,actorEnvironment:a.actorEnvironment,
  actorAuthenticationKind:a.actorAuthenticationKind,actorContextHash:a.actorContextHash,actorDelegatedIdentityId:a.delegatedIdentityId??null,
  actorWorkspaceRole:a.workspaceRole??null,idempotencyKey:c.idempotencyKey,requestFingerprint:bundle.origin.requestFingerprint,
  commandHash,commandJson:stableSerialize(body),outputPayloadJson:serializeOutputCanonicalJson(c.payload),outputPayloadHash:calculateOutputCanonicalHash(c.payload),createdAt:new Date(c.createdAt)}
}
async function insertEditorialCommandForGuard(tx,bundle,audit) {
 await tx.v2EditCommand.create({data:editorialCommandDataForGuard(bundle,audit)})
}

function resealEditorialBundleForGuard(bundle,mutate) {
 const forged=clone(bundle);mutate(forged)
 const {schemaVersion,commandHash,...body}=forged.origin.command
 forged.origin.command=createEditCommand(body)
 for(const e of forged.state.document.entries)if(e.consumption.status==='materialized')e.consumption.materialization.materializationHash=calculateOutputCanonicalHash(e.consumption.materialization.document)
 forged.state.document.provenance.hash=forged.origin.command.commandHash
 forged.state.document.producer.document.commandHash=forged.origin.command.commandHash
 forged.state.document.producer.document.payloadHash=calculateOutputCanonicalHash(forged.origin.command.payload)
 forged.state.document.producer.hash=calculateOutputCanonicalHash(forged.state.document.producer.document)
 forged.state.stateHash=calculateOutputCanonicalHash(forged.state.document)
 const sealBody=outputBoundVersionHashBodyV3({state:forged.state,previousBaseHash:forged.origin.command.baseHash})
 forged.outputBaseHashJson=serializeOutputCanonicalJson(sealBody);forged.version.outputStateHash=forged.state.stateHash;forged.version.baseHash=calculateOutputCanonicalHash(sealBody)
 return forged
}

async function seedControlledProxyMembership(tx,{scope,id,audit,base,derivative}) {
 const createdAt=new Date().toISOString(),operationId=id('metadata-only-proxy-operation')
 const queued=createQueuedPublicOperation({...scope,id:operationId,clientId:audit.clientId,type:'project-proxy-render',
  target:{type:'media-artifact',id:derivative.artifactId,manifestId:derivative.manifestId},createdAt})
 const running=startPublicOperationAttempt(queued,createdAt),persisting=advancePublicOperationPhase(running,'persisting',createdAt)
 const operation=succeedPublicOperation(persisting,createdAt),actor=externalActorAuditData(audit,scope.workspaceId,audit.clientId)
 const membership={schemaVersion:'controlled-proxy-membership/v1',...scope,baseVersionId:base.version.id,
  variantId:base.state.document.entries[0].variantId,outputArtifactId:derivative.artifactId,outputManifestId:derivative.manifestId,
  outputManifestHash:derivative.manifest.manifestHash,metadataOnly:true}
 const inputHash=calculateCanonicalHash(membership),normalization=base.state.document.entries[0].consumption.materialization.document.normalizations[0]
 await tx.v2PublicOperation.create({data:{...scope,id:operation.id,clientId:operation.clientId,...actor,type:operation.type,status:operation.status,
  phase:operation.phase,targetType:operation.target.type,targetId:operation.target.id,
  progressCompleted:operation.progress.completed,progressTotal:operation.progress.total,progressUnit:operation.progress.unit,
  cancelable:operation.cancelable,retryable:operation.retryable,attempt:operation.attempt,maxAttempts:operation.maxAttempts,
  idempotencyKey:id('metadata-only-proxy-key'),requestFingerprint:inputHash,resultJson:stableSerialize(operation.result),
  createdAt:new Date(operation.createdAt),updatedAt:new Date(operation.updatedAt),startedAt:new Date(operation.startedAt),completedAt:new Date(operation.completedAt)}})
 await tx.v2ProjectProxyRenderOperation.create({data:{...scope,operationId,projectVersionId:base.version.id,editPlanSnapshotId:base.editPlanSnapshot.id,
  sourceArtifactId:normalization.document.source.artifactId,sourceManifestId:normalization.document.source.manifestId,
  outputArtifactId:derivative.artifactId,outputManifestId:derivative.manifestId,inputHash,originalFileName:'controlled-membership-only.mp4',
  // No RenderInput/plan, renderer or approval is asserted by this SQL fixture.
  // The existing structural NULL-plan branch is allowed; the stable variant is
  // explicit actual membership. These rows exist only inside a rollback TX.
  colorPipelineBindingsJson:'[]',renderablePlanHash:null,renderablePlanId:null,
  renderableVariantId:membership.variantId,createdAt:new Date(createdAt)}})
 const stored=await tx.v2ProjectProxyRenderOperation.findUnique({where:{operationId}})
 const actualOperation=await tx.v2PublicOperation.findUnique({where:{id:operationId}})
 const artifact=await tx.v2MediaArtifact.findUnique({where:{id:derivative.artifactId}})
 const manifest=await tx.v2MediaArtifactManifest.findUnique({where:{id:derivative.manifestId}})
 assert.equal(actualOperation.status,'succeeded');assert.equal(actualOperation.resultJson,stableSerialize(operation.result))
 assert.equal(stored.projectVersionId,base.version.id);assert.equal(stored.renderableVariantId,membership.variantId)
 assert.equal(stored.outputArtifactId,artifact.id);assert.equal(stored.outputManifestId,manifest.id)
 assert.equal(manifest.artifactId,artifact.id);assert.equal(manifest.manifestHash,derivative.manifest.manifestHash)
 assert.equal(artifact.sha256,derivative.manifest.artifact.sha256);assert.equal(artifact.byteSize,BigInt(derivative.manifest.artifact.byteSize))
 return {operationId,...membership}
}

function rightsDraft(snapshot) {
 const keys=['owner','license','status','allowedUses','prohibitedUses','allowedMarkets','allowedLocales','allowedSyntheticOperations','expiresAt','sourceNote']
 const consentKeys=['status','allowedUses','allowedMarkets','allowedLocales','allowedSyntheticOperations','expiresAt','documentArtifactId']
 return {...Object.fromEntries(keys.filter(k=>snapshot[k]!==undefined).map(k=>[k,clone(snapshot[k])])),
  consent:Object.fromEntries(consentKeys.filter(k=>snapshot.consent[k]!==undefined).map(k=>[k,clone(snapshot.consent[k])]))}
}

const freshEditorialFocus=process.env.APOLLO_W66_FRESH_EDITORIAL_B2_PG==='1'
const operationalCaseName=freshEditorialFocus?'W66 fresh root2 → explicit variant3 → real ingest3 → fork2 → editorial3 validates derived authority and rollback':'W66 root2 → explicit variant3 → real owned ingest3 commits factual state and operation together'
test(operationalCaseName,
 {skip:!enabled,timeout:120000},async t=>{
  const started=performance.now(),workEnd=started+105000,hardEnd=started+110000,runId=randomUUID().replaceAll('-','')
  const environment={...process.env}
  const ownerRoot=environment.APOLLO_W66_OPERATIONAL_EVIDENCE_ROOT
  assert.ok(typeof ownerRoot==='string'&&isAbsolute(ownerRoot),'Explicit owner scratch/evidence root required')
  const rootDirectory=join(resolve(ownerRoot),'operational-source-'+runId)
  assert.ok(!relative(resolve(ownerRoot),rootDirectory).startsWith('..'))
  const ffmpeg=environment.FFMPEG_BIN,ffprobe=environment.FFPROBE_BIN
  for(const [path,pin] of [[ffmpeg,environment.APOLLO_FFMPEG_SHA256],[ffprobe,environment.APOLLO_FFPROBE_SHA256]]) {
   assert.ok(typeof path==='string'&&isAbsolute(path),'Owner must provide an exact binary path')
   assert.match(pin??'',/^[a-f0-9]{64}$/,'Binary SHA comes from the external owner, never the file being tested')
  }
  const url=new URL(environment.DATABASE_URL??'')
  assert.match(url.searchParams.get('application_name')??'',/^apollo-video-e2e-/)
  assert.equal(Number(url.searchParams.get('connection_limit')),3)
  for(const key of ['pool_timeout','connect_timeout'])assert.ok(Number(url.searchParams.get(key))>0&&Number(url.searchParams.get(key))<=10)
  const io=new OwnedDeadlineIo({runId,workEndMonotonicMs:workEnd,hardEndMonotonicMs:hardEnd,otherAdmission:assertOwnedFfmpegAdmission})
  const native=new NodeOwnedFfmpegExecutor(),executions=[]
  const executor={execute:async options=>{
   try {
    assert.ok(options.executable===ffmpeg||options.executable===ffprobe,'Every native executable must be one of the two owner-pinned files')
    ;(facts.nativeAdmissions??=[]).push({executable:options.executable,ownerOperation:options.owner?.operation??null})
    // The worker has its own longer product budget. This harness never
    // expands it, and admits each native action inside its original workEnd.
    assert.ok(performance.now()<workEnd,'Harness native work deadline exhausted')
    const bounded={...options,deadlineMonotonicMs:Math.min(options.deadlineMonotonicMs??workEnd,workEnd),
     timeoutMs:Math.min(options.timeoutMs??30000,30000)}
    const result=await native.execute(bounded);executions.push(result)
    const ordinal=executions.length
    await io.writeExclusive(join(rootDirectory,'execution-'+ordinal+'-stdout.bin'),result.stdout)
    await io.writeExclusive(join(rootDirectory,'execution-'+ordinal+'-stderr.bin'),result.stderr)
    return result
   } catch(error) {if(error?.observation)executions.push(error.observation);throw error}
  }}
  let db,primary=null,cleanupErrors=[],candidateOutcome='failed',facts={runId,evidenceScope:freshEditorialFocus?'controlled-fresh-editorial-derived-bundle':'controlled-source-first-operational-bundle',executions:[],
   validationPath:freshEditorialFocus?'root2/variant3/ingest3/fork2/editorial3':'root2/variant3/ingest3/select4/restore5/fork2/editorial3',
   historicalB1Reexecuted:!freshEditorialFocus}
  // Test-only observation of the SAME deferred flush and its effective10s
  // statement limit. No trigger, guard, timeout or transaction rule changes.
  const editorialFlushDiagnostics=[]
  const emitEditorialFlush=fact=>{
   if(editorialFlushDiagnostics.length>=16)return
   const atMonotonicMs=performance.now()
   const recorded={ordinal:editorialFlushDiagnostics.length+1,...fact,atMonotonicMs,testStartedMonotonicMs:started,elapsedMs:atMonotonicMs-started}
   editorialFlushDiagnostics.push(recorded)
   try{console.warn(JSON.stringify({kind:'w66-editorial-deferred-diagnostic',...recorded}))}catch{} // Preserve the primary failure if the sink fails.
  }
  facts.editorialFlushDiagnostics=editorialFlushDiagnostics
  try {
   await io.mkdir(rootDirectory,{recursive:false})
   const ffmpegFact=await io.hashFile(ffmpeg,256*1024*1024),ffprobeFact=await io.hashFile(ffprobe,256*1024*1024)
   assert.equal(ffmpegFact.sha256,environment.APOLLO_FFMPEG_SHA256);assert.equal(ffprobeFact.sha256,environment.APOLLO_FFPROBE_SHA256)
   const canonicalFfmpegPath=resolveFfmpegBinary(ffmpeg,environment)
   facts.ffmpegSelection={expectedPath:ffmpeg,canonicalPath:canonicalFfmpegPath,expectedSha256:environment.APOLLO_FFMPEG_SHA256,measuredFile:ffmpegFact}
   assert.equal(canonicalFfmpegPath,ffmpeg,'The configured FFmpeg adapter must select the owner-pinned executable')
   const canonicalProbePath=resolveFfprobeBinaryPath(undefined,undefined,environment,undefined,null)
   facts.probeSelection={expectedPath:ffprobe,canonicalPath:canonicalProbePath,expectedSha256:environment.APOLLO_FFPROBE_SHA256,measuredFile:ffprobeFact}
   assert.equal(canonicalProbePath,ffprobe,'The real resolver must select the owner-pinned FFprobe before any native generation')
   const sourcePath=join(rootDirectory,'controlled-master.mp4')
   // Cheap constructor preflight occurs before every native execution. Same
   // factories, no alternate permissive fixture.
   const world=fixture(runId,boundedDate().toISOString()),{scope,id,audit}=world
   const creationCandidate=world.root(),variantCandidate=buildOperationalOutputVersionBundleV3(world.variantInput(creationCandidate))
   assert.equal(creationCandidate.version.outputContractVersion,2);assert.equal(variantCandidate.version.outputContractVersion,3)
   await executor.execute({executable:ffmpeg,args:['-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc=size=320x180:rate=30:duration=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2',
    '-shortest','-vf','format=gbrp,zscale=matrixin=gbr:primariesin=709:transferin=linear:matrix=709:primaries=709:transfer=709:range=limited,format=yuv420p',
    '-c:v','libx264','-pix_fmt','yuv420p','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off',
    '-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709','-color_range','tv','-c:a','aac',sourcePath],
    owner:{runId,operation:'controlled-source-generation'},deadlineMonotonicMs:workEnd,timeoutMs:30000,maxOutputBytes:2*1024*1024})
   const sourceStat=await io.stat(sourcePath),source=await io.hashFile(sourcePath,Number(sourceStat.size))
   const observed=await observeMediaFramesV3(sourcePath,{mediaType:'video',operationId:runId,executor,io,deadlineMonotonicMs:workEnd,environment})
   facts.probeSelection.observed={executable:observed.executable,binarySha256:observed.probe.binarySha256,rawSha256:observed.probe.rawSha256}
   assert.equal(observed.executable,ffprobe,'Observed sequence must come from the pinned FFprobe executable')
   assert.equal(observed.probe.binarySha256,ffprobeFact.sha256,'Observed probe must authenticate the same measured binary bytes')
   assert.equal(observed.probe.binarySha256,environment.APOLLO_FFPROBE_SHA256)
   const measured=videoMetadataFromObservedProbeV3(observed.probe)
   assert.equal(measured.fps,30);assert.equal(measured.color.state,'ready');assert.equal(observed.probe.frameEndPts.at(-1),observed.probe.endPts)
   facts.source={sha256:source.sha256,byteSize:source.byteSize,probeRawSha256:observed.probe.rawSha256}
   db=new PrismaClient()
   facts.rangeCoverageEquivalence=await assertRangeCoverageEquivalence(db)
   await db.v2Workspace.create({data:{id:scope.workspaceId,slug:id('workspace'),name:'Controlled W66 operational PG',createdAt:new Date(world.at),updatedAt:new Date(world.at)}})
   await db.v2ApiClient.create({data:{id:audit.clientId,workspaceId:scope.workspaceId,name:'Controlled operational actor',allowedEnvironmentsJson:'["sandbox"]',scopeGrantsJson:'["projects:write","media:write"]',createdBy:audit.clientId,createdAt:new Date(world.at),updatedAt:new Date(world.at)}})
   const creation=world.root().command,creationRepo=new PrismaCreationOutputBundleRepositoryV2(db)
   const anchorBefore={publication:await publicationSnapshot(db,scope,null),
    creationCommands:await db.v2ProjectCreationCommand.count({where:scope}),idempotency:await db.v2IdempotencyRecord.count({where:{workspaceId:scope.workspaceId}})}
   const anchorTrace={fullDocumentForged:0,localGuardCalls:0,deferredFlushForwarded:0}
   const anchorClient=new Proxy(db,{get(target,key){
    if(key==='$transaction')return (action,options)=>target.$transaction(async tx=>{
     const delegate=new Proxy(tx,{get(transaction,property){
      if(property==='$executeRawUnsafe')return async (query,...values)=>{
       if(query.startsWith('INSERT INTO "project_creation_commands" (')) {
        const columns=query.slice(query.indexOf('(')+1,query.indexOf(')')).split(',').map(name=>name.replaceAll('"',''))
        const position=columns.indexOf('commandJson');assert.ok(position>=0)
        const full=JSON.parse(values[position]);assert.equal(full.author.id,creation.author.id)
        // A full-document attachment contradicts its actual actor columns;
        // the independently sealed body/payload/actor-context remain unchanged.
        full.author={...full.author,id:id('forged-author')};values[position]=JSON.stringify(full);anchorTrace.fullDocumentForged++
       }
       if(query==='SET CONSTRAINTS ALL IMMEDIATE') {
        // Reach the local3 guard before any deferred historical trigger. No
        // immutable UPDATE or fake read result can satisfy this negative.
        anchorTrace.localGuardCalls++
        await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_creation_anchor_v3($1)',creation.payload.allocations.stateId)
        anchorTrace.deferredFlushForwarded++
       }
       return transaction.$executeRawUnsafe(query,...values)
      }
      const value=Reflect.get(transaction,property);return typeof value==='function'?value.bind(transaction):value
     }})
     return action(delegate)
    },options)
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
   }})
   await assert.rejects(()=>new PrismaCreationOutputBundleRepositoryV2(anchorClient).persist({proposal:creation,
    idempotencyKey:id('anchor-negative-request'),idempotencyRecordId:randomUUID(),eventIds:[randomUUID(),randomUUID()],recompose:()=>creation}),
    error=>error.code==='P2010'&&error.meta?.code==='23514'&&String(error.meta?.message??error.message).includes('W66v3 Creation2 Command actor/row/body differs'))
   assert.deepEqual(anchorTrace,{fullDocumentForged:1,localGuardCalls:1,deferredFlushForwarded:0})
   assert.deepEqual({publication:await publicationSnapshot(db,scope,null),
    creationCommands:await db.v2ProjectCreationCommand.count({where:scope}),idempotency:await db.v2IdempotencyRecord.count({where:{workspaceId:scope.workspaceId}})},anchorBefore,
    'The local3 Command attachment guard rolls back actual bundle/head/events/idempotency writes')
   facts.creationAnchorNegative={...anchorTrace,sqlstate:'23514',guard:'W66v3 Creation2 Command actor/row/body differs',
    rollbackReadback:true,scope:'full-document author contradicts actual row; local guard reached before deferred flush'}
   const created=await creationRepo.persist({proposal:creation,idempotencyKey:id('creation-request'),idempotencyRecordId:randomUUID(),eventIds:[randomUUID(),randomUUID()],recompose:()=>creation})
   assert.equal(created.bundle.version.outputContractVersion,2)
   const beforeVariant=await publicationSnapshot(db,scope,null),beforeVariantExecutions=executions.length
   await assert.rejects(()=>new PrismaProjectMediaRepository(db).readProject(scope),
    e=>e.code==='PRECONDITION_REQUIRED'&&e.message==='Ingest requires an explicit operational output variant')
   assert.deepEqual(await publicationSnapshot(db,scope,null),beforeVariant)
   assert.equal(executions.length,beforeVariantExecutions,'Explicit variant admission performs no native action')
   const child=world.variantInput(created.bundle),operationalRepo=new PrismaOperationalOutputBundleRepositoryV3(db)
   const variant=await operationalRepo.persistChild({proposal:child,audit,versionEventId:randomUUID(),operationEventId:null,ingestFacts:null,
    recompose:({parent,restoreTarget,normalizations})=>({...child,parent,restoreTarget,normalizations})})
   const blocked=await readPersistedOutputConsumptionV3(db,{...scope,versionId:variant.bundle.version.id,variantId:id('output-alpha'),purpose:'render'})
   assert.equal(blocked.status,'blocked');assert.deepEqual(blocked.reasons,['empty-project'])
   emitEditorialFlush({phase:'root-explicit-variant-returned'})
   const uploadId=randomUUID(),operationId=id('ingest-operation'),sourceArtifactId=id('source-artifact'),sourceManifestId=id('source-manifest'),now=boundedDate().toISOString()
   const uploadIntent={projectId:scope.projectId,fileName:'controlled-master.mp4',rightsConfirmed:true,kind:'video',
    byteSize:String(source.byteSize),mimeType:'video/mp4',expectedSha256:source.sha256}
   // Exact begin-media-upload service authority; neither generated ID nor
   // clock enters this intent fingerprint. This is a controlled metadata seed,
   // not a signed session, network upload or API-authentication proof.
   const uploadFingerprint=calculateCanonicalHash({schemaVersion:'media-upload-begin/v2',actorContextHash:audit.contextHash,intent:uploadIntent})
   const upload=createMediaUpload({id:uploadId,workspaceId:scope.workspaceId,clientId:audit.clientId,...uploadIntent,
    status:'verified',actualSha256:source.sha256,actualByteSize:String(source.byteSize),verifiedAt:now,
    inspectionStatus:'usable',detectedMimeType:'video/mp4',detectedExtension:'mp4',
    probe:{codec:measured.codec,duration:measured.duration,width:measured.width,height:measured.height},inspectedAt:now,
    expiresAt:boundedDate(3600000).toISOString(),createdAt:now})
   const beginAudit=createMediaUploadAuditEntry({id:randomUUID(),workspaceId:scope.workspaceId,uploadId,action:'begin',
    audit,requestFingerprint:uploadFingerprint,occurredAt:now})
   const beginAuditRow={id:beginAudit.id,workspaceId:beginAudit.workspaceId,uploadId:beginAudit.uploadId,action:beginAudit.action,
    partNumber:null,actorClientId:beginAudit.audit.clientId,actorCredentialId:beginAudit.audit.credentialId,
    actorEnvironment:beginAudit.audit.environment,actorAuthenticationKind:beginAudit.audit.authenticationKind,
    actorContextHash:beginAudit.audit.contextHash,delegatedUserId:beginAudit.audit.delegatedUserId??null,
    delegatedIdentityId:beginAudit.audit.delegatedIdentityId??null,workspaceRole:beginAudit.audit.workspaceRole??null,
    requestFingerprint:beginAudit.requestFingerprint,occurredAt:new Date(beginAudit.occurredAt)}
   await db.$transaction(async tx=>{
    await tx.v2MediaUpload.create({data:{id:upload.id,workspaceId:upload.workspaceId,clientId:upload.clientId,projectId:upload.projectId,
     fileName:upload.fileName,rightsConfirmed:upload.rightsConfirmed,kind:upload.kind,byteSize:BigInt(upload.byteSize),mimeType:upload.mimeType,
     expectedSha256:upload.expectedSha256,status:upload.status,idempotencyKey:id('upload-request'),requestFingerprint:uploadFingerprint,
     actualSha256:upload.actualSha256,actualByteSize:BigInt(upload.actualByteSize),verifiedAt:new Date(upload.verifiedAt),
     inspectionStatus:upload.inspectionStatus,detectedMimeType:upload.detectedMimeType,detectedExtension:upload.detectedExtension,
     probeJson:stableSerialize(upload.probe),inspectedAt:new Date(upload.inspectedAt),expiresAt:new Date(upload.expiresAt),
     createdAt:new Date(upload.createdAt),updatedAt:new Date(upload.createdAt)}})
    await tx.v2MediaUploadAuditEntry.create({data:beginAuditRow})
   })
   const readUpload=await new PrismaMediaTransferRepository(db).findUpload({workspaceId:scope.workspaceId,clientId:audit.clientId,uploadId})
   assert.deepEqual(readUpload,upload,'The real reader must hydrate the constructor-valid upload and measured probe before enqueue')
   const readBeginAudit=await db.v2MediaUploadAuditEntry.findUnique({where:{id:beginAudit.id}})
   assert.deepEqual(readBeginAudit,beginAuditRow,'Every persisted begin audit field must equal its real constructor authority')
   const storedUpload=await db.v2MediaUpload.findUnique({where:{id:uploadId}})
   assert.equal(storedUpload.requestFingerprint,uploadFingerprint);assert.equal(storedUpload.probeJson,stableSerialize(upload.probe))
   facts.uploadSeed={scope:'controlled metadata only; bytes/probe measured independently',uploadId,
    requestFingerprint:uploadFingerprint,beginAuditId:beginAudit.id,actorContextHash:beginAudit.audit.contextHash,
    beginAuditReadback:true,uploadReaderReadback:true,sourceSha256:source.sha256,sourceByteSize:source.byteSize,probeRawSha256:observed.probe.rawSha256}
   const operations=new PrismaPublicOperationRepository(db),context={kind:'media-ingest',uploadId,projectId:scope.projectId,originalFileName:'controlled-master.mp4',sourceArtifactId,sourceManifestId}
   await operations.createOrReplay({operation:createQueuedPublicOperation({id:operationId,...scope,clientId:audit.clientId,type:'media-ingest',target:{type:'media-artifact',id:sourceArtifactId,manifestId:sourceManifestId},createdAt:now}),
    authenticationAudit:audit,context,idempotencyKey:id('ingest-request'),requestFingerprint:calculateCanonicalHash({uploadId,actorContextHash:audit.contextHash})})
   const projectMedia=new PrismaProjectMediaRepository(db),processor=new FfmpegIngestProcessor({workRoot:join(rootDirectory,'work'),ffmpegPath:ffmpeg,executor,environment})
   let preparation=null,transcriptionCalls=0
   // Diagnostic only: each real port receives the same arguments/this and
   // returns its original value or throws the identical error object.
   facts.portDiagnostics=[];facts.portDiagnosticsLimit=64;facts.portDiagnosticsOverflow=false
   function diagnosedPort(port,target) {
    return new Proxy(target,{get(object,key){
     const value=Reflect.get(object,key);if(typeof value!=='function')return value
     return function(...args) {
      const method=typeof key==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)?key:'other'
      const startedAt=performance.now(),fact={port,method,status:'invoked',lastObservedPhase:facts.lastObservedOperationPhase??null}
      facts.lastPortInvoked={port,method}
      if(facts.portDiagnostics.length<64)facts.portDiagnostics.push(fact);else facts.portDiagnosticsOverflow=true
      const settled=result=>{
       fact.status='returned';fact.elapsedMs=performance.now()-startedAt
       const phase=result?.operation?.phase
       if(typeof phase==='string'&&/^[a-z][a-z-]{0,63}$/.test(phase)) {
        fact.observedReturnedPhase=phase;facts.lastObservedOperationPhase=phase
       }
       return result
      }
      const failed=error=>{
       fact.status='threw';fact.elapsedMs=performance.now()-startedAt;fact.error=failureFact(error)
       if(error?.cause!==undefined)fact.cause=failureFact(error.cause)
       throw error
      }
      try {const result=Reflect.apply(value,object,args);return result&&typeof result.then==='function'?result.then(settled,failed):settled(result)}
      catch(error){return failed(error)}
     }
    }})
   }
   const workerDependencies={operations,uploads:new PrismaMediaTransferRepository(db),artifacts:new PrismaMediaArtifactRepository(db),
    projectMedia:{readProject:input=>projectMedia.readProject(input),readIngestRequestFingerprint:input=>projectMedia.readIngestRequestFingerprint(input),
     persistCompletedIngest:async input=>{
      preparation=input
      if(!freshEditorialFocus) {
      const before=await publicationSnapshot(db,scope,operationId)
      const existingArtifactCount=await db.v2MediaArtifact.count({where:{workspaceId:scope.workspaceId}})
      for(const fault of ['lease-owner','target']) {
      let injected=0
      const failingClient=new Proxy(db,{get(target,key){
       if(key==='$transaction')return (action,options)=>target.$transaction(async transaction=>{
        const outbox=new Proxy(transaction.v2PublicEventOutbox,{get(model,method){
         if(method==='createMany')return async args=>{
          const result=await model.createMany(args)
          if(args.data.some(event=>event.id===input.versionEventId)) {
           injected++
           // Controlled fault in this real TX after bundle/CAS/event writes.
           // It must roll back; no previous artifact/rights TX is included.
           const derivative=input.ingestFacts.normalization.document.derivative
           if(fault==='lease-owner')await transaction.v2PublicOperation.update({where:{id:operationId},data:{leaseOwner:id('replacement-lease-owner')}})
           else {
            // The immutable-intent trigger rejects this real UPDATE before
            // the final fence. This case proves that SQL guard, not the fence.
            await transaction.$executeRawUnsafe('UPDATE public_operations SET "targetId"=$1 WHERE id=$2 AND "projectId"=$3 AND "workspaceId"=$4',
             derivative.artifactId,operationId,scope.projectId,scope.workspaceId)
           }
          }
          return result
         }
         const value=Reflect.get(model,method);return typeof value==='function'?value.bind(model):value
        }})
        const delegated=new Proxy(transaction,{get(tx,property){if(property==='v2PublicEventOutbox')return outbox;
         const value=Reflect.get(tx,property);return typeof value==='function'?value.bind(tx):value}})
        return action(delegated)
       },options)
       const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
      }})
      await assert.rejects(()=>new PrismaOperationalOutputBundleRepositoryV3(failingClient).persistChild(input),
       e=>{
        ;(facts.publicationRejections??=[]).push({fault,error:failureFact(e)})
        return fault==='lease-owner'?e.code==='VERSION_CONFLICT'&&e.message==='Operational ingest fence lost':
         e.code==='P2010'&&e.meta?.code==='23514'&&String(e.meta?.message??e.message).includes('W66 immutable ingest intent')
       })
      assert.equal(injected,1,fault+' fault must be reached after real outbox write')
      assert.deepEqual(await publicationSnapshot(db,scope,operationId),before,'Publish TX leaves no new bundle/head/event/operation effects')
      assert.equal(await db.v2MediaArtifact.count({where:{workspaceId:scope.workspaceId}}),existingArtifactCount,
       'Earlier artifact/rights TXs are preserved, not claimed rolled back')
      if(fault==='lease-owner')facts.leaseRollback={fault:'same-tx-owner-revocation-after-version-event',publishEffects:0,priorArtifactsPreserved:true}
      else facts.targetRollback={fault:'same-tx-target-update-to-real-derivative-after-version-event',authority:'w66_output_dependency_guard immutable ingest intent',
       sqlstate:'23514',fenceProof:false,publishEffects:0,priorArtifactsPreserved:true}
      }
      }
      await projectMedia.persistCompletedIngest(input)
     },persistCatalogedInput:input=>projectMedia.persistCatalogedInput(input),markIngestFailed:input=>projectMedia.markIngestFailed(input)},
    storage:{quarantineSource:async()=>({path:sourcePath,...source}),promoteMaster:async()=>({path:sourcePath,key:'controlled/'+runId+'/master.mp4',...source}),
     promoteDerived:async input=>{const bytes=await io.readBounded(input.sourcePath,64*1024*1024),path=join(rootDirectory,'persisted-derivative.mp4');await io.writeExclusive(path,bytes);
      const digest=await io.hashFile(path,bytes.byteLength);assert.equal(digest.sha256,input.sha256);return {path,key:'controlled/'+runId+'/derivative.mp4',...digest}}},
    processor:{normalize:input=>processor.normalize({...input,owner:{...input.owner,
       workEndMonotonicMs:Math.min(input.owner.workEndMonotonicMs,workEnd),hardEndMonotonicMs:Math.min(input.owner.hardEndMonotonicMs,hardEnd)}}),
     observeOriginalAudio:input=>processor.observeOriginalAudio({...input,owner:{...input.owner,
       workEndMonotonicMs:Math.min(input.owner.workEndMonotonicMs,workEnd),hardEndMonotonicMs:Math.min(input.owner.hardEndMonotonicMs,hardEnd)}}),
     cleanup:operationId=>processor.cleanup(operationId)},prober:{probe:async()=>measured},inspector:{inspect:async()=>{throw new Error('Verified usable upload must not be reclassified by a fake inspector')}},
    providers:{resolveTranscription:()=>({create:()=>({transcribe:async()=>{transcriptionCalls++;return createMediaTranscript({language:'pt-BR',text:'Fonte controlada.',words:[{word:'Fonte',start:0,end:1},{word:'controlada.',start:1,end:1.8}],
      segments:[{id:0,start:0,end:1,text:'Fonte'},{id:1,start:1,end:1.8,text:'controlada.'}],provider:'controlled',model:'owned-pg-fixture'})}})})},rights:new PrismaAssetRightsRepository(db)}
   for(const port of ['operations','uploads','artifacts','projectMedia','storage','processor','prober','inspector','rights'])
    workerDependencies[port]=diagnosedPort(port,workerDependencies[port])
   const worker=runNextMediaIngestOperationService(workerDependencies)
   const outcome=await worker(id('lease-owner'))
   if(outcome?.status!=='succeeded') {
    console.log(JSON.stringify({kind:'w66-operational-port-diagnostics',limit:64,overflow:facts.portDiagnosticsOverflow,
     lastPortInvoked:facts.lastPortInvoked,lastObservedOperationPhase:facts.lastObservedOperationPhase??null,ports:facts.portDiagnostics}))
    const actual=await operations.findById(scope.workspaceId,operationId)
    console.log(JSON.stringify({kind:'w66-operational-worker-failure',outcome,status:actual?.operation.status,phase:actual?.operation.phase,
      error:actual?.operation.error?failureFact({code:actual.operation.error.code,message:actual.operation.error.message}):null}))
   }
   assert.equal(outcome?.status,'succeeded');assert.equal(transcriptionCalls,1);assert.ok(preparation)
   const persisted=await operationalRepo.read({...scope,versionId:preparation.proposal.allocation.resultVersionId})
   assert.equal(persisted.version.outputContractVersion,3);assert.equal(persisted.version.sequence,3)
   const sourceCuePlan=JSON.parse(persisted.editPlanSnapshot.contentJson),sourceCueTrack=sourceCuePlan.subtitleTracks[0]
   assert.ok(sourceCueTrack?.cues.length>0,'The real ingest compiler persists planned transcript cues before the fork')
   assert.equal(sourceCueTrack.schemaVersion,'source-transcript-cue-track/v1')
   assert.equal(sourceCueTrack.authority,'aligned-source-transcript-only')
   assert.equal(sourceCueTrack.emission,'suppressed-missing-visual-clock-authority')
   assert.equal(sourceCueTrack.sourceTranscriptId,preparation.ingestFacts.transcript.id)
   assert.equal(sourceCueTrack.sourceTranscriptHash,preparation.ingestFacts.transcript.document.transcriptHash)
   assert.equal(sourceCuePlan.sourceTranscriptCueProjection.status,'available')
   assert.equal(sourceCuePlan.sourceTranscriptCueProjection.cueCount,sourceCueTrack.cues.length)
   assert.equal(sourceCuePlan.sourceTranscriptCueProjection.emission,'suppressed-missing-visual-clock-authority')
   assert.equal(persisted.state.document.entries[0].spec.profile.subtitles.mode,'none')
   for(const cue of sourceCueTrack.cues) {
    const words=cue.sourceWordIndices.map(index=>sourceCuePlan.retimedTranscript.words[index])
    assert.equal(cue.text,words.map(word=>word.text).join(' '))
    assert.equal(cue.startFrame,words[0].timelineStartFrame);assert.equal(cue.endFrame,Math.max(...words.map(word=>word.timelineEndFrame)))
    assert.ok(cue.startFrame>=0&&cue.endFrame<=sourceCuePlan.durationFrames)
    assert.equal(cue.clipId,sourceCuePlan.videoTracks[0].clips[0].id)
   }
   assert.equal(persisted.state.document.entries[0].consumption.materialization.document.emission.subtitles,'suppressed-missing-visual-clock-authority')
   const op=await operations.findById(scope.workspaceId,operationId)
   assert.equal(op.operation.status,'succeeded');assert.equal(op.operation.phase,'completed');assert.deepEqual(op.operation.progress,{completed:6,total:6,unit:'stage'})
   assert.deepEqual(op.operation.result,{resource:{type:'media-artifact',id:sourceArtifactId,manifestId:sourceManifestId}})
   assert.deepEqual(op.operation.result.resource,op.operation.target,'Hydrated success must reference the entire exact target')
   const terminalRow=await db.v2PublicOperation.findUnique({where:{id:operationId}})
   assert.ok(terminalRow);assert.equal(terminalRow.resultJson,stableSerialize(op.operation.result))
   assert.equal(terminalRow.targetType,op.operation.target.type);assert.equal(terminalRow.targetId,op.operation.target.id)
   const terminalDetail=await db.v2MediaIngestOperation.findUnique({where:{operationId}})
   assert.ok(terminalDetail);assert.equal(terminalDetail.sourceArtifactId,op.operation.target.id)
   assert.equal(terminalDetail.sourceManifestId,op.operation.target.manifestId)
   facts.operationResult={resource:op.operation.result.resource,resultReadback:true,targetReadback:true,detailManifestReadback:true}
   emitEditorialFlush({phase:'ingest-returned'})
   const head=await db.v2Project.findUnique({where:{id:scope.projectId}});assert.equal(head.currentVersionId,persisted.version.id)
   const replayAuditContext=createExternalAuditContext({workspaceId:audit.workspaceId,clientId:audit.clientId,
    credentialId:audit.credentialId,environment:audit.environment})
   const replayActor=Object.freeze({...replayAuditContext,auditContext:replayAuditContext,scopes:new Set(['projects:write']),
    authenticationKind:audit.authenticationKind,clientKillSwitchEngaged:false,workspaceKillSwitchEngaged:false,
    clientAccessStatus:'active',workspaceAccessStatus:'active'})
   // External actor context contains actor.type/id. The persisted access audit
   // is a different envelope; reconstruct it and require exact original binding.
   assert.deepEqual(materializeActorAuditContext(replayActor),audit)
   if(!freshEditorialFocus) {
   const creationHttpReplayBefore=await publicationSnapshot(db,scope,operationId),rootBefore=await creationRepo.read({...scope,versionId:created.bundle.version.id})
   const replayCountsBefore={creation:await db.v2ProjectCreationCommand.count({where:scope}),
    idempotency:await db.v2IdempotencyRecord.count({where:{workspaceId:scope.workspaceId}})}
   let replayAllocation=0
   assert.deepEqual(rootBefore.command.audit,audit)
   assert.equal(rootBefore.command.requestFingerprint,creation.requestFingerprint)
   const replayCreation=await createProjectService({repository:creationRepo,clock:()=>boundedDate(),
    createId:kind=>id('http-replay-'+kind+'-'+(++replayAllocation)),createEventId:randomUUID})({workspaceId:scope.workspaceId,
     name:'Explicit root',objective:'discovery',locale:'pt-BR',actor:replayActor,idempotencyKey:id('creation-request')})
   assert.equal(replayCreation.replayed,true);assert.equal(replayCreation.creationVersion.id,created.bundle.version.id)
   assert.equal(replayCreation.bundle.command.requestFingerprint,creation.requestFingerprint)
   assert.equal(replayCreation.projectAtCreation.currentVersionId,undefined)
   assert.equal(replayCreation.projectAtCreation.format,undefined)
   assert.equal(serializeOutputCanonicalJson(replayCreation.bundle),serializeOutputCanonicalJson(rootBefore))
   assert.deepEqual(await publicationSnapshot(db,scope,operationId),creationHttpReplayBefore,'HTTP root replay after real ingest publishes zero effects')
   assert.deepEqual({creation:await db.v2ProjectCreationCommand.count({where:scope}),
    idempotency:await db.v2IdempotencyRecord.count({where:{workspaceId:scope.workspaceId}})},replayCountsBefore)
   assert.equal(await creationRepo.read({...scope,workspaceId:id('foreign-workspace'),versionId:created.bundle.version.id}),null)
   await assert.rejects(()=>db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('UPDATE project_creation_commands SET "commandJson"=$1 WHERE id=$2',
     serializeOutputCanonicalJson({...creation,createdAt:new Date(Date.parse(creation.createdAt)+1).toISOString()}),creation.id)
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
   }),e=>e.code==='P2010'&&e.meta?.code==='23514')
   assert.deepEqual(await publicationSnapshot(db,scope,operationId),creationHttpReplayBefore,'Adulterated root Command is rejected atomically')
   assert.equal(serializeOutputCanonicalJson(await creationRepo.read({...scope,versionId:created.bundle.version.id})),serializeOutputCanonicalJson(rootBefore))
   facts.creationHttpReplay={afterRealIngest:true,originalRootIdsAndBytes:true,publishEffects:0,currentHeadClaim:false,
    foreignScopeRejected:true,rootTamperRejected:true}
   }
   const receipt=await db.v2OutputNormalizationReceipt.findUnique({where:{id:preparation.ingestFacts.normalization.document.id}})
   assert.equal(receipt.receiptHash,preparation.ingestFacts.normalization.receiptHash)
   assert.equal(JSON.parse(receipt.receiptJson).execution.binarySha256,environment.APOLLO_FFMPEG_SHA256)
   for(const purpose of ['render','critic','final']) {
    const consumption=await readPersistedOutputConsumptionV3(db,{...scope,versionId:persisted.version.id,variantId:id('output-alpha'),purpose})
    assert.equal(consumption.status,'materialized');assert.equal(consumption.entry.consumption.materialization.document.emission.subtitles,'suppressed-missing-visual-clock-authority')
   }
   const event=await db.v2PublicEventOutbox.findUnique({where:{id:preparation.versionEventId}})
   assert.equal(event.version,'1.0.0');assert.equal(event.resourceId,persisted.version.id);assert.equal(event.actorClientId,audit.clientId)
   if(!freshEditorialFocus) {
   const baseline={versions:await db.v2ProjectVersion.count({where:{projectId:scope.projectId}}),states:await db.v2ProjectOutputState.count({where:{projectId:scope.projectId}}),
    materials:await db.v2OutputMaterialization.count({where:{projectId:scope.projectId}}),events:await db.v2PublicEventOutbox.count({where:{workspaceId:scope.workspaceId}})}
   // Replay reads the same committed identities; it does not run any provider or
   // publish a new materialization/operation/event.
   const replay=await operationalRepo.persistChild(preparation)
   assert.equal(replay.replayed,true);assert.equal(replay.bundle.version.baseHash,persisted.version.baseHash)
   assert.deepEqual({versions:await db.v2ProjectVersion.count({where:{projectId:scope.projectId}}),states:await db.v2ProjectOutputState.count({where:{projectId:scope.projectId}}),
    materials:await db.v2OutputMaterialization.count({where:{projectId:scope.projectId}}),events:await db.v2PublicEventOutbox.count({where:{workspaceId:scope.workspaceId}})},baseline)

   }
   const normalizationRowsBefore=await db.v2OutputNormalizationReceipt.count({where:scope})
   const ingestMaterial=persisted.state.document.entries[0].consumption.materialization.document
   let forkSource=persisted
   // Both paths read genuine current rights after the actual ingest.
   const rightsRepo=new PrismaAssetRightsRepository(db),currentRights=await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)
   assert.ok(currentRights?.snapshot);const originalRightsDraft=rightsDraft(currentRights.snapshot)
   const setRights=setAssetRightsService({repository:rightsRepo,clock:()=>boundedDate(),createId:()=>randomUUID()})
   let forkSourceRights=currentRights,forkSourceRightsArtifact=await db.v2MediaArtifact.findUnique({where:{id:sourceArtifactId}})
   assert.equal(forkSourceRightsArtifact.currentRightsSnapshotId,currentRights.snapshot.id)
   assert.ok(Number.isSafeInteger(forkSourceRightsArtifact.rightsRevision)&&forkSourceRightsArtifact.rightsRevision>0,'Current rights pointer revision is a positive integer counter')
   assert.equal(currentRights.revision,assetRightsRevision(sourceArtifactId,forkSourceRightsArtifact.rightsRevision),'Rights revision hash binds the artifact id and the integer pointer revision')
   if(!freshEditorialFocus) {
   // No provider/normalizer/clock re-observation occurs for manual children.
   const nativeCountBeforeManual=executions.length
   const sourceBeforeManual=stableSerialize(await operationalRepo.read({...scope,versionId:persisted.version.id}))
   const selectProposal=world.manualInput(persisted,{suffix:'select-persisted'}),manualWrites=new Map()
   const writeManual=proposal=>{
    if(!manualWrites.has(proposal))manualWrites.set(proposal,{proposal,audit,versionEventId:randomUUID(),operationEventId:null,ingestFacts:null,
     recompose:({parent,restoreTarget,normalizations})=>({...proposal,parent,restoreTarget,normalizations})})
    return manualWrites.get(proposal)
   }
   const approvalRowsBefore={reviews:await db.v2ProxyReview.count({where:scope}),runs:await db.v2DirectorRun.count({where:scope})}
   for(const [label,mutate,guard]of [
    ['revision',c=>{c.payload.expectedRevision++},'W66v3 manual revision/variant/scope differs'],
    ['impact',c=>{c.payload.impact.affectedRanges[0].endFrame--;const {impactHash,...body}=c.payload.impact;c.payload.impact.impactHash=calculateCanonicalHash(body)},'W66v3 manual impact differs from real effect']]) {
    const proposal=world.manualInput(persisted,{suffix:'sql-negative-'+label}),forged=resealStoredManualBundle(proposal,mutate,world.manualFingerprint)
    const before=await publicationSnapshot(db,scope,operationId)
    let localCalls=0
    await assert.rejects(()=>db.$transaction(async tx=>{
     await insertManualCommandForGuard(tx,forged,audit)
     await persistOutputVersionBundleInTransactionV3(tx,forged)
     localCalls++;await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_operational_state_v3($1)',forged.state.document.id)
     await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    }),e=>{
     ;(facts.manualRejections??=[]).push({label,error:failureFact(e),proof:'explicit local SQL guard; no disabled trigger or fake read'})
     return e.code==='P2010'&&e.meta?.code==='23514'&&String(e.meta?.message??e.message).includes(guard)
    })
    assert.equal(localCalls,1);assert.deepEqual(await publicationSnapshot(db,scope,operationId),before)
   }
   // Rights are re-evaluated from the current actual row, never transferred by
   // receipt/lineage. Audited fixture-only revocation/restoration is explicit.
   await setRights({...scope,artifactId:sourceArtifactId,baseRevision:currentRights.revision,
    draft:{...originalRightsDraft,status:'revoked'},actor:{type:'system',id:'controlled-fixture'}})
   assert.equal((await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)).snapshot.status,'revoked')
   const rightsBaseline=await publicationSnapshot(db,scope,operationId)
   await assert.rejects(()=>operationalRepo.persistChild(writeManual(selectProposal)),e=>e.code==='ASSET_RIGHTS_BLOCKED'&&e.message==='Output source current rights/consent deny use')
   assert.deepEqual(await publicationSnapshot(db,scope,operationId),rightsBaseline)
   const revokedCurrent=await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)
   await setRights({...scope,artifactId:sourceArtifactId,baseRevision:revokedCurrent.revision,draft:originalRightsDraft,actor:{type:'system',id:'controlled-fixture'}})
   const restoredRights=await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)
   assert.equal(restoredRights.snapshot.status,originalRightsDraft.status)
   assert.equal(restoredRights.snapshot.id,currentRights.snapshot.id,'Audited restoration reuses the immutable original snapshot')
   assert.equal(restoredRights.snapshot.sequence,currentRights.snapshot.sequence,'Snapshot birth sequence remains unchanged')
   const restoredRightsArtifact=await db.v2MediaArtifact.findUnique({where:{id:sourceArtifactId}})
   assert.equal(restoredRightsArtifact.currentRightsSnapshotId,restoredRights.snapshot.id)
   assert.ok(restoredRightsArtifact.rightsRevision>restoredRights.snapshot.sequence,'Current pointer revision is distinct from snapshot birth sequence')
   const restoredRightsChange=await db.v2AssetRightsChange.findUnique({where:{artifactId_sequence:{artifactId:sourceArtifactId,sequence:restoredRightsArtifact.rightsRevision}}})
   assert.equal(restoredRightsChange.snapshotId,restoredRights.snapshot.id)
   assert.equal(restoredRightsChange.resultRevision,restoredRights.revision)
   const selectedResult=await operationalRepo.persistChild(writeManual(selectProposal)),selected=selectedResult.bundle
   assert.equal(selected.version.sequence,4);assert.equal(selected.state.document.transition,'inherit')
   const selectRead=await operationalRepo.read({...scope,versionId:selected.version.id})
   assert.equal(selectRead.version.baseHash,selected.version.baseHash)
   const afterSelect=await publicationSnapshot(db,scope,operationId)
   const stale=world.manualInput(persisted,{suffix:'stale-select'})
   await assert.rejects(()=>operationalRepo.persistChild(writeManual(stale)),e=>e.code==='VERSION_CONFLICT'&&e.message==='Operational head changed')
   assert.deepEqual(await publicationSnapshot(db,scope,operationId),afterSelect)
   const restoreProposal=world.manualInput(selected,{target:persisted,suffix:'restore-persisted'})
   const badRestore=clone(restoreProposal);badRestore.origin.target.stateHash='1'.repeat(64)
   await assert.rejects(()=>operationalRepo.persistChild(writeManual(badRestore)),e=>e.code==='INVALID_COMMAND'&&e.message==='Restore target seal/scope differs')
   assert.deepEqual(await publicationSnapshot(db,scope,operationId),afterSelect)

   // A scoped output can appear after caller seals and before publication.
   // The full DB guard must discover it, even when every supplied seal is valid.
   // This controlled terminal/detail seed exists only in the rollback TX;
   // it is not a renderer, RenderInput, approval or admissibility proof.
   const omittedProposal=world.manualInput(selected,{target:persisted,suffix:'restore-omitted-output'})
   const omissionBefore={publication:await publicationSnapshot(db,scope,operationId),
    operations:await db.v2PublicOperation.count({where:scope}),details:await db.v2ProjectProxyRenderOperation.count({where:scope})}
   const omissionTrace={terminalRows:0,detailRows:0,localCalls:0,flushForwarded:0}
   await assert.rejects(()=>db.$transaction(async tx=>{
    const seeded=await seedControlledProxyMembership(tx,{scope,id,audit,base:selected,derivative:preparation.ingestFacts.normalization.document.derivative})
    omissionTrace.terminalRows++;omissionTrace.detailRows++
    assert.equal(await tx.v2PublicOperation.count({where:scope}),omissionBefore.operations+1)
    assert.equal(await tx.v2ProjectProxyRenderOperation.count({where:scope}),omissionBefore.details+1)
    const forged=resealStoredManualBundle(omittedProposal,c=>{
     c.payload.impact.affectedArtifacts=[];const {impactHash,...body}=c.payload.impact;c.payload.impact.impactHash=calculateCanonicalHash(body)
    },world.manualFingerprint)
    assert.equal(forged.origin.command.payload.impact.affectedArtifacts.length,0)
    await insertManualCommandForGuard(tx,forged,audit);await persistOutputVersionBundleInTransactionV3(tx,forged)
    facts.restoreOutputMembershipNegative={metadataOnly:true,seededOperationId:seeded.operationId,baseVersionId:selected.version.id,
     variantId:seeded.variantId,artifactId:seeded.outputArtifactId,manifestId:seeded.outputManifestId,
     rendererExecuted:false,renderAdmissible:false,approval:false,guardScope:'explicit local SQL completeness validator'}
    omissionTrace.localCalls++;await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_operational_state_v3($1)',forged.state.document.id)
    omissionTrace.flushForwarded++;await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
   }),e=>{
    ;(facts.manualRejections??=[]).push({label:'omitted-persisted-output',error:failureFact(e)})
    return e.code==='P2010'&&e.meta?.code==='23514'&&String(e.meta?.message??e.message).includes('W66v3 restore output membership differs')
   })
   assert.deepEqual(omissionTrace,{terminalRows:1,detailRows:1,localCalls:1,flushForwarded:0})
   assert.deepEqual({publication:await publicationSnapshot(db,scope,operationId),operations:await db.v2PublicOperation.count({where:scope}),
    details:await db.v2ProjectProxyRenderOperation.count({where:scope})},omissionBefore)
   facts.restoreOutputMembershipNegative={...facts.restoreOutputMembershipNegative,...omissionTrace,sqlstate:'23514',rollbackReadback:true}

   const restoredResult=await operationalRepo.persistChild(writeManual(restoreProposal)),restored=restoredResult.bundle
   assert.equal(restored.version.sequence,5);assert.equal(restored.state.document.transition,'restore')
   assert.deepEqual(restored.origin.target,{versionId:persisted.version.id,baseHash:persisted.version.baseHash,stateId:persisted.state.document.id,stateHash:persisted.state.stateHash})
   const ingestPlan=JSON.parse(persisted.editPlanSnapshot.contentJson)
   for(const child of [selected,restored]) {
    const plan=JSON.parse(child.editPlanSnapshot.contentJson),m=child.state.document.entries[0].consumption.materialization.document
    assert.notEqual(child.editPlanSnapshot.id,persisted.editPlanSnapshot.id);assert.notEqual(m.id,ingestMaterial.id)
    for(const field of ['videoTracks','audioTracks','durationFrames','fps'])assert.deepEqual(plan[field],ingestPlan[field])
    assert.deepEqual(m.clips,ingestMaterial.clips);assert.deepEqual(m.normalizations,ingestMaterial.normalizations)
    assert.deepEqual(m.emission,ingestMaterial.emission)
    for(const purpose of ['render','critic','final']) {
     const observed=await readPersistedOutputConsumptionV3(db,{...scope,versionId:child.version.id,variantId:id('output-alpha'),purpose})
     assert.equal(observed.status,'materialized');assert.equal(observed.bundle.version.baseHash,child.version.baseHash)
    }
   }
   const replayBefore=await publicationSnapshot(db,scope,operationId)
   assert.equal((await operationalRepo.persistChild(writeManual(restoreProposal))).replayed,true)
   assert.equal((await operationalRepo.persistChild(writeManual(selectProposal))).replayed,true)
   assert.deepEqual(await publicationSnapshot(db,scope,operationId),replayBefore)
   assert.equal(stableSerialize(await operationalRepo.read({...scope,versionId:persisted.version.id})),sourceBeforeManual)
   assert.equal(await db.v2OutputNormalizationReceipt.count({where:scope}),normalizationRowsBefore);assert.equal(executions.length,nativeCountBeforeManual)
   const persistedHead=await db.v2Project.findUnique({where:{id:scope.projectId}});assert.equal(persistedHead.currentVersionId,restored.version.id)
   assert.deepEqual({reviews:await db.v2ProxyReview.count({where:scope}),runs:await db.v2DirectorRun.count({where:scope})},approvalRowsBefore)
   facts.selectRestore={selectedVersionId:selected.version.id,restoredVersionId:restored.version.id,restoreTarget:persisted.version.id,
    freshMaterializations:true,originalReceiptsUnchanged:true,sourceImmutable:true,rightsCurrentReadback:true,providerOrNativeCallsAdded:0,
    purposes:['render','critic','final'],proof:'persisted geometry admission only; no critic/render/final approval executed',replayEffects:0,
    rollbackCases:['local-sql-revision','local-sql-impact','local-sql-complete-output-membership','current-rights-revoked','stale-head','restore-target-seal']}

   forkSource=restored;forkSourceRights=restoredRights;forkSourceRightsArtifact=restoredRightsArtifact
   } else {
    assert.equal(forkSource.version.sequence,3)
    assert.equal(forkSource.origin.kind,'ingest-operation')
    assert.ok(sourceCueTrack.cues.length>0)
    assert.equal(receipt.receiptHash,preparation.ingestFacts.normalization.receiptHash)
    facts.freshEditorialSetup={sourceVersionId:forkSource.version.id,sourceSequence:3,historicalB1SourceSequence:5,
     historicalB1Reexecuted:false,realOwnedIngest:true,originalNormalizationReceiptId:receipt.id,
     controlledTranscript:true,cuesSealedBeforePersistence:true,currentRightsSnapshotId:currentRights.snapshot.id}
   }

   // Group B reuses the actual persisted source facts above. Forking
   // preserves content and original observed receipts; no provider/native work
   // or target normalization/approval is manufactured by creation.
   let forkAllocationCount=0
   const duplicate=duplicateProjectService({repository:new PrismaProjectDuplicationRepository(db),clock:()=>boundedDate(),createEventId:randomUUID,
    createId:kind=>kind==='project-media-asset'?randomUUID():id('forkB-'+kind+'-'+(++forkAllocationCount))})
   const forkRequest={workspaceId:scope.workspaceId,projectId:scope.projectId,expectedVersionId:forkSource.version.id,expectedVersionHash:forkSource.version.baseHash,
    name:'Real full-content fork',actor:replayActor,idempotency:{clientId:audit.clientId,key:id('forkB-request')}}
   const sourceBeforeFork=serializeOutputCanonicalJson(await operationalRepo.read({...scope,versionId:forkSource.version.id})),nativeBeforeFork=executions.length
   // The same creation reader must deny a real audited revocation, even though
   // the immutable source receipt and copied content still pass their seals.
   await setRights({...scope,artifactId:sourceArtifactId,baseRevision:forkSourceRights.revision,
    draft:{...originalRightsDraft,status:'revoked'},actor:{type:'system',id:'controlled-fixture'}})
   const forkRightsBefore=await publicationSnapshot(db,scope,operationId),projectCountBefore=await db.v2Project.count({where:{workspaceId:scope.workspaceId}})
   await assert.rejects(()=>duplicate(forkRequest),e=>e.code==='ASSET_RIGHTS_BLOCKED'&&e.message==='Current rights block copying this inactive reference')
   assert.deepEqual(await publicationSnapshot(db,scope,operationId),forkRightsBefore)
   assert.equal(await db.v2Project.count({where:{workspaceId:scope.workspaceId}}),projectCountBefore)
   assert.equal(await db.v2IdempotencyRecord.count({where:{workspaceId:scope.workspaceId,clientId:audit.clientId,key:forkRequest.idempotency.key}}),0)
   const forkRevokedRights=await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)
   await setRights({...scope,artifactId:sourceArtifactId,baseRevision:forkRevokedRights.revision,draft:originalRightsDraft,actor:{type:'system',id:'controlled-fixture'}})
   if(freshEditorialFocus) {
    forkSourceRights=await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)
    forkSourceRightsArtifact=await db.v2MediaArtifact.findUnique({where:{id:sourceArtifactId}})
    assert.equal(forkSourceRights.snapshot.id,currentRights.snapshot.id)
    assert.equal(forkSourceRightsArtifact.currentRightsSnapshotId,forkSourceRights.snapshot.id)
    assert.ok(Number.isSafeInteger(forkSourceRightsArtifact.rightsRevision)&&forkSourceRightsArtifact.rightsRevision>0,'Restored rights pointer revision is a positive integer counter')
    assert.equal(forkSourceRights.revision,assetRightsRevision(sourceArtifactId,forkSourceRightsArtifact.rightsRevision),'Restored rights revision hash binds the artifact id and the integer pointer revision')
   }
   const fork=await duplicate(forkRequest),forkPlan=JSON.parse(fork.bundle.command.payload.snapshots.find(s=>s.kind==='edit-plan').contentJson)
   assert.equal(fork.version.sequence,1);assert.equal(fork.version.outputContractVersion,2)
   assert.equal(fork.project.currentVersionId,undefined,'Fork creation receipt never claims the current head')
   assert.equal(fork.version.forkedFromProjectId,scope.projectId);assert.equal(fork.version.forkedFromVersionId,forkSource.version.id)
   assert.equal(fork.copiedBytes,0);assert.equal(fork.bundle.command.payload.forkDerivation.schemaVersion,'project-fork-derivation/v3')
   const originalForkPlan=JSON.parse(forkSource.editPlanSnapshot.contentJson)
   assert.ok(originalForkPlan.videoTracks[0].clips.length>0);assert.ok(originalForkPlan.subtitleTracks[0].cues.length>0)
   assert.equal(forkPlan.durationFrames,originalForkPlan.durationFrames);assert.equal(forkPlan.fps,originalForkPlan.fps)
   assert.notEqual(forkPlan.videoTracks[0].id,originalForkPlan.videoTracks[0].id)
   assert.notEqual(forkPlan.videoTracks[0].clips[0].id,originalForkPlan.videoTracks[0].clips[0].id)
   assert.notEqual(forkPlan.subtitleTracks[0].cues[0].id,originalForkPlan.subtitleTracks[0].cues[0].id)
   assert.equal(forkPlan.subtitleTracks[0].cues[0].text,originalForkPlan.subtitleTracks[0].cues[0].text)
   assert.equal(forkPlan.subtitleTracks[0].sourceTranscriptId,sourceCueTrack.sourceTranscriptId,'External source transcript identity is preserved, never relabeled as target ASR')
   assert.equal(forkPlan.subtitleTracks[0].sourceTranscriptHash,sourceCueTrack.sourceTranscriptHash)
   assert.equal(forkPlan.subtitleTracks[0].emission,'suppressed-missing-visual-clock-authority')
   assert.deepEqual(forkPlan.sourceTranscriptCueProjection,sourceCuePlan.sourceTranscriptCueProjection,
    'Source-only capability facts retain external transcript identity without an unmapped target track reference')
   assert.equal(forkPlan.subtitleTracks[0].cues[0].clipId,forkPlan.videoTracks[0].clips[0].id,'Typed cue clip reference follows the full-content identity map')
   for(const field of ['startFrame','endFrame','sourceSegmentId','sourceWordIndices'])assert.deepEqual(
    forkPlan.subtitleTracks[0].cues[0][field],originalForkPlan.subtitleTracks[0].cues[0][field])
   const forkEntry=fork.bundle.state.document.entries[0]
   assert.notEqual(forkEntry.variantId,forkSource.state.document.entries[0].variantId)
   assert.equal(forkEntry.spec.schemaVersion,'output-spec-revision/v3');assert.equal(forkEntry.spec.source.outputContractVersion,3)
   assert.deepEqual(forkEntry.spec.effectiveSpec.profile,forkSource.state.document.entries[0].spec.profile)
   assert.equal(await db.v2OutputNormalizationReceipt.count({where:{workspaceId:scope.workspaceId,projectId:fork.project.id}}),0)
   for(const purpose of ['render','critic','final']) {
    const observed=await readPersistedOutputConsumptionV3(db,{workspaceId:scope.workspaceId,projectId:fork.project.id,versionId:fork.version.id,variantId:forkEntry.variantId,purpose})
    assert.equal(observed.status,'blocked');assert.deepEqual(observed.reasons,['fork-target-materialization-required'])
   }
   const forkScope={workspaceId:scope.workspaceId,projectId:fork.project.id}
   assert.equal(serializeOutputCanonicalJson(await creationRepo.read({...forkScope,versionId:fork.version.id})),serializeOutputCanonicalJson(fork.bundle))
   if(!freshEditorialFocus) {
   const forkEffects=async()=>({projects:await db.v2Project.count({where:{workspaceId:scope.workspaceId}}),versions:await db.v2ProjectVersion.count({where:{workspaceId:scope.workspaceId}}),
    states:await db.v2ProjectOutputState.count({where:{workspaceId:scope.workspaceId}}),commands:await db.v2ProjectCreationCommand.count({where:{workspaceId:scope.workspaceId}}),
    events:await db.v2PublicEventOutbox.count({where:{workspaceId:scope.workspaceId}}),links:await db.v2ProjectMediaAsset.count({where:{workspaceId:scope.workspaceId}}),
    idempotency:await db.v2IdempotencyRecord.count({where:{workspaceId:scope.workspaceId}})})
   const forkEffectsBefore=await forkEffects(),forkBytes=serializeOutputCanonicalJson(fork.bundle)
   const forkReplay=await duplicate(forkRequest)
   assert.equal(forkReplay.replayed,true);assert.equal(serializeOutputCanonicalJson(forkReplay.bundle),forkBytes)
   assert.deepEqual(await forkEffects(),forkEffectsBefore)
   await assert.rejects(()=>duplicate({...forkRequest,name:'Changed caller intent'}),e=>e.code==='IDEMPOTENCY_PAYLOAD_MISMATCH')
   await assert.rejects(()=>duplicate({...forkRequest,expectedVersionId:persisted.version.id,expectedVersionHash:persisted.version.baseHash,
    idempotency:{clientId:audit.clientId,key:id('forkB-stale-source')}}),e=>e.code==='VERSION_CONFLICT')
   assert.deepEqual(await forkEffects(),forkEffectsBefore)
   }
   assert.equal(serializeOutputCanonicalJson(await operationalRepo.read({...scope,versionId:forkSource.version.id})),sourceBeforeFork)
   assert.equal(await db.v2OutputNormalizationReceipt.count({where:scope}),normalizationRowsBefore)
   assert.equal(executions.length,nativeBeforeFork)
   assert.deepEqual({reviews:await db.v2ProxyReview.count({where:forkScope}),runs:await db.v2DirectorRun.count({where:forkScope})},{reviews:0,runs:0})
   facts.fullContentFork={sourceVersionId:forkSource.version.id,targetProjectId:fork.project.id,targetVersionId:fork.version.id,targetStateId:fork.bundle.state.document.id,
    derivationSchema:'project-fork-derivation/v3',revisionSchema:'output-spec-revision/v3',freshTypedIds:true,clipsAndCuesPreserved:true,
    sourceReceiptsUnchanged:true,targetNormalizationExecutions:0,targetApprovals:0,copiedBytes:0,replayEffects:freshEditorialFocus?null:0,forkReplayReexecuted:!freshEditorialFocus,currentHeadClaim:false,
    currentRightsRevocationRejected:true,restorationUsesAuditedOriginalSnapshot:true,
    rightsSnapshotBirthSequence:forkSourceRights.snapshot.sequence,restoredPointerRevision:forkSourceRightsArtifact.rightsRevision,
    consumption:'blocked for render/critic/final pending legitimate target materialization'}
   emitEditorialFlush({phase:freshEditorialFocus?'fresh-ingest-fork-returned-editorial-entry':'select-restore-fork-returned-editorial-entry'})

   // Fourth duplication behavior uses this real persisted source-cue/fork.
   // Reuse remains original execution/ASR; child owns only its source binding,
   // fresh plan/materialization/Command/State/Version and target current rights.
   const editorialDiagnosticClient=new Proxy(db,{get(target,key){
    if(key==='$transaction')return async (action,options)=>{
     let observedDeferredFlush=false
     const transactionResult=await target.$transaction(async tx=>{
     const delegate=new Proxy(tx,{get(transaction,property){
      if(property==='$executeRawUnsafe')return async (query,...values)=>{
       if(query!=='SET CONSTRAINTS ALL IMMEDIATE')return transaction.$executeRawUnsafe(query,...values)
       observedDeferredFlush=true
       const context=await transaction.$queryRawUnsafe("SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")
       assert.equal(context.length,1);assert.equal(context[0].statement_timeout,'10s');assert.equal(context[0].lock_timeout,'8s')
       emitEditorialFlush({phase:'flush-start',pgContext:context[0]})
       const startedAt=performance.now()
       try {
        const result=await transaction.$executeRawUnsafe(`DO $w66_diagnostic$
DECLARE primary_message text;primary_state text;server_context text;bounded_context jsonb;
BEGIN
 SET CONSTRAINTS ALL IMMEDIATE;
EXCEPTION WHEN query_canceled THEN
 GET STACKED DIAGNOSTICS primary_message=MESSAGE_TEXT,primary_state=RETURNED_SQLSTATE,server_context=PG_EXCEPTION_CONTEXT;
 SELECT coalesce(jsonb_agg(lines.line),'[]'::jsonb) INTO bounded_context FROM
  (SELECT left(item.line,240) AS line FROM regexp_split_to_table(server_context,E'\\n') WITH ORDINALITY AS item(line,ordinal)
   WHERE item.line ~ '^(PL/pgSQL function|SQL function)' ORDER BY item.ordinal LIMIT 16) AS lines;
 RAISE EXCEPTION USING ERRCODE=primary_state,MESSAGE=primary_message||E'\\n[W66_DEFERRED_CONTEXT_V1]'||
  jsonb_build_object('sqlstate',primary_state,'primaryMessage',primary_message,'context',bounded_context)::text||'[/W66_DEFERRED_CONTEXT_V1]';
END; $w66_diagnostic$`)
        emitEditorialFlush({phase:'flush-returned',durationMs:performance.now()-startedAt})
        return result
       } catch(error) {
        const observed=String(error.meta?.message??error.message),start=observed.indexOf('[W66_DEFERRED_CONTEXT_V1]'),end=observed.indexOf('[/W66_DEFERRED_CONTEXT_V1]')
        if(start>=0&&end>start) {
         try{const diagnostic=JSON.parse(observed.slice(start+'[W66_DEFERRED_CONTEXT_V1]'.length,end));emitEditorialFlush({phase:'flush-error',durationMs:performance.now()-startedAt,
          sqlstate:diagnostic.sqlstate,primaryMessage:diagnostic.primaryMessage,context:diagnostic.context})}catch{emitEditorialFlush({phase:'flush-error-unparsed',durationMs:performance.now()-startedAt,sqlstate:error.meta?.code??null})}
        } else emitEditorialFlush({phase:'flush-error-context-absent',durationMs:performance.now()-startedAt,sqlstate:error.meta?.code??null})
        throw error // The real Prisma failure remains the test failure, never a PASS.
       }
      }
      const value=Reflect.get(transaction,property);return typeof value==='function'?value.bind(transaction):value
     }})
     const callbackResult=await action(delegate)
     if(observedDeferredFlush)emitEditorialFlush({phase:'transaction-callback-returned'})
     return callbackResult
    },options)
     if(observedDeferredFlush)emitEditorialFlush({phase:'transaction-promise-returned'})
     return transactionResult
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
   }})
   const editorialRepository=new PrismaEditorialCommandRepository(editorialDiagnosticClient)
   let editorialAllocations=0
   const applyEditorial=applyEditorialCutCommandService({repository:editorialRepository,clock:()=>boundedDate(),createEventId:randomUUID,
    createId:kind=>id('editorialB-'+kind+'-'+(++editorialAllocations))})
   const editorialRequest={...forkScope,baseVersionId:fork.version.id,baseHash:fork.version.baseHash,sourceTranscriptId:sourceCueTrack.sourceTranscriptId,
    variantId:forkEntry.variantId,rules:[{id:id('editorial-cut-controlada'),label:'Remove controlled word',alternatives:['controlada']}],
    reason:'Controlled continuity of full-content fork.',actor:replayActor,idempotency:{clientId:audit.clientId,key:id('editorialB-request')}}
   const beforeEditorial={source:sourceBeforeFork,fork:serializeOutputCanonicalJson(fork.bundle),native:executions.length,
    normalizations:await db.v2OutputNormalizationReceipt.count({where:{workspaceId:scope.workspaceId}}),transcripts:await db.v2MediaTranscript.count({where:{workspaceId:scope.workspaceId}})}
   // Admission denies current rights before a new editorial bundle is inserted.
   const editorialRights=await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)
   await setRights({...scope,artifactId:sourceArtifactId,baseRevision:editorialRights.revision,draft:{...originalRightsDraft,status:'revoked'},actor:{type:'system',id:'controlled-fixture'}})
   const blockedEditorialBefore=await publicationSnapshot(db,forkScope,operationId)
   await assert.rejects(()=>applyEditorial({...editorialRequest,idempotency:{clientId:audit.clientId,key:id('editorialB-revoked')}}),e=>e.code==='ASSET_RIGHTS_BLOCKED')
   assert.deepEqual(await publicationSnapshot(db,forkScope,operationId),blockedEditorialBefore)
   const deniedEditorialRights=await rightsRepo.findCurrent(scope.workspaceId,sourceArtifactId)
   await setRights({...scope,artifactId:sourceArtifactId,baseRevision:deniedEditorialRights.revision,draft:originalRightsDraft,actor:{type:'system',id:'controlled-fixture'}})
   const editorial=await applyEditorial(editorialRequest)
   emitEditorialFlush({phase:'apply-editorial-returned'})
   const editorialPlan=editorial.editPlan,editorialBundle=editorial.outputBundle,
    editorialEntry=editorialBundle.state.document.entries[0],editorialMaterial=editorialEntry.consumption.materialization.document
   assert.equal(editorial.version.sequence,2);assert.equal(editorial.version.parentVersionId,fork.version.id);assert.equal(editorial.version.outputContractVersion,3)
   assert.equal(editorial.command.payload.schemaVersion,3);assert.equal(editorialBundle.state.document.transition,'editorial-cut')
   const editorialEvents=await db.v2PublicEventOutbox.findMany({where:{workspaceId:forkScope.workspaceId,resourceId:editorial.version.id,type:'project.version.created'}})
   assert.equal(editorialEvents.length,1)
   const editorialEventData=JSON.parse(editorialEvents[0].dataJson)
   assert.equal(editorialEventData.commandImpactHash,editorial.impact.impactHash);assert.equal(editorialEventData.commandType,'remove-spoken-content')
   assert.equal(editorialEventData.baseHash,editorial.version.baseHash);assert.equal(editorialEventData.invalidatedArtifactCount,editorial.impact.affectedArtifacts.length)
   assert.deepEqual(editorialEventData.snapshotRefs,editorial.version.snapshotRefs);assert.equal(editorialEvents[0].actorClientId,audit.clientId)
   assert.equal(editorialEntry.variantId,forkEntry.variantId);assert.equal(editorialEntry.outputSpecRevisionId,forkEntry.outputSpecRevisionId)
   assert.equal(editorialEntry.specHash,forkEntry.specHash);assert.deepEqual(editorialEntry.spec,forkEntry.spec)
   assert.equal(editorialMaterial.schemaVersion,'editorial-derived-materialization/v1');assert.equal(editorialMaterial.sourceBinding.document.projectId,fork.project.id)
   assert.equal(editorialMaterial.sourceBinding.document.transcript.projectId,scope.projectId)
   assert.equal(editorialMaterial.sourceBinding.document.transcript.id,sourceCueTrack.sourceTranscriptId)
   assert.deepEqual(editorialMaterial.normalizations,ingestMaterial.normalizations)
   assert.deepEqual(editorialMaterial.emission,{subtitles:'suppressed-missing-visual-clock-authority',cta:'suppressed-missing-visual-clock-authority'})
   assert.equal(editorialPlan.durationFrames,36);assert.equal(editorialPlan.subtitleTracks[0].cues[0].text,'Fonte')
   assert.deepEqual(editorialPlan.subtitleTracks[0].cues[0].sourceWordIndices,[0])
   assert.deepEqual(editorialPlan.videoTracks[0].clips.map(c=>[c.sourceInFrame,c.sourceOutFrame,c.timelineInFrame,c.timelineOutFrame,c.rate]),[[0,30,0,30,1],[54,60,30,36,1]])
   assert.deepEqual(editorial.retainedSourceRanges,[{sourceStartSeconds:0,sourceEndSeconds:1},{sourceStartSeconds:1.8,sourceEndSeconds:2}])
   assert.equal(editorial.impact.schemaVersion,'editorial-cut-impact/v2');assert.deepEqual(editorial.impact.affectedVariantIds,[forkEntry.variantId])
   emitEditorialFlush({phase:'readback-start'})
   for(const purpose of ['render','critic','final']) {
    const observed=await readPersistedOutputConsumptionV3(db,{...forkScope,versionId:editorial.version.id,variantId:forkEntry.variantId,purpose})
    assert.equal(observed.status,'blocked');assert.deepEqual(observed.reasons,['derived-source-perception-authority-required'])
    assert.equal(observed.outputStateId,editorialBundle.state.document.id);assert.equal(observed.outputStateHash,editorialBundle.state.stateHash)
   }
   assert.equal(serializeOutputCanonicalJson(await operationalRepo.read({...forkScope,versionId:editorial.version.id})),serializeOutputCanonicalJson(editorialBundle))
   assert.equal(serializeOutputCanonicalJson(await creationRepo.read({...forkScope,versionId:fork.version.id})),beforeEditorial.fork)
   assert.equal(serializeOutputCanonicalJson(await operationalRepo.read({...scope,versionId:forkSource.version.id})),beforeEditorial.source)
   assert.equal((await db.v2Project.findUnique({where:{id:fork.project.id}})).currentVersionId,editorial.version.id)
   assert.equal(await db.v2OutputNormalizationReceipt.count({where:forkScope}),0);assert.equal(await db.v2MediaTranscript.count({where:forkScope}),0)
   assert.equal(await db.v2OutputMaterializationNormalization.count({where:forkScope}),0,'Original-project receipts are never forged into a target composite FK')
   assert.equal(await db.v2OutputNormalizationReceipt.count({where:{workspaceId:scope.workspaceId}}),beforeEditorial.normalizations)
   assert.equal(await db.v2MediaTranscript.count({where:{workspaceId:scope.workspaceId}}),beforeEditorial.transcripts);assert.equal(executions.length,beforeEditorial.native)
   assert.deepEqual({reviews:await db.v2ProxyReview.count({where:forkScope}),runs:await db.v2DirectorRun.count({where:forkScope})},{reviews:0,runs:0})
   emitEditorialFlush({phase:'readback-returned'})
   const afterEditorial=await publicationSnapshot(db,forkScope,operationId),editorialReplay=await applyEditorial(editorialRequest)
   assert.equal(editorialReplay.replayed,true);assert.equal(serializeOutputCanonicalJson(editorialReplay.outputBundle),serializeOutputCanonicalJson(editorialBundle))
   assert.deepEqual(await publicationSnapshot(db,forkScope,operationId),afterEditorial)
   await assert.rejects(()=>applyEditorial({...editorialRequest,reason:'Changed caller'}),e=>e.code==='IDEMPOTENCY_PAYLOAD_MISMATCH')
   await assert.rejects(()=>applyEditorial({...editorialRequest,idempotency:{clientId:audit.clientId,key:id('editorialB-stale')}}),e=>e.code==='VERSION_CONFLICT')
   assert.deepEqual(await publicationSnapshot(db,forkScope,operationId),afterEditorial)
   // Resealed forged source identity is rejected by the real local SQL guard;
   // all inserted new rows are rolled back before the readback comparison.
   emitEditorialFlush({phase:'good-child-start'})
   const badContext=await editorialRepository.readContext({...forkScope,transcriptId:sourceCueTrack.sourceTranscriptId,variantId:forkEntry.variantId})
   const captured=[]
   const captureEditorial=applyEditorialCutCommandService({repository:{findIdempotentResult:async()=>null,readContext:async()=>badContext,
    commitOrReplay:async input=>{captured.push(input);return {}}},clock:()=>boundedDate(),createEventId:randomUUID,
    createId:kind=>id('editorial-forged-'+kind+'-'+(++editorialAllocations))})
   await captureEditorial({...editorialRequest,baseVersionId:editorial.version.id,baseHash:editorial.version.baseHash,
    rules:[{id:id('editorial-cut-fonte'),label:'Remove source word',alternatives:['Fonte']}],idempotency:{clientId:audit.clientId,key:id('editorialB-forged')}})
   const forgedInput=clone(captured[0].proposal),goodChild=buildOperationalOutputVersionBundleV3(forgedInput)
   emitEditorialFlush({phase:'good-child-returned'})
   // Actual raw INSERT bypasses constructors deliberately. Every attack runs
   // in a fresh rollback TX; errors retain the concrete SQLstate/constraint.
   const commandSealBefore=await publicationSnapshot(db,forkScope,operationId),commandSealRejections=[]
   const outputSealConstraint='edit_commands_output_payload_seal_check',documentSealConstraint='edit_commands_document_seal_check'
   const commandSealAttacks=[
    ['payload-hash',outputSealConstraint,data=>{data.outputPayloadHash='f'.repeat(64)}],
    ['command-hash',documentSealConstraint,data=>{data.commandHash='f'.repeat(64)}],
    ['payload-envelope',outputSealConstraint,data=>{const p=JSON.parse(data.outputPayloadJson);p.variantId=id('foreign-payload-variant')
      data.outputPayloadJson=serializeOutputCanonicalJson(p);data.outputPayloadHash=calculateOutputCanonicalHash(p)}],
    ['command-envelope',outputSealConstraint,data=>{const body=JSON.parse(data.commandJson);body.type='manual-edit'
      data.commandJson=stableSerialize(body);data.commandHash=calculateCanonicalHash(body)}],
    ['missing-output',outputSealConstraint,data=>{data.outputPayloadJson=null;data.outputPayloadHash=null}],
    ['missing-binding',outputSealConstraint,data=>{const p=JSON.parse(data.payloadJson);delete p.sourceBinding
      const body=JSON.parse(data.commandJson);body.payload=p;data.payloadJson=stableSerialize(p)
      data.outputPayloadJson=serializeOutputCanonicalJson(p);data.outputPayloadHash=calculateOutputCanonicalHash(p)
      data.commandJson=stableSerialize(body);data.commandHash=calculateCanonicalHash(body)}],
    ['numeric-id',outputSealConstraint,data=>{const p=JSON.parse(data.payloadJson);p.variantId=123
      const body=JSON.parse(data.commandJson);body.payload=p;data.payloadJson=stableSerialize(p)
      data.outputPayloadJson=serializeOutputCanonicalJson(p);data.outputPayloadHash=calculateOutputCanonicalHash(p)
      data.commandJson=stableSerialize(body);data.commandHash=calculateCanonicalHash(body)}],
    ['foreign-type',outputSealConstraint,data=>{const body=JSON.parse(data.commandJson);data.type='manual-edit';body.type=data.type
      data.commandJson=stableSerialize(body);data.commandHash=calculateCanonicalHash(body)}],
    ['audit-context',outputSealConstraint,data=>{data.actorContextHash='f'.repeat(64)}],
   ]
   emitEditorialFlush({phase:'command-seals-start',expectedCount:commandSealAttacks.length})
   for(const [label,constraint,mutate]of commandSealAttacks) {
    await assert.rejects(()=>db.$transaction(async tx=>{
     const data=editorialCommandDataForGuard(goodChild,audit);mutate(data)
     const fields=Object.keys(data),columns=fields.map(field=>'"'+field+'"').join(','),parameters=fields.map((_,index)=>'$'+(index+1)).join(',')
     await tx.$executeRawUnsafe('INSERT INTO "edit_commands" ('+columns+') VALUES ('+parameters+')',...fields.map(field=>data[field]))
     throw new Error('Adulterated editorial Command seal unexpectedly admitted')
    }),error=>{
     commandSealRejections.push({label,error:failureFact(error),constraint})
     return error.code==='P2010'&&error.meta?.code==='23514'&&String(error.meta?.message??error.message).includes(constraint)
    })
    assert.deepEqual(await publicationSnapshot(db,forkScope,operationId),commandSealBefore)
    assert.equal(await db.v2EditCommand.findUnique({where:{id:goodChild.origin.command.id}}),null)
    assert.equal(await db.v2ProjectVersion.findUnique({where:{id:goodChild.version.id}}),null)
   }
   assert.equal(commandSealRejections.length,commandSealAttacks.length)
   emitEditorialFlush({phase:'command-seals-returned',completedCount:commandSealRejections.length})
   facts.editorialCommandSealNegatives={cases:commandSealRejections,sqlstate:'23514',publishEffects:0,rollbackReadback:true,
    hashOrEnvelopeOrRequiredFieldOrForeignTypeRejected:true,historicalCommandHashesUnchanged:true}
   // A genuine binding still cannot authorize altered embedded receipt facts.
   // Only the embedded document/hash changes; the immutable source row and refs
   // remain legitimate. Resealing the child is deliberately a raw SQL attack.
   const normalizationTamper=resealEditorialBundleForGuard(goodChild,bundle=>{
    const material=bundle.state.document.entries.find(e=>e.consumption.status==='materialized').consumption.materialization.document
    const embedded=material.normalizations[0]
    assert.notEqual(embedded.document.sourceProbe.frames[0].pts,'1')
    embedded.document.sourceProbe.frames[0].pts='1'
    embedded.receiptHash=calculateOutputCanonicalHash(embedded.document)
   })
   assert.deepEqual(normalizationTamper.origin.command.payload.sourceBinding,goodChild.origin.command.payload.sourceBinding)
   const normalizationTrace={setupComplete:false,entrypointCalled:false,entrypointReturned:false}
   await assert.rejects(()=>db.$transaction(async tx=>{
    await insertEditorialCommandForGuard(tx,normalizationTamper,audit)
    await persistOutputVersionBundleInTransactionV3(tx,normalizationTamper)
    normalizationTrace.setupComplete=true;normalizationTrace.entrypointCalled=true
    await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_materialization_v3($1,$2,$3)',
     normalizationTamper.state.document.entries.find(e=>e.consumption.status==='materialized').consumption.materialization.document.id,
     forkScope.projectId,forkScope.workspaceId)
    normalizationTrace.entrypointReturned=true
    throw new Error('Altered embedded normalization unexpectedly admitted')
   }),error=>{
    facts.editorialEmbeddedNormalizationRejection={...normalizationTrace,error:failureFact(error)}
    return normalizationTrace.setupComplete&&normalizationTrace.entrypointCalled&&!normalizationTrace.entrypointReturned&&
     error.code==='P2010'&&error.meta?.code==='23514'&&String(error.meta?.message??error.message).includes('W66v3 materialization normalization seal differs')
   })
   assert.deepEqual(normalizationTrace,{setupComplete:true,entrypointCalled:true,entrypointReturned:false})
   assert.deepEqual(await publicationSnapshot(db,forkScope,operationId),afterEditorial)
   assert.equal(await db.v2EditCommand.findUnique({where:{id:normalizationTamper.origin.command.id}}),null)
   assert.equal(await db.v2ProjectVersion.findUnique({where:{id:normalizationTamper.version.id}}),null)
   const forged=clone(goodChild),forgedBinding=clone(forged.origin.command.payload.sourceBinding)
   forgedBinding.document.authority.derivationHash='f'.repeat(64)
   const resealedBinding=createEditorialSourceBindingV1(forgedBinding.document)
   forged.origin.command.payload.sourceBinding=resealedBinding
   const {schemaVersion:forgedSchema,commandHash:forgedHash,...forgedCommandBody}=forged.origin.command
   forged.origin.command=createEditCommand(forgedCommandBody)
   for(const e of forged.state.document.entries) {
    if(e.consumption.status!=='materialized')continue
    const m=e.consumption.materialization;m.document.sourceBinding=resealedBinding;m.materializationHash=calculateOutputCanonicalHash(m.document)
   }
   forged.state.document.provenance.hash=forged.origin.command.commandHash
   forged.state.document.producer.document.commandHash=forged.origin.command.commandHash
   forged.state.document.producer.document.payloadHash=calculateOutputCanonicalHash(forged.origin.command.payload)
   forged.state.document.producer.hash=calculateOutputCanonicalHash(forged.state.document.producer.document)
   forged.state.stateHash=calculateOutputCanonicalHash(forged.state.document)
   const sealBody=outputBoundVersionHashBodyV3({state:forged.state,previousBaseHash:editorial.version.baseHash})
   forged.outputBaseHashJson=serializeOutputCanonicalJson(sealBody);forged.version.outputStateHash=forged.state.stateHash;forged.version.baseHash=calculateOutputCanonicalHash(sealBody)
   const lineageEntrypoints=['operational-state','materialization'],lineageRejections=[]
   facts.editorialLineageRejections=lineageRejections
   emitEditorialFlush({phase:'lineage-start',expectedCount:lineageEntrypoints.length})
   for(const entrypoint of lineageEntrypoints) {
    const trace={setupComplete:false,entrypointCalled:null,entrypointReturned:false}
    await assert.rejects(()=>db.$transaction(async tx=>{
     const c=forged.origin.command,{commandHash,...body}=c,a=externalActorAuditData(audit,forkScope.workspaceId,c.author.id)
     await tx.v2EditCommand.create({data:{id:c.id,workspaceId:c.workspaceId,projectId:c.projectId,baseVersionId:c.baseVersionId,baseHash:c.baseHash,type:c.type,
      scopeJson:stableSerialize(c.scope),payloadJson:stableSerialize(c.payload),reason:c.reason??null,actorType:c.author.type,actorId:c.author.id,delegatedUserId:c.author.delegatedUserId??null,
      actorCredentialId:a.actorCredentialId,actorEnvironment:a.actorEnvironment,actorAuthenticationKind:a.actorAuthenticationKind,actorContextHash:a.actorContextHash,
      actorDelegatedIdentityId:a.delegatedIdentityId??null,actorWorkspaceRole:a.workspaceRole??null,idempotencyKey:c.idempotencyKey,requestFingerprint:forged.origin.requestFingerprint,
      commandHash:c.commandHash,commandJson:stableSerialize(body),outputPayloadJson:serializeOutputCanonicalJson(c.payload),outputPayloadHash:calculateOutputCanonicalHash(c.payload),createdAt:new Date(c.createdAt)}})
     await persistOutputVersionBundleInTransactionV3(tx,forged)
     trace.setupComplete=true
     trace.entrypointCalled=entrypoint
     if(entrypoint==='operational-state')await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_operational_state_v3($1)',forged.state.document.id)
     else await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_materialization_v3($1,$2,$3)',
      forged.state.document.entries.find(e=>e.consumption.status==='materialized').consumption.materialization.document.id,forkScope.projectId,forkScope.workspaceId)
     trace.entrypointReturned=true
     await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    }),e=>{
     lineageRejections.push({entrypoint,...trace,error:failureFact(e)})
     return trace.setupComplete&&trace.entrypointCalled===entrypoint&&!trace.entrypointReturned&&e.code==='P2010'&&e.meta?.code==='23514'&&
      String(e.meta?.message??e.message).includes('W66 editorial source authority missing/ambiguous')
    })
    assert.deepEqual(trace,{setupComplete:true,entrypointCalled:entrypoint,entrypointReturned:false})
    assert.deepEqual(await publicationSnapshot(db,forkScope,operationId),afterEditorial)
   }
   emitEditorialFlush({phase:'lineage-returned',completedCount:lineageRejections.length})
   const editorialOmissionTrace={terminalRows:0,detailRows:0,guardCalls:0,flushForwarded:0}
   const editorialOmissionBefore={publication:await publicationSnapshot(db,forkScope,operationId),operations:await db.v2PublicOperation.count({where:forkScope}),details:await db.v2ProjectProxyRenderOperation.count({where:forkScope})}
   await assert.rejects(()=>db.$transaction(async tx=>{
    const seeded=await seedControlledProxyMembership(tx,{scope:forkScope,id:s=>id('editorial-omission-'+s),audit,base:editorialBundle,
      derivative:preparation.ingestFacts.normalization.document.derivative})
    editorialOmissionTrace.terminalRows++;editorialOmissionTrace.detailRows++
    const proposals=[]
    const complete=applyEditorialCutCommandService({repository:{findIdempotentResult:async()=>null,readContext:async()=>({...badContext,
      outputReferences:[{artifactId:seeded.outputArtifactId,kind:'proxy',sourceVersionId:editorial.version.id,variantId:seeded.variantId}]}),
      commitOrReplay:async input=>{proposals.push(input);return {}}},clock:()=>boundedDate(),createEventId:randomUUID,
      createId:kind=>id('editorial-omission-'+kind+'-'+(++editorialAllocations))})
    await complete({...editorialRequest,baseVersionId:editorial.version.id,baseHash:editorial.version.baseHash,
      rules:[{id:id('editorial-omission-fonte'),label:'Source word',alternatives:['Fonte']}],idempotency:{clientId:audit.clientId,key:id('editorial-omission-key')}})
    const completeBundle=buildOperationalOutputVersionBundleV3(proposals[0].proposal)
    assert.equal(completeBundle.origin.command.payload.impact.affectedArtifacts.length,1)
    const omitted=resealEditorialBundleForGuard(completeBundle,bundle=>{
      const payload=bundle.origin.command.payload,impact=payload.impact
      payload.impact=createEditorialCutImpactV2({commandId:impact.commandId,baseVersionId:impact.baseVersionId,resultVersionId:impact.resultVersionId,
        sourceTranscriptId:impact.sourceTranscriptId,sourceTranscriptHash:impact.sourceTranscriptHash,affectedEndFrame:impact.affectedRanges[0].endFrame,
        renderEndFrame:impact.minimalRenders[0].ranges[0].endFrame,proxyVariantId:payload.variantId,variantIds:impact.affectedVariantIds,outputReferences:[]})
    })
    assert.equal(omitted.origin.command.payload.impact.affectedArtifacts.length,0)
    await insertEditorialCommandForGuard(tx,omitted,audit);await persistOutputVersionBundleInTransactionV3(tx,omitted)
    editorialOmissionTrace.guardCalls++;await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_operational_state_v3($1)',omitted.state.document.id)
    editorialOmissionTrace.flushForwarded++;await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
   }),e=>e.code==='P2010'&&e.meta?.code==='23514'&&String(e.meta?.message??e.message).includes('W66 editorial output membership differs'))
   assert.deepEqual(editorialOmissionTrace,{terminalRows:1,detailRows:1,guardCalls:1,flushForwarded:0})
   assert.deepEqual({publication:await publicationSnapshot(db,forkScope,operationId),operations:await db.v2PublicOperation.count({where:forkScope}),
    details:await db.v2ProjectProxyRenderOperation.count({where:forkScope})},editorialOmissionBefore)
   facts.editorialOutputMembershipNegative={...editorialOmissionTrace,sqlstate:'23514',rollbackReadback:true,metadataOnly:true,rendererExecuted:false,approval:false}
   facts.editorialFork={targetVersionId:editorial.version.id,parentVersionId:fork.version.id,outputContractVersion:3,
    producer:'output-editorial-derived-producer/v1',materialization:'editorial-derived-materialization/v1',transcriptProjectId:scope.projectId,
    targetNormalizationExecutions:0,targetAsrExecutions:0,sourceReceiptsUnchanged:true,immutableRevision3:true,sourceCuesCutBeforeSeals:true,
    currentRightsRevocationRejected:true,resealedLineageRejectedWithRollback:true,lineageEntrypoints,lineageRejections,replayEffects:0,approval:false,renderOrCriticOrFinalExecuted:false}

   // A committed operational head keeps its original administrative binding.
   // These updates are not re-sealed and must be rejected by the deferred head
   // dispatch, then read back unchanged after real rollback.
   const administrativeBefore=await publicationSnapshot(db,scope,operationId)
   for(const data of [{ownerId:null},{format:'9:16'}]) {
    await assert.rejects(()=>db.$transaction(async tx=>{
     await tx.v2Project.update({where:{id:scope.projectId},data})
     await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    }),e=>e.code==='P2010'&&e.meta?.code==='23514'&&String(e.meta?.message??e.message).includes('W66v3 Creation2 factual anchor differs'))
    assert.deepEqual(await publicationSnapshot(db,scope,operationId),administrativeBefore)
   }
   // Actual DB tamper cannot reinterpret already sealed observed facts.
   await assert.rejects(()=>db.$executeRawUnsafe('UPDATE output_normalization_receipts SET "receiptJson"=$1 WHERE id=$2','{}',receipt.id),e=>e.code==='P2010'&&e.meta?.code==='23514')
   const unchanged=await db.v2OutputNormalizationReceipt.findUnique({where:{id:receipt.id}});assert.equal(unchanged.receiptJson,receipt.receiptJson)
   facts.bundle={versionId:persisted.version.id,baseHash:persisted.version.baseHash,stateHash:persisted.state.stateHash,receiptHash:receipt.receiptHash}
   assert.equal(pendingOwnedFfmpegTerminations().length,0);assert.equal(pendingOwnedIo().length,0)
   assert.ok(performance.now()<workEnd);candidateOutcome='passed'
  } catch(error) {primary=error;facts.error=failureFact(error)}
  finally {
   if(db)try{await db.$disconnect()}catch(error){cleanupErrors.push(failureFact(error));primary??=error}
   facts.executions=executions.map(e=>({ownerKey:e.ownerKey,spawnObserved:e.spawnObserved,closeObserved:e.closeObserved,exitCode:e.exitCode,
    signal:e.signal,stdoutBytes:e.stdoutBytes,stderrBytes:e.stderrBytes,timedOut:e.timedOut,aborted:e.aborted}))
   facts.cleanupErrors=cleanupErrors;facts.marker='observed-pending-owner-confirmation';facts.candidateOutcome=candidateOutcome
   if(performance.now()<hardEnd&&!io.isRetained()&&pendingOwnedFfmpegTerminations().length===0&&pendingOwnedIo().length===0) {
    try{await io.writeExclusive(join(rootDirectory,'proof.json'),JSON.stringify(facts,null,2),'archive')}catch(error){primary??=error}
   }
   // Owner supervises this private evidence tree. Never delete a pending
   // process/IO or pretend that a timed-out write was cancelled.
   if(!primary) {
    assert.ok(performance.now()<hardEnd);assert.equal(pendingOwnedIo().length,0);assert.equal(pendingOwnedFfmpegTerminations().length,0)
   }
   const terminalText=JSON.stringify({kind:'w66-operational-proof',runId,evidenceRoot:rootDirectory,marker:'observed-pending-owner-confirmation',candidateOutcome,
    primary:primary?failureFact(primary):null,cleanupErrors})
   if(!primary)assert.ok(performance.now()<hardEnd)
   console.log(terminalText)
  }
  if(primary)throw primary
 })
