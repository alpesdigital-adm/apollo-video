import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  subtitlePresetHash,
  type SubtitleAnchor,
  type SubtitlePresetId,
} from './subtitle-system.ts'

/**
 * F1.037 / FR-174 — a subtitle exception scoped to ONE segment of ONE variant.
 *
 * The project keeps a single main subtitle resolution (F1.034). This module models
 * the controlled exceptions on top of it — the hook that has to sit higher, the CTA
 * that has to read differently, the testimonial cue that must not appear at all —
 * without ever touching the global resolution.
 *
 * Every override carries its complete scope: workspace, project, the immutable
 * ProjectVersion it was authored against, the output variant, the subtitle segment
 * and a half-open frame range. Nothing here is applicable "in general": a document
 * that does not match the variant and the range of the compiled segment is refused
 * at write time and is a recorded no-op at compile time.
 */

/**
 * Closed state machine. `set` writes the exception; `reset` returns the segment to
 * the level it carried before the current override — the first `reset` of a segment
 * therefore returns it to the inherited main resolution. Both are real Commands on
 * an append-only chain: no history is deleted to undo an exception.
 *
 * There is deliberately no `protect` action: protection is a property of the value
 * that was set, so protecting a segment is stating its value with `protected: true`
 * and is recorded as such. A separate action would let protection drift away from
 * the value it is supposed to protect.
 */
export const SUBTITLE_SEGMENT_OVERRIDE_ACTIONS = ['set', 'reset'] as const
export type SubtitleSegmentOverrideAction = (typeof SUBTITLE_SEGMENT_OVERRIDE_ACTIONS)[number]

/** The four dimensions FR-174 allows an exception to move. Nothing else is overridable. */
export const SUBTITLE_SEGMENT_OVERRIDE_KINDS = ['position', 'style', 'text', 'visibility'] as const
export type SubtitleSegmentOverrideKind = (typeof SUBTITLE_SEGMENT_OVERRIDE_KINDS)[number]

/**
 * Anchors an override may pin, bound to the F1.036 anchor union: if the perception
 * solver ever gains or loses an anchor, this list stops type-checking instead of
 * silently accepting a value the renderer cannot draw.
 */
export const SUBTITLE_SEGMENT_OVERRIDE_ANCHORS = [
  'top', 'upper-third', 'center', 'lower-third', 'bottom',
] as const satisfies readonly SubtitleAnchor[]

export const SUBTITLE_SEGMENT_OVERRIDE_TEXT_MAX = 200

export type SubtitleSegmentOverrideDimension =
  | Readonly<{ kind: 'position'; anchor: SubtitleAnchor }>
  /** A versioned preset reference, never a copy of the mutable style tokens. */
  | Readonly<{ kind: 'style'; presetId: SubtitlePresetId; presetVersion: 1; presetHash: string }>
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'visibility'; visible: boolean }>

export interface SubtitleSegmentOverrideRange {
  startFrame: number
  /** Exclusive. `[startFrame, endFrame)` — the same half-open convention as every range in V2. */
  endFrame: number
}

export interface SubtitleSegmentOverride {
  schemaVersion: 'subtitle-segment-override/v1'
  id: string
  workspaceId: string
  projectId: string
  /** Immutable ProjectVersion the override was authored against. */
  baseVersionId: string
  resultVersionId: string
  commandId: string
  variantId: string
  segmentId: string
  range: Readonly<SubtitleSegmentOverrideRange>
  action: SubtitleSegmentOverrideAction
  /** At most one entry per kind, canonically ordered. Empty means "back to inherited". */
  dimensions: readonly SubtitleSegmentOverrideDimension[]
  /** When true the compiler re-applies this exception on top of an automatic recompilation. */
  protected: boolean
  /** Override this one replaced on the same (variant, segment), or null for the first. */
  previousOverrideId: string | null
  createdAt: string
  overrideHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).toSorted()
  const expected = [...keys].toSorted()
  assertDomain(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    'INVALID_ARGUMENT',
    `${field} fields are invalid`,
    { expected, actual },
  )
}

/** Half-open range guard used by both the entity and the impact. */
export function requireSubtitleSegmentOverrideRange(
  value: unknown,
  field = 'range',
): Readonly<SubtitleSegmentOverrideRange> {
  const range = record(value, field)
  exactKeys(range, ['startFrame', 'endFrame'], field)
  assertDomain(
    Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) &&
      Number(range.startFrame) >= 0 && Number(range.endFrame) > Number(range.startFrame),
    'INVALID_ARGUMENT',
    `${field} must be a positive half-open frame range`,
  )
  return Object.freeze({ startFrame: Number(range.startFrame), endFrame: Number(range.endFrame) })
}

/**
 * Fail-closed parse of one dimension. Each kind declares exactly its own fields;
 * an unknown kind, a missing field or a field borrowed from another kind is
 * rejected before the document can be hashed.
 */
function parseDimension(value: unknown, index: number): SubtitleSegmentOverrideDimension {
  const dimension = record(value, `dimensions[${index}]`)
  const kind = dimension.kind
  assertDomain(
    typeof kind === 'string' && (SUBTITLE_SEGMENT_OVERRIDE_KINDS as readonly string[]).includes(kind),
    'INVALID_ARGUMENT',
    `dimensions[${index}].kind must be one of ${SUBTITLE_SEGMENT_OVERRIDE_KINDS.join(', ')}`,
  )
  if (kind === 'position') {
    exactKeys(dimension, ['kind', 'anchor'], `dimensions[${index}]`)
    assertDomain(
      typeof dimension.anchor === 'string' &&
        (SUBTITLE_SEGMENT_OVERRIDE_ANCHORS as readonly string[]).includes(dimension.anchor),
      'INVALID_ARGUMENT',
      `dimensions[${index}].anchor is not a registered subtitle anchor`,
    )
    return Object.freeze({ kind: 'position' as const, anchor: dimension.anchor as SubtitleAnchor })
  }
  if (kind === 'style') {
    exactKeys(dimension, ['kind', 'presetId', 'presetVersion', 'presetHash'], `dimensions[${index}]`)
    assertDomain(dimension.presetVersion === 1, 'INVALID_ARGUMENT', `dimensions[${index}].presetVersion is unsupported`)
    const presetId = dimension.presetId as SubtitlePresetId
    // Throws when the id is not a registered preset; equality then proves the
    // stored reference still matches the registered body.
    const expected = subtitlePresetHash(presetId)
    assertDomain(
      typeof dimension.presetHash === 'string' && dimension.presetHash === expected,
      'INVALID_ARGUMENT',
      `dimensions[${index}] must reference a registered subtitle preset by id and version hash`,
    )
    return Object.freeze({ kind: 'style' as const, presetId, presetVersion: 1 as const, presetHash: expected })
  }
  if (kind === 'text') {
    exactKeys(dimension, ['kind', 'text'], `dimensions[${index}]`)
    assertDomain(typeof dimension.text === 'string', 'INVALID_ARGUMENT', `dimensions[${index}].text is invalid`)
    // Normalized once, here, so the same visible string always hashes identically.
    const text = (dimension.text as string).normalize('NFC').replace(/\r?\n/g, '\n').trim()
    assertDomain(
      text.length >= 1 && text.length <= SUBTITLE_SEGMENT_OVERRIDE_TEXT_MAX,
      'INVALID_ARGUMENT',
      `dimensions[${index}].text must have between 1 and ${SUBTITLE_SEGMENT_OVERRIDE_TEXT_MAX} characters`,
    )
    return Object.freeze({ kind: 'text' as const, text })
  }
  exactKeys(dimension, ['kind', 'visible'], `dimensions[${index}]`)
  assertDomain(typeof dimension.visible === 'boolean', 'INVALID_ARGUMENT', `dimensions[${index}].visible is invalid`)
  return Object.freeze({ kind: 'visibility' as const, visible: dimension.visible })
}

/**
 * Canonical dimension list: at most one entry per kind, ordered by the declared kind
 * order so two requests that mean the same exception produce the same content address.
 */
export function normalizeSubtitleSegmentOverrideDimensions(
  value: unknown,
): readonly SubtitleSegmentOverrideDimension[] {
  assertDomain(Array.isArray(value), 'INVALID_ARGUMENT', 'dimensions must be an array')
  assertDomain(
    value.length <= SUBTITLE_SEGMENT_OVERRIDE_KINDS.length,
    'INVALID_ARGUMENT',
    'dimensions cannot exceed one entry per overridable dimension',
  )
  const parsed = value.map((entry, index) => parseDimension(entry, index))
  const kinds = parsed.map((entry) => entry.kind)
  assertDomain(new Set(kinds).size === kinds.length, 'INVALID_ARGUMENT', 'dimensions cannot repeat a kind')
  return Object.freeze(
    [...parsed].toSorted(
      (left, right) =>
        SUBTITLE_SEGMENT_OVERRIDE_KINDS.indexOf(left.kind) - SUBTITLE_SEGMENT_OVERRIDE_KINDS.indexOf(right.kind),
    ),
  )
}

export function createSubtitleSegmentOverride(
  input: Omit<SubtitleSegmentOverride, 'schemaVersion' | 'overrideHash' | 'dimensions' | 'range'> & {
    dimensions: readonly unknown[]
    range: unknown
  },
): Readonly<SubtitleSegmentOverride> {
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    commandId: input.commandId,
    variantId: input.variantId,
    segmentId: input.segmentId,
  })) identifier(value, field)
  assertDomain(
    SUBTITLE_SEGMENT_OVERRIDE_ACTIONS.includes(input.action),
    'INVALID_ARGUMENT',
    'Subtitle segment override action is invalid',
  )
  assertDomain(
    input.previousOverrideId === null ||
      (typeof input.previousOverrideId === 'string' && ID.test(input.previousOverrideId)),
    'INVALID_ARGUMENT',
    'Subtitle segment override previousOverrideId is invalid',
  )
  assertDomain(
    input.previousOverrideId !== input.id,
    'INVALID_ARGUMENT',
    'Subtitle segment override cannot replace itself',
  )
  assertDomain(
    input.action !== 'reset' || input.previousOverrideId !== null,
    'INVALID_ARGUMENT',
    'A reset must cite the override it replaced',
  )
  const range = requireSubtitleSegmentOverrideRange(input.range)
  const dimensions = normalizeSubtitleSegmentOverrideDimensions(input.dimensions)
  assertDomain(
    input.action !== 'set' || dimensions.length > 0,
    'INVALID_ARGUMENT',
    'A set must move at least one subtitle dimension',
  )
  assertDomain(typeof input.protected === 'boolean', 'INVALID_ARGUMENT', 'Subtitle segment override protected is invalid')
  // An inherited segment carries no value, so there is nothing protection could
  // preserve across a recompilation.
  assertDomain(
    dimensions.length > 0 || input.protected === false,
    'INVALID_ARGUMENT',
    'An inherited subtitle segment cannot be protected',
  )
  assertDomain(!Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'Subtitle segment override createdAt is invalid')
  const body = Object.freeze({
    schemaVersion: 'subtitle-segment-override/v1' as const,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    commandId: input.commandId,
    variantId: input.variantId,
    segmentId: input.segmentId,
    range,
    action: input.action,
    dimensions,
    protected: input.protected,
    previousOverrideId: input.previousOverrideId,
    createdAt: input.createdAt,
  })
  return Object.freeze({ ...body, overrideHash: calculateCanonicalHash(body) })
}

/**
 * Re-derives a stored override through its own constructor. A hand-edited row, a
 * copied style token or a widened range changes `overrideHash` and is rejected here.
 */
export function requirePersistedSubtitleSegmentOverride(
  value: Readonly<SubtitleSegmentOverride>,
): Readonly<SubtitleSegmentOverride> {
  const { schemaVersion, overrideHash, ...input } = value
  assertDomain(
    schemaVersion === 'subtitle-segment-override/v1',
    'INVALID_RENDER_INPUT',
    'Subtitle segment override schema is unsupported',
  )
  assertDomain(typeof overrideHash === 'string' && SHA256.test(overrideHash), 'INVALID_RENDER_INPUT', 'Subtitle segment override hash is invalid')
  const recreated = createSubtitleSegmentOverride(input)
  assertDomain(
    recreated.overrideHash === overrideHash,
    'INVALID_RENDER_INPUT',
    'Persisted subtitle segment override does not match its hash',
  )
  return recreated
}

/**
 * Dimensions a `reset` re-applies on one (variant, segment).
 *
 * The segment returns to the level it carried before the current override. When the
 * current override is the first one, the previous level is the inherited main
 * resolution — an empty dimension list — and the exception disappears without a
 * single row being deleted.
 */
export function resolveSubtitleSegmentOverrideResetTarget(input: {
  current?: Readonly<SubtitleSegmentOverride> | null
  previous?: Readonly<SubtitleSegmentOverride> | null
}): Readonly<{ dimensions: readonly SubtitleSegmentOverrideDimension[]; protected: boolean }> {
  assertDomain(!!input.current, 'INVALID_ARGUMENT', 'There is no subtitle segment override to reset on this segment')
  const previous = input.previous ?? null
  if (!previous) return Object.freeze({ dimensions: Object.freeze([]), protected: false })
  assertDomain(previous.id !== input.current!.id, 'INVALID_ARGUMENT', 'Subtitle segment override reset target cannot be the current override')
  assertDomain(
    previous.variantId === input.current!.variantId && previous.segmentId === input.current!.segmentId,
    'INVALID_ARGUMENT',
    'Subtitle segment override reset target belongs to another segment',
  )
  return Object.freeze({ dimensions: previous.dimensions, protected: previous.protected })
}

/* -------------------------------------------------------------------------- */
/* Application to compiled cues                                               */
/* -------------------------------------------------------------------------- */

export interface SubtitleSegmentCue {
  id: string
  startFrame: number
  /** Exclusive. */
  endFrame: number
  text: string
  anchor?: SubtitleAnchor
  presetId?: SubtitlePresetId
}

/** Why an override did not reach a cue. Every skip is reported, never swallowed. */
export const SUBTITLE_SEGMENT_OVERRIDE_SKIP_REASONS = [
  'variant-mismatch',
  'segment-missing',
  'range-mismatch',
  'inherited',
  'unprotected-recompilation',
] as const
export type SubtitleSegmentOverrideSkipReason = (typeof SUBTITLE_SEGMENT_OVERRIDE_SKIP_REASONS)[number]

export interface SubtitleSegmentOverrideApplication<TCue extends SubtitleSegmentCue> {
  cues: readonly TCue[]
  applied: readonly Readonly<{ overrideId: string; segmentId: string; kinds: readonly SubtitleSegmentOverrideKind[] }>[]
  skipped: readonly Readonly<{ overrideId: string; segmentId: string; reason: SubtitleSegmentOverrideSkipReason }>[]
  /** Cues removed because a visibility override hid them. */
  hiddenSegmentIds: readonly string[]
}

/**
 * Applies persisted overrides to the cues the compiler produced for ONE variant.
 *
 * The two divergence cases the contract has to answer explicitly:
 *
 * - **variant divergence** — an override authored for another variant is a recorded
 *   no-op here. It is never widened into a global change, and the write path
 *   (`applySubtitleSegmentOverrideService`) refuses to create one in the first
 *   place, so a divergent variant can only ever be legacy data or a replay.
 * - **range divergence** — the override names a half-open range; if the compiled
 *   segment no longer occupies exactly that range, the exception is a recorded
 *   no-op rather than a guess about which frames the operator meant.
 *
 * `onlyProtected` is the recompilation path: after an automatic recompilation only
 * the exceptions explicitly marked `protected` survive.
 */
export function applySubtitleSegmentOverrides<TCue extends SubtitleSegmentCue>(input: {
  cues: readonly TCue[]
  overrides: readonly Readonly<SubtitleSegmentOverride>[]
  variantId: string
  onlyProtected?: boolean
}): Readonly<SubtitleSegmentOverrideApplication<TCue>> {
  const variantId = identifier(input.variantId, 'variantId')
  const applied: { overrideId: string; segmentId: string; kinds: readonly SubtitleSegmentOverrideKind[] }[] = []
  const skipped: { overrideId: string; segmentId: string; reason: SubtitleSegmentOverrideSkipReason }[] = []
  const hidden = new Set<string>()
  const cues = new Map(input.cues.map((cue) => [cue.id, { ...cue }]))
  assertDomain(cues.size === input.cues.length, 'INVALID_ARGUMENT', 'Compiled subtitle segments must have unique ids')

  for (const stored of input.overrides) {
    const override = requirePersistedSubtitleSegmentOverride(stored)
    const note = (reason: SubtitleSegmentOverrideSkipReason) =>
      skipped.push({ overrideId: override.id, segmentId: override.segmentId, reason })
    if (override.variantId !== variantId) { note('variant-mismatch'); continue }
    if (override.dimensions.length === 0) { note('inherited'); continue }
    if (input.onlyProtected === true && !override.protected) { note('unprotected-recompilation'); continue }
    const cue = cues.get(override.segmentId)
    if (!cue) { note('segment-missing'); continue }
    if (cue.startFrame !== override.range.startFrame || cue.endFrame !== override.range.endFrame) {
      note('range-mismatch'); continue
    }
    for (const dimension of override.dimensions) {
      if (dimension.kind === 'position') cue.anchor = dimension.anchor
      else if (dimension.kind === 'style') cue.presetId = dimension.presetId
      else if (dimension.kind === 'text') cue.text = dimension.text
      else if (dimension.visible) hidden.delete(cue.id)
      else hidden.add(cue.id)
    }
    applied.push({
      overrideId: override.id,
      segmentId: override.segmentId,
      kinds: Object.freeze(override.dimensions.map((dimension) => dimension.kind)),
    })
  }

  return Object.freeze({
    cues: Object.freeze(
      input.cues
        .filter((cue) => !hidden.has(cue.id))
        .map((cue) => Object.freeze(cues.get(cue.id) as TCue)),
    ),
    applied: Object.freeze(applied.map((entry) => Object.freeze(entry))),
    skipped: Object.freeze(skipped.map((entry) => Object.freeze(entry))),
    hiddenSegmentIds: Object.freeze([...hidden].toSorted()),
  })
}

/**
 * Recompilation path. An automatic recompilation replaces the cues the Director
 * produced; the exceptions the operator marked `protected` are then re-applied on
 * top of the fresh result, which is what "protected survives a recompilation" means
 * in practice. Unprotected exceptions are dropped and reported, never silently kept.
 */
export function reapplyProtectedSubtitleSegmentOverrides<TCue extends SubtitleSegmentCue>(input: {
  recompiledCues: readonly TCue[]
  overrides: readonly Readonly<SubtitleSegmentOverride>[]
  variantId: string
}): Readonly<SubtitleSegmentOverrideApplication<TCue>> {
  return applySubtitleSegmentOverrides({
    cues: input.recompiledCues,
    overrides: input.overrides,
    variantId: input.variantId,
    onlyProtected: true,
  })
}
