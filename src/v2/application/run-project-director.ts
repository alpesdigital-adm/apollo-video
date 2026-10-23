import {
  type DirectedEditPlan,
  type DirectedSubtitleCue,
  type DirectorDecision,
  type DirectorDecisionInput,
  type DirectorHardCheck,
  type DirectorPerceptionSnapshot,
  type DirectorQualityIssue,
  type DirectorQualityReportV5,
  type DirectorRun,
  type RunDirectorCommandPayload,
  validateDirectedEditPlan,
  validateDirectorDecisions,
} from '../domain/director-run.ts'
import { captionCuesThatDoNotFit, captionTextFitsEveryOutput } from '../domain/caption-fit.ts'
import { createEditCommand } from '../domain/edit-command.ts'
import type { OutputSpecRevisionBody } from '../domain/output-spec-revision.ts'
import { assertBriefingInterpreted, deriveEditorialRequestFromBrief } from '../domain/editorial-request.ts'
import {
  POLICY_RESOLUTION_SNAPSHOT_SCHEMA_VERSION, assertResolutionPlannable, planMovementPolicyUnder, captionTrackId, compositionUnderPolicy, movementMatchesPolicy,
  openingMatchesPolicy, policyRef, protectedOpeningSeconds, resolveEditorialPolicies, storyBlockUnderPolicy,
  type CaptionPolicyValue, type EditorialMediaContext, type EditorialOutputSpec, type EditorialPolicies, type EditorialPolicyResolutionV1,
} from '../domain/editorial-policy-resolution.ts'
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
import { ctaLexiconFor, normalizeSpeechForLexicon, observeSpokenCta } from '../domain/cta-lexicon.ts'
import { transitionProjectOutputState } from '../domain/project-output-state-transition.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import {
  bindDirectorObjective,
  resolveStrategicObjective,
  type StrategicObjectiveId,
} from '../domain/strategic-objective.ts'
import {
  createQualityReport as createStrategicQualityReport,
  effectiveRubricCriteria,
  resolveStrategicRubric,
  type QualityEvidence,
  type RubricCriterionId,
} from '../domain/strategic-rubric.ts'
import { validateStoryPlan, type StoryBlock, type StoryPlan } from '../domain/story-plan.ts'
import { createDirectorDecisionLog } from '../domain/director-decision.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import { createTreatmentPlan, TREATMENT_EFFECTS } from '../domain/treatment-plan.ts'
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

// v3 (ADR-160): the plan is made from the policy resolution of the editorial request; every decision names the policy it stands on and its
// reason is generated from that policy's origin.
// v4 (ADR-160 F3-F5): captions are grouped by the preset and fitted to the measured band of each output, the spoken CTA is judged in the language of the
// speech, and the opening, structure, layout and budgets are derived from the request (a v3 plan carried 4 s, 32 characters and roles by position).
export const PROJECT_DIRECTOR_PLANNER_VERSION = 'apollo-director-policy/v4'
// v4 (ADR-160): the critic judges the plan against the sealed policy resolution and writes `director-quality-report/v5`; a report born
// under v1-v3 is not admitted to final export (see `admitDirectorQualityForFinal`). v3 had made `forbiddenSpeechAbsent` the project's own
// request instead of a fixed list.
// v5 (ADR-160 F3-F5): `captionsFitMeasured` replaces `captionsBounded`, and the rubric counts only the criteria the request asked for; a report born under v4 is not admitted.
export const PROJECT_DIRECTOR_CRITIC_VERSION = 'apollo-director-critic/v5'

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

/** The mean adjacent-frame change score of the shot observations, as a ratio. No observation, no measurement: 0. */
function measuredVisualVariety(observations: readonly Readonly<{ kind: string; value: unknown }>[]): number {
  const scores = observations.filter((item) => item.kind === 'shot').map((item) => (item.value as { changeScore?: unknown } | null)?.changeScore)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score))
  if (scores.length === 0) return 0
  return Number(Math.min(1, Math.max(0, scores.reduce((sum, score) => sum + score, 0) / scores.length)).toFixed(4))
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
  /**
   * The caption policy: a cue holds at most the preset's words and time on screen and the preset's capacity in characters, ends at a silence
   * longer than the preset's minimum time on screen, and is never wider than the band of any output that burns captions (measured).
   */
  captions: Readonly<EditorialPolicies['captions']>['value']
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
  const { grouping, capacityCharacters, deliveries } = input.captions
  const burned = deliveries.flatMap((delivery) => delivery.fit ? [delivery.fit] : [])
  for (const word of input.words) {
    const candidateText = [...group, word].map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim()
    const candidateDurationMs = group.length === 0 ? 0 : (word.timelineEndFrame - group[0]!.timelineStartFrame) / input.fps * 1_000
    const gapMs = group.length === 0 ? 0 : (word.timelineStartFrame - group.at(-1)!.timelineEndFrame) / input.fps * 1_000
    if (group.length > 0 && (
      candidateText.length > capacityCharacters ||
      candidateDurationMs > grouping.maxOnScreenMs ||
      gapMs > grouping.silenceBreakMs ||
      group.length >= grouping.maxWordsPerGroup ||
      !captionTextFitsEveryOutput(candidateText, burned)
    )) flush()
    group = [...group, word]
    if (/[.!?]$/.test(word.text) || group.length >= grouping.maxWordsPerGroup) flush()
  }
  flush()
  // All or nothing: a track whose cues are only partly named would be trusted for the cues that are and refused for the others.
  return Object.freeze(cues.map((cue) => {
    if (named) return Object.freeze(cue)
    const { sourceWordIndices: _dropped, ...unnamed } = cue
    return Object.freeze(unnamed)
  }))
}

/**
 * Where the call to action is spoken: the sentence, in the last clip that has it, in which the words of the language of the speech (or the exact
 * text the requester gave) ask for the action. Nothing is assumed about where a call usually is: it is found or it is not.
 */
function locateSpokenCta(input: {
  action: Readonly<DesiredAction>
  language?: string
  fps: number
  words: readonly Readonly<{ text: string; timelineStartFrame: number; timelineEndFrame: number }>[]
  clips: readonly Readonly<{ id: string; timelineInFrame: number; timelineOutFrame: number }>[]
}): Readonly<{ clipId: string; startSeconds: number; endSeconds: number }> | undefined {
  if (input.action.kind === 'continue-viewing') return undefined
  const lexicon = ctaLexiconFor(input.language)
  const verbal = input.action.verbalCta?.trim() ? normalizeSpeechForLexicon(input.action.verbalCta) : ''
  if (!verbal && lexicon === null) return undefined
  const pattern = lexicon?.patterns[input.action.kind]
  for (const clip of [...input.clips].reverse()) {
    const words = input.words.filter((word) => word.timelineStartFrame >= clip.timelineInFrame && word.timelineEndFrame <= clip.timelineOutFrame)
    if (words.length === 0) continue
    const normalized = words.map((word) => normalizeSpeechForLexicon(word.text))
    const offsets: number[] = []
    let joined = ''
    normalized.forEach((text, index) => { if (index > 0) joined += ' '; offsets.push(joined.length); joined += text })
    const found: { start: number; end: number }[] = []
    if (verbal) {
      const at = joined.lastIndexOf(verbal)
      if (at >= 0) found.push({ start: at, end: at + verbal.length })
    }
    if (found.length === 0 && pattern) {
      const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
      for (const match of joined.matchAll(global)) found.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
    }
    const last = found.at(-1)
    if (!last) continue
    const wordAt = (offset: number) => Math.max(0, offsets.findLastIndex((start) => start <= offset))
    const first = wordAt(last.start)
    const closing = wordAt(Math.max(last.start, last.end - 1))
    let from = first
    while (from > 0 && !/[.!?]$/u.test(words[from - 1]!.text)) from -= 1
    let to = closing
    while (to < words.length - 1 && !/[.!?]$/u.test(words[to]!.text)) to += 1
    return Object.freeze({
      clipId: clip.id,
      startSeconds: Math.round(words[from]!.timelineStartFrame / input.fps * 1_000) / 1_000,
      endSeconds: Math.round(words[to]!.timelineEndFrame / input.fps * 1_000) / 1_000,
    })
  }
  return undefined
}

function buildStoryPlan(input: {
  id: string
  objective: string
  desiredAction: Readonly<DesiredAction>
  desiredActionRef: Readonly<DesiredActionReference>
  /** The clip where the call to action is spoken (its last occurrence), when the speech has one: the block of the call is there, not at an end. */
  ctaClipId?: string
  /** The resolved structure and CTA policies: the blocks are the policy's, not the builder's. */
  policies: Pick<EditorialPolicies, 'structure' | 'cta'>
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
    const isCta = input.policies.cta.value.required && input.desiredAction.kind !== 'continue-viewing' && input.ctaClipId === clip.id
    const shape = storyBlockUnderPolicy(input.policies.structure, { isCta, actionKind: input.desiredAction.kind })
    return {
      id: `story-block-${index + 1}`,
      actId: shape.actId,
      role: shape.role,
      intent: shape.intent,
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
  const durationMs = Math.max(1, Math.round(input.durationFrames / input.fps * 1000))
  const plan: StoryPlan & { id: string } = {
    id: input.id,
    schemaVersion: 2,
    objective: input.objective,
    desiredActionRef: input.desiredActionRef,
    targetDurationMs: { min: Math.max(1, durationMs - 1_000), max: durationMs + 1_000 },
    // One act holds the timeline in source order: no part of it is named an opening, a development or a resolution.
    acts: [{ id: 'sequence', role: 'sequence', blockIds: blocks.map((block) => block.id) }],
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
  /** The project's policy snapshot (guardrails): not to be mistaken for the editorial policy resolution below. */
  projectPolicyRef: string
  /** The sealed resolution every decision stands on: each decision names its policies, and its reason is the policy's own. */
  resolution: Readonly<EditorialPolicyResolutionV1>
  hasSelectedInsert: boolean
  briefCompilationRef?: string
  ocrEnvelopeRef?: string
  ocrLowerRiskCount: number
  evidence: Readonly<{
    crop: Readonly<DecisionPerceptionEvidence>
    caption: Readonly<DecisionPerceptionEvidence>
    insert: Readonly<DecisionPerceptionEvidence>
  }>
}): readonly Readonly<DirectorDecision>[] {
  const bandPolicy = DECISION_BAND_POLICY_REF
  const { policies } = input.resolution
  const ref = (key: keyof EditorialPolicies) => policyRef(input.resolution, key)
  const captionFace = input.evidence.caption.modalities.find((item) => item.modality === 'face')
  const faceSentence = captionFace === undefined ? 'Face observations are unavailable.'
    : captionFace.tier === 'absent' ? `Face observations are unavailable (${captionFace.reasonCode}).`
      : `Face evidence is a partial, unverified candidate (${captionFace.reasonCode}).`
  const decisions: readonly DirectorDecisionInput[] = [
    {
      id: 'decision-narrative-linear', category: 'narrative', choice: 'preserve-linear-narrative',
      reason: policies.structure.reason,
      evidenceRefs: [input.transcriptRef, input.editPlanRef, ref('structure')], confidence: 0.94,
      alternatives: ['cold-open-reference'], bandPolicy,
    },
    {
      id: 'decision-motion-none', category: 'movement', choice: 'no_effect',
      // The reason is the policy's: it quotes the request when the request asked, and says so when it was silent.
      reason: policies.movement.reason,
      evidenceRefs: [input.briefRef, ...(input.briefCompilationRef ? [input.briefCompilationRef] : []), input.projectPolicyRef, ref('movement'), ref('opening')], confidence: 0.99,
      alternatives: ['single-punch-in-after-opening'], bandPolicy,
    },
    {
      id: 'decision-layout-inset', category: 'layout', choice: policies.layout.value.mode === 'source-native' ? 'source-native-frame' : 'landscape-inset-on-blurred-source',
      reason: `${policies.layout.reason} It applies no face-driven crop, so it needs no face box; a face-driven crop would need high face evidence. ` +
        `Evidence: ${tierLine(input.evidence.crop)}.`,
      evidenceRefs: evidenceRefsOf([input.briefRef, ...(input.briefCompilationRef ? [input.briefCompilationRef] : []), input.editPlanRef, ref('layout')], input.evidence.crop),
      confidence: DIRECTOR_PLANNER_PRIORS.crop,
      alternatives: ['center-crop', 'top-aligned-inset'], bandPolicy, perceptionEvidence: input.evidence.crop,
    },
    {
      id: 'decision-subtitle-bottom', category: 'subtitle', choice: 'reserved-bottom-review-required',
      reason: (input.ocrLowerRiskCount > 0
        ? `${faceSentence} ${input.ocrLowerRiskCount} sampled OCR frame(s) include text in the lower source region; source-to-canvas placement requires localized review. Facial safety remains unknown. Evidence: ${tierLine(input.evidence.caption)}.`
        : `${faceSentence} Captions use the reserved bottom region for proxy review; facial safety remains unknown. Evidence: ${tierLine(input.evidence.caption)}.`) +
        ` ${policies.captions.reason}`,
      evidenceRefs: evidenceRefsOf([input.transcriptRef, input.projectPolicyRef, ref('captions'), ref('language'),
        ...(input.ocrEnvelopeRef ? [input.ocrEnvelopeRef] : [])], input.evidence.caption),
      confidence: DIRECTOR_PLANNER_PRIORS.caption,
      alternatives: ['lower-third-dynamic', 'manual-anchor-review'], bandPolicy, perceptionEvidence: input.evidence.caption,
    },
    {
      id: 'decision-transition-straight', category: 'transition', choice: 'straight-cut-with-audio-edge-fade',
      reason: policies.transitions.reason,
      evidenceRefs: [input.editPlanRef, ref('transitions')], confidence: 0.97,
      alternatives: ['short-dissolve'], bandPolicy,
    },
    {
      id: 'decision-insert-selection',
      category: 'insert',
      choice: input.hasSelectedInsert ? 'use_selected_insert' : 'no_insert',
      reason: `${policies.inserts.reason} Evidence: ${tierLine(input.evidence.insert)}.`,
      evidenceRefs: evidenceRefsOf([input.editPlanRef, input.projectPolicyRef, ref('inserts')], input.evidence.insert),
      confidence: DIRECTOR_PLANNER_PRIORS.insert,
      alternatives: ['request-library-search'], bandPolicy, perceptionEvidence: input.evidence.insert,
    },
  ]
  // A reference is named once per decision, however many of its sources point at the same row.
  return validateDirectorDecisions(decisions.map((decision) => ({ ...decision, evidenceRefs: [...new Set(decision.evidenceRefs)] })))
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

/**
 * The caption style a project override fixed, as the policy snapshot resolved it (`resolved.subtitleStyle`, schema 2): the project's own
 * override, or the workspace Guardrail it inherits. An explicit `none` and a project that inherits nothing name no style.
 */
function subtitleStyleOverrideOf(policies: Readonly<Record<string, unknown>>): EditorialMediaContext['subtitleStyleOverride'] {
  const resolved = policies.resolved
  if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) return undefined
  const entry = (resolved as Record<string, unknown>).subtitleStyle
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const { value, origin } = entry as { value?: unknown; origin?: unknown }
  return typeof value === 'string' && (origin === 'workspace' || origin === 'project-custom')
    ? Object.freeze({ presetId: value, origin }) : undefined
}

/** Seconds, on the timeline, where the last sentence of the speech begins: the word after the last sentence-closing word that precedes the final one. */
function closingSentenceStartSecondsOf(words: readonly Readonly<{ text: string; timelineStartFrame: number }>[], fps: number): number | undefined {
  if (words.length === 0) return undefined
  let index = words.length - 1
  while (index > 0 && !/[.!?]$/u.test(words[index - 1]!.text)) index -= 1
  return Math.round(words[index]!.timelineStartFrame / fps * 1_000) / 1_000
}

/** Seconds, on the timeline, at which the first sentence of the speech ends: the first word that closes a sentence (absent: no word does). */
function firstSentenceEndSecondsOf(words: readonly Readonly<{ text: string; timelineEndFrame: number }>[], fps: number): number | undefined {
  const closing = words.find((word) => /[.!?]$/u.test(word.text))
  return closing === undefined ? undefined : Math.round(closing.timelineEndFrame / fps * 1_000) / 1_000
}

/**
 * The outputs of the project, as the sealed State holds them: the geometry and the caption delivery of each. An output whose revision does
 * not carry a materialized geometry (a fork target before it is materialized) contributes its variant only: nothing is measured on it.
 */
function outputsOfState(entries: readonly Readonly<{ variantId: string; spec: unknown }>[]): readonly EditorialOutputSpec[] {
  return Object.freeze(entries.map((entry) => {
    const spec = entry.spec as Partial<OutputSpecRevisionBody> & { effectiveSpec?: Partial<OutputSpecRevisionBody> }
    const body = spec.output !== undefined ? spec : spec.effectiveSpec
    const output = body?.output
    const mode = body?.profile?.subtitles?.mode
    return Object.freeze({
      variantId: entry.variantId,
      ...(output ? { id: output.id, aspectRatio: output.aspectRatio, spec: output } : {}),
      ...(mode === 'none' || mode === 'burn-in' || mode === 'sidecar' ? { subtitleMode: mode } : {}),
    })
  }))
}

const check = (id: string, kind: DirectorHardCheck['kind'], policy: string | null, passed: boolean, evidence: readonly string[]): Readonly<DirectorHardCheck> =>
  Object.freeze({ id, kind, passed, policyRef: policy, evidence: Object.freeze([...evidence]) })

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
  /** The sealed resolution the plan is judged against, and the request hash it was made for. */
  resolution: Readonly<EditorialPolicyResolutionV1>
  /** The language the speech is in (the observed transcript): the words of a spoken call to action are judged in it. */
  speechLanguage?: string
}): Readonly<DirectorQualityReportV5> {
  const cues = input.plan.subtitleTracks.flatMap((track) => track.cues)
  const allSubtitleText = normalizedSpeech(cues.map((cue) => cue.text).join(' '))
  // What must not be said is what THIS project asked to remove; a project that asked for nothing forbids nothing.
  const forbiddenSpeechAbsent = editorialRulesMatchingSpeech(cues.map((cue) => cue.text).join(' '), input.requestedSpeechRemovals).length === 0
  const clips = input.plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  const timelineContinuous = clips.every((clip, index) => clip.timelineInFrame === (index === 0 ? 0 : clips[index - 1]!.timelineOutFrame)) && clips.at(-1)?.timelineOutFrame === input.plan.durationFrames
  const { policies } = input.resolution
  const ref = (key: keyof EditorialPolicies) => policyRef(input.resolution, key)
  const movementFacts = Object.freeze({
    fps: input.plan.fps, automaticZoom: input.plan.movementPolicy.automaticZoom,
    protectedOpeningFrames: input.plan.movementPolicy.protectedOpeningFrames, effectTrackCount: input.plan.effectTracks.length,
  })
  const movementOk = movementMatchesPolicy(movementFacts, policies.movement)
  const openingOk = openingMatchesPolicy(movementFacts, policies.opening)
  const requestHonored = !input.resolution.blocked
  const longestCue = cues.reduce((longest, cue) => Math.max(longest, cue.text.length), 0)
  // Captions fit: within the preset's capacity (the plan declares it) and, on every output that burns captions, within the band measured there.
  const burnedGeometries = policies.captions.value.deliveries.flatMap((delivery) => delivery.fit ? [delivery.fit] : [])
  const cuesThatDoNotFit = captionCuesThatDoNotFit(cues.map((cue) => ({ id: cue.id, text: cue.text })), burnedGeometries)
  const captionsFitMeasured = longestCue <= Math.min(policies.captions.value.capacityCharacters, input.plan.subtitlePolicy.maxCharactersPerBlock) && cuesThatDoNotFit.length === 0
  const removalMatches = editorialRulesMatchingSpeech(cues.map((cue) => cue.text).join(' '), input.requestedSpeechRemovals).length
  // Rights are integral (W64): the master and every insert the plan plays must be certain. One source that is revoked, expired, in a
  // consent that is not approved or simply unknown is a failed gate - there is no partial certainty to average over the others.
  const rightsPassed = input.rightsVerdicts.length > 0 && input.rightsVerdicts.every((verdict) => verdict.certain)
  const uncertainRights = input.rightsVerdicts.filter((verdict) => !verdict.certain)
  const rightsSummary = `rights-all-sources:certain=${input.rightsVerdicts.length - uncertainRights.length}/${input.rightsVerdicts.length}` +
    (uncertainRights.length > 0 ? `:first-refusal=${uncertainRights[0]!.artifactId}:${uncertainRights[0]!.reasonCode}` : '')
  const hardChecks: readonly Readonly<DirectorHardCheck>[] = Object.freeze([
    check('requestHonored', 'request', null, requestHonored,
      [`resolution:${input.resolution.policyResolutionHash}`, `unsupported=${input.resolution.unsupported.length}`, `open-questions=${input.resolution.openQuestions.length}`]),
    check('movementMatchesPolicy', 'request', ref('movement'), movementOk,
      [`policy-mode=${policies.movement.value.mode}`, `effect-tracks=${movementFacts.effectTrackCount}`, `automatic-zoom=${String(movementFacts.automaticZoom)}`]),
    check('openingMatchesPolicy', 'request', ref('opening'), openingOk,
      [`policy-mode=${policies.opening.value.mode}`, `protected-opening-frames=${movementFacts.protectedOpeningFrames}`, `effect-tracks=${movementFacts.effectTrackCount}`]),
    check('forbiddenSpeechAbsent', 'request', ref('speechRemovals'), forbiddenSpeechAbsent,
      [`removal-rules=${input.requestedSpeechRemovals.length}`, `matches-in-captions=${removalMatches}`]),
    check('captionsFitMeasured', 'invariant', ref('captions'), captionsFitMeasured,
      [`cues=${cues.length}`, `longest-cue-characters=${longestCue}`, `preset-capacity-characters=${policies.captions.value.capacityCharacters}`,
        `burn-in-outputs=${burnedGeometries.length}`, `cues-that-do-not-fit=${cuesThatDoNotFit.length}${cuesThatDoNotFit[0] ? `:first=${cuesThatDoNotFit[0].cueId}@${cuesThatDoNotFit[0].variantId}` : ''}`]),
    check('timelineContinuous', 'invariant', null, timelineContinuous,
      [`clips=${clips.length}`, `duration-frames=${input.plan.durationFrames}`]),
    check('sourceRightsCertain', 'invariant', null, rightsPassed, [rightsSummary]),
  ])
  const narrativeIntegrity = requestHonored && movementOk && openingOk && forbiddenSpeechAbsent && timelineContinuous
  const legibility = captionsFitMeasured
  // The structured call to action is the story block where the call is spoken, or the visual overlay the plan draws for it.
  const structuredCta = input.storyPlan.blocks.some((block) =>
    block.role === 'cta' && block.content.ctaId === input.desiredActionRef.id) ||
    input.plan.overlayTracks.some((track) => track.kind === 'cta' && track.desiredActionRef.id === input.desiredActionRef.id)
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
    ...(input.speechLanguage ? { language: input.speechLanguage } : {}),
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
    ['segment', 'context', 'argument', 'proof'].includes(block.role))
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
        `edit-plan:${input.plan.id}:forbidden-speech-absent=${forbiddenSpeechAbsent}`,
        `edit-plan:${input.plan.id}:timeline-continuous=${timelineContinuous}`,
      ]],
      legibility: [legibility ? 100 : 0, [
        `edit-plan:${input.plan.id}:subtitle-fit-measured=${captionsFitMeasured}:text-only`,
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
    // Only the criteria the request asked to be judged on are scored (the resolution names the others, and the weights are renormalized).
    evidence: effectiveRubricCriteria(rubric, policies.rubric.value.notRequested).map((criterion) => scoreFor(criterion.id)),
    notRequested: policies.rubric.value.notRequested,
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
  const blocked = !strategic.passed || decisionBlocked || hardChecks.some((item) => !item.passed)
  return Object.freeze({
    schemaVersion: 'director-quality-report/v5' as const,
    id: input.id,
    desiredActionRef: input.desiredActionRef,
    status: blocked ? 'blocked' as const : 'review-required' as const,
    faceSafety: Object.freeze({ status: 'unknown' as const, reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: Object.freeze([] as string[]) }),
    score: strategic.score / 100,
    strategic,
    hardChecks,
    issues,
    perceptionEvidence: input.perceptionEvidence,
    requestHash: input.resolution.requestHash,
    policyResolutionHash: input.resolution.policyResolutionHash,
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
    // Fail closed: a context that does not state the speech the project asked to remove must not be read as "nothing was asked".
    if (!Array.isArray(context.requestedSpeechRemovals)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Director context does not state the speech the project asked to remove')
    }
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
    // The spoken call is recognised by the words of the language of the speech (the observed transcript), never by a list of one language.
    // The undetermined language is no language: it is the report of a provider that could not tell (ADR-160), not a value to write captions in.
    const reportedLanguage = typeof context.transcript.language === 'string' ? context.transcript.language.trim() : ''
    const transcriptLanguage = reportedLanguage.toLowerCase() === 'und' ? '' : reportedLanguage
    const ctaObservation = observeSpokenCta({
      action: desiredAction, spokenText: context.editPlan.retimedTranscript.words.map((word) => word.text).join(' '),
      ...(transcriptLanguage ? { language: transcriptLanguage } : {}),
    })
    // `not-evaluable` stops at the resolution below (a question to the requester); until then it is not taken for presence.
    const ctaPresent = ctaObservation.state === 'present' || ctaObservation.state === 'not-required'
    const fpsOfPlan = context.editPlan.fps
    const spokenCta = locateSpokenCta({
      action: desiredAction, ...(transcriptLanguage ? { language: transcriptLanguage } : {}), fps: fpsOfPlan,
      words: context.editPlan.retimedTranscript.words, clips,
    })
    const desiredActionRef = createDesiredActionReference(desiredAction)
    // ADR-160. Nothing below is fixed: the editorial request of the brief this run leaves behind (and the speech its Commands asked to
    // remove) resolves to the policies the plan is made from. A request the Apollo cannot execute, or a question it left open, stops here.
    const requestedRemovalIds = context.requestedSpeechRemovals.map((rule) => rule.id)
    const editorialRequest = deriveEditorialRequestFromBrief({ ...context.brief, objective: objective.id, desiredAction }, requestedRemovalIds)
    // A briefing with text that nobody has interpreted is a request nobody read: refused here, never planned over as if it were empty.
    assertBriefingInterpreted(editorialRequest)
    const resolution = resolveEditorialPolicies(editorialRequest, {
      transcriptId: context.transcript.id, ...(transcriptLanguage ? { transcriptLanguage, transcriptLanguageBasis: context.transcript.languageBasis ?? 'declared-not-verified' as const } : {}),
      ...(context.project.locale ? { declaredLocale: context.project.locale } : {}),
      hasSelectedInsert,
      ...(subtitleStyleOverrideOf(context.policies) ? { subtitleStyleOverride: subtitleStyleOverrideOf(context.policies)! } : {}),
      ...(spokenCta ? { spokenCta: { startSeconds: spokenCta.startSeconds, endSeconds: spokenCta.endSeconds } } : {}),
      timelineDurationSeconds: Math.round(context.editPlan.durationFrames / fpsOfPlan * 1_000) / 1_000,
      ...(closingSentenceStartSecondsOf(context.editPlan.retimedTranscript.words, fpsOfPlan) !== undefined
        ? { closingSentenceStartSeconds: closingSentenceStartSecondsOf(context.editPlan.retimedTranscript.words, fpsOfPlan)! } : {}),
      selectedInsertCount: clips.filter((clip) => clip.sourceArtifactId !== context.transcript.sourceArtifactId).length,
      ...(context.sourceDimensions ? { sourceAspectRatio: `${context.sourceDimensions.width}:${context.sourceDimensions.height}` } : {}),
      ...(firstSentenceEndSecondsOf(context.editPlan.retimedTranscript.words, context.editPlan.fps) !== undefined
        ? { firstSentenceEndSeconds: firstSentenceEndSecondsOf(context.editPlan.retimedTranscript.words, context.editPlan.fps)! } : {}),
    }, outputsOfState(context.parent.state.document.entries))
    assertResolutionPlannable(resolution)
    const { policies } = resolution
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
        // ADR-160 F5: the budgets come from the resolution (what the request allowed, what the timeline already holds), not from numbers of the planner.
        maxPatternBreaksPer30s: policies.budget.value.maxPatternBreaksPer30s,
        forbiddenEffects: TREATMENT_EFFECTS.filter((effect) => !policies.budget.value.allowedEffects.includes(effect)),
        maxProofItems: policies.budget.value.maxProofItems,
        maxCtaOccurrences: policies.budget.value.maxCtaOccurrences,
        // A bound of the log itself, not an editorial choice.
        maxDecisions: 12,
        proofRequired: treatmentRubric.criteria.some((criterion) => criterion.id === 'proof-strength' && criterion.weight >= .15) && policies.budget.value.maxProofItems >= 1,
        ctaRequired: policies.cta.value.required,
        ctaPlacement: 'at-observed-call' as const,
      },
      perception: {
        summaryId: perception.summary.id,
        schemaVersion: 1,
        summaryHash: calculateVersionHash(perception.summary),
        confidence: perception.summary.confidence,
        speakerCoverage: perception.summary.speechCoverage,
        // Measured, not declared: the mean adjacent-frame change the perception snapshot recorded over the timeline (0 where nothing was measured: the
        // snapshot's own coverage says whether the kind was examined).
        visualVariety: measuredVisualVariety(perception.timeline.observations),
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
      ...(spokenCta ? { ctaClipId: spokenCta.clipId } : {}),
      policies,
      clips,
      fps: context.editPlan.fps,
      durationFrames: context.editPlan.durationFrames,
    })
    const indexOf = transcriptWordIndexer(context.transcript.words)
    const generatedSubtitleCues = buildSubtitleCues({
      words: context.editPlan.retimedTranscript.words,
      durationFrames: context.editPlan.durationFrames,
      fps: context.editPlan.fps,
      captions: policies.captions.value,
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
      projectPolicyRef: context.currentVersion.snapshotRefs.policies,
      resolution,
      hasSelectedInsert,
      ...(briefCompilation
        ? { briefCompilationRef: briefCompilation.audit.outputHash }
        : {}),
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
      type: policies.transitions.value.type,
      audioFadeMs: policies.transitions.value.audioFadeMs,
      reason: policies.transitions.reason,
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
      overlayTracks: desiredAction.visualCta && policies.ctaOverlay.value.mode === 'window'
        ? Object.freeze([Object.freeze({
            id: `overlay-${desiredActionRef.id}`,
            kind: 'cta' as const,
            desiredActionRef,
            startFrame: Math.min(context.editPlan.durationFrames - 1, Math.round(context.editPlan.fps * policies.ctaOverlay.value.startSeconds)),
            endFrame: Math.min(context.editPlan.durationFrames, Math.max(Math.round(context.editPlan.fps * policies.ctaOverlay.value.endSeconds), Math.round(context.editPlan.fps * policies.ctaOverlay.value.startSeconds) + 1)),
            text: desiredAction.visualCta,
          })])
        : Object.freeze([]),
      subtitleTracks: Object.freeze([Object.freeze({
        id: captionTrackId(policies.language), kind: 'captions' as const, presetId: policies.captions.value.presetId,
        anchor: policies.captions.value.anchor, faceProtection: true as const, maxLines: policies.captions.value.maxLines,
        maxCharactersPerBlock: policies.captions.value.capacityCharacters, cues: subtitleCues,
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
      composition: compositionUnderPolicy(policies.layout),
      director: Object.freeze({ plannerVersion: PROJECT_DIRECTOR_PLANNER_VERSION, decisions, assumptions }),
      movementPolicy: planMovementPolicyUnder(policies, context.editPlan.fps),
      subtitlePolicy: Object.freeze({ faceProtection: true as const, anchor: policies.captions.value.anchor, maxCharactersPerBlock: policies.captions.value.capacityCharacters }),
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
      requestedSpeechRemovals: context.requestedSpeechRemovals,
      resolution,
      ...(transcriptLanguage ? { speechLanguage: transcriptLanguage } : {}),
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
          context.requestedSpeechRemovals),
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
    const proposedPolicySnapshotId = dependencies.createId('project-snapshot')
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
    // The request the brief now states is the request the run sealed: one reader, so the admission that recomputes it cannot disagree.
    assertDomain(
      deriveEditorialRequestFromBrief(compiledBrief ?? context.brief, requestedRemovalIds).requestHash === editorialRequest.requestHash,
      'PERSISTENCE_CONFLICT', 'The editorial request of the resulting brief is not the request the run was planned from',
    )
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
        snapshot({ id: proposedQualitySnapshotId, workspaceId, projectId, kind: 'quality-report', contentSchemaVersion: 5, value: qualityReport, createdAt }),
        snapshot({ id: proposedPolicySnapshotId, workspaceId, projectId, kind: 'policy-resolution', contentSchemaVersion: POLICY_RESOLUTION_SNAPSHOT_SCHEMA_VERSION, value: resolution, createdAt }),
      ])
      const snapshots = bindDirectorSnapshotIdentities(candidates, await resolveSnapshots(candidates))
      const byKind = new Map(snapshots.map((item) => [item.kind, item.id]))
      const perceptionSnapshotId = byKind.get('perception')!
      const treatmentSnapshotId = byKind.get('treatment')!
      const storySnapshotId = byKind.get('story')!
      const editPlanSnapshotId = byKind.get('edit-plan')!
      const qualitySnapshotId = byKind.get('quality-report')!
      const policySnapshotId = byKind.get('policy-resolution')!
      const snapshotRefs = Object.freeze({
        brief: briefSnapshotId,
        perception: perceptionSnapshotId,
        treatment: treatmentSnapshotId,
        story: storySnapshotId,
        editPlan: editPlanSnapshotId,
        quality: qualitySnapshotId,
        policyResolution: policySnapshotId,
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
        requestHash: editorialRequest.requestHash, policyResolution: resolution,
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
