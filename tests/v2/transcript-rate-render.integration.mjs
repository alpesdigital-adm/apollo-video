import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { replaceSourceTranscriptService } from '../../src/v2/application/replace-source-transcript.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { createSourceTranscriptArtifactInvalidations } from '../../src/v2/domain/source-transcript-replacement.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

// ---------------------------------------------------------------------------
// F0.027 slice 3 — one journey, no fixtures in the middle:
//
//   lavfi colour master (real media)
//     -> immutable replacement transcript
//     -> replace-source-transcript (retimes evidence through clip rates)
//     -> persistable EditPlan snapshot
//     -> run-project-director (reads the RETIMED frames, emits cues/transitions)
//     -> EditorialRenderInput built from the DIRECTED plan
//     -> FfmpegEditorialProxyRenderer (real FFmpeg)
//     -> MP4 inspected frame by frame.
//
// Every number below comes from the canonical arithmetic in
// `src/v2/domain/clip-timing.ts`:
//
//   sourceStartFrame = ceil(word.start * fps - 1e-7)
//   sourceEndFrame   = floor(word.end   * fps + 1e-7)
//   timelineFrame(f) = clamp(timelineIn + round((f - sourceIn) / rate),
//                            timelineIn, timelineOut)
//   timelineSpan     = round(sourceSpan / rate)
//
// The three clips read DISJOINT source spans on purpose. Word placement uses a
// first-match scan over the plan's audible ranges, so overlapping spans would
// make the expected values depend on clip order instead of on the arithmetic
// under test. Disjoint spans keep this test about retiming.
// ---------------------------------------------------------------------------

const FPS = 30
const WORKSPACE_ID = 'workspace-transcript-rate'
const PROJECT_ID = 'project-transcript-rate'
const MASTER_ARTIFACT_ID = 'artifact-rate-master'
const CREATED_AT = '2026-07-31T09:00:00.000Z'

// Half-frame anchoring makes `ceil`/`floor` land on the intended source frame
// regardless of binary rounding, so the tests state frames, never decimals.
const startSecondsForFrame = (frame) => (frame === 0 ? 0 : (frame - 0.5) / FPS)
const endSecondsForFrame = (frame) => (frame + 0.5) / FPS

/**
 * Source master (12s, 360 frames at 30fps), six 2s colour segments:
 *
 *   [0,60) red | [60,120) green | [120,180) blue
 *   [180,240) red | [240,300) green | [300,360) blue
 *
 * Timeline (240 frames, 8s) built from three disjoint spans of that master:
 *
 *   clip-unit  src [0,60)    rate 1    -> timeline [0,60)     red        0-2s
 *   clip-fast  src [120,240) rate 2    -> timeline [60,120)   blue+red   2-4s
 *   clip-slow  src [270,330) rate 0.5  -> timeline [120,240)  green+blue 4-8s
 *
 * 60 + round(120/2) + round(60/0.5) = 60 + 60 + 120 = 240 frames.
 */
const CLIPS = Object.freeze([
  Object.freeze({
    id: 'clip-unit', sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 60, rate: 1,
  }),
  Object.freeze({
    id: 'clip-fast', sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceInFrame: 120, sourceOutFrame: 240, timelineInFrame: 60, timelineOutFrame: 120, rate: 2,
  }),
  Object.freeze({
    id: 'clip-slow', sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceInFrame: 270, sourceOutFrame: 330, timelineInFrame: 120, timelineOutFrame: 240, rate: 0.5,
  }),
])
const DURATION_FRAMES = 240

/**
 * Words of the replacement transcript, stated in SOURCE frames. Two of them sit
 * in the gaps the timeline discards, which proves the retiming never invents
 * placement for speech the cut removed.
 */
const WORD_SOURCE_FRAMES = Object.freeze([
  ['Abertura', 6, 15], // clip-unit  rate 1
  ['clara', 20, 40], // clip-unit  rate 1
  ['perdido', 70, 100], // gap [60,120): dropped
  ['rapido', 126, 150], // clip-fast  rate 2
  ['corte', 186, 210], // clip-fast  rate 2
  ['sumido', 246, 260], // gap [240,270): dropped
  ['devagar', 276, 288], // clip-slow  rate 0.5
  ['final', 306, 324], // clip-slow  rate 0.5
])

// Hand-computed with the canonical formula above:
//   Abertura src  6..15  -> clip-unit: 0 + round(6/1)=6,      0 + round(15/1)=15
//   clara    src 20..40  -> clip-unit: 20, 40
//   rapido   src 126..150 -> clip-fast: 60 + round(6/2)=63,   60 + round(30/2)=75
//   corte    src 186..210 -> clip-fast: 60 + round(66/2)=93,  60 + round(90/2)=105
//   devagar  src 276..288 -> clip-slow: 120 + round(6/0.5)=132, 120 + round(18/0.5)=156
//   final    src 306..324 -> clip-slow: 120 + round(36/0.5)=192, 120 + round(54/0.5)=228
const EXPECTED_RETIMED_WORDS = Object.freeze([
  ['Abertura', 6, 15],
  ['clara', 20, 40],
  ['rapido', 63, 75],
  ['corte', 93, 105],
  ['devagar', 132, 156],
  ['final', 192, 228],
])

// Director cue grouping (32 characters, 2.4s, 0.55s gap, 5 words per block):
// every gap between the retained words is wider than 0.55s * 30 = 16.5 frames
// except the first, so the first two words share a cue and the rest are solo.
const EXPECTED_CUES = Object.freeze([
  ['subtitle-cue-1', 6, 40, 'Abertura clara'],
  ['subtitle-cue-2', 63, 75, 'rapido'],
  ['subtitle-cue-3', 93, 105, 'corte'],
  ['subtitle-cue-4', 132, 156, 'devagar'],
  ['subtitle-cue-5', 192, 228, 'final'],
])

const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: WORKSPACE_ID, artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: CREATED_AT,
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    sourceArtifactId: artifactId, sourceManifestId: manifestId, probe,
    outputMetadata: colorMetadata, createdByClientId: 'client-transcript-rate',
    createdAt: CREATED_AT,
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

function transcriptFromSourceFrames(entries) {
  const words = entries.map(([word, startFrame, endFrame]) => ({
    word, start: startSecondsForFrame(startFrame), end: endSecondsForFrame(endFrame),
  }))
  const text = entries.map(([word]) => word).join(' ')
  return createMediaTranscript({
    language: 'pt-BR', text, provider: 'groq', model: 'whisper-large-v3', words,
    segments: [{ id: 0, start: words[0].start, end: words.at(-1).end, text }],
  })
}

const currentTranscript = transcriptFromSourceFrames([['rascunho', 6, 15]])
const replacementTranscript = transcriptFromSourceFrames(WORD_SOURCE_FRAMES)

function baseVersion() {
  return createProjectVersion({
    id: 'version-base', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    sequence: 4, parentVersionId: 'version-parent',
    snapshotRefs: { brief: 'snapshot-brief', editPlan: 'snapshot-edit-plan', policies: 'snapshot-policies' },
    baseHash: 'a'.repeat(64), createdBy: 'client-transcript-rate', createdAt: CREATED_AT,
  })
}

function compiledEditPlan() {
  return {
    schemaVersion: 2, state: 'compiled', id: 'edit-plan-base', projectVersionId: 'version-base',
    storyPlanId: null, fps: FPS, durationFrames: DURATION_FRAMES,
    sources: [{ id: 'source-1', artifactId: MASTER_ARTIFACT_ID, kind: 'video', durationSeconds: 12 }],
    videoTracks: [{ id: 'track-base', kind: 'base-video', clips: CLIPS.map((clip) => ({ ...clip })) }],
    overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [],
    markers: [], protectedElements: [], localeVariantRefs: [], formatVariantRefs: [],
    lineageRefs: [MASTER_ARTIFACT_ID],
    retimedTranscript: {
      sourceTranscriptId: 'transcript-current',
      sourceTranscriptHash: currentTranscript.transcriptHash,
      words: [],
    },
    movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 },
    createdAt: CREATED_AT,
  }
}

class ReplacementRepository {
  committed
  async findIdempotentResult() { return this.committed ?? null }
  async readContext() {
    return {
      currentVersion: baseVersion(), editPlan: compiledEditPlan(), editPlanHash: 'b'.repeat(64),
      currentTranscript: {
        id: 'transcript-current', transcriptHash: currentTranscript.transcriptHash,
        sourceArtifactId: MASTER_ARTIFACT_ID,
      },
      replacementTranscript: {
        id: 'transcript-replacement', transcriptHash: replacementTranscript.transcriptHash,
        sourceArtifactId: MASTER_ARTIFACT_ID, transcript: replacementTranscript,
      },
      outputReferences: [
        { artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: 'version-base', variantId: '9:16' },
      ],
    }
  }

  async commitOrReplay(bundle) {
    const invalidations = createSourceTranscriptArtifactInvalidations({
      impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt,
    })
    // The persisted snapshot — not the in-memory object — is what the rest of
    // the journey reads, exactly like the Postgres repository would do.
    const result = {
      command: bundle.command, version: bundle.version,
      editPlan: JSON.parse(bundle.snapshot.contentJson), impact: bundle.command.payload.impact,
      invalidations, replayed: false, snapshot: bundle.snapshot,
    }
    this.committed = { requestFingerprint: bundle.requestFingerprint, result }
    return result
  }
}

class DirectorRepository {
  constructor(editPlan, currentVersion) {
    this.editPlan = editPlan
    this.currentVersion = currentVersion
    this.records = new Map()
  }

  async findIdempotentResult({ workspaceId, projectId, idempotencyKey }) {
    return this.records.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId }) {
    if (workspaceId !== WORKSPACE_ID || projectId !== PROJECT_ID) return null
    return {
      workspaceId,
      project: { id: projectId, objective: 'discovery', format: '9:16', locale: 'pt-BR' },
      currentVersion: this.currentVersion,
      brief: { productionBrief: { ownerInput: { text: 'Tom direto, natural e sem efeitos gratuitos.' } } },
      policies: { automaticZoom: false, faceProtection: true },
      editPlan: this.editPlan,
      transcript: {
        id: 'transcript-replacement', sourceArtifactId: MASTER_ARTIFACT_ID, language: 'pt-BR',
        provider: 'groq', model: 'whisper-large-v3', transcriptHash: replacementTranscript.transcriptHash,
      },
    }
  }

  async commitOrReplay(bundle) {
    this.lastBundle = bundle
    const result = Object.freeze({
      run: bundle.run, command: bundle.command, version: bundle.version,
      snapshots: bundle.snapshots, replayed: false,
    })
    this.records.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint, result,
    })
    return result
  }
}

const retimed = (plan) =>
  plan.retimedTranscript.words.map((word) => [word.text, word.timelineStartFrame, word.timelineEndFrame])

test('T-FR-233 retimed transcript drives the Director and the real MP4 at rates 1, 2 and 0.5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-transcript-rate-render-'))
  const masterPath = join(root, 'rate-master.mp4')
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  try {
    // -----------------------------------------------------------------------
    // 0. Real source media: 12s, six 2s colour segments, sine audio.
    // -----------------------------------------------------------------------
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...['red', 'green', 'blue', 'red', 'green', 'blue'].flatMap((color) =>
        ['-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=30:d=2`]),
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
      '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0[v]',
      '-map', '[v]', '-map', '6:a:0', '-shortest', '-af', 'volume=16',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000',
      masterPath,
    ], { windowsHide: true })
    const masterProbe = execFileSync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', masterPath,
    ], { encoding: 'utf8', windowsHide: true }).trim()
    assert.equal(Number(masterProbe), 360, 'the colour master must hold exactly 360 source frames')

    // -----------------------------------------------------------------------
    // 1. replace-source-transcript: immutable evidence in, retimed frames out.
    // -----------------------------------------------------------------------
    const replacementRepository = new ReplacementRepository()
    let replacementIds = 0
    const replace = replaceSourceTranscriptService({
      repository: replacementRepository,
      clock: () => new Date('2026-07-31T09:10:00.000Z'),
      createId: () => ['edit-command-replace-1', 'version-retimed', 'snapshot-retimed'][replacementIds++],
      createEventId: () => '123e4567-e89b-42d3-a456-426614174020',
    })
    const replacement = await replace({
      workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
      baseVersionId: 'version-base', baseHash: 'a'.repeat(64),
      replacementTranscriptId: 'transcript-replacement',
      expectedTranscriptHash: replacementTranscript.transcriptHash,
      actor: { type: 'api-client', id: 'client-transcript-rate' },
      idempotencyKey: 'transcript-rate-render-journey',
    })
    assert.equal(replacement.command.type, 'replace-source-transcript')
    assert.deepEqual(retimed(replacement.editPlan), EXPECTED_RETIMED_WORDS.map((entry) => [...entry]))
    assert.equal(replacement.impact.renderBlockedUntilDirectorRun, true)
    assert.deepEqual(replacement.impact.affectedRanges, [{ startFrame: 0, endFrame: DURATION_FRAMES }])

    // 2. The persistable snapshot carries the retimed frames, not memory state.
    const persisted = JSON.parse(replacement.snapshot.contentJson)
    assert.equal(replacement.snapshot.kind, 'edit-plan')
    assert.equal(replacement.snapshot.contentHash, calculateVersionHash(replacement.editPlan))
    assert.deepEqual(retimed(persisted), EXPECTED_RETIMED_WORDS.map((entry) => [...entry]))
    assert.equal(persisted.retimedTranscript.sourceTranscriptId, 'transcript-replacement')
    for (const dropped of ['perdido', 'sumido']) {
      assert.equal(
        persisted.retimedTranscript.words.some((word) => word.text === dropped), false,
        `${dropped} falls in a discarded source gap and must not reach the timeline`,
      )
    }
    // The source evidence itself is untouched: only the placement is retimed.
    for (const [index, [text, startFrame, endFrame]] of WORD_SOURCE_FRAMES
      .filter(([word]) => !['perdido', 'sumido'].includes(word)).entries()) {
      const word = persisted.retimedTranscript.words[index]
      assert.equal(word.text, text)
      assert.equal(word.sourceStartSeconds, startSecondsForFrame(startFrame))
      assert.equal(word.sourceEndSeconds, endSecondsForFrame(endFrame))
    }

    // -----------------------------------------------------------------------
    // 3. Director reads the RETIMED transcript out of that snapshot.
    // -----------------------------------------------------------------------
    const directorRepository = new DirectorRepository(persisted, replacement.version)
    const counters = new Map()
    let event = 0
    const runDirector = runProjectDirectorService({
      repository: directorRepository,
      clock: () => new Date('2026-07-31T09:20:00.000Z'),
      createId: (kind) => {
        const next = (counters.get(kind) ?? 0) + 1
        counters.set(kind, next)
        return `${kind}-${next}`
      },
      createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    })
    const directed = await runDirector({
      workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
      baseVersionId: replacement.version.id, baseHash: replacement.version.baseHash,
      actor: { type: 'api-client', id: 'client-transcript-rate' },
      idempotency: { key: 'director-after-transcript-rate-replacement' },
      reason: 'Dirigir a composicao com a transcricao corrigida e retimada.',
    })
    const directedPlan = directed.run.editPlan
    assert.equal(directedPlan.retimedTranscript.sourceTranscriptId, 'transcript-replacement')
    assert.deepEqual(retimed(directedPlan), EXPECTED_RETIMED_WORDS.map((entry) => [...entry]))

    // Perception is expressed in milliseconds derived from the RETIMED frames.
    // If the Director had read the original source times, `final` alone would
    // land at 10.2s-10.8s, outside an 8s timeline.
    const observations = directed.run.perception.timeline.observations
    assert.equal(directed.run.perception.timeline.durationMs, 8_000)
    assert.equal(observations.length, EXPECTED_RETIMED_WORDS.length)
    assert.deepEqual(
      observations.map((item) => [item.value.text, item.startMs, item.endMs]),
      EXPECTED_RETIMED_WORDS.map(([text, startFrame, endFrame]) => [
        text, Math.round(startFrame / FPS * 1000), Math.round(endFrame / FPS * 1000),
      ]),
    )
    assert.deepEqual(
      observations.map((item) => [item.startMs, item.endMs]),
      [[200, 500], [667, 1_333], [2_100, 2_500], [3_100, 3_500], [4_400, 5_200], [6_400, 7_600]],
    )
    // The immutable source seconds travel untouched inside the observation.
    assert.deepEqual(
      observations.map((item) => [item.value.sourceStartSeconds, item.value.sourceEndSeconds]),
      WORD_SOURCE_FRAMES.filter(([word]) => !['perdido', 'sumido'].includes(word))
        .map(([, startFrame, endFrame]) => [startSecondsForFrame(startFrame), endSecondsForFrame(endFrame)]),
    )

    // The directed plan is renderable by construction: contiguous timeline,
    // one transition per seam, non-overlapping cues (validateDirectedEditPlan).
    const directedClips = directedPlan.videoTracks.find((track) => track.kind === 'base-video').clips
    assert.deepEqual(
      directedClips.map((clip) => [clip.id, clip.sourceInFrame, clip.sourceOutFrame, clip.timelineInFrame, clip.timelineOutFrame, clip.rate]),
      CLIPS.map((clip) => [clip.id, clip.sourceInFrame, clip.sourceOutFrame, clip.timelineInFrame, clip.timelineOutFrame, clip.rate]),
    )
    assert.equal(directedPlan.transitions.length, directedClips.length - 1)
    const cues = directedPlan.subtitleTracks.flatMap((track) => track.cues)
    assert.deepEqual(
      cues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
      EXPECTED_CUES.map((entry) => [...entry]),
    )
    assert.ok(cues.every((cue) => cue.anchor === 'bottom'))
    assert.notEqual(directed.run.qualityReport.status, 'blocked')

    // -----------------------------------------------------------------------
    // 4. RenderInput materialized from the DIRECTED plan, then real FFmpeg.
    // -----------------------------------------------------------------------
    const master = {
      artifactId: MASTER_ARTIFACT_ID, path: masterPath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation(MASTER_ARTIFACT_ID),
    }
    const renderInput = {
      operationId: 'transcript-rate-directed', renderKind: 'proxy',
      sources: [master], lutPaths: {},
      clips: directedClips,
      fps: directedPlan.fps, format: '9:16',
      subtitleCues: cues,
      transitions: directedPlan.transitions,
      composition: {
        foregroundScale: directedPlan.composition.foregroundScale,
        verticalPosition: directedPlan.composition.verticalPosition,
      },
    }
    const rendered = await renderer.render(renderInput)

    // Container-level truth.
    assert.equal(rendered.probe.width, 540)
    assert.equal(rendered.probe.height, 960)
    assert.equal(rendered.probe.audioCodec, 'aac')
    assert.ok(Math.abs(rendered.probe.fps - FPS) <= 0.01, `fps ${rendered.probe.fps}`)
    assert.ok(
      Math.abs(rendered.probe.duration - DURATION_FRAMES / FPS) <= 0.1,
      `240 timeline frames must last 8s, got ${rendered.probe.duration}`,
    )
    // Exact frame count: 240 source frames read at rate 1, 120 at rate 2 and 60
    // at rate 0.5 must produce exactly 240 rendered frames.
    const countedFrames = execFileSync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', rendered.outputPath,
    ], { encoding: 'utf8', windowsHide: true }).trim()
    assert.equal(
      Number(countedFrames), DURATION_FRAMES,
      `directed proxy must hold exactly ${DURATION_FRAMES} frames, ffprobe counted ${countedFrames}`,
    )
    assert.equal(rendered.renderElementMap.durationFrames, DURATION_FRAMES)

    // Audio survived the atempo chain of both retimed clips.
    const audioAnalysis = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', rendered.outputPath,
      '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(audioAnalysis.status, 0, audioAnalysis.stderr)
    const peaks = [...audioAnalysis.stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/g)]
    assert.ok(peaks.length >= 1, 'retimed audio must produce a true-peak summary')
    assert.ok(
      Number(peaks.at(-1)[1]) <= -1,
      `rendered audio true peak must stay at or below -1 dBTP: ${peaks.at(-1)[1]}`,
    )

    // -----------------------------------------------------------------------
    // 5. Visual proof of the retiming, sampled from the MP4 pixels.
    //
    //   0-2s  clip-unit, rate 1   : source red   0-2s     -> 2s red
    //   2-3s  clip-fast, rate 2   : source blue  4-6s     -> 1s blue  (compressed)
    //   3-4s  clip-fast, rate 2   : source red   6-8s     -> 1s red   (compressed)
    //   4-6s  clip-slow, rate 0.5 : source green 9-10s    -> 2s green (expanded)
    //   6-8s  clip-slow, rate 0.5 : source blue  10-11s   -> 2s blue  (expanded)
    // -----------------------------------------------------------------------
    const channelAt = (second) => {
      const pixel = execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', rendered.outputPath,
        '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { windowsHide: true })
      assert.equal(pixel.byteLength, 3)
      return [pixel[0], pixel[1], pixel[2]]
    }
    for (const [second, dominant, label] of [
      [0.5, 0, 'rate 1 red'],
      [1.5, 0, 'rate 1 red'],
      [2.5, 2, 'rate 2 blue compressed from source 4-6s'],
      [3.5, 0, 'rate 2 red compressed from source 6-8s'],
      [4.5, 1, 'rate 0.5 green expanded from source 9-10s'],
      [5.5, 1, 'rate 0.5 green still on screen'],
      [6.5, 2, 'rate 0.5 blue expanded from source 10-11s'],
      [7.5, 2, 'rate 0.5 blue still on screen'],
    ]) {
      const channels = channelAt(second)
      for (const other of [0, 1, 2].filter((index) => index !== dominant)) {
        assert.ok(
          channels[dominant] > channels[other] * 2 + 8,
          `${label} at ${second}s must be dominated by channel ${dominant}: ${channels}`,
        )
      }
    }

    // -----------------------------------------------------------------------
    // 6. Visual proof that the Director's cues — derived from the retimed
    // words — are burned into the caption band at the retimed instants.
    // The band is a flat colour, so white pixels can only be glyphs.
    // Measured on this machine: 1337 white pixels inside a cue, 0 outside one.
    // -----------------------------------------------------------------------
    const captionBandWhitePixels = (second) => {
      const raw = execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', rendered.outputPath,
        '-frames:v', '1', '-vf', 'crop=340:70:100:835',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      assert.equal(raw.byteLength, 340 * 70 * 3)
      let white = 0
      for (let index = 0; index < raw.byteLength; index += 3) {
        if (raw[index] >= 200 && raw[index + 1] >= 200 && raw[index + 2] >= 200) white += 1
      }
      return white
    }
    // subtitle-cue-1 covers frames 6..40 (0.20s-1.33s) over the red segment;
    // subtitle-cue-4 covers frames 132..156 (4.40s-5.20s) over the green one.
    for (const [second, label] of [[0.5, 'subtitle-cue-1'], [4.8, 'subtitle-cue-4']]) {
      const white = captionBandWhitePixels(second)
      assert.ok(white >= 100, `${label} must be burned at ${second}s, only ${white} white pixels`)
    }
    // Frames 40..63 (1.33s-2.10s) and 156..192 (5.20s-6.40s) carry no cue.
    for (const [second, label] of [[1.7, 'gap after subtitle-cue-1'], [5.7, 'gap after subtitle-cue-4']]) {
      const white = captionBandWhitePixels(second)
      assert.ok(white <= 10, `${label} at ${second}s must stay clean, found ${white} white pixels`)
    }
    // Structural mirror of the same fact inside the reviewable element map.
    const subtitleAt = (frame) => rendered.renderElementMap.elements
      .filter((item) => item.type === 'subtitle' && item.frame === frame)
      .map((item) => item.elementId)
    assert.deepEqual(subtitleAt(15), ['subtitle:subtitle-cue-1'])
    assert.deepEqual(subtitleAt(140), ['subtitle:subtitle-cue-4'])
    assert.deepEqual(subtitleAt(51), [])
    assert.deepEqual(subtitleAt(171), [])

    await renderer.cleanup(renderInput.operationId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
