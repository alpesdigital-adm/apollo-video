import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  createContiguousExtractionService,
  readContiguousExtractionService,
} from '../../src/v2/application/contiguous-extraction.ts'
import { produceContiguousEvidenceService } from '../../src/v2/application/contiguous-evidence.ts'
import { produceContiguousEvaluationsService } from '../../src/v2/application/contiguous-evaluation.ts'
import { enqueueProjectProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import {
  calculateContiguousMomentEvaluationHash,
  createContiguousMomentEvaluation,
} from '../../src/v2/domain/contiguous-extraction.ts'
import { createLongFormMomentTranscriptEvidence } from '../../src/v2/domain/long-form-transcript-evidence.ts'
import {
  advancePublicOperationPhase,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { AudioContiguousEvidenceAnalyzer } from '../../src/v2/infrastructure/analysis/audio-contiguous-evidence-analyzer.ts'
import { DeterministicContiguousEvaluationProvider } from '../../src/v2/infrastructure/analysis/deterministic-contiguous-evaluation-provider.ts'
import { FfmpegContiguousAudioEvidenceProvider } from '../../src/v2/infrastructure/analysis/ffmpeg-contiguous-audio-evidence-provider.ts'
import { FfmpegContiguousVisualEvidenceProvider } from '../../src/v2/infrastructure/analysis/ffmpeg-contiguous-visual-evidence-provider.ts'
import { RightsIntegrityContiguousEvidenceAnalyzer } from '../../src/v2/infrastructure/analysis/rights-integrity-contiguous-evidence-analyzer.ts'
import {
  TranscriptBoundaryContiguousEvidenceAnalyzer,
  TranscriptDensityContiguousEvidenceAnalyzer,
} from '../../src/v2/infrastructure/analysis/transcript-contiguous-evidence-analyzers.ts'
import { VisualContiguousEvidenceAnalyzer } from '../../src/v2/infrastructure/analysis/visual-contiguous-evidence-analyzer.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import {
  LocalArtifactSourceMaterializer,
  LocalMediaUploadStorage,
} from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'
import { authenticationAudit } from './helpers/authentication-audit.mjs'

// ---------------------------------------------------------------------------
// T-FR-134 — one journey, one master, one proof.
//
//   real 2 h FFmpeg master (three colour periods + moving box + audible sine)
//     -> long-form index run + two semantic moments (transcript sidecar)
//     -> FIVE real evidence producers (boundary, density, rights, audio, visual)
//        — the audio and visual ones measure the real bytes through FFmpeg
//     -> DeterministicContiguousEvaluationProvider (production evaluator)
//     -> createContiguousExtractionService (production selection + persistence)
//     -> StoryPlan/EditPlan with EXACTLY one contiguous window
//     -> enqueueProjectProxyRenderService (real service, real input hash)
//     -> runNextProjectProxyRenderOperationService (the REAL V2 worker)
//     -> FfmpegEditorialProxyRenderer -> artifact promoted by LocalMediaUploadStorage
//     -> the promoted MP4 is probed and sampled pixel by pixel.
//
// Only the persistence ports are in-memory. Every decision under test —
// evidence facts, scores, objective tags, candidate ranking, rights filtering,
// StoryPlan/EditPlan compilation, render input hash, render input — is produced
// by production code.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

// Three frames per second keeps the master cheap while staying above the
// half-second window `freezedetect` uses: at 1 fps every held frame would be
// reported as frozen no matter how much the picture moves.
const FPS = 3
const WORKSPACE_ID = 'workspace-two-hour-golden'
const PROJECT_ID = 'project-two-hour-golden'
const CLIENT_ID = 'client-two-hour-golden'
const CREDENTIAL_ID = 'credential-two-hour-golden'
const INDEX_RUN_ID = 'long-form-index-run-golden'
const HIERARCHICAL_RUN_ID = 'hierarchical-run-golden'
const TRANSCRIPT_ID = 'transcript-two-hour-golden'
const MASTER_ARTIFACT_ID = 'artifact-two-hour-golden'
const MASTER_MANIFEST_ID = 'manifest-two-hour-golden'
const MASTER_ARTIFACT_KEY = 'masters/two-hour-golden.mp4'
const RIGHTS_SNAPSHOT_ID = 'rights-two-hour-golden'
const PROJECT_VERSION_ID = 'version-two-hour-golden'
const CREATED_AT = '2026-08-02T12:00:00.000Z'
const SOURCE_DURATION_MS = 7_200_000
const TOPIC = 'oferta de entrada'
const OBJECTIVE = 'discovery'
const TARGET_DURATION_MS = 120_000

// Colour periods of the master, in seconds. The renderer must land inside
// SELECTED and nowhere else, which is what the sampled pixels prove.
const DISTRACTOR_SECONDS = Object.freeze([120, 240])
const SELECTED_SECONDS = Object.freeze([3_540, 3_660])

const hex = (value) => value.repeat(64).slice(0, 64)
const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

function colorCompilation(artifactId) {
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: WORKSPACE_ID,
    artifactId, manifestId: MASTER_MANIFEST_ID,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: CREATED_AT,
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters,
    parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID, sourceArtifactId: artifactId,
    sourceManifestId: MASTER_MANIFEST_ID, probe, outputMetadata: colorMetadata,
    createdByClientId: CLIENT_ID, createdAt: '2026-08-02T12:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

// --------------------------- transcript sidecar ----------------------------

function span({ id, chunkId, sourceSegmentId, rangeMs, text }) {
  const textHash = calculateCanonicalHash(text)
  const content = {
    id,
    sourceSegmentId,
    rangeMs,
    text,
    textHash,
    wordCount: text.split(/\s+/u).filter(Boolean).length,
    chunkIds: [chunkId],
  }
  return Object.freeze({
    ...content,
    spanHash: calculateCanonicalHash(content),
  })
}

/**
 * Builds a contiguous run of aligned transcript spans. The first span starts
 * with a capital letter and the last one ends with terminal punctuation, so the
 * production boundary analyzer can observe a self-contained window instead of
 * being handed a verdict.
 */
function transcriptSpans({ prefix, rangeMs, spanCount, wordsPerSpan }) {
  const stepMs = (rangeMs[1] - rangeMs[0]) / spanCount
  return Array.from({ length: spanCount }, (_unused, index) => {
    const words = Array.from(
      { length: wordsPerSpan - 1 },
      (_ignored, position) => `palavra${index}x${position}`,
    )
    const sentence = `Oferta ${words.join(' ')}.`
    return span({
      id: `${prefix}-span-${index}`,
      chunkId: `${prefix}-chunk-${index}`,
      sourceSegmentId: index,
      rangeMs: [
        Math.round(rangeMs[0] + index * stepMs),
        Math.round(rangeMs[0] + (index + 1) * stepMs),
      ],
      text: sentence,
    })
  })
}

function transcriptEvidence({ momentId, momentHash, prefix, rangeMs, spanCount, wordsPerSpan }) {
  return createLongFormMomentTranscriptEvidence({
    id: `${momentId}-transcript-evidence`,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    indexRunId: INDEX_RUN_ID,
    indexRunHash: hex('a'),
    momentId,
    momentHash,
    hierarchicalRunId: HIERARCHICAL_RUN_ID,
    hierarchicalRunHash: hex('7'),
    sourceTranscriptId: TRANSCRIPT_ID,
    sourceTranscriptHash: hex('8'),
    spans: transcriptSpans({ prefix, rangeMs, spanCount, wordsPerSpan }),
  })
}

// ------------------------------- pixel proof -------------------------------

async function samplePixel(filePath, seconds) {
  const { stdout } = await execFileAsync(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(seconds), '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=1:1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 },
  )
  assert.equal(stdout.byteLength, 3)
  return [...stdout]
}

function assertGold(pixel, label) {
  const [red, green, blue] = pixel
  assert.ok(
    red >= 170 && green >= 120 && blue <= 130,
    `${label} must preserve the gold semantic window; got rgb(${pixel.join(',')})`,
  )
}

function assertBlue(pixel, label) {
  const [red, green, blue] = pixel
  assert.ok(
    blue > red + 40 && blue > green + 20,
    `${label} must sit inside the blue distractor window; got rgb(${pixel.join(',')})`,
  )
}

function assertDark(pixel, label) {
  assert.ok(
    Math.max(...pixel) <= 70,
    `${label} must remain outside every semantic window; got rgb(${pixel.join(',')})`,
  )
}

/**
 * Two hours of real media: a dark base, a blue distractor window, a gold
 * selected window, a box that moves every second so the visual analyzer cannot
 * report a frozen picture, and an audible sine so the loudness analyzer cannot
 * report silence.
 */
async function writeTwoHourMaster(masterPath) {
  await execFileAsync(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', [
        `color=c=#10151b:s=160x90:r=${FPS}:d=7200`,
        `drawbox=x=0:y=0:w=iw:h=ih:color=#2d5fa8:t=fill:enable='between(t,${DISTRACTOR_SECONDS[0]},${DISTRACTOR_SECONDS[1]})'`,
        `drawbox=x=0:y=0:w=iw:h=ih:color=#d9aa3d:t=fill:enable='between(t,${SELECTED_SECONDS[0]},${SELECTED_SECONDS[1]})'`,
        // The marker jumps sides on every frame (parity of `n`, never of `t`,
        // so no rounding ever repeats a frame): the picture is never frozen and
        // the lit area stays constant, which keeps the sampled average colour
        // of each period stable.
        "drawbox=x=8:y=37:w=16:h=16:color=white:t=fill:enable='lt(mod(n,2),1)'",
        "drawbox=x=120:y=37:w=16:h=16:color=white:t=fill:enable='gte(mod(n,2),1)'",
      ].join(','),
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=7200',
      '-af', 'volume=0.5',
      '-shortest',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '24k', '-ar', '16000',
      masterPath,
    ],
    { windowsHide: true, timeout: 480_000, maxBuffer: 4 * 1024 * 1024 },
  )
}

// ------------------------------- actors/fence ------------------------------

function apiActor() {
  return Object.freeze({
    clientId: CLIENT_ID,
    credentialId: CREDENTIAL_ID,
    workspaceId: WORKSPACE_ID,
    environment: 'production',
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext: createExternalAuditContext({
      clientId: CLIENT_ID,
      credentialId: CREDENTIAL_ID,
      workspaceId: WORKSPACE_ID,
      environment: 'production',
    }),
  })
}

const stageAudit = () => authenticationAudit({
  clientId: CLIENT_ID,
  credentialId: CREDENTIAL_ID,
  workspaceId: WORKSPACE_ID,
})

const momentsFence = Object.freeze({
  workspaceId: WORKSPACE_ID,
  projectId: PROJECT_ID,
  workflowId: 'workflow-two-hour-golden',
  operationId: 'operation-two-hour-golden-moments',
  stage: 'moments',
  expectedStageInputHash: hex('e'),
  expectedStageIdempotencyKey: 'moments-two-hour-golden',
  leaseOwner: 'worker-two-hour-golden',
  operationAttempt: 1,
  now: CREATED_AT,
})

function sequentialClock(start) {
  let current = Date.parse(start)
  return () => new Date((current += 100))
}

// --------------------------- evidence stage (real) -------------------------

/**
 * One in-memory evidence repository shared by the five production producers,
 * exactly like `repository-factory` shares the Postgres one. It counts persists
 * so replay can be proven to add nothing.
 */
function evidenceRepositoryFor(sourceRef) {
  const runs = new Map()
  let persists = 0
  return {
    persists: () => persists,
    runs: () => [...runs.values()],
    repository: {
      async readSource() {
        return sourceRef.current
      },
      async findIdempotent(input) {
        const stored = runs.get(input.idempotencyKey)
        return stored &&
          stored.workspaceId === input.workspaceId &&
          stored.projectId === input.projectId &&
          stored.sourceIndexRunId === input.sourceIndexRunId &&
          stored.createdBy.id === input.createdByClientId
          ? stored
          : null
      },
      async persistWithLongFormLease({ run, fence }) {
        assert.equal(fence.stage, 'moments')
        persists += 1
        runs.set(run.idempotencyKey, run)
        return { run, replayed: false }
      },
    },
  }
}

function countingAnalyzer(analyzer, counters) {
  counters.set(analyzer.identity.kind, 0)
  return {
    identity: analyzer.identity,
    async analyze(source, signal) {
      counters.set(
        analyzer.identity.kind,
        counters.get(analyzer.identity.kind) + 1,
      )
      return analyzer.analyze(source, signal)
    },
  }
}

function evidenceProducers({ repository, artifactRoot, counters }) {
  const analyzers = [
    new TranscriptBoundaryContiguousEvidenceAnalyzer(),
    new TranscriptDensityContiguousEvidenceAnalyzer(),
    new RightsIntegrityContiguousEvidenceAnalyzer(),
    new AudioContiguousEvidenceAnalyzer(
      new FfmpegContiguousAudioEvidenceProvider({
        artifactRoot, ffmpegPath, timeoutMs: 300_000,
      }),
    ),
    new VisualContiguousEvidenceAnalyzer(
      new FfmpegContiguousVisualEvidenceProvider({
        artifactRoot, ffmpegPath, timeoutMs: 300_000,
      }),
    ),
  ]
  return analyzers.map((analyzer) => ({
    kind: analyzer.identity.kind,
    produce: produceContiguousEvidenceService({
      repository,
      analyzer: countingAnalyzer(analyzer, counters),
      createRunId: () => `evidence-run-${analyzer.identity.kind}`,
      createEvidenceId: (momentId) =>
        `${momentId}-${analyzer.identity.kind}-evidence`,
      clock: () => new Date(CREATED_AT),
    }),
  }))
}

async function runEvidenceStage(producers) {
  const runs = []
  for (const producer of producers) {
    runs.push(await producer.produce({
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      indexRunId: INDEX_RUN_ID,
      authenticationAudit: stageAudit(),
      fence: momentsFence,
      idempotencyKey: `evidence-${producer.kind}-two-hour-golden`,
    }))
  }
  return runs
}

// -------------------------- evaluation stage (real) ------------------------

function evaluationRepositoryFor(sourceRef) {
  const runs = new Map()
  let persists = 0
  return {
    persists: () => persists,
    repository: {
      async readSource() {
        return sourceRef.current
      },
      async findIdempotent(input) {
        const stored = runs.get(input.idempotencyKey)
        return stored &&
          stored.workspaceId === input.workspaceId &&
          stored.projectId === input.projectId &&
          stored.sourceIndexRunId === input.sourceIndexRunId &&
          stored.createdBy.id === input.createdByClientId
          ? stored
          : null
      },
      async persistWithLongFormLease({ run, fence }) {
        assert.equal(fence.stage, 'moments')
        persists += 1
        runs.set(run.idempotencyKey, run)
        return { run, replayed: false }
      },
    },
  }
}

// -------------------------- extraction stage (real) ------------------------

function extractionRepositoryFor(candidatesRef) {
  const stored = []
  const queries = []
  return {
    stored: () => stored,
    queries: () => queries,
    repository: {
      async findIdempotent(input) {
        return stored.find((value) =>
          value.result.workspaceId === input.workspaceId &&
          value.result.projectId === input.projectId &&
          value.createdBy.id === input.createdByClientId &&
          value.idempotencyKey === input.idempotencyKey,
        ) ?? null
      },
      async readCandidateMoments(input) {
        queries.push(input)
        return candidatesRef.current
      },
      async persist(value) {
        stored.push(value)
        return { extraction: value, replayed: false }
      },
      async read(input) {
        return stored.find((value) =>
          value.result.workspaceId === input.workspaceId &&
          value.result.projectId === input.projectId &&
          value.result.id === input.extractionId,
        ) ?? null
      },
    },
  }
}

/**
 * The single bridge in this journey: the contiguous EditPlan carries no
 * subtitle/overlay tracks and no `protectedOpeningFrames`, which the V2 proxy
 * worker requires from a compiled plan. Nothing editorial is invented here —
 * the clip, fps, duration and lineage all come from `extractContiguous`, and
 * the test asserts the bridged clip is byte-identical to the contiguous one.
 */
function compiledPlanFromContiguous(result) {
  const contiguous = result.editPlan
  const track = contiguous.videoTracks[0]
  return {
    schemaVersion: 2,
    state: 'compiled',
    id: contiguous.id,
    projectVersionId: PROJECT_VERSION_ID,
    storyPlanId: contiguous.storyPlanId,
    fps: contiguous.fps,
    durationFrames: contiguous.durationFrames,
    sources: contiguous.sources.map((source) => ({
      id: source.id,
      artifactId: source.artifactId,
      kind: 'video',
      durationSeconds: SOURCE_DURATION_MS / 1_000,
    })),
    videoTracks: [{
      id: track.id,
      kind: 'base-video',
      clips: track.clips.map((clip) => ({ ...clip })),
    }],
    overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [],
    markers: [], protectedElements: [], localeVariantRefs: [], formatVariantRefs: [],
    lineageRefs: [...contiguous.lineageRefs],
    movementPolicy: {
      automaticZoom: false,
      protectedOpeningFrames: Math.round(contiguous.fps * 4),
    },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 },
    createdAt: CREATED_AT,
  }
}

// ---------------------- render stage (real enqueue + worker) ---------------

/**
 * Real V2 render half: `enqueueProjectProxyRenderService` writes the operation
 * context, the real worker claims it, resolves the colour pipeline, drives
 * FfmpegEditorialProxyRenderer over the master under `artifactRoot` and
 * promotes the result through LocalMediaUploadStorage. The operation fake
 * honours idempotent replay, so a second enqueue can be proven not to render
 * the same window twice.
 */
function renderHarness(input) {
  const compilation = colorCompilation(MASTER_ARTIFACT_ID)
  const source = Object.freeze({
    projectId: PROJECT_ID,
    projectVersionId: PROJECT_VERSION_ID,
    editPlanSnapshotId: input.editPlanSnapshotId,
    editPlanHash: input.editPlanHash,
    editPlan: input.compiledPlan,
    format: '16:9',
    sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceManifestId: MASTER_MANIFEST_ID,
    sourceArtifactKey: MASTER_ARTIFACT_KEY,
    sourceSha256: input.masterSha256,
    renderSources: Object.freeze([Object.freeze({
      artifactId: MASTER_ARTIFACT_ID, manifestId: MASTER_MANIFEST_ID,
      artifactKey: MASTER_ARTIFACT_KEY, sha256: input.masterSha256,
      byteSize: input.masterByteSize, mediaType: 'video', container: 'mp4',
      role: 'source-master',
    })]),
    originalFileName: 'two-hour-golden.mp4',
    uploadReceivedAt: CREATED_AT,
    criticIssues: Object.freeze([]),
  })

  const colorPipelines = {
    async listForSource({ sourceArtifactId, sourceManifestId }) {
      return sourceArtifactId === MASTER_ARTIFACT_ID &&
        sourceManifestId === MASTER_MANIFEST_ID
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
  let replayKey
  let replayValue
  const phases = []
  const renders = { count: 0 }
  const record = () => ({ operation, context })
  const matches = (command) => lease && lease.owner === command.leaseOwner &&
    lease.attempt === command.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(command.now)
  const operations = {
    async findReplay(query) {
      const key = `${query.clientId}:${query.idempotencyKey}:${query.requestFingerprint}`
      return key === replayKey ? replayValue : null
    },
    async createOrReplay(created) {
      operation = created.operation
      context = created.context
      replayValue = {
        operation, context,
        authenticationAudit: created.authenticationAudit, replayed: true,
      }
      replayKey = [
        created.authenticationAudit.clientId,
        created.idempotencyKey,
        created.requestFingerprint,
      ].join(':')
      return { ...replayValue, replayed: false }
    },
    async claimNext(command) {
      assert.equal(command.type, 'project-proxy-render')
      if (!['queued', 'retrying'].includes(operation?.status)) return null
      operation = startPublicOperationAttempt(operation, command.now)
      lease = {
        owner: command.leaseOwner, attempt: operation.attempt,
        heartbeatAt: command.now, expiresAt: command.leaseUntil,
      }
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
      operation = retryOrFailPublicOperation(
        operation, command.error, command.now, command.nextAttemptAt,
      )
      lease = undefined
      return record()
    },
  }

  const enqueue = enqueueProjectProxyRenderService({
    projects: { async readCurrentSource() { return source } },
    colorPipelines,
    operations,
    clock: () => new Date('2026-08-02T12:25:00.000Z'),
    createId: (kind) => ({
      operation: 'operation-two-hour-golden-proxy',
      artifact: 'artifact-two-hour-golden-proxy',
      manifest: 'manifest-two-hour-golden-proxy',
    })[kind],
  })

  const renderer = new FfmpegEditorialProxyRenderer({
    workRoot: join(input.root, 'render-work'), ffmpegPath,
  })
  const realStorage = new LocalMediaUploadStorage(input.artifactRoot)
  const captured = { rendererCleaned: 0 }
  const worker = runNextProjectProxyRenderOperationService({
    async catalogOutput() {},
    operations,
    colorPipelines,
    luts: {
      async materialize() {
        return {
          selectionId: 'selection-two-hour-golden',
          selectionHash: '7'.repeat(64),
          lutPaths: {},
        }
      },
      async cleanup() {},
    },
    projects: {
      async readImmutableSource(query) {
        assert.equal(query.workspaceId, WORKSPACE_ID)
        assert.equal(query.projectId, PROJECT_ID)
        assert.equal(query.projectVersionId, PROJECT_VERSION_ID)
        assert.equal(query.editPlanSnapshotId, input.editPlanSnapshotId)
        return source
      },
      async attachCompletedOutput(attached) { captured.attached = attached },
    },
    artifacts: {
      async persistOrReplay(persist) {
        captured.manifest = persist.manifest
        captured.lineageIds = persist.lineageIds
        return {
          artifactId: persist.artifactId,
          manifestId: persist.manifestId,
          replayed: false,
        }
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
        renders.count += 1
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
        return { record: {}, replayed: false }
      },
    },
    proxyReviews: {
      async persistGenerated(persist) {
        captured.review = persist.review
        return { ...persist.review, id: persist.id }
      },
    },
    sources: new LocalArtifactSourceMaterializer(input.artifactRoot),
    clock: sequentialClock('2026-08-02T12:30:00.000Z'),
    leaseDurationMs: 600_000,
    heartbeatIntervalMs: 30_000,
  })

  return {
    enqueue, worker, captured, phases, renders, source, compilation,
    operation: () => operation,
    cleanup: () => renderer.cleanup('operation-two-hour-golden-proxy'),
    expectedInputHash: () => projectProxyRenderInputHash({
      source,
      colorPipelineBindings: [{
        sourceArtifactId: MASTER_ARTIFACT_ID,
        sourceManifestId: MASTER_MANIFEST_ID,
        compilationId: compilation.id,
        compilationHash: compilation.compilationHash,
        pipelineHash: compilation.pipeline.pipelineHash,
      }],
    }),
  }
}

const observationOf = (value, reference) => ({
  value, evidenceRefs: [reference],
})

/**
 * A moment whose rights snapshot was revoked after the evaluation run, scored
 * 1.0 on every dimension so it would outrank the honest window if the rights
 * gate could be bypassed.
 */
function rightsBlockedMoment(masterSha256) {
  const reference = 'evidence-golden-rights-blocked'
  return createContiguousMomentEvaluation({
    id: 'moment-golden-rights-blocked',
    momentHash: hex('9'),
    evaluationId: 'evaluation-golden-rights-blocked',
    evaluationProducer: {
      provider: 'apollo', model: 'contiguous-evidence-policy', version: '1.0.0',
      inputHash: hex('4'), outputHash: hex('5'),
    },
    indexRunId: INDEX_RUN_ID,
    sourceArtifactId: MASTER_ARTIFACT_ID,
    sourceArtifactSha256: masterSha256,
    sourceManifestId: MASTER_MANIFEST_ID,
    sourceManifestHash: hex('c'),
    chapterId: 'chapter-golden-rights-blocked',
    topic: TOPIC,
    objectiveTags: [OBJECTIVE],
    recommendedRangeMs: [600_000, 720_000],
    semanticRangeMs: [600_000, 720_000],
    sourceDurationMs: SOURCE_DURATION_MS,
    rightsSnapshotId: 'rights-golden-revoked',
    rightsStatus: 'blocked',
    consentStatus: 'approved',
    scores: {
      selfContained: observationOf(1, reference),
      density: observationOf(1, reference),
      integrity: observationOf(1, reference),
      audio: observationOf(1, reference),
      visual: observationOf(1, reference),
    },
  })
}

test(
  'T-FR-134 golden crosses index run, evidence, evaluation, selection, worker and renderer to one two-minute MP4 out of a real two-hour master',
  { timeout: 1_500_000 },
  async (t) => {
    assert.equal(typeof ffmpegPath, 'string')
    const root = await mkdtemp(join(tmpdir(), 'apollo-contiguous-two-hour-golden-'))
    const artifactRoot = join(root, 'artifacts')
    const masterPath = join(artifactRoot, ...MASTER_ARTIFACT_KEY.split('/'))
    await mkdir(join(masterPath, '..'), { recursive: true })
    let harness
    try {
      // ---------------------------------------------------------------- master
      await writeTwoHourMaster(masterPath)
      const [masterProbe, masterSha256, masterStat] = await Promise.all([
        probeVideo(masterPath, { requireAudio: true }),
        calculateFileSha256(masterPath),
        stat(masterPath),
      ])
      const masterByteSize = masterStat.size.toString()

      await t.test('the master is two real hours with three distinct periods', async () => {
        assert.ok(Math.abs(masterProbe.duration - 7_200) <= 0.5)
        assert.equal(masterProbe.fps, FPS)
        assertDark(await samplePixel(masterPath, 60), 'master before every window')
        assertBlue(await samplePixel(masterPath, 200), 'master inside the distractor window')
        assertDark(await samplePixel(masterPath, SELECTED_SECONDS[0] - 1), 'master just before the selected window')
        assertGold(await samplePixel(masterPath, SELECTED_SECONDS[0] + 1), 'master just inside the selected window')
        assertGold(await samplePixel(masterPath, SELECTED_SECONDS[1] - 1), 'master just before the selected window ends')
        assertDark(await samplePixel(masterPath, SELECTED_SECONDS[1] + 1), 'master just after the selected window')
        t.diagnostic(`master duration=${masterProbe.duration}s fps=${masterProbe.fps} bytes=${masterByteSize}`)
      })

      // ------------------------------------------------- index run + moments
      const selectedMomentId = 'moment-golden-selected'
      const distractorMomentId = 'moment-golden-distractor'
      const evidenceSource = {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        indexRunId: INDEX_RUN_ID,
        indexRunHash: hex('a'),
        sourceArtifactId: MASTER_ARTIFACT_ID,
        sourceArtifactSha256: masterSha256,
        sourceArtifactKey: MASTER_ARTIFACT_KEY,
        sourceArtifactByteSize: masterByteSize,
        sourceManifestId: MASTER_MANIFEST_ID,
        sourceManifestHash: hex('c'),
        sourceDurationMs: SOURCE_DURATION_MS,
        rightsSnapshotId: RIGHTS_SNAPSHOT_ID,
        rightsStatus: 'approved',
        consentStatus: 'not-required',
        moments: [
          {
            // Boundaries already aligned to the semantic window.
            id: selectedMomentId,
            momentHash: hex('d'),
            recommendedRangeMs: [SELECTED_SECONDS[0] * 1_000, SELECTED_SECONDS[1] * 1_000],
            transcriptEvidence: transcriptEvidence({
              momentId: selectedMomentId,
              momentHash: hex('d'),
              prefix: 'selected',
              rangeMs: [SELECTED_SECONDS[0] * 1_000, SELECTED_SECONDS[1] * 1_000],
              spanCount: 12,
              wordsPerSpan: 24,
            }),
          },
          {
            // Boundaries NARROWER than the semantic speech: the evaluator has to
            // expand them to the sentence edges to reach the target duration.
            id: distractorMomentId,
            momentHash: hex('b'),
            recommendedRangeMs: [
              DISTRACTOR_SECONDS[0] * 1_000 + 2_000,
              DISTRACTOR_SECONDS[1] * 1_000 - 2_000,
            ],
            transcriptEvidence: transcriptEvidence({
              momentId: distractorMomentId,
              momentHash: hex('b'),
              prefix: 'distractor',
              rangeMs: [DISTRACTOR_SECONDS[0] * 1_000, DISTRACTOR_SECONDS[1] * 1_000],
              spanCount: 12,
              wordsPerSpan: 12,
            }),
          },
        ],
      }
      const evidenceSourceRef = { current: evidenceSource }
      const analyzerCalls = new Map()
      const evidenceStore = evidenceRepositoryFor(evidenceSourceRef)
      const producers = evidenceProducers({
        repository: evidenceStore.repository,
        artifactRoot,
        counters: analyzerCalls,
      })

      let evidenceRuns
      await t.test('five production evidence producers measure the real bytes of both windows', async () => {
        evidenceRuns = await runEvidenceStage(producers)
        assert.equal(evidenceRuns.length, 5)
        assert.deepEqual(
          evidenceRuns.map((entry) => entry.run.analyzer.kind).sort(),
          [
            'audio-analysis', 'rights-integrity', 'transcript-boundary',
            'transcript-density', 'visual-analysis',
          ],
        )
        assert.ok(evidenceRuns.every((entry) => entry.replayed === false))
        assert.equal(evidenceStore.persists(), 5)
        for (const entry of evidenceRuns) {
          assert.equal(entry.run.evidence.length, 2)
        }
        const audio = evidenceRuns
          .find((entry) => entry.run.analyzer.kind === 'audio-analysis')
          .run.evidence.find((item) => item.sourceMomentId === selectedMomentId)
        const visual = evidenceRuns
          .find((entry) => entry.run.analyzer.kind === 'visual-analysis')
          .run.evidence.find((item) => item.sourceMomentId === selectedMomentId)
        assert.equal(audio.facts.audibleSignal, true)
        assert.equal(audio.facts.sourceChecksumVerified, true)
        assert.equal(visual.facts.sourceChecksumVerified, true)
        assert.equal(visual.facts.sampledFrameCount, 120 * FPS)
        assert.ok(visual.facts.blackRatio < 0.98)
        assert.ok(
          visual.facts.freezeRatio < 0.5,
          `the selected window must not read as frozen; got ${visual.facts.freezeRatio}`,
        )
        t.diagnostic(
          `selected audio lufs=${audio.facts.integratedLufs} silenceRatio=${audio.facts.silenceRatio} | ` +
          `visual frames=${visual.facts.sampledFrameCount} luma=${visual.facts.averageLuma} ` +
          `black=${visual.facts.blackRatio} freeze=${visual.facts.freezeRatio}`,
        )
      })

      await t.test('rights cannot be bypassed at the evidence stage', async () => {
        const persistsBefore = evidenceStore.persists()
        evidenceSourceRef.current = { ...evidenceSource, rightsStatus: 'blocked' }
        const rightsProducer = producers.find((item) => item.kind === 'rights-integrity')
        await assert.rejects(
          rightsProducer.produce({
            workspaceId: WORKSPACE_ID,
            projectId: PROJECT_ID,
            indexRunId: INDEX_RUN_ID,
            authenticationAudit: stageAudit(),
            fence: momentsFence,
            idempotencyKey: 'evidence-rights-integrity-blocked-golden',
          }),
          (error) => ['PERSISTENCE_CONFLICT', 'ASSET_RIGHTS_BLOCKED'].includes(error.code),
        )
        await assert.rejects(
          new RightsIntegrityContiguousEvidenceAnalyzer().analyze(
            evidenceSourceRef.current,
            new AbortController().signal,
          ),
          (error) => error.code === 'ASSET_RIGHTS_BLOCKED',
        )
        evidenceSourceRef.current = evidenceSource
        assert.equal(evidenceStore.persists(), persistsBefore)
      })

      // ------------------------------------------------------ evaluation stage
      const evaluationSourceRef = {
        current: {
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          indexRunId: INDEX_RUN_ID,
          indexRunHash: hex('a'),
          sourceArtifactId: MASTER_ARTIFACT_ID,
          sourceArtifactSha256: masterSha256,
          sourceManifestId: MASTER_MANIFEST_ID,
          sourceManifestHash: hex('c'),
          sourceDurationMs: SOURCE_DURATION_MS,
          rightsSnapshotId: RIGHTS_SNAPSHOT_ID,
          rightsStatus: 'approved',
          consentStatus: 'not-required',
          moments: evidenceSource.moments.map((moment) => ({
            id: moment.id,
            momentHash: moment.momentHash,
            chapterId: `${moment.id}-chapter`,
            topic: TOPIC,
            recommendedRangeMs: moment.recommendedRangeMs,
            evidence: evidenceRuns.flatMap((entry) =>
              entry.run.evidence.filter(
                (item) => item.sourceMomentId === moment.id,
              )),
          })),
        },
      }
      const evaluationStore = evaluationRepositoryFor(evaluationSourceRef)
      let providerCalls = 0
      const evaluationProvider = new DeterministicContiguousEvaluationProvider()
      const produceEvaluations = produceContiguousEvaluationsService({
        repository: evaluationStore.repository,
        provider: {
          identity: evaluationProvider.identity,
          async evaluate(source, signal) {
            providerCalls += 1
            return evaluationProvider.evaluate(source, signal)
          },
        },
        createRunId: () => 'contiguous-evaluation-run-golden',
        createEvaluationId: (momentId) => `${momentId}-evaluation`,
        clock: () => new Date(CREATED_AT),
      })
      const evaluationRequest = {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        indexRunId: INDEX_RUN_ID,
        authenticationAudit: stageAudit(),
        fence: momentsFence,
        idempotencyKey: 'contiguous-evaluation-two-hour-golden',
      }

      let evaluated
      await t.test('the production evaluator scores both windows from evidence only', async () => {
        const run = await produceEvaluations(evaluationRequest)
        evaluated = run.run
        assert.equal(run.replayed, false)
        assert.equal(evaluated.evaluations.length, 2)
        assert.ok(evaluated.decisions.every((item) => item.status === 'evaluated'))
        const selected = evaluated.evaluations.find((item) => item.id === selectedMomentId)
        const distractor = evaluated.evaluations.find((item) => item.id === distractorMomentId)
        assert.ok(selected.objectiveTags.includes(OBJECTIVE))
        assert.ok(distractor.objectiveTags.includes(OBJECTIVE))
        // Boundary expansion: the distractor's semantic window is WIDER than the
        // indexed recommendation, because the transcript sentences start earlier
        // and end later. Nothing was synthesized — the window simply grew to the
        // semantic edges and still lands on the target duration.
        assert.deepEqual(
          [...distractor.semanticRangeMs],
          [DISTRACTOR_SECONDS[0] * 1_000, DISTRACTOR_SECONDS[1] * 1_000],
        )
        assert.ok(distractor.semanticRangeMs[0] < distractor.recommendedRangeMs[0])
        assert.ok(distractor.semanticRangeMs[1] > distractor.recommendedRangeMs[1])
        assert.deepEqual(
          [...selected.semanticRangeMs],
          [SELECTED_SECONDS[0] * 1_000, SELECTED_SECONDS[1] * 1_000],
        )
        // Every dimension is bound to one evidence id — nothing is fabricated.
        for (const dimension of ['selfContained', 'density', 'integrity', 'audio', 'visual']) {
          assert.equal(selected.scores[dimension].evidenceRefs.length, 1)
          assert.ok(
            evaluationSourceRef.current.moments[0].evidence.some(
              (item) => item.id === selected.scores[dimension].evidenceRefs[0],
            ),
          )
        }
        assert.equal(selected.sourceArtifactSha256, masterSha256)
        t.diagnostic(
          `selected scores ${JSON.stringify(
            Object.fromEntries(
              Object.entries(selected.scores).map(([key, value]) => [key, value.value]),
            ),
          )}`,
        )
        t.diagnostic(
          `distractor scores ${JSON.stringify(
            Object.fromEntries(
              Object.entries(distractor.scores).map(([key, value]) => [key, value.value]),
            ),
          )}`,
        )
      })

      // ------------------------------------------------------ selection stage
      const candidatesRef = {
        current: [...evaluated.evaluations, rightsBlockedMoment(masterSha256)],
      }
      const extractionStore = extractionRepositoryFor(candidatesRef)
      const createExtraction = createContiguousExtractionService({
        repository: extractionStore.repository,
        createId: () => 'contiguous-extraction-two-hour-golden',
        clock: () => new Date('2026-08-02T12:20:00.000Z'),
      })
      const readExtraction = readContiguousExtractionService({
        repository: extractionStore.repository,
      })
      const extractionRequest = {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        objective: OBJECTIVE,
        topic: TOPIC,
        targetDurationMs: TARGET_DURATION_MS,
        toleranceMs: 0,
        fps: FPS,
        actor: apiActor(),
        idempotencyKey: 'contiguous-extraction-two-hour-golden-1',
      }

      let extraction
      await t.test('selection compiles exactly one contiguous window and no multi-range synthesis', async () => {
        const created = await createExtraction(extractionRequest)
        extraction = created.extraction.result
        assert.equal(created.replayed, false)
        assert.equal(extractionStore.stored().length, 1)

        const selectedCandidate = extraction.candidates.find(
          (candidate) => candidate.candidateHash === extraction.selectedCandidateHash,
        )
        assert.equal(selectedCandidate.sourceMomentId, selectedMomentId)
        assert.equal(selectedCandidate.durationMs, TARGET_DURATION_MS)
        assert.equal(selectedCandidate.durationDeltaMs, 0)

        assert.equal(extraction.storyPlan.mode, 'contiguous')
        assert.equal(extraction.storyPlan.blocks.length, 1)
        assert.equal(extraction.editPlan.mode, 'contiguous')
        assert.equal(extraction.editPlan.synthesizedRanges, false)
        assert.equal(extraction.editPlan.movementPolicy.automaticZoom, false)
        assert.equal(
          extraction.editPlan.movementPolicy.reason,
          'contiguous-source-preservation',
        )
        assert.equal(extraction.editPlan.videoTracks.length, 1)
        assert.equal(extraction.editPlan.videoTracks[0].clips.length, 1)
        assert.equal(extraction.editPlan.durationFrames, 120 * FPS)
        assert.equal(extraction.editPlan.fps, FPS)
        assert.equal(extraction.editPlan.sources[0].artifactSha256, masterSha256)

        const clip = extraction.editPlan.videoTracks[0].clips[0]
        assert.deepEqual(
          [clip.sourceInFrame, clip.sourceOutFrame],
          [SELECTED_SECONDS[0] * FPS, SELECTED_SECONDS[1] * FPS],
        )
        assert.deepEqual(
          [clip.timelineInFrame, clip.timelineOutFrame],
          [0, 120 * FPS],
        )
        assert.equal(clip.rate, 1)
        // Context preserved: the compiled window contains the exact semantic
        // borders the evaluation demanded, with nothing trimmed off either end.
        const semantic = evaluated.evaluations.find(
          (item) => item.id === selectedMomentId,
        ).semanticRangeMs
        assert.equal(clip.sourceInFrame * 1_000 / FPS, semantic[0])
        assert.equal(clip.sourceOutFrame * 1_000 / FPS, semantic[1])

        const readBack = await readExtraction({
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          extractionId: extraction.id,
        })
        assert.equal(readBack.result.resultHash, extraction.resultHash)
      })

      await t.test('a rights-blocked window can never be selected', async () => {
        const blocked = rightsBlockedMoment(masterSha256)
        // It outranks everything on every dimension, so only the rights gate can
        // keep it out of the plan.
        assert.ok(
          Object.values(blocked.scores).every((observation) => observation.value === 1),
        )
        assert.equal(
          extraction.candidates.some(
            (candidate) => candidate.sourceMomentId === blocked.id,
          ),
          false,
        )
        assert.equal(
          extraction.editPlan.lineageRefs.includes(blocked.rightsSnapshotId),
          false,
        )
        assert.equal(extraction.candidates.length, 2)

        // With nothing but the blocked window, the service refuses instead of
        // downgrading the request to an unauthorized range.
        const blockedOnly = extractionRepositoryFor({ current: [blocked] })
        const create = createContiguousExtractionService({
          repository: blockedOnly.repository,
          createId: () => 'contiguous-extraction-two-hour-golden-blocked',
          clock: () => new Date('2026-08-02T12:21:00.000Z'),
        })
        await assert.rejects(
          create({
            ...extractionRequest,
            idempotencyKey: 'contiguous-extraction-two-hour-golden-blocked',
          }),
          (error) => error.code === 'PRECONDITION_REQUIRED',
        )
        assert.equal(blockedOnly.stored().length, 0)
      })

      await t.test('replaying every stage duplicates no work', async () => {
        const analyzerCallsBefore = new Map(analyzerCalls)
        const replayedEvidence = await runEvidenceStage(producers)
        assert.ok(replayedEvidence.every((entry) => entry.replayed === true))
        assert.deepEqual([...analyzerCalls], [...analyzerCallsBefore])
        assert.equal(evidenceStore.persists(), 5)
        assert.equal(evidenceStore.runs().length, 5)

        const replayedEvaluation = await produceEvaluations(evaluationRequest)
        assert.equal(replayedEvaluation.replayed, true)
        assert.equal(replayedEvaluation.run.runHash, evaluated.runHash)
        assert.equal(providerCalls, 1)
        assert.equal(evaluationStore.persists(), 1)

        const replayedExtraction = await createExtraction(extractionRequest)
        assert.equal(replayedExtraction.replayed, true)
        assert.equal(replayedExtraction.extraction.result.resultHash, extraction.resultHash)
        assert.equal(extractionStore.stored().length, 1)
        assert.equal(extractionStore.queries().length, 1)
      })

      // ------------------------------------------------- worker + renderer
      const compiledPlan = compiledPlanFromContiguous(extraction)
      const editPlanHash = calculateVersionHash(compiledPlan)
      harness = renderHarness({
        root,
        artifactRoot,
        masterSha256,
        masterByteSize: Number(masterByteSize),
        compiledPlan,
        editPlanHash,
        editPlanSnapshotId: 'snapshot-two-hour-golden-edit-plan',
      })

      await t.test('the compiled plan handed to the worker is the contiguous plan', () => {
        assert.deepEqual(
          compiledPlan.videoTracks[0].clips,
          extraction.editPlan.videoTracks[0].clips.map((clip) => ({ ...clip })),
        )
        assert.equal(compiledPlan.movementPolicy.automaticZoom, false)
        assert.equal(compiledPlan.durationFrames, extraction.editPlan.durationFrames)
        assert.equal(compiledPlan.fps, extraction.editPlan.fps)
        assert.deepEqual(compiledPlan.overlayTracks, [])
        assert.deepEqual(compiledPlan.subtitleTracks, [])
      })

      let outcome
      await t.test('the real worker renders one two-minute MP4 out of the two-hour master', async () => {
        const enqueued = await harness.enqueue({
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          expectedProjectVersionId: PROJECT_VERSION_ID,
          actor: apiActor(),
          idempotencyKey: 'proxy-two-hour-golden',
        })
        assert.equal(enqueued.replayed, false)
        assert.equal(enqueued.context.kind, 'project-proxy-render')
        assert.equal(enqueued.context.inputHash, harness.expectedInputHash())

        outcome = await harness.worker('worker-two-hour-golden')
        assert.deepEqual(outcome, {
          operationId: 'operation-two-hour-golden-proxy',
          status: 'succeeded',
        })
        assert.deepEqual(harness.phases, ['rendering', 'verifying', 'persisting'])
        assert.equal(harness.renders.count, 1)

        // The worker built the render input itself, from the persisted plan.
        const renderInput = harness.captured.renderInput
        assert.equal(renderInput.renderKind, 'proxy')
        assert.equal(renderInput.fps, FPS)
        assert.equal(renderInput.clips.length, 1)
        assert.deepEqual(
          [renderInput.clips[0].sourceInFrame, renderInput.clips[0].sourceOutFrame],
          [SELECTED_SECONDS[0] * FPS, SELECTED_SECONDS[1] * FPS],
        )
        assert.deepEqual(renderInput.subtitleCues, [])
        assert.equal(
          renderInput.sources[0].path,
          join(artifactRoot, ...MASTER_ARTIFACT_KEY.split('/')),
        )

        const proxyPath = harness.captured.stored.path
        const proxyProbe = await probeVideo(proxyPath, { requireAudio: true })
        assert.ok(
          Math.abs(proxyProbe.duration - 120) <= 0.2,
          `the short must last two minutes; got ${proxyProbe.duration}s`,
        )
        assert.equal(proxyProbe.width, 960)
        assert.equal(proxyProbe.height, 540)
        assert.equal(proxyProbe.audioCodec, 'aac')
        assert.match(harness.captured.stored.sha256, /^[a-f0-9]{64}$/)
        assert.ok(harness.captured.stored.byteSize > 0)

        // Pixels: the short is the gold window from end to end, and never the
        // blue distractor or the dark filler that surrounds it in the master.
        assertGold(await samplePixel(proxyPath, 0.5), 'short start')
        assertGold(await samplePixel(proxyPath, 60), 'short middle')
        assertGold(await samplePixel(proxyPath, 119.5), 'short end')
        t.diagnostic(
          `short duration=${proxyProbe.duration}s ${proxyProbe.width}x${proxyProbe.height} ` +
          `bytes=${harness.captured.stored.byteSize} sha=${harness.captured.stored.sha256.slice(0, 12)}`,
        )
      })

      await t.test('re-enqueueing the same extraction renders nothing twice', async () => {
        const replay = await harness.enqueue({
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          expectedProjectVersionId: PROJECT_VERSION_ID,
          actor: apiActor(),
          idempotencyKey: 'proxy-two-hour-golden',
        })
        assert.equal(replay.replayed, true)
        assert.equal(replay.operation.id, 'operation-two-hour-golden-proxy')
        assert.equal(await harness.worker('worker-two-hour-golden'), null)
        assert.equal(harness.renders.count, 1)
        assert.equal(harness.operation().status, 'succeeded')
      })
    } finally {
      if (harness) await harness.cleanup().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  },
)
