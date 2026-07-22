import test from'node:test';import assert from'node:assert/strict';import{PATCH_OPERATION_KINDS,applyPatchAsVersion,buildRenderElementMap,compileBatchReview,controlPreview,createReviewAnnotation,hitTestRenderElements,interpretReviewAnnotation,materializePatchEditPlan,previewMetrics,proposePatchFromAnnotation,resolveReviewScope,validatePatchOperation,validateRenderElementMap}from'../../src/v2/domain/review-system.ts'
const annotation=(overrides={})=>createReviewAnnotation({id:'a1',projectVersionId:'v1',frame:30,timeRangeMs:[1000,1000],screenshotRef:'shot',region:{x:.1,y:.2,width:.3,height:.2},targetIds:['el1'],applicationScope:{kind:'region',targetIds:['el1'],formatIds:['9:16'],localeIds:['pt-BR'],recipeIds:[],global:false},affectedCount:1,text:'Mover para cima',author:{id:'u1',name:'Ana'},status:'open',createdAt:'2026-01-01T00:00:00Z',...overrides})
test('T-FR-210 controls active proxy by frame/time and exposes identity, stale state and performance p95',()=>{let session={projectVersionId:'v1',proxyUrl:'/p.mp4',proxyHash:'hash',fps:30,resolution:{width:1080,height:1920},stale:false,frame:0,playing:false};session=controlPreview(session,{type:'play'});session=controlPreview(session,{type:'seek-time',value:2});assert.equal(session.frame,60);assert.equal(session.playing,true);assert.deepEqual(previewMetrics({firstFrameMs:100,seekMs:[20,30,80,40],renderedFrames:100,droppedFrames:2}),{firstFrameMs:100,seekP95Ms:80,droppedFrameRate:.02})})
test('T-FR-211 creates point, region and scene annotations without mutating ProjectVersion',()=>{const point=annotation({region:undefined,targetIds:[]});const region=annotation();const scene=annotation({targetIds:['scene-1'],region:undefined});assert.equal(point.projectVersionId,'v1');assert.equal(region.region.width,.3);assert.deepEqual(scene.targetIds,['scene-1']);assert.equal(point.status,'open')})
test('T-FR-212 resolves all nine review scopes deterministically, defaults to the current variant and confirms global expansion',()=>{const input={current:{targetId:'scene:1',formatId:'9:16',localeId:'pt-BR',recipeId:'recipe-1'},availableCounts:{frame:120,region:1,clip:2,scene:3,range:1,project:1,formats:5,locales:2,recipes:3}};for(const kind of['frame','region','clip','scene','range','project','formats','locales','recipes']){const local=resolveReviewScope({...input,requested:{kind}});assert.deepEqual(local.scope.targetIds,['scene:1']);assert.deepEqual(local.scope.formatIds,['9:16']);assert.deepEqual(local.scope.localeIds,['pt-BR']);assert.deepEqual(local.scope.recipeIds,['recipe-1']);assert.equal(local.affectedCount,1)}assert.throws(()=>resolveReviewScope({...input,requested:{kind:'formats',global:true}}),(error)=>error?.code==='PRECONDITION_REQUIRED');const global=resolveReviewScope({...input,requested:{kind:'formats',global:true,formatIds:['9:16','1:1']},confirmedGlobal:true});assert.equal(global.affectedCount,5);assert.deepEqual(global.scope.formatIds,['9:16','1:1']);assert.equal(global.confirmationRequired,true)})
test('T-FR-213 emits and hit-tests overlapping render layers by transparency, priority and resized canvas',()=>{
  const hash='a'.repeat(64)
  const map=buildRenderElementMap({proxyHash:hash,fps:30,durationFrames:60,canvas:{width:1000,height:1000},source:{width:1000,height:1000},clips:[{id:'clip-1',sourceArtifactId:'source-1',timelineInFrame:0,timelineOutFrame:60}],subtitleCues:[{id:'cue-1',startFrame:0,endFrame:60,text:'Legenda segura'}]})
  assert.equal(validateRenderElementMap(map,hash).proxyHash,hash)
  const hit=hitTestRenderElements(map,{frame:1,x:100,y:180,displayWidth:200,displayHeight:200})
  assert.equal(hit.selected.elementId,'subtitle:cue-1')
  assert.equal(hit.chooserRequired,true)
  assert.deepEqual(hit.candidates.map((item)=>item.type),['subtitle','presenter','background'])
  const transparent={...map,elements:map.elements.map((item)=>item.type==='subtitle'?{...item,opacity:0}:item)}
  assert.equal(hitTestRenderElements(transparent,{frame:1,x:100,y:180,displayWidth:200,displayHeight:200}).selected.type,'presenter')
  assert.throws(()=>validateRenderElementMap(map,'b'.repeat(64)),(error)=>error?.code==='VERSION_CONFLICT')
})
test('T-FR-214 allowlists six typed operations and rejects free mutation payloads',()=>{
  assert.deepEqual(PATCH_OPERATION_KINDS,['trim','replace-asset','update-text','update-layout','update-subtitle','move'])
  const operations=[
    {op:'trim',targetId:'clip-1',value:{mode:'remove-range'},rangeMs:[100,200]},
    {op:'replace-asset',targetId:'clip-1',value:{assetId:'asset-2'}},
    {op:'update-text',targetId:'subtitle:cue-1',value:{text:'Texto'}},
    {op:'update-layout',targetId:'subtitle:cue-1',value:{anchor:'bottom',faceProtection:true}},
    {op:'update-subtitle',targetId:'subtitle:cue-1',value:{text:'Legenda'}},
    {op:'move',targetId:'clip-1',value:{afterTargetId:'clip-2'}},
  ]
  operations.forEach((operation)=>assert.equal(validatePatchOperation(operation).op,operation.op))
  assert.throws(()=>validatePatchOperation({op:'update-layout',targetId:'el1',value:{arbitraryCss:'display:none'}}),(error)=>error?.code==='INVALID_ARGUMENT')
})
test('T-FR-214 proposes impact through ambiguity, protected, policy and budget gates before materializing an immutable EditPlan',()=>{
  const ann=annotation({targetIds:['subtitle:cue-1'],text:'Reposicionar a legenda abaixo do rosto.'})
  const operation=interpretReviewAnnotation(ann)[0]
  const ready=proposePatchFromAnnotation({annotation:ann,baseVersionId:'v1',interpretations:[operation],protectedTargetIds:[],policyAllowedOps:['update-layout'],budgetRemaining:2,estimatedCost:1})
  assert.equal(ready.status,'ready');assert.equal(ready.impact.cost,1);assert.equal(ready.gates.length,4);assert.ok(ready.gates.every((gate)=>gate.passed))
  const plan={schemaVersion:2,state:'compiled',id:'plan-v1',projectVersionId:'v1',fps:30,durationFrames:60,videoTracks:[{id:'base',kind:'base-video',clips:[{id:'clip-1',sourceArtifactId:'asset-1',sourceInFrame:0,sourceOutFrame:60,timelineInFrame:0,timelineOutFrame:60,rate:1}]}],subtitleTracks:[{id:'captions',kind:'captions',anchor:'center',faceProtection:true,cues:[{id:'cue-1',startFrame:0,endFrame:60,text:'Legenda',anchor:'center'}]}],protectedElements:[],composition:{foregroundScale:1,verticalPosition:.5}}
  const patched=materializePatchEditPlan({editPlan:plan,patch:ready.patch,newVersionId:'v2',createdAt:'2026-01-02T00:00:00Z'})
  assert.equal(patched.projectVersionId,'v2');assert.equal(patched.subtitleTracks[0].cues[0].anchor,'bottom');assert.equal(plan.subtitleTracks[0].cues[0].anchor,'center')
  assert.equal(applyPatchAsVersion({patch:ready.patch,currentVersionId:'v1',renderSucceeded:true}).status,'applied')
  assert.equal(applyPatchAsVersion({patch:ready.patch,currentVersionId:'v1',renderSucceeded:false}).status,'render-failed')
  const ambiguous=proposePatchFromAnnotation({annotation:ann,baseVersionId:'v1',interpretations:[operation,{...operation,targetId:'subtitle:cue-2'}],protectedTargetIds:[],policyAllowedOps:['update-layout'],budgetRemaining:2,estimatedCost:1})
  assert.equal(ambiguous.status,'ambiguous');assert.equal(ambiguous.gates[0].passed,false)
  const prohibited=proposePatchFromAnnotation({annotation:ann,baseVersionId:'v1',interpretations:[operation],protectedTargetIds:['subtitle:cue-1'],policyAllowedOps:['update-layout'],budgetRemaining:2,estimatedCost:1})
  assert.equal(prohibited.status,'prohibited');assert.equal(prohibited.gates.find((gate)=>gate.gate==='protected-elements').code,'PROTECTED_TARGET')
  const policy=proposePatchFromAnnotation({annotation:ann,baseVersionId:'v1',interpretations:[operation],protectedTargetIds:[],policyAllowedOps:['trim'],budgetRemaining:2,estimatedCost:1})
  assert.equal(policy.status,'prohibited');assert.equal(policy.gates.find((gate)=>gate.gate==='policy').code,'POLICY_DENIED')
  const budget=proposePatchFromAnnotation({annotation:ann,baseVersionId:'v1',interpretations:[operation],protectedTargetIds:[],policyAllowedOps:['update-layout'],budgetRemaining:0,estimatedCost:1})
  assert.equal(budget.status,'budget-blocked');assert.equal(budget.gates.find((gate)=>gate.gate==='budget').code,'BUDGET_EXCEEDED')
})
test('T-FR-215 batches compatible annotations atomically and reports conflict/rollback or explicit partial retry',()=>{const a=annotation(),b=annotation({id:'a2'});const op={op:'update-text',targetId:'el1',value:{text:'A'}};const compatible=compileBatchReview({annotations:[a,b],proposals:[{annotationId:'a1',operation:op},{annotationId:'a2',operation:op}],baseVersionId:'v1'});assert.equal(compatible.status,'ready');assert.equal(compatible.patch.operations.length,2);const conflictInput={annotations:[a,b],proposals:[{annotationId:'a1',operation:op},{annotationId:'a2',operation:{...op,value:{text:'B'}}}],baseVersionId:'v1'};assert.equal(compileBatchReview(conflictInput).status,'conflict');assert.equal(compileBatchReview({...conflictInput,mode:'partial-retry'}).status,'partial')})
