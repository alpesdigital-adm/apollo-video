import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const TRANSFORMATION_BRIEF_SCHEMA_VERSION = 'transformation-brief/v1' as const

export const TRANSFORMATION_MODES = Object.freeze([
  'background-replacement',
  'stylization',
  'cutaway',
  'camera-motion',
  'relight',
  'object-environment-change',
] as const)
export type TransformationMode = (typeof TRANSFORMATION_MODES)[number]

export const TRANSFORMATION_INTENTS = Object.freeze([
  'pattern-break',
  'visual-metaphor',
  'demonstration',
  'dramatic-emphasis',
  'world-shift',
  'camera-enhancement',
] as const)
export type TransformationIntent = (typeof TRANSFORMATION_INTENTS)[number]

export const TRANSFORMATION_FALLBACKS = Object.freeze([
  'video-to-video',
  'actor-composite',
  'generated-cutaway',
  'still-parallax',
  'source-unchanged',
] as const)
export type TransformationFallback = (typeof TRANSFORMATION_FALLBACKS)[number]

export const TRANSFORMATION_PRESERVES = Object.freeze([
  'identity', 'lips', 'expression', 'body-motion', 'wardrobe', 'speech',
  'timing', 'foreground', 'background', 'objects', 'text', 'brand', 'audio',
] as const)
export type TransformationPreserve = (typeof TRANSFORMATION_PRESERVES)[number]

export interface TransformationSafeZone {
  x: number
  y: number
  width: number
  height: number
  purpose: 'subject' | 'face' | 'text' | 'brand' | 'protected-object'
}

export interface TransformationBrief {
  schemaVersion: typeof TRANSFORMATION_BRIEF_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  storyPlanId: string
  storyPlanHash: string
  sourceArtifactId: string
  sourceArtifactHash: string
  sourceRange: Readonly<{ startFrame: number; endFrame: number }>
  intent: TransformationIntent
  editorialIntent: string
  mode: TransformationMode
  prompt: string
  negativeConstraints: readonly string[]
  preserve: readonly TransformationPreserve[]
  allowedChanges: readonly string[]
  target: Readonly<Record<string, unknown>>
  outputSpecIds: readonly string[]
  intensityBps: number
  durationFrames: number
  noveltyBps: number
  safety: readonly string[]
  safeZones: readonly Readonly<TransformationSafeZone>[]
  fallbackLadder: readonly TransformationFallback[]
  rightsSnapshotId: string
  rightsSnapshotHash: string
  identitySnapshotId?: string
  identitySnapshotHash?: string
  createdAt: string
  briefHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function hash(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && HASH.test(value), 'INVALID_ARGUMENT', `${field} must be a lowercase SHA-256`)
  return value
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function boundedText(value: unknown, field: string, maximum: number): string {
  assertDomain(typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= maximum, 'INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim().normalize('NFC')
}

function orderedUnique(values: readonly string[], field: string, maximum = 32): readonly string[] {
  assertDomain(Array.isArray(values) && values.length <= maximum, 'INVALID_ARGUMENT', `${field} is invalid`)
  const normalized = values.map((value, index) => boundedText(value, `${field}[${index}]`, 300))
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  return Object.freeze(normalized)
}

function canonicalRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARGUMENT', 'target must be an object')
  // Canonical hashing rejects functions, symbols and non-finite numbers.
  calculateCanonicalHash(value)
  return Object.freeze({ ...value })
}

export function createTransformationBrief(input: Omit<TransformationBrief, 'schemaVersion' | 'id' | 'durationFrames' | 'briefHash'> & { id?: string }): Readonly<TransformationBrief> {
  const startFrame = input.sourceRange.startFrame
  const endFrame = input.sourceRange.endFrame
  assertDomain(Number.isSafeInteger(startFrame) && startFrame >= 0 && Number.isSafeInteger(endFrame) && endFrame > startFrame, 'INVALID_ARGUMENT', 'sourceRange must be a non-empty half-open frame range')
  assertDomain(TRANSFORMATION_INTENTS.includes(input.intent), 'INVALID_ARGUMENT', 'intent is unsupported')
  assertDomain(TRANSFORMATION_MODES.includes(input.mode), 'INVALID_ARGUMENT', 'mode is unsupported')
  assertDomain(Number.isSafeInteger(input.intensityBps) && input.intensityBps >= 0 && input.intensityBps <= 10_000, 'INVALID_ARGUMENT', 'intensityBps is invalid')
  assertDomain(Number.isSafeInteger(input.noveltyBps) && input.noveltyBps >= 0 && input.noveltyBps <= 10_000, 'INVALID_ARGUMENT', 'noveltyBps is invalid')

  const preserve = orderedUnique(input.preserve, 'preserve') as readonly TransformationPreserve[]
  assertDomain(preserve.every((value) => TRANSFORMATION_PRESERVES.includes(value)), 'INVALID_ARGUMENT', 'preserve contains an unsupported value')
  const allowedChanges = orderedUnique(input.allowedChanges, 'allowedChanges')
  assertDomain(!preserve.some((value) => allowedChanges.includes(value)), 'INVALID_ARGUMENT', 'preserve and allowedChanges must be disjoint')
  const fallbackLadder = orderedUnique(input.fallbackLadder, 'fallbackLadder', TRANSFORMATION_FALLBACKS.length) as readonly TransformationFallback[]
  assertDomain(fallbackLadder.length > 0 && fallbackLadder.every((value) => TRANSFORMATION_FALLBACKS.includes(value)), 'INVALID_ARGUMENT', 'fallbackLadder is invalid')
  assertDomain(fallbackLadder.at(-1) === 'source-unchanged', 'INVALID_ARGUMENT', 'fallbackLadder must end with source-unchanged')

  const safeZones = Object.freeze(input.safeZones.map((zone, index) => {
    assertDomain(
      [zone.x, zone.y, zone.width, zone.height].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
        zone.width > 0 && zone.height > 0 && zone.x + zone.width <= 1 && zone.y + zone.height <= 1,
      'INVALID_ARGUMENT',
      `safeZones[${index}] is outside normalized bounds`,
    )
    return Object.freeze({ ...zone })
  }))

  if (preserve.includes('identity')) {
    assertDomain(Boolean(input.identitySnapshotId && input.identitySnapshotHash), 'INVALID_ARGUMENT', 'identity preservation requires an immutable identity snapshot')
  }

  const body = Object.freeze({
    schemaVersion: TRANSFORMATION_BRIEF_SCHEMA_VERSION,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    projectVersionId: identity(input.projectVersionId, 'projectVersionId'),
    storyPlanId: identity(input.storyPlanId, 'storyPlanId'),
    storyPlanHash: hash(input.storyPlanHash, 'storyPlanHash'),
    sourceArtifactId: identity(input.sourceArtifactId, 'sourceArtifactId'),
    sourceArtifactHash: hash(input.sourceArtifactHash, 'sourceArtifactHash'),
    sourceRange: Object.freeze({ startFrame, endFrame }),
    intent: input.intent,
    editorialIntent: boundedText(input.editorialIntent, 'editorialIntent', 500),
    mode: input.mode,
    prompt: boundedText(input.prompt, 'prompt', 2_000),
    negativeConstraints: orderedUnique(input.negativeConstraints, 'negativeConstraints'),
    preserve,
    allowedChanges,
    target: canonicalRecord(input.target),
    outputSpecIds: orderedUnique(input.outputSpecIds.map((value) => identity(value, 'outputSpecId')), 'outputSpecIds'),
    intensityBps: input.intensityBps,
    durationFrames: endFrame - startFrame,
    noveltyBps: input.noveltyBps,
    safety: orderedUnique(input.safety, 'safety'),
    safeZones,
    fallbackLadder,
    rightsSnapshotId: identity(input.rightsSnapshotId, 'rightsSnapshotId'),
    rightsSnapshotHash: hash(input.rightsSnapshotHash, 'rightsSnapshotHash'),
    ...(input.identitySnapshotId ? { identitySnapshotId: identity(input.identitySnapshotId, 'identitySnapshotId') } : {}),
    ...(input.identitySnapshotHash ? { identitySnapshotHash: hash(input.identitySnapshotHash, 'identitySnapshotHash') } : {}),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
  const briefHash = calculateCanonicalHash(body)
  const id = input.id ? identity(input.id, 'id') : `transformation-brief-${briefHash.slice(0, 32)}`
  return Object.freeze({ ...body, id, briefHash })
}

export function assertTransformationBrief(value: Readonly<TransformationBrief>): Readonly<TransformationBrief> {
  const rebuilt = createTransformationBrief({ ...value, id: value.id })
  assertDomain(rebuilt.briefHash === value.briefHash, 'PERSISTENCE_CONFLICT', 'TransformationBrief hash does not match its body')
  return rebuilt
}

/** Provider payload projection. Project/story/rights identities deliberately stay inside Apollo. */
export function projectTransformationProviderInput(brief: Readonly<TransformationBrief>): Readonly<Record<string, unknown>> {
  assertTransformationBrief(brief)
  return Object.freeze({
    schemaVersion: 'transformation-provider-input/v1',
    sourceArtifactHash: brief.sourceArtifactHash,
    sourceRange: brief.sourceRange,
    mode: brief.mode,
    prompt: brief.prompt,
    negativeConstraints: brief.negativeConstraints,
    preserve: brief.preserve,
    allowedChanges: brief.allowedChanges,
    target: brief.target,
    outputSpecIds: brief.outputSpecIds,
    intensityBps: brief.intensityBps,
    durationFrames: brief.durationFrames,
    safeZones: brief.safeZones,
  })
}

export interface StoryPlanTransformationCandidate {
  storyPlanId: string
  storyPlanHash: string
  sourceArtifactId: string
  sourceArtifactHash: string
  sourceRange: Readonly<{ startFrame: number; endFrame: number }>
  intent: TransformationIntent
  editorialIntent: string
  mode: TransformationMode
  prompt: string
  negativeConstraints: readonly string[]
  preserve: readonly TransformationPreserve[]
  allowedChanges: readonly string[]
  target: Readonly<Record<string, unknown>>
  outputSpecIds: readonly string[]
  intensityBps: number
  noveltyBps: number
  safety: readonly string[]
  safeZones: readonly Readonly<TransformationSafeZone>[]
  fallbackLadder: readonly TransformationFallback[]
}

export function createTransformationBriefFromStoryPlan(input: {
  workspaceId: string
  projectId: string
  projectVersionId: string
  candidate: Readonly<StoryPlanTransformationCandidate>
  rightsSnapshotId: string
  rightsSnapshotHash: string
  identitySnapshotId?: string
  identitySnapshotHash?: string
  createdAt: string
}): Readonly<TransformationBrief> {
  return createTransformationBrief({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    ...input.candidate,
    rightsSnapshotId: input.rightsSnapshotId,
    rightsSnapshotHash: input.rightsSnapshotHash,
    ...(input.identitySnapshotId ? { identitySnapshotId: input.identitySnapshotId } : {}),
    ...(input.identitySnapshotHash ? { identitySnapshotHash: input.identitySnapshotHash } : {}),
    createdAt: input.createdAt,
  })
}

