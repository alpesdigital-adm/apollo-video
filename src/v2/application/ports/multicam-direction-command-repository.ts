import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { MulticamDirectionImpactV1 } from '../../domain/multicam-direction-impact.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { Rational } from '../../domain/session-time.ts'
import type { StrategicObjectiveId } from '../../domain/strategic-objective.ts'
import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'
import type { DirectMulticamSessionPayload } from '../direct-multicam-session.ts'

/**
 * The project side of `direct-multicam-session` (F4.012).
 *
 * Deliberately the same three methods `EditorialCommandRepository` has, because
 * the compile step is the same one MAP.md §3.1 prescribes: read the context,
 * check the idempotency key against the whole actor, and commit the Command,
 * the `edit-plan` snapshot, the version and the outbox event in one
 * transaction. What differs is what the context has to carry — the current plan
 * is re-cut across cameras rather than trimmed, so the service needs the media
 * links the compiled clips will point at and the cadence each was probed at.
 */

/** One artifact the project already links, as the compile step needs to see it. */
export interface MulticamProjectMediaLink {
  readonly artifactId: string
  readonly role: string
  readonly status: string
  readonly mediaType: string
  /**
   * The probed cadence of this file, or null when nothing probed it.
   *
   * Null, not the plan's fps: a `CaptureTrack` carries a media *timebase*
   * (seconds per tick), which is not a frame rate — 1/90000 says nothing about
   * cadence — so an unprobed file has no rate here and the domain records the
   * fallback on the clip (`compileShotsToSourceRanges` `sourceFrameRates`).
   */
  readonly frameRate: Rational | null
}

export interface MulticamDirectionCommandContext {
  readonly workspaceId: string
  readonly projectId: string
  readonly objective: StrategicObjectiveId
  readonly currentVersion: Readonly<ProjectVersion>
  /**
   * The plan the project version currently holds.
   *
   * Typed as the union `hydrateSource` itself parses
   * (`prisma/project-proxy-render-repository.ts:94`). A multicam direction
   * re-cuts a timeline a Director already established, so the service refuses a
   * project whose plan is still an undirected editorial cut rather than
   * inventing a story plan, a treatment and a desired action to wrap around it.
   */
  readonly currentPlan: Readonly<EditorialCutEditPlan | DirectedEditPlan>
  readonly currentDurationFrames: number
  readonly proxyVariantId: string
  readonly outputReferences: readonly Readonly<CommandImpactOutputReference>[]
  readonly mediaLinks: readonly Readonly<MulticamProjectMediaLink>[]
}

export interface MulticamDirectionCommandResult {
  readonly command: Readonly<EditCommand<DirectMulticamSessionPayload>>
  readonly version: Readonly<ProjectVersion>
  readonly editPlan: Readonly<DirectedEditPlan>
  readonly impact: Readonly<MulticamDirectionImpactV1>
  readonly invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  readonly replayed: boolean
}

export interface MulticamDirectionCommandCommit {
  readonly command: Readonly<EditCommand<DirectMulticamSessionPayload>>
  readonly authenticationAudit: Readonly<ApiAccessAuditContext>
  readonly requestFingerprint: string
  readonly snapshot: Readonly<ProjectSnapshot>
  readonly version: Readonly<ProjectVersion>
  readonly editPlan: Readonly<DirectedEditPlan>
  readonly event: Readonly<PublicEvent>
  /** The direction this Command was compiled from, named so the commit can refuse a swap. */
  readonly directionEvidence: Readonly<{
    sessionId: string
    sessionVersion: number
    directionVersion: number
    directionHash: string
  }>
}

export interface MulticamDirectionCommandRepository {
  findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<{ requestFingerprint: string; result: MulticamDirectionCommandResult }> | null>

  readContext(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<MulticamDirectionCommandContext> | null>

  commitOrReplay(bundle: MulticamDirectionCommandCommit): Promise<Readonly<MulticamDirectionCommandResult>>
}
