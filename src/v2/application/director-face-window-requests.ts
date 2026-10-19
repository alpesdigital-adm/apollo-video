import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  DIRECTOR_FACE_WINDOW_REQUEST_LIMIT,
  createFaceWindowRequestReport,
  emptyFaceWindowRequestReport,
  type FaceWindowRequestEntry,
  type FaceWindowRequestReport,
} from '../domain/director-perception-evidence.ts'
import type { FaceEvidenceRequestState } from '../domain/director-evidence-rubric.ts'
import { DomainError } from '../domain/errors.ts'
import {
  planRequiredSourceWindows, projectTimelineSpansToSource,
} from '../domain/face-evidence-time-map.ts'
import { frameRangesToCoverageMs, perceptionDurationMs } from '../domain/perception-frame-time.ts'
import { mergeRanges, type PerceptionRange } from '../domain/perception-timeline.ts'
import type { PerceptionSnapshotClip } from '../domain/server-perception-snapshot.ts'

/**
 * W64. The Director asks for the face windows its plan needs, and decides with what it already holds.
 *
 * Face evidence is keyed by the SOURCE's frames (W65b), so what a planned cut needs is the windows of each source it plays, cut the way
 * `planRequiredSourceWindows` cuts them. The windows the sealed evidence already covers are satisfied; the rest are requested through the
 * face source window admission (the same one the public route uses), under a key that is a pure function of (workspace, project, base
 * Version, source, window): asking twice for the same plan is the same operation, never a second one.
 *
 * Nothing waits. A window that is requested and not sealed is PENDING: the Director's decisions are made on the sealed evidence it read
 * at claim, and the face tier of a range whose windows are pending is `absent` with `FACE_EVIDENCE_PENDING`. A refused request
 * (rights, a window the admission rejects) is a FAILED request: `FACE_EVIDENCE_REQUEST_FAILED`.
 */
export interface DirectorFaceWindowRequester {
  request(input: Readonly<{
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    window: Readonly<{ startSourceFrame: number; endSourceFrame: number }>
    idempotencyKey: string
    /** The run's own credential audit: the request is made as the actor that asked for the run. */
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }>): Promise<Readonly<{ operationId: string; replayed: boolean }>>
}

export function directorFaceWindowIdempotencyKey(input: Readonly<{
  workspaceId: string
  projectId: string
  baseVersionId: string
  sourceArtifactId: string
  window: Readonly<{ startSourceFrame: number; endSourceFrame: number }>
}>): string {
  return `dfw-${calculateCanonicalHash({
    kind: 'director-face-window-request/v1',
    workspaceId: input.workspaceId, projectId: input.projectId, baseVersionId: input.baseVersionId,
    sourceArtifactId: input.sourceArtifactId, window: input.window,
  }).slice(0, 56)}`
}

export type SealedFaceWindow = Readonly<{ sourceArtifactId: string; startSourceFrame: number; endSourceFrame: number }>
export type PlannedFaceWindow = Readonly<{ sourceArtifactId: string; startSourceFrame: number; endSourceFrame: number; satisfied: boolean }>
export type FaceWindowPlan = Readonly<{
  status: 'planned' | 'timeline-unsupported'
  reasonCode: string | null
  windows: readonly PlannedFaceWindow[]
}>

function covers(sealed: readonly Readonly<{ start: number; end: number }>[], start: number, end: number): boolean {
  let cursor = start
  for (const window of sealed) {
    if (window.end <= cursor) continue
    if (window.start > cursor) return false
    cursor = window.end
    if (cursor >= end) return true
  }
  return cursor >= end
}

/**
 * The source windows the plan's clips need, each marked satisfied when the sealed windows of its source cover it end to end. A source
 * whose clips cannot be mapped to source frames by a pure offset (another speed, unequal lengths) needs no window it could use, and a
 * timeline whose frame rate is not an integer cannot be mapped at all; both are said, never guessed.
 */
export function planDirectorFaceWindows(input: Readonly<{
  fps: number
  durationFrames: number
  clips: readonly PerceptionSnapshotClip[]
  sealedWindows: readonly SealedFaceWindow[]
}>): FaceWindowPlan {
  if (!Number.isInteger(input.fps) || input.fps <= 0) {
    return Object.freeze({ status: 'timeline-unsupported' as const, reasonCode: 'TIMELINE_FPS_NOT_INTEGER', windows: Object.freeze([]) })
  }
  const windows: PlannedFaceWindow[] = []
  for (const sourceArtifactId of [...new Set(input.clips.map((clip) => clip.sourceArtifactId))].toSorted()) {
    const sourceClips = input.clips.filter((clip) => clip.sourceArtifactId === sourceArtifactId)
    const spans = projectTimelineSpansToSource(sourceClips, sourceArtifactId, [{ startFrame: 0, endFrame: input.durationFrames }])
    if (spans.length === 0) continue
    const sourceDurationFrames = Math.max(...sourceClips.map((clip) => clip.sourceOutFrame))
    const sealed = mergeRanges(input.sealedWindows.filter((window) => window.sourceArtifactId === sourceArtifactId)
      .map((window) => [window.startSourceFrame, window.endSourceFrame] as const))
    const required = planRequiredSourceWindows({ sourceDurationFrames, fps: { num: input.fps, den: 1 }, spans })
    for (const window of required) {
      windows.push(Object.freeze({ sourceArtifactId, startSourceFrame: window.startSourceFrame, endSourceFrame: window.endSourceFrame,
        satisfied: covers(sealed.map(([start, end]) => ({ start, end })), window.startSourceFrame, window.endSourceFrame) }))
    }
  }
  return Object.freeze({ status: 'planned' as const, reasonCode: null, windows: Object.freeze(windows) })
}

/** The timeline milliseconds that source windows of one source play, through the clips that play it at unit rate. */
export function timelineRangesOfSourceWindows(input: Readonly<{
  fps: number
  durationFrames: number
  clips: readonly PerceptionSnapshotClip[]
  windows: readonly Readonly<{ sourceArtifactId: string; startSourceFrame: number; endSourceFrame: number }>[]
}>): readonly PerceptionRange[] {
  const durationMs = perceptionDurationMs(input.durationFrames, input.fps)
  const frames: { startFrame: number; endFrame: number }[] = []
  for (const window of input.windows) {
    for (const clip of input.clips) {
      if (clip.sourceArtifactId !== window.sourceArtifactId || clip.rate !== 1 ||
          clip.sourceOutFrame - clip.sourceInFrame !== clip.timelineOutFrame - clip.timelineInFrame) continue
      const start = Math.max(window.startSourceFrame, clip.sourceInFrame)
      const end = Math.min(window.endSourceFrame, clip.sourceOutFrame)
      if (end <= start) continue
      const offset = clip.timelineInFrame - clip.sourceInFrame
      frames.push({ startFrame: start + offset, endFrame: end + offset })
    }
  }
  return frameRangesToCoverageMs(frames, input.fps, input.durationFrames, durationMs)
}

export type DirectorFaceWindowRequestOutcome = Readonly<{
  report: FaceWindowRequestReport
  state: FaceEvidenceRequestState
}>

const NO_STATE: FaceEvidenceRequestState = Object.freeze({ pendingRangesMs: Object.freeze([]), failedRangesMs: Object.freeze([]) })

function reasonOf(error: DomainError): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code : 'FACE_WINDOW_REQUEST_REFUSED'
}

/**
 * Requests the windows the plan lacks (at most DIRECTOR_FACE_WINDOW_REQUEST_LIMIT per run; the rest are deferred, to the next run) and
 * reports every window's state. A request the admission refuses with a domain error (no analysis rights, a window outside the source)
 * is recorded as refused and does not stop the run; any other failure is not swallowed.
 */
export async function requestDirectorFaceWindows(
  dependencies: Readonly<{ requester?: DirectorFaceWindowRequester }>,
  input: Readonly<{
    workspaceId: string
    projectId: string
    baseVersionId: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    fps: number
    durationFrames: number
    clips: readonly PerceptionSnapshotClip[]
    sealedWindows: readonly SealedFaceWindow[]
    /** Sources whose sealed windows were not read because there are too many to trust a partial list of: nothing is requested for them. */
    refusedSources?: readonly string[]
  }>,
): Promise<DirectorFaceWindowRequestOutcome> {
  const plan = planDirectorFaceWindows(input)
  if (plan.status === 'timeline-unsupported') {
    return Object.freeze({ report: emptyFaceWindowRequestReport('timeline-unsupported', plan.reasonCode), state: NO_STATE })
  }
  const entries: FaceWindowRequestEntry[] = []
  const requestedWindows: PlannedFaceWindow[] = []
  const failedWindows: PlannedFaceWindow[] = []
  let requests = 0
  for (const window of plan.windows) {
    const base = { sourceArtifactId: window.sourceArtifactId, startSourceFrame: window.startSourceFrame, endSourceFrame: window.endSourceFrame }
    if (window.satisfied) {
      entries.push(Object.freeze({ ...base, state: 'satisfied' as const, operationId: null, idempotencyKey: null, replayed: null, reasonCode: null }))
      continue
    }
    if (input.refusedSources?.includes(window.sourceArtifactId)) {
      entries.push(Object.freeze({ ...base, state: 'deferred' as const, operationId: null, idempotencyKey: null, replayed: null,
        reasonCode: 'FACE_WINDOW_LIMIT_EXCEEDED' }))
      continue
    }
    if (!dependencies.requester) {
      entries.push(Object.freeze({ ...base, state: 'deferred' as const, operationId: null, idempotencyKey: null, replayed: null,
        reasonCode: 'FACE_REQUESTER_NOT_CONFIGURED' }))
      continue
    }
    if (requests >= DIRECTOR_FACE_WINDOW_REQUEST_LIMIT) {
      entries.push(Object.freeze({ ...base, state: 'deferred' as const, operationId: null, idempotencyKey: null, replayed: null,
        reasonCode: 'FACE_WINDOW_REQUEST_LIMIT_EXCEEDED' }))
      continue
    }
    requests += 1
    const idempotencyKey = directorFaceWindowIdempotencyKey({
      workspaceId: input.workspaceId, projectId: input.projectId, baseVersionId: input.baseVersionId,
      sourceArtifactId: window.sourceArtifactId, window: { startSourceFrame: window.startSourceFrame, endSourceFrame: window.endSourceFrame },
    })
    try {
      const result = await dependencies.requester.request({
        workspaceId: input.workspaceId, projectId: input.projectId, sourceArtifactId: window.sourceArtifactId,
        window: { startSourceFrame: window.startSourceFrame, endSourceFrame: window.endSourceFrame },
        idempotencyKey, authenticationAudit: input.authenticationAudit,
      })
      requestedWindows.push(window)
      entries.push(Object.freeze({ ...base, state: 'requested' as const, operationId: result.operationId, idempotencyKey,
        replayed: result.replayed, reasonCode: null }))
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      failedWindows.push(window)
      entries.push(Object.freeze({ ...base, state: 'refused' as const, operationId: null, idempotencyKey: null, replayed: null,
        reasonCode: reasonOf(error) }))
    }
  }
  const rangesOf = (windows: readonly PlannedFaceWindow[]) => timelineRangesOfSourceWindows({
    fps: input.fps, durationFrames: input.durationFrames, clips: input.clips, windows })
  return Object.freeze({
    report: createFaceWindowRequestReport({
      entries,
      status: dependencies.requester ? 'planned' : 'not-configured',
      reasonCode: dependencies.requester ? null : 'FACE_REQUESTER_NOT_CONFIGURED',
    }),
    state: Object.freeze({ pendingRangesMs: rangesOf(requestedWindows), failedRangesMs: rangesOf(failedWindows) }),
  })
}
