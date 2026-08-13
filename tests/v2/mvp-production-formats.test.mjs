import test from 'node:test'
import assert from 'node:assert/strict'
import { cancelDirectorBudget, concludeDirectorRun, createDirectorBudget, reserveAtomically, reserveDirectorBudget, settleDirectorBudget } from '../../src/v2/domain/director-budget.ts'
import { createEditorialAudioTimelineHash, planTalkingHead, planVisualMontage, TALKING_HEAD_POLICY, TALKING_HEAD_TIMING_GOLDENS, validateProductionCoverage } from '../../src/v2/domain/production-modes.ts'
import { critiqueOutputVariant, createReframePlan, customizeOutputPreset, REFRAME_GOLDEN_FIXTURES, RESPONSIVE_VISUAL_GOLDENS, solveResponsivePlacement, VERSIONED_OUTPUT_PRESETS } from '../../src/v2/domain/responsive-output.ts'

const usage = (value = 0) => ({ cost: value, timeMs: value, tokens: value, generations: value, candidates: value, criticRounds: value })
test('T-FR-066 reserves Director budget atomically and handles overrun, cancel and exhaustion recovery', async () => { const initial = createDirectorBudget('run', usage(10)); const store = { state: initial, async read(){return this.state}, async compareAndSwap(_id, revision, next){if(this.state.revision!==revision)return false;this.state=next;return true} }; const reserved = await reserveAtomically(store, 'run', usage(3)); assert.equal(reserved.reserved.cost, 3); const overrun = settleDirectorBudget(reserved, usage(3), usage(11)); assert.equal(overrun.status, 'budget_exhausted'); assert.equal(concludeDirectorRun(overrun, [{ valid: true, score: .8 }]).status, 'completed-with-best-valid'); assert.equal(cancelDirectorBudget(reserved).reserved.cost, 0); assert.equal(reserveDirectorBudget(initial, usage(11)).status, 'budget_exhausted') })
test('T-FR-090 talking head removes only evidenced silence/retakes with 120ms handles and preserves the selected take', () => {
  const plan = planTalkingHead({ durationMs: 20_000, sourceVideoId: 'video-main', sourceAudioId: 'audio-main', silences: [{ startMs: 2_000, endMs: 2_400, evidenceId: 'short-pause' }, { startMs: 4_000, endMs: 4_800, evidenceId: 'silence-long' }], retakes: [{ id: 'retake-hook', ranges: [{ startMs: 8_000, endMs: 9_000 }, { startMs: 9_500, endMs: 10_500 }], selectedIndex: 1 }] })
  assert.equal(TALKING_HEAD_POLICY.handleMs, 120)
  assert.equal(plan.sourceVideoId, 'video-main')
  assert.equal(TALKING_HEAD_POLICY.minimumSilenceMs, 500)
  assert.deepEqual(plan.cuts, [
    { startMs: 4_120, endMs: 4_680, kind: 'silence', evidenceId: 'silence-long', handleMs: 120 },
    { startMs: 8_120, endMs: 8_880, kind: 'retake', evidenceId: 'retake-hook:take-1', handleMs: 120 },
  ])
  assert.equal(plan.durationMs, 18_680)
  assert.equal(plan.cuts.some((cut) => cut.evidenceId.endsWith('take-2')), false)
  assert.match(plan.planHash, /^[a-f0-9]{64}$/)
  assert.throws(() => planTalkingHead({ durationMs: 5_000, sourceVideoId: 'video-main', sourceAudioId: 'audio-main', silences: [{ startMs: 1_000, endMs: 2_000 }, { startMs: 1_500, endMs: 2_500 }], retakes: [] }), /overlap/)
  assert.throws(() => planTalkingHead({ durationMs: 5_000, sourceVideoId: 'video-main', sourceAudioId: 'audio-main', silences: [], retakes: [{ ranges: [{ startMs: 0, endMs: 1_000 }, { startMs: 900, endMs: 2_000 }], selectedIndex: 0 }] }), /overlap/)
})

test('T-FR-090 speaker-first template covers canonical beats with captions, reframe, justified motion and pattern breaks', () => {
  const plan = planTalkingHead({ durationMs: 30_000, sourceVideoId: 'video-main', sourceAudioId: 'audio-main', silences: [], retakes: [] })
  assert.deepEqual(plan.beats.map((beat) => beat.role), ['hook', 'development', 'development', 'proof', 'cta'])
  assert.deepEqual(plan.visuals.map((visual) => visual.beatId), plan.beats.map((beat) => beat.id))
  assert.deepEqual(plan.subtitles.map((subtitle) => subtitle.beatId), plan.beats.map((beat) => beat.id))
  assert.equal(plan.cameraMotions[0].kind, 'hold')
  assert.equal(plan.cameraMotions.slice(1).every((motion) => motion.kind === 'face-safe-reframe'), true)
  assert.deepEqual(plan.patternBreaks, plan.visuals.filter((visual) => visual.kind === 'b-roll').map((visual) => visual.startMs))
  assert.deepEqual(validateProductionCoverage(plan), { valid: true, coverage: 1, repeated: false, rhythmValid: true, legible: true })
})

test('T-FR-090 proxy/final goldens share a cryptographic audio timeline at exact 30/60/120 second outputs', () => {
  assert.deepEqual(TALKING_HEAD_TIMING_GOLDENS.map((plan) => plan.durationMs), [30_000, 60_000, 120_000])
  for (const plan of TALKING_HEAD_TIMING_GOLDENS) {
    assert.equal(plan.mode, 'talking-head')
    assert.match(plan.render.proxy.audioTimelineHash, /^[a-f0-9]{64}$/)
    assert.equal(plan.render.proxy.audioTimelineHash, plan.render.final.audioTimelineHash)
    assert.equal(plan.render.synchronized, true)
    assert.equal(plan.reframe, true)
    assert.ok(plan.visuals.some((visual) => visual.kind === 'b-roll'))
  }
})

test('T-FR-090 renderer audio contract is frame-first, deterministic and fails closed on timeline gaps', () => {
  const clips = [
    { sourceArtifactId: 'source-video', audioSourceArtifactId: 'source-audio', sourceInFrame: 0, sourceOutFrame: 300, audioSourceInFrame: 0, audioSourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 },
    { sourceArtifactId: 'source-video', audioSourceArtifactId: 'source-audio', sourceInFrame: 600, sourceOutFrame: 900, audioSourceInFrame: 600, audioSourceOutFrame: 900, timelineInFrame: 300, timelineOutFrame: 600, rate: 1 },
  ]
  const hash = createEditorialAudioTimelineHash({ fps: 30, clips })
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.equal(hash, createEditorialAudioTimelineHash({ fps: 30, clips }))
  assert.notEqual(hash, createEditorialAudioTimelineHash({ fps: 60, clips }))
  assert.throws(() => createEditorialAudioTimelineHash({ fps: 30, clips: [{ ...clips[0], timelineInFrame: 1 }] }), /segment 0/)
})
test('T-FR-091 voiceover builds beats and AssetBrief coverage without visible people or empty screens', () => { const plan=planVisualMontage({durationMs:12000,sourceAudioId:'voice',beatBoundariesMs:[3000,7000],availableVisualIds:['img','clip']}); assert.equal(plan.visuals.some((visual)=>visual.kind==='speaker'),false);assert.deepEqual(validateProductionCoverage(plan),{valid:true,coverage:1,repeated:false,rhythmValid:true,legible:true});assert.equal(plan.render.proxy.audioTimelineHash,plan.render.final.audioTimelineHash) })
test('T-FR-160 registers five versioned presets, validates custom ratio and smoke manifests', () => { assert.deepEqual(Object.keys(VERSIONED_OUTPUT_PRESETS),['9:16','16:9','4:5','1:1','21:9']);for(const value of Object.values(VERSIONED_OUTPUT_PRESETS)){assert.equal(value.version,1);assert.equal(value.export.codec,'h264');assert.ok(value.spec.width>0)}assert.equal(customizeOutputPreset('1:1',{width:720,height:720}).aspectRatio,'1:1');assert.throws(()=>customizeOutputPreset('9:16',{width:1000,height:1000}),/ratio/) })
test('T-FR-163 resolves format-specific placement, collisions and impossible constraints with 20 visual goldens', () => { assert.equal(RESPONSIVE_VISUAL_GOLDENS.length,20);const spec=VERSIONED_OUTPUT_PRESETS['9:16'].spec;const result=solveResponsivePlacement(spec,[{id:'a',anchor:'center',preferredSize:.2,minSize:100,maxSize:400,priority:2},{id:'impossible',anchor:'center',preferredSize:2,minSize:3000,maxSize:4000,priority:1}]);assert.equal(result.elements[0].id,'a');assert.equal(result.warnings[0].code,'IMPOSSIBLE_CONSTRAINTS') })
test('T-FR-164 creates smooth ROI crop plans with manual overrides and localized uncertainty/fit issues', () => { const plan=createReframePlan({format:'9:16',maxVelocityPerSecond:.1,margin:.1,observations:[{atMs:0,x:.1,y:.1,width:.3,height:.3,confidence:.9,kind:'face'},{atMs:1000,x:.8,y:.8,width:.9,height:.9,confidence:.4,kind:'object'}],overrides:[{atMs:0,x:.4,y:.4}]});assert.equal(plan.keyframes[0].source,'manual');assert.deepEqual(new Set(plan.issues.map((issue)=>issue.code)),new Set(['REFRAME_UNCERTAIN','SUBJECT_DOES_NOT_FIT']));assert.deepEqual(Object.keys(REFRAME_GOLDEN_FIXTURES),['onePerson','twoPeople','screen','movingObject']);for(const observations of Object.values(REFRAME_GOLDEN_FIXTURES))assert.ok(createReframePlan({format:'16:9',observations,maxVelocityPerSecond:.2,margin:.02}).keyframes.length) })
test('T-FR-165 localizes output issues and rejects only the affected variant', () => { const bad=critiqueOutputVariant({spec:VERSIONED_OUTPUT_PRESETS['9:16'].spec,proxyHash:'h1',elements:[{id:'sub',fromFrame:10,toFrame:20,x:-1,y:0,width:500,height:100,kind:'subtitle'}],subjectVisible:false,density:.9});const good=critiqueOutputVariant({spec:VERSIONED_OUTPUT_PRESETS['16:9'].spec,proxyHash:'h2',elements:[],subjectVisible:true,density:.2});assert.equal(bad.valid,false);assert.equal(good.valid,true);assert.equal(bad.issues.every((issue)=>issue.format==='9:16'),true) })
