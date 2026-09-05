import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  COLOR_CRITIC_CORRECTABLE_DIMENSIONS,
  COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
  evaluateColorCritic,
  type ColorCriticCreativeIntent,
  type ColorCriticDimension,
  type ColorCriticIssue,
  type ColorCriticPolicy,
  type ColorCriticReport,
  type ColorCriticSeverity,
  type ColorCriticSubject,
} from '../domain/color-critic-report.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { MulticamMatchPlan } from '../domain/multicam-match-plan.ts'
import {
  colorCriticSourceKey,
  type ColorCriticEvaluator,
  type ColorCriticEvidenceCrop,
  type ColorCriticSourceRef,
  type ColorCriticSubjectClip,
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
  const evidence = input.evidence ?? []
  const cropRef = (crop: Readonly<ColorCriticEvidenceCrop>) => `color-crop:${crop.artifactKey}@${crop.sha256}`
  const cropRefs = evidence.map(cropRef)
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
    // The crops of the camera the issue is about, matched on the crop's own
    // `cameraId` rather than on the shape of its storage key — a key that
    // happened to contain the camera name would otherwise be the only reason
    // the right picture reached the right issue.
    evidenceIds: Object.freeze([
      reportRef,
      ...evidence.filter((crop) => issue.cameraId === null || crop.cameraId === issue.cameraId).map(cropRef),
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
 * The source refs are keyed by (artifact × pipelineHash), the same key the
 * renderer's colour pre-pass dedups its executions by
 * (`ffmpeg-editorial-proxy-renderer.ts:527-552`). One ref per artifact would be
 * a lie the moment a per-segment override gives two clips of one camera
 * different chains: the "before" side would then be produced by a chain that was
 * never applied to the clip the report names.
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
      pipelineHash: pipeline.pipelineHash,
      sourceInFrame: clip.sourceInFrame,
      sourceOutFrame: clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame,
      timelineOutFrame: clip.timelineOutFrame,
    }))
    const key = colorCriticSourceKey(clip.sourceArtifactId, pipeline.pipelineHash)
    if (!sources.has(key)) {
      sources.set(key, Object.freeze({
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
 * The verdict was reached and could not be written down.
 *
 * It carries the report it could not persist, because losing a computed
 * rejection to a database hiccup is how a blocked export becomes an
 * acknowledgeable warning: the frames were judged, and saying they were not
 * would be false. The gate reads `proxyIssues` off this error and reports the
 * verdict it actually has; the missing row is a second, separate problem.
 */
export class ColorCriticVerdictNotRecordedError extends DomainError {
  readonly report: Readonly<ColorCriticReport>
  readonly proxyIssues: readonly Readonly<ProxyQualityIssue>[]

  constructor(input: {
    report: Readonly<ColorCriticReport>
    proxyIssues: readonly Readonly<ProxyQualityIssue>[]
    cause: unknown
  }) {
    super(
      'PERSISTENCE_CONFLICT',
      `The colour critic judged this render ${input.report.action} (${input.report.cause}) and could not record the verdict`,
      {
        reportId: input.report.reportId,
        action: input.report.action,
        cause: input.report.cause,
        persistenceError: input.cause instanceof DomainError ? input.cause.code : 'unknown',
      },
    )
    this.name = 'ColorCriticVerdictNotRecordedError'
    this.report = input.report
    this.proxyIssues = Object.freeze([...input.proxyIssues])
  }
}

/**
 * Whether a stored match plan is a plan ABOUT these frames.
 *
 * A project can hold several capture sessions, and the head of the wrong one is
 * a reference camera nobody approved for this render. A plan qualifies only when
 * it knows every camera the delivered timeline cuts to — its reference plus the
 * cameras it corrects.
 */
export function matchPlanCoversCameras(
  plan: Readonly<MulticamMatchPlan>,
  cameraIds: readonly string[],
): boolean {
  const known = new Set<string>([
    plan.referenceCameraId,
    ...plan.cameraTransforms.map((entry) => entry.cameraId),
  ])
  return cameraIds.length > 0 && cameraIds.every((cameraId) => known.has(cameraId))
}

/**
 * Which of a project's capture sessions shaped this render's colour.
 *
 * Exactly one candidate must know every camera the render cut to. Zero means no
 * plan describes these frames; more than one means the evidence cannot say which
 * did, and picking either would put a reference camera nobody chose behind every
 * cross-camera number in the report. Both answers are `null`, and `null` makes
 * the critic report the comparison as unavailable rather than guessing.
 */
export function selectRenderMatchPlan<T extends { readonly plan: Readonly<MulticamMatchPlan> }>(input: {
  cameraIds: readonly string[]
  candidates: readonly T[]
}): T | null {
  const covering = input.candidates.filter((candidate) => matchPlanCoversCameras(candidate.plan, input.cameraIds))
  return covering.length === 1 ? covering[0]! : null
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

    // The reference camera comes from a match plan or it does not come at all.
    // A head that does not know every camera these frames were cut from is a
    // plan about another session's cameras, and measuring this render's
    // exposure against it would answer with a reference nobody approved here.
    const judgedCameraIds = [...new Set(request.clips.map((clip) => clip.cameraId))].sort()
    let matchPlan: Readonly<MulticamMatchPlan> | undefined
    if (request.sessionId && dependencies.matchPlans) {
      const head = await dependencies.matchPlans.readHead({
        workspaceId, projectId, sessionId: id(request.sessionId, 'sessionId'),
      })
      matchPlan = head && matchPlanCoversCameras(head.plan, judgedCameraIds) ? head.plan : undefined
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
    // The verdict exists before the row does. If the row cannot be written the
    // verdict is still what it is, so it leaves inside the failure rather than
    // being discarded — a rejection lost to a deadlock would otherwise reach the
    // gate as "this render's colour was not judged", which is false, and which a
    // person can acknowledge away.
    let persisted: Awaited<ReturnType<ColorCriticReportRepository['persist']>>
    try {
      persisted = await dependencies.reports.persist({ report, createdAt: evaluatedAt })
    } catch (error) {
      throw new ColorCriticVerdictNotRecordedError({
        report,
        proxyIssues: colorCriticProxyIssues({ report, fps: request.fps, evidence: measured.evidence }),
        cause: error,
      })
    }
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const COLOR_CRITIC_LISTING_MAX = 100

/**
 * The verdicts recorded about one project version, newest evaluation first.
 *
 * A list rather than "the latest": a project version can have been judged
 * several times — a rejection, a bounded correction, the re-judgement after it —
 * and the sequence is what shows whether the loop closed or ran out of budget.
 */
export function listColorCriticReportsService(dependencies: {
  reports: Pick<ColorCriticReportRepository, 'listForProjectVersion'>
}) {
  return async function list(input: Readonly<{
    workspaceId: string
    projectId: string
    projectVersionId: string
    limit?: number
  }>): Promise<Readonly<{
    reports: readonly Readonly<ColorCriticReport>[]
    correctionsApplied: number
    correctionBudgetExhausted: boolean
  }>> {
    const limit = input.limit ?? 25
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= COLOR_CRITIC_LISTING_MAX,
      'INVALID_ARGUMENT',
      `limit must be between 1 and ${COLOR_CRITIC_LISTING_MAX}`,
    )
    const reports = await dependencies.reports.listForProjectVersion({
      workspaceId: id(input.workspaceId, 'workspaceId'),
      projectId: id(input.projectId, 'projectId'),
      projectVersionId: id(input.projectVersionId, 'projectVersionId'),
      limit,
    })
    // Counted here the same way `evaluate` counts it, off the same rows: how
    // many bounded corrections a version has already had is what decides
    // whether another one is allowed, and a reader deciding what to do next
    // needs the same number the evaluator will use.
    const correctionsApplied = reports.filter((report) => report.action === 'bounded-correction').length
    return Object.freeze({
      reports,
      correctionsApplied,
      correctionBudgetExhausted: correctionsApplied >= COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
    })
  }
}

export function readColorCriticReportService(dependencies: {
  reports: Pick<ColorCriticReportRepository, 'read'>
}) {
  return async function read(input: Readonly<{
    workspaceId: string
    reportId: string
  }>): Promise<Readonly<ColorCriticReport>> {
    const report = await dependencies.reports.read({
      workspaceId: id(input.workspaceId, 'workspaceId'),
      reportId: id(input.reportId, 'reportId'),
    })
    if (!report) {
      throw new DomainError(
        'COLOR_CRITIC_REPORT_NOT_FOUND',
        `Colour critic report ${input.reportId} was not found`,
      )
    }
    return report
  }
}

export interface ColorCriticIssueListing {
  readonly reportId: string
  readonly projectId: string
  readonly projectVersionId: string
  readonly action: ColorCriticReport['action']
  readonly cause: ColorCriticReport['cause']
  readonly referenceCameraId: string | null
  readonly matchPlanId: string | null
  readonly evaluatedAt: string
  readonly reportHash: string
  readonly issues: readonly Readonly<ColorCriticIssue>[]
  /** Issues the filter excluded, so a narrowed list never reads as a clean one. */
  readonly filteredOut: number
}

/**
 * The issues of one verdict, each with the evidence it was reached over.
 *
 * The filters narrow what is shown and the count of what they removed travels
 * with the answer: a reader who asked for hard issues and got none has to be
 * able to tell that from a report with no issues at all.
 */
export function listColorCriticIssuesService(dependencies: {
  reports: Pick<ColorCriticReportRepository, 'read'>
}) {
  const read = readColorCriticReportService(dependencies)
  return async function list(input: Readonly<{
    workspaceId: string
    reportId: string
    severity?: ColorCriticSeverity
    dimension?: ColorCriticDimension
  }>): Promise<Readonly<ColorCriticIssueListing>> {
    const report = await read(input)
    const issues = report.issues.filter((issue) => (
      (input.severity === undefined || issue.severity === input.severity)
      && (input.dimension === undefined || issue.dimension === input.dimension)
    ))
    return Object.freeze({
      reportId: report.reportId,
      projectId: report.projectId,
      projectVersionId: report.projectVersionId,
      action: report.action,
      cause: report.cause,
      referenceCameraId: report.referenceCameraId,
      matchPlanId: report.matchPlanId,
      evaluatedAt: report.evaluatedAt,
      reportHash: report.reportHash,
      issues: Object.freeze(issues),
      filteredOut: report.issues.length - issues.length,
    })
  }
}
