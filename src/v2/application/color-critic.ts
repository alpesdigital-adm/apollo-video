import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  COLOR_CRITIC_CORRECTABLE_DIMENSIONS,
  COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
  evaluateColorCritic,
  type ColorCriticCreativeIntent,
  type ColorCriticPolicy,
  type ColorCriticReport,
  type ColorCriticSubject,
} from '../domain/color-critic-report.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { MulticamMatchPlan } from '../domain/multicam-match-plan.ts'
import type {
  ColorCriticEvaluator,
  ColorCriticEvidenceCrop,
  ColorCriticSourceRef,
  ColorCriticSubjectClip,
} from './ports/color-critic-evaluator.ts'
import type { ColorCriticReportRepository } from './ports/color-critic-report-repository.ts'
import type { MulticamMatchPlanRepository } from './ports/multicam-match-plan-repository.ts'
import type { ProxyQualityIssue } from './render-workflow.ts'

/**
 * The colour critic, wired to the gate it exists for (F4.014 / FR-184).
 *
 * The domain judges two sets of measurements against versioned thresholds and
 * returns a cause and an action. Everything that makes it a product is here:
 *
 * - **The bytes that were judged are not declared.** They are the render's own
 *   sources and its own delivered file; the "before" side is the same colour
 *   chain re-run with the `output` stage disabled, because the renderer keeps
 *   no intermediate. A caller cannot point the critic at a different file and
 *   collect a verdict about it.
 * - **The creative intent is read off the pipeline, not off the request.** A
 *   look is declared by an enabled `creative-lut` stage, and the only thing a
 *   caller may state is how much cast that look is allowed to introduce —
 *   which the domain then bounds by `maxDeclaredCastAllowance`, so declaring a
 *   large enough allowance cannot turn a defect into an intent.
 * - **The correction budget is counted, not claimed.** How many bounded
 *   corrections this project version has already had is read from the stored
 *   reports. The loop cannot be reopened by a caller sending zero.
 * - **The verdict reaches the gate.** `reject` becomes a hard issue on the
 *   `ProxyReview` that names the report, which keeps `finalAllowed` false;
 *   `human-review` and `bounded-correction` become warnings, which do not block
 *   but must be acknowledged through the existing append-only capability.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function id(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

/** The gate issue codes, so a route, a UI and a test all spell them the same way. */
export const COLOR_CRITIC_PROXY_ISSUE_CODES = Object.freeze({
  reject: 'COLOR_CRITIC_REJECTED',
  'human-review': 'COLOR_CRITIC_HUMAN_REVIEW',
  'bounded-correction': 'COLOR_CRITIC_BOUNDED_CORRECTION',
  approve: 'COLOR_CRITIC_APPROVED',
} as const)

/**
 * Turn a verdict into proxy-review issues.
 *
 * A rejection localizes one hard issue per blocking finding — the report
 * already refuses to reject without at least one — and every issue names the
 * report, so the reason survives into a review a person reads weeks later. A
 * `human-review` verdict is a warning: it does not block the final export, and
 * it cannot be cleared by silence either, because a warning holds the proxy in
 * `warning-ack-required` until somebody acknowledges it.
 *
 * `approve` produces nothing. There is deliberately no "approved" issue: an
 * empty list is what a clean render looks like everywhere else in this review,
 * and inventing a green issue would make "no issues" ambiguous.
 */
export function colorCriticProxyIssues(input: {
  report: Readonly<ColorCriticReport>
  fps: number
  evidence?: readonly Readonly<ColorCriticEvidenceCrop>[]
}): readonly Readonly<ProxyQualityIssue>[] {
  const { report } = input
  if (report.action === 'approve') return Object.freeze([])
  const severity: ProxyQualityIssue['severity'] = report.action === 'reject' ? 'hard' : 'warning'
  const code = COLOR_CRITIC_PROXY_ISSUE_CODES[report.action]
  const correctable = new Set<string>(COLOR_CRITIC_CORRECTABLE_DIMENSIONS)
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 0
  const cropRefs = (input.evidence ?? []).map((crop) => `color-crop:${crop.artifactKey}@${crop.sha256}`)
  const reportRef = `color-critic-report:${report.reportId}@${report.reportHash}`
  // A rejection points at its blocking findings; anything else points at the
  // findings that made a human necessary, and failing that at the verdict
  // itself — an action with no issue behind it would be unexplainable.
  const relevant = report.action === 'reject'
    ? report.issues.filter((issue) => issue.severity === 'hard')
    : report.issues
  if (relevant.length === 0) {
    return Object.freeze([Object.freeze({
      code,
      severity,
      category: 'technical' as const,
      message: `Colour critic verdict ${report.action} (${report.cause}) on report ${report.reportId}.`,
      correctable: report.action !== 'reject',
      evidenceIds: Object.freeze([reportRef, ...cropRefs]),
    })])
  }
  return Object.freeze(relevant.map((issue) => Object.freeze({
    code,
    severity,
    category: 'technical' as const,
    message: `${issue.code}: ${issue.dimension} ${issue.classification} (${issue.cause}) measured ${issue.measured === null ? 'nothing readable' : issue.measured} against ${issue.threshold === null ? 'no threshold' : issue.threshold} of ${issue.thresholdVersion}.`,
    ...(issue.cameraId ? { targetId: issue.cameraId } : {}),
    ...(issue.range && fps > 0
      ? {
          rangeMs: Object.freeze([
            Math.round(Number(issue.range.start) / fps * 1_000),
            Math.round(Number(issue.range.end) / fps * 1_000),
          ] as [number, number]),
        }
      : {}),
    correctable: correctable.has(issue.dimension),
    evidenceIds: Object.freeze([
      reportRef,
      ...cropRefs.filter((ref) => issue.cameraId === null || ref.includes(issue.cameraId)),
      ...issue.evidenceRefs,
    ]),
  })))
}

/**
 * Turn what the proxy worker already holds into what the critic needs.
 *
 * The worker knows the clips, the materialized source paths and the resolved
 * pipeline of every target; the critic wants those three joined. Doing the join
 * here rather than in the worker keeps the rule visible: a clip is judged
 * against the pipeline the render actually applied to it, found by the same key
 * the renderer used (`ffmpeg-editorial-proxy-renderer.ts:505-512`), not by a
 * pipeline chosen for it afterwards.
 *
 * A clip with no `cameraId` is dropped, not defaulted. Attributing an unlabelled
 * shot to some camera would put one camera's frames in another camera's verdict.
 */
export function colorCriticRenderInputs(input: {
  clips: readonly Readonly<{
    id: string
    sourceArtifactId: string
    cameraId?: string
    sourceInFrame: number
    sourceOutFrame: number
    timelineInFrame: number
    timelineOutFrame: number
  }>[]
  sources: readonly Readonly<{ artifactId: string; path: string; sha256: string; mediaType: string }>[]
  /** Compiled ColorPlan targets, when the render was driven by a ColorPlan. */
  compiledTargets?: readonly Readonly<ColorCriticSourceRef['pipeline']>[]
  /** The per-source trusted compilation pipeline, when it was not. */
  compilationPipelines?: ReadonlyMap<string, Readonly<ColorCriticSourceRef['pipeline']>>
}): Readonly<{
  clips: readonly Readonly<ColorCriticSubjectClip>[]
  sources: readonly Readonly<ColorCriticSourceRef>[]
}> {
  const targetsByKey = new Map(
    (input.compiledTargets ?? []).map((target) => [canonicalTargetKey(target.target), target]),
  )
  const pathByArtifact = new Map(
    input.sources.filter((source) => source.mediaType === 'video').map((source) => [source.artifactId, source]),
  )
  const clips: ColorCriticSubjectClip[] = []
  const sources = new Map<string, ColorCriticSourceRef>()
  for (const clip of input.clips) {
    if (!clip.cameraId) continue
    const asset = pathByArtifact.get(clip.sourceArtifactId)
    if (!asset) continue
    const pipeline = targetsByKey.get(canonicalTargetKey({
      sourceId: clip.sourceArtifactId.trim().toLowerCase(),
      cameraId: clip.cameraId.trim().toLowerCase(),
      segmentId: clip.id.trim().toLowerCase(),
    })) ?? input.compilationPipelines?.get(clip.sourceArtifactId)
    if (!pipeline) continue
    clips.push(Object.freeze({
      clipId: clip.id,
      cameraId: clip.cameraId,
      sourceArtifactId: clip.sourceArtifactId,
      sourceInFrame: clip.sourceInFrame,
      sourceOutFrame: clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame,
      timelineOutFrame: clip.timelineOutFrame,
    }))
    if (!sources.has(clip.sourceArtifactId)) {
      sources.set(clip.sourceArtifactId, Object.freeze({
        artifactId: asset.artifactId,
        path: asset.path,
        sha256: asset.sha256,
        pipeline,
      }))
    }
  }
  return Object.freeze({ clips: Object.freeze(clips), sources: Object.freeze([...sources.values()]) })
}

function canonicalTargetKey(target: Readonly<{ sourceId?: string; cameraId?: string; segmentId?: string }>): string {
  return calculateCanonicalHash({
    ...(target.sourceId ? { sourceId: target.sourceId } : {}),
    ...(target.cameraId ? { cameraId: target.cameraId } : {}),
    ...(target.segmentId ? { segmentId: target.segmentId } : {}),
  })
}

export interface EvaluateColorCriticRequest {
  workspaceId: string
  projectId: string
  projectVersionId: string
  /** The rendered file under judgement. Its bytes are the "after" side. */
  deliveredArtifactId: string
  deliveredPath: string
  deliveredSha256: string
  operationId: string
  fps: number
  clips: readonly Readonly<ColorCriticSubjectClip>[]
  sources: readonly Readonly<ColorCriticSourceRef>[]
  lutPaths?: Readonly<Record<string, string>>
  sessionId?: string
  /**
   * How much cast the declared look may introduce. The only number a caller
   * contributes, and the domain bounds it: a bigger allowance than the policy
   * ceiling is refused rather than believed.
   */
  castAllowedDelta?: number
  brandColorsDeclared?: boolean
  policy?: Partial<ColorCriticPolicy>
  signal?: AbortSignal
}

export interface EvaluateColorCriticResult {
  readonly report: Readonly<ColorCriticReport>
  readonly replayed: boolean
  readonly evidence: readonly Readonly<ColorCriticEvidenceCrop>[]
  readonly proxyIssues: readonly Readonly<ProxyQualityIssue>[]
  /** How many bounded corrections this project version had already had. */
  readonly correctionsApplied: number
  readonly correctionBudgetExhausted: boolean
}

/**
 * The creative intent this render actually carries.
 *
 * Read off the resolved pipelines rather than off the request: a look is an
 * enabled `creative-lut` stage bound to an immutable LUT artifact, and that is
 * a fact about the bytes that were rendered. A request that claimed a look the
 * pipeline does not apply would be asking for the cast budget of a grade that
 * was never applied.
 */
function creativeIntentOf(
  sources: readonly Readonly<ColorCriticSourceRef>[],
  declaredAllowance: number | undefined,
  brandColorsDeclared: boolean | undefined,
): Readonly<ColorCriticCreativeIntent> {
  const luts = sources.flatMap((source) => {
    const stage = source.pipeline.stages.find((candidate) => candidate.kind === 'creative-lut')
    return stage && stage.enabled && stage.lut ? [stage.lut.artifactId] : []
  })
  const declared = luts.length > 0
  return Object.freeze({
    declared,
    // An allowance without a look is a budget for a grade nobody applied, so it
    // is dropped rather than honoured.
    ...(declared && declaredAllowance !== undefined ? { castAllowedDelta: declaredAllowance } : {}),
    ...(declared ? { lutId: [...new Set(luts)].sort()[0]! } : {}),
    ...(brandColorsDeclared !== undefined ? { brandColorsDeclared } : {}),
  })
}

export function evaluateColorCriticService(dependencies: {
  evaluator: ColorCriticEvaluator
  reports: ColorCriticReportRepository
  matchPlans?: Pick<MulticamMatchPlanRepository, 'readHead'>
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function evaluate(request: EvaluateColorCriticRequest): Promise<Readonly<EvaluateColorCriticResult>> {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const projectVersionId = id(request.projectVersionId, 'projectVersionId')
    const deliveredArtifactId = id(request.deliveredArtifactId, 'deliveredArtifactId')
    assertDomain(
      Array.isArray(request.clips) && request.clips.length > 0,
      'INVALID_ARGUMENT',
      'A colour critic run needs at least one clip to attribute the delivered frames to a camera',
    )
    assertDomain(
      Number.isFinite(request.fps) && request.fps > 0,
      'INVALID_ARGUMENT',
      'A colour critic run needs the frame rate the timeline was rendered at',
    )

    // The budget is counted from the record, not taken from the request: a
    // caller that could send `0` could reopen a loop this repository exists to
    // keep closed.
    const previous = await dependencies.reports.listForProjectVersion({
      workspaceId, projectId, projectVersionId, limit: 50,
    })
    const correctionsApplied = previous.filter((report) => report.action === 'bounded-correction').length

    let matchPlan: Readonly<MulticamMatchPlan> | undefined
    if (request.sessionId && dependencies.matchPlans) {
      const head = await dependencies.matchPlans.readHead({
        workspaceId, projectId, sessionId: id(request.sessionId, 'sessionId'),
      })
      matchPlan = head?.plan
    }

    const measured = await dependencies.evaluator.measureStages({
      workspaceId,
      operationId: request.operationId,
      fps: request.fps,
      clips: request.clips,
      sources: request.sources,
      deliveredPath: request.deliveredPath,
      deliveredArtifactId,
      deliveredSha256: request.deliveredSha256,
      ...(request.lutPaths ? { lutPaths: request.lutPaths } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    })
    if (measured.before.length === 0 || measured.after.length === 0) {
      throw new DomainError(
        'COLOR_MEASUREMENT_INSUFFICIENT',
        'Neither side of the output transform could be measured; a verdict about the delivered colour has no evidence behind it',
        { before: measured.before.length, after: measured.after.length },
      )
    }

    const evaluatedAt = clock().toISOString()
    const subject: Readonly<ColorCriticSubject> = Object.freeze({
      kind: 'output' as const,
      artifactId: deliveredArtifactId,
    })
    const report = evaluateColorCritic({
      // Content-addressed: the same bytes judged against the same thresholds
      // are the same report, which is why the repository can collapse a re-run
      // into a replay instead of minting a second verdict.
      reportId: `ccr-${createHash('sha256')
        .update(`${workspaceId}|${projectVersionId}|${deliveredArtifactId}|${request.deliveredSha256}|${correctionsApplied}`)
        .digest('hex')
        .slice(0, 32)}`,
      workspaceId,
      projectId,
      projectVersionId,
      subject,
      before: measured.before,
      after: measured.after,
      ...(matchPlan ? { matchPlan } : {}),
      creativeIntent: creativeIntentOf(request.sources, request.castAllowedDelta, request.brandColorsDeclared),
      correctionsApplied,
      ...(request.policy ? { policy: request.policy } : {}),
      evaluatedAt,
    })
    const persisted = await dependencies.reports.persist({ report, createdAt: evaluatedAt })
    return Object.freeze({
      report: persisted.report,
      replayed: persisted.replayed,
      evidence: measured.evidence,
      proxyIssues: colorCriticProxyIssues({ report: persisted.report, fps: request.fps, evidence: measured.evidence }),
      correctionsApplied,
      correctionBudgetExhausted: correctionsApplied >= COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
    })
  }
}
