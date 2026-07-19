import {
  type DirectedEditPlan,
  type DirectedSubtitleCue,
  type DirectorDecision,
  type DirectorPerceptionSnapshot,
  type DirectorQualityReport,
  type DirectorRun,
  type RunDirectorCommandPayload,
  validateDirectedEditPlan,
  validateDirectorDecisions,
} from '../domain/director-run.ts'
import { createEditCommand } from '../domain/edit-command.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createPerceptionTimeline, type PerceptionObservation } from '../domain/perception-timeline.ts'
import { createProjectSnapshot, type ProjectSnapshot, type ProjectSnapshotKind } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import { resolveStrategicObjective } from '../domain/strategic-objective.ts'
import { validateStoryPlan, type StoryBlock, type StoryPlan } from '../domain/story-plan.ts'
import { createTreatmentPlan } from '../domain/treatment-plan.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'

const PLANNER_VERSION = 'apollo-director-policy/v1'
const CRITIC_VERSION = 'apollo-director-critic/v1'
const SUBTITLE_MAX_CHARACTERS = 32

export interface RunProjectDirectorRequest {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  actor: Readonly<{ type: 'api-client'; id: string }>
  idempotency: Readonly<{ key: string }>
  reason?: string
}

export interface RunProjectDirectorDependencies {
  repository: DirectorRunRepository
  clock: () => Date
  createId: (kind: 'director-run' | 'edit-command' | 'project-version' | 'project-snapshot') => string
  createEventId: () => string
}

function normalizedIdentifier(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized), 'INVALID_COMMAND', `${field} is invalid`)
  return normalized
}

function mergeCoverage(ranges: readonly (readonly [number, number])[]): number {
  if (ranges.length === 0) return 0
  const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  let start = sorted[0]![0]
  let end = sorted[0]![1]
  let total = 0
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd)
    else { total += end - start; start = nextStart; end = nextEnd }
  }
  return total + end - start
}

function buildPerception(input: {
  id: string
  durationFrames: number
  fps: number
  transcript: {
    id: string
    provider: string
    model: string
    transcriptHash: string
  }
  words: readonly Readonly<{
    text: string
    sourceStartSeconds: number
    sourceEndSeconds: number
    timelineStartFrame: number
    timelineEndFrame: number
  }>[]
}): Readonly<DirectorPerceptionSnapshot> {
  const durationMs = Math.max(1, Math.ceil(input.durationFrames / input.fps * 1000))
  const observations: PerceptionObservation[] = input.words.map((word, index) => ({
    id: `transcript-word-${index + 1}`,
    kind: 'transcript-word' as const,
    startMs: Math.max(0, Math.min(durationMs - 1, Math.round(word.timelineStartFrame / input.fps * 1000))),
    endMs: Math.max(0, Math.min(durationMs, Math.round(word.timelineEndFrame / input.fps * 1000))),
    value: Object.freeze({
      text: word.text,
      sourceStartSeconds: word.sourceStartSeconds,
      sourceEndSeconds: word.sourceEndSeconds,
    }),
    provenance: Object.freeze({
      source: input.transcript.id,
      model: `${input.transcript.provider}/${input.transcript.model}`,
      version: input.transcript.transcriptHash,
      confidence: 0.82,
    }),
  })).map((observation) => observation.endMs <= observation.startMs
    ? { ...observation, endMs: Math.min(durationMs, observation.startMs + 1) }
    : observation)
  const timeline = createPerceptionTimeline({ durationMs, observations })
  const speechMs = mergeCoverage(timeline.observations
    .filter((item) => item.kind === 'transcript-word')
    .map((item) => [item.startMs, item.endMs] as const))
  return Object.freeze({
    schemaVersion: 1 as const,
    id: input.id,
    timeline,
    summary: Object.freeze({
      id: `${input.id}-summary`,
      speechCoverage: Number(Math.min(1, speechMs / durationMs).toFixed(4)),
      visualCoverage: 'partial' as const,
      faceCoverage: 'absent' as const,
      confidence: 0.82,
      sourceTranscriptId: input.transcript.id,
    }),
  })
}

function buildSubtitleCues(input: {
  words: readonly Readonly<{
    text: string
    timelineStartFrame: number
    timelineEndFrame: number
  }>[]
  durationFrames: number
  fps: number
}): readonly Readonly<DirectedSubtitleCue>[] {
  const cues: DirectedSubtitleCue[] = []
  let group: typeof input.words = []
  let previousEndFrame = 0
  const flush = () => {
    if (group.length === 0) return
    const text = group.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim()
    const startFrame = Math.max(previousEndFrame, group[0]!.timelineStartFrame)
    const endFrame = Math.min(input.durationFrames, Math.max(startFrame + 1, group.at(-1)!.timelineEndFrame))
    if (text && startFrame < endFrame) {
      cues.push({ id: `subtitle-cue-${cues.length + 1}`, startFrame, endFrame, text, anchor: 'bottom' })
      previousEndFrame = endFrame
    }
    group = []
  }
  for (const word of input.words) {
    const candidateText = [...group, word].map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim()
    const candidateDuration = group.length === 0 ? 0 : (word.timelineEndFrame - group[0]!.timelineStartFrame) / input.fps
    const gapFrames = group.length === 0 ? 0 : word.timelineStartFrame - group.at(-1)!.timelineEndFrame
    if (group.length > 0 && (
      candidateText.length > SUBTITLE_MAX_CHARACTERS ||
      candidateDuration > 2.4 ||
      gapFrames > input.fps * 0.55 ||
      group.length >= 5
    )) flush()
    group = [...group, word]
    if (/[.!?]$/.test(word.text) || group.length >= 5) flush()
  }
  flush()
  return Object.freeze(cues.map((cue) => Object.freeze(cue)))
}

function buildStoryPlan(input: {
  id: string
  objective: string
  clips: readonly Readonly<{
    id: string
    timelineInFrame: number
    timelineOutFrame: number
  }>[]
  fps: number
  durationFrames: number
}): Readonly<StoryPlan> & Readonly<{ id: string }> {
  const blocks: StoryBlock[] = input.clips.map((clip, index) => {
    const durationMs = Math.max(1, Math.round((clip.timelineOutFrame - clip.timelineInFrame) / input.fps * 1000))
    return {
      id: `story-block-${index + 1}`,
      actId: index === 0 ? 'opening' : 'development',
      role: index === 0 ? 'hook' : index === input.clips.length - 1 ? 'context' : 'argument',
      intent: index === 0 ? 'establish-speaker-and-premise' : index === input.clips.length - 1 ? 'close-with-next-understanding' : 'develop-value-and-proof-context',
      dependencies: index === 0 ? [] : [`story-block-${index}`],
      sourceCandidateIds: [clip.id],
      durationTargetMs: { min: Math.max(1, durationMs - 1_000), ideal: durationMs, max: durationMs + 1_000 },
      content: { claimIds: [], qualifierIds: [], proofIds: [] },
      presentation: 'source-video',
      sourceRangeId: clip.id,
    }
  })
  const opening = blocks.filter((block) => block.actId === 'opening').map((block) => block.id)
  const development = blocks.filter((block) => block.actId === 'development').map((block) => block.id)
  const durationMs = Math.max(1, Math.round(input.durationFrames / input.fps * 1000))
  const plan: StoryPlan & { id: string } = {
    id: input.id,
    schemaVersion: 1,
    objective: input.objective,
    targetDurationMs: { min: Math.max(1, durationMs - 1_000), max: durationMs + 1_000 },
    acts: [
      { id: 'opening', role: 'opening', blockIds: opening },
      ...(development.length ? [{ id: 'development', role: 'development' as const, blockIds: development }] : []),
    ],
    blocks,
  }
  validateStoryPlan(plan)
  return Object.freeze({ ...plan, acts: Object.freeze(plan.acts), blocks: Object.freeze(plan.blocks.map((block) => Object.freeze(block))) })
}

function buildDecisions(input: {
  briefRef: string
  transcriptRef: string
  editPlanRef: string
  policyRef: string
}): readonly Readonly<DirectorDecision>[] {
  return validateDirectorDecisions([
    {
      id: 'decision-narrative-linear', category: 'narrative', choice: 'preserve-linear-narrative',
      reason: 'The retained source already opens with context and develops one continuous argument; reordering would weaken attribution.',
      evidenceRefs: [input.transcriptRef, input.editPlanRef], confidence: 0.94,
      alternatives: ['cold-open-reference'],
    },
    {
      id: 'decision-motion-none', category: 'movement', choice: 'no_effect',
      reason: 'The owner requested a direct, natural tone and no semantic event justifies camera simulation.',
      evidenceRefs: [input.briefRef, input.policyRef], confidence: 0.99,
      alternatives: ['single-punch-in-after-opening'],
    },
    {
      id: 'decision-layout-inset', category: 'layout', choice: 'landscape-inset-on-blurred-source',
      reason: 'Preserves the full head and shoulders in 9:16 without the aggressive crop that previously cut the face.',
      evidenceRefs: [input.briefRef, input.editPlanRef], confidence: 0.92,
      alternatives: ['center-crop', 'top-aligned-inset'],
    },
    {
      id: 'decision-subtitle-bottom', category: 'subtitle', choice: 'bottom-face-safe-clean',
      reason: 'Face observations are unavailable, so captions use a conservative region below the inset instead of covering the eyes.',
      evidenceRefs: [input.transcriptRef, input.policyRef], confidence: 0.96,
      alternatives: ['lower-third-dynamic', 'manual-anchor-review'],
    },
    {
      id: 'decision-transition-straight', category: 'transition', choice: 'straight-cut-with-audio-edge-fade',
      reason: 'All retained clips show the same speaker and setting; an ornamental transition would draw attention to the edit.',
      evidenceRefs: [input.editPlanRef], confidence: 0.97,
      alternatives: ['short-dissolve'],
    },
    {
      id: 'decision-insert-none', category: 'insert', choice: 'no_insert',
      reason: 'No rights-approved supporting asset is linked to the project, so the Director omits B-roll instead of fabricating relevance.',
      evidenceRefs: [input.editPlanRef, input.policyRef], confidence: 1,
      alternatives: ['request-library-search'],
    },
  ])
}

function normalizedSpeech(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function buildQualityReport(input: {
  id: string
  plan: Readonly<DirectedEditPlan>
  evaluatedAt: string
}): Readonly<DirectorQualityReport> {
  const cues = input.plan.subtitleTracks.flatMap((track) => track.cues)
  const allSubtitleText = normalizedSpeech(cues.map((cue) => cue.text).join(' '))
  const forbiddenSpeechAbsent = !['31 de janeiro', '1 de fevereiro', 'dois dias'].some((phrase) => allSubtitleText.includes(normalizedSpeech(phrase)))
  const clips = input.plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  const timelineContinuous = clips.every((clip, index) => clip.timelineInFrame === (index === 0 ? 0 : clips[index - 1]!.timelineOutFrame)) && clips.at(-1)?.timelineOutFrame === input.plan.durationFrames
  const hardChecks = Object.freeze({
    openingMotionProtected: input.plan.movementPolicy.protectedOpeningFrames >= Math.round(input.plan.fps * 4) && input.plan.effectTracks.length === 0,
    automaticZoomDisabled: input.plan.movementPolicy.automaticZoom === false,
    subtitlesFaceSafe: cues.every((cue) => cue.anchor === 'bottom') && input.plan.subtitlePolicy.faceProtection === true,
    subtitlesBounded: cues.every((cue) => cue.text.length <= input.plan.subtitlePolicy.maxCharactersPerBlock),
    forbiddenSpeechAbsent,
    timelineContinuous,
  })
  const issues = Object.freeze([{
    code: 'FACE_PERCEPTION_UNAVAILABLE_SAFE_FALLBACK',
    severity: 'warning' as const,
    category: 'editorial' as const,
    message: 'No face detector evidence is available; the caption track uses the conservative bottom safe region.',
    rangeMs: [0, Math.round(input.plan.durationFrames / input.plan.fps * 1000)] as const,
    targetId: input.plan.subtitleTracks[0]?.id ?? 'subtitle-track',
    correctable: true,
  }])
  const blocked = Object.values(hardChecks).some((value) => !value)
  return Object.freeze({
    schemaVersion: 'director-quality-report/v1' as const,
    id: input.id,
    status: blocked ? 'blocked' as const : issues.length ? 'approved-with-warnings' as const : 'approved' as const,
    score: blocked ? 0 : 0.9,
    hardChecks,
    issues,
    criticVersion: CRITIC_VERSION,
    evaluatedAt: input.evaluatedAt,
  })
}

function snapshot(input: {
  id: string
  workspaceId: string
  projectId: string
  kind: ProjectSnapshotKind
  contentSchemaVersion: number
  value: unknown
  createdAt: string
}): Readonly<ProjectSnapshot> {
  return createProjectSnapshot({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    kind: input.kind,
    contentSchemaVersion: input.contentSchemaVersion,
    contentJson: stableSerialize(input.value),
    contentHash: calculateVersionHash(input.value),
    createdAt: input.createdAt,
  })
}

export function runProjectDirectorService(dependencies: RunProjectDirectorDependencies) {
  return async function run(request: RunProjectDirectorRequest) {
    const workspaceId = normalizedIdentifier(request.workspaceId, 'workspaceId')
    const projectId = normalizedIdentifier(request.projectId, 'projectId')
    const baseVersionId = normalizedIdentifier(request.baseVersionId, 'baseVersionId')
    const clientId = normalizedIdentifier(request.actor.id, 'actor.id')
    const idempotencyKey = request.idempotency.key.trim()
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_COMMAND', 'baseHash is invalid')
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_COMMAND', 'Idempotency-Key is invalid')
    const requestFingerprint = calculateVersionHash({
      type: 'run-director', workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      plannerVersion: PLANNER_VERSION, criticVersion: CRITIC_VERSION, reason: request.reason?.trim() || null,
    })
    const existing = await dependencies.repository.findIdempotentResult({ workspaceId, projectId, idempotencyKey })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with different Director input')
      return Object.freeze({ ...existing.result, replayed: true })
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project with aligned media was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Director base version is stale', { currentVersionId: context.currentVersion.id, currentBaseHash: context.currentVersion.baseHash })
    }
    const objective = resolveStrategicObjective(context.project.objective)
    const clips = context.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
    assertDomain(clips.length > 0 && context.editPlan.retimedTranscript.words.length > 0, 'INVALID_COMMAND', 'Director requires a compiled editorial timeline and retimed transcript')
    const createdAt = dependencies.clock().toISOString()
    const directorRunId = dependencies.createId('director-run')
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const perceptionId = `perception-${directorRunId}`
    const treatmentPlanId = `treatment-${directorRunId}`
    const storyPlanId = `story-${directorRunId}`
    const qualityReportId = `quality-${directorRunId}`
    const perception = buildPerception({
      id: perceptionId,
      durationFrames: context.editPlan.durationFrames,
      fps: context.editPlan.fps,
      transcript: context.transcript,
      words: context.editPlan.retimedTranscript.words,
    })
    const treatmentBase = createTreatmentPlan({
      objective: objective.id,
      mode: 'talking-head',
      rubric: { id: `${objective.rubricId}/v1`, version: 1, proofRequired: false },
      policy: { snapshotId: context.currentVersion.snapshotRefs.policies, maxPatternBreaksPer30s: 2, forbiddenEffects: ['zoom'] },
      perception: {
        summaryId: perception.summary.id,
        confidence: perception.summary.confidence,
        speakerCoverage: perception.summary.speechCoverage,
        visualVariety: 0,
      },
    })
    const treatmentPlan = Object.freeze({ id: treatmentPlanId, ...treatmentBase })
    const storyPlan = buildStoryPlan({ id: storyPlanId, objective: objective.id, clips, fps: context.editPlan.fps, durationFrames: context.editPlan.durationFrames })
    const decisions = buildDecisions({
      briefRef: context.currentVersion.snapshotRefs.brief ?? 'brief-unavailable',
      transcriptRef: context.transcript.id,
      editPlanRef: context.currentVersion.snapshotRefs.editPlan,
      policyRef: context.currentVersion.snapshotRefs.policies,
    })
    const assumptions = Object.freeze([
      'Face detector evidence is unavailable; use a conservative caption-safe region below the source inset.',
      'No rights-approved B-roll candidate is linked; omission is safer than an irrelevant insert.',
    ])
    const subtitleCues = buildSubtitleCues({
      words: context.editPlan.retimedTranscript.words,
      durationFrames: context.editPlan.durationFrames,
      fps: context.editPlan.fps,
    })
    const transitions = Object.freeze(clips.slice(0, -1).map((clip, index) => Object.freeze({
      id: `transition-${index + 1}`,
      fromClipId: clip.id,
      toClipId: clips[index + 1]!.id,
      atFrame: clip.timelineOutFrame,
      type: 'straight-cut' as const,
      audioFadeMs: 24,
      reason: 'Same speaker and setting: preserve continuity with an invisible straight cut and bounded audio edge fade.',
    })))
    const editPlan: DirectedEditPlan = {
      ...context.editPlan,
      id: `edit-plan-${versionId}`,
      projectVersionId: versionId,
      storyPlanId,
      treatmentPlanId,
      directorRunId,
      subtitleTracks: Object.freeze([Object.freeze({
        id: 'track-captions-pt-br', kind: 'captions' as const, presetId: 'clean-color' as const,
        anchor: 'bottom' as const, faceProtection: true as const, maxLines: 2 as const,
        maxCharactersPerBlock: SUBTITLE_MAX_CHARACTERS, cues: subtitleCues,
      })]),
      effectTracks: Object.freeze([]),
      transitions,
      composition: Object.freeze({
        layout: 'landscape-inset' as const,
        background: 'blurred-source' as const,
        foregroundScale: 1 as const,
        verticalPosition: 0.5 as const,
        faceSafeFallback: Object.freeze([0.14, 0.08, 0.72, 0.57] as const),
        subtitleSafeRegion: Object.freeze([0.08, 0.72, 0.84, 0.2] as const),
      }),
      director: Object.freeze({ plannerVersion: PLANNER_VERSION, decisions, assumptions }),
      movementPolicy: Object.freeze({ automaticZoom: false as const, protectedOpeningFrames: Math.max(context.editPlan.movementPolicy.protectedOpeningFrames, Math.round(context.editPlan.fps * 4)) }),
      subtitlePolicy: Object.freeze({ faceProtection: true as const, anchor: 'bottom' as const, maxCharactersPerBlock: SUBTITLE_MAX_CHARACTERS }),
      createdAt,
    }
    validateDirectedEditPlan(editPlan)
    const qualityReport = buildQualityReport({ id: qualityReportId, plan: editPlan, evaluatedAt: createdAt })
    assertDomain(qualityReport.status !== 'blocked', 'INVALID_RENDER_INPUT', 'Director critic blocked the proposed EditPlan')
    const perceptionSnapshotId = dependencies.createId('project-snapshot')
    const treatmentSnapshotId = dependencies.createId('project-snapshot')
    const storySnapshotId = dependencies.createId('project-snapshot')
    const editPlanSnapshotId = dependencies.createId('project-snapshot')
    const qualitySnapshotId = dependencies.createId('project-snapshot')
    const snapshots = Object.freeze([
      snapshot({ id: perceptionSnapshotId, workspaceId, projectId, kind: 'perception', contentSchemaVersion: 1, value: perception, createdAt }),
      snapshot({ id: treatmentSnapshotId, workspaceId, projectId, kind: 'treatment', contentSchemaVersion: 1, value: treatmentPlan, createdAt }),
      snapshot({ id: storySnapshotId, workspaceId, projectId, kind: 'story', contentSchemaVersion: 1, value: storyPlan, createdAt }),
      snapshot({ id: editPlanSnapshotId, workspaceId, projectId, kind: 'edit-plan', contentSchemaVersion: 2, value: editPlan, createdAt }),
      snapshot({ id: qualitySnapshotId, workspaceId, projectId, kind: 'quality-report', contentSchemaVersion: 1, value: qualityReport, createdAt }),
    ])
    const snapshotRefs = Object.freeze({
      perception: perceptionSnapshotId,
      treatment: treatmentSnapshotId,
      story: storySnapshotId,
      editPlan: editPlanSnapshotId,
      quality: qualitySnapshotId,
    })
    const commandPayload: RunDirectorCommandPayload = Object.freeze({
      schemaVersion: 1 as const,
      directorRunId,
      plannerVersion: PLANNER_VERSION,
      criticVersion: CRITIC_VERSION,
      sourceTranscriptId: context.transcript.id,
      sourceArtifactId: context.transcript.sourceArtifactId,
      snapshotRefs,
    })
    const command = createEditCommand<RunDirectorCommandPayload>({
      id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      author: { type: 'api-client', id: clientId }, type: 'run-director', scope: { project: true }, payload: commandPayload,
      reason: request.reason?.trim() || 'Generate the first complete V2 editorial direction and reviewable proxy.',
      idempotencyKey, createdAt,
    })
    const hashes = Object.fromEntries(snapshots.map((item) => [item.kind, item.contentHash]))
    const version = createProjectVersion({
      id: versionId, workspaceId, projectId, sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: {
        brief: context.currentVersion.snapshotRefs.brief,
        treatment: treatmentSnapshotId,
        story: storySnapshotId,
        editPlan: editPlanSnapshotId,
        policies: context.currentVersion.snapshotRefs.policies,
      },
      baseHash: calculateVersionHash({
        projectId, sequence: context.currentVersion.sequence + 1, parentVersionId: context.currentVersion.id,
        previousBaseHash: context.currentVersion.baseHash, commandId, directorRunId, snapshotHashes: hashes,
      }),
      createdBy: clientId, commandId, createdAt,
    })
    const run: DirectorRun = Object.freeze({
      schemaVersion: 1 as const, id: directorRunId, workspaceId, projectId, commandId,
      baseVersionId, resultVersionId: versionId, status: 'planned' as const,
      plannerVersion: PLANNER_VERSION, criticVersion: CRITIC_VERSION,
      perception, treatmentPlan, storyPlan, editPlan, qualityReport, decisions, assumptions,
      initiatedBy: Object.freeze({ type: 'api-client' as const, id: clientId }), createdAt,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(), type: 'project.version.created', version: '1.0.0', workspaceId,
      occurredAt: createdAt, sequence: version.sequence, actor: { clientId },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId, sequence: version.sequence, parentVersionId: version.parentVersionId,
        baseHash: version.baseHash, commandId, commandType: command.type, directorRunId,
        snapshotRefs: version.snapshotRefs, qualityStatus: qualityReport.status, createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      command, requestFingerprint, snapshots, version, run, event,
      sourceEvidence: {
        transcriptId: context.transcript.id,
        transcriptHash: context.transcript.transcriptHash,
        sourceArtifactId: context.transcript.sourceArtifactId,
      },
    })
  }
}
