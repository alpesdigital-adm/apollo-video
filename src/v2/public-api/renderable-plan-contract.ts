import type { StoredRenderablePlanSnapshot } from '../application/ports/renderable-plan-snapshot-repository.ts'
import { STRATEGIC_OBJECTIVES, type StrategicObjectiveId } from '../domain/strategic-objective.ts'
import type { Rational } from '../domain/session-time.ts'
import {
  exactFields,
  identifier,
  member,
  record,
  sha256,
  versionRef,
} from './capture-derivation-contract.ts'
import { parseRationalString } from './capture-session-contract.ts'

/**
 * The public boundary for the two compilers that turn a decision into
 * something a renderer accepts (F4.015, F4.016 condition 6).
 *
 * Both were reachable only from a test until this module existed. The react
 * playback map could be built, read, listed and anchored through `/v1` and then
 * stopped: the compile that produces the renderable plan — and with it the
 * `renderable_plan_snapshots` row that gate criteria 4 and 6 read — had no
 * capability, no schema and no route. Nothing outside a test could create the
 * evidence the gate requires, so the gate could not reach ten of ten through
 * the published API at all.
 *
 * Three decisions this module makes rather than leaves to a reader.
 *
 * **One presenter, two commands.** The two compilers differ in what they read
 * and agree completely in what they produce: a `DirectedEditPlan` kept beside
 * the derivation that decided it. So the answer has one shape and one builder,
 * and a client that learns to read a compiled react plan can read a compiled
 * synthesis without a second parser.
 *
 * **The answer is the stored row, not the plan document.** A `DirectedEditPlan`
 * is thousands of clips wide on a long cut; publishing it inline would make
 * every compile response a download. What a caller needs in order to act is the
 * identity of the cut (`planId`, `planHash`), what it was derived from and at
 * which hash, and the three numbers that say whether it is the cut they meant —
 * frame rate, duration and clip count. Those are the columns
 * `RenderablePlanSnapshot` already stores, read back from PostgreSQL by the
 * repository, so the response is what a later reader will open rather than a
 * projection assembled in the route.
 *
 * **The assumptions travel.** `assembleDirectedEditPlan` writes down what the
 * cut takes for granted — that the output runs the reaction's length and not
 * the reference's, that materialization is cut-only, how many milliseconds a
 * synthesis left on the floor. Those sentences are the honest part of an
 * automated cut and they are published, not summarised into a boolean.
 */

const OBJECTIVE_IDS = Object.freeze(
  STRATEGIC_OBJECTIVES.map((objective) => objective.id),
) as readonly StrategicObjectiveId[]

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface CompiledRenderablePlanResult {
  readonly snapshot: Readonly<StoredRenderablePlanSnapshot>
  readonly replayed: boolean
}

export function presentCompiledRenderablePlan(result: Readonly<CompiledRenderablePlanResult>) {
  const { snapshot } = result
  return Object.freeze({
    plan: Object.freeze({
      planId: snapshot.planId,
      // The identity of the cut, over the whole document minus `createdAt`.
      // Two callers holding this string hold the same clips.
      planHash: snapshot.planHash,
      origin: snapshot.origin,
      // The aggregate that decided the cut, and the hash it held when it was
      // read. A source that later moves leaves this naming a hash nothing
      // matches, which is how a reader learns the plan is stale instead of
      // rendering last week's cut.
      sourceId: snapshot.sourceId,
      sourceHash: snapshot.sourceHash,
      // Null where the source is not versioned: a synthesis is one immutable
      // cut, and writing 1 there would invent a chain it does not have.
      sourceVersion: snapshot.sourceVersion,
      projectId: snapshot.projectId,
      projectVersionId: snapshot.plan.projectVersionId,
      fps: snapshot.fps,
      durationFrames: snapshot.durationFrames,
      clipCount: snapshot.clipCount,
      // The compiler that wrote it, so a plan produced before a compiler change
      // is recognisable as such rather than assumed current.
      compilerVersion: snapshot.plan.director.plannerVersion,
      assumptions: snapshot.plan.director.assumptions,
      lineageRefs: snapshot.plan.lineageRefs,
      createdAt: snapshot.createdAt,
    }),
    replayed: result.replayed,
  })
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ParsedCompilePlaybackPlanBody {
  readonly baseVersionId: string
  readonly baseHash: string
  readonly reactionTrackId: string
  readonly projectVersionId: string
  readonly objective: StrategicObjectiveId
  readonly planFps: Rational
}

const COMPILE_PLAYBACK_KEYS = Object.freeze([
  'baseVersionId',
  'baseHash',
  'reactionTrackId',
  'projectVersionId',
  'objective',
  'planFps',
] as const)

/**
 * The map version to compile, the project version to compile it into, and the
 * frame rate to compile at.
 *
 * No clip, no rate, no duration and no source: every frame number in the plan
 * is derived from the stored map and from durations the server measured on the
 * files. `planFps` is the one number the caller chooses, and it is a delivery
 * decision rather than a measurement — it crosses as `"num/den"` because a
 * frame rate of 30000/1001 is not 29.97 and rounding it in transit would put a
 * drift nobody chose into every timeline.
 */
export function parseCompilePlaybackPlanBody(raw: unknown): ParsedCompilePlaybackPlanBody {
  const body = record(raw, 'body')
  exactFields(body, COMPILE_PLAYBACK_KEYS, 'body')
  return Object.freeze({
    // `<sessionId>:playback:<trackId>:v<n>` — the pair, never the number: a
    // version number alone can be reused after a write that failed halfway.
    baseVersionId: versionRef(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    reactionTrackId: identifier(body.reactionTrackId, 'reactionTrackId'),
    projectVersionId: identifier(body.projectVersionId, 'projectVersionId'),
    objective: member(body.objective, OBJECTIVE_IDS, 'objective'),
    planFps: parseRationalString(body.planFps, 'planFps'),
  })
}

export interface ParsedCompileSynthesisPlanBody {
  readonly projectVersionId: string
  readonly objective: StrategicObjectiveId
}

const COMPILE_SYNTHESIS_KEYS = Object.freeze(['projectVersionId', 'objective'] as const)

/**
 * The project version to compile the synthesis into, and what the cut is for.
 *
 * There is no fence here and the absence is deliberate: an `EditorialSynthesis`
 * is one immutable content-addressed cut, so there is no later version of it to
 * be stale against — the same argument the phase gate's own command makes. The
 * frame rate is not a field either: the synthesis already fixed it exactly
 * (`editPlan.frameRate`), and letting a caller name a second one here would
 * offer two answers to a question the aggregate already settled.
 */
export function parseCompileSynthesisPlanBody(raw: unknown): ParsedCompileSynthesisPlanBody {
  const body = record(raw, 'body')
  exactFields(body, COMPILE_SYNTHESIS_KEYS, 'body')
  return Object.freeze({
    projectVersionId: identifier(body.projectVersionId, 'projectVersionId'),
    objective: member(body.objective, OBJECTIVE_IDS, 'objective'),
  })
}
