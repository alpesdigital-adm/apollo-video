import { createHash } from 'node:crypto'

import { colorCameraIdsForSession } from '../domain/camera-identity.ts'
import type { CaptureSession, CaptureTrack, CaptureTrackPart } from '../domain/capture-session.ts'
import type { ColorPlan, ColorTransform } from '../domain/color-and-export.ts'
import type { CameraColorMeasurement } from '../domain/color-measurement.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  addMulticamMatchRangeOverride,
  compileMatchPlanToColorPlanLayers,
  deriveMulticamMatchPlan,
  MATCH_PIPELINE_STAGE,
  type EditPlanClipRef,
  type MatchActor,
  type MatchAdjustParameters,
  type MulticamMatchPlan,
  type MulticamMatchPolicy,
} from '../domain/multicam-match-plan.ts'
import {
  convertTick,
  createTickInterval,
  intervalDuration,
  type TickInterval,
  type Timebase,
} from '../domain/session-time.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { CameraColorProbe, CaptureMediaPort } from './ports/camera-color-probe.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'
import type { ColorCriticReportRepository } from './ports/color-critic-report-repository.ts'
import type {
  CameraColorMeasurementRepository,
  MulticamMatchPlanRepository,
  StoredMulticamMatchPlan,
} from './ports/multicam-match-plan-repository.ts'
import type {
  ProjectColorPlanRepository,
  ProjectColorPlanResult,
} from './ports/project-color-plan-repository.ts'
import type { setProjectColorPlanService } from './project-color-plans.ts'

/**
 * Multicamera colour match, wired (F4.013 / FR-183).
 *
 * The domain knows how to turn measurements into `match`-stage transforms and
 * how to compile those into ColorPlan layers. This is the part that makes it a
 * product: it decides WHICH bytes get measured, measures them with a real
 * instrument, persists the plan on a fenced chain, and writes the resulting
 * `cameras`/`segments` layers into the project's ColorPlan through the same
 * `set-project-color-plan` command a person would use.
 *
 * Three rules shape every signature below.
 *
 * - **The caller supplies positions, never numbers.** Which session, which
 *   camera is the reference, and which two version fences it was looking at.
 *   Every delta, every confidence and every issue is derived here from decoded
 *   frames. There is no request field a caller could use to declare that a
 *   camera matches.
 * - **Two fences, both named by the caller.** The reference camera is chosen
 *   against one exact capture-session version, and the ColorPlan write lands on
 *   one exact project version. Each is `id + hash`, because a version number can
 *   be reused after a failed write and a hash cannot.
 * - **A local correction stays local.** The override service touches the
 *   `segments` layer of the clips it names and copies every sibling camera and
 *   the global layer through byte-for-byte, so a fix to one shot cannot become a
 *   grade on the programme.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

/** Roles that carry a picture a camera match can be derived from. */
export const MATCHABLE_TRACK_ROLES = Object.freeze([
  'camera-main',
  'camera-alt',
  'phone',
  'reaction',
  'screen',
  'reference-video',
] as const)

/**
 * How much of each part is decoded.
 *
 * A colour statistic saturates long before a whole recording is read: the
 * adapter subsamples at 4 Hz and the derivation weights ranges by their overlap
 * with the reference, so decoding an hour to average it into one number buys
 * nothing and costs an hour. The window is per part, from its start, and the
 * measurement records the extent it actually read — never the extent it was
 * asked about.
 */
export const DEFAULT_MEASUREMENT_WINDOW_SECONDS = 20
export const DEFAULT_MAX_RANGES_PER_CAMERA = 8

function id(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function hash(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  assertDomain(HASH.test(normalized), 'INVALID_ARGUMENT', `${field} must be a SHA-256 hash`)
  return normalized
}

function seconds(interval: Readonly<TickInterval>, timebase: Readonly<Timebase>): number {
  const ticks = intervalDuration(interval)
  return Number(ticks) * (Number(timebase.secondsPerTick.num) / Number(timebase.secondsPerTick.den))
}

/**
 * A part's own interval expressed in the session's clock, the same conversion
 * `createTrackCoverage` applies to a coverage claim (`track-coverage.ts:240-255`).
 * Rounding inwards on both ends is deliberate: a range that is measured must be
 * a range the file really covers, and widening it would attribute a neighbour's
 * frames to this camera.
 */
function partSessionRange(
  part: Readonly<CaptureTrackPart>,
  sessionTimebase: Readonly<Timebase>,
): Readonly<TickInterval> | null {
  const start = convertTick({ tick: part.coverage.start, from: part.timebase, to: sessionTimebase, rounding: 'ceil' })
  const end = convertTick({ tick: part.coverage.end, from: part.timebase, to: sessionTimebase, rounding: 'floor' })
  if (end <= start) return null
  return createTickInterval(start, end)
}

/**
 * The actor behind the reference-camera choice.
 *
 * The capability is declared `confirmation: 'human-approval'`, and this is what
 * makes that declaration true rather than decorative: a bearer credential with
 * nobody behind it cannot choose which camera every other camera is corrected
 * towards. `ui-session` is a person at a keyboard; a delegated user id is a
 * person a client is acting for. Neither is inferable from the payload, so
 * neither can be forged by one.
 */
function referenceSelector(actor: Readonly<AuthenticatedExternalActor>, workspaceId: string): Readonly<{
  selectedBy: Readonly<MatchActor>
  audit: ReturnType<typeof materializeActorAuditContext>
}> {
  requireScope(actor, 'projects:write')
  const audit = materializeActorAuditContext(actor)
  assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Multicam match actor does not belong to the workspace')
  assertDomain(
    audit.authenticationKind === 'ui-session' || audit.delegatedUserId !== undefined,
    'AUTH_INVALID',
    'The reference camera is a human decision; an unattended credential cannot make it',
  )
  return Object.freeze({
    selectedBy: Object.freeze({ kind: 'human' as const, id: id(audit.delegatedUserId ?? audit.clientId, 'actor.id') }),
    audit,
  })
}

/**
 * The EditPlan's clips, grouped by the camera key they were cut from.
 *
 * Read from the persisted ColorPlan targets — the same rows
 * `setProjectColorPlanService` validates every override key against
 * (`project-color-plans.ts:66-94`) — so the plan can only correct cameras the
 * timeline actually cuts to, and a request cannot widen that set.
 */
function editPlanClipsByCameraId(
  targets: readonly Readonly<{ sourceId: string; cameraId?: string; segmentId?: string }>[],
): Readonly<Record<string, readonly Readonly<EditPlanClipRef>[]>> {
  const byCamera = new Map<string, EditPlanClipRef[]>()
  for (const target of targets) {
    if (!target.cameraId || !target.segmentId) continue
    const clips = byCamera.get(target.cameraId) ?? []
    clips.push(Object.freeze({ clipId: target.segmentId }))
    byCamera.set(target.cameraId, clips)
  }
  return Object.freeze(Object.fromEntries(
    [...byCamera.entries()].map(([cameraId, clips]) => [cameraId, Object.freeze(clips)]),
  ))
}

/**
 * The next ColorPlan: the current one with the `match` stage of the named
 * layers replaced, and everything else copied through unchanged.
 *
 * The copy is what makes a per-camera or per-range correction local. `global`,
 * `sources`, `metadata`, `outputMetadata` and every transform of another kind
 * are carried across by reference; only the `match` entry of a key the caller's
 * work actually produced is replaced. A camera key the EditPlan no longer cuts
 * to is dropped, because `assertPlanTargets` would otherwise refuse the whole
 * write for a stale key nobody asked about.
 */
function mergeMatchLayers(input: {
  current: Readonly<ColorPlan>
  cameras: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  segments: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  knownCameraIds: ReadonlySet<string>
  knownSegmentIds: ReadonlySet<string>
  /** Layer kinds whose match entry may be removed when the new work omits it. */
  replaceCameras: boolean
}): Readonly<ColorPlan> {
  const merge = (
    existing: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>,
    incoming: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>,
    known: ReadonlySet<string>,
    replace: boolean,
  ): Readonly<Record<string, readonly Readonly<ColorTransform>[]>> => {
    const keys = [...new Set([...Object.keys(existing), ...Object.keys(incoming)])].filter((key) => known.has(key)).sort()
    const next: Record<string, readonly Readonly<ColorTransform>[]> = {}
    for (const key of keys) {
      const base = existing[key] ?? []
      const added = incoming[key] ?? []
      const others = replace || added.length > 0
        ? base.filter((transform) => transform.kind !== MATCH_PIPELINE_STAGE)
        : base
      const layer = [...others, ...added]
      if (layer.length > 0) next[key] = Object.freeze(layer)
    }
    return Object.freeze(next)
  }
  return Object.freeze({
    schemaVersion: 'color-plan/v1' as const,
    metadata: input.current.metadata,
    outputMetadata: input.current.outputMetadata,
    global: input.current.global,
    ...(input.current.sourceMetadata ? { sourceMetadata: input.current.sourceMetadata } : {}),
    ...(input.current.sources ? { sources: input.current.sources } : {}),
    cameras: merge(input.current.cameras ?? {}, input.cameras, input.knownCameraIds, input.replaceCameras),
    segments: merge(input.current.segments ?? {}, input.segments, input.knownSegmentIds, false),
  })
}

export interface MulticamMatchColorPlanWrite {
  readonly colorPlanId: string
  readonly colorPlanHash: string
  readonly compiledManifestHash: string
  readonly resultVersionId: string
  readonly replayed: boolean
  /** Cameras the plan corrected that the EditPlan does not cut to. */
  readonly omittedCameraIds: readonly string[]
}

export interface MulticamMatchInvalidation {
  readonly matchPlanIds: readonly string[]
  readonly colorCriticReportIds: readonly string[]
}

export interface DeriveMulticamMatchPlanResult {
  readonly plan: Readonly<MulticamMatchPlan>
  readonly version: number
  readonly replayed: boolean
  readonly colorPlan: Readonly<MulticamMatchColorPlanWrite>
  readonly invalidated: Readonly<MulticamMatchInvalidation>
}

interface MatchColorPlanDependencies {
  colorPlans: Pick<ProjectColorPlanRepository, 'readContext' | 'readCurrent'>
  setProjectColorPlan: ReturnType<typeof setProjectColorPlanService>
  colorPlanActorId?: string
}

/**
 * Write the compiled layers through the ColorPlan command.
 *
 * The command's author is this service — a `system` actor with a name that says
 * which service — and the human who chose the reference is named in the reason
 * beside it, never instead of it. A caller note is appended, never substituted:
 * the audit trail records who moved the colour, not only who asked.
 */
async function writeMatchLayers(
  dependencies: MatchColorPlanDependencies,
  input: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    baseHash: string
    cameras: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
    segments: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
    omittedCameraIds: readonly string[]
    replaceCameras: boolean
    idempotencyKey: string
    reason: string
    note?: string
  },
): Promise<Readonly<MulticamMatchColorPlanWrite>> {
  const context = await dependencies.colorPlans.readContext({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
  })
  if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project ColorPlan context was not found')
  const current = await dependencies.colorPlans.readCurrent({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
  })
  if (!current) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      'The project has no ColorPlan yet; a camera match is a layer inside one, not a pipeline of its own',
      { projectId: input.projectId },
    )
  }
  const plan = mergeMatchLayers({
    current: current.colorPlan.plan,
    cameras: input.cameras,
    segments: input.segments,
    knownCameraIds: new Set(context.targets.flatMap((target) => target.cameraId ? [target.cameraId] : [])),
    knownSegmentIds: new Set(context.targets.flatMap((target) => target.segmentId ? [target.segmentId] : [])),
    replaceCameras: input.replaceCameras,
  })
  const applied = await dependencies.setProjectColorPlan({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    baseVersionId: input.baseVersionId,
    baseHash: input.baseHash,
    plan,
    reason: input.note ? `${input.reason}; ${input.note}` : input.reason,
    idempotencyKey: input.idempotencyKey,
    actor: { type: 'system', id: dependencies.colorPlanActorId ?? 'apollo-multicam-color-match' },
  })
  return Object.freeze({
    colorPlanId: applied.colorPlan.id,
    colorPlanHash: applied.colorPlan.plan.planHash,
    compiledManifestHash: applied.colorPlan.compiled.manifestHash,
    resultVersionId: applied.version.id,
    replayed: applied.replayed,
    omittedCameraIds: Object.freeze([...input.omittedCameraIds]),
  })
}

/** Content-addressed plan identity: the same evidence always names the same plan. */
function derivedPlanId(input: {
  workspaceId: string
  projectId: string
  sessionId: string
  sessionVersion: number
  referenceEpoch: number
  referenceCameraId: string
  measurements: readonly Readonly<CameraColorMeasurement>[]
}): string {
  const digest = createHash('sha256')
    .update([
      input.workspaceId, input.projectId, input.sessionId,
      String(input.sessionVersion), String(input.referenceEpoch), input.referenceCameraId,
      ...[...input.measurements]
        .map((measurement) => `${measurement.measurementId}:${measurement.measurementHash}`)
        .sort(),
    ].join('|'))
    .digest('hex')
  return `mmp-${digest.slice(0, 32)}`
}

/** The evidence identity two derivations must share to be the same derivation. */
function derivationIdentity(
  measurements: readonly Readonly<CameraColorMeasurement>[],
): string {
  return [...measurements]
    .map((measurement) => `${measurement.measurementId}:${measurement.measurementHash}`)
    .sort()
    .join('|')
}

export interface DeriveMulticamMatchPlanRequest {
  workspaceId: string
  projectId: string
  sessionId: string
  /** The camera every other camera is corrected towards. A human decision. */
  referenceCameraId: string
  /** The capture-session version that human was looking at: `<sessionId>:v<n>`. */
  baseVersionId: string
  baseHash: string
  /** The project version the ColorPlan write must land on. */
  projectBaseVersionId: string
  projectBaseHash: string
  note?: string
  policy?: Partial<MulticamMatchPolicy>
  actor: Readonly<AuthenticatedExternalActor>
}

export function deriveMulticamMatchPlanService(dependencies: {
  sessions: Pick<CaptureSessionRepository, 'readHead'>
  media: CaptureMediaPort
  probe: CameraColorProbe
  measurements: CameraColorMeasurementRepository
  plans: MulticamMatchPlanRepository
  criticReports?: Pick<ColorCriticReportRepository, 'findDependentsOfMatchPlan'>
  colorPlans: Pick<ProjectColorPlanRepository, 'readContext' | 'readCurrent'>
  setProjectColorPlan: ReturnType<typeof setProjectColorPlanService>
  colorPlanActorId?: string
  clock?: () => Date
  windowSeconds?: number
  maxRangesPerCamera?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const windowSeconds = dependencies.windowSeconds ?? DEFAULT_MEASUREMENT_WINDOW_SECONDS
  const maxRanges = dependencies.maxRangesPerCamera ?? DEFAULT_MAX_RANGES_PER_CAMERA

  return async function derive(request: DeriveMulticamMatchPlanRequest): Promise<Readonly<DeriveMulticamMatchPlanResult>> {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const sessionId = id(request.sessionId, 'sessionId')
    const baseHash = hash(request.baseHash, 'baseHash')
    const projectBaseVersionId = id(request.projectBaseVersionId, 'projectBaseVersionId')
    const projectBaseHash = hash(request.projectBaseHash, 'projectBaseHash')
    const selector = referenceSelector(request.actor, workspaceId)

    const session = await dependencies.sessions.readHead({ workspaceId, sessionId })
    if (!session) throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${sessionId} was not found`)
    assertDomain(
      session.projectId === projectId,
      'INVALID_ARGUMENT',
      `Capture session ${sessionId} belongs to another project`,
    )
    // The fence is checked against the session that is current NOW, and the
    // failure carries what is current so the UI can offer a reload instead of
    // asking the operator to guess.
    if (request.baseVersionId !== `${sessionId}:v${session.version}` || baseHash !== session.sessionHash) {
      throw new DomainError(
        'CAPTURE_SESSION_VERSION_STALE',
        'The reference camera was chosen against a capture session version that is no longer current',
        { currentVersion: session.version, currentHash: session.sessionHash },
      )
    }

    const context = await dependencies.colorPlans.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project ColorPlan context was not found')
    const clipsByCamera = editPlanClipsByCameraId(context.targets)
    const cameraIdByTrack = colorCameraIdsForSession(session)
    const referenceCameraId = request.referenceCameraId.trim()
    assertDomain(
      [...cameraIdByTrack.values()].includes(referenceCameraId),
      'COLOR_REFERENCE_UNAVAILABLE',
      `No capture track of session ${sessionId} carries the camera key ${referenceCameraId}`,
      { referenceCameraId, cameras: [...new Set(cameraIdByTrack.values())].sort() },
    )

    const measurements = await measureSessionCameras({
      session,
      cameraIdByTrack,
      clipsByCamera,
      referenceCameraId,
      media: dependencies.media,
      probe: dependencies.probe,
      workspaceId,
      windowSeconds,
      maxRanges,
    })

    const head = await dependencies.plans.readHead({ workspaceId, projectId, sessionId })
    // A retry measures the same bytes and therefore produces the same
    // content-addressed measurement ids and hashes. When those, the session
    // version and the reference camera all match the head, the derivation
    // already happened: return it and do no new work, rather than minting a
    // second version that differs only in its timestamp.
    if (
      head &&
      head.plan.sessionVersion === session.version &&
      head.plan.referenceEpoch === session.referenceEpoch &&
      head.plan.referenceCameraId === referenceCameraId &&
      derivationIdentity(head.plan.measurements) === derivationIdentity(measurements)
    ) {
      const layers = compileMatchPlanToColorPlanLayers(head.plan, { editPlanClipsByCameraId: clipsByCamera })
      const colorPlan = await writeMatchLayers(dependencies, {
        workspaceId, projectId,
        baseVersionId: projectBaseVersionId, baseHash: projectBaseHash,
        cameras: layers.cameras, segments: layers.segments,
        omittedCameraIds: layers.omittedCameraIds,
        replaceCameras: true,
        idempotencyKey: `mcm-${head.plan.planHash.slice(0, 32)}`,
        reason: matchReason(head.plan, selector.selectedBy.id),
        ...(request.note ? { note: request.note } : {}),
      })
      return Object.freeze({
        plan: head.plan,
        version: head.version,
        replayed: true,
        colorPlan,
        invalidated: Object.freeze({ matchPlanIds: Object.freeze([]), colorCriticReportIds: Object.freeze([]) }),
      })
    }

    const createdAt = clock().toISOString()
    const plan = deriveMulticamMatchPlan({
      planId: derivedPlanId({
        workspaceId, projectId, sessionId,
        sessionVersion: session.version,
        referenceEpoch: session.referenceEpoch,
        referenceCameraId,
        measurements,
      }),
      workspaceId,
      projectId,
      sessionId,
      sessionVersion: session.version,
      referenceEpoch: session.referenceEpoch,
      referenceCameraId,
      referenceCameraSelection: {
        selectedBy: selector.selectedBy,
        selectedAt: createdAt,
        baseVersionId: request.baseVersionId,
        baseHash,
      },
      measurements,
      // `colorProbeIds` names the ffprobe rows a plan rests on. This path reads
      // its colourimetry out of the decoded bytes it measured, not out of a
      // `media_color_probe` row, so it cites none rather than citing something
      // it did not read.
      lineage: { colorProbeIds: [] },
      ...(request.policy ? { policy: request.policy } : {}),
      ...(head ? { supersedes: head.plan } : {}),
      createdAt,
    })

    // What a reference change makes stale, named before the write so the answer
    // is about the world the caller acted on. Only dependents: plans of this
    // session that were built against the camera that is being replaced, and
    // the critic verdicts that rested on the plan being superseded. Nothing is
    // deleted — erasing a rejection because the plan moved on would erase the
    // reason the plan moved on.
    const invalidated = head && head.plan.referenceCameraId !== referenceCameraId
      ? await collectInvalidations(dependencies, { workspaceId, sessionId, previous: head.plan })
      : Object.freeze({ matchPlanIds: Object.freeze([]), colorCriticReportIds: Object.freeze([]) })

    for (const measurement of measurements) {
      await dependencies.measurements.persist({ workspaceId, measurement, createdAt })
    }
    const appended = await dependencies.plans.appendVersion({
      plan,
      base: head ? { version: head.version, planHash: head.plan.planHash } : null,
      occurredAt: createdAt,
    })

    const layers = compileMatchPlanToColorPlanLayers(appended.stored.plan, { editPlanClipsByCameraId: clipsByCamera })
    const colorPlan = await writeMatchLayers(dependencies, {
      workspaceId, projectId,
      baseVersionId: projectBaseVersionId, baseHash: projectBaseHash,
      cameras: layers.cameras, segments: layers.segments,
      omittedCameraIds: layers.omittedCameraIds,
      replaceCameras: true,
      idempotencyKey: `mcm-${appended.stored.plan.planHash.slice(0, 32)}`,
      reason: matchReason(appended.stored.plan, selector.selectedBy.id),
      ...(request.note ? { note: request.note } : {}),
    })
    return Object.freeze({
      plan: appended.stored.plan,
      version: appended.stored.version,
      replayed: appended.replayed,
      colorPlan,
      invalidated,
    })
  }
}

function matchReason(plan: Readonly<MulticamMatchPlan>, selectedById: string): string {
  return `multicam colour match ${plan.planId} written by apollo-multicam-color-match; reference camera ${plan.referenceCameraId} chosen by ${selectedById}`
}

async function collectInvalidations(
  dependencies: {
    plans: Pick<MulticamMatchPlanRepository, 'findDependents'>
    criticReports?: Pick<ColorCriticReportRepository, 'findDependentsOfMatchPlan'>
  },
  input: { workspaceId: string; sessionId: string; previous: Readonly<MulticamMatchPlan> },
): Promise<Readonly<MulticamMatchInvalidation>> {
  const dependents = await dependencies.plans.findDependents({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    referenceCameraId: input.previous.referenceCameraId,
  })
  const reports = dependencies.criticReports
    ? await dependencies.criticReports.findDependentsOfMatchPlan({
        workspaceId: input.workspaceId,
        matchPlanId: input.previous.planId,
      })
    : []
  return Object.freeze({
    matchPlanIds: Object.freeze([...new Set(dependents.map((entry) => `${entry.sessionId}:v${entry.version}`))].sort()),
    colorCriticReportIds: Object.freeze([...new Set(reports.map((report) => report.reportId))].sort()),
  })
}

/**
 * Decode every camera the EditPlan cuts to, plus the reference.
 *
 * The ranges come from the session's own parts, converted into the session
 * clock exactly the way Wave 18 converts a coverage claim. Each part's file is
 * materialized, measured and released in a `finally`: the S3 driver downloads
 * the whole recording, so a sweep over a six-track session that forgets leaks
 * six recordings a pass, and the local driver copies nothing, which is
 * precisely why forgetting is invisible in development.
 */
async function measureSessionCameras(input: {
  session: Readonly<CaptureSession>
  cameraIdByTrack: ReadonlyMap<string, string>
  clipsByCamera: Readonly<Record<string, readonly Readonly<EditPlanClipRef>[]>>
  referenceCameraId: string
  media: CaptureMediaPort
  probe: CameraColorProbe
  workspaceId: string
  windowSeconds: number
  maxRanges: number
}): Promise<readonly Readonly<CameraColorMeasurement>[]> {
  const roles = new Set<string>(MATCHABLE_TRACK_ROLES)
  const wanted = input.session.tracks.filter((track: Readonly<CaptureTrack>) => {
    if (!roles.has(track.role)) return false
    const cameraId = input.cameraIdByTrack.get(track.trackId)
    if (cameraId === undefined) return false
    return cameraId === input.referenceCameraId || input.clipsByCamera[cameraId] !== undefined
  })
  assertDomain(
    wanted.length >= 2,
    'COLOR_RANGES_NOT_COMPARABLE',
    'A camera match needs the reference camera and at least one camera the EditPlan cuts to',
    {
      referenceCameraId: input.referenceCameraId,
      editPlanCameras: Object.keys(input.clipsByCamera).sort(),
    },
  )
  const measurements: Readonly<CameraColorMeasurement>[] = []
  for (const track of wanted) {
    const cameraId = input.cameraIdByTrack.get(track.trackId)!
    const parts = [...track.parts].sort((left, right) => left.ordinal - right.ordinal).slice(0, input.maxRanges)
    for (const part of parts) {
      // Second zero of the file is the start of the part's coverage: a part's
      // `coverage` counts the ticks that FILE covers in its own timebase, so
      // its first decodable frame and its coverage start are the same instant
      // by construction. Reading the window from the file's start and labelling
      // it with the converted coverage start is therefore one range, not two.
      const sessionRange = partSessionRange(part, input.session.clock.timebase)
      if (sessionRange === null) continue
      const partSeconds = seconds(part.coverage, part.timebase)
      const sourceEndSeconds = Math.min(partSeconds, input.windowSeconds)
      if (!(sourceEndSeconds > 0)) continue
      // The measured stretch and the session ticks it describes have to be the
      // same stretch. Clipping the session range by the same fraction the
      // window clipped the file keeps them one range instead of two.
      const measuredTicks = BigInt(Math.max(1, Math.round(
        Number(intervalDuration(sessionRange)) * (sourceEndSeconds / partSeconds),
      )))
      const measuredRange = createTickInterval(
        sessionRange.start,
        sessionRange.start + (measuredTicks < intervalDuration(sessionRange) ? measuredTicks : intervalDuration(sessionRange)),
      )
      const resolved = await input.media.resolve({ workspaceId: input.workspaceId, part })
      try {
        const produced = await input.probe.measureCameraColor({
          mediaPath: resolved.path,
          cameraId,
          sourceAssetId: part.sourceAssetId,
          sourceSha256: part.evidence.ingestSha256,
          sessionId: input.session.sessionId,
          ranges: [{ sessionRange: measuredRange, sourceStartSeconds: 0, sourceEndSeconds }],
        })
        measurements.push(...produced)
      } finally {
        await resolved.release()
      }
    }
  }
  return Object.freeze(measurements)
}

// ---------------------------------------------------------------------------
// Range overrides
// ---------------------------------------------------------------------------

export interface AddMulticamMatchRangeOverrideRequest {
  workspaceId: string
  projectId: string
  sessionId: string
  /** The match plan chain fence: the version and hash the caller was reading. */
  basePlanVersion: number
  basePlanHash: string
  /** The project version the ColorPlan write must land on. */
  projectBaseVersionId: string
  projectBaseHash: string
  override: {
    overrideId: string
    cameraId: string
    segmentId?: string
    range?: Readonly<TickInterval>
    parameters: Readonly<MatchAdjustParameters>
    reason: string
  }
  actor: Readonly<AuthenticatedExternalActor>
}

export interface AddMulticamMatchRangeOverrideResult {
  readonly plan: Readonly<MulticamMatchPlan>
  readonly version: number
  readonly replayed: boolean
  readonly colorPlan: Readonly<MulticamMatchColorPlanWrite>
}

/**
 * Apply one local correction (F4.013, ADR-127).
 *
 * The amendment is a new plan version that copies every camera transform
 * through untouched, and the ColorPlan write replaces only the `segments`
 * entries of the clips the override matched. The sibling camera layers, the
 * global layer and the source layers are the same objects that were read, so
 * "the sibling camera is byte-identical" is a property of the code rather than
 * a hope checked by a test.
 */
export function addMulticamMatchRangeOverrideService(dependencies: {
  plans: Pick<MulticamMatchPlanRepository, 'readHead' | 'appendVersion'>
  colorPlans: Pick<ProjectColorPlanRepository, 'readContext' | 'readCurrent'>
  setProjectColorPlan: ReturnType<typeof setProjectColorPlanService>
  colorPlanActorId?: string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function addOverride(
    request: AddMulticamMatchRangeOverrideRequest,
  ): Promise<Readonly<AddMulticamMatchRangeOverrideResult>> {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const sessionId = id(request.sessionId, 'sessionId')
    const basePlanHash = hash(request.basePlanHash, 'basePlanHash')
    const projectBaseVersionId = id(request.projectBaseVersionId, 'projectBaseVersionId')
    const projectBaseHash = hash(request.projectBaseHash, 'projectBaseHash')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Match override actor does not belong to the workspace')
    const actor: Readonly<MatchActor> = Object.freeze({
      kind: audit.delegatedUserId !== undefined || audit.authenticationKind === 'ui-session' ? 'human' as const : 'system' as const,
      id: id(audit.delegatedUserId ?? audit.clientId, 'actor.id'),
    })

    const head = await dependencies.plans.readHead({ workspaceId, projectId, sessionId })
    if (!head) {
      throw new DomainError('COLOR_REFERENCE_UNAVAILABLE', `No multicam match plan exists for session ${sessionId}`)
    }
    if (head.version !== request.basePlanVersion || head.plan.planHash !== basePlanHash) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'The match plan moved on before the override could be applied',
        { currentVersion: head.version, currentHash: head.plan.planHash },
      )
    }
    // A replay of the same override is the same override: the plan already
    // carries it, so nothing new is written and the stored plan is returned.
    const existing = head.plan.rangeOverrides.find((entry) => entry.overrideId === request.override.overrideId)
    const createdAt = clock().toISOString()
    const amended = existing
      ? head.plan
      : addMulticamMatchRangeOverride(head.plan, {
          planId: `${head.plan.planId}.o${head.plan.rangeOverrides.length + 1}`,
          createdAt,
          override: { ...request.override, actor },
        })
    const stored: Readonly<StoredMulticamMatchPlan> = existing
      ? head
      : (await dependencies.plans.appendVersion({
          plan: amended,
          base: { version: head.version, planHash: head.plan.planHash },
          occurredAt: createdAt,
        })).stored

    const context = await dependencies.colorPlans.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project ColorPlan context was not found')
    const layers = compileMatchPlanToColorPlanLayers(stored.plan, {
      editPlanClipsByCameraId: editPlanClipsByCameraId(context.targets),
    })
    const colorPlan = await writeMatchLayers(dependencies, {
      workspaceId, projectId,
      baseVersionId: projectBaseVersionId, baseHash: projectBaseHash,
      // The camera layers are not rewritten by an override: `replaceCameras`
      // stays false, so a camera whose transform this plan did not change keeps
      // the exact transform object the current ColorPlan already holds.
      cameras: {}, segments: layers.segments,
      omittedCameraIds: layers.omittedCameraIds,
      replaceCameras: false,
      idempotencyKey: `mco-${createHash('sha256').update(`${stored.plan.planHash}|${request.override.overrideId}`).digest('hex').slice(0, 32)}`,
      reason: `multicam match range override ${request.override.overrideId} on camera ${request.override.cameraId} by ${actor.kind} ${actor.id}`,
      note: request.override.reason,
    })
    return Object.freeze({
      plan: stored.plan,
      version: stored.version,
      replayed: existing !== undefined,
      colorPlan,
    })
  }
}
