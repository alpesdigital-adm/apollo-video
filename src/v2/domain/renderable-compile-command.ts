import type { ApiAccessAuditContext } from './api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { createEditCommand, type EditCommand } from './edit-command.ts'
import { assertDomain } from './errors.ts'
import type { OutputOriginAllocation } from './output-version-origin.ts'
import { createV2RenderablePlanSnapshotFacts, type V2RenderablePlanSnapshotFacts } from './project-fork-derivation.ts'

/**
 * A renderable plan reaches a project only as the State of a Version born with it.
 *
 * The database refuses a bare INSERT of a renderable plan snapshot: the row is admitted when the sealed State of the Version it
 * names binds it back (`renderablePlanSnapshotId`, `renderablePlanId` and `renderablePlanHash`), and that State is a State3 whose
 * origin is the Command below. So a compile is a Command like any other that produces a Version:
 *
 * - the Command is `compile-renderable-plan`, based on the exact head Version and hash, with the credential audit of an external
 *   author. It changes no existing render, so its impact is an explicit zero;
 * - the new Version is the head's child. Its EditPlan is the head's plan under the new identity (the declared effect), every entry
 *   re-materializes from the head's exact observations, and the State holds the renderable plan as the alternate plan of that
 *   Version: the plan's `projectVersionId` IS the new Version, which is what makes the binding reciprocal;
 * - every identity the compile allocates is derived from the natural key (workspace, project, derivation, derivation hash and the
 *   head it is compiled on), because the plan document carries its Version's id and so has to be compiled after the id is known:
 *   the same compile twice names the same Version, Command and rows, which is what makes a retry a replay.
 *
 * The frame rate is not in that key. A second delivery rate of the same derivation is a second plan of the same Version, which
 * cannot be: the first compile moved the head, so the second names the head it left behind.
 */
export const RENDERABLE_COMPILE_COMMAND_TYPE = 'compile-renderable-plan' as const
export const RENDERABLE_COMPILE_PAYLOAD_SCHEMA = 1 as const
export const RENDERABLE_COMPILE_PRODUCER_SCHEMA = 'output-renderable-compile-producer/v1' as const
export type RenderableCompileOrigin = V2RenderablePlanSnapshotFacts['origin']

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/
const HASH = /^[a-f0-9]{64}$/
const ORIGINS: readonly RenderableCompileOrigin[] = ['react-playback', 'multi-range-synthesis', 'music-led-montage', 'localization']

export interface RenderableCompileKey {
  readonly workspaceId: string
  readonly projectId: string
  readonly origin: RenderableCompileOrigin
  readonly sourceId: string
  readonly sourceHash: string
  /** The head Version the cut is compiled on; the compile is its child. */
  readonly baseVersionId: string
}
export interface RenderableCompileIdentity {
  readonly versionId: string
  readonly stateId: string
  readonly commandId: string
  readonly editPlanSnapshotId: string
  readonly idempotencyKey: string
}

export function renderableCompileIdentity(key: Readonly<RenderableCompileKey>): Readonly<RenderableCompileIdentity> {
  for (const field of ['workspaceId', 'projectId', 'baseVersionId'] as const) {
    assertDomain(typeof key[field] === 'string' && ID.test(key[field]), 'INVALID_ARGUMENT', `${field} is invalid`)
  }
  assertDomain(ORIGINS.includes(key.origin), 'INVALID_ARGUMENT', 'a renderable compile names a known derivation origin')
  assertDomain(typeof key.sourceId === 'string' && key.sourceId.trim() === key.sourceId && key.sourceId.length > 0 && key.sourceId.length <= 160,
    'INVALID_ARGUMENT', 'sourceId is invalid')
  assertDomain(HASH.test(key.sourceHash), 'INVALID_ARGUMENT', 'sourceHash is invalid')
  const digest = calculateCanonicalHash({ schemaVersion: 'renderable-compile-identity/v1', workspaceId: key.workspaceId, projectId: key.projectId,
    origin: key.origin, sourceId: key.sourceId, sourceHash: key.sourceHash, baseVersionId: key.baseVersionId }).slice(0, 40)
  return Object.freeze({
    versionId: `renderable-version-${digest}`, stateId: `renderable-state-${digest}`, commandId: `renderable-command-${digest}`,
    editPlanSnapshotId: `renderable-edit-plan-${digest}`, idempotencyKey: `renderable-compile-${digest}`,
  })
}

/**
 * The primary key of a renderable plan snapshot: one derivation, at one hash, compiled into one Version at one delivery rate. The
 * database's own `renderable_plan_snapshots_source_key` holds the same columns; the id is that key hashed, so it always fits its
 * column and a divergence between the two shows up as a unique violation the replay cannot resolve.
 */
export function renderableSnapshotRowId(key: Readonly<{ workspaceId: string; origin: RenderableCompileOrigin; sourceId: string; sourceHash: string; projectVersionId: string; fps: number }>): string {
  return `renderable-snapshot-${calculateCanonicalHash({ schemaVersion: 'renderable-snapshot-row/v1', workspaceId: key.workspaceId, origin: key.origin,
    sourceId: key.sourceId, sourceHash: key.sourceHash, projectVersionId: key.projectVersionId, fps: key.fps }).slice(0, 48)}`
}

/** The identity of the row the Command publishes, sealed in the Command payload and re-read from the row by the database guard. */
export interface RenderableCompileSnapshotRef {
  readonly id: string
  readonly planId: string
  readonly planHash: string
  readonly origin: RenderableCompileOrigin
  readonly sourceId: string
  readonly sourceHash: string
  readonly sourceVersion: number | null
  readonly fps: number
  readonly durationFrames: number
  readonly clipCount: number
}
export interface RenderableCompileImpactV1 {
  schemaVersion: 'renderable-compile-impact/v1'
  commandType: 'compile-renderable-plan'
  commandId: string
  baseVersionId: string
  resultVersionId: string
  preservedEditPlanSnapshotId: string
  renderablePlanSnapshotId: string
  renderablePlanHash: string
  changeKinds: readonly ['renderable-plan']
  dependencyTypes: readonly never[]
  affectedRanges: readonly never[]
  affectedVariantIds: readonly never[]
  affectedArtifacts: readonly never[]
  minimalRenders: readonly never[]
  renderSemanticsChanged: false
  impactHash: string
}
export interface RenderableCompilePayload {
  readonly schemaVersion: typeof RENDERABLE_COMPILE_PAYLOAD_SCHEMA
  readonly snapshot: Readonly<RenderableCompileSnapshotRef>
  readonly impact: Readonly<RenderableCompileImpactV1>
}

type ImpactInput = Pick<RenderableCompileImpactV1, 'commandId' | 'baseVersionId' | 'resultVersionId' | 'preservedEditPlanSnapshotId' | 'renderablePlanSnapshotId' | 'renderablePlanHash'>

/** A compile changes no render semantics: the EditPlan snapshot is the parent's, and the plan it binds is rendered by its own operation. */
export function createRenderableCompileImpact(input: ImpactInput): Readonly<RenderableCompileImpactV1> {
  for (const field of ['commandId', 'baseVersionId', 'resultVersionId', 'preservedEditPlanSnapshotId', 'renderablePlanSnapshotId'] as const) {
    assertDomain(typeof input[field] === 'string' && (field === 'renderablePlanSnapshotId' ? ROW_ID : ID).test(input[field]),
      'INVALID_ARGUMENT', `${field} is invalid`)
  }
  assertDomain(HASH.test(input.renderablePlanHash), 'INVALID_ARGUMENT', 'renderablePlanHash is invalid')
  assertDomain(input.baseVersionId !== input.resultVersionId, 'INVALID_ARGUMENT', 'A renderable compile requires a distinct result Version')
  const body = {
    schemaVersion: 'renderable-compile-impact/v1' as const, commandType: RENDERABLE_COMPILE_COMMAND_TYPE,
    commandId: input.commandId, baseVersionId: input.baseVersionId, resultVersionId: input.resultVersionId,
    preservedEditPlanSnapshotId: input.preservedEditPlanSnapshotId, renderablePlanSnapshotId: input.renderablePlanSnapshotId,
    renderablePlanHash: input.renderablePlanHash, changeKinds: Object.freeze(['renderable-plan'] as const),
    dependencyTypes: Object.freeze([] as never[]), affectedRanges: Object.freeze([] as never[]), affectedVariantIds: Object.freeze([] as never[]),
    affectedArtifacts: Object.freeze([] as never[]), minimalRenders: Object.freeze([] as never[]), renderSemanticsChanged: false as const,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseRenderableCompileImpact(value: unknown): Readonly<RenderableCompileImpactV1> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'PERSISTENCE_CONFLICT', 'Stored renderable compile impact must be an object')
  const impact = value as RenderableCompileImpactV1
  const recreated = createRenderableCompileImpact({ commandId: impact.commandId, baseVersionId: impact.baseVersionId, resultVersionId: impact.resultVersionId,
    preservedEditPlanSnapshotId: impact.preservedEditPlanSnapshotId, renderablePlanSnapshotId: impact.renderablePlanSnapshotId, renderablePlanHash: impact.renderablePlanHash })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored renderable compile impact is inconsistent')
  return recreated
}

function snapshotRef(row: Readonly<V2RenderablePlanSnapshotFacts>): Readonly<RenderableCompileSnapshotRef> {
  return Object.freeze({ id: row.id, planId: row.planId, planHash: row.planHash, origin: row.origin, sourceId: row.sourceId, sourceHash: row.sourceHash,
    sourceVersion: row.sourceVersion, fps: row.fps, durationFrames: row.durationFrames, clipCount: row.clipCount })
}

/** The payload of the Command for one row. The row is validated here (its plan against its own hash, measurements and lineage). */
export function createRenderableCompilePayload(input: Readonly<{
  commandId: string; baseVersionId: string; resultVersionId: string; preservedEditPlanSnapshotId: string; renderableSnapshot: Readonly<V2RenderablePlanSnapshotFacts>
}>): Readonly<RenderableCompilePayload> {
  const row = createV2RenderablePlanSnapshotFacts(input.renderableSnapshot)
  assertDomain(row.projectVersionId === input.resultVersionId, 'INVALID_COMMAND', 'The renderable plan must be compiled into the Version the Command creates')
  return Object.freeze({ schemaVersion: RENDERABLE_COMPILE_PAYLOAD_SCHEMA, snapshot: snapshotRef(row),
    impact: createRenderableCompileImpact({ commandId: input.commandId, baseVersionId: input.baseVersionId, resultVersionId: input.resultVersionId,
      preservedEditPlanSnapshotId: input.preservedEditPlanSnapshotId, renderablePlanSnapshotId: row.id, renderablePlanHash: row.planHash }) })
}

/** The origin carried by a Version whose Command is `compile-renderable-plan`. The row itself is read back by id. */
export interface RenderableCompileOriginV3 {
  kind: 'renderable-compile-command'
  command: EditCommand<RenderableCompilePayload>
  /** Credential audit for an external (api-client) author; null for internal actors. */
  audit: ApiAccessAuditContext | null
  requestFingerprint: string
}

function exactKeys(value: unknown, keys: readonly string[], message: string): void {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'INVALID_COMMAND', message)
}

/**
 * The scope, base, actor, time, payload and impact of the origin against the exact base and the allocation. Everything here is
 * mirrored by the database guard from the sealed rows; nothing is re-derived from the caller.
 */
export function validateRenderableCompileOriginV3(input: RenderableCompileOriginV3,
  base: Readonly<{ version: Readonly<{ id: string; baseHash: string; workspaceId: string; projectId: string }> }>,
  allocation: Readonly<OutputOriginAllocation>): RenderableCompileOriginV3 {
  exactKeys(input, ['kind', 'command', 'audit', 'requestFingerprint'], 'Renderable compile origin fields are missing or unsupported')
  const c = input.command
  assertDomain(input.kind === 'renderable-compile-command' && c.type === RENDERABLE_COMPILE_COMMAND_TYPE, 'INVALID_COMMAND',
    'Renderable compile origin requires the compile-renderable-plan Command')
  assertDomain(c.workspaceId === allocation.workspaceId && c.projectId === allocation.projectId && c.baseVersionId === base.version.id &&
    c.baseHash === base.version.baseHash && c.author.id === allocation.createdBy && c.createdAt === allocation.createdAt &&
    stableSerialize(c.scope) === stableSerialize({ project: true }), 'INVALID_COMMAND', 'Renderable compile Command scope/base/actor/time differs')
  const { schemaVersion: _schema, commandHash: _seal, ...body } = c
  assertDomain(createEditCommand({ ...body, type: RENDERABLE_COMPILE_COMMAND_TYPE } as unknown as Parameters<typeof createEditCommand>[0]).commandHash === c.commandHash,
    'INVALID_COMMAND', 'Renderable compile Command historical hash differs')
  const payload = c.payload
  exactKeys(payload, ['schemaVersion', 'snapshot', 'impact'], 'Renderable compile payload fields are missing or unsupported')
  exactKeys(payload.snapshot, ['id', 'planId', 'planHash', 'origin', 'sourceId', 'sourceHash', 'sourceVersion', 'fps', 'durationFrames', 'clipCount'],
    'Renderable compile snapshot identity fields are missing or unsupported')
  const impact = parseRenderableCompileImpact(payload.impact)
  assertDomain(payload.schemaVersion === RENDERABLE_COMPILE_PAYLOAD_SCHEMA && stableSerialize(impact) === stableSerialize(payload.impact) &&
    impact.commandId === c.id && impact.baseVersionId === base.version.id && impact.resultVersionId === allocation.resultVersionId &&
    impact.renderablePlanSnapshotId === payload.snapshot.id && impact.renderablePlanHash === payload.snapshot.planHash,
  'INVALID_COMMAND', 'Renderable compile impact differs from the Command it belongs to')
  assertDomain(HASH.test(payload.snapshot.planHash) && HASH.test(payload.snapshot.sourceHash) && ORIGINS.includes(payload.snapshot.origin),
    'INVALID_COMMAND', 'Renderable compile snapshot identity is invalid')
  if (c.author.type === 'api-client') {
    assertDomain(input.audit !== null && input.audit.workspaceId === allocation.workspaceId && input.audit.clientId === c.author.id &&
      input.audit.delegatedUserId === c.author.delegatedUserId, 'INVALID_COMMAND', 'Renderable compile external actor audit differs')
  } else assertDomain(input.audit === null, 'INVALID_COMMAND', 'Only an external actor carries a credential audit')
  assertDomain(HASH.test(input.requestFingerprint), 'INVALID_COMMAND', 'Renderable compile request fingerprint is invalid')
  return input
}

/**
 * The row a renderable-compile origin publishes, bound to the Version it creates: the validated facts of a stored row, in this
 * workspace and project, compiled into the result Version at the Version's own clock, and exactly the identity the Command sealed.
 * Any other origin publishes no row, so a row handed to one is refused instead of ignored.
 */
export function bindRenderableSnapshotV3(origin: Readonly<{ kind: string }>, row: Readonly<V2RenderablePlanSnapshotFacts> | undefined,
  allocation: Readonly<OutputOriginAllocation>): Readonly<V2RenderablePlanSnapshotFacts> | null {
  if (origin.kind !== 'renderable-compile-command') {
    assertDomain(row === undefined, 'INVALID_COMMAND', 'Only a renderable compile publishes a renderable plan snapshot')
    return null
  }
  assertDomain(row !== undefined, 'INVALID_COMMAND', 'A renderable compile requires the snapshot row it publishes')
  const facts = createV2RenderablePlanSnapshotFacts(row)
  const sealed = (origin as RenderableCompileOriginV3).command.payload.snapshot
  assertDomain(facts.workspaceId === allocation.workspaceId && facts.projectId === allocation.projectId && facts.projectVersionId === allocation.resultVersionId &&
    facts.createdAt === allocation.createdAt, 'INVALID_COMMAND', 'The renderable snapshot belongs to another workspace, project, Version or clock')
  assertDomain(stableSerialize(snapshotRef(facts)) === stableSerialize(sealed), 'INVALID_COMMAND', 'The renderable snapshot differs from the identity its Command sealed')
  return facts
}

export function renderableCompileRequestFingerprint(input: Readonly<{
  key: Readonly<RenderableCompileKey>; sourceVersion: number | null; fps: number; planHash: string; audit: Readonly<ApiAccessAuditContext> | null
  author: Readonly<{ type: string; id: string; delegatedUserId?: string }>
}>): string {
  return calculateCanonicalHash({ schemaVersion: 'renderable-compile-request/v1', ...input.key, sourceVersion: input.sourceVersion, fps: input.fps,
    planHash: input.planHash,
    actorIdentity: input.audit ? { kind: 'external', contextHash: input.audit.contextHash } : { kind: 'internal', actor: input.author } })
}
