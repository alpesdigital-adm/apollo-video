import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { assembleServerPerceptionSnapshot, queryServerPerceptionSnapshot } from '../../src/v2/domain/server-perception-snapshot.ts'
import { createTemporalProducerEnvelope } from '../../src/v2/domain/temporal-producer-envelope.ts'
import { buildCorpusSpec, GRID_QUANTUM_PX, OCR_SAMPLE_INTERVAL_FRAMES, SPLITS, TEXT_POOLS, UNRUN } from '../../scripts/validation/w63b-corpus-spec.mjs'
import { textureRgb } from '../../scripts/validation/w63b-corpus-textures.mjs'
import {
  aggregateOcr, aggregateTemporal, characterErrorRate, clockOf, detectFadeRuns, detectHardCuts, evaluateClaims, evaluateOcr, evaluateOcrClock,
  evaluateTemporal, judge, levenshtein, normalizeText,
} from '../../scripts/validation/w63b-metrics.mjs'
import { assertRunnerClean, collectProvenance } from '../../scripts/validation/w63b-provenance.mjs'
import { STRATA } from '../../scripts/validation/w63b-thresholds.mjs'
import { assemblyBase, FPS, ocrEnvelope, sha, temporalAnalysis, wholeClips } from './helpers/perception-snapshot-fixtures.mjs'

/** Observation sets in the real shape: the products' own domain constructors and the W63a assembler/query, fed with labelled numbers. */
function analysisOf(scores, vectorAt = () => ({ x: 0, y: 0 })) {
  const base = temporalAnalysis({ frames: scores.length + 1, sourceSha256: sha('b') })
  const pairs = base.shot.observations.map((pair, index) => ({ ...pair, changeScore: scores[index] }))
  const motion = pairs.filter((pair) => pair.changeScore <= 0.35).map((pair) => ({
    startSourcePts: pair.startSourcePts, endSourcePts: pair.endSourcePts, previousFrame: pair.previousFrame, currentFrame: pair.currentFrame,
    vectorPxPerSecond: vectorAt(pair.previousFrame), residualMeanAbsoluteLuma: 0.01, ambiguity: 0.1 }))
  const merged = []
  for (const item of motion) {
    const last = merged.at(-1)
    if (last?.endSourcePts === item.startSourcePts) last.endSourcePts = item.endSourcePts
    else merged.push({ startSourcePts: item.startSourcePts, endSourcePts: item.endSourcePts })
  }
  return { ...base, shot: { observations: pairs, coverage: base.shot.coverage, gaps: [] },
    motion: { observations: motion, coverage: merged, gaps: pairs.filter((pair) => pair.changeScore > 0.35).map((pair) => ({
      startSourcePts: pair.startSourcePts, endSourcePts: pair.endSourcePts, reasonCode: 'UNRELIABLE_FRAME_DIFFERENCE' })) } }
}

function temporalEnvelopeFor({ clips, scores, vectorAt, id = 'temporal-w63b' }) {
  const timeMap = clips.map((clip) => ({ clipId: clip.id, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: 1 }))
  return createTemporalProducerEnvelope({
    id, workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', operationId: `op-${id}`, operationAttempt: 1,
    operationFenceHash: sha('2'), sourceArtifactId: 'source-1', sourceSha256: sha('b'), editPlanSnapshotId: 'snapshot-edit-1',
    editPlanSnapshotHash: sha('c'), timelineDurationFrames: Math.max(...clips.map((clip) => clip.timelineOutFrame)), timelineFps: { ...FPS },
    timeMap, analysis: analysisOf(scores, vectorAt), createdAt: '2026-10-19T00:00:00.000Z' })
}

function evidenceOf({ clips, scores, vectorAt, ocr = null }) {
  const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ clips,
    extra: { temporal: [temporalEnvelopeFor({ clips, scores, vectorAt })], ...(ocr ? { ocr: [ocr] } : {}) } }))
  return queryServerPerceptionSnapshot(snapshot, {})
}

const entryOf = (spec) => ({ id: spec.id, stratum: spec.stratum, spec })
const flat = (frames, value = 0.002) => Array.from({ length: frames - 1 }, () => value)

test('W63b text helpers: NFC, whitespace, Levenshtein over code points, box IoU through the reader', () => {
  assert.equal(normalizeText('  Ãção \n da  vida '), 'Ãção da vida')
  assert.equal(normalizeText('ã'), normalizeText('ã'))
  assert.equal(levenshtein('Ação', 'Acao'), 2)
  assert.equal(levenshtein('', 'abc'), 3)
  assert.equal(characterErrorRate('Última', 'Última'), 0)
  assert.equal(characterErrorRate('', 'abcd'), 1)
})

test('W63b Rule B flags a single-pair spike, never a uniform high plateau, and finds a spike inside a pan', () => {
  const quiet = new Map(Array.from({ length: 60 }, (_, pair) => [pair, 0.003]))
  quiet.set(30, 0.86)
  assert.deepEqual(detectHardCuts(quiet).map((event) => event.pair), [30])
  const pan = new Map(Array.from({ length: 60 }, (_, pair) => [pair, 0.18]))
  assert.deepEqual(detectHardCuts(pan), [], 'a pan has a high score on every pair: no spike')
  pan.set(40, 0.9)
  assert.deepEqual(detectHardCuts(pan).map((event) => event.pair), [40])
  const soft = new Map(Array.from({ length: 60 }, (_, pair) => [pair, 0.003]))
  soft.set(20, 0.09)
  assert.deepEqual(detectHardCuts(soft), [], 'below the 0.10 floor')
})

test('W63b Rule C finds a ramp of at least three pairs, not a one-pair spike', () => {
  const scores = new Map(Array.from({ length: 80 }, (_, pair) => [pair, 0.002]))
  for (let pair = 30; pair < 42; pair += 1) scores.set(pair, 0.03)
  scores.set(10, 0.9)
  const runs = detectFadeRuns(scores)
  assert.deepEqual(runs, [{ start: 30, end: 42 }])
})

test('W63b the corpus specification is a pure function of the split and its labels are internally consistent', () => {
  for (const split of SPLITS) {
    const first = buildCorpusSpec(split)
    assert.equal(JSON.stringify(first), JSON.stringify(buildCorpusSpec(split)), 'deterministic')
    for (const clip of first.clips) {
      assert.ok(clip.frames >= 60 && clip.frames <= 300, `${clip.id} frames`)
      assert.ok(clip.frames / 30 <= 10, `${clip.id} is within the temporal producer's 10 s bound`)
      for (const text of clip.text) {
        assert.ok(text.startFrame >= 0 && text.endFrame <= clip.frames && text.endFrame - text.startFrame >= 45, `${clip.id}/${text.id} range`)
        assert.ok([...text.text].length <= 34)
      }
      for (const cut of clip.labels.hardCuts) assert.ok(cut.frame > 1 && cut.frame < clip.frames - 1)
      for (const fade of clip.labels.crossfades) assert.ok(fade.endFrame - fade.startFrame >= 8 && fade.endFrame < clip.frames - 8)
      for (const segment of clip.labels.motion) assert.ok(segment.startPair >= 0 && segment.endPair <= clip.frames - 1 && segment.endPair > segment.startPair, `${clip.id} motion`)
      for (const insert of clip.labels.inserts) {
        assert.ok(insert.startFrame > 0 && insert.endFrame < clip.frames)
        const [x, y, w, h] = insert.boxPx
        assert.ok(x >= 0 && y >= 0 && x + w <= 1920 && y + h <= 1080)
      }
      const sceneFrames = clip.scenes.reduce((sum, scene) => sum + scene.frames, 0) - clip.transitions.reduce((sum, item) => sum + (item.type === 'xfade' ? item.frames : 0), 0)
      assert.equal(sceneFrames, clip.frames, `${clip.id}: scene program length`)
      if (clip.editPlan) {
        let cursor = 0
        for (const item of clip.editPlan.clips) {
          assert.equal(item.timelineInFrame, cursor)
          assert.equal(item.timelineOutFrame - item.timelineInFrame, item.sourceOutFrame - item.sourceInFrame)
          assert.ok(item.sourceOutFrame <= clip.frames)
          cursor = item.timelineOutFrame
        }
        assert.equal(cursor, clip.editPlan.durationFrames)
        assert.ok(cursor <= 300)
      }
    }
    const strata = new Set(first.clips.map((clip) => clip.stratum))
    for (const stratum of strata) assert.ok(stratum in STRATA || stratum === 'robustness-pts-gap', `${stratum} has pre-registered criteria`)
    for (const stratum of Object.keys(STRATA)) assert.ok(strata.has(stratum), `${stratum} has clips`)
  }
  assert.ok(UNRUN.some((item) => item.stratum === 'text-non-latin'))
  assert.equal(OCR_SAMPLE_INTERVAL_FRAMES, 15)
  assert.equal(GRID_QUANTUM_PX, 12)
})

test('W63b the two splits share no text, no clip seed and no texture', () => {
  const [development, evaluation] = SPLITS.map((split) => buildCorpusSpec(split))
  const poolsOf = (split) => new Set(Object.values(TEXT_POOLS[split]).flat())
  for (const text of poolsOf('development')) assert.ok(!poolsOf('evaluation').has(text), text)
  const seeds = new Set(development.clips.map((clip) => clip.seed))
  assert.ok(evaluation.clips.every((clip) => !seeds.has(clip.seed)))
  const sceneSeeds = new Set(development.clips.flatMap((clip) => clip.scenes.map((scene) => scene.seed)))
  assert.ok(evaluation.clips.flatMap((clip) => clip.scenes).every((scene) => scene.seed === undefined || !sceneSeeds.has(scene.seed)))
  const dev = development.clips.flatMap((clip) => clip.text.filter((text) => text.id !== 'lower-third').map((text) => text.text))
  assert.ok(dev.every((text) => poolsOf('development').has(text)))
  const ev = evaluation.clips.flatMap((clip) => clip.text.filter((text) => text.id !== 'lower-third').map((text) => text.text))
  assert.ok(ev.every((text) => poolsOf('evaluation').has(text)))
  for (const split of SPLITS) {
    const multilingual = buildCorpusSpec(split).clips.filter((clip) => clip.stratum === 'text-multilingual')
    const accented = multilingual.flatMap((clip) => clip.text).filter((text) => /[^\p{ASCII}]/u.test(text.text))
    assert.ok(accented.length >= 6, `${split}: the multilingual stratum carries diacritics (${accented.length})`)
  }
})

test('W63b textures are reproducible byte for byte and differ between seeds', () => {
  const a = textureRgb({ seed: 1, width: 96, height: 64 })
  assert.deepEqual(a, textureRgb({ seed: 1, width: 96, height: 64 }))
  assert.notDeepEqual(a, textureRgb({ seed: 2, width: 96, height: 64 }))
  assert.ok(Math.min(...a) >= 30 && Math.max(...a) <= 225)
})

test('W63b temporal evaluation: a labelled cut is matched within one pair, a stray spike is a false boundary, a fade is a run with IoU', () => {
  const spec = buildCorpusSpec('development').clips.find((clip) => clip.id === 'hard-cut-high-contrast-a')
  const frames = spec.frames
  const scores = flat(frames)
  for (const cut of spec.labels.hardCuts) scores[cut.frame - 1] = 0.86
  const clips = wholeClips('source-1', frames)
  const good = evaluateTemporal(entryOf(spec), evidenceOf({ clips, scores }))
  assert.equal(good.hardCuts.length, 3)
  assert.ok(good.hardCuts.every((cut) => cut.event && cut.score >= 0.8))
  assert.equal(good.falseCutEvents.length, 0)
  assert.equal(good.pairSetExact, true)
  const stray = [...scores]
  stray[5] = 0.5
  const bad = evaluateTemporal(entryOf(spec), evidenceOf({ clips, scores: stray }))
  assert.equal(bad.falseCutEvents.length, 1)
  const late = [...scores]
  const cut = spec.labels.hardCuts[0].frame - 1
  late[cut] = 0.002
  late[cut + 2] = 0.86
  const missed = evaluateTemporal(entryOf(spec), evidenceOf({ clips, scores: late }))
  assert.equal(missed.hardCuts[0].event, null, 'two pairs late is outside the +-1 pair tolerance')
  const aggregate = aggregateTemporal([good])
  assert.equal(aggregate.hardCutRecall, 1)
  assert.equal(judge('hard-cut-high-contrast', { temporal: aggregate }).verdict, 'pass')
  assert.equal(judge('hard-cut-high-contrast', { temporal: aggregateTemporal([missed]) }).verdict, 'fail')

  const fadeSpec = buildCorpusSpec('development').clips.find((clip) => clip.id === 'crossfade-high-contrast-a')
  const fadeScores = flat(fadeSpec.frames)
  for (const fade of fadeSpec.labels.crossfades) for (let pair = fade.startFrame; pair < fade.endFrame; pair += 1) fadeScores[pair] = 0.03
  const faded = evaluateTemporal(entryOf(fadeSpec), evidenceOf({ clips: wholeClips('source-1', fadeSpec.frames), scores: fadeScores }))
  assert.ok(faded.fades.every((fade) => fade.iou === 1))
  assert.equal(faded.falseCutEvents.length + faded.falseFadeRuns.length, 0)
  assert.equal(judge('crossfade-high-contrast', { temporal: aggregateTemporal([faded]) }).verdict, 'pass')
})

test('W63b motion evaluation: sign, magnitude and coverage against the content displacement label', () => {
  const spec = buildCorpusSpec('development').clips.find((clip) => clip.id === 'pan-slow-a')
  const clips = wholeClips('source-1', spec.frames)
  const scores = Array.from({ length: spec.frames - 1 }, (_, pair) => pair < 30 ? 0.002 : 0.12)
  const vectorAt = (pair) => pair < 30 ? { x: 0, y: 0 } : { x: -360, y: 0 } // 12 px/frame to the left = -360 px/s
  const right = evaluateTemporal(entryOf(spec), evidenceOf({ clips, scores, vectorAt }))
  const moving = right.segments.find((segment) => !segment.stationary)
  assert.equal(moving.directionShare, 1)
  assert.equal(moving.magnitudeRelError, 0)
  assert.equal(moving.coverage, 1)
  assert.equal(judge('pan-slow', { temporal: aggregateTemporal([right]) }).verdict, 'pass')
  const flipped = evaluateTemporal(entryOf(spec), evidenceOf({ clips, scores, vectorAt: (pair) => pair < 30 ? { x: 0, y: 0 } : { x: 360, y: 0 } }))
  assert.equal(flipped.segments.find((segment) => !segment.stationary).directionShare, 0)
  assert.equal(judge('pan-slow', { temporal: aggregateTemporal([flipped]) }).verdict, 'fail')
  const slow = evaluateTemporal(entryOf(spec), evidenceOf({ clips, scores, vectorAt: (pair) => pair < 30 ? { x: 0, y: 0 } : { x: -180, y: 0 } }))
  assert.equal(slow.segments.find((segment) => !segment.stationary).magnitudeRelError, 0.5)
  const jitter = evaluateTemporal(entryOf(spec), evidenceOf({ clips, scores, vectorAt: (pair) => pair < 30 ? { x: 360, y: 0 } : { x: -360, y: 0 } }))
  assert.equal(jitter.segments.find((segment) => segment.stationary).falseMotionPairs, 30)
  assert.equal(judge('pan-slow', { temporal: aggregateTemporal([jitter]) }).verdict, 'fail')
})

test('W63b time after cuts: labels follow the label EditPlan, seam pairs are absent, a removed cut is not expected', () => {
  const spec = buildCorpusSpec('development').clips.find((clip) => clip.id === 'time-after-cuts-a')
  const clock = clockOf(entryOf(spec))
  assert.equal(clock.sourceFrameToTimeline(30), 0)
  assert.equal(clock.sourceFrameToTimeline(150), 90)
  assert.equal(clock.sourceFrameToTimeline(120), null)
  assert.equal(clock.sourcePairToTimeline(89), 59, 'the cut at source frame 90 is the timeline pair 59')
  assert.equal(clock.sourcePairToTimeline(149), null, 'the cut at 150 was edited out')
  assert.deepEqual(clock.seamPairs(), [89])
  const clips = spec.editPlan.clips.map((item) => ({ id: item.id, sourceArtifactId: 'source-1', ...item, rate: 1 }))
  const duration = spec.editPlan.durationFrames
  assert.equal(clock.expectedPairs().length, duration - spec.editPlan.clips.length, 'one pair per frame, minus the last of each clip')
  const analysisScores = Array.from({ length: 240 - 1 }, (_, pair) => pair === 89 ? 0.86 : 0.002)
  const evidence = evidenceOf({ clips, scores: analysisScores, vectorAt: (pair) => pair >= 180 ? { x: -360, y: 0 } : { x: 0, y: 0 } })
  const temporal = evaluateTemporal(entryOf(spec), evidence)
  assert.equal(temporal.hardCuts.length, 1)
  assert.ok(temporal.hardCuts.every((cut) => cut.event))
  assert.equal(temporal.seamPairsObserved, 0)
  assert.equal(temporal.pairSetExact, true)
})

test('W63b OCR evaluation assigns words to labels, de-duplicates readings and counts spurious words', () => {
  const spec = buildCorpusSpec('development').clips.find((clip) => clip.id === 'text-normal-a')
  const item = spec.text[0]
  const entry = entryOf({ ...spec, text: [{ ...item, startFrame: 0, endFrame: 60, box: [0.1, 0.75, 0.3, 0.1] }] })
  const clips = wholeClips('source-1', 60)
  const envelope = (text) => ocrEnvelope({ clips, frames: [0, 15, 30, 45], text, id: `ocr-${Math.random()}` })
  const scores = flat(60)
  const exact = evaluateOcr(entry, evidenceOf({ clips, scores, ocr: envelope(() => item.text) }))
  assert.equal(exact.units.length, 4)
  assert.ok(exact.units.every((unit) => unit.exact && unit.cer === 0 && unit.iou > 0.99))
  const wrong = evaluateOcr(entry, evidenceOf({ clips, scores, ocr: envelope(() => item.text.replace('ç', 'c')) }))
  assert.ok(wrong.units.every((unit) => !unit.exact && unit.cer > 0))
  const aggregate = aggregateOcr([exact])
  assert.equal(aggregate.exactRate, 1)
  assert.equal(aggregate.spuriousPerSample, 0)
  const missing = evaluateOcr(entry, evidenceOf({ clips, scores, ocr: ocrEnvelope({ clips, frames: [0, 15, 30, 45], empty: true, id: 'ocr-empty' }) }))
  assert.ok(missing.units.every((unit) => !unit.read && unit.cer === 1))
  // a label that is not visible at a sample makes the word there spurious
  const hidden = evaluateOcr(entryOf({ ...spec, text: [{ ...item, startFrame: 30, endFrame: 60, box: [0.1, 0.75, 0.3, 0.1] }] }),
    evidenceOf({ clips, scores, ocr: envelope(() => item.text) }))
  assert.equal(hidden.units.length, 2)
  assert.equal(aggregateOcr([hidden]).spuriousPerSample, 0.5)
  const clock = evaluateOcrClock(entry, evidenceOf({ clips, scores, ocr: envelope(() => item.text) }))
  assert.equal(clock.misplaced, 0)
})

test('W63b OCR clock check on a cut timeline detects a sample placed on the wrong timeline frame', () => {
  const spec = buildCorpusSpec('development').clips.find((clip) => clip.id === 'time-after-cuts-a')
  const entry = entryOf(spec)
  const edit = spec.editPlan.clips.map((item) => ({ id: item.id, sourceArtifactId: 'source-1', ...item, rate: 1 }))
  const wholeSource = Array.from({ length: 239 }, () => 0.002)
  const frames = []
  for (const item of edit) for (let frame = item.sourceInFrame; frame < item.sourceOutFrame; frame += 1) if (frame % 15 === 0) frames.push(item.timelineInFrame + frame - item.sourceInFrame)
  const envelope = ocrEnvelope({ clips: edit, frames, id: 'ocr-cut' })
  const evidence = evidenceOf({ clips: edit, scores: wholeSource, ocr: envelope })
  const clock = evaluateOcrClock(entry, evidence)
  assert.equal(clock.misplaced, 0)
  assert.equal(clock.sameSamples, true)
})

test('W63b claims: image-insert stays absent and nothing else is invented', () => {
  const clips = wholeClips('source-1', 60)
  const claims = evaluateClaims(evidenceOf({ clips, scores: flat(60) }))
  assert.equal(claims.imageInsertClaimed, false)
  assert.equal(claims.imageInsertReasonCode, 'INSERT_GEOMETRY_NOT_COMPILED')
  assert.equal(claims.otherClaims, 0)
  assert.equal(judge('inserted-image', { temporal: aggregateTemporal([evaluateTemporal(entryOf(buildCorpusSpec('development').clips.find((clip) => clip.id === 'inserted-image-a')), evidenceOf({ clips: wholeClips('source-1', 150), scores: flat(150) }))]), claims }).verdict, 'pass')
})

test('W63b every stratum without criteria is informational and every other criterion key is resolvable', () => {
  for (const [id, stratum] of Object.entries(STRATA)) {
    const empty = judge(id, { ocr: {}, temporal: {}, claims: {}, clock: [] })
    if (Object.keys(stratum.criteria).filter((key) => key !== 'fadeIouMin').length === 0) assert.equal(empty.verdict, 'informational')
    else assert.equal(empty.verdict, 'fail', `${id}: absent measurements fail closed`)
  }
})

test('W63b provenance: a result names HEAD, the SHA-256 of the runner as run and the full git status, and a dirty runner refuses to start', async () => {
  const exec = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'w63b-provenance-'))
  const git = async (...args) => (await exec('git', args, { cwd: root, windowsHide: true })).stdout.trim()
  try {
    await git('init', '-q')
    await git('config', 'user.email', 'w63b@example.invalid')
    await git('config', 'user.name', 'w63b')
    const runner = join(root, 'runner.mjs')
    const helper = join(root, 'helper.mjs')
    await writeFile(runner, 'export const a = 1\n')
    await writeFile(helper, 'export const b = 1\n')
    await git('add', '.')
    await git('commit', '-q', '-m', 'init')
    const clean = await collectProvenance({ root, git, files: [runner, helper] })
    assert.equal(clean.head, await git('rev-parse', 'HEAD'))
    assert.deepEqual(clean.status, [])
    assert.equal(clean.treeClean, true)
    assert.equal(clean.files[0].sha256, createHash('sha256').update('export const a = 1\n').digest('hex'))
    assert.deepEqual(clean.files.map((entry) => [entry.file, entry.dirty]), [['runner.mjs', false], ['helper.mjs', false]])
    assert.doesNotThrow(() => assertRunnerClean(clean))
    // an unrelated untracked file is recorded in the status but does not stop a run
    await writeFile(join(root, 'other.txt'), 'x')
    const other = await collectProvenance({ root, git, files: [runner, helper] })
    assert.deepEqual(other.status, ['?? other.txt'])
    assert.equal(other.treeClean, false)
    assert.doesNotThrow(() => assertRunnerClean(other))
    // a modified runner (the first status line starts with a space that a trimming git() drops) refuses to start
    await writeFile(runner, 'export const a = 2\n')
    const dirty = await collectProvenance({ root, git, files: [runner, helper] })
    assert.equal(dirty.files[0].dirty, true)
    assert.equal(dirty.files[0].sha256, createHash('sha256').update('export const a = 2\n').digest('hex'), 'the hash is of the bytes on disk')
    assert.ok(dirty.status.some((line) => line.endsWith('runner.mjs')))
    assert.throws(() => assertRunnerClean(dirty), /refusing to run: runner.mjs/)
    await git('add', 'runner.mjs')
    assert.equal((await collectProvenance({ root, git, files: [runner, helper] })).files[0].dirty, true, 'staged but uncommitted is still not HEAD')
    await git('commit', '-q', '-m', 'second')
    const committed = await collectProvenance({ root, git, files: [runner, helper] })
    assert.doesNotThrow(() => assertRunnerClean(committed))
    assert.equal(committed.head, await git('rev-parse', 'HEAD'))
    // an untracked runner is not HEAD either
    const loose = join(root, 'loose.mjs')
    await writeFile(loose, 'x')
    const untracked = await collectProvenance({ root, git, files: [loose] })
    assert.equal(untracked.files[0].dirty, true)
    assert.throws(() => assertRunnerClean(untracked), /refusing to run: loose\.mjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
