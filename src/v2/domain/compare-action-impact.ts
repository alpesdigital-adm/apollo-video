import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type { CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'

/**
 * Impact of a `compare-action` Command.
 *
 * Accepting or reopening a comparison changes only the review state of the
 * project. It compiles no EditPlan, writes no bytes and creates no
 * ProjectVersion, so `resultVersionId` is the base version itself — the
 * "preserved version" invariant. Every impact list is empty and
 * `renderSemanticsChanged` is the literal `false`, which is what makes this the
 * only registered Command type that may never invalidate an artifact.
 *
 * The document is content-addressed: `impactHash` is the canonical hash of the
 * body without it, so a stored impact cannot be edited without detection.
 */
export interface CompareActionImpactV1 {
  schemaVersion: 'compare-action-impact/v1'
  commandId: string
  commandType: 'compare-action'
  baseVersionId: string
  /** Always identical to `baseVersionId`: no version is created or replaced. */
  resultVersionId: string
  action: 'accept' | 'reopen'
  changeKinds: readonly ['review-state']
  dependencyTypes: readonly never[]
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  minimalRenders: readonly never[]
  renderSemanticsChanged: false
  impactHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value as string
}

function emptyList(value: unknown, field: string): void {
  assertDomain(Array.isArray(value) && value.length === 0, 'PERSISTENCE_CONFLICT', `${field} must be empty`)
}

export function createCompareActionImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  action: 'accept' | 'reopen'
}): Readonly<CompareActionImpactV1> {
  assertDomain(
    input.action === 'accept' || input.action === 'reopen',
    'INVALID_ARGUMENT',
    'Compare action is invalid',
  )
  const baseVersionId = identifier(input.baseVersionId, 'baseVersionId')
  assertDomain(
    identifier(input.resultVersionId, 'resultVersionId') === baseVersionId,
    'INVALID_ARGUMENT',
    'A compare action preserves its base version and cannot produce another one',
  )
  const body = {
    schemaVersion: 'compare-action-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'compare-action' as const,
    baseVersionId,
    resultVersionId: baseVersionId,
    action: input.action,
    changeKinds: Object.freeze(['review-state'] as const),
    dependencyTypes: Object.freeze([] as never[]),
    affectedRanges: Object.freeze([] as Readonly<CommandImpactRange>[]),
    affectedVariantIds: Object.freeze([] as string[]),
    affectedArtifacts: Object.freeze([] as Readonly<CommandImpactOutputReference>[]),
    minimalRenders: Object.freeze([] as never[]),
    renderSemanticsChanged: false as const,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseCompareActionImpact(value: unknown): Readonly<CompareActionImpactV1> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact must be an object',
  )
  const impact = value as CompareActionImpactV1
  const expectedKeys = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'action', 'changeKinds', 'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'minimalRenders', 'renderSemanticsChanged', 'impactHash',
  ].sort()
  const actualKeys = Object.keys(impact).sort()
  assertDomain(
    actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]),
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact fields are invalid',
  )
  assertDomain(
    impact.schemaVersion === 'compare-action-impact/v1' && impact.commandType === 'compare-action',
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact belongs to another Command type',
  )
  assertDomain(
    impact.renderSemanticsChanged === false,
    'PERSISTENCE_CONFLICT',
    'A compare action can never change render semantics',
  )
  assertDomain(
    JSON.stringify(impact.changeKinds) === JSON.stringify(['review-state']),
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact changeKinds are invalid',
  )
  emptyList(impact.dependencyTypes, 'Stored compare action impact dependencyTypes')
  emptyList(impact.affectedRanges, 'Stored compare action impact affectedRanges')
  emptyList(impact.affectedVariantIds, 'Stored compare action impact affectedVariantIds')
  emptyList(impact.affectedArtifacts, 'Stored compare action impact affectedArtifacts')
  emptyList(impact.minimalRenders, 'Stored compare action impact minimalRenders')
  assertDomain(
    typeof impact.impactHash === 'string' && /^[a-f0-9]{64}$/.test(impact.impactHash),
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact hash is invalid',
  )
  assertDomain(
    impact.action === 'accept' || impact.action === 'reopen',
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact action is invalid',
  )
  assertDomain(
    typeof impact.resultVersionId === 'string' && impact.resultVersionId === impact.baseVersionId,
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact does not preserve its base version',
  )
  const recreated = createCompareActionImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    action: impact.action,
  })
  // Key order is irrelevant: the document survives canonical serialization, so
  // a persisted round-trip and a freshly built document must be byte-identical.
  assertDomain(
    stableSerialize(recreated) === stableSerialize(impact),
    'PERSISTENCE_CONFLICT',
    'Stored compare action impact is inconsistent',
  )
  return Object.freeze(impact)
}
