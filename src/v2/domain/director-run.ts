import { assertDomain } from './errors.ts'
import type { PerceptionTimeline } from './perception-timeline.ts'
import type { StoryPlan } from './story-plan.ts'
import type { SubtitleAnchor, SubtitlePresetId } from './subtitle-system.ts'
import type { TreatmentPlan } from './treatment-plan.ts'

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
      sourceInFrame: number
      sourceOutFrame: number
      timelineInFrame: number
      timelineOutFrame: number
      rate: 1
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
    commandType: 'remove-spoken-content'
    exclusions: readonly unknown[]
    retainedSourceRanges: readonly Readonly<{ sourceStartSeconds: number; sourceEndSeconds: number }>[]
  }>
  retimedTranscript: Readonly<{ sourceTranscriptId: string; words: readonly Readonly<RetimedTranscriptWord>[] }>
  movementPolicy: Readonly<{ automaticZoom: false; protectedOpeningFrames: number }>
  subtitlePolicy: Readonly<{ faceProtection: true; anchor: 'bottom'; maxCharactersPerBlock: number }>
  createdAt: string
}

export type DirectorDecisionCategory =
  | 'narrative'
  | 'movement'
  | 'layout'
  | 'subtitle'
  | 'transition'
  | 'insert'

export interface DirectorDecision {
  id: string
  category: DirectorDecisionCategory
  choice: string
  reason: string
  evidenceRefs: readonly string[]
  confidence: number
  alternatives: readonly string[]
}

export interface DirectorPerceptionSnapshot {
  schemaVersion: 1
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
}

export interface DirectedSubtitleCue {
  id: string
  startFrame: number
  endFrame: number
  text: string
  anchor: SubtitleAnchor
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

export interface DirectorQualityIssue {
  code: string
  severity: 'hard' | 'warning'
  category: 'technical' | 'policy' | 'integrity' | 'editorial'
  message: string
  rangeMs?: readonly [number, number]
  targetId?: string
  correctable: boolean
}

export interface DirectorQualityReport {
  schemaVersion: 'director-quality-report/v1'
  id: string
  status: 'approved' | 'approved-with-warnings' | 'blocked'
  score: number
  hardChecks: Readonly<{
    openingMotionProtected: boolean
    automaticZoomDisabled: boolean
    subtitlesFaceSafe: boolean
    subtitlesBounded: boolean
    forbiddenSpeechAbsent: boolean
    timelineContinuous: boolean
  }>
  issues: readonly Readonly<DirectorQualityIssue>[]
  criticVersion: string
  evaluatedAt: string
}

export type DirectedEditPlan = Omit<DirectorSourceEditPlan, 'storyPlanId' | 'subtitleTracks' | 'effectTracks' | 'subtitlePolicy'> & Readonly<{
  storyPlanId: string
  treatmentPlanId: string
  directorRunId: string
  subtitleTracks: readonly Readonly<{
    id: string
    kind: 'captions'
    presetId: SubtitlePresetId
    anchor: SubtitleAnchor
    faceProtection: true
    maxLines: 2
    maxCharactersPerBlock: number
    cues: readonly Readonly<DirectedSubtitleCue>[]
  }>[]
  effectTracks: readonly never[]
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
  schemaVersion: 1
  id: string
  workspaceId: string
  projectId: string
  commandId: string
  baseVersionId: string
  resultVersionId: string
  status: 'planned' | 'rendering' | 'succeeded' | 'failed'
  plannerVersion: string
  criticVersion: string
  perception: Readonly<DirectorPerceptionSnapshot>
  treatmentPlan: Readonly<TreatmentPlan> & Readonly<{ id: string }>
  storyPlan: Readonly<StoryPlan> & Readonly<{ id: string }>
  editPlan: Readonly<DirectedEditPlan>
  qualityReport: Readonly<DirectorQualityReport>
  decisions: readonly Readonly<DirectorDecision>[]
  assumptions: readonly string[]
  initiatedBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}

export interface RunDirectorCommandPayload {
  schemaVersion: 1
  directorRunId: string
  plannerVersion: string
  criticVersion: string
  sourceTranscriptId: string
  sourceArtifactId: string
  snapshotRefs: Readonly<{
    perception: string
    treatment: string
    story: string
    editPlan: string
    quality: string
  }>
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)
}

export function validateDirectorDecisions(input: readonly DirectorDecision[]): readonly Readonly<DirectorDecision>[] {
  assertDomain(input.length >= 4 && input.length <= 64, 'INVALID_COMMAND', 'Director decisions must be bounded and complete')
  const ids = new Set<string>()
  for (const decision of input) {
    assertDomain(validId(decision.id) && !ids.has(decision.id), 'INVALID_COMMAND', 'Director decision identity is invalid')
    ids.add(decision.id)
    assertDomain(decision.choice.trim().length > 0 && decision.reason.trim().length > 0, 'INVALID_COMMAND', 'Director decision needs a choice and reason')
    assertDomain(decision.evidenceRefs.length > 0, 'INVALID_COMMAND', 'Director decision needs evidence')
    assertDomain(decision.confidence >= 0 && decision.confidence <= 1, 'INVALID_COMMAND', 'Director decision confidence is invalid')
  }
  return Object.freeze(input.map((decision) => Object.freeze({
    ...decision,
    evidenceRefs: Object.freeze([...decision.evidenceRefs]),
    alternatives: Object.freeze([...decision.alternatives]),
  })))
}

export function validateDirectedEditPlan(plan: DirectedEditPlan): Readonly<DirectedEditPlan> {
  assertDomain(plan.schemaVersion === 2 && plan.state === 'compiled', 'INVALID_RENDER_INPUT', 'Director EditPlan must be compiled')
  assertDomain(plan.storyPlanId.trim().length > 0 && plan.treatmentPlanId.trim().length > 0 && plan.directorRunId.trim().length > 0, 'INVALID_RENDER_INPUT', 'Director EditPlan references are incomplete')
  assertDomain(plan.movementPolicy.automaticZoom === false && plan.movementPolicy.protectedOpeningFrames >= Math.round(plan.fps * 4), 'INVALID_RENDER_INPUT', 'Opening motion protection is invalid')
  assertDomain(plan.effectTracks.length === 0, 'INVALID_RENDER_INPUT', 'Unjustified camera effects are forbidden')
  const clips = plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  assertDomain(clips.length > 0, 'INVALID_RENDER_INPUT', 'Director EditPlan needs source clips')
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
    assertDomain(cue.anchor === 'bottom', 'INVALID_RENDER_INPUT', 'Subtitle cue must use the face-safe fallback anchor')
    if (index > 0) assertDomain(cue.startFrame >= cues[index - 1]!.endFrame, 'INVALID_RENDER_INPUT', 'Subtitle cues cannot overlap')
  }
  return Object.freeze(plan)
}

export function retimedWordsDurationMs(words: readonly RetimedTranscriptWord[], fps: number): number {
  const lastFrame = words.reduce((maximum, word) => Math.max(maximum, word.timelineEndFrame), 0)
  return Math.round(lastFrame / fps * 1000)
}
