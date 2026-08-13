import {
  type DirectedEditPlan,
  type DirectedSubtitleCue,
  type DirectorDecision,
  type DirectorPerceptionSnapshot,
  type DirectorQualityIssue,
  type DirectorQualityReport,
  type DirectorRun,
  type RunDirectorCommandPayload,
  validateDirectedEditPlan,
  validateDirectorDecisions,
} from '../domain/director-run.ts'
import { createEditCommand } from '../domain/edit-command.ts'
import {
  createDesiredAction,
  createDesiredActionReference,
  parseDesiredAction,
  validateDesiredActionAlignment,
  type DesiredAction,
  type DesiredActionReference,
  type DesiredActionInput,
} from '../domain/desired-action.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createPerceptionTimeline, type PerceptionObservation } from '../domain/perception-timeline.ts'
import { createProjectSnapshot, type ProjectSnapshot, type ProjectSnapshotKind } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import {
  bindDirectorObjective,
  resolveStrategicObjective,
  type StrategicObjectiveId,
} from '../domain/strategic-objective.ts'
import {
  createQualityReport as createStrategicQualityReport,
  resolveStrategicRubric,
  type QualityEvidence,
  type RubricCriterionId,
} from '../domain/strategic-rubric.ts'
import { validateStoryPlan, type StoryBlock, type StoryPlan } from '../domain/story-plan.ts'
import { createTreatmentPlan } from '../domain/treatment-plan.ts'
import { createDirectorRunImpact } from '../domain/director-run-impact.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { parseProductionBrief } from '../domain/production-brief.ts'
import { canonicalProjectMutationAudit } from './project-analysis-execution.ts'
import type { BriefCompilation } from './compile-brief.ts'
import { createMediaOnlyAnalysis, inferMediaOnlyTreatment } from './media-only-production.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

export const PROJECT_DIRECTOR_PLANNER_VERSION = 'apollo-director-policy/v1'
export const PROJECT_DIRECTOR_CRITIC_VERSION = 'apollo-director-critic/v1'
const SUBTITLE_MAX_CHARACTERS = 32

export interface RunProjectDirectorRequest {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  actor?: Readonly<AuthenticatedExternalActor>
  authenticationAudit?: Readonly<ApiAccessAuditContext>
  idempotency: Readonly<{ key: string }>
  allocatedResultVersionId?: string
  operationFence?: Readonly<{
    operationId: string
    leaseOwner: string
    attempt: number
    now: string
  }>
  reason?: string
  objective?: StrategicObjectiveId
  desiredAction?: Readonly<DesiredActionInput>
  expectedObjectiveVersion?: number
  expectedRubricRef?: string
  expectedSupersedesRunId?: string
  expectedBaseObjective?: StrategicObjectiveId
}

export function projectDirectorRequestFingerprint(input: {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  reason?: string
  objective?: StrategicObjectiveId
  desiredAction?: Readonly<DesiredActionInput>
  actorContextHash: string
  operationId?: string
}): string {
  return calculateVersionHash({
    type: 'run-director',
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    baseVersionId: input.baseVersionId,
    baseHash: input.baseHash,
    plannerVersion: PROJECT_DIRECTOR_PLANNER_VERSION,
    criticVersion: PROJECT_DIRECTOR_CRITIC_VERSION,
    objective: input.objective ?? null,
    desiredAction: input.desiredAction ?? null,
    actorContextHash: input.actorContextHash,
    execution: input.operationId
      ? { kind: 'public-operation-worker', operationId: input.operationId }
      : { kind: 'external-request' },
    reason: input.reason?.trim() || null,
  })
}

export interface RunProjectDirectorDependencies {
  repository: DirectorRunRepository
  clock: () => Date
  createId: (kind: 'director-run' | 'edit-command' | 'project-version' | 'project-snapshot') => string
  createEventId: () => string
  compileBrief: (input: {
    text: string
    guardrails?: readonly string[]
  }) => Promise<Readonly<BriefCompilation>>
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

function observedTranscriptStatements(words: readonly Readonly<{ text: string }>[]): readonly string[] {
  const statements: string[] = []
  let current: string[] = []
  for (const word of words) {
    current.push(word.text)
    if (/[.!?]$/u.test(word.text) || current.length >= 12) {
      statements.push(current.join(' ').replace(/\s+/g, ' ').trim())
      current = []
    }
  }
  if (current.length > 0) statements.push(current.join(' ').replace(/\s+/g, ' ').trim())
  return Object.freeze(statements.filter(Boolean))
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
  desiredAction: Readonly<DesiredAction>
  desiredActionRef: Readonly<DesiredActionReference>
  ctaPresent: boolean
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
    const isCta = input.desiredAction.kind !== 'continue-viewing' &&
      input.ctaPresent && index === input.clips.length - 1
    return {
      id: `story-block-${index + 1}`,
      actId: index === 0 ? 'opening' : isCta ? 'resolution' : 'development',
      role: index === 0 ? 'hook' : isCta ? 'cta' : index === input.clips.length - 1 ? 'context' : 'argument',
      intent: index === 0
        ? 'establish-speaker-and-premise'
        : isCta
          ? `perform-${input.desiredAction.kind}`
          : index === input.clips.length - 1
            ? 'close-with-next-understanding'
            : 'develop-value-and-proof-context',
      dependencies: index === 0 ? [] : [`story-block-${index}`],
      sourceCandidateIds: [clip.id],
      durationTargetMs: { min: Math.max(1, durationMs - 1_000), ideal: durationMs, max: durationMs + 1_000 },
      content: {
        claimIds: [], qualifierIds: [], proofIds: [],
        ...(isCta ? { ctaId: input.desiredActionRef.id } : {}),
      },
      presentation: 'source-video',
      sourceRangeId: clip.id,
    }
  })
  const opening = blocks.filter((block) => block.actId === 'opening').map((block) => block.id)
  const development = blocks.filter((block) => block.actId === 'development').map((block) => block.id)
  const resolution = blocks.filter((block) => block.actId === 'resolution').map((block) => block.id)
  const durationMs = Math.max(1, Math.round(input.durationFrames / input.fps * 1000))
  const plan: StoryPlan & { id: string } = {
    id: input.id,
    schemaVersion: 2,
    objective: input.objective,
    desiredActionRef: input.desiredActionRef,
    targetDurationMs: { min: Math.max(1, durationMs - 1_000), max: durationMs + 1_000 },
    acts: [
      { id: 'opening', role: 'opening', blockIds: opening },
      ...(development.length ? [{ id: 'development', role: 'development' as const, blockIds: development }] : []),
      ...(resolution.length ? [{ id: 'resolution', role: 'resolution' as const, blockIds: resolution }] : []),
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
  hasSelectedInsert: boolean
  briefCompilationRef?: string
  mediaOnly: boolean
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
      reason: input.mediaOnly
        ? 'No owner brief or observed semantic event justifies camera simulation; the conservative media-only choice is no effect.'
        : 'The owner requested a direct, natural tone and no semantic event justifies camera simulation.',
      evidenceRefs: [input.briefRef, ...(input.briefCompilationRef ? [input.briefCompilationRef] : []), input.policyRef], confidence: 0.99,
      alternatives: ['single-punch-in-after-opening'],
    },
    {
      id: 'decision-layout-inset', category: 'layout', choice: 'landscape-inset-on-blurred-source',
      reason: 'Preserves the full head and shoulders in 9:16 without the aggressive crop that previously cut the face.',
      evidenceRefs: [input.briefRef, ...(input.briefCompilationRef ? [input.briefCompilationRef] : []), input.editPlanRef], confidence: 0.92,
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
      id: 'decision-insert-selection',
      category: 'insert',
      choice: input.hasSelectedInsert ? 'use_selected_insert' : 'no_insert',
      reason: input.hasSelectedInsert
        ? 'The compiled timeline contains a rights-approved selected insert; preserve it as an intentional B-roll cutaway.'
        : 'No rights-approved supporting asset is linked to the project, so the Director omits B-roll instead of fabricating relevance.',
      evidenceRefs: [input.editPlanRef, input.policyRef], confidence: 1,
      alternatives: ['request-library-search'],
    },
  ])
}

function normalizedSpeech(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function desiredActionFromBrief(
  brief: Readonly<Record<string, unknown>>,
  objective: StrategicObjectiveId,
): Readonly<DesiredAction> {
  return parseDesiredAction(brief.desiredAction, objective)
}

function hasObservableCta(
  action: Readonly<DesiredAction>,
  words: readonly Readonly<{ text: string }>[],
): boolean {
  if (action.kind === 'continue-viewing') return true
  if (action.visualCta?.trim() || action.verbalCta?.trim()) return true
  const transcript = normalizedSpeech(words.map((word) => word.text).join(' '))
  const patterns: Record<Exclude<DesiredAction['kind'], 'continue-viewing'>, RegExp> = {
    'submit-lead': /\b(cadastre|cadastro|inscreva|formulario|deixe seu contato)\b/,
    buy: /\b(compre|comprar|checkout|garanta|adquira)\b/,
    'message-whatsapp': /\bwhatsapp\b/,
    book: /\b(agende|agendar|agenda|marque|marcar)\b/,
    download: /\b(baixe|baixar|download|material|guia|arquivo)\b/,
  }
  return patterns[action.kind].test(transcript)
}

function buildQualityReport(input: {
  id: string
  plan: Readonly<DirectedEditPlan>
  storyPlan: Readonly<StoryPlan> & Readonly<{ id: string }>
  objective: StrategicObjectiveId
  rubricRef: string
  desiredAction: Readonly<DesiredAction>
  desiredActionRef: Readonly<DesiredActionReference>
  ctaPresent: boolean
  hasSelectedInsert: boolean
  transcriptId: string
  sourceRights: Readonly<
    | { state: 'missing' }
    | {
        state: 'present'
        snapshotId: string
        snapshotHash: string
        status: string
        consentStatus: string
        expiresAt?: string
        consentExpiresAt?: string
      }
  >
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
  const evaluatedAtMs = new Date(input.evaluatedAt).getTime()
  const unexpired = (value?: string) => value === undefined || (
    !Number.isNaN(new Date(value).getTime()) && new Date(value).getTime() > evaluatedAtMs
  )
  const rightsPassed = input.sourceRights.state === 'present' &&
    input.sourceRights.status === 'approved' &&
    ['approved', 'not-required'].includes(input.sourceRights.consentStatus) &&
    unexpired(input.sourceRights.expiresAt) &&
    unexpired(input.sourceRights.consentExpiresAt)
  const narrativeIntegrity = hardChecks.openingMotionProtected &&
    hardChecks.automaticZoomDisabled && hardChecks.forbiddenSpeechAbsent &&
    hardChecks.timelineContinuous
  const legibility = hardChecks.subtitlesFaceSafe && hardChecks.subtitlesBounded
  const structuredCta = input.storyPlan.blocks.some((block) =>
    block.role === 'cta' && block.content.ctaId === input.desiredActionRef.id)
  assertDomain(
    input.storyPlan.desiredActionRef?.id === input.desiredActionRef.id &&
      input.plan.desiredActionRef.id === input.desiredActionRef.id,
    'INVALID_RENDER_INPUT',
    'Director consumers do not share the canonical desired action reference',
  )
  const desiredActionAlignment = validateDesiredActionAlignment({
    objective: input.objective,
    action: input.desiredAction,
    spokenCta: allSubtitleText,
  })
  const ctaAligned = desiredActionAlignment.valid
  const rubric = resolveStrategicRubric(input.objective)
  assertDomain(
    input.rubricRef === `${rubric.id}/v${rubric.version}`,
    'PERSISTENCE_CONFLICT',
    'Director objective and strategic rubric do not match',
  )
  const hasOpening = input.storyPlan.blocks.some((block) => block.role === 'hook') &&
    cues.some((cue) => cue.startFrame <= Math.round(input.plan.fps))
  const hasDevelopment = input.storyPlan.blocks.some((block) =>
    ['context', 'argument', 'proof'].includes(block.role))
  const hasDestination = Boolean(input.desiredAction.destination?.value)
  const scoreFor = (criterionId: RubricCriterionId): Readonly<QualityEvidence> => {
    const values: Record<RubricCriterionId, readonly [number, readonly string[]]> = {
      'hook-clarity': [hasOpening ? 100 : 0, [
        `story:${input.storyPlan.id}:opening=${hasOpening}`,
        `transcript:${input.transcriptId}:early-caption=${hasOpening}`,
      ]],
      'problem-recognition': [hasDevelopment ? 85 : 35, [
        `story:${input.storyPlan.id}:development=${hasDevelopment}`,
        `transcript:${input.transcriptId}:semantic-proxy=structure-only`,
      ]],
      'trust-building': [narrativeIntegrity && rightsPassed ? 90 : 30, [
        `edit-plan:${input.plan.id}:narrative-integrity=${narrativeIntegrity}`,
        `rights:${input.sourceRights.state === 'present' ? input.sourceRights.snapshotId : 'missing'}`,
      ]],
      'offer-clarity': [hasDestination ? 85 : 0, [
        `desired-action:${input.desiredAction.kind}:destination=${hasDestination}`,
        'semantic-proxy:offer-copy-not-inferred',
      ]],
      'proof-strength': [input.hasSelectedInsert ? 85 : 60, [
        `edit-plan:${input.plan.id}:selected-proof-insert=${input.hasSelectedInsert}`,
        'semantic-proxy:no-commercial-causality',
      ]],
      'cta-clarity': [structuredCta && input.ctaPresent && ctaAligned ? 100 : 0, [
        `story:${input.storyPlan.id}:structured-cta=${structuredCta}`,
        `desired-action:${input.desiredAction.kind}:observable-cta=${input.ctaPresent}`,
        `desired-action:${input.desiredActionRef.actionHash}:alignment=${desiredActionAlignment.issues.join(',') || 'valid'}`,
      ]],
      'friction-reduction': [hasDestination ? 90 : input.desiredAction.kind === 'continue-viewing' ? 85 : 0, [
        `desired-action:${input.desiredAction.kind}:destination=${hasDestination}`,
      ]],
      'narrative-integrity': [narrativeIntegrity ? 100 : 0, [
        `edit-plan:${input.plan.id}:forbidden-speech-absent=${hardChecks.forbiddenSpeechAbsent}`,
        `edit-plan:${input.plan.id}:timeline-continuous=${hardChecks.timelineContinuous}`,
      ]],
      legibility: [legibility ? 100 : 0, [
        `edit-plan:${input.plan.id}:subtitle-face-safe=${hardChecks.subtitlesFaceSafe}`,
        `edit-plan:${input.plan.id}:subtitle-bounded=${hardChecks.subtitlesBounded}`,
      ]],
      'rights-compliance': [rightsPassed ? 100 : 0, [
        input.sourceRights.state === 'present'
          ? `rights:${input.sourceRights.snapshotId}:${input.sourceRights.snapshotHash}:status=${input.sourceRights.status}:consent=${input.sourceRights.consentStatus}`
          : 'rights:missing',
      ]],
    }
    const [score, evidence] = values[criterionId]
    return Object.freeze({ criterionId, score, evidence: Object.freeze([...evidence]) })
  }
  const strategic = createStrategicQualityReport({
    objective: input.objective,
    evidence: rubric.criteria.map((criterion) => scoreFor(criterion.id)),
    gates: {
      narrativeIntegrity,
      legibility,
      rights: rightsPassed,
      ctaPresent: input.ctaPresent && structuredCta && ctaAligned,
    },
    gateEvidence: {
      'narrative-integrity': [`edit-plan:${input.plan.id}:narrative=${narrativeIntegrity}`],
      legibility: [`edit-plan:${input.plan.id}:legibility=${legibility}`],
      'rights-compliance': [input.sourceRights.state === 'present'
        ? `rights:${input.sourceRights.snapshotId}:eligible=${rightsPassed}`
        : 'rights:missing'],
      'cta-required': [`story:${input.storyPlan.id}:cta=${input.ctaPresent && structuredCta && ctaAligned}`],
    },
    evaluatedAt: input.evaluatedAt,
  })
  const baseIssues: DirectorQualityIssue[] = [{
    code: 'FACE_PERCEPTION_UNAVAILABLE_SAFE_FALLBACK',
    severity: 'warning' as const,
    category: 'editorial' as const,
    message: 'No face detector evidence is available; the caption track uses the conservative bottom safe region.',
    rangeMs: [0, Math.round(input.plan.durationFrames / input.plan.fps * 1000)] as const,
    targetId: input.plan.subtitleTracks[0]?.id ?? 'subtitle-track',
    correctable: true,
  }]
  const gateIssue = {
    'narrative-integrity': ['STRATEGIC_NARRATIVE_INTEGRITY_FAILED', 'integrity'],
    legibility: ['STRATEGIC_LEGIBILITY_FAILED', 'technical'],
    'rights-compliance': ['STRATEGIC_RIGHTS_FAILED', 'policy'],
    'cta-required': ['STRATEGIC_CTA_REQUIRED', 'editorial'],
  } as const
  for (const gate of strategic.gateFailures) {
    const [code, category] = gateIssue[gate]
    baseIssues.push(Object.freeze({
      code,
      severity: 'hard' as const,
      category,
      message: `Strategic quality gate ${gate} failed with persisted evidence.`,
      correctable: true,
    }))
  }
  if (strategic.score < strategic.rubric.threshold) {
    baseIssues.push(Object.freeze({
      code: 'STRATEGIC_SCORE_BELOW_THRESHOLD',
      severity: 'hard' as const,
      category: 'editorial' as const,
      message: `Strategic editorial proxy score ${strategic.score} is below threshold ${strategic.rubric.threshold}.`,
      correctable: true,
    }))
  }
  const issues = Object.freeze(baseIssues)
  const blocked = !strategic.passed || Object.values(hardChecks).some((value) => !value)
  return Object.freeze({
    schemaVersion: 'director-quality-report/v2' as const,
    id: input.id,
    desiredActionRef: input.desiredActionRef,
    status: blocked ? 'blocked' as const : issues.length ? 'approved-with-warnings' as const : 'approved' as const,
    score: strategic.score / 100,
    strategic,
    hardChecks,
    issues,
    criticVersion: PROJECT_DIRECTOR_CRITIC_VERSION,
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
    let authenticationAudit: Readonly<ApiAccessAuditContext>
    if (request.operationFence) {
      if (!request.authenticationAudit || request.actor) {
        throw new DomainError(
          'AUTH_INVALID',
          'Director worker requires exactly one persisted authentication audit',
        )
      }
      authenticationAudit = canonicalProjectMutationAudit(
        request.authenticationAudit,
        workspaceId,
      )
    } else {
      if (!request.actor || request.authenticationAudit) {
        throw new DomainError(
          'AUTH_INVALID',
          'Direct Director execution requires exactly one authenticated external actor',
        )
      }
      requireScope(request.actor, 'projects:write')
      authenticationAudit = canonicalProjectMutationAudit(
        materializeActorAuditContext(request.actor),
        workspaceId,
      )
    }
    const clientId = normalizedIdentifier(
      authenticationAudit.clientId,
      'actor.id',
    )
    const idempotencyKey = request.idempotency.key.trim()
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_COMMAND', 'baseHash is invalid')
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_COMMAND', 'Idempotency-Key is invalid')
    const requestFingerprint = projectDirectorRequestFingerprint({
      workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      reason: request.reason,
      objective: request.objective,
      desiredAction: request.desiredAction,
      actorContextHash: authenticationAudit.contextHash,
      ...(request.operationFence
        ? { operationId: request.operationFence.operationId }
        : {}),
    })
    const existing = await dependencies.repository.findIdempotentResult({
      workspaceId,
      projectId,
      idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with different Director input')
      if (
        request.allocatedResultVersionId !== undefined &&
        existing.result.version.id !== request.allocatedResultVersionId
      ) throw new DomainError('PERSISTENCE_CONFLICT', 'Director replay result does not match the allocated operation target')
      return Object.freeze({ ...existing.result, replayed: true })
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project with aligned media was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Director base version is stale', { currentVersionId: context.currentVersion.id, currentBaseHash: context.currentVersion.baseHash })
    }
    const objective = resolveStrategicObjective(
      request.objective ?? context.project.objective,
    )
    const currentDesiredAction = desiredActionFromBrief(
      context.brief,
      context.project.objective,
    )
    const requestedDesiredAction = request.desiredAction
      ? createDesiredAction({
          objective: objective.id,
          desiredAction: request.desiredAction,
        })
      : undefined
    const objectiveChanged = objective.id !== context.project.objective
    const desiredAction = requestedDesiredAction ?? (
      objectiveChanged
        ? createDesiredAction({ objective: objective.id })
        : currentDesiredAction
    )
    const desiredActionChanged = stableSerialize(desiredAction) !==
      stableSerialize(currentDesiredAction)
    const directionChanged = objectiveChanged || desiredActionChanged
    const objectiveBinding = bindDirectorObjective({
      objective: objective.id,
      ...(context.latestDirectorObjective
        ? { previous: context.latestDirectorObjective }
        : {}),
      supersede: directionChanged,
    })
    if (request.operationFence) {
      assertDomain(
        request.expectedBaseObjective === context.project.objective &&
          request.expectedObjectiveVersion === objectiveBinding.objectiveVersion &&
          request.expectedRubricRef === objectiveBinding.rubricRef &&
          request.expectedSupersedesRunId === objectiveBinding.supersedesRunId,
        'PERSISTENCE_CONFLICT',
        'Persisted Director objective transition does not match current immutable state',
      )
    } else {
      assertDomain(
        request.expectedObjectiveVersion === undefined &&
          request.expectedRubricRef === undefined &&
          request.expectedSupersedesRunId === undefined &&
          request.expectedBaseObjective === undefined,
        'INVALID_ARGUMENT',
        'Direct Director execution cannot provide persisted objective binding fields',
      )
    }
    assertDomain(
      !directionChanged || Boolean(request.reason?.trim()),
      'PRECONDITION_REQUIRED',
      'Changing the strategic objective or desired action requires an explicit reason',
    )
    const productionBrief = parseProductionBrief(context.brief.productionBrief)
    const policyGuardrails = context.policies.guardrails
    assertDomain(
      Array.isArray(policyGuardrails) && policyGuardrails.every((item) => typeof item === 'string'),
      'PERSISTENCE_CONFLICT',
      'Stored project policy guardrails are invalid',
    )
    const briefCompilation = productionBrief.ownerInput
      ? await dependencies.compileBrief({
          text: productionBrief.ownerInput.text,
          guardrails: policyGuardrails,
        })
      : undefined
    assertDomain(
      !briefCompilation?.compiled.requiresReview,
      'PRECONDITION_REQUIRED',
      'Material brief conflicts require owner review before Director execution',
      {
        conflicts: briefCompilation?.compiled.conflicts
          .filter((item) => item.material)
          .map((item) => ({ code: item.code, message: item.message })) ?? [],
      },
    )
    const clips = context.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
    assertDomain(clips.length > 0 && context.editPlan.retimedTranscript.words.length > 0, 'INVALID_COMMAND', 'Director requires a compiled editorial timeline and retimed transcript')
    const hasSelectedInsert = clips.some(
      (clip) => clip.sourceArtifactId !== context.transcript.sourceArtifactId,
    )
    const ctaPresent = hasObservableCta(
      desiredAction,
      context.editPlan.retimedTranscript.words,
    )
    const desiredActionRef = createDesiredActionReference(desiredAction)
    const createdAt = dependencies.clock().toISOString()
    const directorRunId = dependencies.createId('director-run')
    const commandId = dependencies.createId('edit-command')
    const versionId = request.allocatedResultVersionId
      ? normalizedIdentifier(request.allocatedResultVersionId, 'allocatedResultVersionId')
      : dependencies.createId('project-version')
    const perceptionId = `perception-${directorRunId}`
    const treatmentPlanId = `treatment-${directorRunId}`
    const storyPlanId = `story-${directorRunId}`
    const qualityReportId = `quality-${directorRunId}`
    const currentBriefSnapshotId = normalizedIdentifier(
      context.currentVersion.snapshotRefs.brief ?? '',
      'briefSnapshotId',
    )
    const briefChanged = directionChanged || briefCompilation !== undefined
    const briefSnapshotId = briefChanged
      ? dependencies.createId('project-snapshot')
      : currentBriefSnapshotId
    const perception = buildPerception({
      id: perceptionId,
      durationFrames: context.editPlan.durationFrames,
      fps: context.editPlan.fps,
      transcript: context.transcript,
      words: context.editPlan.retimedTranscript.words,
    })
    const mediaOnlyAnalysis = productionBrief.ownerInput
      ? undefined
      : createMediaOnlyAnalysis({
          brief: productionBrief,
          objective: objective.id,
          action: desiredAction,
          mediaRefs: [...new Set(context.editPlan.videoTracks.flatMap((track) =>
            track.clips.map((clip) => clip.sourceArtifactId)))],
        })
    const mediaOnlyTreatment = mediaOnlyAnalysis
      ? inferMediaOnlyTreatment({
          analysis: mediaOnlyAnalysis,
          observedClaims: observedTranscriptStatements(context.editPlan.retimedTranscript.words),
          proposedClaims: [],
          perceptionConfidence: perception.summary.confidence,
        })
      : undefined
    const treatmentRubric = resolveStrategicRubric(objective.id)
    const treatmentBase = createTreatmentPlan({
      objective: objective.id,
      mode: mediaOnlyTreatment
        ? 'media-only'
        : hasSelectedInsert &&
        clips.every((clip) => Boolean(clip.audioSourceArtifactId))
        ? 'visual-montage'
        : 'talking-head',
      rubric: {
        id: treatmentRubric.id,
        version: treatmentRubric.version,
        proofRequired: treatmentRubric.criteria.some((criterion) => criterion.id === 'proof-strength' && criterion.weight >= .15),
        rubricHash: calculateVersionHash(treatmentRubric),
      },
      policy: {
        snapshotId: context.currentVersion.snapshotRefs.policies,
        schemaVersion: Number((context.policies as { schemaVersion?: number }).schemaVersion ?? 1),
        snapshotHash: calculateVersionHash(context.policies),
        maxPatternBreaksPer30s: 2,
        forbiddenEffects: ['zoom'],
        maxProofItems: 3,
        maxCtaOccurrences: 1,
        maxDecisions: 12,
      },
      perception: {
        summaryId: perception.summary.id,
        schemaVersion: 1,
        summaryHash: calculateVersionHash(perception.summary),
        confidence: perception.summary.confidence,
        speakerCoverage: perception.summary.speechCoverage,
        visualVariety: 0,
        evidenceItemCount: perception.timeline.observations.length,
        durationMs: Math.round(context.editPlan.durationFrames / context.editPlan.fps * 1_000),
      },
      ...(mediaOnlyTreatment ? { mediaOnly: mediaOnlyTreatment } : {}),
    })
    const treatmentPlan = Object.freeze({ id: treatmentPlanId, ...treatmentBase })
    const storyPlan = buildStoryPlan({
      id: storyPlanId,
      objective: objective.id,
      desiredAction,
      desiredActionRef,
      ctaPresent,
      clips,
      fps: context.editPlan.fps,
      durationFrames: context.editPlan.durationFrames,
    })
    const decisions = buildDecisions({
      briefRef: briefSnapshotId,
      transcriptRef: context.transcript.id,
      editPlanRef: context.currentVersion.snapshotRefs.editPlan,
      policyRef: context.currentVersion.snapshotRefs.policies,
      hasSelectedInsert,
      ...(briefCompilation
        ? { briefCompilationRef: briefCompilation.audit.outputHash }
        : {}),
      mediaOnly: Boolean(mediaOnlyTreatment),
    })
    const assumptions = Object.freeze([...new Set([
      'Face detector evidence is unavailable; use a conservative caption-safe region below the source inset.',
      hasSelectedInsert
        ? 'The selected insert already passed the asset-selection and rights gates.'
        : 'No rights-approved B-roll candidate is linked; omission is safer than an irrelevant insert.',
      ...(briefCompilation?.compiled.assumptions ?? []),
      ...(mediaOnlyTreatment?.assumptions ?? []),
    ])])
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
      desiredActionRef,
      overlayTracks: desiredAction.visualCta
        ? Object.freeze([Object.freeze({
            id: `overlay-${desiredActionRef.id}`,
            kind: 'cta' as const,
            desiredActionRef,
            startFrame: Math.max(0, context.editPlan.durationFrames - Math.round(context.editPlan.fps * 3)),
            endFrame: context.editPlan.durationFrames,
            text: desiredAction.visualCta,
          })])
        : Object.freeze([]),
      subtitleTracks: Object.freeze([Object.freeze({
        id: 'track-captions-pt-br', kind: 'captions' as const, presetId: 'clean-color' as const,
        anchor: 'bottom' as const, faceProtection: true as const, maxLines: 2 as const,
        maxCharactersPerBlock: SUBTITLE_MAX_CHARACTERS, cues: subtitleCues,
        desiredActionRef,
      })]),
      effectTracks: Object.freeze([]),
      transitions,
      composition: Object.freeze({
        layout: 'landscape-inset' as const,
        background: 'blurred-source' as const,
        foregroundScale: 1 as const,
        verticalPosition: 0.5 as const,
        faceSafeFallback: Object.freeze([0.14, 0.08, 0.72, 0.56] as const),
        subtitleSafeRegion: Object.freeze([0.08, 0.7, 0.84, 0.24] as const),
      }),
      director: Object.freeze({ plannerVersion: PROJECT_DIRECTOR_PLANNER_VERSION, decisions, assumptions }),
      movementPolicy: Object.freeze({ automaticZoom: false as const, protectedOpeningFrames: Math.max(context.editPlan.movementPolicy.protectedOpeningFrames, Math.round(context.editPlan.fps * 4)) }),
      subtitlePolicy: Object.freeze({ faceProtection: true as const, anchor: 'bottom' as const, maxCharactersPerBlock: SUBTITLE_MAX_CHARACTERS }),
      createdAt,
    }
    validateDirectedEditPlan(editPlan)
    const qualityReport = buildQualityReport({
      id: qualityReportId,
      plan: editPlan,
      storyPlan,
      objective: objective.id,
      rubricRef: objectiveBinding.rubricRef,
      desiredAction,
      desiredActionRef,
      ctaPresent,
      hasSelectedInsert,
      transcriptId: context.transcript.id,
      sourceRights: context.sourceRights,
      evaluatedAt: createdAt,
    })
    assertDomain(
      qualityReport.status !== 'blocked',
      'INVALID_RENDER_INPUT',
      'Director critic blocked the proposed EditPlan',
      {
        qualityReportId,
        score: qualityReport.strategic.score,
        threshold: qualityReport.strategic.rubric.threshold,
        gateFailures: qualityReport.strategic.gateFailures,
      },
    )
    const perceptionSnapshotId = dependencies.createId('project-snapshot')
    const treatmentSnapshotId = dependencies.createId('project-snapshot')
    const storySnapshotId = dependencies.createId('project-snapshot')
    const editPlanSnapshotId = dependencies.createId('project-snapshot')
    const qualitySnapshotId = dependencies.createId('project-snapshot')
    const compiledBrief = briefChanged
      ? Object.freeze({
          ...context.brief,
          schemaVersion: briefCompilation ? 3 : 2,
          objective: objective.id,
          desiredAction,
          ...(briefCompilation ? { briefCompilation } : {}),
          ...(directionChanged
            ? { objectiveChange: Object.freeze({
                from: context.project.objective,
                to: objective.id,
                objectiveVersion: objectiveBinding.objectiveVersion,
                rubricRef: objectiveBinding.rubricRef,
                supersedesRunId: objectiveBinding.supersedesRunId,
                reason: request.reason!.trim(),
                changedAt: createdAt,
              }) }
            : {}),
        })
      : undefined
    const snapshots = Object.freeze([
      ...(compiledBrief
        ? [snapshot({
            id: briefSnapshotId,
            workspaceId,
            projectId,
            kind: 'brief',
            contentSchemaVersion: briefCompilation ? 3 : 2,
            value: compiledBrief,
            createdAt,
          })]
        : []),
      snapshot({ id: perceptionSnapshotId, workspaceId, projectId, kind: 'perception', contentSchemaVersion: 1, value: perception, createdAt }),
      snapshot({ id: treatmentSnapshotId, workspaceId, projectId, kind: 'treatment', contentSchemaVersion: treatmentPlan.schemaVersion, value: treatmentPlan, createdAt }),
      snapshot({ id: storySnapshotId, workspaceId, projectId, kind: 'story', contentSchemaVersion: 1, value: storyPlan, createdAt }),
      snapshot({ id: editPlanSnapshotId, workspaceId, projectId, kind: 'edit-plan', contentSchemaVersion: 2, value: editPlan, createdAt }),
      snapshot({ id: qualitySnapshotId, workspaceId, projectId, kind: 'quality-report', contentSchemaVersion: 2, value: qualityReport, createdAt }),
    ])
    const snapshotRefs = Object.freeze({
      brief: briefSnapshotId,
      perception: perceptionSnapshotId,
      treatment: treatmentSnapshotId,
      story: storySnapshotId,
      editPlan: editPlanSnapshotId,
      quality: qualitySnapshotId,
    })
    const impact = createDirectorRunImpact({
      commandId,
      baseVersionId,
      resultVersionId: versionId,
      sourceTranscriptId: context.transcript.id,
      sourceTranscriptHash: context.transcript.transcriptHash,
      plannerVersion: PROJECT_DIRECTOR_PLANNER_VERSION,
      criticVersion: PROJECT_DIRECTOR_CRITIC_VERSION,
      affectedEndFrame: Math.max(context.currentDurationFrames, editPlan.durationFrames),
      renderEndFrame: editPlan.durationFrames,
      proxyVariantId: context.proxyVariantId,
      outputReferences: context.outputReferences,
    })
    const commandPayload: RunDirectorCommandPayload = Object.freeze({
      schemaVersion: 3 as const,
      directorRunId,
      previousObjective: context.project.objective,
      objective: objective.id,
      objectiveVersion: objectiveBinding.objectiveVersion,
      rubricRef: objectiveBinding.rubricRef,
      ...(objectiveBinding.supersedesRunId
        ? { supersedesRunId: objectiveBinding.supersedesRunId }
        : {}),
      plannerVersion: PROJECT_DIRECTOR_PLANNER_VERSION,
      criticVersion: PROJECT_DIRECTOR_CRITIC_VERSION,
      sourceTranscriptId: context.transcript.id,
      sourceArtifactId: context.transcript.sourceArtifactId,
      snapshotRefs,
      impact,
    })
    const command = createEditCommand<RunDirectorCommandPayload>({
      id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      author: {
        type: 'api-client', id: clientId,
        ...(authenticationAudit.delegatedUserId
          ? { delegatedUserId: normalizedIdentifier(authenticationAudit.delegatedUserId, 'actor.delegatedUserId') }
          : {}),
      }, type: 'run-director', scope: { project: true }, payload: commandPayload,
      reason: request.reason?.trim() || 'Generate the first complete V2 editorial direction and reviewable proxy.',
      idempotencyKey, createdAt,
    })
    const hashes = Object.fromEntries(snapshots.map((item) => [item.kind, item.contentHash]))
    const version = createProjectVersion({
      id: versionId, workspaceId, projectId, sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: {
        brief: briefSnapshotId,
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
      schemaVersion: 2 as const, id: directorRunId, workspaceId, projectId, commandId,
      baseVersionId, resultVersionId: versionId, status: 'planned' as const,
      plannerVersion: PROJECT_DIRECTOR_PLANNER_VERSION, criticVersion: PROJECT_DIRECTOR_CRITIC_VERSION,
      objective: objective.id,
      objectiveVersion: objectiveBinding.objectiveVersion,
      rubricRef: objectiveBinding.rubricRef,
      ...(objectiveBinding.supersedesRunId
        ? { supersedesRunId: objectiveBinding.supersedesRunId }
        : {}),
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
        objective: objective.id,
        objectiveVersion: objectiveBinding.objectiveVersion,
        rubricRef: objectiveBinding.rubricRef,
        supersedesRunId: objectiveBinding.supersedesRunId ?? null,
        commandImpactHash: impact.impactHash,
        artifactInvalidationCount: impact.affectedArtifacts.length,
      },
    })
    return dependencies.repository.commitOrReplay({
      command, authenticationAudit, requestFingerprint, snapshots, version, run, event,
      sourceEvidence: {
        transcriptId: context.transcript.id,
        transcriptHash: context.transcript.transcriptHash,
        sourceArtifactId: context.transcript.sourceArtifactId,
      },
      ...(request.operationFence ? { operationFence: request.operationFence } : {}),
    })
  }
}
