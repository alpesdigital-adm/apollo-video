import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyEditorialCutCommandService,
  compileInitialSourceEditPlan,
} from '../../src/v2/application/apply-editorial-cut-command.ts'
import { createEditorialForkFixture, editorialFixturePhaseStart, traceEditorialFixtureAsync } from './helpers/operational-editorial-fixture.mjs'
import { buildOperationalOutputVersionBundleV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createEditorialCutImpactV2, createEditorialCutInvalidations, parseEditorialCutImpactV2 } from '../../src/v2/domain/editorial-cut-impact.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'

editorialFixturePhaseStart('direct-editorial-file-enter')()

const baseHash = 'a'.repeat(64)

function editorialActor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-1', credentialId: 'credential-editorial-1',
    workspaceId: 'workspace-1', environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext,
  })
}

test('ingest compiles one full-source plan with transcript evidence and no fabricated cut', () => {
  const transcript = createMediaTranscript({
    language: 'pt-BR', text: 'fonte íntegra', provider: 'controlled', model: 'ingest/v1',
    words: [{ word: 'fonte', start: 0.2, end: 0.6 }, { word: 'íntegra', start: 0.7, end: 1.2 }],
    segments: [{ id: 0, text: 'fonte íntegra', start: 0.2, end: 1.2 }],
  })
  const plan = compileInitialSourceEditPlan({
    id: 'edit-plan-ingest-test', projectVersionId: 'version-ingest-test',
    transcriptId: 'transcript-ingest-test', transcript,
    sourceArtifactId: 'artifact-ingest-test', sourceDurationSeconds: 2, fps: 30,
    createdAt: '2026-08-02T18:00:00.000Z',
  })

  assert.equal(plan.editorial.commandType, 'source-ingest')
  assert.deepEqual(plan.editorial.exclusions, [])
  assert.deepEqual(plan.editorial.retainedSourceRanges, [{ sourceStartSeconds: 0, sourceEndSeconds: 2 }])
  assert.equal(plan.videoTracks[0].clips.length, 1)
  assert.equal(plan.videoTracks[0].clips[0].sourceInFrame, 0)
  assert.equal(plan.videoTracks[0].clips[0].sourceOutFrame, 60)
  assert.equal(plan.durationFrames, 60)
  assert.equal(plan.retimedTranscript.sourceTranscriptHash, transcript.transcriptHash)
  assert.deepEqual(plan.subtitleTracks, [], 'No subtitle cue intent means no automatic cue projection')
  assert.equal(Object.hasOwn(plan,'sourceTranscriptCueProjection'),false)
})

function initialCueInput() {
  return {id:'edit-plan-source-cues',projectVersionId:'version-source-cues',transcriptId:'transcript-source-cues',
    transcript:createMediaTranscript({language:'pt-BR',text:'fonte íntegra',provider:'controlled',model:'source-cues/v1',
      words:[{word:'fonte',start:.2,end:.6},{word:'íntegra',start:.7,end:1.2}],
      segments:[{id:0,text:'fonte',start:.2,end:.6},{id:1,text:'íntegra',start:.7,end:1.2}]}),
    sourceArtifactId:'artifact-source-cues',sourceDurationSeconds:2,fps:30,createdAt:'2026-10-14T12:00:00.000Z',
    sourceTranscriptCueIntent:{schemaVersion:'source-transcript-cue-intent/v1',kind:'alignment-only',
      emission:'suppressed-missing-visual-clock-authority',trackId:'track-source-cues',cueIdPrefix:'cue-source-cues'}}
}

test('initial transcript cue intent projects actual segment words at absolute frames without emission authority',()=>{
  const input=initialCueInput(),before=structuredClone(input),plan=compileInitialSourceEditPlan(input),track=plan.subtitleTracks[0]
  assert.equal(track.schemaVersion,'source-transcript-cue-track/v1');assert.equal(track.kind,'captions')
  assert.equal(track.authority,'aligned-source-transcript-only');assert.equal(track.emission,'suppressed-missing-visual-clock-authority')
  assert.equal(track.sourceTranscriptId,input.transcriptId);assert.equal(track.sourceTranscriptHash,input.transcript.transcriptHash)
  assert.deepEqual(plan.sourceTranscriptCueProjection,{schemaVersion:'source-transcript-cue-projection/v1',capability:'aligned-source-word-cues',
    sourceTranscriptId:input.transcriptId,sourceTranscriptHash:input.transcript.transcriptHash,
    emission:'suppressed-missing-visual-clock-authority',status:'available',cueCount:2})
  assert.deepEqual(track.cues,[
    {id:'cue-source-cues-0',startFrame:6,endFrame:18,text:'fonte',clipId:plan.videoTracks[0].clips[0].id,sourceSegmentId:0,sourceWordIndices:[0]},
    {id:'cue-source-cues-1',startFrame:21,endFrame:36,text:'íntegra',clipId:plan.videoTracks[0].clips[0].id,sourceSegmentId:1,sourceWordIndices:[1]},
  ])
  for(const cue of track.cues) {
    const words=cue.sourceWordIndices.map(index=>plan.retimedTranscript.words[index])
    assert.equal(cue.text,words.map(word=>word.text).join(' '))
    assert.equal(cue.startFrame,Math.min(...words.map(word=>word.timelineStartFrame)));assert.equal(cue.endFrame,Math.max(...words.map(word=>word.timelineEndFrame)))
    assert.ok(cue.startFrame>=0&&cue.endFrame<=plan.durationFrames)
    assert.equal(Object.hasOwn(cue,'anchor'),false,'Alignment supplies no face-safe placement')
  }
  for(const field of ['presetId','anchor','faceProtection','qualityReportId','directorRunId'])assert.equal(Object.hasOwn(track,field),false)
  assert.equal(Object.isFrozen(track.cues[0].sourceWordIndices),true);assert.deepEqual(input,before)
  const highFpsInput=initialCueInput();highFpsInput.fps=240
  const highFpsBefore=structuredClone(highFpsInput),withoutIntent={...highFpsInput};delete withoutIntent.sourceTranscriptCueIntent
  const baseline=compileInitialSourceEditPlan(withoutIntent),highFpsPlan=compileInitialSourceEditPlan(highFpsInput)
  assert.equal(highFpsPlan.sourceTranscriptCueProjection.status,'available')
  assert.equal(highFpsPlan.sourceTranscriptCueProjection.cueCount,2)
  assert.deepEqual(highFpsPlan.subtitleTracks[0].cues,[
    {id:'cue-source-cues-0',startFrame:48,endFrame:144,text:'fonte',clipId:highFpsPlan.videoTracks[0].clips[0].id,sourceSegmentId:0,sourceWordIndices:[0]},
    {id:'cue-source-cues-1',startFrame:168,endFrame:288,text:'íntegra',clipId:highFpsPlan.videoTracks[0].clips[0].id,sourceSegmentId:1,sourceWordIndices:[1]},
  ])
  assert.equal(highFpsPlan.durationFrames,480)
  for(const field of ['sources','videoTracks','durationFrames','fps','retimedTranscript','editorial'])assert.deepEqual(highFpsPlan[field],baseline[field])
  assert.equal(highFpsPlan.retimedTranscript.sourceTranscriptHash,highFpsInput.transcript.transcriptHash)
  assert.equal(highFpsPlan.sourceTranscriptCueProjection.emission,'suppressed-missing-visual-clock-authority')
  assert.deepEqual(highFpsInput,highFpsBefore)
})

test('initial transcript cue intent refuses corrupt intent seals and transcript contract data',()=>{
  const invalidInput=mutate=>{const input=structuredClone(initialCueInput());mutate(input);return input}
  for(const [label,mutate] of [
    ['schema',i=>{i.sourceTranscriptCueIntent.schemaVersion='source-transcript-cue-intent/v0'}],
    ['kind',i=>{i.sourceTranscriptCueIntent.kind='burn-in'}],
    ['emission',i=>{i.sourceTranscriptCueIntent.emission='ready'}],
    ['unknown field',i=>{i.sourceTranscriptCueIntent.approved=true}],
    ['null intent',i=>{i.sourceTranscriptCueIntent=null}],
    ['invalid id',i=>{i.sourceTranscriptCueIntent.trackId='unsafe/id'}],
    ['non-string id',i=>{i.sourceTranscriptCueIntent.trackId=123}],
    ['source identity collision',i=>{i.sourceTranscriptCueIntent.trackId=i.sourceArtifactId}],
    ['clip track collision',i=>{i.sourceTranscriptCueIntent.trackId='track-primary-video'}],
    ['cue track collision',i=>{i.sourceTranscriptCueIntent.trackId='cue-source-cues-0'}],
    ['oversized cue prefix',i=>{i.sourceTranscriptCueIntent.cueIdPrefix='a'.repeat(97)}],
    ['transcript seal',i=>{i.transcript.transcriptHash='0'.repeat(64)}],
    ['absent words with stale seal',i=>{i.transcript.words=[]}],
    ['contradictory timing seal',i=>{i.transcript.words[0].start=.3}],
    ['frame rate',i=>{i.fps=0}],
  ])assert.throws(()=>compileInitialSourceEditPlan(invalidInput(mutate)),e=>e.code==='INVALID_COMMAND',label)
  let getterCalls=0
  const accessor=initialCueInput();Object.defineProperty(accessor.sourceTranscriptCueIntent,'kind',{
    enumerable:true,get(){getterCalls++;throw new Error('intent getter must not execute')}})
  assert.throws(()=>compileInitialSourceEditPlan(accessor),e=>e.code==='INVALID_COMMAND');assert.equal(getterCalls,0)
  const hidden=initialCueInput();Object.defineProperty(hidden.sourceTranscriptCueIntent,'hidden',{value:true})
  assert.throws(()=>compileInitialSourceEditPlan(hidden),e=>e.code==='INVALID_COMMAND')
  for(const mutate of [i=>{i.transcript.words[0].start=-1},i=>{i.transcript.words[0].end=.1},i=>{i.transcript.segments[0].end=-1}]) {
    const input=structuredClone(initialCueInput());mutate(input)
    assert.throws(()=>compileInitialSourceEditPlan(input),e=>e.code==='INVALID_ARGUMENT')
  }
})

test('initial transcript cue capability suppresses valid unavailable alignment while preserving the complete source plan',()=>{
  for(const [label,reason,words,segments,fps=30] of [
    ['segment only','word-alignment-unavailable',[],[{id:0,text:'word',start:0,end:2}]],
    ['words without segments','segment-alignment-unavailable',[{word:'word',start:.2,end:.6}],[]],
    ['word outside segment','source-coverage-unavailable',[{word:'word',start:.2,end:.6}],[{id:0,text:'word',start:.2,end:.5}]],
    ['legitimate overlapping segments','segment-partition-unsupported',[{word:'word',start:.2,end:.6}],[{id:0,text:'word',start:0,end:1},{id:1,text:'word',start:.5,end:1.2}]],
    ['legitimate zero-duration segment','segment-partition-unsupported',[{word:'word',start:.2,end:.6}],[{id:0,text:'word',start:0,end:0},{id:1,text:'word',start:.1,end:1.2}]],
    ['segment identity not representable','segment-identity-unsupported',[{word:'word',start:.2,end:.6}],[{id:Number.MAX_SAFE_INTEGER+1,text:'word',start:0,end:1}]],
    ['alignment outside observed source','source-coverage-unavailable',[{word:'word',start:1,end:2.5}],[{id:0,text:'word',start:1,end:2.5}]],
    ['legitimate zero-duration word','word-frame-coverage-unavailable',[{word:'word',start:1,end:1}],[{id:0,text:'word',start:0,end:2}]],
    ['word cannot fit terminal frame','word-frame-coverage-unavailable',[{word:'word',start:1.999,end:2}],[{id:0,text:'word',start:0,end:2}]],
  ]) {
    const input=initialCueInput();input.fps=fps
    input.transcript=createMediaTranscript({language:'pt-BR',text:'word',provider:'controlled',model:'source-cues/v1',words,segments})
    const before=structuredClone(input),withoutIntent={...input};delete withoutIntent.sourceTranscriptCueIntent
    const baseline=compileInitialSourceEditPlan(withoutIntent),plan=compileInitialSourceEditPlan(input)
    assert.deepEqual(plan.subtitleTracks,[],label)
    assert.deepEqual(plan.sourceTranscriptCueProjection,{schemaVersion:'source-transcript-cue-projection/v1',capability:'aligned-source-word-cues',
      sourceTranscriptId:input.transcriptId,sourceTranscriptHash:input.transcript.transcriptHash,
      emission:'suppressed-missing-visual-clock-authority',status:'unavailable',reasons:[reason]},label)
    for(const field of ['sources','videoTracks','durationFrames','fps','retimedTranscript','editorial'])assert.deepEqual(plan[field],baseline[field],label)
    assert.deepEqual(input,before,label)
  }
})

test('initial transcript cue capability preserves legitimate overlapping word order and absolute frame bounds',()=>{
  const input=initialCueInput();input.transcript=createMediaTranscript({language:'pt-BR',text:'fonte íntegra',provider:'controlled',model:'source-cues/v1',
    words:[{word:'fonte',start:.2,end:.8},{word:'íntegra',start:.16,end:1.2}],segments:[{id:0,text:'fonte íntegra',start:0,end:1.2}]})
  const plan=compileInitialSourceEditPlan(input),cue=plan.subtitleTracks[0].cues[0]
  assert.equal(plan.sourceTranscriptCueProjection.status,'available');assert.equal(cue.text,'fonte íntegra')
  assert.deepEqual(cue.sourceWordIndices,[0,1]);assert.equal(cue.startFrame,5);assert.equal(cue.endFrame,36)
  assert.equal(plan.retimedTranscript.sourceTranscriptHash,input.transcript.transcriptHash)
  assert.equal(plan.videoTracks[0].clips[0].sourceInFrame,0);assert.equal(plan.videoTracks[0].clips[0].sourceOutFrame,60)
  assert.equal(plan.sourceTranscriptCueProjection.emission,'suppressed-missing-visual-clock-authority')
})

function alignedTranscript() {
  return createMediaTranscript({
    language: 'pt-BR',
    text: 'abertura 31 de janeiro e 1 de fevereiro conteúdo 31 de janeiro e 1 de fevereiro final dois dias encerramento',
    words: [
      { word: 'abertura', start: 0, end: .6 },
      { word: '31', start: 39.2, end: 39.4 }, { word: 'de', start: 39.4, end: 39.55 }, { word: 'janeiro', start: 39.55, end: 39.9 },
      { word: 'e', start: 40, end: 40.1 }, { word: '1', start: 40.1, end: 40.25 }, { word: 'de', start: 40.25, end: 40.4 }, { word: 'fevereiro', start: 40.4, end: 40.8 },
      { word: 'conteúdo', start: 43, end: 43.5 },
      { word: '31', start: 55, end: 55.2 }, { word: 'de', start: 55.2, end: 55.35 }, { word: 'janeiro', start: 55.35, end: 55.7 },
      { word: 'e', start: 55.8, end: 55.9 }, { word: '1º', start: 55.9, end: 56.1 }, { word: 'de', start: 56.1, end: 56.25 }, { word: 'fevereiro', start: 56.25, end: 56.7 },
      { word: 'final', start: 58, end: 58.3 }, { word: 'dois', start: 84, end: 84.2 }, { word: 'dias', start: 84.2, end: 84.5 },
      { word: 'encerramento', start: 90.2, end: 90.8 },
    ],
    segments: [
      { id: 0, start: 0, end: .7, text: 'abertura' },
      { id: 1, start: 39.02, end: 42.68, text: '31 de janeiro e 1 de fevereiro' },
      { id: 2, start: 43, end: 43.6, text: 'conteúdo' },
      { id: 3, start: 54.82, end: 57.72, text: '31 de janeiro e 1 de fevereiro' },
      { id: 4, start: 58, end: 58.4, text: 'final' },
      { id: 5, start: 83.24, end: 89.979996, text: 'em apenas dois dias' },
      { id: 6, start: 90.2, end: 90.9, text: 'encerramento' },
    ],
    provider: 'groq',
    model: 'whisper-large-v3',
  })
}

class InMemoryEditorialCommandRepository {
  constructor(world) {
    this.initialContext=world.context;this.currentVersion=world.fork.version;this.parent=world.fork.bundle
    this.transcript=world.prepared.transcript;this.records=new Map();this.lastBundle=undefined
    const members=world.fork.bundle.state.document.entries
    // Untrusted isolated output-reference data exercises impact/invalidation
    // projection. Actual PG membership/final admission is independently gated.
    this.outputReferences=[
      {artifactId:'artifact-proxy-1',kind:'proxy',sourceVersionId:this.currentVersion.id,variantId:members[0].variantId},
      {artifactId:'artifact-final-1',kind:'final',sourceVersionId:this.currentVersion.id,variantId:members[1].variantId},
    ]
  }
  async findIdempotentResult({workspaceId,projectId,idempotencyKey}) {return this.records.get(workspaceId+':'+projectId+':'+idempotencyKey)??null}
  async readContext({workspaceId,projectId,transcriptId,variantId}) {
    if(workspaceId!=='workspace-1'||projectId!=='project-1'||transcriptId!==this.initialContext.transcriptId)return null
    return {...this.initialContext,parent:this.parent,currentVersion:this.currentVersion,variantId,outputReferences:this.outputReferences}
  }
  async commitOrReplay(input) {
    this.lastBundle=input
    const bundle=buildOperationalOutputVersionBundleV3(input.proposal),editPlan=JSON.parse(bundle.editPlanSnapshot.contentJson)
    const result={command:input.command,version:bundle.version,editPlan,exclusions:editPlan.editorial.exclusions,retainedSourceRanges:editPlan.editorial.retainedSourceRanges,
      impact:input.command.payload.impact,invalidations:createEditorialCutInvalidations({impact:input.command.payload.impact,createdAt:input.command.createdAt}),outputBundle:bundle,replayed:false}
    this.records.set(input.command.workspaceId+':'+input.command.projectId+':'+input.command.idempotencyKey,{requestFingerprint:input.requestFingerprint,result})
    this.currentVersion=bundle.version;this.parent=bundle
    return result
  }
}

function recoveryRules() {
  return [
    { id: 'date-january-31', label: '31 de janeiro', alternatives: ['31 de janeiro', 'trinta e um de janeiro'] },
    { id: 'date-february-1', label: '1 de fevereiro', alternatives: ['1 de fevereiro', 'primeiro de fevereiro'] },
    { id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] },
  ]
}

// Six cases share only this fixed, fully immutable domain source/fork setup.
// Constructor object identities are preserved; no JSON clone, hash authority,
// application cache or mutable repository/head/allocator crosses a case.
function freezeSharedEditorialWorld(value,seen=new WeakSet()) {
  if(value===null||typeof value!=='object')return value
  assert.ok(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null,
    'Shared fixture contains only its own data objects and arrays')
  if(seen.has(value))return value
  seen.add(value)
  for(const key of Reflect.ownKeys(value)) {
    assert.equal(typeof key,'string','Shared fixture has no symbol authority')
    const descriptor=Object.getOwnPropertyDescriptor(value,key)
    assert.ok(Object.hasOwn(descriptor,'value'),'Shared fixture never evaluates an accessor')
    freezeSharedEditorialWorld(descriptor.value,seen)
  }
  return Object.freeze(value)
}
let sharedEditorialWorldPromise
function sharedEditorialWorld() {
  return sharedEditorialWorldPromise??=createEditorialForkFixture({actor:editorialActor(),transcript:alignedTranscript(),sourceDurationSeconds:102.166,fps:30.000000097})
    .then(world=>freezeSharedEditorialWorld(world))
}
async function fixture() {
  const world=await sharedEditorialWorld()
  const repository = new InMemoryEditorialCommandRepository(world)
  const counters = new Map()
  let event = 0
  const service = applyEditorialCutCommandService({
    repository,
    clock: () => new Date('2026-07-18T21:00:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-editorial-command-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
  })
  return { repository, service, request:(overrides={})=>request({baseHash:world.fork.version.baseHash,variantId:world.context.variantId,sourceTranscriptId:world.context.transcriptId,...overrides}) }
}

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'project-version-1', baseHash,
    sourceTranscriptId: 'transcript-1', rules: recoveryRules(),
    reason: 'Remover datas e duração que não pertencem à nova composição.',
    actor: editorialActor(),
    idempotency: { clientId: 'client-1', key: 'remove-dates-v1' },
    ...overrides,
  }
}

test('typed editorial Command creates an immutable retimed EditPlan without automatic zoom', async () => {
  const finishCase=editorialFixturePhaseStart('case-typed-editorial')
  try {
  const { repository, service, request } = await traceEditorialFixtureAsync('case-fixture',()=>fixture())
  const result = await traceEditorialFixtureAsync('case-service',()=>service(request()))

  assert.equal(result.replayed, false)
  assert.notEqual(result.version.id,repository.initialContext.currentVersion.id,'Fresh child identity precedes the new State seal')
  assert.notEqual(result.outputBundle.state.document.id,repository.initialContext.parent.state.document.id)
  const another=await fixture()
  assert.strictEqual(another.repository.initialContext,repository.initialContext,'Only the deeply immutable fixed source is shared')
  assert.notEqual(another.repository,repository);assert.notEqual(another.repository.records,repository.records)
  assert.notEqual(another.repository.outputReferences,repository.outputReferences)
  assert.equal(another.repository.records.size,0);assert.equal(another.repository.lastBundle,undefined)
  assert.strictEqual(another.repository.parent,repository.initialContext.parent)
  assert.strictEqual(another.repository.currentVersion,repository.initialContext.currentVersion)
  another.repository.outputReferences=[]
  assert.equal(repository.outputReferences.length,2,'Changing another case output list cannot affect this case')
  const sharedWorld=await sharedEditorialWorld(),sourceFrame=sharedWorld.prepared.n.document.sourceProbe.frames[0]
  assert.equal(Object.isFrozen(sharedWorld),true);assert.equal(Object.isFrozen(sharedWorld.context.sourceBindingFacts.inventory),true)
  assert.equal(Object.isFrozen(sharedWorld.context.sourceBindingFacts.inventory[0]),true)
  assert.equal(Object.isFrozen(sourceFrame),true)
  const originalPts=sourceFrame.pts,originalRole=sharedWorld.context.sourceBindingFacts.inventory[0].role
  assert.throws(()=>{sourceFrame.pts='tampered'},TypeError)
  assert.throws(()=>{sharedWorld.context.sourceBindingFacts.inventory[0].role='tampered'},TypeError)
  assert.equal(sourceFrame.pts,originalPts);assert.equal(sharedWorld.context.sourceBindingFacts.inventory[0].role,originalRole)
  const independentFrame=structuredClone(sourceFrame);independentFrame.pts='independent-clone'
  assert.equal(sourceFrame.pts,originalPts,'An ordinary mutable clone cannot change the shared observation')
  assert.equal(repository.initialContext.currentDurationFrames,3064,'Actual source compiler frames, never the old fictitious 3065')
  assert.equal(repository.initialContext.normalizations[0].document.sourceProbe.frames.length,3065,'Explicit native probe coverage at 30/1')
  assert.equal(repository.initialContext.sourceFps,30.000000097,'Requested timeline clock stays distinct from native packet clock')
  assert.equal(result.version.outputContractVersion,3)
  assert.equal(result.outputBundle.state.document.transition,'editorial-cut')
  assert.equal(result.command.type, 'remove-spoken-content')
  assert.equal(result.version.sequence, 2)
  assert.equal(result.version.parentVersionId, 'project-version-1')
  assert.equal(result.version.commandId, result.command.id)
  assert.equal(result.editPlan.videoTracks[0].clips.length, 4)
  assert.equal(result.editPlan.durationFrames, 2662)
  assert.equal(result.editPlan.movementPolicy.automaticZoom, false)
  assert.equal(result.editPlan.movementPolicy.protectedOpeningFrames, 120)
  assert.equal(Number.isInteger(result.editPlan.movementPolicy.protectedOpeningFrames), true)
  assert.equal(result.editPlan.subtitlePolicy.faceProtection, true)
  assert.deepEqual(result.exclusions.map(({ sourceStartSeconds, sourceEndSeconds }) => ({ sourceStartSeconds, sourceEndSeconds })), [
    { sourceStartSeconds: 39.02, sourceEndSeconds: 42.68 },
    { sourceStartSeconds: 54.82, sourceEndSeconds: 57.72 },
    { sourceStartSeconds: 83.24, sourceEndSeconds: 89.979996 },
  ])
  const retimedText = result.editPlan.retimedTranscript.words.map((word) => word.text).join(' ').toLowerCase()
  assert.equal(retimedText.includes('janeiro'), false)
  assert.equal(retimedText.includes('fevereiro'), false)
  assert.equal(retimedText.includes('dois dias'), false)
  assert.equal(repository.lastBundle.snapshot.kind, 'edit-plan')
  assert.equal(repository.lastBundle.event.type, 'project.version.created')
  assert.equal(result.command.payload.schemaVersion, 3)
  assert.equal(result.impact.schemaVersion, 'editorial-cut-impact/v2')
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 3064 }])
  assert.deepEqual(result.impact.affectedVariantIds, repository.initialContext.parent.state.document.entries.map(e=>e.variantId).sort())
  assert.deepEqual(result.impact.dependencyTypes, ['audio', 'content', 'timing', 'visual'])
  assert.equal(result.impact.minimalRenders.length, 1)
  assert.equal(result.invalidations.length, 2)
  assert.equal(result.invalidations.every((item) => item.status === 'stale'), true)
  assert.equal(repository.lastBundle.event.data.commandImpactHash, result.impact.impactHash)
  assert.deepEqual(
    parseEditorialCutImpactV2(JSON.parse(stableSerialize(result.impact))),
    result.impact,
  )
  const tampered = structuredClone(result.impact)
  tampered.affectedRanges[0].endFrame -= 1
  assert.throws(
    () => parseEditorialCutImpactV2(tampered),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  } finally {finishCase()}
})

test('editorial Command still declares the required full proxy when the base has no completed output', async () => {
  const { repository, service, request } = await fixture()
  repository.outputReferences = []
  const result = await service(request())
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.impact.affectedVariantIds, repository.initialContext.parent.state.document.entries.map(e=>e.variantId).sort())
  assert.deepEqual(result.impact.minimalRenders, [{
    kind: 'proxy', variantId: repository.initialContext.variantId, ranges: [{ startFrame: 0, endFrame: 2662 }],
  }])
  assert.deepEqual(result.invalidations, [])
})

test('editorial Command replays exactly and rejects reuse with a different payload', async () => {
  const { service, request } = await fixture()
  const first = await service(request())
  const replay = await service(request())
  assert.equal(replay.replayed, true)
  assert.equal(replay.command.id, first.command.id)
  assert.equal(replay.version.id, first.version.id)

  await assert.rejects(
    () => service(request({ rules: recoveryRules().slice(0, 2) })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('editorial Command rejects stale versions and rules absent from aligned source', async () => {
  const { service, request } = await fixture()
  await assert.rejects(
    () => service(request({ baseHash: 'b'.repeat(64) })),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
  await assert.rejects(
    () => service(request({
      idempotency: { clientId: 'client-1', key: 'missing-phrase' },
      rules: [{ id: 'date-march-2', label: '2 de março', alternatives: ['2 de março'] }],
    })),
    (error) => error instanceof DomainError && error.code === 'INVALID_COMMAND' && error.details.missingRuleIds.includes('date-march-2'),
  )
})

test('editorial Command compiles exact reviewed exclusion overrides instead of whole transcript segments', async () => {
  const { service, request } = await fixture()
  const result = await service(request({
    idempotency: { clientId: 'client-1', key: 'reviewed-exclusions-v1' },
    exclusionOverrides: [
      {
        sourceStartSeconds: 38.5,
        sourceEndSeconds: 58,
        ruleIds: ['date-january-31', 'date-february-1'],
        reason: 'Reviewed boundary preserves the sentence before and after both date mentions.',
      },
      {
        sourceStartSeconds: 83,
        sourceEndSeconds: 85,
        ruleIds: ['duration-two-days'],
        reason: 'Reviewed boundary removes only the duration claim.',
      },
    ],
  }))

  assert.deepEqual(result.retainedSourceRanges, [
    { sourceStartSeconds: 0, sourceEndSeconds: 38.5 },
    { sourceStartSeconds: 58, sourceEndSeconds: 83 },
    { sourceStartSeconds: 85, sourceEndSeconds: 102.166 },
  ])
  assert.equal(result.editPlan.videoTracks[0].clips.length, 3)
  assert.equal(result.editPlan.durationFrames, 2417)
  assert.equal(result.editPlan.movementPolicy.automaticZoom, false)
  assert.deepEqual(result.command.payload.exclusionOverrides, [
    {
      sourceStartSeconds: 38.5,
      sourceEndSeconds: 58,
      ruleIds: ['date-january-31', 'date-february-1'],
      reason: 'Reviewed boundary preserves the sentence before and after both date mentions.',
    },
    {
      sourceStartSeconds: 83,
      sourceEndSeconds: 85,
      ruleIds: ['duration-two-days'],
      reason: 'Reviewed boundary removes only the duration claim.',
    },
  ])
})

test('editorial Command rejects reviewed overrides that leave a detected occurrence behind', async () => {
  const { service, request } = await fixture()
  await assert.rejects(
    () => service(request({
      idempotency: { clientId: 'client-1', key: 'incomplete-reviewed-exclusions-v1' },
      exclusionOverrides: [
        {
          sourceStartSeconds: 38.5,
          sourceEndSeconds: 43,
          ruleIds: ['date-january-31', 'date-february-1'],
          reason: 'This deliberately misses the second date occurrence.',
        },
        {
          sourceStartSeconds: 83,
          sourceEndSeconds: 85,
          ruleIds: ['duration-two-days'],
          reason: 'Duration claim.',
        },
      ],
    })),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT' &&
      error.message === 'Editorial exclusion overrides must cover every detected phrase',
  )
})


test('editorial impact2 uses canonical ASCII output membership for mixed IDs independent of input order',()=>{
 const references=[{artifactId:'artifact_A',kind:'proxy',sourceVersionId:'version-base',variantId:'variant-one'},
  {artifactId:'artifact-a',kind:'proxy',sourceVersionId:'version-base',variantId:'variant-two'},
  {artifactId:'artifact.z',kind:'proxy',sourceVersionId:'version-base',variantId:'variant-one'}]
 const input={commandId:'command-cut',baseVersionId:'version-base',resultVersionId:'version-result',sourceTranscriptId:'transcript-source',sourceTranscriptHash:'a'.repeat(64),
  affectedEndFrame:60,renderEndFrame:30,proxyVariantId:'variant-one',variantIds:['variant-two','variant-one'],outputReferences:references}
 const first=createEditorialCutImpactV2(input),reversed=createEditorialCutImpactV2({...input,outputReferences:[...references].reverse()})
 assert.deepEqual(first.affectedArtifacts.map(a=>a.artifactId),['artifact-a','artifact.z','artifact_A'])
 assert.deepEqual(first,reversed);assert.deepEqual(parseEditorialCutImpactV2(first),first)
 const tampered=structuredClone(first);tampered.affectedArtifacts.reverse()
 assert.throws(()=>parseEditorialCutImpactV2(tampered),e=>e.code==='PERSISTENCE_CONFLICT')
})
