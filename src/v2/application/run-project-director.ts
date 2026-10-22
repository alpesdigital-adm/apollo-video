import {
  type DirectedEditPlan,
  type DirectedSubtitleCue,
  type DirectorDecision,
  type DirectorDecisionInput,
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
import type { PerceptionKind, PerceptionRange } from '../domain/perception-timeline.ts'
import { frameRangesToCoverageMs } from '../domain/perception-frame-time.ts'
import {
  assembleServerPerceptionSnapshot, serverPerceptionSnapshotId,
  type PerceptionSnapshotClip, type ServerPerceptionAssemblyInput, type ServerPerceptionSnapshot,
} from '../domain/server-perception-snapshot.ts'
import {
  DECISION_BAND_POLICY_REF, assessDecisionEvidence, evaluateSourceRightsCertainty,
  type DecisionPerceptionEvidence, type SourceRightsVerdict,
} from '../domain/director-evidence-rubric.ts'
import {
  createDirectorPerceptionEvidenceReport, digestOfDecisionEvidence,
  type DirectorPerceptionEvidenceReport,
} from '../domain/director-perception-evidence.ts'
import { requestDirectorFaceWindows, type DirectorFaceWindowRequester } from './director-face-window-requests.ts'
import type { PerceptionProducerEnvelope } from '../domain/perception-producer-envelope.ts'
import { createProjectSnapshot, type ProjectSnapshot, type ProjectSnapshotKind } from '../domain/project-snapshot.ts'
import { offeredObservationsFor } from './adoptable-observations.ts'
import { transitionProjectOutputState } from '../domain/project-output-state-transition.ts'
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
import { createDirectorDecisionLog } from '../domain/director-decision.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import { createTreatmentPlan } from '../domain/treatment-plan.ts'
import { createDirectorRunImpact } from '../domain/director-run-impact.ts'
import type { DirectorRunContext, DirectorRunRepository } from './ports/director-run-repository.ts'
import { bindDirectorSnapshotIdentities } from './director-snapshot-identity.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { parseProductionBrief } from '../domain/production-brief.ts'
import { canonicalProjectMutationAudit } from './project-analysis-execution.ts'
import type { BriefCompilation } from './compile-brief.ts'
import { editorialRulesMatchingSpeech, type EditorialPhraseRule } from './editorial-phrase-rules.ts'
import { createMediaOnlyAnalysis, inferMediaOnlyTreatment } from './media-only-production.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

export const PROJECT_DIRECTOR_PLANNER_VERSION = 'apollo-director-policy/v2'
// v3: `forbiddenSpeechAbsent` is the project's own request (the phrases its `remove-spoken-content` Commands asked to cut), no longer a
// fixed list; a report born under v1/v2 is not admitted to final export (see `admitDirectorQualityForFinal`).
export const PROJECT_DIRECTOR_CRITIC_VERSION = 'apollo-director-critic/v3'
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
  createId: (kind: 'director-run' | 'edit-command' | 'project-version' | 'project-snapshot' | 'project-output-state' | 'output-materialization') => string
  createEventId: () => string
  compileBrief: (input: {
    text: string
    guardrails?: readonly string[]
  }) => Promise<Readonly<BriefCompilation>>
  /**
   * W64. How the Director asks for the face windows its plan needs (the face source window admission, as the run's own actor). Absent
   * where a Director has no way to ask (a controlled context): the windows it lacks are then reported as not requested, and nothing is
   * pending.
   */
  faceWindows?: DirectorFaceWindowRequester
  /**
   * W64. Writes the perception snapshot of the Version a run has just created (the run's own commit already wrote the snapshot of the
   * Version it directed). BEST EFFORT and outside the commit: a failure here never fails a run that is already sealed - the public
   * read answers `SNAPSHOT_NOT_MATERIALIZED` for that Version until something writes it.
   */
  materializeSnapshot?: (input: Readonly<{ workspaceId: string; projectId: string; projectVersionId: string }>) => Promise<unknown>
  /** Where the structured warning of a failed best-effort materialization goes (default: `console.warn` of one JSON line). */
  warn?: (event: Readonly<Record<string, unknown>>) => void
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

/**
 * The Director's perception IS the server perception snapshot of its input Version (W63a): one assembler fuses the sealed evidence
 * - the EditPlan's retimed transcript, the OCR samples, the adjacent-frame measurements and the source-keyed face windows - on the
 * EditPlan's clock, and says per kind what was examined. The Director adds nothing to it and decides nothing from the kinds it
 * did not have before: face safety stays `unknown`, and the snapshot is evidence input only.
 */
function buildPerception(input: {
  id: string
  inputVersionId: string
  assembly: Readonly<ServerPerceptionAssemblyInput>
  transcriptId: string
  ocrEnvelope?: Readonly<PerceptionProducerEnvelope>
}): Readonly<{ perception: Readonly<DirectorPerceptionSnapshot>; serverPerception: Readonly<ServerPerceptionSnapshot> }> {
  const serverPerception = assembleServerPerceptionSnapshot(input.assembly)
  const timeline = serverPerception.timeline
  const durationMs = timeline.durationMs
  // The Director has already bound its OCR envelope to this Version; the snapshot must have taken exactly that evidence.
  assertDomain(!input.ocrEnvelope || serverPerception.inputs.some((item) => item.kind === 'ocr' &&
    item.envelopeHash === input.ocrEnvelope!.envelopeHash),
  'PERSISTENCE_CONFLICT', 'The server perception snapshot did not take the Director OCR evidence')
  const stateOf = (kind: PerceptionKind) => timeline.coverage.find((entry) => entry.kind === kind)!.state
  const speechMs = mergeCoverage(timeline.observations
    .filter((item) => item.kind === 'transcript-word')
    .map((item) => [item.startMs, item.endMs] as const))
  const perception: Readonly<DirectorPerceptionSnapshot> = Object.freeze({
    schemaVersion: 2 as const,
    id: input.id,
    inputVersionId: input.inputVersionId,
    ...(input.ocrEnvelope ? { ocrEvidence: Object.freeze({
      envelopeId: input.ocrEnvelope.id,
      envelopeHash: input.ocrEnvelope.envelopeHash,
      sourceArtifactId: input.ocrEnvelope.sourceArtifactId,
      sourceSha256: input.ocrEnvelope.sourceSha256,
      timeMapHash: input.ocrEnvelope.timeMapHash,
      sampledTimelineFrames: Object.freeze(input.ocrEnvelope.samples.map((sample) => sample.timelineFrame)),
      emptyTextTimelineFrames: Object.freeze(input.ocrEnvelope.samples.filter((sample) =>
        sample.ocr.length === 0).map((sample) => sample.timelineFrame)),
    }) } : {}),
    serverSnapshot: Object.freeze({ schemaVersion: serverPerception.schemaVersion, snapshotHash: serverPerception.snapshotHash }),
    timeline,
    summary: Object.freeze({
      id: `${input.id}-summary`,
      speechCoverage: Number(Math.min(1, speechMs / durationMs).toFixed(4)),
      visualCoverage: (['ocr', 'shot', 'motion', 'face'] as const).some((kind) => stateOf(kind) !== 'absent')
        ? 'partial' as const : 'absent' as const,
      faceCoverage: stateOf('face'),
      confidence: 0.82,
      sourceTranscriptId: input.transcriptId,
    }),
  })
  return Object.freeze({ perception, serverPerception })
}

/** What the Director itself carries of its input Version, for a context that has no store to read the rest of the evidence from. */
function directorAssemblyInput(input: {
  workspaceId: string
  projectId: string
  baseVersionId: string
  context: Readonly<DirectorRunContext>
  ocrEnvelope?: Readonly<PerceptionProducerEnvelope>
}): Readonly<ServerPerceptionAssemblyInput> {
  const { context } = input
  return Object.freeze({
    workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.baseVersionId,
    editPlan: Object.freeze({
      snapshotId: context.currentVersion.snapshotRefs.editPlan, snapshotHash: null,
      fps: context.editPlan.fps, durationFrames: context.editPlan.durationFrames,
      clips: Object.freeze(context.editPlan.videoTracks.flatMap((track) => track.clips).map((clip) => Object.freeze({
        id: clip.id, sourceArtifactId: clip.sourceArtifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
        timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate }))),
    }),
    transcript: Object.freeze({
      transcript: Object.freeze({ id: context.transcript.id, provider: context.transcript.provider, model: context.transcript.model,
        transcriptHash: context.transcript.transcriptHash, sourceArtifactId: context.transcript.sourceArtifactId }),
      words: context.editPlan.retimedTranscript.words,
    }),
    ...(input.ocrEnvelope ? { ocr: Object.freeze([input.ocrEnvelope]) } : {}),
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

/**
 * Which word of the observed transcript a retimed word is: the one with the same text and the same source times. A word the
 * transcript has twice, or not at all, has no index (a cue made of it carries no authority rather than a guessed one).
 */
function transcriptWordIndexer(words: readonly Readonly<{ word: string; start: number; end: number }>[] | undefined):
  ((word: Readonly<{ text: string; sourceStartSeconds: number; sourceEndSeconds: number }>) => number | null) | null {
  if (words === undefined) return null
  const key = (text: string, start: number, end: number) => `${text}\u0000${start}\u0000${end}`
  const indices = new Map<string, number | null>()
  words.forEach((word, index) => {
    const k = key(word.word, word.start, word.end)
    indices.set(k, indices.has(k) ? null : index)
  })
  return (word) => indices.get(key(word.text, word.sourceStartSeconds, word.sourceEndSeconds)) ?? null
}

function buildSubtitleCues(input: {
  words: readonly Readonly<{
    text: string
    sourceStartSeconds: number
    sourceEndSeconds: number
    timelineStartFrame: number
    timelineEndFrame: number
  }>[]
  durationFrames: number
  fps: number
  /** When present, every cue names the transcript words it is made of; if any word cannot be named, no cue does. */
  indexOf?: ((word: Readonly<{ text: string; sourceStartSeconds: number; sourceEndSeconds: number }>) => number | null) | null
}): readonly Readonly<DirectedSubtitleCue>[] {
  const cues: DirectedSubtitleCue[] = []
  let group: typeof input.words = []
  let previousEndFrame = 0
  let named = input.indexOf !== null && input.indexOf !== undefined
  const flush = () => {
    if (group.length === 0) return
    const text = group.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim()
    const startFrame = Math.max(previousEndFrame, group[0]!.timelineStartFrame)
    const endFrame = Math.min(input.durationFrames, Math.max(startFrame + 1, group.at(-1)!.timelineEndFrame))
    if (text && startFrame < endFrame) {
      const indices = input.indexOf ? group.map((word) => input.indexOf!(word)) : []
      if (indices.some((index) => index === null)) named = false
      cues.push({ id: `subtitle-cue-${cues.length + 1}`, startFrame, endFrame, text, anchor: 'bottom',
        ...(named ? { sourceWordIndices: Object.freeze(indices as number[]) } : {}) })
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
  // All or nothing: a track whose cues are only partly named would be trusted for the cues that are and refused for the others.
  return Object.freeze(cues.map((cue) => {
    if (named) return Object.freeze(cue)
    const { sourceWordIndices: _dropped, ...unnamed } = cue
    return Object.freeze(unnamed)
  }))
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

/**
 * The planner's own confidence in the choice it makes, before any evidence is weighed. It is a prior, and the band is not graded on it
 * alone: crop, caption and insert are graded on (evidence tier, this prior) by `confidence-band-policy/v2`, so a decision whose
 * evidence is absent is never auto-applied however sure the planner is. The 0.82 of the caption is the transcript prior the snapshot
 * assembler gives words (policy-prior, not measured); it replaces the 0.5 that used to stand in for "the face detector has not looked".
 */
export const DIRECTOR_PLANNER_PRIORS = Object.freeze({ crop: 0.82, caption: 0.82, insert: 1 })

const tierLine = (evidence: Readonly<DecisionPerceptionEvidence>) => evidence.modalities.length === 0
  ? 'nothing to examine'
  : evidence.modalities.map((item) => `${item.modality} ${item.tier} (${item.reasonCode})`).join(', ')

/** The refs a decision stands on: what it already named, the snapshot, and the sealed envelopes its evidence was taken from. */
function evidenceRefsOf(existing: readonly string[], evidence: Readonly<DecisionPerceptionEvidence>): readonly string[] {
  return Object.freeze([...new Set([...existing, evidence.snapshot.id, ...evidence.modalities.flatMap((item) => item.envelopeIds)])].slice(0, 32))
}

function buildDecisions(input: {
  briefRef: string
  transcriptRef: string
  editPlanRef: string
  policyRef: string
  hasSelectedInsert: boolean
  briefCompilationRef?: string
  mediaOnly: boolean
  ocrEnvelopeRef?: string
  ocrLowerRiskCount: number
  evidence: Readonly<{
    crop: Readonly<DecisionPerceptionEvidence>
    caption: Readonly<DecisionPerceptionEvidence>
    insert: Readonly<DecisionPerceptionEvidence>
  }>
}): readonly Readonly<DirectorDecision>[] {
  const bandPolicy = DECISION_BAND_POLICY_REF
  const captionFace = input.evidence.caption.modalities.find((item) => item.modality === 'face')
  const faceSentence = captionFace === undefined ? 'Face observations are unavailable.'
    : captionFace.tier === 'absent' ? `Face observations are unavailable (${captionFace.reasonCode}).`
      : `Face evidence is a partial, unverified candidate (${captionFace.reasonCode}).`
  const decisions: readonly DirectorDecisionInput[] = [
    {
      id: 'decision-narrative-linear', category: 'narrative', choice: 'preserve-linear-narrative',
      reason: 'The retained source already opens with context and develops one continuous argument; reordering would weaken attribution.',
      evidenceRefs: [input.transcriptRef, input.editPlanRef], confidence: 0.94,
      alternatives: ['cold-open-reference'], bandPolicy,
    },
    {
      id: 'decision-motion-none', category: 'movement', choice: 'no_effect',
      reason: input.mediaOnly
        ? 'No owner brief or observed semantic event justifies camera simulation; the conservative media-only choice is no effect.'
        : 'The owner requested a direct, natural tone and no semantic event justifies camera simulation.',
      evidenceRefs: [input.briefRef, ...(input.briefCompilationRef ? [input.briefCompilationRef] : []), input.policyRef], confidence: 0.99,
      alternatives: ['single-punch-in-after-opening'], bandPolicy,
    },
    {
      id: 'decision-layout-inset', category: 'layout', choice: 'landscape-inset-on-blurred-source',
      reason: 'Preserves the full head and shoulders in 9:16 without the aggressive crop that previously cut the face. It applies no ' +
        `face-driven crop, so it needs no face box; a face-driven crop would need high face evidence. Evidence: ${tierLine(input.evidence.crop)}.`,
      evidenceRefs: evidenceRefsOf([input.briefRef, ...(input.briefCompilationRef ? [input.briefCompilationRef] : []), input.editPlanRef], input.evidence.crop),
      confidence: DIRECTOR_PLANNER_PRIORS.crop,
      alternatives: ['center-crop', 'top-aligned-inset'], bandPolicy, perceptionEvidence: input.evidence.crop,
    },
    {
      id: 'decision-subtitle-bottom', category: 'subtitle', choice: 'reserved-bottom-review-required',
      reason: input.ocrLowerRiskCount > 0
        ? `${faceSentence} ${input.ocrLowerRiskCount} sampled OCR frame(s) include text in the lower source region; source-to-canvas placement requires localized review. Facial safety remains unknown. Evidence: ${tierLine(input.evidence.caption)}.`
        : `${faceSentence} Captions use the reserved bottom region for proxy review; facial safety remains unknown. Evidence: ${tierLine(input.evidence.caption)}.`,
      evidenceRefs: evidenceRefsOf([input.transcriptRef, input.policyRef,
        ...(input.ocrEnvelopeRef ? [input.ocrEnvelopeRef] : [])], input.evidence.caption),
      confidence: DIRECTOR_PLANNER_PRIORS.caption,
      alternatives: ['lower-third-dynamic', 'manual-anchor-review'], bandPolicy, perceptionEvidence: input.evidence.caption,
    },
    {
      id: 'decision-transition-straight', category: 'transition', choice: 'straight-cut-with-audio-edge-fade',
      reason: 'All retained clips show the same speaker and setting; an ornamental transition would draw attention to the edit.',
      evidenceRefs: [input.editPlanRef], confidence: 0.97,
      alternatives: ['short-dissolve'], bandPolicy,
    },
    {
      id: 'decision-insert-selection',
      category: 'insert',
      choice: input.hasSelectedInsert ? 'use_selected_insert' : 'no_insert',
      reason: (input.hasSelectedInsert
        ? 'The compiled timeline contains a rights-approved selected insert; preserve it as an intentional B-roll cutaway.'
        : 'No rights-approved supporting asset is linked to the project, so the Director omits B-roll instead of fabricating relevance.') +
        ` Evidence: ${tierLine(input.evidence.insert)}.`,
      evidenceRefs: evidenceRefsOf([input.editPlanRef, input.policyRef], input.evidence.insert),
      confidence: DIRECTOR_PLANNER_PRIORS.insert,
      alternatives: ['request-library-search'], bandPolicy, perceptionEvidence: input.evidence.insert,
    },
  ]
  return validateDirectorDecisions(decisions)
}

type OcrLowerRisk = Readonly<{ envelopeId: string; sourceFrame: number; rangeMs: readonly [number, number] }>
function ocrLowerSourceRisks(envelope: Readonly<PerceptionProducerEnvelope> | undefined,
  fps: number, durationFrames: number): readonly OcrLowerRisk[] {
  if (!envelope) return Object.freeze([])
  const durationMs = Math.round(durationFrames / fps * 1_000)
  return Object.freeze(envelope.samples.filter((sample) => sample.ocr.some((region) =>
    region.box[1] + region.box[3] > 0.7)).map((sample) => {
    const startMs = Math.min(durationMs - 1, Math.round(sample.timelineFrame / fps * 1_000))
    return Object.freeze({ envelopeId: envelope.id, sourceFrame: sample.sourceFrame,
      rangeMs: Object.freeze([startMs, Math.min(durationMs, Math.max(startMs + 1,
        Math.round((sample.timelineFrame + 1) / fps * 1_000)))] as const) })
  }))
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
  ocrLowerRisks: readonly OcrLowerRisk[]
  /** The rights verdict of every source the plan plays (the master and each insert): integral, any uncertain one is a block. */
  rightsVerdicts: readonly SourceRightsVerdict[]
  /** The planned decisions with their bands (the crop, caption and insert decisions carry the evidence they stand on). */
  decisions: readonly Readonly<DirectorDecision>[]
  /** The critic's account of the perception behind the plan, sealed in the report. */
  perceptionEvidence: Readonly<DirectorPerceptionEvidenceReport>
  /** The speech the project asked to remove (its `remove-spoken-content` rules); the captions must not say any of it. */
  requestedSpeechRemovals: readonly Readonly<EditorialPhraseRule>[]
}): Readonly<DirectorQualityReport> {
  const cues = input.plan.subtitleTracks.flatMap((track) => track.cues)
  const allSubtitleText = normalizedSpeech(cues.map((cue) => cue.text).join(' '))
  // What must not be said is what THIS project asked to remove; a project that asked for nothing forbids nothing.
  const forbiddenSpeechAbsent = editorialRulesMatchingSpeech(cues.map((cue) => cue.text).join(' '), input.requestedSpeechRemovals).length === 0
  const clips = input.plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  const timelineContinuous = clips.every((clip, index) => clip.timelineInFrame === (index === 0 ? 0 : clips[index - 1]!.timelineOutFrame)) && clips.at(-1)?.timelineOutFrame === input.plan.durationFrames
  const hardChecks = Object.freeze({
    openingMotionProtected: input.plan.movementPolicy.protectedOpeningFrames >= Math.round(input.plan.fps * 4) && input.plan.effectTracks.length === 0,
    automaticZoomDisabled: input.plan.movementPolicy.automaticZoom === false,
    // Placement intent is not evidence that rendered captions avoid faces.
    subtitlesFaceSafe: false,
    subtitlesBounded: cues.every((cue) => cue.text.length <= input.plan.subtitlePolicy.maxCharactersPerBlock),
    forbiddenSpeechAbsent,
    timelineContinuous,
  })
  // Rights are integral (W64): the master and every insert the plan plays must be certain. One source that is revoked, expired, in a
  // consent that is not approved or simply unknown is a failed gate - there is no partial certainty to average over the others.
  const rightsPassed = input.rightsVerdicts.length > 0 && input.rightsVerdicts.every((verdict) => verdict.certain)
  const uncertainRights = input.rightsVerdicts.filter((verdict) => !verdict.certain)
  const rightsSummary = `rights-all-sources:certain=${input.rightsVerdicts.length - uncertainRights.length}/${input.rightsVerdicts.length}` +
    (uncertainRights.length > 0 ? `:first-refusal=${uncertainRights[0]!.artifactId}:${uncertainRights[0]!.reasonCode}` : '')
  const narrativeIntegrity = hardChecks.openingMotionProtected &&
    hardChecks.automaticZoomDisabled && hardChecks.forbiddenSpeechAbsent &&
    hardChecks.timelineContinuous
  const legibility = hardChecks.subtitlesBounded
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
        rightsSummary,
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
        `edit-plan:${input.plan.id}:subtitle-bounded=${hardChecks.subtitlesBounded}:text-only`,
      ]],
      'rights-compliance': [rightsPassed ? 100 : 0, [
        input.sourceRights.state === 'present'
          ? `rights:${input.sourceRights.snapshotId}:${input.sourceRights.snapshotHash}:status=${input.sourceRights.status}:consent=${input.sourceRights.consentStatus}`
          : 'rights:missing',
        rightsSummary,
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
        : 'rights:missing', rightsSummary],
      'cta-required': [`story:${input.storyPlan.id}:cta=${input.ctaPresent && structuredCta && ctaAligned}`],
    },
    evaluatedAt: input.evaluatedAt,
  })
  // The face tier is the caption decision's (its own ranges): absent keeps the historical code; a partial tier - V9 candidates, which
  // are never face-safe proof - is a distinct, honest warning. Neither is ever "approved".
  const captionDecision = input.decisions.find((decision) => decision.perceptionEvidence?.decisionType === 'caption')
  const captionFace = captionDecision?.perceptionEvidence?.modalities.find((item) => item.modality === 'face')
  const timelineEndMs = Math.round(input.plan.durationFrames / input.plan.fps * 1000)
  const baseIssues: DirectorQualityIssue[] = [captionFace !== undefined && captionFace.tier !== 'absent'
    ? {
        code: 'FACE_EVIDENCE_PARTIAL_REVIEW_REQUIRED',
        severity: 'warning' as const,
        category: 'editorial' as const,
        message: `Face evidence is partial and unverified (${captionFace.reasonCode}; ${captionFace.denseMs} of ${captionFace.rangeMs} ms of the caption ranges densely examined, ${captionFace.observationCount} face observation(s)). Candidates are not face-safe proof: caption placement requires review before approval or final export.`,
        rangeMs: [0, timelineEndMs] as const,
        targetId: input.plan.subtitleTracks[0]?.id ?? 'subtitle-track',
        correctable: true,
      }
    : {
        code: 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED',
        severity: 'warning' as const,
        category: 'editorial' as const,
        message: `Face detector evidence is unavailable${captionFace ? ` (${captionFace.reasonCode})` : ''}. Caption placement requires review before approval or final export.`,
        rangeMs: [0, timelineEndMs] as const,
        targetId: input.plan.subtitleTracks[0]?.id ?? 'subtitle-track',
        correctable: true,
      }]
  for (const decision of input.decisions) {
    const evidence = decision.perceptionEvidence
    if (!evidence || decision.confidenceBand === 'auto-apply') continue
    const digest = digestOfDecisionEvidence(evidence, decision.confidenceBand, decision.confidence)
    const [firstRange] = evidence.rangesMs
    const lastRange = evidence.rangesMs.at(-1)!
    baseIssues.push(Object.freeze({
      code: decision.confidenceBand === 'block' ? 'DECISION_EVIDENCE_BLOCKED' : 'DECISION_EVIDENCE_REVIEW_REQUIRED',
      severity: decision.confidenceBand === 'block' ? 'hard' as const : 'warning' as const,
      category: decision.confidenceBand === 'block' ? 'policy' as const : 'editorial' as const,
      message: `${decision.decisionType} decision ${decision.id} is ${decision.confidenceBand} under confidence-band-policy/v2: evidence tier ${evidence.tier} ` +
        `(${digest.reasonCodes.join(', ') || 'no reservation'}), confidence ${decision.confidence}. Evidence ${evidence.snapshot.id}.`,
      rangeMs: [firstRange![0], lastRange[1]] as const,
      targetId: decision.id, correctable: true,
    }))
  }
  for (const risk of input.ocrLowerRisks.slice(0, 32)) baseIssues.push(Object.freeze({
    code: 'OCR_SOURCE_LOWER_REGION_REVIEW_REQUIRED',
    severity: 'warning' as const, category: 'editorial' as const,
    message: `Server-produced OCR sample ${risk.sourceFrame} has text in the lower source region; output-canvas collision is unverified. Evidence ${risk.envelopeId}.`,
    rangeMs: risk.rangeMs, targetId: risk.envelopeId, correctable: true,
  }))
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
  // A decision whose band is `block` under the policy blocks the plan: nothing the evidence cannot stand behind is emitted.
  const decisionBlocked = input.decisions.some((decision) => decision.perceptionEvidence !== undefined && decision.confidenceBand === 'block')
  const blocked = !strategic.passed || decisionBlocked || Object.entries(hardChecks).some(([key, value]) => key !== 'subtitlesFaceSafe' && !value)
  return Object.freeze({
    schemaVersion: 'director-quality-report/v4' as const,
    id: input.id,
    desiredActionRef: input.desiredActionRef,
    status: blocked ? 'blocked' as const : 'review-required' as const,
    faceSafety: Object.freeze({ status: 'unknown' as const, reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: Object.freeze([] as string[]) }),
    score: strategic.score / 100,
    strategic,
    hardChecks,
    issues,
    perceptionEvidence: input.perceptionEvidence,
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
    const ocrEnvelope = context.ocrEnvelope
    if (ocrEnvelope) {
      const sourceRanges = context.editPlan.videoTracks.flatMap((track) => track.clips)
        .filter((clip) => clip.sourceArtifactId === context.transcript.sourceArtifactId)
        .map((clip) => ({ clipId: clip.id, sourceInFrame: clip.sourceInFrame,
          sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame,
          timelineOutFrame: clip.timelineOutFrame, rate: clip.rate }))
      assertDomain(ocrEnvelope.authority === 'server-produced' && ocrEnvelope.modality === 'ocr' &&
        ocrEnvelope.faceSafety === 'unknown' && ocrEnvelope.workspaceId === workspaceId &&
        ocrEnvelope.projectId === projectId && ocrEnvelope.projectVersionId === baseVersionId &&
        ocrEnvelope.sourceArtifactId === context.transcript.sourceArtifactId &&
        ocrEnvelope.editPlanSnapshotId === context.currentVersion.snapshotRefs.editPlan &&
        stableSerialize(ocrEnvelope.timeMap) === stableSerialize(sourceRanges),
      'PERSISTENCE_CONFLICT', 'Director OCR evidence does not match its input version and source map')
    }
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
    const proposedBriefSnapshotId = briefChanged
      ? dependencies.createId('project-snapshot')
      : currentBriefSnapshotId
    const { perception, serverPerception } = buildPerception({
      id: perceptionId,
      inputVersionId: baseVersionId,
      assembly: context.perceptionEvidence ?? directorAssemblyInput({
        workspaceId, projectId, baseVersionId, context, ...(ocrEnvelope ? { ocrEnvelope } : {}),
      }),
      transcriptId: context.transcript.id,
      ...(ocrEnvelope ? { ocrEnvelope } : {}),
    })
    const lowerOcrRisks = ocrLowerSourceRisks(ocrEnvelope,
      context.editPlan.fps, context.editPlan.durationFrames)
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
    const indexOf = transcriptWordIndexer(context.transcript.words)
    const generatedSubtitleCues = buildSubtitleCues({
      words: context.editPlan.retimedTranscript.words,
      durationFrames: context.editPlan.durationFrames,
      fps: context.editPlan.fps,
      indexOf,
    })
    // Confirmed review Commands own their caption text. Replanning must assess
    // that text afresh instead of silently replacing it from the transcript.
    const reviewedPlan = context.editPlan as unknown as {
      reviewPatch?: { patchId: string; annotationIds: readonly string[] }
      subtitleTracks: readonly { cues: readonly DirectedSubtitleCue[] }[]
    }
    let subtitleCues = generatedSubtitleCues
    if (reviewedPlan.reviewPatch) {
      assertDomain(typeof reviewedPlan.reviewPatch.patchId === 'string' &&
        Array.isArray(reviewedPlan.reviewPatch.annotationIds) &&
        reviewedPlan.reviewPatch.annotationIds.length > 0,
      'INVALID_RENDER_INPUT', 'Reviewed captions require confirmed annotation lineage')
      const reviewedCues = reviewedPlan.subtitleTracks.flatMap((track) => track.cues)
      assertDomain(reviewedCues.length === generatedSubtitleCues.length &&
        reviewedCues.every((cue, index) => {
          const generated = generatedSubtitleCues[index]!
          return cue.id === generated.id && cue.startFrame === generated.startFrame &&
            cue.endFrame === generated.endFrame
        }), 'INVALID_RENDER_INPUT', 'Reviewed caption timing must match the current transcript alignment')
      subtitleCues = Object.freeze(reviewedCues.map((cue) => Object.freeze({ ...cue })))
    }

    // ---- W64. What the plan stands on, from the snapshot of the Version it directs (resolved above, at claim) and from the rights of
    // every source it plays. Face windows the plan needs and the sealed evidence lacks are requested now and never waited for.
    const snapshotId = serverPerceptionSnapshotId(serverPerception.snapshotHash)
    const planClips: readonly PerceptionSnapshotClip[] = context.perceptionEvidence?.editPlan.clips ?? Object.freeze(clips.map((clip) =>
      Object.freeze({ id: clip.id, sourceArtifactId: clip.sourceArtifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
        timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate })))
    const faceOutcome = await requestDirectorFaceWindows(
      { ...(dependencies.faceWindows ? { requester: dependencies.faceWindows } : {}) },
      {
        workspaceId, projectId, baseVersionId, authenticationAudit,
        fps: context.editPlan.fps, durationFrames: context.editPlan.durationFrames, clips: planClips,
        refusedSources: (context.perceptionEvidence?.faceWindowRefusals ?? []).map((refusal) => refusal.sourceArtifactId),
        sealedWindows: (context.perceptionEvidence?.faceWindows ?? []).map((window) => ({
          sourceArtifactId: window.sourceArtifactId, startSourceFrame: window.window.startSourceFrame, endSourceFrame: window.window.endSourceFrame })),
      },
    )
    const planSourceIds = [...new Set(clips.flatMap((clip) => [clip.sourceArtifactId, ...(clip.audioSourceArtifactId ? [clip.audioSourceArtifactId] : [])]))].toSorted()
    const rightsNow = new Date(createdAt)
    const rightsVerdicts: readonly SourceRightsVerdict[] = Object.freeze(planSourceIds.map((artifactId) => evaluateSourceRightsCertainty(
      artifactId,
      context.timelineSourceRights
        ? context.timelineSourceRights.find((entry) => entry.artifactId === artifactId)?.rights
        // A controlled context states the master's rights only: every other source is unknown, and unknown is not certain.
        : artifactId === context.transcript.sourceArtifactId ? context.sourceRights : undefined,
      rightsNow)))
    const durationMs = serverPerception.timeline.durationMs
    const wholeTimeline: readonly PerceptionRange[] = Object.freeze([Object.freeze([0, durationMs] as const)])
    const captionRanges = subtitleCues.length === 0 ? wholeTimeline
      : frameRangesToCoverageMs(subtitleCues.map((cue) => ({ startFrame: cue.startFrame, endFrame: cue.endFrame })),
        context.editPlan.fps, context.editPlan.durationFrames, durationMs)
    const insertClips = clips.filter((clip) => clip.sourceArtifactId !== context.transcript.sourceArtifactId)
    const insertRanges = insertClips.length === 0 ? wholeTimeline
      : frameRangesToCoverageMs(insertClips.map((clip) => ({ startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame })),
        context.editPlan.fps, context.editPlan.durationFrames, durationMs)
    const insertSourceIds = new Set(insertClips.map((clip) => clip.sourceArtifactId))
    const evidenceBase = { snapshot: serverPerception, snapshotId, faceRequests: faceOutcome.state } as const
    const decisions = buildDecisions({
      briefRef: proposedBriefSnapshotId,
      transcriptRef: context.transcript.id,
      editPlanRef: context.currentVersion.snapshotRefs.editPlan,
      policyRef: context.currentVersion.snapshotRefs.policies,
      hasSelectedInsert,
      ...(briefCompilation
        ? { briefCompilationRef: briefCompilation.audit.outputHash }
        : {}),
      mediaOnly: Boolean(mediaOnlyTreatment),
      ...(ocrEnvelope ? { ocrEnvelopeRef: ocrEnvelope.id } : {}),
      ocrLowerRiskCount: lowerOcrRisks.length,
      evidence: {
        crop: assessDecisionEvidence({ ...evidenceBase, decisionId: 'decision-layout-inset', decisionType: 'crop', rangesMs: wholeTimeline }),
        caption: assessDecisionEvidence({ ...evidenceBase, decisionId: 'decision-subtitle-bottom', decisionType: 'caption', rangesMs: captionRanges }),
        insert: assessDecisionEvidence({ ...evidenceBase, decisionId: 'decision-insert-selection', decisionType: 'insert', rangesMs: insertRanges,
          inserted: hasSelectedInsert, rights: rightsVerdicts.filter((verdict) => insertSourceIds.has(verdict.artifactId)) }),
      },
    })
    const captionFaceEvidence = decisions.find((decision) => decision.id === 'decision-subtitle-bottom')?.perceptionEvidence
      ?.modalities.find((item) => item.modality === 'face')
    const perceptionEvidenceReport = createDirectorPerceptionEvidenceReport({
      snapshot: serverPerception, rights: rightsVerdicts, faceWindows: faceOutcome.report, faceRequests: faceOutcome.state,
      decisions: decisions.flatMap((decision) => decision.perceptionEvidence
        ? [digestOfDecisionEvidence(decision.perceptionEvidence, decision.confidenceBand, decision.confidence)] : []),
    })
    const assumptions = Object.freeze([...new Set([
      captionFaceEvidence?.tier === 'partial'
        ? `Face evidence is a partial, unverified candidate (${captionFaceEvidence.reasonCode}); keep the bottom caption region reserved for human visual review.`
        : `Face evidence is unavailable${captionFaceEvidence ? ` (${captionFaceEvidence.reasonCode})` : ''}; reserve the bottom caption region for human visual review.`,
      hasSelectedInsert
        ? 'The selected insert already passed the asset-selection and rights gates.'
        : 'No rights-approved B-roll candidate is linked; omission is safer than an irrelevant insert.',
      ...(briefCompilation?.compiled.assumptions ?? []),
      ...(mediaOnlyTreatment?.assumptions ?? []),
    ])])
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
      audioTimelineHash: createEditorialAudioTimelineHash({ fps: context.editPlan.fps, clips }),
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
        // The same cue track shape the ingest compiles: an editorial cut that ends inside one of these captions rebuilds the part
        // that remains from the transcript words the cue names, and refuses a cue that names none.
        ...(indexOf !== null && subtitleCues.some((cue) => cue.sourceWordIndices !== undefined)
          ? { schemaVersion: 'source-transcript-cue-track/v1' as const, sourceTranscriptId: context.transcript.id,
            sourceTranscriptHash: context.transcript.transcriptHash }
          : {}),
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
    // Source-space OCR remains valid only while the result keeps the input clip map.
    assertDomain(stableSerialize(editPlan.videoTracks) === stableSerialize(context.editPlan.videoTracks),
      'PERSISTENCE_CONFLICT', 'Director result changed source mapping before OCR projection')
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
      ocrLowerRisks: lowerOcrRisks,
      rightsVerdicts,
      decisions,
      perceptionEvidence: perceptionEvidenceReport,
      requestedSpeechRemovals: context.requestedSpeechRemovals ?? [],
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
        requestedSpeechStillPresent: editorialRulesMatchingSpeech(
          editPlan.subtitleTracks.flatMap((track) => track.cues).map((cue) => cue.text).join(' '),
          context.requestedSpeechRemovals ?? []),
        blockedDecisions: decisions.filter((decision) => decision.perceptionEvidence !== undefined && decision.confidenceBand === 'block')
          .map((decision) => decision.id),
        uncertainRights: rightsVerdicts.filter((verdict) => !verdict.certain).map((verdict) => `${verdict.artifactId}:${verdict.reasonCode}`),
      },
    )
    const proposedPerceptionSnapshotId = dependencies.createId('project-snapshot')
    const proposedTreatmentSnapshotId = dependencies.createId('project-snapshot')
    const proposedStorySnapshotId = dependencies.createId('project-snapshot')
    const proposedEditPlanSnapshotId = dependencies.createId('project-snapshot')
    const proposedQualitySnapshotId = dependencies.createId('project-snapshot')
    // Fixed with the rest of the identifiers: a retried owner transaction rebinds references, it never mints new ones.
    const stateId = dependencies.createId('project-output-state')
    const materializationIds = context.parent.state.document.entries.map(() => dependencies.createId('output-materialization'))
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
    // Planning, criticism, compiler work, IDs and time are fixed before the
    // owner transaction. A retry only rebinds canonical references and seals.
    const plannedDecisions = decisions
    const plannedEditPlan = editPlan
    // The recordings the plan consumes that the head State does not observe (selected inserts, music) are read before
    // the owner transaction opens; the transition adopts their persisted receipts and nothing else.
    const adoptable = await offeredObservationsFor(dependencies.repository, context.parent, plannedEditPlan as unknown as Record<string, unknown>)
    const eventId = dependencies.createEventId()
    const committed = await dependencies.repository.commitWithCanonicalSnapshots({
      workspaceId, projectId, baseVersionId, baseHash: request.baseHash, resultVersionId: versionId,
      idempotencyKey, requestFingerprint, actorContextHash: authenticationAudit.contextHash,
      ...(request.operationFence ? { operationFence: request.operationFence } : {}),
    }, async (resolveSnapshots) => {
      const briefCandidate = compiledBrief ? snapshot({
        id: proposedBriefSnapshotId, workspaceId, projectId, kind: 'brief',
        contentSchemaVersion: briefCompilation ? 3 : 2, value: compiledBrief, createdAt,
      }) : undefined
      const resolvedBrief = briefCandidate
        ? bindDirectorSnapshotIdentities([briefCandidate], await resolveSnapshots([briefCandidate]))[0]!
        : undefined
      const briefSnapshotId = resolvedBrief?.id ?? currentBriefSnapshotId
      const decisions = validateDirectorDecisions(plannedDecisions.map((decision) => ({
        id: decision.id, category: decision.category, choice: decision.choice,
        reason: decision.reason, confidence: decision.confidence,
        alternatives: decision.alternatives,
        evidenceRefs: decision.evidenceRefs.map((ref) =>
          ref === proposedBriefSnapshotId ? briefSnapshotId : ref),
        ...(decision.bandPolicy ? { bandPolicy: decision.bandPolicy } : {}),
        ...(decision.perceptionEvidence ? { perceptionEvidence: decision.perceptionEvidence } : {}),
      })))
      const editPlan: DirectedEditPlan = Object.freeze({
        ...plannedEditPlan,
        director: Object.freeze({ ...plannedEditPlan.director, decisions }),
      })
      const candidates = Object.freeze([
        ...(resolvedBrief ? [resolvedBrief] : []),
        snapshot({ id: proposedPerceptionSnapshotId, workspaceId, projectId, kind: 'perception', contentSchemaVersion: 2, value: perception, createdAt }),
        snapshot({ id: proposedTreatmentSnapshotId, workspaceId, projectId, kind: 'treatment', contentSchemaVersion: treatmentPlan.schemaVersion, value: treatmentPlan, createdAt }),
        snapshot({ id: proposedStorySnapshotId, workspaceId, projectId, kind: 'story', contentSchemaVersion: 1, value: storyPlan, createdAt }),
        snapshot({ id: proposedEditPlanSnapshotId, workspaceId, projectId, kind: 'edit-plan', contentSchemaVersion: 2, value: editPlan, createdAt }),
        snapshot({ id: proposedQualitySnapshotId, workspaceId, projectId, kind: 'quality-report', contentSchemaVersion: 4, value: qualityReport, createdAt }),
      ])
      const snapshots = bindDirectorSnapshotIdentities(candidates, await resolveSnapshots(candidates))
      const byKind = new Map(snapshots.map((item) => [item.kind, item.id]))
      const perceptionSnapshotId = byKind.get('perception')!
      const treatmentSnapshotId = byKind.get('treatment')!
      const storySnapshotId = byKind.get('story')!
      const editPlanSnapshotId = byKind.get('edit-plan')!
      const qualitySnapshotId = byKind.get('quality-report')!
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
        variantIds: context.variantIds,
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
      // The Version keeps the parent's snapshots except the ones this run replaced. A snapshot the canonical store
      // resolved to the parent's own row is inherited, not replaced.
      const resolvedByKind = new Map(snapshots.map((item) => [item.kind, item]))
      const replacementSnapshots = (['brief', 'story', 'treatment'] as const).flatMap((kind) => {
        const resolved = resolvedByKind.get(kind)
        return resolved && resolved.id !== context.currentVersion.snapshotRefs[kind] ? [resolved] : []
      })
      let allocatedMaterializations = 0
      const bundle = transitionProjectOutputState({
        ...(adoptable.length > 0 ? { adoptable } : {}),
        parent: context.parent, command, audit: authenticationAudit, requestFingerprint,
        editPlanSnapshot: resolvedByKind.get('edit-plan')!, replacementSnapshots,
        allocation: {
          workspaceId, projectId, resultVersionId: versionId, stateId, parentVersionId: context.currentVersion.id,
          sequence: context.currentVersion.sequence + 1, createdBy: clientId, createdAt,
        },
        createMaterializationId: () => materializationIds[allocatedMaterializations++]!,
      })
      const version = bundle.version
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
      const decisionLog = createDirectorDecisionLog({
        workspaceId,
        projectId,
        runId: directorRunId,
        commandId,
        resultVersionId: versionId,
        actor: authenticationAudit.delegatedUserId
          ? { type: 'user', id: normalizedIdentifier(authenticationAudit.delegatedUserId, 'actor.delegatedUserId') }
          : { type: 'api-client', id: clientId },
        storyPlan,
        decisions,
        createdAt,
      })
      const event = createPublicEvent({
        id: eventId, type: 'project.version.created', version: '1.0.0', workspaceId,
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
      return {
        bundle, snapshots, run, decisionLog, event,
        ...(serverPerception.editPlan.snapshotHash !== null && serverPerception.sources.every((source) => source.sha256 !== null)
          ? { serverPerception } : {}),
        sourceEvidence: {
          transcriptId: context.transcript.id,
          transcriptHash: context.transcript.transcriptHash,
          sourceArtifactId: context.transcript.sourceArtifactId,
          // The rights the plan was judged on: the commit re-reads them and refuses the run if any moved or stopped being certain.
          rights: Object.freeze(rightsVerdicts.map((verdict) => Object.freeze({
            artifactId: verdict.artifactId, snapshotId: verdict.snapshotId, snapshotHash: verdict.snapshotHash }))),
          ...(ocrEnvelope ? { ocrEnvelope: Object.freeze({ id: ocrEnvelope.id,
            envelopeHash: ocrEnvelope.envelopeHash, inputVersionId: baseVersionId,
            sourceArtifactId: ocrEnvelope.sourceArtifactId, timeMapHash: ocrEnvelope.timeMapHash }) } : {}),
        },
        ...(request.operationFence ? { operationFence: request.operationFence } : {}),
      }
    })
    if (!committed.replayed && dependencies.materializeSnapshot) {
      try {
        await dependencies.materializeSnapshot({ workspaceId, projectId, projectVersionId: committed.version.id })
      } catch (error) {
        // Best effort by design (see the dependency): the run is sealed, and an unwritten snapshot reads as SNAPSHOT_NOT_MATERIALIZED.
        // It is not silent: one structured warning names the run and the Version and the kind of failure - never the message, which
        // may carry data the log must not.
        const emit = dependencies.warn ?? ((event: Readonly<Record<string, unknown>>) => { console.warn(JSON.stringify(event)) })
        try {
          emit(Object.freeze({
            level: 'warn', kind: 'director-snapshot-materialization-failed', workspaceId, projectId, directorRunId,
            projectVersionId: committed.version.id,
            errorName: error instanceof Error ? error.name : 'NonError',
            errorCode: error instanceof DomainError ? error.code : null,
          }))
        } catch { /* a failing log sink must not fail a sealed run either */ }
      }
    }
    return committed
  }
}
