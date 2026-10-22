import { assertDomain } from './errors.ts'
import type { PerceptionTimeline } from './perception-timeline.ts'
import type { StoryPlan } from './story-plan.ts'
import type { SubtitleAnchor, SubtitlePresetId } from './subtitle-system.ts'
import type { TreatmentPlan } from './treatment-plan.ts'
import type { ManualCropRegion } from './manual-editing.ts'
import type { DirectorRunImpactV1 } from './director-run-impact.ts'
import type { StrategicObjectiveId } from './strategic-objective.ts'
import type { DesiredActionReference } from './desired-action.ts'
import { createEditorialAudioTimelineHash } from './production-modes.ts'
import type { QualityReport as StrategicQualityReport } from './strategic-rubric.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  CONFIDENCE_BAND_POLICY_V2_SHA256,
  classifyConfidence,
  classifyConfidenceV2,
  createDecisionConfidence,
  isEvidenceGatedType,
  type ConfidenceBand,
  type ConfidenceDecisionType,
  type ConfidenceDecisionTypeV2,
  type DecisionBandPolicyRef,
  type DecisionConfidence,
} from './decision-confidence.ts'
import { parseDecisionPerceptionEvidence, requiredModalitiesFor, type DecisionPerceptionEvidence } from './director-evidence-rubric.ts'
import type { DirectorPerceptionEvidenceReport } from './director-perception-evidence.ts'
import { assertPlanHonorsResolution, type EditorialPolicyResolutionV1 } from './editorial-policy-resolution.ts'

interface RetimedTranscriptWord {
  text: string
  sourceStartSeconds: number
  sourceEndSeconds: number
  timelineStartFrame: number
  timelineEndFrame: number
}

interface DirectorSourceEditPlan {
  schemaVersion: 2
  state: 'compiled'
  id: string
  projectVersionId: string
  storyPlanId: null
  fps: number
  durationFrames: number
  sources: readonly Readonly<{ id: string; artifactId: string; kind: 'video'; durationSeconds: number }>[]
  videoTracks: readonly Readonly<{
    id: string
    kind: 'base-video'
    clips: readonly Readonly<{
      id: string
      sourceArtifactId: string
      audioSourceArtifactId?: string
      audioSourceInFrame?: number
      audioSourceOutFrame?: number
      sourceInFrame: number
      sourceOutFrame: number
      timelineInFrame: number
      timelineOutFrame: number
      rate: number
      crop?: Readonly<ManualCropRegion>
    }>[]
  }>[]
  overlayTracks: readonly never[]
  subtitleTracks: readonly never[]
  audioTracks: readonly never[]
  effectTracks: readonly never[]
  markers: readonly Readonly<{
    kind: 'editorial-cut'
    atFrame: number
    sourceStartSeconds: number
    sourceEndSeconds: number
    ruleIds: readonly string[]
  }>[]
  protectedElements: readonly never[]
  localeVariantRefs: readonly never[]
  formatVariantRefs: readonly never[]
  lineageRefs: readonly string[]
  editorial: Readonly<{
    commandType: 'remove-spoken-content' | 'source-ingest'
    exclusions: readonly unknown[]
    retainedSourceRanges: readonly Readonly<{ sourceStartSeconds: number; sourceEndSeconds: number }>[]
  }>
  retimedTranscript: Readonly<{ sourceTranscriptId: string; words: readonly Readonly<RetimedTranscriptWord>[] }>
  /** What the plan declares of its movement. Both values come from the resolved policies (`planMovementPolicyUnder`), never from a constant of the producer. */
  movementPolicy: Readonly<{ automaticZoom: boolean; protectedOpeningFrames: number }>
  /** A source plan states no caption capacity: it is a cut, and the capacity is the policy of whoever directs it. */
  subtitlePolicy: Readonly<{ faceProtection: true; anchor: 'bottom' }>
  createdAt: string
}

export type DirectorDecisionCategory =
  | 'narrative'
  | 'movement'
  | 'layout'
  | 'subtitle'
  | 'transition'
  | 'insert'
  /**
   * Which camera plays over a stretch of the timeline (F4.012, ADR-118).
   *
   * Additive: no existing decision changes category, and the entry in
   * `decisionTypeByCategory` below is what makes the category real. Choosing an
   * angle is a `cut` for confidence purposes — the same band policy a
   * transition is graded by (`decision-confidence.ts:23`), because both answer
   * "what does the viewer see at this instant?" and both are wrong in the same
   * way when they are wrong. `multicam-direction.ts` builds these decisions
   * (`toAngleDecision`) and says there that the integration phase adds the
   * category; this is that addition.
   */
  | 'angle'

export interface DirectorDecision {
  id: string
  category: DirectorDecisionCategory
  choice: string
  reason: string
  evidenceRefs: readonly string[]
  confidence: number
  decisionType: ConfidenceDecisionTypeV2
  confidenceDetail: Readonly<DecisionConfidence>
  confidenceBand: ConfidenceBand
  alternatives: readonly string[]
  /**
   * W64. The band policy that graded this decision. Absent on a decision born before the evidence rubric: it is graded by
   * `confidence-band-policy/v1` exactly as it was, and never by v2.
   */
  bandPolicy?: Readonly<DecisionBandPolicyRef>
  /**
   * W64. The evidence a crop, caption or insert decision (policy v2) stands on: the snapshot, the sealed envelopes and observations,
   * the tier per modality and the weakest of them. Present on exactly the evidence-gated decisions of a v2 run.
   */
  perceptionEvidence?: Readonly<DecisionPerceptionEvidence>
}

export type DirectorDecisionInput = Omit<
  DirectorDecision,
  'decisionType' | 'confidenceDetail' | 'confidenceBand'
>

export type DirectorPerceptionSnapshot = Readonly<{
  id: string
  timeline: Readonly<PerceptionTimeline>
  summary: Readonly<{
    id: string
    speechCoverage: number
    visualCoverage: 'absent' | 'partial' | 'complete'
    faceCoverage: 'absent' | 'partial' | 'complete'
    confidence: number
    sourceTranscriptId: string
  }>
}> & (Readonly<{ schemaVersion: 1; inputVersionId?: never; ocrEvidence?: never }> | Readonly<{
  /** Version 2 binds observed OCR samples to the Director's input version. */
  schemaVersion: 2
  inputVersionId: string
  ocrEvidence?: Readonly<{
    envelopeId: string
    envelopeHash: string
    sourceArtifactId: string
    sourceSha256: string
    timeMapHash: string
    sampledTimelineFrames: readonly number[]
    emptyTextTimelineFrames: readonly number[]
  }>
  /**
   * W63a. The server perception snapshot this timeline IS (same bytes: its `timeline` is the snapshot's), named by its content hash.
   * Absent on a run that predates it. Evidence input only: it grants no face safety and decides nothing.
   */
  serverSnapshot?: Readonly<{ schemaVersion: 'server-perception-snapshot/v1'; snapshotHash: string }>
}>)

export interface DirectedSubtitleCue {
  id: string
  startFrame: number
  endFrame: number
  text: string
  anchor: SubtitleAnchor
  /**
   * Indices (into the observed transcript's words) of the words this cue was generated from. Present only on a cue whose text
   * still is those words: an editorial cut that ends inside the cue rebuilds its text from them, so a review patch that edits the
   * text drops them.
   */
  sourceWordIndices?: readonly number[]
  /**
   * W68. The subtitle preset an operator's `style` exception draws THIS cue with. Never part of a compiled EditPlan: it is set only on
   * the render copy of the cue, from the persisted exception of the output being rendered.
   */
  presetId?: SubtitlePresetId
}

export interface DirectedTransition {
  id: string
  fromClipId: string
  toClipId: string
  atFrame: number
  type: 'straight-cut'
  audioFadeMs: number
  reason: string
}

export interface DirectedCtaOverlay {
  id: string
  kind: 'cta'
  desiredActionRef: Readonly<DesiredActionReference>
  startFrame: number
  endFrame: number
  text: string
}

export interface DirectedMusicTrack {
  id: string
  kind: 'background-music'
  artifactId: string
  analysisId: string
  analysisHash: string
  rightsSnapshotId: string
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  gainDb: number
  fadeInFrames: number
  fadeOutFrames: number
}

export interface DirectorQualityIssue {
  code: string
  severity: 'hard' | 'warning'
  category: 'technical' | 'policy' | 'integrity' | 'editorial'
  message: string
  rangeMs?: readonly [number, number]
  targetId?: string
  correctable: boolean
}

/** Fields every quality report version carries. */
export interface DirectorQualityReportBase {
  id: string
  desiredActionRef: Readonly<DesiredActionReference>
  status: 'approved' | 'approved-with-warnings' | 'review-required' | 'blocked'
  faceSafety: Readonly<{
    status: 'unknown' | 'verified'
    reasonCode: string
    evidenceRefs: readonly string[]
  }>
  score: number
  strategic: Readonly<StrategicQualityReport>
  issues: readonly Readonly<DirectorQualityIssue>[]
  criticVersion: string
  evaluatedAt: string
}

/** The fixed-name hard checks of report v3 and v4: editorial names a report of the request-driven era no longer carries. Read, never written. */
export interface DirectorLegacyHardChecks {
  openingMotionProtected: boolean
  automaticZoomDisabled: boolean
  subtitlesFaceSafe: boolean
  subtitlesBounded: boolean
  /**
   * True when none of the speech THIS project asked to remove (the rules of its `remove-spoken-content` Commands) appears in the
   * captions, and when nothing was asked (since `apollo-director-critic/v3`; earlier critics tested a fixed list). The public schema
   * is immutable per ref, so this meaning lives here and in docs/specs/09, not in the schema description.
   */
  forbiddenSpeechAbsent: boolean
  timelineContinuous: boolean
}

/**
 * One hard check of report v5. `request` checks verify that the plan honours what the request resolved to; `invariant` checks are the
 * product's own limits. `policyRef` names the policy of the sealed resolution the check is about (null: the check is about no policy).
 */
export interface DirectorHardCheck {
  id: string
  kind: 'request' | 'invariant'
  passed: boolean
  policyRef: string | null
  evidence: readonly string[]
}

/** A report born before the evidence rubric (W64): no perception evidence section. Still readable, never written. */
export interface DirectorQualityReportV3 extends DirectorQualityReportBase {
  schemaVersion: 'director-quality-report/v3'
  hardChecks: Readonly<DirectorLegacyHardChecks>
  perceptionEvidence?: undefined
}

/** W64. The report whose critic states, per modality and per crop/caption/insert decision, how much perception stood behind the plan. Read, never written. */
export interface DirectorQualityReportV4 extends DirectorQualityReportBase {
  schemaVersion: 'director-quality-report/v4'
  hardChecks: Readonly<DirectorLegacyHardChecks>
  perceptionEvidence: Readonly<DirectorPerceptionEvidenceReport>
}

/**
 * ADR-160. The report of a plan made from a sealed editorial request: it names the request (`requestHash`) and the policy resolution
 * (`policyResolutionHash`) it was judged against, and its hard checks are a list tied to those policies. Only v5 is admitted to a final export.
 */
export interface DirectorQualityReportV5 extends DirectorQualityReportBase {
  schemaVersion: 'director-quality-report/v5'
  hardChecks: readonly Readonly<DirectorHardCheck>[]
  perceptionEvidence: Readonly<DirectorPerceptionEvidenceReport>
  requestHash: string
  policyResolutionHash: string
}

export type DirectorQualityReport = DirectorQualityReportV3 | DirectorQualityReportV4 | DirectorQualityReportV5

/**
 * Validates the hard-check list of a report v5: a bounded list of uniquely named checks, each with its kind, its verdict, the policy it is
 * about (a reference of the sealed resolution, or null) and at least one line of evidence. Fail closed on anything else.
 */
export function parseDirectorHardChecks(value: unknown): readonly Readonly<DirectorHardCheck>[] {
  assertDomain(Array.isArray(value) && value.length >= 1 && value.length <= 32, 'PERSISTENCE_CONFLICT', 'Director hard checks are not a bounded non-empty list')
  const ids = new Set<string>()
  return Object.freeze((value as unknown[]).map((candidate) => {
    assertDomain(typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) &&
      Object.keys(candidate).sort().join('|') === 'evidence|id|kind|passed|policyRef', 'PERSISTENCE_CONFLICT', 'Director hard check is malformed')
    const check = candidate as Record<string, unknown>
    assertDomain(typeof check.id === 'string' && /^[A-Za-z][A-Za-z0-9]{2,63}$/.test(check.id) && !ids.has(check.id) &&
      (check.kind === 'request' || check.kind === 'invariant') && typeof check.passed === 'boolean' &&
      (check.policyRef === null || (typeof check.policyRef === 'string' && /^policy:[A-Za-z]+:[a-f0-9]{16}$/.test(check.policyRef))) &&
      Array.isArray(check.evidence) && check.evidence.length >= 1 && check.evidence.length <= 16 &&
      check.evidence.every((line) => typeof line === 'string' && line.length >= 1 && line.length <= 500),
    'PERSISTENCE_CONFLICT', 'Director hard check is invalid')
    ids.add(check.id as string)
    return Object.freeze({ id: check.id as string, kind: check.kind as 'request' | 'invariant', passed: check.passed as boolean,
      policyRef: check.policyRef as string | null, evidence: Object.freeze([...(check.evidence as string[])]) })
  }))
}

export function hasConsistentFaceSafetyClaim(value: Readonly<Record<string, unknown>>): boolean {
  const faceSafety = value.faceSafety as Record<string, unknown> | null
  const hardChecks = value.hardChecks as Record<string, unknown> | readonly unknown[] | null
  // Report v5 keeps no face-safety flag among its hard checks: the claim is the `faceSafety` object alone (a global face safety is never
  // granted by the Director; per-cue certification decides at the final).
  const listed = Array.isArray(hardChecks)
  if (!faceSafety || typeof faceSafety !== 'object' || Array.isArray(faceSafety) ||
      !hardChecks || typeof hardChecks !== 'object' ||
      Object.keys(faceSafety).sort().join('|') !== 'evidenceRefs|reasonCode|status' ||
      !['unknown', 'verified'].includes(String(faceSafety.status)) ||
      typeof faceSafety.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(faceSafety.reasonCode) ||
      !Array.isArray(faceSafety.evidenceRefs) || faceSafety.evidenceRefs.length > 128 ||
      faceSafety.evidenceRefs.some((ref) => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref)) ||
      new Set(faceSafety.evidenceRefs).size !== faceSafety.evidenceRefs.length ||
      (!listed && typeof (hardChecks as Record<string, unknown>).subtitlesFaceSafe !== 'boolean')) return false
  const subtitlesFaceSafe = listed ? null : (hardChecks as Record<string, unknown>).subtitlesFaceSafe
  if (faceSafety.status === 'unknown') {
    return faceSafety.evidenceRefs.length === 0 && (listed || subtitlesFaceSafe === false) &&
      ['review-required', 'blocked'].includes(String(value.status))
  }
  return faceSafety.evidenceRefs.length > 0 && (listed || subtitlesFaceSafe === true) &&
    ['approved', 'approved-with-warnings', 'blocked'].includes(String(value.status))
}

export type DirectedEditPlan = Omit<DirectorSourceEditPlan, 'storyPlanId' | 'overlayTracks' | 'subtitleTracks' | 'audioTracks' | 'effectTracks' | 'subtitlePolicy'> & Readonly<{
  storyPlanId: string
  treatmentPlanId: string
  directorRunId: string
  audioTimelineHash: string
  desiredActionRef: Readonly<DesiredActionReference>
  overlayTracks: readonly Readonly<DirectedCtaOverlay>[]
  subtitleTracks: readonly Readonly<{
    /** Present when the cues carry the transcript words they were generated from (the same shape as the ingest cue track). */
    schemaVersion?: 'source-transcript-cue-track/v1'
    sourceTranscriptId?: string
    sourceTranscriptHash?: string
    id: string
    kind: 'captions'
    presetId: SubtitlePresetId
    anchor: SubtitleAnchor
    faceProtection: true
    maxLines: number
    maxCharactersPerBlock: number
    desiredActionRef: Readonly<DesiredActionReference>
    cues: readonly Readonly<DirectedSubtitleCue>[]
  }>[]
  effectTracks: readonly never[]
  audioTracks: readonly Readonly<DirectedMusicTrack>[]
  transitions: readonly Readonly<DirectedTransition>[]
  composition: Readonly<{
    layout: 'landscape-inset'
    background: 'blurred-source'
    foregroundScale: 1
    verticalPosition: 0.5
    faceSafeFallback: readonly [number, number, number, number]
    subtitleSafeRegion: readonly [number, number, number, number]
  }>
  director: Readonly<{
    plannerVersion: string
    decisions: readonly Readonly<DirectorDecision>[]
    assumptions: readonly string[]
  }>
  subtitlePolicy: Readonly<{
    faceProtection: true
    anchor: 'bottom'
    maxCharactersPerBlock: number
  }>
}>

export interface DirectorRun {
  schemaVersion: 2
  id: string
  workspaceId: string
  projectId: string
  commandId: string
  baseVersionId: string
  resultVersionId: string
  status: 'planned' | 'rendering' | 'succeeded' | 'failed'
  plannerVersion: string
  criticVersion: string
  objective: StrategicObjectiveId
  objectiveVersion: number
  rubricRef: string
  supersedesRunId?: string
  perception: Readonly<DirectorPerceptionSnapshot>
  treatmentPlan: Readonly<TreatmentPlan> & Readonly<{ id: string }>
  storyPlan: Readonly<StoryPlan> & Readonly<{ id: string }>
  editPlan: Readonly<DirectedEditPlan>
  qualityReport: Readonly<DirectorQualityReport>
  /** ADR-160. The hash of the editorial request this run was made for (absent on a run born before it) and the sealed resolution of its policies. */
  requestHash?: string
  policyResolution?: Readonly<EditorialPolicyResolutionV1>
  decisions: readonly Readonly<DirectorDecision>[]
  assumptions: readonly string[]
  initiatedBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}

export interface RunDirectorCommandPayload {
  schemaVersion: 3
  directorRunId: string
  previousObjective: StrategicObjectiveId
  objective: StrategicObjectiveId
  objectiveVersion: number
  rubricRef: string
  supersedesRunId?: string
  plannerVersion: string
  criticVersion: string
  sourceTranscriptId: string
  sourceArtifactId: string
  snapshotRefs: Readonly<{
    brief: string
    perception: string
    treatment: string
    story: string
    editPlan: string
    quality: string
    /** ADR-160. The snapshot of the sealed policy resolution; absent on a run born before it. */
    policyResolution?: string
  }>
  impact: Readonly<DirectorRunImpactV1>
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)
}

const decisionTypeByCategory: Readonly<Record<DirectorDecisionCategory, ConfidenceDecisionType>> = Object.freeze({
  narrative: 'narrative-reorder',
  movement: 'generation',
  layout: 'generation',
  subtitle: 'transcription',
  transition: 'cut',
  insert: 'asset-selection',
  angle: 'cut',
})

/**
 * `confidence-band-policy/v2` (W64): the layout decision IS the crop decision, the subtitle decision IS the caption decision and the
 * insert decision becomes an evidence-gated insert, each graded on (tier, confidence). Every other category keeps its v1 type.
 */
const decisionTypeByCategoryV2: Readonly<Record<DirectorDecisionCategory, ConfidenceDecisionTypeV2>> = Object.freeze({
  ...decisionTypeByCategory,
  layout: 'crop',
  subtitle: 'caption',
  insert: 'insert',
})

export function decisionTypeFor(category: DirectorDecisionCategory, bandPolicyV2: boolean): ConfidenceDecisionTypeV2 {
  return (bandPolicyV2 ? decisionTypeByCategoryV2 : decisionTypeByCategory)[category]
}

export function validateDirectorDecisions(
  input: readonly (DirectorDecisionInput | DirectorDecision)[],
): readonly Readonly<DirectorDecision>[] {
  assertDomain(input.length >= 4 && input.length <= 64, 'INVALID_COMMAND', 'Director decisions must be bounded and complete')
  const ids = new Set<string>()
  for (const decision of input) {
    assertDomain(validId(decision.id) && !ids.has(decision.id), 'INVALID_COMMAND', 'Director decision identity is invalid')
    ids.add(decision.id)
    assertDomain(decision.choice.trim().length > 0 && decision.reason.trim().length > 0, 'INVALID_COMMAND', 'Director decision needs a choice and reason')
    assertDomain(decision.evidenceRefs.length > 0, 'INVALID_COMMAND', 'Director decision needs evidence')
    assertDomain(decision.confidence >= 0 && decision.confidence <= 1, 'INVALID_COMMAND', 'Director decision confidence is invalid')
  }
  return Object.freeze(input.map((decision) => {
    const evidenceRefs = Object.freeze([...decision.evidenceRefs])
    const weight = 1 / evidenceRefs.length
    const confidenceDetail = createDecisionConfidence({
      value: decision.confidence,
      evidence: evidenceRefs.map((ref, index) => Object.freeze({
        ref,
        weight: index === evidenceRefs.length - 1
          ? 1 - weight * (evidenceRefs.length - 1)
          : weight,
      })),
      reasonCodes: [`DIRECTOR_${decision.category.toUpperCase()}`],
      calibrationVersion: 'director-confidence-2026-08-v1',
    })
    const persisted = decision as Partial<DirectorDecision>
    // W64. A decision graded by policy v2 says so; one that does not is graded by v1, exactly as it always was.
    const bandPolicy = persisted.bandPolicy
    const v2 = bandPolicy !== undefined
    assertDomain(
      !v2 || (bandPolicy.schemaVersion === 'confidence-band-policy/v2' && bandPolicy.policyHash === CONFIDENCE_BAND_POLICY_V2_SHA256 &&
        Object.keys(bandPolicy).sort().join('|') === 'policyHash|schemaVersion'),
      'PERSISTENCE_CONFLICT',
      'Director decision was graded by a band policy this build does not know',
    )
    const decisionType = decisionTypeFor(decision.category, v2)
    let perceptionEvidence: DecisionPerceptionEvidence | undefined
    let confidenceBand: ConfidenceBand
    if (v2 && isEvidenceGatedType(decisionType)) {
      assertDomain(persisted.perceptionEvidence !== undefined, 'PERSISTENCE_CONFLICT', 'An evidence-gated Director decision carries no perception evidence')
      perceptionEvidence = parseDecisionPerceptionEvidence(persisted.perceptionEvidence)
      assertDomain(
        perceptionEvidence.decisionId === decision.id && perceptionEvidence.decisionType === decisionType &&
          evidenceRefs.includes(perceptionEvidence.snapshot.id),
        'PERSISTENCE_CONFLICT',
        'Director decision perception evidence is not about this decision or does not name its snapshot as evidence',
      )
      // Exactly what the rubric demands of this decision: an insert that proposes footage stands on rights, one that proposes none on nothing.
      const demanded = requiredModalitiesFor(decisionType, decision.choice === 'use_selected_insert')
      assertDomain(
        perceptionEvidence.required.length === demanded.length && demanded.every((modality, index) => modality === perceptionEvidence!.required[index]),
        'PERSISTENCE_CONFLICT',
        'Director decision perception evidence does not require what the rubric demands of the decision',
      )
      confidenceBand = classifyConfidenceV2(decisionType, confidenceDetail, perceptionEvidence.tier)
    } else {
      assertDomain(persisted.perceptionEvidence === undefined, 'PERSISTENCE_CONFLICT', 'A Director decision that is not evidence-gated carries perception evidence')
      confidenceBand = v2
        ? classifyConfidenceV2(decisionType, confidenceDetail)
        : classifyConfidence(decisionType as ConfidenceDecisionType, confidenceDetail)
    }
    const hasPersistedConfidence = persisted.decisionType !== undefined ||
      persisted.confidenceDetail !== undefined || persisted.confidenceBand !== undefined
    if (hasPersistedConfidence) {
      const storedConfidence = persisted.confidenceDetail
        ? createDecisionConfidence(persisted.confidenceDetail)
        : undefined
      assertDomain(
        persisted.decisionType === decisionType &&
          persisted.confidenceBand === confidenceBand &&
          storedConfidence !== undefined &&
          storedConfidence.confidenceHash === persisted.confidenceDetail?.confidenceHash &&
          storedConfidence.confidenceHash === confidenceDetail.confidenceHash,
        'PERSISTENCE_CONFLICT',
        'Stored Director decision confidence is inconsistent',
      )
    }
    return Object.freeze({
      ...decision,
      decisionType,
      confidenceDetail,
      confidenceBand,
      evidenceRefs,
      alternatives: Object.freeze([...decision.alternatives]),
      ...(perceptionEvidence ? { perceptionEvidence } : {}),
    })
  }))
}

export function validateDirectedEditPlan(plan: DirectedEditPlan): Readonly<DirectedEditPlan> {
  assertDomain(plan.schemaVersion === 2 && plan.state === 'compiled', 'INVALID_RENDER_INPUT', 'Director EditPlan must be compiled')
  assertDomain(plan.storyPlanId.trim().length > 0 && plan.treatmentPlanId.trim().length > 0 && plan.directorRunId.trim().length > 0, 'INVALID_RENDER_INPUT', 'Director EditPlan references are incomplete')
  assertDomain(
    plan.desiredActionRef.schemaVersion === 'desired-action-ref/v1' &&
      plan.desiredActionRef.actionHash === calculateCanonicalHash(plan.desiredActionRef.action) &&
      plan.desiredActionRef.id === `desired-action-${plan.desiredActionRef.actionHash.slice(0, 24)}` &&
      plan.subtitleTracks.every((track) => track.desiredActionRef.id === plan.desiredActionRef.id) &&
      plan.overlayTracks.every((track) => track.desiredActionRef.id === plan.desiredActionRef.id),
    'INVALID_RENDER_INPUT',
    'Director consumers do not share the canonical desired action reference',
  )
  // The renderer executes no effect: a plan that declares one is not a plan it can render. What the plan must honour beyond that is its resolution (assertPlanHonorsResolution).
  assertPlanHonorsResolution(plan, null)
  const clips = plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  assertDomain(clips.length > 0, 'INVALID_RENDER_INPUT', 'Director EditPlan needs source clips')
  assertDomain(plan.audioTimelineHash === createDirectedAudioTimelineHash({ fps: plan.fps, clips, musicTracks: plan.audioTracks ?? [] }), 'INVALID_RENDER_INPUT', 'Director audio timeline hash is inconsistent')
  let cursor = 0
  for (const clip of clips) {
    assertDomain(clip.timelineInFrame === cursor && clip.timelineOutFrame > clip.timelineInFrame, 'INVALID_RENDER_INPUT', 'Director timeline is not continuous')
    cursor = clip.timelineOutFrame
  }
  assertDomain(cursor === plan.durationFrames, 'INVALID_RENDER_INPUT', 'Director timeline duration is inconsistent')
  assertDomain(plan.transitions.length === Math.max(0, clips.length - 1), 'INVALID_RENDER_INPUT', 'Every editorial seam needs an explicit transition decision')
  const cues = plan.subtitleTracks.flatMap((track) => track.cues)
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]!
    assertDomain(cue.startFrame >= 0 && cue.endFrame > cue.startFrame && cue.endFrame <= plan.durationFrames, 'INVALID_RENDER_INPUT', 'Subtitle cue timing is invalid')
    assertDomain(cue.text.trim().length > 0 && cue.text.length <= plan.subtitlePolicy.maxCharactersPerBlock, 'INVALID_RENDER_INPUT', 'Subtitle cue text is outside policy')
    assertDomain(cue.anchor === 'bottom', 'INVALID_RENDER_INPUT', 'Subtitle cue must use the reserved bottom anchor pending face review')
    if (index > 0) assertDomain(cue.startFrame >= cues[index - 1]!.endFrame, 'INVALID_RENDER_INPUT', 'Subtitle cues cannot overlap')
  }
  for (const overlay of plan.overlayTracks) {
    assertDomain(
      overlay.kind === 'cta' && overlay.text.trim().length > 0 &&
        overlay.startFrame >= 0 && overlay.endFrame > overlay.startFrame &&
        overlay.endFrame <= plan.durationFrames,
      'INVALID_RENDER_INPUT',
      'Desired action overlay is invalid',
    )
  }
  const musicTracks = Array.isArray(plan.audioTracks) ? plan.audioTracks : []
  assertDomain(musicTracks.length <= 1, 'INVALID_RENDER_INPUT', 'Director EditPlan supports at most one background music track')
  for (const track of musicTracks) assertDomain(
    track.kind === 'background-music' && typeof track.artifactId === 'string' && track.artifactId.trim().length > 0 && typeof track.analysisHash === 'string' && /^[a-f0-9]{64}$/.test(track.analysisHash) &&
    typeof track.rightsSnapshotId === 'string' && track.rightsSnapshotId.trim().length > 0 && Number.isSafeInteger(track.sourceInFrame) && Number.isSafeInteger(track.sourceOutFrame) &&
    Number.isSafeInteger(track.timelineInFrame) && Number.isSafeInteger(track.timelineOutFrame) && track.sourceInFrame >= 0 &&
    track.sourceOutFrame > track.sourceInFrame && track.timelineInFrame === 0 && track.timelineOutFrame === plan.durationFrames &&
    track.sourceOutFrame - track.sourceInFrame >= plan.durationFrames && Number.isFinite(track.gainDb) && track.gainDb <= -12 && track.gainDb >= -60 &&
    Number.isSafeInteger(track.fadeInFrames) && Number.isSafeInteger(track.fadeOutFrames) && track.fadeInFrames >= 0 && track.fadeOutFrames >= 0,
    'INVALID_RENDER_INPUT',
    'Background music track is invalid or may mask speech',
  )
  return Object.freeze(plan)
}

export function createDirectedAudioTimelineHash(input: { fps: number; clips: readonly Readonly<DirectorSourceEditPlan['videoTracks'][number]['clips'][number]>[]; musicTracks: readonly Readonly<DirectedMusicTrack>[] }): string {
  const speechHash = createEditorialAudioTimelineHash({ fps: input.fps, clips: input.clips })
  if (input.musicTracks.length === 0) return speechHash
  return calculateCanonicalHash({ schemaVersion: 'directed-audio-timeline/v1', speechHash, musicTracks: input.musicTracks })
}

export function retimedWordsDurationMs(words: readonly RetimedTranscriptWord[], fps: number): number {
  const lastFrame = words.reduce((maximum, word) => Math.max(maximum, word.timelineEndFrame), 0)
  return Math.round(lastFrame / fps * 1000)
}
