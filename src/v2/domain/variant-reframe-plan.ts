import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { FaceSourceEvidenceStream } from './face-source-evidence-stream.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedBounds, type NormalizedInsets, type OutputAspectRatio } from './output-spec.ts'
import { validateRenderReframePlan, type RenderReframePlanV1 } from './render-reframe-plan.ts'
import {
  createReframePlan, maximumReframeCrop, parseReframeObservationSet, reframeCriticalVisible, reframeViewportIsWholeFrame, validateReframePlan,
  type ReframeObservationSetV2, type ReframePlanIssueV2, type ReframePlanV2,
} from './reframe-plan.ts'
import {
  REFRAME_ISSUE_CODES, REFRAME_POLICY, REFRAME_POLICY_SHA256, reframeIssueDisposition, reframeVariantDisposition,
  type ReframeIssueCode, type ReframeIssueDisposition, type ReframeVariantDisposition,
} from './reframe-policy.ts'
import { projectFaceEvidenceToReframeObservations, type ReframeRoiSource } from './server-reframe-roi.ts'
import {
  reframeClipBindingHash, selectReframeOverridesForClips,
  type ReframeOverrideInactiveReason, type VariantReframeClipFactsV1, type VariantReframeOverrideV2,
} from './variant-reframe-overrides.ts'
import { buildVariantRenderReframePlan } from './variant-reframe-render-plan.ts'

/**
 * `variant-reframe-plan/v1` (W66r): the persisted, content-addressed reframe of ONE output variant of ONE ProjectVersion.
 *
 * It holds everything needed to reproduce and to audit a crop: the sealed canvas of the variant, the clips it was decided over, the
 * policy hash, the server-owned observations (with the evidence they came from), the plan the server decided on its own, the plan
 * with the editor's overrides on top, the keyframed ranges the renderer receives, and every issue with its range and evidence.
 *
 * The server plan is kept apart from the final one on purpose. A manual override produces a different final plan and the SAME
 * server plan: it can never alter the observations or the automatic decision, only sit on top of them. The record carries no
 * ProjectVersion id: the same inputs give the same record hash in any Version, and the row that binds it to a Version is the one
 * that says which.
 */
export interface VariantReframeIssueV1 {
  code: ReframeIssueCode
  severity: 'hard' | 'warning'
  disposition: ReframeIssueDisposition
  variantId: string
  aspectRatio: OutputAspectRatio
  clipId: string | null
  /** Half-open timeline frames. */
  startFrame: number
  endFrame: number
  observationIds: readonly string[]
  evidenceIds: readonly string[]
  reasonCode: string | null
}

export interface VariantReframeAppliedOverrideV1 {
  id: string
  commandId: string
  overrideHash: string
  clipId: string
  startFrame: number
  endFrame: number
  crop: Readonly<NormalizedBounds>
}
export interface VariantReframeInactiveOverrideV1 {
  id: string
  commandId: string
  overrideHash: string
  clipId: string
  startFrame: number
  endFrame: number
  reasonCode: ReframeOverrideInactiveReason
}

export interface VariantReframeBindingV1 {
  outputSpecRevisionId: string
  specHash: string
  aspectRatio: OutputAspectRatio
  safeArea: Readonly<NormalizedInsets>
  canvas: Readonly<{ width: number; height: number; fps: number }>
  timeline: Readonly<{ fps: number; durationFrames: number }>
  source: Readonly<{ artifactId: string; manifestId: string; sha256: string; width: number; height: number }>
  clips: readonly Readonly<VariantReframeClipFactsV1>[]
  clipMapHash: string
}

export interface VariantReframePlanRecordV1 {
  schemaVersion: 'variant-reframe-plan/v1'
  workspaceId: string
  projectId: string
  variantId: string
  binding: Readonly<VariantReframeBindingV1>
  policy: Readonly<{ id: string; hash: string }>
  observationSet: Readonly<ReframeObservationSetV2>
  /** What the server decided without any editor input. */
  serverPlan: Readonly<ReframePlanV2>
  /** The server plan with the applied overrides on top (the very same object when there are none). */
  finalPlan: Readonly<ReframePlanV2>
  renderPlan: Readonly<RenderReframePlanV1>
  overrides: Readonly<{ applied: readonly Readonly<VariantReframeAppliedOverrideV1>[]; inactive: readonly Readonly<VariantReframeInactiveOverrideV1>[] }>
  issues: readonly Readonly<VariantReframeIssueV1>[]
  disposition: ReframeVariantDisposition
  dispositionCodes: readonly ReframeIssueCode[]
  recordHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const MAX_ISSUES = 20_000
const MAX_EVIDENCE_PER_ISSUE = 16

export function reframeClipMapHash(timeline: Readonly<{ fps: number; durationFrames: number }>, clips: readonly Readonly<VariantReframeClipFactsV1>[]): string {
  return calculateCanonicalHash({ schemaVersion: 'variant-reframe-clip-map/v1', timeline, clips: clips.map((clip) => reframeClipBindingHash(clip)) })
}

/** The clips this Version plays of ONE source, with the facts an override and a plan are bound to. */
export type VariantReframeClip = Readonly<VariantReframeClipFactsV1 & { hasStaticCrop: boolean }>

function issueOf(plan: Readonly<ReframePlanV2>, issue: Readonly<ReframePlanIssueV2>, variantId: string, clips: readonly Readonly<VariantReframeClipFactsV1>[]): VariantReframeIssueV1 {
  const clip = clips.find((candidate) => candidate.timelineInFrame <= issue.startFrame && issue.endFrame <= candidate.timelineOutFrame)
  return Object.freeze({
    code: issue.code as ReframeIssueCode,
    severity: reframeIssueDisposition(issue.code) === 'blocked' ? 'hard' as const : 'warning' as const,
    disposition: reframeIssueDisposition(issue.code),
    variantId, aspectRatio: plan.format, clipId: clip?.clipId ?? null,
    startFrame: issue.startFrame, endFrame: issue.endFrame,
    observationIds: Object.freeze(issue.observationIds.slice(0, MAX_EVIDENCE_PER_ISSUE)),
    evidenceIds: Object.freeze(issue.evidenceIds.slice(0, MAX_EVIDENCE_PER_ISSUE)),
    reasonCode: issue.reasonCode as string | null,
  })
}

/** Adjacent issues of one cause are one localized issue: the range grows, the evidence unions (bounded). */
function mergeIssues(issues: readonly VariantReframeIssueV1[]): readonly Readonly<VariantReframeIssueV1>[] {
  const ordered = [...issues].toSorted((left, right) => left.startFrame - right.startFrame || left.code.localeCompare(right.code) || left.endFrame - right.endFrame)
  const merged: VariantReframeIssueV1[] = []
  for (const issue of ordered) {
    const previous = merged.findLast((candidate) => candidate.code === issue.code && candidate.clipId === issue.clipId && candidate.reasonCode === issue.reasonCode)
    if (previous && previous.endFrame === issue.startFrame) {
      merged[merged.indexOf(previous)] = Object.freeze({
        ...previous, endFrame: issue.endFrame,
        observationIds: Object.freeze([...new Set([...previous.observationIds, ...issue.observationIds])].slice(0, MAX_EVIDENCE_PER_ISSUE)),
        evidenceIds: Object.freeze([...new Set([...previous.evidenceIds, ...issue.evidenceIds])].toSorted().slice(0, MAX_EVIDENCE_PER_ISSUE)),
      })
    } else merged.push(issue)
  }
  return Object.freeze(merged.map((issue) => Object.freeze(issue)))
}

/**
 * Whether an editor crop hides a subject the server is sure of. A crop may lose a subject only where the server itself found that
 * no crop can show them all (`SUBJECTS_DO_NOT_FIT`): there the editor decides which one to keep.
 */
export function reframeOverrideHidesSubject(input: Readonly<{
  observationSet: Readonly<ReframeObservationSetV2>
  serverPlan: Readonly<ReframePlanV2>
  safeArea: Readonly<NormalizedInsets>
  crop: Readonly<NormalizedBounds>
  startFrame: number
  endFrame: number
}>): boolean {
  const viewport = maximumReframeCrop(input.serverPlan.format, input.observationSet.sourceWidth, input.observationSet.sourceHeight)
  if (reframeViewportIsWholeFrame(viewport)) return false
  const unfit = input.serverPlan.issues.filter((issue) => issue.code === 'SUBJECTS_DO_NOT_FIT')
  const overlapping = input.observationSet.observations.filter((item) => item.startFrame < input.endFrame && input.startFrame < item.endFrame &&
    !unfit.some((issue) => item.startFrame < issue.endFrame && issue.startFrame < item.endFrame))
  return !reframeCriticalVisible(input.crop, overlapping, input.safeArea, REFRAME_POLICY.tracking.safetyMargin)
}

export function buildVariantReframePlanRecord(input: Readonly<{
  workspaceId: string
  projectId: string
  variantId: string
  spec: Readonly<{ outputSpecRevisionId: string; specHash: string; aspectRatio: OutputAspectRatio; safeArea: Readonly<NormalizedInsets>; width: number; height: number; fps: number }>
  timeline: Readonly<{ fps: number; durationFrames: number }>
  source: Readonly<ReframeRoiSource>
  clips: readonly VariantReframeClip[]
  stream: Readonly<FaceSourceEvidenceStream>
  overrideHeads: readonly Readonly<VariantReframeOverrideV2>[]
  observationSetId: string
}>): Readonly<VariantReframePlanRecordV1> {
  assertDomain(ID.test(input.variantId) && ID.test(input.observationSetId) && OUTPUT_ASPECT_RATIOS.includes(input.spec.aspectRatio),
    'INVALID_RENDER_INPUT', 'Reframe plan identity is invalid')
  const clipFacts: readonly Readonly<VariantReframeClipFactsV1>[] = Object.freeze(input.clips.map((clip) => Object.freeze({
    clipId: clip.clipId, sourceArtifactId: clip.sourceArtifactId, sourceSha256: clip.sourceSha256, sourceWidth: clip.sourceWidth, sourceHeight: clip.sourceHeight,
    sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
    rate: clip.rate, fps: clip.fps,
  })))
  const observationSet = projectFaceEvidenceToReframeObservations({
    id: input.observationSetId, fps: input.timeline.fps, durationFrames: input.timeline.durationFrames, source: input.source, stream: input.stream,
    policy: REFRAME_POLICY,
    clips: input.clips.map((clip) => ({
      id: clip.clipId, sourceArtifactId: clip.sourceArtifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate, ...(clip.hasStaticCrop ? { crop: true } : {}),
    })),
  })
  const variant = Object.freeze({
    variantId: input.variantId, outputSpecRevisionId: input.spec.outputSpecRevisionId, specHash: input.spec.specHash,
    aspectRatio: input.spec.aspectRatio, safeArea: Object.freeze({ ...input.spec.safeArea }),
  })
  const viewport = maximumReframeCrop(input.spec.aspectRatio, input.source.width, input.source.height)
  const whole = reframeViewportIsWholeFrame(viewport)
  // Overrides: only those authored against these very clips apply, and an editor crop that would hide a subject the server is sure
  // of is reported inactive instead of silently winning (the editor sees why, and can reframe or reset).
  const selection = selectReframeOverridesForClips({ variantId: input.variantId, heads: input.overrideHeads, clips: clipFacts })
  const applied: Array<Readonly<VariantReframeOverrideV2>> = []
  const inactive: Array<{ override: Readonly<VariantReframeOverrideV2>; reasonCode: ReframeOverrideInactiveReason }> = [...selection.inactive]
  const serverPlan = createReframePlan({ format: input.spec.aspectRatio, observationSet, policy: REFRAME_POLICY, variant })
  for (const override of selection.applicable) {
    if (!whole && reframeOverrideHidesSubject({ observationSet, serverPlan, safeArea: input.spec.safeArea, crop: override.crop!, startFrame: override.startFrame, endFrame: override.endFrame })) {
      inactive.push({ override, reasonCode: 'HIDES_CRITICAL_SUBJECT' })
    } else applied.push(override)
  }
  const finalPlan = applied.length === 0 ? serverPlan : createReframePlan({
    format: input.spec.aspectRatio, observationSet, policy: REFRAME_POLICY, variant,
    overrides: applied.map((override) => ({ id: override.id, format: input.spec.aspectRatio, startFrame: override.startFrame, endFrame: override.endFrame, crop: override.crop! })),
  })
  const built = buildVariantRenderReframePlan({
    plan: finalPlan, observationSet, variantId: input.variantId, fps: input.timeline.fps, durationFrames: input.timeline.durationFrames,
    source: { width: input.source.width, height: input.source.height },
    clips: input.clips.map((clip) => ({ id: clip.clipId, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate })),
    overrides: applied.map((override) => ({ id: override.id, startFrame: override.startFrame, endFrame: override.endFrame })),
  })
  const evidenceOfRange = (startFrame: number, endFrame: number) => [...new Set(observationSet.observations
    .filter((item) => item.startFrame < endFrame && startFrame < item.endFrame).flatMap((item) => item.evidenceIds))].toSorted()
  const issues = mergeIssues([
    ...finalPlan.issues.map((issue) => issueOf(finalPlan, issue, input.variantId, clipFacts)),
    ...built.violations.map((violation): VariantReframeIssueV1 => Object.freeze({
      code: 'TRACKING_LIMIT_EXCEEDED' as const, severity: 'hard' as const, disposition: reframeIssueDisposition('TRACKING_LIMIT_EXCEEDED'),
      variantId: input.variantId, aspectRatio: input.spec.aspectRatio, clipId: violation.clipId,
      startFrame: violation.startFrame, endFrame: violation.endFrame,
      observationIds: Object.freeze(observationSet.observations.filter((item) => item.startFrame < violation.endFrame && violation.startFrame < item.endFrame).map((item) => item.id).slice(0, MAX_EVIDENCE_PER_ISSUE)),
      evidenceIds: Object.freeze(evidenceOfRange(violation.startFrame, violation.endFrame).slice(0, MAX_EVIDENCE_PER_ISSUE)),
      reasonCode: violation.reasonCode,
    })),
  ])
  const dispositionCodes = [...new Set(issues.map((issue) => issue.code))].toSorted() as ReframeIssueCode[]
  const body = Object.freeze({
    schemaVersion: 'variant-reframe-plan/v1' as const, workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId,
    binding: Object.freeze({
      outputSpecRevisionId: input.spec.outputSpecRevisionId, specHash: input.spec.specHash, aspectRatio: input.spec.aspectRatio,
      safeArea: Object.freeze({ ...input.spec.safeArea }),
      canvas: Object.freeze({ width: input.spec.width, height: input.spec.height, fps: input.spec.fps }),
      timeline: Object.freeze({ ...input.timeline }),
      source: Object.freeze({ artifactId: input.source.artifactId, manifestId: input.source.manifestId, sha256: input.source.sha256, width: input.source.width, height: input.source.height }),
      clips: clipFacts, clipMapHash: reframeClipMapHash(input.timeline, clipFacts),
    }),
    policy: Object.freeze({ id: REFRAME_POLICY.id, hash: REFRAME_POLICY_SHA256 }),
    observationSet, serverPlan, finalPlan, renderPlan: built.renderPlan,
    overrides: Object.freeze({
      applied: Object.freeze(applied.map((override) => Object.freeze({ id: override.id, commandId: override.commandId, overrideHash: override.overrideHash,
        clipId: override.clipId, startFrame: override.startFrame, endFrame: override.endFrame, crop: override.crop! }))),
      inactive: Object.freeze(inactive.map((entry) => Object.freeze({ id: entry.override.id, commandId: entry.override.commandId, overrideHash: entry.override.overrideHash,
        clipId: entry.override.clipId, startFrame: entry.override.startFrame, endFrame: entry.override.endFrame, reasonCode: entry.reasonCode }))),
    }),
    issues, disposition: reframeVariantDisposition(dispositionCodes), dispositionCodes: Object.freeze(dispositionCodes),
  })
  return Object.freeze({ ...body, recordHash: calculateCanonicalHash(body) })
}

/** Hydration: every sub-document is re-validated and the content addresses are recomputed; a hand-edited row cannot survive. */
export function parseVariantReframePlanRecord(value: unknown): Readonly<VariantReframePlanRecordV1> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_RENDER_INPUT', 'Reframe plan record must be an object')
  const record = value as VariantReframePlanRecordV1
  const keys = ['schemaVersion', 'workspaceId', 'projectId', 'variantId', 'binding', 'policy', 'observationSet', 'serverPlan', 'finalPlan', 'renderPlan', 'overrides',
    'issues', 'disposition', 'dispositionCodes', 'recordHash']
  assertDomain(Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)), 'INVALID_RENDER_INPUT', 'Reframe plan record fields are invalid')
  assertDomain(record.schemaVersion === 'variant-reframe-plan/v1', 'INVALID_RENDER_INPUT', 'Reframe plan record schema is unsupported')
  assertDomain(ID.test(record.workspaceId) && ID.test(record.projectId) && ID.test(record.variantId), 'INVALID_RENDER_INPUT', 'Reframe plan record identity is invalid')
  assertDomain(record.policy.hash === REFRAME_POLICY_SHA256 && record.policy.id === REFRAME_POLICY.id, 'INVALID_RENDER_INPUT', 'Reframe plan record is not sealed to the pinned policy')
  const observationSet = parseReframeObservationSet(record.observationSet)
  assertDomain(observationSet.schemaVersion === 'reframe-observations/v2', 'INVALID_RENDER_INPUT', 'Reframe plan record observations must be server-owned')
  validateReframePlan(record.serverPlan, observationSet)
  validateReframePlan(record.finalPlan, observationSet)
  validateRenderReframePlan(record.renderPlan)
  assertDomain(record.serverPlan.variant.variantId === record.variantId && record.finalPlan.variant.variantId === record.variantId &&
    record.renderPlan.variantId === record.variantId && record.finalPlan.format === record.binding.aspectRatio && record.renderPlan.format === record.binding.aspectRatio &&
    record.finalPlan.variant.specHash === record.binding.specHash && record.serverPlan.variant.specHash === record.binding.specHash &&
    record.finalPlan.observationSetHash === observationSet.contentHash && record.serverPlan.observationSetHash === observationSet.contentHash,
  'INVALID_RENDER_INPUT', 'Reframe plan record documents describe different variants or observations')
  assertDomain(record.overrides.applied.length > 0 || record.finalPlan.planHash === record.serverPlan.planHash, 'INVALID_RENDER_INPUT',
    'A plan without applied overrides is the server plan')
  assertDomain(record.binding.clipMapHash === reframeClipMapHash(record.binding.timeline, record.binding.clips), 'INVALID_RENDER_INPUT', 'Reframe plan clip map hash is inconsistent')
  assertDomain(record.renderPlan.durationFrames === record.binding.timeline.durationFrames && record.renderPlan.fps === record.binding.timeline.fps &&
    record.renderPlan.source.width === record.binding.source.width && record.renderPlan.source.height === record.binding.source.height,
  'INVALID_RENDER_INPUT', 'Reframe plan record timeline or source drifted from its render plan')
  assertDomain(Array.isArray(record.issues) && record.issues.length <= MAX_ISSUES && record.issues.every((issue) =>
    REFRAME_ISSUE_CODES.includes(issue.code) && issue.variantId === record.variantId && issue.disposition === reframeIssueDisposition(issue.code) &&
    issue.startFrame >= 0 && issue.endFrame > issue.startFrame && issue.endFrame <= record.binding.timeline.durationFrames &&
    issue.evidenceIds.length <= MAX_EVIDENCE_PER_ISSUE), 'INVALID_RENDER_INPUT', 'Reframe plan record issues are invalid')
  const codes = [...new Set(record.issues.map((issue) => issue.code))].toSorted()
  assertDomain(record.disposition === reframeVariantDisposition(codes) && calculateCanonicalHash(record.dispositionCodes) === calculateCanonicalHash(codes),
    'INVALID_RENDER_INPUT', 'Reframe plan record disposition does not follow from its issues')
  const { recordHash, ...body } = record
  assertDomain(/^[a-f0-9]{64}$/.test(recordHash) && recordHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Reframe plan record hash is inconsistent')
  return Object.freeze(record)
}

/** Whether a stored record still describes what a Version plays for a variant: same spec revision, same clips, same timeline. */
export function variantReframePlanFitsVersion(record: Readonly<VariantReframePlanRecordV1>, current: Readonly<{
  specHash: string; timeline: Readonly<{ fps: number; durationFrames: number }>; clips: readonly Readonly<VariantReframeClipFactsV1>[]
}>): boolean {
  return record.binding.specHash === current.specHash && record.binding.clipMapHash === reframeClipMapHash(current.timeline, current.clips)
}
