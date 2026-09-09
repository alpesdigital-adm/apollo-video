import type { CameraColorMeasurement } from '../../domain/color-measurement.ts'
import type { MulticamMatchPlan } from '../../domain/multicam-match-plan.ts'

/**
 * A match plan as it sits in storage (F4.013).
 *
 * Like `MulticamDirection`, `MulticamMatchPlan` has no version field: the chain
 * is a persistence fact. The pair is handed back so the next write can fence on
 * both halves.
 */
export interface StoredMulticamMatchPlan {
  readonly plan: Readonly<MulticamMatchPlan>
  readonly version: number
  readonly previousVersionHash: string | null
}

export interface MulticamMatchPlanBase {
  readonly version: number
  readonly planHash: string
}

/** Enough of a plan to decide what a changed measurement invalidates. */
export interface MulticamMatchPlanDependencyRef {
  readonly projectId: string
  readonly sessionId: string
  readonly version: number
  readonly planHash: string
  readonly referenceCameraId: string
  readonly humanReviewRequired: boolean
  readonly isHead: boolean
}

/**
 * Camera colour measurements (F4.013 / FR-151).
 *
 * A measurement is its own aggregate rather than a copy inside every plan that
 * cites it: the same measured range is read by a match plan and by a colour
 * critic report, and two copies would be two answers to one question. It is
 * content-addressed and never updated — re-measuring the same range with a
 * different result produces a different measurement id, not an edit.
 *
 * `CameraColorMeasurement` has no `workspaceId` of its own, so the workspace
 * travels beside it here rather than being guessed from the session.
 */
export interface CameraColorMeasurementRepository {
  persist(input: {
    workspaceId: string
    measurement: Readonly<CameraColorMeasurement>
    createdAt: string
  }): Promise<Readonly<{ measurement: Readonly<CameraColorMeasurement>; replayed: boolean }>>

  read(input: {
    workspaceId: string
    measurementId: string
  }): Promise<Readonly<CameraColorMeasurement> | null>

  /** Every measurement taken against one session, oldest first. */
  listForSession(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<CameraColorMeasurement>[]>

  /**
   * Measurements of one camera's bytes.
   *
   * `sourceSha256` is part of the answer rather than a filter the caller may
   * forget: a measurement of different bytes is a measurement of a different
   * recording even when the asset id is the same.
   */
  listForCamera(input: {
    workspaceId: string
    cameraId: string
    sourceAssetId?: string
  }): Promise<readonly Readonly<CameraColorMeasurement>[]>
}

/**
 * Multicam match plans (F4.013 / FR-151).
 *
 * A chain plus a head per project and session. The plan's measurements are not
 * copied into it: they are stored once as their own aggregate and joined back,
 * so a plan and a critic report that cite the same measurement cite the same
 * row. `persist` writes any measurement it has not seen before, which makes a
 * plan storable in one call without the caller sequencing two repositories.
 */
export interface MulticamMatchPlanRepository {
  appendVersion(input: {
    plan: Readonly<MulticamMatchPlan>
    base: Readonly<MulticamMatchPlanBase> | null
    occurredAt: string
  }): Promise<Readonly<{ stored: Readonly<StoredMulticamMatchPlan>; replayed: boolean }>>

  readHead(input: {
    workspaceId: string
    projectId: string
    sessionId: string
  }): Promise<Readonly<StoredMulticamMatchPlan> | null>

  readVersion(input: {
    workspaceId: string
    projectId: string
    sessionId: string
    version: number
  }): Promise<Readonly<StoredMulticamMatchPlan> | null>

  listVersions(input: {
    workspaceId: string
    projectId: string
    sessionId: string
    limit?: number
  }): Promise<readonly Readonly<StoredMulticamMatchPlan>[]>

  /**
   * Plans that were built on a measurement, or against a reference camera.
   *
   * Re-measuring a camera or changing which camera is the reference does not
   * invalidate every plan — only the ones that said so.
   */
  findDependents(input: {
    workspaceId: string
    measurementId?: string
    referenceCameraId?: string
    sessionId?: string
  }): Promise<readonly Readonly<MulticamMatchPlanDependencyRef>[]>
}
