import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { collectFaceSourceEvidenceStream } from '../../src/v2/domain/face-source-evidence-stream.ts'
import { OUTPUT_FORMAT_REGISTRY } from '../../src/v2/domain/output-format-registry.ts'
import { createEditorialAudioTimelineHash } from '../../src/v2/domain/production-modes.ts'
import { REFRAME_POLICY, REFRAME_POLICY_SHA256 } from '../../src/v2/domain/reframe-policy.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { measureReframeTrajectory } from '../../src/v2/domain/variant-reframe-render-plan.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { sealedSourceWindow, sourceExpectation } from './helpers/face-source-envelope-v3.mjs'
import {
  analyzeFrame, drawSourceFrame, FPS, H, judgeScene, makeBaseFrame, SCENES, sceneDurationFrames, standInDetectorRows, TOLERANCE, W,
} from './helpers/reframe-gt-oracle.mjs'
import { buildRecord, clipFacts, SOURCE, SPECS } from './helpers/reframe-trajectory-fixtures.mjs'

/**
 * W66r: frame-by-frame ground truth on the RENDERED mp4.
 *
 * The chain is the product's from the detector rows on: rows -> V9 raw tensor decoder -> sealed accepted-producer envelope -> source evidence
 * stream -> ROI through the clips -> policy-sealed plan -> keyframed render plan -> the production FfmpegEditorialProxyRenderer -> mp4.
 * The only stand-in is the DETECTOR: its rows are the boxes of the GT generator that also drew the subjects (see reframe-gt-oracle.mjs).
 * The mp4 is then decoded frame by frame and read from its pixels.
 */
const require = createRequire(import.meta.url)
const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
const ffprobePath = process.env.FFPROBE_BIN ?? require('ffprobe-static').path
const colorMetadata = Object.freeze({ colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 })
const DETECTOR_LABEL = 'GT-STAND-IN: rows are the boxes of the GT generator written through the V9 raw-tensor decoder into a sealed accepted-producer envelope; NOT a detector; quality on real video is not measured'

let root
const sourcePaths = new Map()
const evidence = []
/** When set, a few decoded frames of every render are kept as PNG so the measurements can be looked at (W66R_EVIDENCE_DIR). */
const evidenceDir = process.env.W66R_EVIDENCE_DIR || null
const KEPT_FRAMES = new Set([0, 40, 75, 110, 149])

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'apollo-reframe-gt-'))
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
})
after(async () => {
  console.log(`W66R-GT-SUMMARY ${JSON.stringify({ policyId: REFRAME_POLICY.id, policySha256: REFRAME_POLICY_SHA256, detector: DETECTOR_LABEL, scenes: evidence.length })}`)
  if (root) await rm(root, { recursive: true, force: true })
})

function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: 'workspace-reframe-gt', artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) }, createdAt: '2026-10-19T08:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({ provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters) })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: probe.workspaceId, projectId: 'project-reframe-gt', sourceArtifactId: artifactId, sourceManifestId: manifestId,
    probe, outputMetadata: colorMetadata, createdByClientId: 'client-reframe-gt', createdAt: '2026-10-19T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

/** Encodes the GT frames of a scene (drawn by the generator, piped raw) into a 1280x720, 30 fps mp4 with an audio track. */
async function generateSource(scene, path) {
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${(scene.sourceFrames / FPS + 0.5).toFixed(3)}`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-shortest', path,
  ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.on('error', () => {})
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`source encode exited ${code}: ${stderr}`))))
  })
  const base = makeBaseFrame()
  for (let frame = 0; frame < scene.sourceFrames; frame += 1) {
    const buffer = Buffer.allocUnsafe(W * H * 3)
    drawSourceFrame(buffer, base, scene.subjectsAtSource(frame))
    if (!child.stdin.write(buffer)) await new Promise((resolve) => child.stdin.once('drain', resolve))
  }
  child.stdin.end()
  await exited
}

async function sourceOf(name) {
  if (!sourcePaths.has(name)) {
    const path = join(root, `source-${name}.mp4`)
    await generateSource(SCENES[name], path)
    sourcePaths.set(name, path)
  }
  return sourcePaths.get(name)
}

/** Decodes every frame of an mp4 as RGB24 and hands each to `onFrame` as it arrives. */
function decodeFrames(path, width, height, onFrame) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const frameBytes = width * height * 3
    let pending = []
    let pendingBytes = 0
    let index = 0
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.on('data', (chunk) => {
      pending.push(chunk)
      pendingBytes += chunk.length
      while (pendingBytes >= frameBytes) {
        const all = pending.length === 1 ? pending[0] : Buffer.concat(pending)
        onFrame(all.subarray(0, frameBytes), index)
        index += 1
        const rest = all.subarray(frameBytes)
        pending = rest.length ? [rest] : []
        pendingBytes = rest.length
      }
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(index) : reject(new Error(`decode exited ${code}: ${stderr}`))))
  })
}

const probeStream = (path) => JSON.parse(execFileSync(ffprobePath, [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate', '-of', 'json', path,
], { encoding: 'utf8', windowsHide: true })).streams[0]

/** The evidence and the record the product builds for one scene and one variant, from the GT stand-in rows. */
function recordFor(name, spec) {
  const scene = SCENES[name]
  const envelope = sealedSourceWindow({ id: `gt-stand-in-${name}`, start: 0, end: scene.sourceFrames, rowsAt: (frame) => standInDetectorRows(scene, frame) })
  const stream = collectFaceSourceEvidenceStream([envelope], sourceExpectation({ sourceDurationFrames: scene.sourceFrames }))
  assert.equal(stream.untrusted.length, 0, 'the stand-in envelope is accepted by the same registry and seal checks as any producer')
  const record = buildRecord({ spec, stream, durationFrames: sceneDurationFrames(scene), clips: scene.clips.map((clip) => clipFacts({ ...clip })) })
  return { scene, envelope, stream, record }
}

let renderSequence = 0
async function renderPlanned({ name, format, renderPlan }) {
  const scene = SCENES[name]
  const clips = scene.clips.map((clip) => ({
    id: clip.clipId, sourceArtifactId: SOURCE.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: 1,
  }))
  renderSequence += 1
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, `work-${renderSequence}`), ffmpegPath })
  return renderer.render({
    operationId: `reframe-gt-${name}-${renderSequence}`, renderKind: 'proxy',
    sources: [{ artifactId: SOURCE.artifactId, path: await sourceOf(name), mediaType: 'video', colorPipelineCompilation: colorCompilation(SOURCE.artifactId) }],
    lutPaths: {}, clips, audioTimelineHash: createEditorialAudioTimelineHash({ fps: FPS, clips }), fps: FPS, format,
    composition: { foregroundScale: 1, verticalPosition: 0.5 }, reframePlan: renderPlan,
  })
}

/** Renders `renderPlan`, decodes the mp4 and judges every frame against the GT. */
let judgeSequence = 0
async function renderAndJudge({ name, format, renderPlan, issues, keep = true }) {
  const scene = SCENES[name]
  const rendered = await renderPlanned({ name, format, renderPlan })
  const stream = probeStream(rendered.outputPath)
  const canvas = { width: stream.width, height: stream.height }
  const expected = OUTPUT_FORMAT_REGISTRY.presets[format].exportDefaults.proxy
  assert.deepEqual([canvas.width, canvas.height], [expected.width, expected.height], 'the proxy canvas of the format')
  const analyses = []
  judgeSequence += 1
  const decoded = await decodeFrames(rendered.outputPath, canvas.width, canvas.height, (buffer, index) => {
    // The measurement is told nothing about the composition: it reads the picture where it is.
    analyses.push(analyzeFrame(buffer, canvas.width, canvas.height))
    if (evidenceDir && keep && KEPT_FRAMES.has(index)) {
      execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${canvas.width}x${canvas.height}`, '-i', 'pipe:0', '-frames:v', '1',
        join(evidenceDir, `${String(judgeSequence).padStart(2, '0')}-${name}-${format.replace(':', 'x')}-f${String(index).padStart(3, '0')}.png`)], { input: buffer, windowsHide: true })
    }
  })
  assert.equal(decoded, sceneDurationFrames(scene), 'every timeline frame is decoded exactly once')
  assert.equal(Number(stream.nb_read_frames), decoded)
  const verdict = judgeScene({ scene, analyses, renderPlan, issues, policy: REFRAME_POLICY, canvas })
  return { rendered, canvas, verdict }
}

const speedLimit = REFRAME_POLICY.tracking.maxVelocityPerSecond
const accelerationLimit = REFRAME_POLICY.tracking.maxAccelerationPerSecondSquared
// A 15-frame window averages the crop motion; its rounding slack is far under these.
const MEASURED_SPEED_SLACK = 0.02
const MEASURED_ACCELERATION_SLACK = 0.06

function report(label, { name, spec, record, stream, envelope, rendered, canvas, verdict }) {
  const { perFrame: _perFrame, ...summary } = verdict
  const exact = record.renderPlan.ranges.filter((range) => range.source !== 'fallback').map((range) => {
    const measured = measureReframeTrajectory(range, FPS)
    return { clipId: range.clipId, keyframes: range.keyframes.length, maxSpeed: measured.maxSpeed, maxAccelerationExcess: measured.maxAccelerationExcess }
  })
  const line = {
    label, scene: name, variantId: spec.variantId, aspectRatio: spec.aspectRatio, detector: DETECTOR_LABEL,
    envelopeHash: envelope.envelopeHash, streamHash: stream.streamHash, policySha256: record.policy.hash,
    recordHash: record.recordHash, reframePlanHash: record.renderPlan.reframePlanHash, disposition: record.disposition,
    issues: record.issues.map((issue) => [issue.code, issue.severity, issue.startFrame, issue.endFrame]),
    ranges: record.renderPlan.ranges.map((range) => [range.clipId, range.source, range.keyframes.length]),
    renderSha256: rendered.sha256, canvas, tolerances: TOLERANCE,
    renderInputTrajectory: exact, measured: { ...summary, canvas: undefined },
  }
  evidence.push(line)
  console.log(`W66R-GT-EVIDENCE ${JSON.stringify(line)}`)
  return exact
}

const assertPixelsKeepSubject = (verdict, name) => {
  assert.equal(verdict.unflaggedFailingFrames, 0, `${name}: ${JSON.stringify(verdict.firstUnflaggedFailure)} ${JSON.stringify(verdict.reasonCounts)}`)
  assert.equal(verdict.failingFrames, 0, `${name}: ${JSON.stringify(verdict.reasonCounts)}`)
  assert.equal(verdict.allSubjectsVisibleEveryFrame, true, `${name}: a subject is missing from a decoded frame`)
  assert.ok(verdict.maxWindowError <= TOLERANCE.window, `${name}: the measured crop differs from the RenderInput by ${verdict.maxWindowError}px`)
  assert.ok(verdict.maxSubjectPositionError <= TOLERANCE.position, `${name}: a decoded subject is ${verdict.maxSubjectPositionError}px from the generator`)
  assertFillsCanvas(verdict, name)
}
/**
 * The specification of a reframe: the crop FILLS the variant canvas. The sharp picture of every reframed frame covers at least
 * `TOLERANCE.coverage` of the canvas width and of the canvas height, at the cover scale of its crop, with the subject where that puts it.
 */
const assertFillsCanvas = (verdict, name) => {
  assert.ok(verdict.reframedFrames > 0, `${name}: the scene has reframed frames`)
  assert.ok(verdict.minCoverage.width >= TOLERANCE.coverage && verdict.minCoverage.height >= TOLERANCE.coverage,
    `${name}: the picture covers ${(verdict.minCoverage.width * 100).toFixed(1)}% of the canvas width and ${(verdict.minCoverage.height * 100).toFixed(1)}% of its height on the worst reframed frame (needs ${TOLERANCE.coverage * 100}%)`)
  assert.ok(verdict.maxSubjectOutputError <= TOLERANCE.outputPosition, `${name}: a subject is ${verdict.maxSubjectOutputError} canvas px from where the specification puts it`)
  for (const reason of ['foreground-does-not-fill-canvas', 'scale-differs-from-cover']) assert.equal(verdict.reasonCounts[reason] ?? 0, 0, `${name}: ${reason}`)
}
const assertPolicyDynamics = (verdict, exact, name) => {
  for (const range of exact) {
    assert.ok(range.maxSpeed <= speedLimit + 1e-6, `${name}: RenderInput speed ${range.maxSpeed} over ${speedLimit}`)
    assert.ok(range.maxAccelerationExcess <= 1e-6, `${name}: RenderInput acceleration over the limit by ${range.maxAccelerationExcess}`)
  }
  assert.ok(verdict.dynamics.maxSpeed <= speedLimit + MEASURED_SPEED_SLACK, `${name}: measured crop speed ${verdict.dynamics.maxSpeed}`)
  assert.ok(verdict.dynamics.maxAcceleration <= accelerationLimit + MEASURED_ACCELERATION_SLACK, `${name}: measured crop acceleration ${verdict.dynamics.maxAcceleration}`)
  // The pixels and the RenderInput describe the same motion.
  assert.ok(Math.abs(verdict.dynamics.maxSpeed - verdict.oracleDynamics.maxSpeed) <= MEASURED_SPEED_SLACK, `${name}: ${verdict.dynamics.maxSpeed} vs ${verdict.oracleDynamics.maxSpeed}`)
  assert.ok(Math.abs(verdict.dynamics.maxAcceleration - verdict.oracleDynamics.maxAcceleration) <= MEASURED_ACCELERATION_SLACK, `${name}: ${verdict.dynamics.maxAcceleration} vs ${verdict.oracleDynamics.maxAcceleration}`)
}
const windowSpread = (verdict) => {
  const lefts = verdict.perFrame.map((frame) => frame.measured.left)
  return Math.max(...lefts) - Math.min(...lefts)
}

for (const name of ['one-person', 'moving-subject', 'subject-reverses']) {
  test(`W66r GT ${name} 9:16: the decoded crop keeps the subject inside its safety margin on every frame and obeys the policy`, { timeout: 15 * 60_000 }, async () => {
    const built = recordFor(name, SPECS.vertical)
    assert.equal(built.record.policy.hash, REFRAME_POLICY_SHA256, 'the policy hash is sealed into the record')
    assert.deepEqual([built.record.disposition, built.record.issues.length], ['ready', 0])
    const judged = await renderAndJudge({ name, format: '9:16', renderPlan: built.record.renderPlan, issues: built.record.issues })
    const exact = report('tracked', { name, spec: SPECS.vertical, ...built, ...judged })
    assertPixelsKeepSubject(judged.verdict, name)
    assertPolicyDynamics(judged.verdict, exact, name)
    assert.ok(windowSpread(judged.verdict) > 100, `${name}: the crop must really follow the subject (it moved ${windowSpread(judged.verdict)}px)`)
    assert.ok(judged.verdict.dynamics.speedWindows > 100 && judged.verdict.dynamics.accelerationWindows > 80, 'the dynamics are measured over most of the clip, not skipped')
  })
}

test('W66r GT two clips with a cut: the crop jumps with the cut, it is never interpolated across it, and the subject is inside on both sides', { timeout: 15 * 60_000 }, async () => {
  const name = 'cut-between-clips'
  const built = recordFor(name, SPECS.vertical)
  assert.deepEqual([built.record.disposition, built.record.renderPlan.ranges.length], ['ready', 2])
  const judged = await renderAndJudge({ name, format: '9:16', renderPlan: built.record.renderPlan, issues: built.record.issues })
  const exact = report('cut', { name, spec: SPECS.vertical, ...built, ...judged })
  assertPixelsKeepSubject(judged.verdict, name)
  assertPolicyDynamics(judged.verdict, exact, name)
  const [before, afterCut] = [judged.verdict.perFrame[74].measured, judged.verdict.perFrame[75].measured]
  assert.ok(afterCut.left - before.left > 400, `the measured crop jumps at the cut (${before.left} -> ${afterCut.left})`)
  // inside each clip the crop is steady: nothing slides from one clip's subject to the other's
  const steady = (from, to) => Math.max(...judged.verdict.perFrame.slice(from, to).map((frame) => frame.measured.left)) - Math.min(...judged.verdict.perFrame.slice(from, to).map((frame) => frame.measured.left))
  assert.ok(steady(0, 75) <= 3 && steady(75, 150) <= 3, `${steady(0, 75)} ${steady(75, 150)}`)
})

test('W66r GT two people far apart: no crop shows both, the variant is blocked, the issue is localized and the fallback shows both people on every frame', { timeout: 15 * 60_000 }, async () => {
  const name = 'two-people-far-apart'
  const built = recordFor(name, SPECS.vertical)
  assert.deepEqual([built.record.disposition, built.record.issues.map((issue) => [issue.code, issue.severity, issue.startFrame, issue.endFrame])], ['blocked', [['SUBJECTS_DO_NOT_FIT', 'hard', 0, 150]]])
  assert.deepEqual(built.record.renderPlan.ranges.map((range) => range.source), ['fallback'])
  const judged = await renderAndJudge({ name, format: '9:16', renderPlan: built.record.renderPlan, issues: built.record.issues })
  report('does-not-fit', { name, spec: SPECS.vertical, ...built, ...judged })
  assert.equal(judged.verdict.failingFrames, 0, JSON.stringify(judged.verdict.reasonCounts))
  assert.equal(judged.verdict.allSubjectsVisibleEveryFrame, true, 'both people are on every decoded frame')
  assert.equal(judged.verdict.reframedFrames, 0, 'an unreframed range keeps the layout it always had and is not held to the fill')
  assert.ok(judged.verdict.perFrame.every((frame) => frame.measured.left <= 3 && frame.measured.right >= W - 3), 'the whole frame is shown')
  assert.equal(judged.verdict.flaggedFrames, 150, 'every frame is inside the localized issue')
})

test('W66r GT a screen with no face: no subject observation, the variant needs a person to look, the whole frame is shown', { timeout: 15 * 60_000 }, async () => {
  const name = 'screen-only'
  const built = recordFor(name, SPECS.vertical)
  assert.deepEqual([built.record.disposition, built.record.issues.map((issue) => [issue.code, issue.severity])], ['review-required', [['NO_SUBJECT_OBSERVATION', 'warning']]])
  const judged = await renderAndJudge({ name, format: '9:16', renderPlan: built.record.renderPlan, issues: built.record.issues })
  report('screen-only', { name, spec: SPECS.vertical, ...built, ...judged })
  assert.equal(judged.verdict.failingFrames, 0, JSON.stringify(judged.verdict.reasonCounts))
  assert.equal(judged.verdict.allSubjectsVisibleEveryFrame, true, 'the screen is on every decoded frame')
  assert.equal(judged.verdict.reframedFrames, 0, 'an unreframed range keeps the layout it always had and is not held to the fill')
  assert.ok(judged.verdict.perFrame.every((frame) => frame.measured.left <= 3 && frame.measured.right >= W - 3))
})

test('W66r GT a subject faster than the policy allows: the variant is blocked, and every frame that loses the subject is inside a reported issue', { timeout: 15 * 60_000 }, async () => {
  const name = 'subject-too-fast'
  const built = recordFor(name, SPECS.vertical)
  assert.equal(built.record.disposition, 'blocked')
  assert.ok(built.record.issues.some((issue) => issue.code === 'TRACKING_LIMIT_EXCEEDED' && issue.severity === 'hard'))
  const judged = await renderAndJudge({ name, format: '9:16', renderPlan: built.record.renderPlan, issues: built.record.issues })
  const exact = report('too-fast', { name, spec: SPECS.vertical, ...built, ...judged })
  assert.equal(judged.verdict.unflaggedFailingFrames, 0, `a frame lost the subject without an issue: ${JSON.stringify(judged.verdict.firstUnflaggedFailure)}`)
  assert.ok(judged.verdict.failingFrames > 0, 'the crop really loses the subject here: the report is what makes this honest')
  assert.ok(judged.verdict.maxWindowError <= TOLERANCE.window)
  assertFillsCanvas(judged.verdict, name)
  for (const range of exact) assert.ok(range.maxSpeed <= speedLimit + 1e-6, 'the plan never exceeds the speed limit even where it cannot keep up')
})

test('W66r GT the 16:9 variant of the same evidence is its own plan: the whole frame, the subject visible on every frame', { timeout: 15 * 60_000 }, async () => {
  const name = 'one-person'
  const vertical = recordFor(name, SPECS.vertical)
  const built = recordFor(name, SPECS.wide)
  assert.notEqual(built.record.renderPlan.reframePlanHash, vertical.record.renderPlan.reframePlanHash)
  assert.deepEqual([built.record.disposition, built.record.issues.length, built.stream.streamHash], ['ready', 0, vertical.stream.streamHash])
  const judged = await renderAndJudge({ name, format: '16:9', renderPlan: built.record.renderPlan, issues: built.record.issues })
  const exact = report('wide', { name, spec: SPECS.wide, ...built, ...judged })
  assertPixelsKeepSubject(judged.verdict, `${name} 16:9`)
  assertPolicyDynamics(judged.verdict, exact, `${name} 16:9`)
  assert.ok(judged.verdict.perFrame.every((frame) => frame.measured.left <= 3 && frame.measured.right >= W - 3), 'the 16:9 variant shows the whole 16:9 source')
  assert.deepEqual([judged.canvas.width, judged.canvas.height], [960, 540])
})

test('W66r GT the same plan renders the same bytes, and the oracle FAILS a render that does not keep the subject or breaks the policy', { timeout: 20 * 60_000 }, async () => {
  const name = 'moving-subject'
  const built = recordFor(name, SPECS.vertical)
  const first = await renderPlanned({ name, format: '9:16', renderPlan: built.record.renderPlan })
  const second = await renderPlanned({ name, format: '9:16', renderPlan: built.record.renderPlan })
  assert.equal(second.sha256, first.sha256, 'the same RenderInput gives the same mp4')
  // (1) a crop that never moves loses the moving subject: the pixel judge reports it with no help from the plan
  const stuck = createRenderReframePlan({
    format: '9:16', variantId: SPECS.vertical.variantId, fps: FPS, durationFrames: 150, source: { width: W, height: H },
    ranges: [{ clipId: 'clip-1', startFrame: 0, endFrame: 150, interpolation: 'linear', keyframes: [{ frame: 0, crop: { x: 0.34, y: 0, width: 0.31640625, height: 1 } }] }],
  })
  const lost = await renderAndJudge({ name, format: '9:16', renderPlan: stuck, issues: [] })
  console.log(`W66R-GT-CONTROL ${JSON.stringify({ control: 'static-centre-crop', unflaggedFailingFrames: lost.verdict.unflaggedFailingFrames, reasonCounts: lost.verdict.reasonCounts })}`)
  assert.ok(lost.verdict.unflaggedFailingFrames > 30, `${lost.verdict.unflaggedFailingFrames}`)
  assert.ok(lost.verdict.maxWindowError <= TOLERANCE.window, 'the plan WAS rendered faithfully: the failure is the subject leaving the crop')
  // (2) a trajectory that jumps 0.4 of the frame in five frames: the exact measure and the decoded pixels both exceed the limit
  const jumping = createRenderReframePlan({
    format: '9:16', variantId: SPECS.vertical.variantId, fps: FPS, durationFrames: 150, source: { width: W, height: H },
    ranges: [{ clipId: 'clip-1', startFrame: 0, endFrame: 150, interpolation: 'linear', keyframes: [
      { frame: 0, crop: { x: 0.02, y: 0, width: 0.31640625, height: 1 } }, { frame: 50, crop: { x: 0.02, y: 0, width: 0.31640625, height: 1 } },
      { frame: 55, crop: { x: 0.42, y: 0, width: 0.31640625, height: 1 } }, { frame: 149, crop: { x: 0.42, y: 0, width: 0.31640625, height: 1 } }] }],
  })
  const fast = await renderAndJudge({ name, format: '9:16', renderPlan: jumping, issues: [] })
  const exact = measureReframeTrajectory(jumping.ranges[0], FPS)
  console.log(`W66R-GT-CONTROL ${JSON.stringify({ control: 'velocity-jump', exactMaxSpeed: exact.maxSpeed, measuredMaxSpeed: fast.verdict.dynamics.maxSpeed })}`)
  assert.ok(exact.maxSpeed > speedLimit * 5, `${exact.maxSpeed}`)
  assert.ok(fast.verdict.dynamics.maxSpeed > speedLimit * 2, `${fast.verdict.dynamics.maxSpeed}`)
})
