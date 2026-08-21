import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueProjectProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { setProjectSubtitleConfigurationService } from '../../src/v2/application/project-subtitle-configurations.ts'
import { replaceSourceTranscriptService } from '../../src/v2/application/replace-source-transcript.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createDirectorRunInvalidations, parseDirectorRunImpact } from '../../src/v2/domain/director-run-impact.ts'
import { critiqueOutputFormat, selectExportableVariants } from '../../src/v2/domain/format-quality-critic.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import {
  advancePublicOperationPhase,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { createSourceTranscriptArtifactInvalidations } from '../../src/v2/domain/source-transcript-replacement.ts'
import { materializeSubtitlePresetSnapshot, SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } from '../../src/v2/domain/subtitle-system.ts'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import {
  LocalArtifactSourceMaterializer,
  LocalMediaUploadStorage,
} from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'

// ---------------------------------------------------------------------------
// Wave 9 phase E — combined journeys.
//
// ONE StoryPlan/transcript, TWO output variants. Everything below is produced by
// production code: replace-source-transcript -> run-project-director ->
// enqueue-project-proxy-render -> runNextProjectProxyRenderOperationService (the
// real V2 worker) -> FfmpegEditorialProxyRenderer (real FFmpeg) -> artifact
// promoted by LocalMediaUploadStorage and inspected with real ffprobe/FFmpeg.
//
// Only persistence is in-memory. No `EditorialRenderInput` is hand-built: the
// worker derives it, decides the OutputSpec/placement geometry per variant, and
// hands the rendered element map to the real format critic.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const FPS = 30
const WORKSPACE_ID = 'workspace-wave9-combined'
const PROJECT_ID = 'project-wave9-combined'
const MASTER_ARTIFACT_ID = 'artifact-wave9-master'
const MASTER_MANIFEST_ID = `manifest-${MASTER_ARTIFACT_ID}`
const MASTER_ARTIFACT_KEY = 'masters/wave9-master.mp4'
const CREATED_AT = '2026-08-14T09:00:00.000Z'
const UPLOAD_RECEIVED_AT = '2026-08-14T09:00:00.000Z'
const SOURCE_WIDTH = 640
const SOURCE_HEIGHT = 360
const DURATION_FRAMES = 180

const CANVAS = Object.freeze({
  '9:16': Object.freeze({ width: 540, height: 960 }),
  '16:9': Object.freeze({ width: 960, height: 540 }),
})

/** Widest 9:16 window a 640x360 master can offer, centred. */
const PORTRAIT_CROP_WIDTH = (9 / 16) / (SOURCE_WIDTH / SOURCE_HEIGHT)

const startSecondsForFrame = (frame) => (frame === 0 ? 0 : (frame - 0.5) / FPS)
const endSecondsForFrame = (frame) => (frame + 0.5) / FPS

/**
 * Master: 6s, 640x360, three 2s colour segments (red, green, blue) plus a sine
 * bed. Timeline: three rate-1 clips, one per segment, 180 frames total.
 */
const CLIPS = Object.freeze([
  Object.freeze({ id: 'clip-red', sourceArtifactId: MASTER_ARTIFACT_ID, sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 60, rate: 1 }),
  Object.freeze({ id: 'clip-green', sourceArtifactId: MASTER_ARTIFACT_ID, sourceInFrame: 60, sourceOutFrame: 120, timelineInFrame: 60, timelineOutFrame: 120, rate: 1 }),
  Object.freeze({ id: 'clip-blue', sourceArtifactId: MASTER_ARTIFACT_ID, sourceInFrame: 120, sourceOutFrame: 180, timelineInFrame: 120, timelineOutFrame: 180, rate: 1 }),
])

// Source frames; rate 1 everywhere, so timeline frames are identical.
const WORD_SOURCE_FRAMES = Object.freeze([
  ['Abertura', 6, 15],
  ['clara', 20, 40],
  ['meio', 70, 100],
  ['final', 130, 160],
])

// Gap 15->20 is 5 frames (< 0.55s * 30 = 16.5) so the first two words share a
// cue; 40->70 and 100->130 are 30 frames, so the rest are solo.
const EXPECTED_CUES = Object.freeze([
  ['subtitle-cue-1', 6, 40, 'Abertura clara'],
  ['subtitle-cue-2', 70, 100, 'meio'],
  ['subtitle-cue-3', 130, 160, 'final'],
])

/**
 * Subject evidence is persisted PER VARIANT, already projected onto that
 * variant's canvas. The same two subjects therefore carry different rectangles
 * in 9:16 and 16:9 — that is the whole point of the per-variant evidence.
 *
 * 9:16 (540x960): `subject-lower` sits on the burned caption band and
 * `subject-face` sits in the top strip the pillarboxed presenter never covers
 * (presenter = y 328..632 of 960).
 * 16:9 (960x540): the presenter fills the canvas and both subjects sit far above
 * the caption band, so neither reason code can fire.
 */
const SUBJECTS = Object.freeze({
  '9:16': Object.freeze([
    Object.freeze({ id: 'subject-face', startFrame: 0, endFrame: DURATION_FRAMES, bounds: Object.freeze({ x: 0.3, y: 0.05, width: 0.4, height: 0.1 }), critical: true }),
    Object.freeze({ id: 'subject-lower', startFrame: 0, endFrame: DURATION_FRAMES, bounds: Object.freeze({ x: 0.3, y: 0.86, width: 0.4, height: 0.1 }), critical: false }),
  ]),
  '16:9': Object.freeze([
    Object.freeze({ id: 'subject-face', startFrame: 0, endFrame: DURATION_FRAMES, bounds: Object.freeze({ x: 0.35, y: 0.05, width: 0.3, height: 0.2 }), critical: true }),
    Object.freeze({ id: 'subject-lower', startFrame: 0, endFrame: DURATION_FRAMES, bounds: Object.freeze({ x: 0.35, y: 0.3, width: 0.3, height: 0.2 }), critical: false }),
  ]),
})

const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

function proxyActor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-wave9', credentialId: 'credential-wave9',
    workspaceId: WORKSPACE_ID, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

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
    outputMetadata: colorMetadata, createdByClientId: 'client-wave9', createdAt: CREATED_AT,
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
    baseHash: 'a'.repeat(64), createdBy: 'client-wave9', createdAt: CREATED_AT,
  })
}

function compiledEditPlan() {
  return {
    schemaVersion: 2, state: 'compiled', id: 'edit-plan-base', projectVersionId: 'version-base',
    storyPlanId: null, fps: FPS, durationFrames: DURATION_FRAMES,
    sources: [{ id: 'source-1', artifactId: MASTER_ARTIFACT_ID, kind: 'video', durationSeconds: 6 }],
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

// --------------------------------------------------------------------------
// In-memory persistence for the replacement + Director half (identical in shape
// to the goldens that already ship: only persistence is faked).
// --------------------------------------------------------------------------

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
        { artifactId: 'proxy-16x9', kind: 'proxy', sourceVersionId: 'version-base', variantId: '16:9' },
      ],
    }
  }

  async commitOrReplay(bundle) {
    const result = {
      command: bundle.command, version: bundle.version,
      editPlan: JSON.parse(bundle.snapshot.contentJson), impact: bundle.command.payload.impact,
      invalidations: createSourceTranscriptArtifactInvalidations({
        impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt,
      }),
      replayed: false, snapshot: bundle.snapshot,
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
      brief: {
        objective: 'discovery',
        desiredAction: { schemaVersion: 1, kind: 'continue-viewing', disclosures: [] },
        productionBrief: createProductionBrief({ ownerText: 'Tom: direto, natural e sem efeitos gratuitos.' }),
      },
      policies: { automaticZoom: false, faceProtection: true, guardrails: [] },
      editPlan: this.editPlan,
      currentDurationFrames: this.editPlan.durationFrames,
      proxyVariantId: '9:16',
      sourceRights: {
        state: 'present', snapshotId: 'rights-wave9-master',
        snapshotHash: 'e'.repeat(64), status: 'approved', consentStatus: 'not-required',
      },
      outputReferences: [
        { artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: this.currentVersion.id, variantId: '9:16' },
        { artifactId: 'proxy-16x9', kind: 'proxy', sourceVersionId: this.currentVersion.id, variantId: '16:9' },
      ],
      transcript: {
        id: 'transcript-replacement', sourceArtifactId: MASTER_ARTIFACT_ID, language: 'pt-BR',
        provider: 'groq', model: 'whisper-large-v3',
        transcriptHash: this.editPlan.retimedTranscript.sourceTranscriptHash,
      },
    }
  }

  async commitOrReplay(bundle) {
    const impact = parseDirectorRunImpact(bundle.command.payload.impact)
    const result = Object.freeze({
      run: bundle.run, command: bundle.command, version: bundle.version, impact,
      invalidations: createDirectorRunInvalidations({ impact, createdAt: bundle.command.createdAt }),
      snapshots: bundle.snapshots, replayed: false,
    })
    this.records.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint, result,
    })
    return result
  }
}

/**
 * Runs replacement -> Director ONCE. Both variants render this single persisted
 * snapshot, which is what makes journey 1 ("same StoryPlan/transcript") literal.
 */
let directedOnce
async function directOnce() {
  if (directedOnce) return directedOnce
  const replacementRepository = new ReplacementRepository()
  let replacementIds = 0
  const replace = replaceSourceTranscriptService({
    repository: replacementRepository,
    clock: () => new Date('2026-08-14T09:10:00.000Z'),
    createId: () => ['edit-command-replace', 'version-retimed', 'snapshot-retimed'][replacementIds++],
    createEventId: () => '123e4567-e89b-42d3-a456-426614174020',
  })
  const replacement = await replace({
    workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    baseVersionId: 'version-base', baseHash: 'a'.repeat(64),
    replacementTranscriptId: 'transcript-replacement',
    expectedTranscriptHash: replacementTranscript.transcriptHash,
    actor: proxyActor(),
    idempotencyKey: 'wave9-combined-transcript-replacement',
  })
  const persisted = JSON.parse(replacement.snapshot.contentJson)
  const directorRepository = new DirectorRepository(persisted, replacement.version)
  const counters = new Map()
  let event = 0
  const runDirector = runProjectDirectorService({
    repository: directorRepository,
    clock: () => new Date('2026-08-14T09:20:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    compileBrief: createEvidenceBoundBriefCompiler(),
  })
  const directed = await runDirector({
    workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    baseVersionId: replacement.version.id, baseHash: replacement.version.baseHash,
    actor: proxyActor(),
    idempotency: { key: 'wave9-combined-director-run' },
    reason: 'Dirigir uma composicao unica para duas variantes de formato.',
  })
  const editPlanSnapshot = directed.snapshots.find((item) => item.kind === 'edit-plan')
  const directedPlan = JSON.parse(editPlanSnapshot.contentJson)
  assert.equal(editPlanSnapshot.contentHash, calculateVersionHash(directedPlan))
  directedOnce = { replacement, persisted, directed, directedPlan, editPlanSnapshot }
  return directedOnce
}

// --------------------------------------------------------------------------
// Real media helpers.
// --------------------------------------------------------------------------

const countFrames = (path) => Number(execFileSync(ffprobePath, [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path,
], { encoding: 'utf8', windowsHide: true }).trim())

const probeStream = (path, stream) => JSON.parse(execFileSync(ffprobePath, [
  '-v', 'error', '-select_streams', stream, '-show_entries',
  'stream=codec_name,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', path,
], { encoding: 'utf8', windowsHide: true })).streams

const channelAt = (path, second) => {
  const pixel = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true })
  assert.equal(pixel.byteLength, 3)
  return [pixel[0], pixel[1], pixel[2]]
}

const assertDominantChannel = (path, second, dominant, label) => {
  const channels = channelAt(path, second)
  for (const other of [0, 1, 2].filter((index) => index !== dominant)) {
    assert.ok(
      channels[dominant] > channels[other] * 2 + 8,
      `${label} at ${second}s must be dominated by channel ${dominant}: ${channels}`,
    )
  }
}

/**
 * White pixels inside the caption band of a variant. The band is a flat colour
 * segment, so anything white in there is a burned glyph.
 */
const captionBandWhitePixels = (path, second, format) => {
  const canvas = CANVAS[format]
  // FFmpeg's crop on a yuv420p stream needs even geometry, so every coordinate
  // is snapped to an even number before it reaches the filter.
  const even = (value) => Math.round(value / 2) * 2
  const cropWidth = even(canvas.width * 0.8)
  const cropHeight = even(canvas.height * 0.12)
  const cropX = even((canvas.width - cropWidth) / 2)
  const cropY = even(canvas.height - cropHeight - canvas.height * 0.03)
  const raw = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-vf', `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(raw.byteLength, cropWidth * cropHeight * 3)
  let white = 0
  for (let index = 0; index < raw.byteLength; index += 3) {
    if (raw[index] >= 200 && raw[index + 1] >= 200 && raw[index + 2] >= 200) white += 1
  }
  return white
}

async function writeColourMaster(masterPath) {
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...['red', 'green', 'blue'].flatMap((color) =>
      ['-f', 'lavfi', '-i', `color=c=${color}:s=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:r=${FPS}:d=2`]),
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a:0', '-shortest', '-af', 'volume=16',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000',
    masterPath,
  ], { windowsHide: true })
  assert.equal(countFrames(masterPath), DURATION_FRAMES, 'the colour master must hold exactly 180 source frames')
}

/** Static, per-variant crop trajectory: one keyframe per clip, held. */
function reframePlanFor(format) {
  const crop = format === '9:16'
    ? { x: (1 - PORTRAIT_CROP_WIDTH) / 2, y: 0, width: PORTRAIT_CROP_WIDTH, height: 1 }
    : { x: 0, y: 0, width: 1, height: 1 }
  return createRenderReframePlan({
    format, variantId: format, fps: FPS, durationFrames: DURATION_FRAMES,
    source: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
    ranges: CLIPS.map((clip) => ({
      clipId: clip.id, startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame,
      interpolation: 'hold', keyframes: [{ frame: clip.timelineInFrame, crop }],
    })),
  })
}

/** Directory listing that reports an absent directory as an empty one. */
const readdirSafe = async (path) => {
  try { return (await readdir(path, { recursive: true })).toSorted() } catch { return [] }
}

function sequentialClock(start) {
  let current = Date.parse(start)
  return () => new Date((current += 100))
}

const subtitleResolutionFor = (presetId) => presetId === null
  ? Object.freeze({ presetId: 'clean-color', presetHash: subtitlePresetHash('clean-color'), registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: false })
  : Object.freeze({ presetId, presetHash: subtitlePresetHash(presetId), registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: true, presetSnapshot: materializeSubtitlePresetSnapshot(presetId) })

// --------------------------------------------------------------------------
// The render half: real enqueue service, real worker, real FFmpeg.
// --------------------------------------------------------------------------

/**
 * Builds the immutable render source a repository would persist for ONE variant.
 * The subtitle policy is materialized with the production domain function, so a
 * disabled resolution really removes the cues instead of the test pretending to.
 */
function renderSourceFor(input) {
  const resolution = input.subtitleResolution
  const cues = input.directedPlan.subtitleTracks.flatMap((track) => track.cues ?? [])
  const materialized = resolution.enabled ? cues : []
  const editPlan = {
    ...input.directedPlan,
    subtitleTracks: input.directedPlan.subtitleTracks.map((track) => ({ ...track, cues: materialized })),
  }
  return Object.freeze({
    projectId: PROJECT_ID,
    projectVersionId: input.projectVersionId,
    editPlanSnapshotId: input.editPlanSnapshotId,
    editPlanHash: input.editPlanHash,
    editPlan,
    format: input.format,
    sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceManifestId: MASTER_MANIFEST_ID,
    sourceArtifactKey: MASTER_ARTIFACT_KEY,
    sourceSha256: input.masterSha256,
    renderSources: Object.freeze([Object.freeze({
      artifactId: MASTER_ARTIFACT_ID, manifestId: MASTER_MANIFEST_ID,
      artifactKey: MASTER_ARTIFACT_KEY, sha256: input.masterSha256, byteSize: input.masterByteSize,
      mediaType: 'video', container: 'mp4', role: 'source-master',
    })]),
    originalFileName: 'wave9-master.mp4',
    uploadReceivedAt: UPLOAD_RECEIVED_AT,
    criticIssues: Object.freeze([]),
    subtitleResolution: resolution,
    reframePlan: input.reframePlan,
    formatSubjects: SUBJECTS[input.format],
  })
}

/**
 * enqueue-project-proxy-render (real service) -> real worker -> real FFmpeg ->
 * LocalMediaUploadStorage. Only persistence ports are in memory.
 */
async function renderThroughRealWorker(input) {
  const artifactRoot = join(input.root, 'artifacts')
  const masterTarget = join(artifactRoot, ...MASTER_ARTIFACT_KEY.split('/'))
  await mkdir(join(masterTarget, '..'), { recursive: true })
  await copyFile(input.masterPath, masterTarget)

  const source = input.source
  const compilation = colorCompilation(MASTER_ARTIFACT_ID)
  const colorPipelines = {
    async listForSource({ sourceArtifactId, sourceManifestId }) {
      return sourceArtifactId === MASTER_ARTIFACT_ID && sourceManifestId === MASTER_MANIFEST_ID
        ? [{ compilation }]
        : []
    },
    async read({ compilationId }) {
      return compilationId === compilation.id ? { compilation } : null
    },
  }

  let operation
  let context
  let lease
  let failure
  const phases = []
  const record = () => ({ operation, context })
  const matches = (command) => lease && lease.owner === command.leaseOwner &&
    lease.attempt === command.attempt && Date.parse(lease.expiresAt) > Date.parse(command.now)
  const operations = {
    async findReplay() { return null },
    async createOrReplay(created) {
      operation = created.operation
      context = created.context
      return { operation, context, authenticationAudit: created.authenticationAudit, replayed: false }
    },
    async claimNext(command) {
      assert.equal(command.type, 'project-proxy-render')
      if (!['queued', 'retrying'].includes(operation.status)) return null
      operation = startPublicOperationAttempt(operation, command.now)
      lease = { owner: command.leaseOwner, attempt: operation.attempt, heartbeatAt: command.now, expiresAt: command.leaseUntil }
      return { ...record(), lease: Object.freeze({ ...lease }) }
    },
    async heartbeat(command) {
      if (!matches(command)) return false
      lease = { ...lease, heartbeatAt: command.now, expiresAt: command.leaseUntil }
      return true
    },
    async advancePhase(command) {
      if (!matches(command)) return false
      operation = advancePublicOperationPhase(operation, command.phase, command.now)
      phases.push(command.phase)
      return true
    },
    async succeed(command) {
      if (!matches(command)) return null
      operation = succeedPublicOperation(operation, command.now)
      lease = undefined
      return record()
    },
    async failOrRetry(command) {
      if (!matches(command)) return null
      failure = command.error
      operation = retryOrFailPublicOperation(operation, command.error, command.now, command.nextAttemptAt)
      lease = undefined
      return record()
    },
  }

  const enqueued = await enqueueProjectProxyRenderService({
    projects: { async readCurrentSource() { return source } },
    colorPipelines,
    operations,
    clock: () => new Date('2026-08-14T09:25:00.000Z'),
    createId: (kind) => ({
      operation: `operation-${input.suffix}`,
      artifact: `artifact-${input.suffix}-proxy`,
      manifest: `manifest-${input.suffix}-proxy`,
    })[kind],
  })({
    workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    expectedProjectVersionId: source.projectVersionId,
    actor: proxyActor(),
    idempotencyKey: `proxy-${input.suffix}`,
  })

  // `readImmutableSource` may hand the worker a TAMPERED copy: everything else
  // stays byte-identical, so any failure is attributable to the tampering alone.
  const immutableSource = input.tamper ? input.tamper(source) : source
  const workRoot = join(input.root, `work-${input.suffix}`)
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot, ffmpegPath })
  const realStorage = new LocalMediaUploadStorage(artifactRoot)
  const captured = { lutCleaned: 0, rendererCleaned: 0, renderCalls: 0 }
  const deps = {
    async catalogOutput() {},
    operations,
    colorPipelines,
    luts: {
      async materialize() {
        return { selectionId: input.lutSelectionId ?? 'selection-wave9', selectionHash: '7'.repeat(64), lutPaths: {} }
      },
      async cleanup() { captured.lutCleaned += 1 },
    },
    projects: {
      async readImmutableSource(query) {
        assert.equal(query.workspaceId, WORKSPACE_ID)
        assert.equal(query.projectId, PROJECT_ID)
        assert.equal(query.projectVersionId, source.projectVersionId)
        assert.equal(query.editPlanSnapshotId, source.editPlanSnapshotId)
        return immutableSource
      },
      async attachCompletedOutput(attached) { captured.attached = attached },
    },
    artifacts: {
      async persistOrReplay(persist) {
        captured.manifest = persist.manifest
        captured.lineageIds = persist.lineageIds
        return { artifactId: persist.artifactId, manifestId: persist.manifestId, replayed: false }
      },
    },
    storage: {
      async promoteDerived(promote) {
        captured.stored = await realStorage.promoteDerived(promote)
        return captured.stored
      },
    },
    renderer: {
      async render(renderInput) {
        captured.renderCalls += 1
        captured.renderInput = renderInput
        return renderer.render(renderInput)
      },
      async cleanup(operationId) {
        captured.rendererCleaned += 1
        return renderer.cleanup(operationId)
      },
    },
    renderElementMaps: {
      async persistOrReplay(persist) {
        captured.elementMap = persist.map
        captured.elementMapTarget = persist
        return { record: {}, replayed: false }
      },
    },
    proxyReviews: {
      async persistGenerated(persist) {
        captured.review = persist.review
        return { ...persist.review, id: persist.id }
      },
    },
    sources: new LocalArtifactSourceMaterializer(artifactRoot),
    clock: sequentialClock('2026-08-14T09:30:00.000Z'),
    leaseDurationMs: 120_000,
    heartbeatIntervalMs: 10_000,
  }

  const outcome = await runNextProjectProxyRenderOperationService(deps)(`worker-${input.suffix}`)
  return {
    ...captured, outcome, phases, failure, source, compilation, artifactRoot, workRoot,
    enqueuedContext: enqueued.context, operation, renderer,
    expectedInputHash: projectProxyRenderInputHash({
      source,
      colorPipelineBindings: [{
        sourceArtifactId: MASTER_ARTIFACT_ID, sourceManifestId: MASTER_MANIFEST_ID,
        compilationId: compilation.id, compilationHash: compilation.compilationHash,
        pipelineHash: compilation.pipeline.pipelineHash,
      }],
    }),
  }
}

/** Everything a variant render must satisfy regardless of its format verdict. */
function assertRenderedVariant(rendered, expected) {
  const canvas = CANVAS[expected.format]
  assert.deepEqual(rendered.outcome, { operationId: expected.operationId, status: 'succeeded' })
  assert.equal(rendered.operation.status, 'succeeded')
  assert.deepEqual(rendered.phases, ['rendering', 'verifying', 'persisting'])
  assert.equal(rendered.enqueuedContext.inputHash, rendered.expectedInputHash)
  assert.equal(rendered.renderInput.format, expected.format)
  assert.equal(rendered.renderInput.fps, FPS)
  assert.equal(rendered.manifest.probe.width, canvas.width)
  assert.equal(rendered.manifest.probe.height, canvas.height)
  assert.deepEqual(rendered.elementMap.canvas, { ...canvas })
  assert.equal(rendered.elementMap.durationFrames, DURATION_FRAMES)
  assert.equal(rendered.elementMap.proxyHash, rendered.stored.sha256)
  assert.equal(rendered.review.inputHash, rendered.expectedInputHash)
  assert.equal(rendered.review.outputSpecId, readOutputFormatPreset(expected.format).spec.id)
  assert.deepEqual(rendered.review.technicalIssues, [])
  assert.equal(rendered.rendererCleaned, 1)
  assert.equal(rendered.lutCleaned, 1)
}

/** Renders one variant of the single directed snapshot. */
async function renderVariant(options) {
  const journey = await directOnce()
  const masterBytes = await readFile(options.masterPath)
  const source = renderSourceFor({
    format: options.format,
    directedPlan: journey.directedPlan,
    projectVersionId: journey.directed.version.id,
    editPlanSnapshotId: journey.editPlanSnapshot.id,
    editPlanHash: journey.editPlanSnapshot.contentHash,
    masterSha256: createHash('sha256').update(masterBytes).digest('hex'),
    masterByteSize: masterBytes.byteLength,
    subtitleResolution: options.subtitleResolution ?? subtitleResolutionFor('clean-color'),
    reframePlan: reframePlanFor(options.format),
  })
  return renderThroughRealWorker({
    root: options.root, masterPath: options.masterPath, suffix: options.suffix,
    source, ...(options.tamper ? { tamper: options.tamper } : {}),
    ...(options.lutSelectionId ? { lutSelectionId: options.lutSelectionId } : {}),
  })
}

/**
 * In-memory persistence for the subtitle configuration chain. It keeps the full
 * history per variant, so `previousConfiguration` is a real predecessor and a
 * `revert` has something to return to.
 */
class SubtitleConfigurationRepository {
  constructor(version) {
    this.version = version
    this.history = []
    this.idempotent = new Map()
  }

  async findIdempotent({ workspaceId, projectId, idempotencyKey }) {
    return this.idempotent.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId, variantId }) {
    if (workspaceId !== WORKSPACE_ID || projectId !== PROJECT_ID) return null
    const forVariant = this.history.filter((item) => item.variantId === variantId)
    return {
      currentVersion: this.version,
      transcript: replacementTranscript,
      directorPresetId: 'clean-color',
      durationFrames: DURATION_FRAMES,
      outputReferences: [
        { artifactId: 'proxy-16x9', kind: 'proxy', sourceVersionId: this.version.id, variantId: '16:9' },
      ],
      currentConfiguration: forVariant.at(-1) ?? null,
      previousConfiguration: forVariant.at(-2) ?? null,
    }
  }

  async commitOrReplay(bundle) {
    this.version = bundle.version
    this.history.push(bundle.configuration)
    const result = Object.freeze({
      command: bundle.command, version: bundle.version,
      configuration: bundle.configuration, impact: bundle.impact, replayed: false,
    })
    this.idempotent.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint, result,
    })
    return result
  }

  async readCurrent() { return null }
}

/** The subtitle resolution a repository derives from a persisted configuration. */
const resolutionOf = (configuration) => Object.freeze(configuration.resolved.enabled
  ? { presetId: configuration.resolved.presetId, presetHash: configuration.resolved.presetHash, registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: true }
  : { presetId: 'clean-color', presetHash: subtitlePresetHash('clean-color'), registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: false })

// ---------------------------------------------------------------------------
// Journeys 1-5: one StoryPlan, two variants, one blocked and one exportable.
// ---------------------------------------------------------------------------
test('T-WAVE9-E 9:16 and 16:9 share one StoryPlan, own their geometry, and only 9:16 is blocked', { timeout: 15 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-wave9-variants-'))
  const masterPath = join(root, 'wave9-master.mp4')
  try {
    await writeColourMaster(masterPath)
    const journey = await directOnce()

    // --- Journey 1: both variants start from the SAME StoryPlan/transcript ---
    const cues = journey.directedPlan.subtitleTracks.flatMap((track) => track.cues)
    assert.deepEqual(
      cues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
      EXPECTED_CUES.map((entry) => [...entry]),
    )
    assert.equal(journey.directedPlan.retimedTranscript.sourceTranscriptId, 'transcript-replacement')
    assert.equal(journey.directedPlan.retimedTranscript.sourceTranscriptHash, replacementTranscript.transcriptHash)

    const portrait = await renderVariant({ root, masterPath, suffix: 'portrait', format: '9:16' })
    const landscape = await renderVariant({ root, masterPath, suffix: 'landscape', format: '16:9' })

    // Same snapshot identity, same transcript identity, same source master.
    for (const rendered of [portrait, landscape]) {
      assert.equal(rendered.source.editPlanSnapshotId, journey.editPlanSnapshot.id)
      assert.equal(rendered.source.editPlanHash, journey.editPlanSnapshot.contentHash)
      assert.equal(rendered.source.editPlan.retimedTranscript.sourceTranscriptHash, replacementTranscript.transcriptHash)
      assert.equal(rendered.source.sourceArtifactId, MASTER_ARTIFACT_ID)
    }
    assert.equal(portrait.source.editPlanHash, landscape.source.editPlanHash)
    assert.equal(portrait.renderInput.audioTimelineHash, landscape.renderInput.audioTimelineHash)
    assert.deepEqual(
      portrait.renderInput.clips.map((clip) => clip.id),
      landscape.renderInput.clips.map((clip) => clip.id),
    )

    // --- Journey 2: each variant owns its OutputSpec/placement/reframe ------
    const portraitPreset = readOutputFormatPreset('9:16')
    const landscapePreset = readOutputFormatPreset('16:9')
    assert.notEqual(portraitPreset.spec.id, landscapePreset.spec.id)
    assert.notEqual(portraitPreset.presetHash, landscapePreset.presetHash)
    const portraitPlacement = portrait.renderInput.placementPlan
    const landscapePlacement = landscape.renderInput.placementPlan
    assert.notEqual(portraitPlacement.placementPlanHash, landscapePlacement.placementPlanHash)
    assert.deepEqual(portraitPlacement.canvas, { width: 540, height: 960 })
    assert.deepEqual(landscapePlacement.canvas, { width: 960, height: 540 })
    assert.equal(portraitPlacement.outputSpecId, portraitPreset.spec.id)
    assert.equal(landscapePlacement.outputSpecId, landscapePreset.spec.id)
    // No shared coordinate: the reserved subtitle band differs in both axes.
    assert.notDeepEqual(portraitPlacement.subtitleRegion.bounds, landscapePlacement.subtitleRegion.bounds)
    const portraitReframe = portrait.renderInput.reframePlan
    const landscapeReframe = landscape.renderInput.reframePlan
    assert.notEqual(portraitReframe.reframePlanHash, landscapeReframe.reframePlanHash)
    assert.equal(portraitReframe.variantId, '9:16')
    assert.equal(landscapeReframe.variantId, '16:9')
    assert.notEqual(
      portraitReframe.ranges[0].keyframes[0].crop.width,
      landscapeReframe.ranges[0].keyframes[0].crop.width,
    )
    console.log(`journey 2 placementPlanHash 9:16=${portraitPlacement.placementPlanHash.slice(0, 12)} 16:9=${landscapePlacement.placementPlanHash.slice(0, 12)}; reframePlanHash 9:16=${portraitReframe.reframePlanHash.slice(0, 12)} 16:9=${landscapeReframe.reframePlanHash.slice(0, 12)}`)

    assertRenderedVariant(portrait, { operationId: 'operation-portrait', format: '9:16' })
    assertRenderedVariant(landscape, { operationId: 'operation-landscape', format: '16:9' })

    // --- Journey 3: the 9:16 blocker is localized ---------------------------
    const portraitIssues = portrait.review.criticIssues
    console.log(`journey 3 9:16 reason codes: ${JSON.stringify(portraitIssues.map((issue) => [issue.code, issue.severity, issue.evidenceRange.startFrame, issue.evidenceRange.endFrame]))}`)
    console.log(`journey 3 16:9 reason codes: ${JSON.stringify(landscape.review.criticIssues.map((issue) => [issue.code, issue.severity]))}`)
    const collision = portraitIssues.find((issue) => issue.code === 'SUBTITLE_SUBJECT_COLLISION')
    assert.ok(collision, 'the 9:16 subtitle band overlaps subject-lower and must raise a hard reason code')
    assert.equal(collision.severity, 'hard')
    assert.equal(collision.outputSpecId, portraitPreset.spec.id)
    assert.equal(collision.outputPresetHash, portraitPreset.presetHash)
    assert.equal(collision.placementPlanHash, portraitPlacement.placementPlanHash)
    assert.equal(collision.reframePlanHash, portraitReframe.reframePlanHash)
    assert.equal(collision.format, '9:16')
    // Half-open evidence range, exactly the frames the first cue occupies.
    assert.deepEqual({ ...collision.evidenceRange }, { startFrame: 6, endFrame: 40 })
    assert.deepEqual([...collision.rangeMs], [200, 1_333])
    assert.deepEqual([...collision.elementIds], ['subtitle:subtitle-cue-1'])
    assert.ok(collision.evidenceIds.includes('subject-lower'))
    const notVisible = portraitIssues.find((issue) => issue.code === 'SUBJECT_NOT_VISIBLE')
    assert.ok(notVisible, 'the pillarboxed 9:16 presenter never covers subject-face')
    assert.equal(notVisible.severity, 'hard')
    assert.deepEqual({ ...notVisible.evidenceRange }, { startFrame: 0, endFrame: DURATION_FRAMES })
    assert.deepEqual([...notVisible.evidenceIds], ['subject-face'])

    // --- Journey 4: the decision is per variant -----------------------------
    assert.equal(portrait.review.formatQuality.status, 'blocked')
    assert.equal(portrait.review.formatQuality.exportAllowed, false)
    assert.equal(portrait.review.status, 'blocked')
    assert.equal(portrait.review.finalAllowed, false)
    assert.equal(landscape.review.formatQuality.status, 'passed')
    assert.equal(landscape.review.formatQuality.exportAllowed, true)
    assert.deepEqual(landscape.review.criticIssues, [])
    assert.equal(landscape.review.status, 'ready-for-final')
    assert.equal(landscape.review.finalAllowed, true)
    // Both operations succeeded: a blocked format is an editorial verdict on one
    // variant, never a worker failure that would take the sibling down with it.
    assert.equal(portrait.operation.status, 'succeeded')
    assert.equal(landscape.operation.status, 'succeeded')

    // --- Journey 5: the 16:9 variant is a real, exportable MP4 --------------
    const landscapePath = landscape.stored.path
    const landscapeBytes = await readFile(landscapePath)
    assert.equal(createHash('sha256').update(landscapeBytes).digest('hex'), landscape.manifest.artifact.sha256)
    const [video] = probeStream(landscapePath, 'v:0')
    const [audio] = probeStream(landscapePath, 'a:0')
    assert.equal(video.codec_name, 'h264')
    assert.equal(video.width, 960)
    assert.equal(video.height, 540)
    assert.equal(video.r_frame_rate, '30/1')
    assert.equal(audio.codec_name, 'aac')
    const landscapeFrames = countFrames(landscapePath)
    assert.equal(landscapeFrames, DURATION_FRAMES, `16:9 proxy must hold exactly ${DURATION_FRAMES} frames, ffprobe counted ${landscapeFrames}`)
    assert.ok(
      Math.abs(landscape.manifest.probe.duration - DURATION_FRAMES / FPS) <= 0.1,
      `180 frames must last 6s, got ${landscape.manifest.probe.duration}`,
    )
    console.log(`journey 5 16:9 MP4: ${video.width}x${video.height} @ ${video.r_frame_rate}, ${landscapeFrames} frames, ${landscape.manifest.probe.duration}s, ${landscape.stored.byteSize} bytes`)
    for (const [second, dominant, label] of [
      [0.5, 0, 'clip-red'], [2.5, 1, 'clip-green'], [4.5, 2, 'clip-blue'],
    ]) assertDominantChannel(landscapePath, second, dominant, label)
    // The 9:16 sibling was still rendered: blocking is a verdict, not a deletion.
    assert.equal(countFrames(portrait.stored.path), DURATION_FRAMES)

    // Both reports read together give the export decision per output. The
    // reports are recomputed from the PERSISTED element maps and promoted proxy
    // digests; their reportHash matching the one the worker stored proves the
    // reconstruction is the very report the worker produced.
    const reports = [portrait, landscape].map((rendered) => critiqueOutputFormat({
      outputSpecId: rendered.review.outputSpecId,
      format: rendered.renderInput.format,
      proxyHash: rendered.stored.sha256,
      map: rendered.elementMap,
      placementPlanHash: rendered.renderInput.placementPlan.placementPlanHash,
      reframePlanHash: rendered.renderInput.reframePlan.reframePlanHash,
      subjects: SUBJECTS[rendered.renderInput.format],
    }))
    assert.equal(reports[0].reportHash, portrait.review.formatQuality.reportHash)
    assert.equal(reports[1].reportHash, landscape.review.formatQuality.reportHash)
    const decision = selectExportableVariants(reports)
    assert.deepEqual([...decision.approvedOutputSpecIds], [landscapePreset.spec.id])
    assert.deepEqual([...decision.blockedOutputSpecIds], [portraitPreset.spec.id])
    assert.deepEqual(
      decision.decisions.map((item) => [item.format, item.status, item.exportAllowed, [...item.blockingCodes]]),
      // `selectExportableVariants` returns decisions in canonical outputSpecId
      // order, so 16:9 precedes 9:16 regardless of the input order.
      [
        ['16:9', 'passed', true, []],
        ['9:16', 'blocked', false, ['SUBJECT_NOT_VISIBLE', 'SUBTITLE_SUBJECT_COLLISION']],
      ],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Journeys 6, 7 and 8: the subtitle configuration chain drives real renders.
// ---------------------------------------------------------------------------
test('T-WAVE9-E the subtitle configuration chain changes only the preset, never the transcript', { timeout: 15 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-wave9-subtitles-'))
  const masterPath = join(root, 'wave9-master.mp4')
  try {
    await writeColourMaster(masterPath)
    const journey = await directOnce()

    // --- The chain: clean-color -> kinetic -> none -> revert ---------------
    const repository = new SubtitleConfigurationRepository(journey.directed.version)
    let counter = 0
    const setSubtitles = setProjectSubtitleConfigurationService({
      repository,
      clock: () => new Date(`2026-08-14T10:0${counter}:00.000Z`),
      createId: (kind) => `${kind}-subtitle-${counter}`,
    })
    const step = async (label, request) => {
      counter += 1
      return setSubtitles({
        workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
        baseVersionId: repository.version.id, baseHash: repository.version.baseHash,
        variantId: '16:9', actor: proxyActor(),
        idempotencyKey: `wave9-subtitle-${label}`, ...request,
      })
    }
    const cleanColor = await step('clean-color', { requested: { mode: 'manual', presetId: 'clean-color', presetVersion: 1 } })
    const kinetic = await step('kinetic', { requested: { mode: 'manual', presetId: 'kinetic', presetVersion: 1 } })
    const none = await step('none', { requested: { mode: 'none' } })
    const reverted = await step('revert', { action: 'revert' })

    const chain = [cleanColor, kinetic, none, reverted].map((item) => item.configuration)
    console.log(`journeys 6-8 chain: ${JSON.stringify(chain.map((item) => [item.action, item.requested.mode, item.resolved.enabled ? item.resolved.presetId : null]))}`)
    // --- Journey 8 (lineage): every link points at the one it replaced ------
    assert.deepEqual(chain.map((item) => item.action), ['set', 'set', 'set', 'revert'])
    assert.equal(chain[0].previousConfigurationId, null)
    assert.equal(chain[1].previousConfigurationId, chain[0].id)
    assert.equal(chain[2].previousConfigurationId, chain[1].id)
    assert.equal(chain[3].previousConfigurationId, chain[2].id)
    // Versions form an unbroken parent chain on top of the directed version.
    const versions = [cleanColor, kinetic, none, reverted].map((item) => item.version)
    assert.equal(versions[0].parentVersionId, journey.directed.version.id)
    for (const [index, version] of versions.entries()) {
      if (index > 0) assert.equal(version.parentVersionId, versions[index - 1].id)
      assert.equal(version.sequence, journey.directed.version.sequence + index + 1)
    }
    // A revert returns to the configuration the head replaced — the kinetic one.
    assert.equal(chain[3].requested.mode, 'manual')
    assert.equal(chain[3].resolved.enabled, true)
    assert.equal(chain[3].resolved.presetId, chain[1].resolved.presetId)
    assert.equal(chain[3].resolved.presetHash, chain[1].resolved.presetHash)

    // --- Journey 6 (identity): the transcript never moves -------------------
    // Byte-identical, compared literally and as bytes.
    for (const configuration of chain) {
      assert.equal(configuration.transcriptHash, chain[0].transcriptHash)
      assert.equal(
        Buffer.compare(Buffer.from(configuration.transcriptHash, 'utf8'), Buffer.from(chain[0].transcriptHash, 'utf8')),
        0,
      )
    }
    assert.equal(chain[0].transcriptHash, calculateCanonicalHash(replacementTranscript))
    assert.notEqual(chain[0].resolved.presetHash, chain[1].resolved.presetHash)

    // --- Journey 6 (render): only preset/mode and the render identity move --
    const withCleanColor = await renderVariant({
      root, masterPath, suffix: 'clean-color', format: '16:9',
      subtitleResolution: resolutionOf(chain[0]),
    })
    const withKinetic = await renderVariant({
      root, masterPath, suffix: 'kinetic', format: '16:9',
      subtitleResolution: resolutionOf(chain[1]),
    })
    assertRenderedVariant(withCleanColor, { operationId: 'operation-clean-color', format: '16:9' })
    assertRenderedVariant(withKinetic, { operationId: 'operation-kinetic', format: '16:9' })
    // The transcript-derived halves of the render are untouched.
    assert.equal(
      withCleanColor.source.editPlan.retimedTranscript.sourceTranscriptHash,
      withKinetic.source.editPlan.retimedTranscript.sourceTranscriptHash,
    )
    assert.equal(withCleanColor.expectedInputHash, withKinetic.expectedInputHash)
    assert.equal(withCleanColor.renderInput.audioTimelineHash, withKinetic.renderInput.audioTimelineHash)
    assert.deepEqual(
      withCleanColor.renderInput.subtitleCues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
      withKinetic.renderInput.subtitleCues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
    )
    // The geometry identity moved, because the reserved band came from the preset.
    assert.notEqual(
      withCleanColor.renderInput.placementPlan.placementPlanHash,
      withKinetic.renderInput.placementPlan.placementPlanHash,
    )
    assert.equal(withCleanColor.renderInput.placementPlan.subtitleRegion.presetId, 'clean-color')
    assert.equal(withKinetic.renderInput.placementPlan.subtitleRegion.presetId, 'kinetic')
    assert.notEqual(withCleanColor.manifest.recipe.parametersHash, withKinetic.manifest.recipe.parametersHash)
    assert.equal(withCleanColor.manifest.recipe.version, EDITORIAL_PROXY_RECIPE_VERSION)
    console.log(`journey 6 parametersHash clean-color=${withCleanColor.manifest.recipe.parametersHash.slice(0, 12)} kinetic=${withKinetic.manifest.recipe.parametersHash.slice(0, 12)}; transcriptHash unchanged=${chain[0].transcriptHash.slice(0, 12)}`)

    // --- Journey 7: `none` keeps the audio and erases every caption pixel ---
    const withoutSubtitles = await renderVariant({
      root, masterPath, suffix: 'none', format: '16:9',
      subtitleResolution: resolutionOf(chain[2]),
    })
    assertRenderedVariant(withoutSubtitles, { operationId: 'operation-none', format: '16:9' })
    assert.deepEqual([...withoutSubtitles.renderInput.subtitleCues], [])
    // No preset, so no reserved band: the plan records the absence explicitly.
    assert.equal(withoutSubtitles.renderInput.placementPlan.subtitleRegion, null)
    assert.equal(
      withoutSubtitles.elementMap.elements.some((element) => element.type === 'subtitle'), false,
      'a disabled resolution must leave no subtitle element in the reviewable map',
    )
    // Transcript and its evidence survive untouched: only the drawing stopped.
    assert.equal(
      withoutSubtitles.source.editPlan.retimedTranscript.sourceTranscriptHash,
      replacementTranscript.transcriptHash,
    )
    assert.deepEqual(
      withoutSubtitles.source.editPlan.retimedTranscript.words.map((word) => [word.text, word.timelineStartFrame, word.timelineEndFrame]),
      WORD_SOURCE_FRAMES.map(([text, startFrame, endFrame]) => [text, startFrame, endFrame]),
    )
    const nonePath = withoutSubtitles.stored.path
    const [noneAudio] = probeStream(nonePath, 'a:0')
    assert.equal(noneAudio.codec_name, 'aac', 'the audio track must survive a disabled subtitle resolution')
    const audioAnalysis = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', nonePath,
      '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(audioAnalysis.status, 0, audioAnalysis.stderr)
    const peaks = [...audioAnalysis.stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/g)]
    assert.ok(peaks.length >= 1, 'a soundless file would produce no true-peak summary')
    assert.ok(Number(peaks.at(-1)[1]) > -70, `the sine bed must still be audible, true peak ${peaks.at(-1)?.[1]}`)
    assert.ok(Number(peaks.at(-1)[1]) <= -1, `rendered audio true peak must stay at or below -1 dBTP: ${peaks.at(-1)[1]}`)
    // Zero ink where the cues used to burn, measured against a drawn baseline.
    for (const [second, cueId] of [[0.5, 'subtitle-cue-1'], [2.7, 'subtitle-cue-2'], [4.7, 'subtitle-cue-3']]) {
      const drawn = captionBandWhitePixels(withKinetic.stored.path, second, '16:9')
      const suppressed = captionBandWhitePixels(nonePath, second, '16:9')
      console.log(`journey 7 caption band at ${second}s (${cueId}): kinetic=${drawn} none=${suppressed}`)
      assert.ok(drawn > 100, `${cueId} must be burned when subtitles are enabled, counted ${drawn}`)
      assert.equal(suppressed, 0, `${cueId} must leave zero ink when resolved to none, counted ${suppressed}`)
    }

    // --- Journey 8 (reproducibility): the reverted version renders the old ---
    const afterRevert = await renderVariant({
      root, masterPath, suffix: 'revert', format: '16:9',
      subtitleResolution: resolutionOf(chain[3]),
    })
    assertRenderedVariant(afterRevert, { operationId: 'operation-revert', format: '16:9' })
    assert.equal(afterRevert.manifest.recipe.parametersHash, withKinetic.manifest.recipe.parametersHash)
    assert.equal(
      afterRevert.renderInput.placementPlan.placementPlanHash,
      withKinetic.renderInput.placementPlan.placementPlanHash,
    )
    assert.equal(calculateCanonicalHash(afterRevert.elementMap), calculateCanonicalHash(withKinetic.elementMap))
    assert.equal(countFrames(afterRevert.stored.path), countFrames(withKinetic.stored.path))
    for (const second of [0.5, 2.5, 4.5]) {
      assert.deepEqual(channelAt(afterRevert.stored.path, second), channelAt(withKinetic.stored.path, second))
      assert.equal(
        captionBandWhitePixels(afterRevert.stored.path, second, '16:9'),
        captionBandWhitePixels(withKinetic.stored.path, second, '16:9'),
      )
    }
    console.log(`journey 8 revert reproduced kinetic: parametersHash=${afterRevert.manifest.recipe.parametersHash.slice(0, 12)}, sha256 equal=${afterRevert.stored.sha256 === withKinetic.stored.sha256}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Journeys 9 and 10: tampering fails closed, and a clean rerun reproduces.
// ---------------------------------------------------------------------------
test('T-WAVE9-E tampered hashes never reach the renderer and a clean rerun reproduces the result', { timeout: 15 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-wave9-tamper-'))
  const masterPath = join(root, 'wave9-master.mp4')
  try {
    await writeColourMaster(masterPath)

    // --- Journey 10: two runs of the same persisted input reproduce ---------
    // Different operations, identical everything else. FFmpeg is not contract-
    // ually bit-reproducible, so the product guarantee under test is: same input
    // hash, same recipe parameters, same element map, same frame count and the
    // same sampled pixels. The sha256 equality is reported, never asserted.
    const first = await renderVariant({ root, masterPath, suffix: 'repro-a', format: '16:9', lutSelectionId: 'selection-repro' })
    const second = await renderVariant({ root, masterPath, suffix: 'repro-b', format: '16:9', lutSelectionId: 'selection-repro' })
    assertRenderedVariant(first, { operationId: 'operation-repro-a', format: '16:9' })
    assertRenderedVariant(second, { operationId: 'operation-repro-b', format: '16:9' })
    assert.equal(second.expectedInputHash, first.expectedInputHash)
    assert.equal(second.enqueuedContext.inputHash, first.enqueuedContext.inputHash)
    assert.equal(second.manifest.recipe.parametersHash, first.manifest.recipe.parametersHash)
    assert.equal(second.manifest.recipe.version, first.manifest.recipe.version)
    assert.equal(
      second.renderInput.placementPlan.placementPlanHash,
      first.renderInput.placementPlan.placementPlanHash,
    )
    assert.equal(
      second.renderInput.reframePlan.reframePlanHash,
      first.renderInput.reframePlan.reframePlanHash,
    )
    assert.equal(calculateCanonicalHash(second.elementMap), calculateCanonicalHash(first.elementMap))
    assert.equal(second.review.rangeCacheKey, first.review.rangeCacheKey)
    const firstFrames = countFrames(first.stored.path)
    assert.equal(countFrames(second.stored.path), firstFrames)
    assert.equal(firstFrames, DURATION_FRAMES)
    for (const second_ of [0.2, 0.5, 2.5, 4.5, 5.8]) {
      assert.deepEqual(channelAt(second.stored.path, second_), channelAt(first.stored.path, second_))
    }
    for (const second_ of [0.5, 2.7, 4.7]) {
      assert.equal(
        captionBandWhitePixels(second.stored.path, second_, '16:9'),
        captionBandWhitePixels(first.stored.path, second_, '16:9'),
      )
    }
    console.log(`journey 10 rerun: inputHash=${first.expectedInputHash.slice(0, 12)}, parametersHash=${first.manifest.recipe.parametersHash.slice(0, 12)}, ${firstFrames} frames both runs, byte-identical MP4=${second.stored.sha256 === first.stored.sha256}`)

    // --- Journey 9: four tampered hashes, four closed doors ----------------
    // Each run differs from the clean `repro-a` run above by EXACTLY one field,
    // so the failure is attributable to the tampering and to nothing else. The
    // proof that no FFmpeg process was launched is structural: the operation
    // never advanced to the `rendering` phase and the renderer port was never
    // called, both recorded by the worker's own persistence commands.
    const tampers = [
      ['registryHash', (source) => ({ ...source, subtitleResolution: { ...source.subtitleResolution, registryHash: 'f'.repeat(64) } })],
      ['presetHash', (source) => ({ ...source, subtitleResolution: { ...source.subtitleResolution, presetHash: '1'.repeat(64) } })],
      ['reframePlanHash', (source) => ({ ...source, reframePlan: { ...source.reframePlan, reframePlanHash: '0'.repeat(64) } })],
      ['reframePlan.outputPresetHash', (source) => ({ ...source, reframePlan: { ...source.reframePlan, outputPresetHash: 'b'.repeat(64) } })],
    ]
    for (const [label, tamper] of tampers) {
      const suffix = `tamper-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      const rejected = await renderVariant({ root, masterPath, suffix, format: '16:9', tamper })
      console.log(`journey 9 ${label}: outcome=${JSON.stringify(rejected.outcome)}, phases=${JSON.stringify(rejected.phases)}, renderCalls=${rejected.renderCalls}`)
      assert.deepEqual(rejected.outcome, { operationId: `operation-${suffix}`, status: 'failed' })
      assert.equal(rejected.operation.status, 'failed')
      assert.deepEqual(rejected.failure, {
        code: 'invalid_render_input',
        message: 'Project proxy render could not be completed',
        retryable: false,
      })
      // Never entered `rendering`: the validation ran before the phase advanced.
      assert.deepEqual(rejected.phases, [])
      assert.equal(rejected.renderCalls, 0, 'the renderer port must never be called for a tampered input')
      assert.equal(rejected.stored, undefined, 'no artifact may be promoted from a tampered input')
      assert.equal(rejected.manifest, undefined)
      assert.equal(rejected.review, undefined)
    }

    // The fourth family, `placementPlanHash`, cannot be tampered through
    // persistence at all: the worker DERIVES the placement plan from the output
    // preset and the resolved subtitle preset, and re-validates it before the
    // `rendering` phase. Its only trust boundary is therefore the renderer
    // input, which rejects an inconsistent digest before spawning FFmpeg.
    const tamperedPlacement = {
      ...first.renderInput.placementPlan,
      placementPlanHash: '2'.repeat(64),
    }
    const scratchBefore = await readdirSafe(first.workRoot)
    await assert.rejects(
      () => first.renderer.render({
        ...first.renderInput,
        operationId: 'operation-placement-tamper',
        placementPlan: tamperedPlacement,
        signal: undefined,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_RENDER_INPUT')
        assert.match(error.message, /Placement plan hash is inconsistent/)
        return true
      },
    )
    // Not a single byte was written: the digest was checked before any encode.
    assert.deepEqual(await readdirSafe(first.workRoot), scratchBefore)

    // The untampered plan renders through the very same renderer instance, so
    // the rejection above is about the digest and not about a broken fixture.
    const control = await first.renderer.render({
      ...first.renderInput,
      operationId: 'operation-placement-control',
      signal: undefined,
    })
    try {
      assert.equal(countFrames(control.outputPath), DURATION_FRAMES)
      assert.equal(control.renderElementMap.durationFrames, DURATION_FRAMES)
    } finally {
      await first.renderer.cleanup('operation-placement-control')
    }
    console.log(`journey 9 placementPlanHash: renderer rejected the tampered digest with INVALID_RENDER_INPUT and wrote nothing; the same input with the untampered digest rendered ${DURATION_FRAMES} frames`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
