import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import { planRequiredSourceWindows, projectTimelineSpansToSource, type RequiredSourceWindow } from '../domain/face-evidence-time-map.ts'
import type { FaceProducerEnvelopeV3 } from '../domain/face-producer-envelope-v3.ts'
import { collectFaceSourceEvidenceStream } from '../domain/face-source-evidence-stream.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import { maximumReframeCrop, reframeViewportIsWholeFrame } from '../domain/reframe-plan.ts'
import { buildVariantReframePlanRecord, type VariantReframePlanRecordV1 } from '../domain/variant-reframe-plan.ts'
import type { FaceSourceWindowEvidenceReader } from './ports/face-source-window-evidence-reader.ts'
import type { StoredVariantReframePlan, VariantReframePlanRepository } from './ports/variant-reframe-plan-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
/** Source frames asked of the window store at a time: 100 windows of at most 300 frames, inside its row limit. */
const READ_BLOCK_FRAMES = 30_000
const WINDOW_LIST_LIMIT = 200

/** What a caller learns about one persisted record. The raw observations stay in the store; their address and counts are here. */
export function presentVariantReframePlan(stored: Readonly<StoredVariantReframePlan>) {
  const record = stored.record
  return Object.freeze({
    planRecordId: stored.id,
    sequence: stored.sequence,
    recordHash: record.recordHash,
    disposition: record.disposition,
    dispositionCodes: record.dispositionCodes,
    policy: record.policy,
    binding: Object.freeze({
      outputSpecRevisionId: record.binding.outputSpecRevisionId, specHash: record.binding.specHash, aspectRatio: record.binding.aspectRatio,
      clipMapHash: record.binding.clipMapHash, timeline: record.binding.timeline, canvas: record.binding.canvas,
    }),
    roi: record.observationSet.roi,
    evidence: Object.freeze(record.observationSet.evidence.map((stream) => Object.freeze({
      id: stream.id, streamHash: stream.streamHash, policySha256: stream.policySha256,
      trustedWindowCount: stream.trustedEnvelopeHashes.length, untrustedWindows: stream.untrusted,
    }))),
    observationSetHash: record.observationSet.contentHash,
    observationCount: record.observationSet.observations.length,
    unknownRangeCount: record.observationSet.unknownRanges.length,
    serverPlanHash: record.serverPlan.planHash,
    finalPlanHash: record.finalPlan.planHash,
    overrides: record.overrides,
    issues: record.issues,
    renderPlan: record.renderPlan,
  })
}

export function planProjectReframeService(dependencies: {
  plans: VariantReframePlanRepository
  /** Reads the sealed face windows of a source. Absent: no evidence exists and a crop that could hide a subject is not decided. */
  faceEvidence?: FaceSourceWindowEvidenceReader
  clock?: () => Date
}) {
  return async function planProjectReframe(input: Readonly<{
    workspaceId: string
    projectId: string
    baseVersionId: string
    /** The STABLE output variant of the sealed State. An aspect ratio is not a variant. */
    variantId: string
  }>) {
    for (const [field, value] of Object.entries({ workspaceId: input.workspaceId, projectId: input.projectId, baseVersionId: input.baseVersionId, variantId: input.variantId })) {
      assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
    }
    const context = await dependencies.plans.readContext({ workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Reframe project was not found')
    assertDomain(context.version.id === input.baseVersionId, 'VERSION_CONFLICT', 'Reframe base version is stale')
    const now = (dependencies.clock ?? (() => new Date()))()
    const aspectRatio: OutputAspectRatio = context.spec.aspectRatio
    const viewport = maximumReframeCrop(aspectRatio, context.source.width, context.source.height)
    const needsEvidence = !reframeViewportIsWholeFrame(viewport)

    const sourceDurationFrames = Math.max(...context.clips.map((clip) => clip.sourceOutFrame))
    const envelopes = new Map<string, FaceProducerEnvelopeV3>()
    if (dependencies.faceEvidence) {
      for (const clip of context.clips) {
        for (let from = Math.max(0, clip.sourceInFrame); from < clip.sourceOutFrame; from += READ_BLOCK_FRAMES) {
          const stored = await dependencies.faceEvidence.listSourceWindows({
            workspaceId: input.workspaceId, projectId: input.projectId, sourceArtifactId: context.source.artifactId,
            fromSourceFrame: from, toSourceFrame: Math.min(clip.sourceOutFrame, from + READ_BLOCK_FRAMES), now, limit: WINDOW_LIST_LIMIT,
          })
          for (const item of stored) envelopes.set(item.envelope.envelopeHash, item.envelope)
        }
      }
    }
    const stream = collectFaceSourceEvidenceStream([...envelopes.values()], {
      workspaceId: input.workspaceId, sourceArtifactId: context.source.artifactId, sourceSha256: context.source.sha256,
      sourceFps: { num: context.timeline.fps, den: 1 }, sourceDurationFrames,
    })
    if (needsEvidence && stream.trustedWindows.length === 0) {
      // Nothing authenticated says where the subject is, so no crop is decided: the variant waits for evidence, and the windows that
      // would let it be planned are listed (requesting them is the Director's job, not the planner's).
      const spans = projectTimelineSpansToSource(context.clips, context.source.artifactId, [{ startFrame: 0, endFrame: context.timeline.durationFrames }])
      const required: readonly RequiredSourceWindow[] = spans.length
        ? planRequiredSourceWindows({ sourceDurationFrames, fps: { num: context.timeline.fps, den: 1 }, spans }) : []
      return Object.freeze({
        schemaVersion: 'reframe-plan-request-result/v3' as const,
        status: 'review-required' as const,
        plan: null,
        reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' as const,
        baseVersionId: input.baseVersionId,
        variantId: input.variantId,
        format: aspectRatio,
        requiredFaceWindows: Object.freeze([Object.freeze({ sourceArtifactId: context.source.artifactId, windows: Object.freeze([...required]) })]),
        replayed: false,
      })
    }
    const record: Readonly<VariantReframePlanRecordV1> = buildVariantReframePlanRecord({
      workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId,
      spec: context.spec, timeline: context.timeline, source: context.source, clips: context.clips, stream, overrideHeads: context.overrideHeads,
    })
    const { stored, replayed } = await dependencies.plans.persistOrReplay({
      id: variantReframePlanRowId({ projectVersionId: context.version.id, variantId: input.variantId, recordHash: record.recordHash }), workspaceId: input.workspaceId, projectId: input.projectId,
      projectVersionId: context.version.id, variantId: input.variantId, record, createdAt: now.toISOString(),
    })
    return Object.freeze({
      schemaVersion: 'reframe-plan-request-result/v3' as const,
      status: stored.record.disposition,
      plan: presentVariantReframePlan(stored),
      reasonCode: null,
      baseVersionId: input.baseVersionId,
      variantId: input.variantId,
      format: aspectRatio,
      requiredFaceWindows: Object.freeze([]),
      replayed,
    })
  }
}

/** The row id of a persisted record is the address of what it holds for this Version and variant: replaying it is the same row. */
export function variantReframePlanRowId(input: Readonly<{ projectVersionId: string; variantId: string; recordHash: string }>): string {
  return `variant-reframe-plan-${calculateCanonicalHash(input).slice(0, 48)}`
}

/** Reads the latest persisted record of one output variant of one Version (the head Version unless one is named). It plans nothing. */
export function readVariantReframePlanService(dependencies: { plans: VariantReframePlanRepository }) {
  return async (input: Readonly<{ workspaceId: string; projectId: string; variantId: string; projectVersionId?: string }>) => {
    for (const [field, value] of Object.entries({ workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId })) {
      assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
    }
    assertDomain(input.projectVersionId === undefined || ID.test(input.projectVersionId), 'INVALID_ARGUMENT', 'projectVersionId is invalid')
    // The planner's own context is read first WHICHEVER Version is named: it is what says the project exists in THIS workspace (another
    // workspace's project is not found, it does not have an empty plan) and that the variant is an exact member of the State (an aspect ratio
    // is not one). A named Version then only chooses which record of that variant is read; one that is not the project's has none.
    const context = await dependencies.plans.readContext({ workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Reframe project was not found')
    const projectVersionId = input.projectVersionId ?? context.version.id
    const stored = await dependencies.plans.readHead({ workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId, variantId: input.variantId })
    return Object.freeze({ variantId: input.variantId, projectVersionId, plan: stored ? presentVariantReframePlan(stored) : null })
  }
}
