import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueProjectProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import {
  exportProjectSubtitleSidecarService,
  listProjectSubtitleSidecarsService,
} from '../../src/v2/application/export-subtitle-sidecar.ts'
import { calculatePerceptionTimelineRecordHash } from '../../src/v2/application/perception-timelines.ts'
import { projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { replaceSourceTranscriptService } from '../../src/v2/application/replace-source-transcript.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { applySubtitleSegmentOverrideService } from '../../src/v2/application/subtitle-segment-overrides.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createDirectorRunInvalidations, parseDirectorRunImpact } from '../../src/v2/domain/director-run-impact.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { createPerceptionTimeline, PERCEPTION_KINDS } from '../../src/v2/domain/perception-timeline.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import {
  advancePublicOperationPhase,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { renderElementMapHash, validateRenderElementMap } from '../../src/v2/domain/review-system.ts'
import { createSourceTranscriptArtifactInvalidations } from '../../src/v2/domain/source-transcript-replacement.ts'
import {
  deriveSubtitleAnchorBands,
  subtitleAnchorDecisionFor,
} from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { deriveSubtitleRegion } from '../../src/v2/domain/subtitle-region.ts'
import {
  applySubtitleSegmentOverrides,
  reapplyProtectedSubtitleSegmentOverrides,
  requirePersistedSubtitleSegmentOverride,
} from '../../src/v2/domain/subtitle-segment-override.ts'
import {
  collectRenderedSubtitleCues,
  encodeSubtitleSidecar,
  parseSubtitleSidecar,
  subtitleSidecarFrameToMs,
} from '../../src/v2/domain/subtitle-sidecar.ts'
import {
  materializeSubtitlePresetSnapshot,
  requireSubtitlePresetSnapshot,
  SUBTITLE_STYLE_REGISTRY,
  subtitlePresetHash,
} from '../../src/v2/domain/subtitle-system.ts'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import {
  LocalArtifactSourceMaterializer,
  LocalMediaUploadStorage,
} from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { TemporaryFileSubtitleSidecarStaging } from '../../src/v2/infrastructure/media/subtitle-sidecar-staging.ts'

// ---------------------------------------------------------------------------
// Wave 10 — ONE combined journey across F1.035, F1.036, F1.037 and F1.038.
//
// A single directed StoryPlan/transcript produces two output variants. The
// subtitle preset travels as a content-addressed snapshot (F1.035); the anchor of
// every cue is decided from a persisted PerceptionTimeline instead of the default
// bottom band (F1.036); one protected `text` exception is applied to exactly one
// (variant, range) pair (F1.037); and the SRT/VTT sidecars are derived from the
// RenderElementMap the very same render operation persisted (F1.038).
//
// Everything below runs production code: replace-source-transcript ->
// run-project-director -> applySubtitleSegmentOverrideService ->
// enqueue-project-proxy-render -> runNextProjectProxyRenderOperationService (the
// real V2 worker) -> FfmpegEditorialProxyRenderer (real FFmpeg) ->
// LocalMediaUploadStorage -> exportProjectSubtitleSidecarService. Only
// persistence is in memory, and every in-memory adapter re-runs the same
// integrity checks the Prisma adapter runs on read.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const FPS = 30
const WORKSPACE_ID = 'workspace-wave10-combined'
const PROJECT_ID = 'project-wave10-combined'
const MASTER_ARTIFACT_ID = 'artifact-wave10-master'
const MASTER_MANIFEST_ID = `manifest-${MASTER_ARTIFACT_ID}`
const MASTER_ARTIFACT_KEY = 'masters/wave10-master.mp4'
const CREATED_AT = '2026-08-21T09:00:00.000Z'
const UPLOAD_RECEIVED_AT = '2026-08-21T09:00:00.000Z'
const SOURCE_WIDTH = 640
const SOURCE_HEIGHT = 360
const DURATION_FRAMES = 180
const DURATION_MS = Math.round(DURATION_FRAMES / FPS * 1_000)
const PRESET_ID = 'clean-color'

/** The exception FR-174 applies to exactly one variant and one compiled range. */
const OVERRIDE_SEGMENT_ID = 'subtitle-cue-2'
const OVERRIDE_TEXT = 'Correcao aprovada pelo dono'
const OVERRIDE_VARIANT = '9:16'
const SIBLING_VARIANT = '16:9'

const CANVAS = Object.freeze({
  '9:16': Object.freeze({ width: 540, height: 960 }),
  '16:9': Object.freeze({ width: 960, height: 540 }),
})

/** Widest 9:16 window a 640x360 master can offer, centred. */
const PORTRAIT_CROP_WIDTH = (9 / 16) / (SOURCE_WIDTH / SOURCE_HEIGHT)

const startSecondsForFrame = (frame) => (frame === 0 ? 0 : (frame - 0.5) / FPS)
const endSecondsForFrame = (frame) => (frame + 0.5) / FPS

const CLIPS = Object.freeze([
  Object.freeze({ id: 'clip-red', sourceArtifactId: MASTER_ARTIFACT_ID, sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 60, rate: 1 }),
  Object.freeze({ id: 'clip-green', sourceArtifactId: MASTER_ARTIFACT_ID, sourceInFrame: 60, sourceOutFrame: 120, timelineInFrame: 60, timelineOutFrame: 120, rate: 1 }),
  Object.freeze({ id: 'clip-blue', sourceArtifactId: MASTER_ARTIFACT_ID, sourceInFrame: 120, sourceOutFrame: 180, timelineInFrame: 120, timelineOutFrame: 180, rate: 1 }),
])

const WORD_SOURCE_FRAMES = Object.freeze([
  ['Abertura', 6, 15],
  ['clara', 20, 40],
  ['meio', 70, 100],
  ['final', 130, 160],
])

/** What the Director compiles from the words above (gap 15->20 merges the first two). */
const EXPECTED_CUES = Object.freeze([
  ['subtitle-cue-1', 6, 40, 'Abertura clara'],
  ['subtitle-cue-2', 70, 100, 'meio'],
  ['subtitle-cue-3', 130, 160, 'final'],
])

/** Frames sampled inside each cue, used for every pixel measurement below. */
const CUE_SAMPLE_SECONDS = Object.freeze({
  'subtitle-cue-1': 0.5,
  'subtitle-cue-2': 2.7,
  'subtitle-cue-3': 4.7,
})

const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

/**
 * The perception evidence the render consults. A presenter framed low covers the
 * `bottom` and `lower-third` bands of BOTH variants, so the default anchor cannot
 * survive it. Built with the production constructor, therefore content-addressed.
 */
const PERCEPTION_TIMELINE = createPerceptionTimeline({
  durationMs: DURATION_MS,
  observations: [{
    id: 'face-presenter-low',
    kind: 'face',
    startMs: 0,
    endMs: DURATION_MS,
    value: { bounds: { x: 0.22, y: 0.6, width: 0.56, height: 0.38 } },
    provenance: { source: 'wave10-journey', model: 'face-fixture', version: 'v1', confidence: 0.99 },
  }],
  coverage: PERCEPTION_KINDS.map((kind) => ({ kind, ranges: kind === 'face' ? [[0, DURATION_MS]] : [] })),
})

const anchorBandsFor = (format) => {
  const preset = readOutputFormatPreset(format)
  return deriveSubtitleAnchorBands({
    region: deriveSubtitleRegion({ spec: preset.spec, presetId: PRESET_ID }),
    safeArea: preset.spec.safeArea,
  })
}

function proxyActor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-wave10', credentialId: 'credential-wave10',
    workspaceId: WORKSPACE_ID, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
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
    outputMetadata: colorMetadata, createdByClientId: 'client-wave10', createdAt: CREATED_AT,
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
    baseHash: 'a'.repeat(64), createdBy: 'client-wave10', createdAt: CREATED_AT,
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
// In-memory persistence for the replacement + Director half.
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
      outputReferences: OUTPUT_REFERENCES('version-base'),
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

const OUTPUT_REFERENCES = (versionId) => [
  { artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: versionId, variantId: '9:16' },
  { artifactId: 'proxy-16x9', kind: 'proxy', sourceVersionId: versionId, variantId: '16:9' },
]

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
        state: 'present', snapshotId: 'rights-wave10-master',
        snapshotHash: 'e'.repeat(64), status: 'approved', consentStatus: 'not-required',
      },
      outputReferences: OUTPUT_REFERENCES(this.currentVersion.id),
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

/** Runs replacement -> Director ONCE, so every variant renders one persisted snapshot. */
let directedOnce
async function directOnce() {
  if (directedOnce) return directedOnce
  const replacementRepository = new ReplacementRepository()
  let replacementIds = 0
  const replace = replaceSourceTranscriptService({
    repository: replacementRepository,
    clock: () => new Date('2026-08-21T09:10:00.000Z'),
    createId: () => ['edit-command-replace', 'version-retimed', 'snapshot-retimed'][replacementIds++],
    createEventId: () => '123e4567-e89b-42d3-a456-426614174020',
  })
  const replacement = await replace({
    workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
    baseVersionId: 'version-base', baseHash: 'a'.repeat(64),
    replacementTranscriptId: 'transcript-replacement',
    expectedTranscriptHash: replacementTranscript.transcriptHash,
    actor: proxyActor(),
    idempotencyKey: 'wave10-combined-transcript-replacement',
  })
  const persisted = JSON.parse(replacement.snapshot.contentJson)
  const directorRepository = new DirectorRepository(persisted, replacement.version)
  const counters = new Map()
  let event = 0
  const runDirector = runProjectDirectorService({
    repository: directorRepository,
    clock: () => new Date('2026-08-21T09:20:00.000Z'),
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
    idempotency: { key: 'wave10-combined-director-run' },
    reason: 'Dirigir uma composicao unica para duas variantes de formato.',
  })
  const editPlanSnapshot = directed.snapshots.find((item) => item.kind === 'edit-plan')
  const directedPlan = JSON.parse(editPlanSnapshot.contentJson)
  assert.equal(editPlanSnapshot.contentHash, calculateVersionHash(directedPlan))
  directedOnce = { replacement, persisted, directed, directedPlan, editPlanSnapshot }
  return directedOnce
}

// --------------------------------------------------------------------------
// Perception persistence.
//
// `hydrate` mirrors `PrismaPerceptionTimelineRepository.hydrate` exactly: the
// timeline is re-derived with the production constructor and the stored hashes
// are re-checked, so a hand-edited observation is refused on READ, before the
// worker can consult it.
// --------------------------------------------------------------------------

class PerceptionTimelineRepository {
  constructor() { this.rows = [] }

  persistRow(row) { this.rows.push(row) }

  record(projectVersionId, timeline) {
    const content = Object.freeze({
      schemaVersion: 'persisted-perception-timeline/v1',
      id: `perception-${projectVersionId}`,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      projectVersionId,
      baseRevision: null,
      timeline,
      requestFingerprint: calculateCanonicalHash({ projectVersionId, timelineHash: timeline.timelineHash }),
      idempotencyKey: `perception-${projectVersionId}`,
      authenticationAudit: proxyActor().auditContext,
      createdByClientId: 'client-wave10',
      createdAt: CREATED_AT,
    })
    return Object.freeze({
      ...content,
      recordHash: calculatePerceptionTimelineRecordHash(content),
      // Stored exactly as the Postgres row stores it: JSON plus the two digests.
      timelineJson: stableSerialize(timeline),
      timelineHash: timeline.timelineHash,
    })
  }

  async findIdempotent() { return null }
  async persist(value) { this.rows.push(value); return { timeline: value, replayed: false } }
  async findLatest({ workspaceId, projectId }) {
    const row = [...this.rows].reverse().find((item) =>
      item.workspaceId === workspaceId && item.projectId === projectId)
    if (!row) return null
    return Object.freeze({ ...row, timeline: hydratePerceptionRow(row) })
  }
}

/**
 * The read-time integrity gate of `PrismaPerceptionTimelineRepository.hydrate`,
 * expressed with the same production functions (`createPerceptionTimeline`,
 * `stableSerialize`, `calculatePerceptionTimelineRecordHash`). A tampered row
 * therefore fails on read here for exactly the reason it fails in Postgres.
 */
function hydratePerceptionRow(row) {
  const timeline = createPerceptionTimeline({
    durationMs: row.timeline.durationMs,
    observations: row.timeline.observations,
    coverage: row.timeline.coverage.map((entry) => ({ kind: entry.kind, ranges: entry.ranges })),
  })
  if (timeline.timelineHash !== row.timelineHash || stableSerialize(timeline) !== row.timelineJson) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception timeline failed integrity validation')
  }
  const { recordHash, timelineJson, timelineHash, ...content } = row
  if (calculatePerceptionTimelineRecordHash({ ...content, timeline }) !== recordHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception timeline record hash is invalid')
  }
  return timeline
}

// --------------------------------------------------------------------------
// Subtitle segment override persistence (F1.037).
// --------------------------------------------------------------------------

class SubtitleSegmentOverrideRepository {
  constructor(version, segments) {
    this.version = version
    this.segments = segments
    this.rows = []
    this.idempotent = new Map()
  }

  headOf(variantId, segmentId) {
    return this.rows.filter((row) =>
      row.subtitleOverride.variantId === variantId && row.subtitleOverride.segmentId === segmentId)
  }

  async findIdempotent({ workspaceId, projectId, idempotencyKey }) {
    return this.idempotent.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId, variantId, segmentId }) {
    if (workspaceId !== WORKSPACE_ID || projectId !== PROJECT_ID) return null
    const history = this.headOf(variantId, segmentId)
    return {
      currentVersion: this.version,
      durationFrames: DURATION_FRAMES,
      segments: this.segments,
      variantIds: [OVERRIDE_VARIANT, SIBLING_VARIANT],
      outputReferences: OUTPUT_REFERENCES(this.version.id),
      currentOverride: history.at(-1)?.subtitleOverride ?? null,
      previousOverride: history.at(-2)?.subtitleOverride ?? null,
    }
  }

  async commitOrReplay(bundle) {
    // The Postgres adapter re-derives the document before it is stored; so does this one.
    requirePersistedSubtitleSegmentOverride(bundle.subtitleOverride)
    this.version = bundle.version
    const result = Object.freeze({
      command: bundle.command, version: bundle.version,
      subtitleOverride: bundle.subtitleOverride, impact: bundle.impact, replayed: false,
    })
    this.rows.push(result)
    this.idempotent.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint, result,
    })
    return result
  }

  async readCurrent({ variantId, segmentId }) {
    return this.headOf(variantId, segmentId).at(-1) ?? null
  }

  async listCurrentByVariant({ variantId }) {
    const heads = new Map()
    for (const row of this.rows) {
      if (row.subtitleOverride.variantId !== variantId) continue
      heads.set(row.subtitleOverride.segmentId, row.subtitleOverride)
    }
    return [...heads.values()]
  }
}

// --------------------------------------------------------------------------
// Media artifact persistence, shared by the render worker and the sidecar.
// --------------------------------------------------------------------------

function inMemoryArtifacts() {
  const byId = new Map()
  const byKey = new Map()
  return {
    seed(record) { byId.set(record.id, record); byKey.set(record.artifactKey, record) },
    async findById(workspaceId, artifactId) {
      const record = byId.get(artifactId)
      return record && record.workspaceId === workspaceId ? record : null
    },
    async findColorProbe() { return null },
    async persistOrReplay(bundle) {
      const manifestRecord = {
        id: bundle.manifestId,
        schemaVersion: bundle.manifest.schemaVersion,
        manifestHash: bundle.manifest.manifestHash,
        recipe: {
          id: bundle.manifest.recipe.id,
          version: bundle.manifest.recipe.version,
          parametersHash: bundle.manifest.recipe.parametersHash,
        },
        // Recorded ONLY when the caller supplies one. Nothing is invented here:
        // whether a proxy manifest carries a RenderInput is a property of the
        // worker, and this journey has to be able to observe it.
        ...(bundle.renderInput ? {
          renderInput: {
            ref: bundle.renderInput.ref,
            inputHash: bundle.renderInput.inputHash,
            canonicalByteSize: bundle.renderInput.canonicalByteSize,
            algorithm: 'aes-256-gcm',
          },
        } : {}),
        ...(bundle.manifest.artifact.probe ? { probe: bundle.manifest.artifact.probe } : {}),
        sources: bundle.manifest.sources.map((source, ordinal) => ({ ...source, ordinal })),
        createdAt: bundle.createdAt,
      }
      const existing = byKey.get(bundle.manifest.artifact.artifactKey)
      if (existing) {
        assert.equal(existing.sha256, bundle.manifest.artifact.sha256)
        const replayed = existing.manifests.find((entry) => entry.manifestHash === bundle.manifest.manifestHash)
        if (replayed) return { artifactId: existing.id, manifestId: replayed.id, replayed: true }
        existing.manifests.push(manifestRecord)
        return { artifactId: existing.id, manifestId: bundle.manifestId, replayed: false }
      }
      for (const source of bundle.manifest.sources) {
        assert.ok(byKey.has(source.artifactKey), `manifest source ${source.artifactKey} must already exist`)
      }
      const record = {
        id: bundle.artifactId,
        workspaceId: bundle.workspaceId,
        artifactKey: bundle.manifest.artifact.artifactKey,
        sha256: bundle.manifest.artifact.sha256,
        byteSize: BigInt(bundle.manifest.artifact.byteSize),
        mediaType: bundle.manifest.artifact.mediaType,
        container: bundle.manifest.artifact.container,
        status: 'available',
        lifecycleRevision: 1,
        manifests: [manifestRecord],
        createdAt: bundle.createdAt,
      }
      byId.set(record.id, record)
      byKey.set(record.artifactKey, record)
      return { artifactId: record.id, manifestId: bundle.manifestId, replayed: false }
    },
  }
}

function inMemorySidecars(alignments) {
  const rows = []
  return {
    alignments,
    async readRenderedAlignment(input) {
      return alignments.get(`${input.projectVersionId ?? 'head'}:${input.variantId}`) ??
        alignments.get(`head:${input.variantId}`) ?? null
    },
    async findIdempotent(input) {
      const row = rows.find((item) =>
        item.record.workspaceId === input.workspaceId &&
        item.record.projectId === input.projectId &&
        item.idempotencyKey === input.idempotencyKey)
      return row ? { requestFingerprint: row.requestFingerprint, record: row.record } : null
    },
    async persistOrReplay(input) {
      const byLineage = rows.find((item) =>
        item.record.workspaceId === input.record.workspaceId &&
        item.record.lineageHash === input.record.lineageHash)
      if (byLineage) {
        assert.equal(byLineage.record.sha256, input.record.sha256)
        return { record: byLineage.record, replayed: true }
      }
      rows.push({ ...input })
      return { record: input.record, replayed: false }
    },
    async list(input) {
      return rows.map((item) => item.record).filter((record) =>
        record.workspaceId === input.workspaceId && record.projectId === input.projectId &&
        (!input.projectVersionId || record.projectVersionId === input.projectVersionId) &&
        (!input.variantId || record.variantId === input.variantId) &&
        (!input.format || record.format === input.format)).slice(0, input.limit)
    },
    get rows() { return rows },
  }
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

/** Full RGB24 frame at `second`. The source is flat colour, so any near-white pixel is a glyph. */
const frameAt = (path, second, format) => {
  const canvas = CANVAS[format]
  const raw = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(raw.byteLength, canvas.width * canvas.height * 3)
  return raw
}

const isGlyph = (raw, offset) => raw[offset] >= 200 && raw[offset + 1] >= 200 && raw[offset + 2] >= 200

function glyphRows(raw, format) {
  const canvas = CANVAS[format]
  const rows = []
  for (let y = 0; y < canvas.height; y += 1) {
    let count = 0
    for (let x = 0; x < canvas.width; x += 1) {
      if (isGlyph(raw, (y * canvas.width + x) * 3)) count += 1
    }
    if (count > 0) rows.push({ y, count })
  }
  return rows
}

const glyphTotal = (raw, format) => glyphRows(raw, format).reduce((sum, row) => sum + row.count, 0)

function glyphCentreRow(raw, format) {
  const rows = glyphRows(raw, format)
  if (rows.length === 0) return Number.NaN
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return rows.reduce((sum, row) => sum + row.y * row.count, 0) / total
}

const bandPixels = (band, format) => Object.freeze({
  top: Math.round(band.y * CANVAS[format].height),
  bottom: Math.round((band.y + band.height) * CANVAS[format].height),
  centre: Math.round((band.y + band.height / 2) * CANVAS[format].height),
})

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

const readdirSafe = async (path) => {
  try { return (await readdir(path, { recursive: true })).toSorted() } catch { return [] }
}

function sequentialClock(start) {
  let current = Date.parse(start)
  return () => new Date((current += 100))
}

/** F1.035: the resolution a repository persists carries the content-addressed snapshot. */
const subtitleResolution = () => Object.freeze({
  presetId: PRESET_ID,
  presetHash: subtitlePresetHash(PRESET_ID),
  registryHash: SUBTITLE_STYLE_REGISTRY.registryHash,
  enabled: true,
  presetSnapshot: materializeSubtitlePresetSnapshot(PRESET_ID),
})

// --------------------------------------------------------------------------
// The render half: real enqueue service, real worker, real FFmpeg.
// --------------------------------------------------------------------------

function renderSourceFor(input) {
  const editPlan = {
    ...input.directedPlan,
    subtitleTracks: input.directedPlan.subtitleTracks.map((track) => ({ ...track, cues: input.cues })),
  }
  return Object.freeze({
    projectId: PROJECT_ID,
    projectVersionId: input.projectVersionId,
    editPlanSnapshotId: input.editPlanSnapshotId,
    // Derived from the plan actually rendered, so an exception cannot hide behind
    // the hash of the plan it replaced.
    editPlanHash: calculateVersionHash(editPlan),
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
    originalFileName: 'wave10-master.mp4',
    uploadReceivedAt: UPLOAD_RECEIVED_AT,
    criticIssues: Object.freeze([]),
    subtitleResolution: input.subtitleResolution,
    reframePlan: reframePlanFor(input.format),
  })
}

async function renderThroughRealWorker(input) {
  const artifactRoot = join(input.root, 'artifacts')
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
    clock: () => new Date('2026-08-21T09:25:00.000Z'),
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
        return { selectionId: 'selection-wave10', selectionHash: '7'.repeat(64), lutPaths: {} }
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
        captured.persistedRenderInput = persist.renderInput
        // Only the render whose artifact the sidecar consumes is committed to the
        // shared content-addressed repository. The control renders keep the
        // reserved identity: two of them are byte-identical by construction, and a
        // content-addressed store would collapse them into one row.
        return input.artifacts
          ? input.artifacts.persistOrReplay(persist)
          : { artifactId: persist.artifactId, manifestId: persist.manifestId, replayed: false }
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
    perceptionTimelines: input.perceptionTimelines,
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
    clock: sequentialClock('2026-08-21T09:30:00.000Z'),
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

/**
 * `createMediaArtifactManifestV2` stores the recipe parameters as ONE content
 * address, so the only way to prove what the recipe carries is to rebuild the
 * exact parameter document and match its hash. Every value below comes from an
 * independent source — the domain registry, the plans the renderer received and
 * the operation context — so a field silently dropped from the recipe (or a
 * preset identity replaced by a different one) breaks this equality.
 */
function assertRecipeParameters(rendered, expected) {
  const parameters = {
    inputHash: rendered.expectedInputHash,
    audioTimelineHash: rendered.renderInput.audioTimelineHash,
    projectVersionId: rendered.source.projectVersionId,
    editPlanSnapshotId: rendered.source.editPlanSnapshotId,
    format: rendered.source.format,
    colorPipelineBindings: rendered.enqueuedContext.colorPipelineBindings,
    rangeReuse: null,
    projectLutSelectionId: 'selection-wave10',
    projectLutSelectionHash: '7'.repeat(64),
    materializedCubeHash: null,
    placementPlanHash: rendered.renderInput.placementPlan.placementPlanHash,
    reframePlanHash: rendered.renderInput.reframePlan.reframePlanHash,
    subtitleRegistryHash: expected.registryHash,
    subtitlePresetId: expected.presetId,
    subtitlePresetVersion: 1,
    subtitlePresetHash: expected.presetHash,
    subtitlePresetSnapshotHash: expected.snapshotHash,
    subtitleAnchorPlanHash: expected.anchorPlanHash,
    perceptionTimelineHash: expected.perceptionTimelineHash,
  }
  assert.equal(
    rendered.manifest.recipe.parametersHash,
    calculateCanonicalHash(parameters),
    'the persisted recipe must carry exactly this preset/anchor identity',
  )
  assert.equal(rendered.manifest.recipe.id, 'editorial-proxy')
  assert.equal(rendered.manifest.recipe.version, EDITORIAL_PROXY_RECIPE_VERSION)
}

/** Everything a successful variant render must satisfy. */
function assertRenderedVariant(rendered, expected) {
  const canvas = CANVAS[expected.format]
  assert.equal(rendered.failure, undefined, `render ${expected.operationId} failed: ${JSON.stringify(rendered.failure)}`)
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
  assert.equal(rendered.rendererCleaned, 1)
  assert.equal(rendered.lutCleaned, 1)
}

// ---------------------------------------------------------------------------
// The journey.
// ---------------------------------------------------------------------------

test('T-WAVE10 one journey: versioned preset, perception anchor, scoped protected override, real proxy and its sidecar', {
  timeout: 30 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-wave10-combined-'))
  const masterPath = join(root, 'wave10-master.mp4')
  try {
    await writeColourMaster(masterPath)
    const masterBytes = await readFile(masterPath)
    const masterSha256 = createHash('sha256').update(masterBytes).digest('hex')
    const artifactRoot = join(root, 'artifacts')
    const masterTarget = join(artifactRoot, ...MASTER_ARTIFACT_KEY.split('/'))
    await mkdir(join(masterTarget, '..'), { recursive: true })
    await copyFile(masterPath, masterTarget)

    const artifacts = inMemoryArtifacts()
    artifacts.seed({
      id: MASTER_ARTIFACT_ID, workspaceId: WORKSPACE_ID, artifactKey: MASTER_ARTIFACT_KEY,
      sha256: masterSha256, byteSize: BigInt(masterBytes.byteLength), mediaType: 'video',
      container: 'mp4', status: 'available', lifecycleRevision: 1,
      manifests: [{
        id: MASTER_MANIFEST_ID, schemaVersion: 'media-artifact-manifest/v4',
        manifestHash: 'd'.repeat(64), recipe: { id: 'ingest', version: '1.0.0', parametersHash: 'e'.repeat(64) },
        sources: [], createdAt: CREATED_AT,
      }],
      createdAt: CREATED_AT,
    })

    const journey = await directOnce()
    const directedCues = journey.directedPlan.subtitleTracks.flatMap((track) => track.cues)
    assert.deepEqual(
      directedCues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
      EXPECTED_CUES.map((entry) => [...entry]),
    )

    const perceptionTimelines = new PerceptionTimelineRepository()
    perceptionTimelines.persistRow(
      perceptionTimelines.record(journey.directed.version.id, PERCEPTION_TIMELINE))

    const renderVariant = async (options) => renderThroughRealWorker({
      root, suffix: options.suffix, perceptionTimelines,
      ...(options.artifacts ? { artifacts: options.artifacts } : {}),
      source: renderSourceFor({
        format: options.format,
        directedPlan: journey.directedPlan,
        cues: options.cues,
        projectVersionId: options.projectVersionId,
        editPlanSnapshotId: options.editPlanSnapshotId,
        masterSha256, masterByteSize: masterBytes.byteLength,
        subtitleResolution: options.subtitleResolution ?? subtitleResolution(),
      }),
      ...(options.tamper ? { tamper: options.tamper } : {}),
    })

    // ===== Requirement 1: the render carries a content-addressed preset snapshot =====
    const resolution = subtitleResolution()
    const snapshot = requireSubtitlePresetSnapshot(resolution.presetSnapshot)
    assert.equal(snapshot.schemaVersion, 'subtitle-preset-snapshot/v1')
    assert.equal(snapshot.presetVersion, 1)
    assert.equal(snapshot.presetId, PRESET_ID)
    assert.equal(snapshot.presetHash, subtitlePresetHash(PRESET_ID))
    assert.equal(snapshot.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
    assert.equal(snapshot.snapshotHash, materializeSubtitlePresetSnapshot(PRESET_ID).snapshotHash)
    console.log(`R1 preset snapshot presetHash=${snapshot.presetHash.slice(0, 12)} snapshotHash=${snapshot.snapshotHash.slice(0, 12)} registryHash=${snapshot.registryHash.slice(0, 12)}`)

    // ===== The two BASE renders (one per variant) ==============================
    const basePortrait = await renderVariant({
      suffix: 'base-9x16', format: OVERRIDE_VARIANT, cues: directedCues,
      projectVersionId: journey.directed.version.id,
      editPlanSnapshotId: journey.editPlanSnapshot.id,
    })
    const baseLandscape = await renderVariant({
      suffix: 'base-16x9', format: SIBLING_VARIANT, cues: directedCues,
      projectVersionId: journey.directed.version.id,
      editPlanSnapshotId: journey.editPlanSnapshot.id,
    })
    assertRenderedVariant(basePortrait, { operationId: 'operation-base-9x16', format: OVERRIDE_VARIANT })
    assertRenderedVariant(baseLandscape, { operationId: 'operation-base-16x9', format: SIBLING_VARIANT })
    // Both variants render ONE directed plan: same snapshot, same transcript identity.
    assert.equal(basePortrait.source.editPlanSnapshotId, journey.editPlanSnapshot.id)
    assert.equal(basePortrait.source.editPlanHash, journey.editPlanSnapshot.contentHash)
    assert.equal(baseLandscape.source.editPlanHash, journey.editPlanSnapshot.contentHash)
    assert.equal(basePortrait.renderInput.audioTimelineHash, baseLandscape.renderInput.audioTimelineHash)

    // ----- Requirement 1 (continued): the recipe records the full preset identity -----
    for (const rendered of [basePortrait, baseLandscape]) {
      assertRecipeParameters(rendered, {
        presetId: PRESET_ID,
        presetHash: snapshot.presetHash,
        snapshotHash: snapshot.snapshotHash,
        registryHash: snapshot.registryHash,
        anchorPlanHash: rendered.renderInput.placementPlan.subtitleAnchorPlan.anchorPlanHash,
        perceptionTimelineHash: PERCEPTION_TIMELINE.timelineHash,
      })
      console.log(`R1 ${rendered.source.format} recipe parametersHash=${rendered.manifest.recipe.parametersHash.slice(0, 12)} (preset ${PRESET_ID} v1, snapshot ${snapshot.snapshotHash.slice(0, 12)})`)
    }

    // ===== Requirement 2: the anchor is decided by the persisted perception ====
    const anchorPlan = basePortrait.renderInput.placementPlan.subtitleAnchorPlan
    assert.ok(anchorPlan, 'a render with cues and a perception timeline must carry an anchor plan')
    assert.equal(anchorPlan.perceptionTimelineHash, PERCEPTION_TIMELINE.timelineHash)
    assert.equal(anchorPlan.presetId, PRESET_ID)
    assert.equal(anchorPlan.presetHash, snapshot.presetHash)
    assert.equal(anchorPlan.registryHash, snapshot.registryHash)
    const portraitBands = anchorBandsFor(OVERRIDE_VARIANT)
    for (const [cueId] of EXPECTED_CUES) {
      const decision = subtitleAnchorDecisionFor(anchorPlan, cueId)
      assert.ok(decision, `cue ${cueId} must carry an anchor decision`)
      assert.equal(decision.anchor, 'upper-third', `${cueId} must be pushed off the default bottom band`)
      assert.equal(decision.suppressed, false)
      assert.ok(decision.blockerIds.includes('face-presenter-low'))
      assert.ok(decision.eligibleAnchors.includes('upper-third'))
      assert.equal(decision.eligibleAnchors.includes('bottom'), false)
    }
    // The decision and its evidence already reached the persisted recipe (the
    // parametersHash equality above binds anchorPlanHash and perceptionTimelineHash).
    // The RenderElementMap describes the very rectangle the plan decided.
    const upperThird = portraitBands['upper-third']
    for (const [cueId] of EXPECTED_CUES) {
      const element = basePortrait.elementMap.elements.find((item) => item.elementId === `subtitle:${cueId}`)
      assert.ok(element, `cue ${cueId} must appear in the RenderElementMap`)
      assert.equal(element.bounds.y, Math.round(upperThird.y * CANVAS[OVERRIDE_VARIANT].height))
      assert.equal(element.bounds.height, Math.round(upperThird.height * CANVAS[OVERRIDE_VARIANT].height))
    }
    // Pixel proof: the glyphs really land on the decided band, far from the default one.
    const decidedBand = bandPixels(upperThird, OVERRIDE_VARIANT)
    const defaultBand = bandPixels(portraitBands.bottom, OVERRIDE_VARIANT)
    for (const [cueId] of EXPECTED_CUES) {
      const raw = frameAt(basePortrait.stored.path, CUE_SAMPLE_SECONDS[cueId], OVERRIDE_VARIANT)
      const rows = glyphRows(raw, OVERRIDE_VARIANT)
      const centre = glyphCentreRow(raw, OVERRIDE_VARIANT)
      console.log(`R2 ${cueId}: glyph rows ${rows[0]?.y}..${rows.at(-1)?.y} centre ${centre.toFixed(1)}; decided band ${decidedBand.top}..${decidedBand.bottom} (centre ${decidedBand.centre}); default bottom band centre ${defaultBand.centre}`)
      assert.ok(rows.length > 0, `${cueId} must be burned into the frame`)
      assert.ok(Math.abs(centre - decidedBand.centre) <= 14, `glyph centre ${centre.toFixed(1)} must track the decided band centre ${decidedBand.centre}`)
      assert.ok(rows[0].y >= decidedBand.top - 10 && rows.at(-1).y <= decidedBand.bottom + 10, 'every glyph row must lie inside the decided band')
      assert.ok(rows.at(-1).y < Math.round(0.6 * CANVAS[OVERRIDE_VARIANT].height), 'no glyph may reach the presenter')
    }

    // ----- The counterfactual: with no evidence the same plan anchors bottom ---
    // Same EditPlan, same preset, same reframe: only the perception repository
    // differs. If the anchor were authored instead of derived, these two renders
    // would be identical.
    const withoutPerception = await renderThroughRealWorker({
      root, suffix: 'no-perception',
      perceptionTimelines: { async findLatest() { return null } },
      source: renderSourceFor({
        format: OVERRIDE_VARIANT, directedPlan: journey.directedPlan, cues: directedCues,
        projectVersionId: journey.directed.version.id,
        editPlanSnapshotId: journey.editPlanSnapshot.id,
        masterSha256, masterByteSize: masterBytes.byteLength,
        subtitleResolution: subtitleResolution(),
      }),
    })
    assertRenderedVariant(withoutPerception, { operationId: 'operation-no-perception', format: OVERRIDE_VARIANT })
    const blindPlan = withoutPerception.renderInput.placementPlan.subtitleAnchorPlan
    assert.equal(blindPlan.perceptionTimelineHash, null)
    assert.deepEqual(blindPlan.decisions.map((item) => item.anchor), ['bottom', 'bottom', 'bottom'])
    assert.notEqual(blindPlan.anchorPlanHash, anchorPlan.anchorPlanHash)
    assert.notEqual(
      withoutPerception.manifest.recipe.parametersHash,
      basePortrait.manifest.recipe.parametersHash,
      'the recipe identity must move when the anchor evidence moves',
    )
    const blindCentre = glyphCentreRow(
      frameAt(withoutPerception.stored.path, CUE_SAMPLE_SECONDS['subtitle-cue-1'], OVERRIDE_VARIANT),
      OVERRIDE_VARIANT,
    )
    const seeingCentre = glyphCentreRow(
      frameAt(basePortrait.stored.path, CUE_SAMPLE_SECONDS['subtitle-cue-1'], OVERRIDE_VARIANT),
      OVERRIDE_VARIANT,
    )
    console.log(`R2 counterfactual: glyph centre without perception ${blindCentre.toFixed(1)} (bottom band centre ${defaultBand.centre}) vs with perception ${seeingCentre.toFixed(1)} (upper-third centre ${decidedBand.centre})`)
    assert.ok(Math.abs(blindCentre - defaultBand.centre) <= 14, 'without evidence the cue stays on the reserved bottom band')
    assert.ok(blindCentre - seeingCentre > 400, `the evidence moved the subtitle ${(blindCentre - seeingCentre).toFixed(1)}px up the canvas`)

    // ===== Requirement 3: one protected override, one variant, one range ======
    const overrideRepository = new SubtitleSegmentOverrideRepository(
      journey.directed.version,
      directedCues.map((cue) => ({ id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame, text: cue.text })),
    )
    let overrideCounter = 0
    const applyOverride = applySubtitleSegmentOverrideService({
      repository: overrideRepository,
      clock: () => new Date(`2026-08-21T10:0${overrideCounter}:00.000Z`),
      createId: (kind) => `${kind}-subtitle-override-${overrideCounter}`,
    })
    overrideCounter += 1
    const applied = await applyOverride({
      workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
      baseVersionId: journey.directed.version.id, baseHash: journey.directed.version.baseHash,
      variantId: OVERRIDE_VARIANT, segmentId: OVERRIDE_SEGMENT_ID, action: 'set',
      dimensions: [{ kind: 'text', text: OVERRIDE_TEXT }], protected: true,
      actor: proxyActor(), idempotencyKey: 'wave10-subtitle-override-text',
      reason: 'Correcao pontual de uma fala, apenas no vertical.',
    })
    const exception = applied.subtitleOverride
    assert.equal(exception.variantId, OVERRIDE_VARIANT)
    assert.equal(exception.segmentId, OVERRIDE_SEGMENT_ID)
    assert.deepEqual({ ...exception.range }, { startFrame: 70, endFrame: 100 })
    assert.equal(exception.protected, true)
    assert.deepEqual(exception.dimensions.map((item) => item.kind), ['text'])
    assert.equal(applied.command.type, 'apply-subtitle-segment-override')
    assert.deepEqual([...applied.command.scope.outputSpecIds], [OVERRIDE_VARIANT])
    assert.deepEqual({ ...applied.command.scope.frameRange }, { startFrame: 70, endFrame: 100 })
    console.log(`R3 override ${exception.id} overrideHash=${exception.overrideHash.slice(0, 12)} version=${applied.version.id} range=[70,100) variant=${OVERRIDE_VARIANT}`)

    const overrides = await overrideRepository.listCurrentByVariant({ variantId: OVERRIDE_VARIANT })
    const portraitApplication = applySubtitleSegmentOverrides({
      cues: directedCues, overrides, variantId: OVERRIDE_VARIANT,
    })
    const siblingApplication = applySubtitleSegmentOverrides({
      cues: directedCues, overrides, variantId: SIBLING_VARIANT,
    })
    assert.deepEqual(
      portraitApplication.applied.map((item) => [item.overrideId, item.segmentId, [...item.kinds]]),
      [[exception.id, OVERRIDE_SEGMENT_ID, ['text']]],
    )
    assert.deepEqual(
      siblingApplication.skipped.map((item) => [item.overrideId, item.reason]),
      [[exception.id, 'variant-mismatch']],
    )
    assert.deepEqual(siblingApplication.applied, [])
    // Only the named range moved; the other two cues are literally the same objects' text.
    assert.deepEqual(
      portraitApplication.cues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
      [
        ['subtitle-cue-1', 6, 40, 'Abertura clara'],
        ['subtitle-cue-2', 70, 100, OVERRIDE_TEXT],
        ['subtitle-cue-3', 130, 160, 'final'],
      ],
    )
    assert.deepEqual(
      siblingApplication.cues.map((cue) => [cue.id, cue.startFrame, cue.endFrame, cue.text]),
      EXPECTED_CUES.map((entry) => [...entry]),
    )

    // The two renders of the exception version. Perception is re-recorded against
    // the new ProjectVersion, exactly as a recompilation would.
    perceptionTimelines.persistRow(perceptionTimelines.record(applied.version.id, PERCEPTION_TIMELINE))
    const overriddenPortrait = await renderVariant({
      suffix: 'override-9x16', format: OVERRIDE_VARIANT, cues: portraitApplication.cues,
      projectVersionId: applied.version.id, editPlanSnapshotId: 'snapshot-edit-plan-override',
      artifacts,
    })
    const untouchedLandscape = await renderVariant({
      suffix: 'sibling-16x9', format: SIBLING_VARIANT, cues: siblingApplication.cues,
      projectVersionId: applied.version.id, editPlanSnapshotId: 'snapshot-edit-plan-override',
    })
    assertRenderedVariant(overriddenPortrait, { operationId: 'operation-override-9x16', format: OVERRIDE_VARIANT })
    assertRenderedVariant(untouchedLandscape, { operationId: 'operation-sibling-16x9', format: SIBLING_VARIANT })

    // The sibling's compiled plan is byte-identical to the directed one.
    assert.equal(untouchedLandscape.source.editPlanHash, journey.editPlanSnapshot.contentHash)
    assert.notEqual(overriddenPortrait.source.editPlanHash, journey.editPlanSnapshot.contentHash)
    assert.deepEqual(
      overriddenPortrait.renderInput.subtitleCues.map((cue) => cue.text),
      ['Abertura clara', OVERRIDE_TEXT, 'final'],
    )
    assert.deepEqual(
      untouchedLandscape.renderInput.subtitleCues.map((cue) => cue.text),
      ['Abertura clara', 'meio', 'final'],
    )

    // ----- Pixel proof: the new text is visible ONLY in the target variant -----
    const ink = (rendered, format, cueId) =>
      glyphTotal(frameAt(rendered.stored.path, CUE_SAMPLE_SECONDS[cueId], format), format)
    const portraitBefore = ink(basePortrait, OVERRIDE_VARIANT, OVERRIDE_SEGMENT_ID)
    const portraitAfter = ink(overriddenPortrait, OVERRIDE_VARIANT, OVERRIDE_SEGMENT_ID)
    const landscapeBefore = ink(baseLandscape, SIBLING_VARIANT, OVERRIDE_SEGMENT_ID)
    const landscapeAfter = ink(untouchedLandscape, SIBLING_VARIANT, OVERRIDE_SEGMENT_ID)
    console.log(`R3 glyph pixels at ${OVERRIDE_SEGMENT_ID}: 9:16 ${portraitBefore} -> ${portraitAfter}; 16:9 ${landscapeBefore} -> ${landscapeAfter}`)
    assert.ok(portraitAfter > portraitBefore * 1.5,
      `the 27-character exception must burn far more ink than "meio": ${portraitBefore} -> ${portraitAfter}`)
    assert.equal(landscapeAfter, landscapeBefore,
      `the sibling variant must be pixel-identical at ${OVERRIDE_SEGMENT_ID}: ${landscapeBefore} vs ${landscapeAfter}`)
    // Ranges outside the exception are untouched in the target variant too.
    // Prove the materialized cue first: decoded H.264 pixels after the changed
    // GOP can differ slightly across FFmpeg encoders even when the later cue is
    // identical.
    for (const cueId of ['subtitle-cue-1', 'subtitle-cue-3']) {
      const baseCue = basePortrait.renderInput.subtitleCues.find((cue) => cue.id === cueId)
      const overriddenCue = overriddenPortrait.renderInput.subtitleCues.find((cue) => cue.id === cueId)
      assert.deepEqual(overriddenCue, baseCue, `${cueId} materialization must remain byte-identical`)
      const beforeFrame = frameAt(basePortrait.stored.path, CUE_SAMPLE_SECONDS[cueId], OVERRIDE_VARIANT)
      const afterFrame = frameAt(overriddenPortrait.stored.path, CUE_SAMPLE_SECONDS[cueId], OVERRIDE_VARIANT)
      const before = glyphTotal(beforeFrame, OVERRIDE_VARIANT)
      const after = glyphTotal(afterFrame, OVERRIDE_VARIANT)
      const beforeRows = glyphRows(beforeFrame, OVERRIDE_VARIANT)
      const afterRows = glyphRows(afterFrame, OVERRIDE_VARIANT)
      console.log(`R3 glyph pixels at ${cueId} (outside the exception range): 9:16 ${before} -> ${after}`)
      assert.deepEqual(
        [afterRows.at(0)?.y, afterRows.at(-1)?.y],
        [beforeRows.at(0)?.y, beforeRows.at(-1)?.y],
        `${cueId} lies outside [70,100) and must keep the same glyph bounds`,
      )
      assert.ok(
        Math.abs(after - before) <= Math.max(2, Math.ceil(before * 0.01)),
        `${cueId} decoded ink drift must stay within the lossy-codec tolerance: ${before} vs ${after}`,
      )
    }
    // And the whole sibling render is identical: same element map and the very
    // same MP4 bytes, so the exception left no trace at all in 16:9.
    assert.equal(
      calculateCanonicalHash(untouchedLandscape.elementMap.elements),
      calculateCanonicalHash(baseLandscape.elementMap.elements),
    )
    assert.equal(untouchedLandscape.stored.sha256, baseLandscape.stored.sha256)
    assert.equal(untouchedLandscape.stored.byteSize, baseLandscape.stored.byteSize)
    console.log(`R3 sibling 16:9 MP4 is byte-identical to the pre-exception render: sha256=${untouchedLandscape.stored.sha256.slice(0, 12)} (${untouchedLandscape.stored.byteSize} bytes)`)

    // ----- The exception survives an automatic recompilation, unprotected ones do not -----
    overrideCounter += 1
    const unprotected = await applyOverride({
      workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
      baseVersionId: overrideRepository.version.id, baseHash: overrideRepository.version.baseHash,
      variantId: OVERRIDE_VARIANT, segmentId: 'subtitle-cue-3', action: 'set',
      dimensions: [{ kind: 'position', anchor: 'top' }], protected: false,
      actor: proxyActor(), idempotencyKey: 'wave10-subtitle-override-unprotected',
    })
    assert.equal(unprotected.subtitleOverride.protected, false)
    const recompiled = reapplyProtectedSubtitleSegmentOverrides({
      // A fresh Director pass produces the same ranges with the original texts.
      recompiledCues: directedCues,
      overrides: await overrideRepository.listCurrentByVariant({ variantId: OVERRIDE_VARIANT }),
      variantId: OVERRIDE_VARIANT,
    })
    assert.deepEqual(
      recompiled.cues.map((cue) => [cue.id, cue.text]),
      [['subtitle-cue-1', 'Abertura clara'], ['subtitle-cue-2', OVERRIDE_TEXT], ['subtitle-cue-3', 'final']],
    )
    assert.deepEqual(
      recompiled.applied.map((item) => item.overrideId), [exception.id],
    )
    assert.deepEqual(
      recompiled.skipped.map((item) => [item.overrideId, item.reason]),
      [[unprotected.subtitleOverride.id, 'unprotected-recompilation']],
    )
    console.log(`R3 recompilation kept ${recompiled.applied.length} protected exception and dropped ${recompiled.skipped.length} unprotected one`)

    // ===== Requirement 4: the proxy is a real, valid MP4 ======================
    const proxyPath = overriddenPortrait.stored.path
    const [video] = probeStream(proxyPath, 'v:0')
    const [audio] = probeStream(proxyPath, 'a:0')
    assert.equal(video.codec_name, 'h264')
    assert.equal(video.width, CANVAS[OVERRIDE_VARIANT].width)
    assert.equal(video.height, CANVAS[OVERRIDE_VARIANT].height)
    assert.equal(video.r_frame_rate, '30/1')
    assert.equal(audio.codec_name, 'aac')
    const frames = countFrames(proxyPath)
    assert.equal(frames, DURATION_FRAMES, `the proxy must hold exactly ${DURATION_FRAMES} frames, ffprobe counted ${frames}`)
    assert.ok(
      Math.abs(overriddenPortrait.manifest.probe.duration - DURATION_FRAMES / FPS) <= 0.1,
      `180 frames must last 6s, got ${overriddenPortrait.manifest.probe.duration}`,
    )
    console.log(`R4 proxy MP4: ${video.width}x${video.height} @ ${video.r_frame_rate}, ${frames} frames, ${overriddenPortrait.manifest.probe.duration}s, ${overriddenPortrait.stored.byteSize} bytes, audio ${audio.codec_name}`)

    // ===== Requirement 6: manifest, checksum and element map agree ============
    const proxyBytes = await readFile(proxyPath)
    const proxySha256 = createHash('sha256').update(proxyBytes).digest('hex')
    assert.equal(proxySha256, overriddenPortrait.manifest.artifact.sha256)
    assert.equal(proxySha256, overriddenPortrait.stored.sha256)
    assert.equal(proxySha256, overriddenPortrait.elementMap.proxyHash)
    assert.equal(Number(overriddenPortrait.manifest.artifact.byteSize), proxyBytes.byteLength)
    const persistedRecord = await artifacts.findById(WORKSPACE_ID, 'artifact-override-9x16-proxy')
    assert.ok(persistedRecord, 'the worker must have persisted the proxy artifact')
    assert.equal(persistedRecord.sha256, proxySha256)
    const persistedMap = validateRenderElementMap({ ...overriddenPortrait.elementMap }, proxySha256)
    const mapHash = renderElementMapHash(persistedMap)
    console.log(`R6 sha256=${proxySha256.slice(0, 12)} bytes=${proxyBytes.byteLength} mapHash=${mapHash.slice(0, 12)} elements=${persistedMap.elements.length}`)

    // ===== Requirement 5: the sidecar comes from THIS render's alignment ======
    const cueTexts = Object.fromEntries(
      overriddenPortrait.renderInput.subtitleCues.map((cue) => [cue.id, cue.text]))
    const alignment = Object.freeze({
      projectId: PROJECT_ID,
      projectVersionId: applied.version.id,
      projectVersionSequence: applied.version.sequence,
      isCurrentVersion: true,
      variantId: OVERRIDE_VARIANT,
      outputKind: 'proxy',
      outputArtifactId: 'artifact-override-9x16-proxy',
      outputManifestId: 'manifest-override-9x16-proxy',
      outputArtifactKey: overriddenPortrait.stored.key,
      outputSha256: proxySha256,
      // The identity the proxy render operation itself carries, exactly like the
      // Postgres adapter (`v2ProjectProxyRenderOperation.inputHash`).
      renderInputHash: overriddenPortrait.expectedInputHash,
      editPlanSnapshotId: 'snapshot-edit-plan-override',
      editPlanHash: overriddenPortrait.source.editPlanHash,
      renderElementMapId: 'render-element-map-wave10',
      renderElementMapHash: mapHash,
      map: overriddenPortrait.elementMap,
      cueTexts,
    })
    const alignments = new Map([[`${applied.version.id}:${OVERRIDE_VARIANT}`, alignment]])
    alignments.set(`head:${OVERRIDE_VARIANT}`, alignment)
    const sidecars = inMemorySidecars(alignments)
    const sidecarDependencies = {
      sidecars, artifacts, persistence: artifacts,
      storage: new LocalMediaUploadStorage(artifactRoot),
      staging: new TemporaryFileSubtitleSidecarStaging(join(root, 'staging')),
      clock: () => new Date('2026-08-21T11:00:00.000Z'),
    }
    const exportSidecar = exportProjectSubtitleSidecarService(sidecarDependencies)
    const srt = await exportSidecar({
      workspaceId: WORKSPACE_ID, actor: proxyActor(), projectId: PROJECT_ID,
      variantId: OVERRIDE_VARIANT, format: 'srt', idempotencyKey: 'wave10-sidecar-srt',
    })
    const vtt = await exportSidecar({
      workspaceId: WORKSPACE_ID, actor: proxyActor(), projectId: PROJECT_ID,
      variantId: OVERRIDE_VARIANT, format: 'vtt', idempotencyKey: 'wave10-sidecar-vtt',
    })

    for (const result of [srt, vtt]) {
      const path = join(artifactRoot, ...result.sidecar.artifactKey.split('/'))
      const bytes = await readFile(path)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sidecar.sha256)
      assert.equal(bytes.byteLength, result.sidecar.byteSize)
      // Bound to the very MP4 and the very map of this operation.
      assert.equal(result.sidecar.outputSha256, proxySha256)
      assert.equal(result.sidecar.renderElementMapHash, mapHash)
      assert.equal(result.sidecar.renderInputHash, overriddenPortrait.expectedInputHash)
      assert.equal(result.sidecar.projectVersionId, applied.version.id)
      assert.equal(result.replayed, false)
      // End-to-end coherence: the sidecar carries the exception, not the original.
      const parsed = parseSubtitleSidecar(bytes, result.sidecar.format)
      assert.equal(parsed.length, 3)
      assert.deepEqual(parsed.map((cue) => cue.text), ['Abertura clara', OVERRIDE_TEXT, 'final'])
      assert.deepEqual(
        parsed.map((cue) => [cue.startMs, cue.endMs]),
        EXPECTED_CUES.map(([, startFrame, endFrame]) => [
          subtitleSidecarFrameToMs(startFrame, FPS), subtitleSidecarFrameToMs(endFrame, FPS),
        ]),
      )
      assert.ok(bytes.includes(Buffer.from(OVERRIDE_TEXT, 'utf8')), 'the exception text must be in the sidecar bytes')
      console.log(`R5 ${result.sidecar.format}: ${result.sidecar.byteSize} bytes sha256=${result.sidecar.sha256.slice(0, 12)} cues=${result.sidecar.cueCount}`)
    }
    assert.notEqual(srt.sidecar.sha256, vtt.sidecar.sha256)

    // Reconstruction is byte-identical: the same persisted map re-encodes to the
    // same digest, recomputed here through the production domain functions.
    const reconstructed = encodeSubtitleSidecar({
      cues: collectRenderedSubtitleCues({ map: persistedMap, texts: cueTexts }),
      format: 'srt', locale: 'pt-BR',
      durationMs: subtitleSidecarFrameToMs(persistedMap.durationFrames, persistedMap.fps),
    })
    assert.equal(reconstructed.sha256, srt.sidecar.sha256)
    assert.equal(reconstructed.byteSize, srt.sidecar.byteSize)
    const rerun = await exportSidecar({
      workspaceId: WORKSPACE_ID, actor: proxyActor(), projectId: PROJECT_ID,
      variantId: OVERRIDE_VARIANT, format: 'srt', idempotencyKey: 'wave10-sidecar-srt-again',
    })
    assert.equal(rerun.sidecar.sha256, srt.sidecar.sha256)
    assert.equal(rerun.sidecar.artifactId, srt.sidecar.artifactId)
    assert.equal(rerun.sidecar.lineageHash, srt.sidecar.lineageHash)
    assert.equal(rerun.replayed, true)
    assert.equal(sidecars.rows.length, 2, 'srt and vtt are one row each; a re-derivation adds none')
    const listed = await listProjectSubtitleSidecarsService({ sidecars })({
      workspaceId: WORKSPACE_ID, actor: proxyActor(), projectId: PROJECT_ID,
    })
    assert.equal(listed.sidecars.length, 2)
    console.log(`R5 reconstruction byte-identical: sha256=${reconstructed.sha256.slice(0, 12)} bytes=${reconstructed.byteSize}, replay added no row (${sidecars.rows.length} rows)`)

    // The sidecar artifact's lineage points at the MP4 this journey rendered.
    const sidecarArtifact = await artifacts.findById(WORKSPACE_ID, srt.sidecar.artifactId)
    assert.equal(sidecarArtifact.container, 'srt')
    assert.equal(sidecarArtifact.mediaType, 'data')
    assert.equal(sidecarArtifact.manifests[0].recipe.id, 'subtitle-sidecar')
    assert.equal(sidecarArtifact.manifests[0].sources[0].sha256, proxySha256)
    assert.equal(sidecarArtifact.manifests[0].sources[0].artifactKey, overriddenPortrait.stored.key)

    // ===== Requirement 7 (sidecar half): a tampered map is refused ============
    const tamperedHash = { ...alignment, renderElementMapHash: 'f'.repeat(64) }
    alignments.set(`head:${OVERRIDE_VARIANT}`, tamperedHash)
    await assert.rejects(
      () => exportSidecar({
        workspaceId: WORKSPACE_ID, actor: proxyActor(), projectId: PROJECT_ID,
        variantId: OVERRIDE_VARIANT, format: 'srt', idempotencyKey: 'wave10-sidecar-tamper-hash',
      }),
      (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    )
    // A cue widened inside the map after the render.
    const widened = {
      ...alignment,
      map: {
        ...alignment.map,
        elements: alignment.map.elements.filter((element) =>
          !(element.elementId === `subtitle:${OVERRIDE_SEGMENT_ID}` && element.frame === 99)),
      },
    }
    alignments.set(`head:${OVERRIDE_VARIANT}`, widened)
    await assert.rejects(
      () => exportSidecar({
        workspaceId: WORKSPACE_ID, actor: proxyActor(), projectId: PROJECT_ID,
        variantId: OVERRIDE_VARIANT, format: 'srt', idempotencyKey: 'wave10-sidecar-tamper-map',
      }),
      (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    )
    // An alignment redirected at an artifact that no render produced. The master
    // was ingested, not rendered, so its manifest recipe is not a render recipe.
    alignments.set(`head:${OVERRIDE_VARIANT}`, {
      ...alignment,
      outputArtifactId: MASTER_ARTIFACT_ID,
      outputManifestId: MASTER_MANIFEST_ID,
      outputArtifactKey: MASTER_ARTIFACT_KEY,
      outputSha256: masterSha256,
    })
    await assert.rejects(
      () => exportSidecar({
        workspaceId: WORKSPACE_ID, actor: proxyActor(), projectId: PROJECT_ID,
        variantId: OVERRIDE_VARIANT, format: 'srt', idempotencyKey: 'wave10-sidecar-tamper-artifact',
      }),
      (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    )
    assert.equal(sidecars.rows.length, 2, 'no tampered attempt may persist a sidecar')
    alignments.set(`head:${OVERRIDE_VARIANT}`, alignment)
    console.log('R7 sidecar: a rewritten map hash, a dropped cue frame and a non-render artifact all fail closed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Requirement 7 (render half): nothing tampered ever reaches FFmpeg.
// ---------------------------------------------------------------------------

test('T-WAVE10 a tampered preset snapshot or perception evidence never reaches the renderer', {
  timeout: 20 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-wave10-tamper-'))
  const masterPath = join(root, 'wave10-master.mp4')
  try {
    await writeColourMaster(masterPath)
    const masterBytes = await readFile(masterPath)
    const masterSha256 = createHash('sha256').update(masterBytes).digest('hex')
    const artifactRoot = join(root, 'artifacts')
    const masterTarget = join(artifactRoot, ...MASTER_ARTIFACT_KEY.split('/'))
    await mkdir(join(masterTarget, '..'), { recursive: true })
    await copyFile(masterPath, masterTarget)

    const artifacts = inMemoryArtifacts()
    artifacts.seed({
      id: MASTER_ARTIFACT_ID, workspaceId: WORKSPACE_ID, artifactKey: MASTER_ARTIFACT_KEY,
      sha256: masterSha256, byteSize: BigInt(masterBytes.byteLength), mediaType: 'video',
      container: 'mp4', status: 'available', lifecycleRevision: 1,
      manifests: [], createdAt: CREATED_AT,
    })
    const journey = await directOnce()
    const directedCues = journey.directedPlan.subtitleTracks.flatMap((track) => track.cues)
    const perceptionTimelines = new PerceptionTimelineRepository()
    const cleanRow = perceptionTimelines.record(journey.directed.version.id, PERCEPTION_TIMELINE)
    perceptionTimelines.persistRow(cleanRow)

    const run = (suffix, options = {}) => renderThroughRealWorker({
      root, suffix,
      perceptionTimelines: options.perceptionTimelines ?? perceptionTimelines,
      source: renderSourceFor({
        format: OVERRIDE_VARIANT, directedPlan: journey.directedPlan, cues: directedCues,
        projectVersionId: journey.directed.version.id,
        editPlanSnapshotId: journey.editPlanSnapshot.id,
        masterSha256, masterByteSize: masterBytes.byteLength,
        subtitleResolution: subtitleResolution(),
      }),
      ...(options.tamper ? { tamper: options.tamper } : {}),
    })

    // --- Family 1: the content-addressed preset snapshot (F1.035) ------------
    const snapshotTampers = [
      ['presetSnapshotHash', (source) => ({
        ...source,
        subtitleResolution: {
          ...source.subtitleResolution,
          presetSnapshot: { ...source.subtitleResolution.presetSnapshot, snapshotHash: 'f'.repeat(64) },
        },
      })],
      ['presetSnapshot.tokens', (source) => ({
        ...source,
        subtitleResolution: {
          ...source.subtitleResolution,
          presetSnapshot: {
            ...source.subtitleResolution.presetSnapshot,
            tokens: {
              ...source.subtitleResolution.presetSnapshot.tokens,
              grouping: { ...source.subtitleResolution.presetSnapshot.tokens.grouping, maxCharsPerLine: 99 },
            },
          },
        },
      })],
      ['presetSnapshot.absent', (source) => {
        const { presetSnapshot, ...resolution } = source.subtitleResolution
        return { ...source, subtitleResolution: resolution }
      }],
    ]
    for (const [label, tamper] of snapshotTampers) {
      const suffix = `tamper-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      const rejected = await run(suffix, { tamper })
      console.log(`R7 ${label}: outcome=${JSON.stringify(rejected.outcome)} phases=${JSON.stringify(rejected.phases)} renderCalls=${rejected.renderCalls} error=${rejected.failure.code}`)
      assert.deepEqual(rejected.outcome, { operationId: `operation-${suffix}`, status: 'failed' })
      assert.equal(rejected.operation.status, 'failed')
      assert.equal(rejected.failure.retryable, false)
      assert.deepEqual(rejected.phases, [], 'the operation must never enter the rendering phase')
      assert.equal(rejected.renderCalls, 0, 'the renderer port must never be called for a tampered snapshot')
      assert.equal(rejected.stored, undefined)
      assert.equal(rejected.manifest, undefined)
      assert.equal(rejected.review, undefined)
    }

    // --- Family 2: the perception evidence behind the anchor plan (F1.036) ---
    // The anchor plan is DERIVED by the worker, so persistence cannot carry a
    // forged `anchorPlanHash`; what persistence can carry is forged evidence. A
    // row whose observations no longer hash to the stored digest is refused on
    // read — the same gate `PrismaPerceptionTimelineRepository.hydrate` runs.
    const tamperedRow = {
      ...cleanRow,
      timeline: {
        ...cleanRow.timeline,
        observations: cleanRow.timeline.observations.map((item) => ({
          ...item, value: { bounds: { x: 0.3, y: 0.02, width: 0.4, height: 0.1 } },
        })),
      },
    }
    const tamperedPerception = new PerceptionTimelineRepository()
    tamperedPerception.persistRow(tamperedRow)
    const forgedEvidence = await run('tamper-perception-evidence', { perceptionTimelines: tamperedPerception })
    console.log(`R7 perceptionTimeline: outcome=${JSON.stringify(forgedEvidence.outcome)} phases=${JSON.stringify(forgedEvidence.phases)} renderCalls=${forgedEvidence.renderCalls} error=${forgedEvidence.failure.code}`)
    assert.deepEqual(forgedEvidence.outcome, { operationId: 'operation-tamper-perception-evidence', status: 'failed' })
    assert.deepEqual(forgedEvidence.phases, [])
    assert.equal(forgedEvidence.renderCalls, 0)
    assert.equal(forgedEvidence.stored, undefined)

    // --- Family 3: `anchorPlanHash` at the renderer's own trust boundary -----
    const clean = await run('tamper-control')
    assertRenderedVariant(clean, { operationId: 'operation-tamper-control', format: OVERRIDE_VARIANT })
    const cleanPlan = clean.renderInput.placementPlan
    const scratchBefore = await readdirSafe(clean.workRoot)
    await assert.rejects(
      () => clean.renderer.render({
        ...clean.renderInput,
        operationId: 'operation-anchor-tamper',
        placementPlan: {
          ...cleanPlan,
          subtitleAnchorPlan: { ...cleanPlan.subtitleAnchorPlan, anchorPlanHash: '2'.repeat(64) },
        },
        signal: undefined,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_RENDER_INPUT')
        assert.match(error.message, /Subtitle anchor plan hash is inconsistent|Placement plan hash is inconsistent/)
        return true
      },
    )
    // Not one byte was written: the digest was checked before any encode started.
    assert.deepEqual(await readdirSafe(clean.workRoot), scratchBefore)
    // A decision rewritten onto another band is refused for its own reason.
    await assert.rejects(
      () => clean.renderer.render({
        ...clean.renderInput,
        operationId: 'operation-anchor-band-tamper',
        placementPlan: {
          ...cleanPlan,
          subtitleAnchorPlan: {
            ...cleanPlan.subtitleAnchorPlan,
            decisions: cleanPlan.subtitleAnchorPlan.decisions.map((decision) => ({
              ...decision, anchor: 'bottom', bounds: cleanPlan.subtitleAnchorPlan.bands.bottom,
            })),
          },
        },
        signal: undefined,
      }),
      (error) => error.code === 'INVALID_RENDER_INPUT',
    )
    assert.deepEqual(await readdirSafe(clean.workRoot), scratchBefore)
    console.log('R7 anchorPlanHash: the renderer rejected the forged digest and the forged band with INVALID_RENDER_INPUT and wrote nothing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
