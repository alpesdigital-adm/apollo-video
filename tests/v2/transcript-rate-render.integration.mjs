import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueProjectProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { replaceSourceTranscriptService } from '../../src/v2/application/replace-source-transcript.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createDirectorRunInvalidations, parseDirectorRunImpact } from '../../src/v2/domain/director-run-impact.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import {
  advancePublicOperationPhase,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { createSourceTranscriptArtifactInvalidations } from '../../src/v2/domain/source-transcript-replacement.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

function proxyActor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-transcript-rate', credentialId: 'credential-transcript-rate',
    workspaceId: WORKSPACE_ID, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

// ---------------------------------------------------------------------------
// F0.027 slice 3 — two journeys, no fixtures in the middle:
//
//   lavfi colour master (real media)
//     -> immutable replacement transcript
//     -> replace-source-transcript (retimes evidence through clip rates)
//     -> persistable EditPlan snapshot
//     -> run-project-director (reads the RETIMED frames, emits cues/transitions)
//     -> enqueue-project-proxy-render (real service, real input hash)
//     -> runNextProjectProxyRenderOperationService (the REAL V2 worker)
//     -> FfmpegEditorialProxyRenderer (real FFmpeg)
//     -> artifact promoted by LocalMediaUploadStorage, inspected frame by frame.
//
// Nothing here hand-builds an `EditorialRenderInput`: the render input is the
// one the worker derives from the persisted directed snapshot, and every proof
// below is taken from the PROMOTED artifact and from the records the worker
// persisted (manifest, render element map, proxy review).
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
// Word placement scans the plan's audible ranges in TIMELINE order and keeps one
// occurrence per range that fully contains the word (fix 8a494ff), so a source
// span played twice produces two occurrences and a reordered timeline reorders
// the evidence with it. Journey 1 keeps its three source spans DISJOINT so its
// expected values depend only on the arithmetic above; journey 2 exists to prove
// the repetition and reordering rules themselves.
// ---------------------------------------------------------------------------

const FPS = 30
const WORKSPACE_ID = 'workspace-transcript-rate'
const PROJECT_ID = 'project-transcript-rate'
const MASTER_ARTIFACT_ID = 'artifact-rate-master'
const MASTER_MANIFEST_ID = `manifest-${MASTER_ARTIFACT_ID}`
const MASTER_ARTIFACT_KEY = 'masters/rate-master.mp4'
const CREATED_AT = '2026-07-31T09:00:00.000Z'
const UPLOAD_RECEIVED_AT = '2026-07-31T09:00:00.000Z'

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

/**
 * Journey 2 timeline (180 frames, 6s) over the SAME master. It breaks both
 * assumptions journey 1 avoids on purpose:
 *
 *   clip-echo-a  src [60,120) -> timeline [0,60)     green  0-2s
 *   clip-back    src [0,60)   -> timeline [60,120)   red    2-4s   (reordered)
 *   clip-echo-b  src [60,120) -> timeline [120,180)  green  4-6s   (repeated span)
 *
 * The source plays green-after-red; the timeline plays green, red, green. Any
 * "first match wins" placement would silently drop the second green.
 */
const REPEAT_CLIPS = Object.freeze([
  Object.freeze({
    id: 'clip-echo-a', sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceInFrame: 60, sourceOutFrame: 120, timelineInFrame: 0, timelineOutFrame: 60, rate: 1,
  }),
  Object.freeze({
    id: 'clip-back', sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 60, timelineOutFrame: 120, rate: 1,
  }),
  Object.freeze({
    id: 'clip-echo-b', sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceInFrame: 60, sourceOutFrame: 120, timelineInFrame: 120, timelineOutFrame: 180, rate: 1,
  }),
])
const REPEAT_DURATION_FRAMES = 180

// Stated in SOURCE frames, in source chronology, exactly as a provider emits it.
const REPEAT_WORD_SOURCE_FRAMES = Object.freeze([
  ['meio', 10, 40], // only inside clip-back  -> one occurrence, in the MIDDLE
  ['eco', 66, 90], // inside clip-echo-a AND clip-echo-b -> two occurrences
  ['ausente', 246, 260], // no clip reads [240,300): dropped
])

// clip-echo-a: 0 + round(66-60)=6 .. 0 + round(90-60)=30
// clip-back:   60 + round(10-0)=70 .. 60 + round(40-0)=100
// clip-echo-b: 120 + round(66-60)=126 .. 120 + round(90-60)=150
const EXPECTED_REPEAT_WORDS = Object.freeze([
  ['eco', 6, 30],
  ['meio', 70, 100],
  ['eco', 126, 150],
])

// Gaps 30->70 (40 frames) and 100->126 (26 frames) both exceed 0.55s * 30 = 16.5,
// so no two words share a cue and the repeated word gets its own second cue.
const EXPECTED_REPEAT_CUES = Object.freeze([
  ['subtitle-cue-1', 6, 30, 'eco'],
  ['subtitle-cue-2', 70, 100, 'meio'],
  ['subtitle-cue-3', 126, 150, 'eco'],
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
const repeatReplacementTranscript = transcriptFromSourceFrames(REPEAT_WORD_SOURCE_FRAMES)

function baseVersion() {
  return createProjectVersion({
    id: 'version-base', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    sequence: 4, parentVersionId: 'version-parent',
    snapshotRefs: { brief: 'snapshot-brief', editPlan: 'snapshot-edit-plan', policies: 'snapshot-policies' },
    baseHash: 'a'.repeat(64), createdBy: 'client-transcript-rate', createdAt: CREATED_AT,
  })
}

function compiledEditPlan(clips = CLIPS, durationFrames = DURATION_FRAMES) {
  return {
    schemaVersion: 2, state: 'compiled', id: 'edit-plan-base', projectVersionId: 'version-base',
    storyPlanId: null, fps: FPS, durationFrames,
    sources: [{ id: 'source-1', artifactId: MASTER_ARTIFACT_ID, kind: 'video', durationSeconds: 12 }],
    videoTracks: [{ id: 'track-base', kind: 'base-video', clips: clips.map((clip) => ({ ...clip })) }],
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
  constructor(options = {}) {
    this.editPlan = options.editPlan ?? compiledEditPlan()
    this.replacement = options.replacement ?? replacementTranscript
  }

  committed
  async findIdempotentResult() { return this.committed ?? null }
  async readContext() {
    return {
      currentVersion: baseVersion(), editPlan: this.editPlan, editPlanHash: 'b'.repeat(64),
      currentTranscript: {
        id: 'transcript-current', transcriptHash: currentTranscript.transcriptHash,
        sourceArtifactId: MASTER_ARTIFACT_ID,
      },
      replacementTranscript: {
        id: 'transcript-replacement', transcriptHash: this.replacement.transcriptHash,
        sourceArtifactId: MASTER_ARTIFACT_ID, transcript: this.replacement,
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
        state: 'present', snapshotId: 'rights-rate-master',
        snapshotHash: 'e'.repeat(64), status: 'approved', consentStatus: 'not-required',
      },
      outputReferences: [
        { artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: this.currentVersion.id, variantId: '9:16' },
      ],
      transcript: {
        id: 'transcript-replacement', sourceArtifactId: MASTER_ARTIFACT_ID, language: 'pt-BR',
        provider: 'groq', model: 'whisper-large-v3',
        transcriptHash: this.editPlan.retimedTranscript.sourceTranscriptHash,
      },
    }
  }

  async commitOrReplay(bundle) {
    this.lastBundle = bundle
    const impact = parseDirectorRunImpact(bundle.command.payload.impact)
    const result = Object.freeze({
      run: bundle.run, command: bundle.command, version: bundle.version,
      impact, invalidations: createDirectorRunInvalidations({ impact, createdAt: bundle.command.createdAt }),
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

const sourceEvidence = (plan) =>
  plan.retimedTranscript.words.map((word) => [word.text, word.sourceStartSeconds, word.sourceEndSeconds])

/**
 * Runs the replacement -> Director half of a journey and returns the PERSISTED
 * directed snapshot, which is the only thing the render half is allowed to read.
 */
async function directRetimedPlan(options) {
  const replacementRepository = new ReplacementRepository({
    editPlan: options.editPlan, replacement: options.replacement,
  })
  let replacementIds = 0
  const replace = replaceSourceTranscriptService({
    repository: replacementRepository,
    clock: () => new Date('2026-07-31T09:10:00.000Z'),
    createId: () => [
      `edit-command-replace-${options.suffix}`,
      `version-retimed-${options.suffix}`,
      `snapshot-retimed-${options.suffix}`,
    ][replacementIds++],
    createEventId: () => '123e4567-e89b-42d3-a456-426614174020',
  })
  const replacement = await replace({
    workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    baseVersionId: 'version-base', baseHash: 'a'.repeat(64),
    replacementTranscriptId: 'transcript-replacement',
    expectedTranscriptHash: options.replacement.transcriptHash,
    actor: proxyActor(),
    idempotencyKey: `transcript-rate-render-journey-${options.suffix}`,
  })
  const persisted = JSON.parse(replacement.snapshot.contentJson)
  const directorRepository = new DirectorRepository(persisted, replacement.version)
  const counters = new Map()
  let event = 0
  const runDirector = runProjectDirectorService({
    repository: directorRepository,
    clock: () => new Date('2026-07-31T09:20:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${options.suffix}-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    compileBrief: createEvidenceBoundBriefCompiler(),
  })
  const directed = await runDirector({
    workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    baseVersionId: replacement.version.id, baseHash: replacement.version.baseHash,
    actor: proxyActor(),
    idempotency: { key: `director-after-transcript-rate-replacement-${options.suffix}` },
    reason: 'Dirigir a composicao com a transcricao corrigida e retimada.',
  })
  const editPlanSnapshot = directed.snapshots.find((item) => item.kind === 'edit-plan')
  const directedPlan = JSON.parse(editPlanSnapshot.contentJson)
  assert.equal(editPlanSnapshot.contentHash, calculateVersionHash(directedPlan))
  return { replacement, persisted, directed, directedPlan, editPlanSnapshot }
}

function sequentialClock(start) {
  let current = Date.parse(start)
  return () => new Date((current += 100))
}

/**
 * Real V2 render half: enqueue-project-proxy-render (real service) writes the
 * operation context, the real worker claims it, resolves the colour pipeline,
 * drives FfmpegEditorialProxyRenderer over the master copied into the artifact
 * root, and promotes the result through LocalMediaUploadStorage.
 *
 * Only the persistence ports are in-memory; every decision under test — input
 * hash, render input, manifest, element map, review — is produced by production
 * code.
 */
async function renderThroughRealWorker(input) {
  const artifactRoot = join(input.root, 'artifacts')
  const masterTarget = join(artifactRoot, ...MASTER_ARTIFACT_KEY.split('/'))
  await mkdir(join(masterTarget, '..'), { recursive: true })
  await copyFile(input.masterPath, masterTarget)
  const masterBytes = await readFile(input.masterPath)
  const masterSha256 = createHash('sha256').update(masterBytes).digest('hex')

  const compilation = colorCompilation(MASTER_ARTIFACT_ID)
  const source = Object.freeze({
    projectId: PROJECT_ID,
    projectVersionId: input.projectVersionId,
    editPlanSnapshotId: input.editPlanSnapshotId,
    editPlanHash: input.editPlanHash,
    editPlan: input.directedPlan,
    format: '9:16',
    sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceManifestId: MASTER_MANIFEST_ID,
    sourceArtifactKey: MASTER_ARTIFACT_KEY,
    sourceSha256: masterSha256,
    renderSources: Object.freeze([Object.freeze({
      artifactId: MASTER_ARTIFACT_ID, manifestId: MASTER_MANIFEST_ID,
      artifactKey: MASTER_ARTIFACT_KEY, sha256: masterSha256, byteSize: masterBytes.byteLength,
      mediaType: 'video', container: 'mp4', role: 'source-master',
    })]),
    originalFileName: 'rate-master.mp4',
    uploadReceivedAt: UPLOAD_RECEIVED_AT,
    criticIssues: Object.freeze([]),
  })

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
      operation = retryOrFailPublicOperation(operation, command.error, command.now, command.nextAttemptAt)
      lease = undefined
      return record()
    },
  }

  const enqueued = await enqueueProjectProxyRenderService({
    projects: { async readCurrentSource() { return source } },
    colorPipelines,
    operations,
    clock: () => new Date('2026-07-31T09:25:00.000Z'),
    createId: (kind) => ({
      operation: `operation-${input.suffix}`,
      artifact: `artifact-${input.suffix}-proxy`,
      manifest: `manifest-${input.suffix}-proxy`,
    })[kind],
  })({
    workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    expectedProjectVersionId: input.projectVersionId,
    actor: proxyActor(),
    idempotencyKey: `proxy-${input.suffix}`,
  })

  const renderer = new FfmpegEditorialProxyRenderer({
    workRoot: join(input.root, `work-${input.suffix}`), ffmpegPath,
  })
  const realStorage = new LocalMediaUploadStorage(artifactRoot)
  const captured = { lutCleaned: 0, rendererCleaned: 0 }
  const deps = {
    async catalogOutput() {},
    operations,
    colorPipelines,
    luts: {
      async materialize() {
        return { selectionId: `selection-${input.suffix}`, selectionHash: '7'.repeat(64), lutPaths: {} }
      },
      async cleanup() { captured.lutCleaned += 1 },
    },
    projects: {
      async readImmutableSource(query) {
        assert.equal(query.workspaceId, WORKSPACE_ID)
        assert.equal(query.projectId, PROJECT_ID)
        assert.equal(query.projectVersionId, input.projectVersionId)
        assert.equal(query.editPlanSnapshotId, input.editPlanSnapshotId)
        assert.equal(query.sourceArtifactId, MASTER_ARTIFACT_ID)
        assert.equal(query.sourceManifestId, MASTER_MANIFEST_ID)
        return source
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
    clock: sequentialClock('2026-07-31T09:30:00.000Z'),
    leaseDurationMs: 120_000,
    heartbeatIntervalMs: 10_000,
  }

  const outcome = await runNextProjectProxyRenderOperationService(deps)(`worker-${input.suffix}`)
  return {
    ...captured, outcome, phases, source, compilation, masterSha256,
    enqueuedContext: enqueued.context, operation, artifactRoot,
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

const countFrames = (path) => Number(execFileSync(ffprobePath, [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path,
], { encoding: 'utf8', windowsHide: true }).trim())

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

// The caption band is a flat colour, so white pixels there can only be glyphs.
// Measured on this machine: 1337 white pixels inside a cue, 0 outside one.
const captionBandWhitePixels = (path, second) => {
  const raw = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
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

const subtitlesAtFrame = (map, frame) => map.elements
  .filter((item) => item.type === 'subtitle' && item.frame === frame)
  .map((item) => item.elementId)

async function writeColourMaster(masterPath) {
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
  assert.equal(countFrames(masterPath), 360, 'the colour master must hold exactly 360 source frames')
}

function assertWorkerContract(rendered, expected) {
  // The operation context the enqueue service persisted is the one the worker
  // executed, and its input hash is reproducible from the immutable source.
  assert.deepEqual(rendered.outcome, { operationId: expected.operationId, status: 'succeeded' })
  assert.equal(rendered.operation.status, 'succeeded')
  assert.deepEqual(rendered.phases, ['rendering', 'verifying', 'persisting'])
  assert.equal(rendered.enqueuedContext.kind, 'project-proxy-render')
  assert.equal(rendered.enqueuedContext.inputHash, rendered.expectedInputHash)
  assert.deepEqual(rendered.enqueuedContext.colorPipelineBindings, [{
    sourceArtifactId: MASTER_ARTIFACT_ID, sourceManifestId: MASTER_MANIFEST_ID,
    compilationId: rendered.compilation.id, compilationHash: rendered.compilation.compilationHash,
    pipelineHash: rendered.compilation.pipeline.pipelineHash,
  }])
  // The worker did not receive a hand-made render input: it materialized one
  // from the directed snapshot, with the master resolved under artifactRoot.
  assert.equal(rendered.renderInput.operationId, expected.operationId)
  assert.equal(rendered.renderInput.renderKind, 'proxy')
  assert.equal(rendered.renderInput.format, '9:16')
  assert.equal(rendered.renderInput.fps, FPS)
  assert.match(rendered.renderInput.audioTimelineHash, /^[a-f0-9]{64}$/)
  assert.equal(rendered.renderInput.audioTimelineHash, rendered.source.editPlan.audioTimelineHash)
  assert.deepEqual(rendered.renderInput.lutPaths, {})
  assert.equal(rendered.renderInput.sources.length, 1)
  assert.equal(
    rendered.renderInput.sources[0].path,
    join(rendered.artifactRoot, ...MASTER_ARTIFACT_KEY.split('/')),
  )
  assert.equal(rendered.renderInput.sources[0].colorPipelineCompilation.id, rendered.compilation.id)
  assert.deepEqual(
    rendered.renderInput.clips.map((clip) => clip.id),
    expected.clipIds,
  )
  assert.deepEqual(
    rendered.renderInput.subtitleCues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
    expected.cues.map((entry) => [...entry]),
  )

  // Manifest: recipe identity, content-addressed parameters and lineage.
  assert.equal(rendered.manifest.recipe.id, 'editorial-proxy')
  assert.equal(rendered.manifest.recipe.version, EDITORIAL_PROXY_RECIPE_VERSION)
  assert.equal(rendered.manifest.recipe.parametersHash, calculateCanonicalHash({
    inputHash: rendered.expectedInputHash,
    projectVersionId: expected.projectVersionId,
    editPlanSnapshotId: expected.editPlanSnapshotId,
    format: '9:16',
    colorPipelineBindings: rendered.enqueuedContext.colorPipelineBindings,
    rangeReuse: null,
    audioTimelineHash: rendered.renderInput.audioTimelineHash,
    projectLutSelectionId: expected.lutSelectionId,
    projectLutSelectionHash: '7'.repeat(64),
    materializedCubeHash: null,
  }))
  assert.equal(rendered.manifest.artifact.artifactKey, rendered.stored.key)
  assert.equal(rendered.manifest.artifact.sha256, rendered.stored.sha256)
  assert.equal(rendered.manifest.artifact.byteSize, rendered.stored.byteSize)
  assert.equal(rendered.manifest.artifact.container, 'mp4')
  assert.equal(rendered.manifest.probe.width, 540)
  assert.equal(rendered.manifest.probe.height, 960)
  assert.deepEqual(
    rendered.manifest.sources.map((item) => [item.artifactKey, item.sha256, item.role]),
    [[MASTER_ARTIFACT_KEY, rendered.masterSha256, 'source-master']],
  )
  assert.equal(rendered.lineageIds.length, 1)

  // Element map and review are persisted against the SAME artifact identity.
  assert.equal(rendered.elementMapTarget.proxyArtifactId, expected.outputArtifactId)
  assert.equal(rendered.elementMap.proxyHash, rendered.stored.sha256)
  assert.equal(rendered.elementMap.durationFrames, expected.durationFrames)
  assert.deepEqual(rendered.elementMap.canvas, { width: 540, height: 960 })
  assert.equal(rendered.review.proxyArtifactId, expected.outputArtifactId)
  assert.equal(rendered.review.inputHash, rendered.expectedInputHash)
  assert.equal(rendered.review.spec.codec, 'h264')
  assert.equal(rendered.review.spec.width, 540)
  assert.equal(rendered.review.spec.height, 960)
  assert.deepEqual(rendered.review.technicalIssues, [])
  assert.equal(rendered.review.status, 'ready-for-final')
  assert.equal(rendered.review.finalAllowed, true)
  assert.equal(rendered.review.timeToFirstProxyMs >= 1_800_000, true)
  assert.deepEqual(rendered.attached, {
    workspaceId: WORKSPACE_ID, operationId: expected.operationId, projectId: PROJECT_ID,
    projectVersionId: expected.projectVersionId, variantId: '9:16',
    outputArtifactId: expected.outputArtifactId, outputManifestId: expected.outputManifestId,
    originalFileName: 'rate-master-editorial.mp4', createdAt: rendered.attached.createdAt,
  })
  // The worker always releases the renderer scratch space and the LUT selection.
  assert.equal(rendered.rendererCleaned, 1)
  assert.equal(rendered.lutCleaned, 1)
}

test('T-FR-233 retimed transcript drives the Director, the real V2 worker and the promoted MP4 at rates 1, 2 and 0.5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-transcript-rate-render-'))
  const masterPath = join(root, 'rate-master.mp4')
  try {
    // -----------------------------------------------------------------------
    // 0. Real source media: 12s, six 2s colour segments, sine audio.
    // -----------------------------------------------------------------------
    await writeColourMaster(masterPath)

    // -----------------------------------------------------------------------
    // 1. replace-source-transcript: immutable evidence in, retimed frames out.
    // -----------------------------------------------------------------------
    const journey = await directRetimedPlan({
      suffix: 'rate', editPlan: compiledEditPlan(), replacement: replacementTranscript,
    })
    const { replacement, persisted, directed, directedPlan, editPlanSnapshot } = journey
    assert.equal(replacement.command.type, 'replace-source-transcript')
    assert.deepEqual(retimed(replacement.editPlan), EXPECTED_RETIMED_WORDS.map((entry) => [...entry]))
    assert.equal(replacement.impact.renderBlockedUntilDirectorRun, true)
    assert.deepEqual(replacement.impact.affectedRanges, [{ startFrame: 0, endFrame: DURATION_FRAMES }])

    // 2. The persistable snapshot carries the retimed frames, not memory state.
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
    // 4. The REAL V2 worker renders that persisted snapshot end to end.
    // -----------------------------------------------------------------------
    const rendered = await renderThroughRealWorker({
      root, masterPath, suffix: 'rate',
      projectVersionId: directed.version.id,
      editPlanSnapshotId: editPlanSnapshot.id,
      editPlanHash: editPlanSnapshot.contentHash,
      directedPlan,
    })
    assertWorkerContract(rendered, {
      operationId: 'operation-rate',
      outputArtifactId: 'artifact-rate-proxy',
      outputManifestId: 'manifest-rate-proxy',
      projectVersionId: directed.version.id,
      editPlanSnapshotId: editPlanSnapshot.id,
      lutSelectionId: 'selection-rate',
      durationFrames: DURATION_FRAMES,
      clipIds: ['clip-unit', 'clip-fast', 'clip-slow'],
      cues: EXPECTED_CUES,
    })

    // Every proof below reads the PROMOTED artifact, not the renderer scratch
    // file: the worker deletes its work directory in `finally`.
    const proxyPath = rendered.stored.path
    const proxyBytes = await readFile(proxyPath)
    assert.equal(createHash('sha256').update(proxyBytes).digest('hex'), rendered.manifest.artifact.sha256)

    // Container-level truth.
    assert.equal(rendered.manifest.probe.width, 540)
    assert.equal(rendered.manifest.probe.height, 960)
    assert.ok(Math.abs(rendered.manifest.probe.fps - FPS) <= 0.01, `fps ${rendered.manifest.probe.fps}`)
    assert.ok(
      Math.abs(rendered.manifest.probe.duration - DURATION_FRAMES / FPS) <= 0.1,
      `240 timeline frames must last 8s, got ${rendered.manifest.probe.duration}`,
    )
    // Exact frame count: 60 source frames read at rate 1, 120 at rate 2 and 60
    // at rate 0.5 must produce exactly 240 rendered frames.
    const countedFrames = countFrames(proxyPath)
    assert.equal(
      countedFrames, DURATION_FRAMES,
      `directed proxy must hold exactly ${DURATION_FRAMES} frames, ffprobe counted ${countedFrames}`,
    )

    // Audio survived the atempo chain of both retimed clips.
    const audioAnalysis = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', proxyPath,
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
    for (const [second, dominant, label] of [
      [0.5, 0, 'rate 1 red'],
      [1.5, 0, 'rate 1 red'],
      [2.5, 2, 'rate 2 blue compressed from source 4-6s'],
      [3.5, 0, 'rate 2 red compressed from source 6-8s'],
      [4.5, 1, 'rate 0.5 green expanded from source 9-10s'],
      [5.5, 1, 'rate 0.5 green still on screen'],
      [6.5, 2, 'rate 0.5 blue expanded from source 10-11s'],
      [7.5, 2, 'rate 0.5 blue still on screen'],
    ]) assertDominantChannel(proxyPath, second, dominant, label)

    // -----------------------------------------------------------------------
    // 6. Visual proof that the Director's cues — derived from the retimed
    // words — are burned into the caption band at the retimed instants.
    // -----------------------------------------------------------------------
    // subtitle-cue-1 covers frames 6..40 (0.20s-1.33s) over the red segment;
    // subtitle-cue-4 covers frames 132..156 (4.40s-5.20s) over the green one.
    for (const [second, label] of [[0.5, 'subtitle-cue-1'], [4.8, 'subtitle-cue-4']]) {
      const white = captionBandWhitePixels(proxyPath, second)
      assert.ok(white >= 100, `${label} must be burned at ${second}s, only ${white} white pixels`)
    }
    // Frames 40..63 (1.33s-2.10s) and 156..192 (5.20s-6.40s) carry no cue.
    for (const [second, label] of [[1.7, 'gap after subtitle-cue-1'], [5.7, 'gap after subtitle-cue-4']]) {
      const white = captionBandWhitePixels(proxyPath, second)
      assert.ok(white <= 10, `${label} at ${second}s must stay clean, found ${white} white pixels`)
    }
    // Structural mirror of the same fact inside the reviewable element map.
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 15), ['subtitle:subtitle-cue-1'])
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 140), ['subtitle:subtitle-cue-4'])
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 51), [])
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 171), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-233 a repeated and reordered timeline keeps every occurrence of the same source evidence through the real worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-transcript-repeat-render-'))
  const masterPath = join(root, 'rate-master.mp4')
  try {
    await writeColourMaster(masterPath)

    // -----------------------------------------------------------------------
    // 1. Same replacement service, timeline that plays one source span twice
    //    and puts an earlier span between the two occurrences.
    // -----------------------------------------------------------------------
    const journey = await directRetimedPlan({
      suffix: 'repeat',
      editPlan: compiledEditPlan(REPEAT_CLIPS, REPEAT_DURATION_FRAMES),
      replacement: repeatReplacementTranscript,
    })
    const { persisted, directed, directedPlan, editPlanSnapshot } = journey

    // `eco` is spoken ONCE in the master and played TWICE by the timeline, so
    // the retimed evidence must contain it twice, at two distinct positions.
    assert.deepEqual(retimed(persisted), EXPECTED_REPEAT_WORDS.map((entry) => [...entry]))
    assert.equal(persisted.retimedTranscript.words.filter((word) => word.text === 'eco').length, 2)
    assert.equal(
      persisted.retimedTranscript.words.some((word) => word.text === 'ausente'), false,
      'ausente sits in source frames no clip reads and must not reach the timeline',
    )
    // Order follows the TIMELINE, not the source chronology: `meio` is the
    // earliest word in the master (source 0.32s) yet plays second (frame 70).
    const timelineStarts = persisted.retimedTranscript.words.map((word) => word.timelineStartFrame)
    assert.deepEqual(timelineStarts, [6, 70, 126])
    assert.deepEqual([...timelineStarts].toSorted((left, right) => left - right), timelineStarts)
    assert.deepEqual(
      persisted.retimedTranscript.words.map((word) => word.sourceStartSeconds),
      [startSecondsForFrame(66), startSecondsForFrame(10), startSecondsForFrame(66)],
    )
    // The two occurrences carry byte-identical source evidence: only placement
    // differs. Source seconds are never rewritten by the retiming.
    assert.deepEqual(sourceEvidence(persisted), [
      ['eco', startSecondsForFrame(66), endSecondsForFrame(90)],
      ['meio', startSecondsForFrame(10), endSecondsForFrame(40)],
      ['eco', startSecondsForFrame(66), endSecondsForFrame(90)],
    ])

    // -----------------------------------------------------------------------
    // 2. The Director turns those three occurrences into three cues — the
    //    repeat is NOT collapsed into the first one, and no cue overlaps.
    // -----------------------------------------------------------------------
    const cues = directedPlan.subtitleTracks.flatMap((track) => track.cues)
    assert.deepEqual(
      cues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
      EXPECTED_REPEAT_CUES.map((entry) => [...entry]),
    )
    for (const [index, cue] of cues.entries()) {
      if (index > 0) assert.ok(cue.startFrame >= cues[index - 1].endFrame, 'cues must not overlap')
      assert.ok(cue.endFrame > cue.startFrame, 'a collapsed cue would be empty')
    }
    assert.equal(directed.run.perception.timeline.durationMs, 6_000)
    assert.deepEqual(
      directed.run.perception.timeline.observations.map((item) => [item.value.text, item.startMs, item.endMs]),
      [['eco', 200, 1_000], ['meio', 2_333, 3_333], ['eco', 4_200, 5_000]],
    )

    // -----------------------------------------------------------------------
    // 3. Same real worker, same real FFmpeg: the repetition reaches the pixels.
    // -----------------------------------------------------------------------
    const rendered = await renderThroughRealWorker({
      root, masterPath, suffix: 'repeat',
      projectVersionId: directed.version.id,
      editPlanSnapshotId: editPlanSnapshot.id,
      editPlanHash: editPlanSnapshot.contentHash,
      directedPlan,
    })
    assertWorkerContract(rendered, {
      operationId: 'operation-repeat',
      outputArtifactId: 'artifact-repeat-proxy',
      outputManifestId: 'manifest-repeat-proxy',
      projectVersionId: directed.version.id,
      editPlanSnapshotId: editPlanSnapshot.id,
      lutSelectionId: 'selection-repeat',
      durationFrames: REPEAT_DURATION_FRAMES,
      clipIds: ['clip-echo-a', 'clip-back', 'clip-echo-b'],
      cues: EXPECTED_REPEAT_CUES,
    })

    const proxyPath = rendered.stored.path
    assert.equal(countFrames(proxyPath), REPEAT_DURATION_FRAMES)
    assert.ok(
      Math.abs(rendered.manifest.probe.duration - REPEAT_DURATION_FRAMES / FPS) <= 0.1,
      `180 timeline frames must last 6s, got ${rendered.manifest.probe.duration}`,
    )

    // The master plays red then green; this timeline plays green, red, green.
    // Source chronology alone could never produce this pixel sequence.
    for (const [second, dominant, label] of [
      [0.5, 1, 'clip-echo-a green from source 2-4s'],
      [1.5, 1, 'clip-echo-a green still on screen'],
      [2.5, 0, 'clip-back red from source 0-2s, played AFTER the green'],
      [3.5, 0, 'clip-back red still on screen'],
      [4.5, 1, 'clip-echo-b green: the same source span replayed'],
      [5.5, 1, 'clip-echo-b green still on screen'],
    ]) assertDominantChannel(proxyPath, second, dominant, label)

    // `eco` is burned at BOTH occurrences (frames 6..30 = 0.20s-1.00s and
    // 126..150 = 4.20s-5.00s). Before fix 8a494ff the second one did not exist.
    for (const [second, label] of [[0.5, 'subtitle-cue-1 eco'], [4.5, 'subtitle-cue-3 eco repeated']]) {
      const white = captionBandWhitePixels(proxyPath, second)
      assert.ok(white >= 100, `${label} must be burned at ${second}s, only ${white} white pixels`)
    }
    // Frames 30..70 (1.00s-2.33s) and 100..126 (3.33s-4.20s) carry no cue.
    for (const [second, label] of [[1.8, 'gap after subtitle-cue-1'], [3.8, 'gap after subtitle-cue-2']]) {
      const white = captionBandWhitePixels(proxyPath, second)
      assert.ok(white <= 10, `${label} at ${second}s must stay clean, found ${white} white pixels`)
    }
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 15), ['subtitle:subtitle-cue-1'])
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 85), ['subtitle:subtitle-cue-2'])
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 135), ['subtitle:subtitle-cue-3'])
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 55), [])
    assert.deepEqual(subtitlesAtFrame(rendered.elementMap, 110), [])
    // The two `eco` cues are distinct elements at distinct frames: the burned
    // caption band is not one long cue stretched over the middle word.
    const echoFrames = rendered.elementMap.elements
      .filter((item) => item.type === 'subtitle' && item.elementId !== 'subtitle:subtitle-cue-2')
      .map((item) => item.frame)
    assert.equal(echoFrames.some((frame) => frame >= 30 && frame < 126), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
