import { assertDomain } from '../domain/errors.ts'
import {
  TRANSFORMATION_FALLBACKS,
  TRANSFORMATION_INTENTS,
  TRANSFORMATION_MODES,
  TRANSFORMATION_PRESERVES,
  type TransformationBrief,
} from '../domain/transformation-brief.ts'
import type { TransformationProviderSelection } from '../domain/transformation-provider-registry.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim().length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}

function stringArray(value: unknown, field: string, maximum = 32): readonly string[] {
  assertDomain(Array.isArray(value) && value.length <= maximum, 'INVALID_ARGUMENT', `${field} must be a bounded array`)
  return Object.freeze(value.map((entry, index) => string(entry, `${field}[${index}]`)))
}

function integer(value: unknown, field: string, min: number, max: number): number {
  assertDomain(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, 'INVALID_ARGUMENT', `${field} is out of range`)
  return value as number
}

const BRIEF_KEYS = [
  'projectVersionId', 'storyPlanId', 'storyPlanHash', 'sourceArtifactId', 'sourceArtifactHash',
  'sourceRange', 'intent', 'editorialIntent', 'mode', 'prompt', 'negativeConstraints',
  'preserve', 'allowedChanges', 'target', 'outputSpecIds', 'intensityBps', 'noveltyBps',
  'safety', 'safeZones', 'fallbackLadder', 'rightsSnapshotId', 'rightsSnapshotHash',
  'identitySnapshotId', 'identitySnapshotHash',
]

export function parseCreateTransformationBriefBody(raw: unknown) {
  const body = record(raw, 'body')
  assertDomain(Object.keys(body).every((key) => BRIEF_KEYS.includes(key)), 'INVALID_ARGUMENT', 'body contains unsupported properties')
  const range = record(body.sourceRange, 'body.sourceRange')
  assertDomain(
    typeof body.intent === 'string' && TRANSFORMATION_INTENTS.includes(body.intent as (typeof TRANSFORMATION_INTENTS)[number]),
    'INVALID_ARGUMENT', 'body.intent is unsupported',
  )
  assertDomain(
    typeof body.mode === 'string' && TRANSFORMATION_MODES.includes(body.mode as (typeof TRANSFORMATION_MODES)[number]),
    'INVALID_ARGUMENT', 'body.mode is unsupported',
  )
  const preserve = stringArray(body.preserve, 'body.preserve')
  assertDomain(
    preserve.every((entry) => TRANSFORMATION_PRESERVES.includes(entry as (typeof TRANSFORMATION_PRESERVES)[number])),
    'INVALID_ARGUMENT', 'body.preserve contains an unsupported value',
  )
  const fallbackLadder = stringArray(body.fallbackLadder, 'body.fallbackLadder', TRANSFORMATION_FALLBACKS.length)
  assertDomain(
    fallbackLadder.every((entry) => TRANSFORMATION_FALLBACKS.includes(entry as (typeof TRANSFORMATION_FALLBACKS)[number])),
    'INVALID_ARGUMENT', 'body.fallbackLadder contains an unsupported step',
  )
  const safeZones = Array.isArray(body.safeZones) ? body.safeZones : []
  assertDomain(safeZones.length <= 32, 'INVALID_ARGUMENT', 'body.safeZones must be a bounded array')
  return Object.freeze({
    projectVersionId: string(body.projectVersionId, 'body.projectVersionId'),
    storyPlanId: string(body.storyPlanId, 'body.storyPlanId'),
    storyPlanHash: string(body.storyPlanHash, 'body.storyPlanHash'),
    sourceArtifactId: string(body.sourceArtifactId, 'body.sourceArtifactId'),
    sourceArtifactHash: string(body.sourceArtifactHash, 'body.sourceArtifactHash'),
    sourceRange: Object.freeze({
      startFrame: integer(range.startFrame, 'body.sourceRange.startFrame', 0, 10_000_000),
      endFrame: integer(range.endFrame, 'body.sourceRange.endFrame', 1, 10_000_000),
    }),
    intent: body.intent as (typeof TRANSFORMATION_INTENTS)[number],
    editorialIntent: string(body.editorialIntent, 'body.editorialIntent'),
    mode: body.mode as (typeof TRANSFORMATION_MODES)[number],
    prompt: string(body.prompt, 'body.prompt'),
    negativeConstraints: stringArray(body.negativeConstraints ?? [], 'body.negativeConstraints'),
    preserve: preserve as never,
    allowedChanges: stringArray(body.allowedChanges ?? [], 'body.allowedChanges'),
    target: Object.freeze({ ...record(body.target ?? {}, 'body.target') }),
    outputSpecIds: stringArray(body.outputSpecIds ?? [], 'body.outputSpecIds'),
    intensityBps: integer(body.intensityBps, 'body.intensityBps', 0, 10_000),
    noveltyBps: integer(body.noveltyBps, 'body.noveltyBps', 0, 10_000),
    safety: stringArray(body.safety ?? [], 'body.safety'),
    safeZones: Object.freeze(safeZones.map((zone, index) => {
      const parsed = record(zone, `body.safeZones[${index}]`)
      return Object.freeze({
        x: parsed.x as number, y: parsed.y as number,
        width: parsed.width as number, height: parsed.height as number,
        purpose: string(parsed.purpose, `body.safeZones[${index}].purpose`) as never,
      })
    })),
    fallbackLadder: fallbackLadder as never,
    rightsSnapshotId: string(body.rightsSnapshotId, 'body.rightsSnapshotId'),
    rightsSnapshotHash: string(body.rightsSnapshotHash, 'body.rightsSnapshotHash'),
    ...(body.identitySnapshotId ? { identitySnapshotId: string(body.identitySnapshotId, 'body.identitySnapshotId') } : {}),
    ...(body.identitySnapshotHash ? { identitySnapshotHash: string(body.identitySnapshotHash, 'body.identitySnapshotHash') } : {}),
  })
}

export function parseRouteTransformationBriefBody(raw: unknown) {
  const body = record(raw, 'body')
  const keys = ['region', 'maximumCostMinorUnits', 'minimumQualityScoreBps', 'output', 'halfOpenProbeProviderId']
  assertDomain(Object.keys(body).every((key) => keys.includes(key)), 'INVALID_ARGUMENT', 'body contains unsupported properties')
  const output = record(body.output, 'body.output')
  return Object.freeze({
    region: string(body.region, 'body.region'),
    maximumCostMinorUnits: integer(body.maximumCostMinorUnits, 'body.maximumCostMinorUnits', 0, 100_000_000),
    minimumQualityScoreBps: integer(body.minimumQualityScoreBps, 'body.minimumQualityScoreBps', 0, 10_000),
    output: Object.freeze({
      width: integer(output.width, 'body.output.width', 1, 16_384),
      height: integer(output.height, 'body.output.height', 1, 16_384),
      fps: integer(output.fps, 'body.output.fps', 1, 240),
      includeAudio: output.includeAudio === true,
    }),
    ...(body.halfOpenProbeProviderId ? { halfOpenProbeProviderId: string(body.halfOpenProbeProviderId, 'body.halfOpenProbeProviderId') } : {}),
  })
}

/**
 * The brief as the outside sees it.
 *
 * `prompt` is deliberately absent: it is untrusted authored text that may carry
 * anything, and the public contract exposes its hash and the structured intent
 * instead. `INTERNAL_ONLY_SURFACES` names `rawPrompt` for exactly this reason.
 */
export function presentTransformationBrief(brief: Readonly<TransformationBrief>) {
  return Object.freeze({
    id: brief.id,
    projectId: brief.projectId,
    projectVersionId: brief.projectVersionId,
    storyPlanId: brief.storyPlanId,
    sourceArtifactId: brief.sourceArtifactId,
    sourceRange: brief.sourceRange,
    intent: brief.intent,
    editorialIntent: brief.editorialIntent,
    mode: brief.mode,
    preserve: brief.preserve,
    allowedChanges: brief.allowedChanges,
    outputSpecIds: brief.outputSpecIds,
    intensityBps: brief.intensityBps,
    durationFrames: brief.durationFrames,
    noveltyBps: brief.noveltyBps,
    safety: brief.safety,
    safeZones: brief.safeZones,
    fallbackLadder: brief.fallbackLadder,
    rightsSnapshotId: brief.rightsSnapshotId,
    createdAt: brief.createdAt,
    briefHash: brief.briefHash,
  })
}

export function presentTransformationSelection(selection: Readonly<TransformationProviderSelection>) {
  return Object.freeze({
    id: selection.id,
    briefId: selection.briefId,
    briefHash: selection.briefHash,
    ...(selection.selectedProviderId ? { selectedProviderId: selection.selectedProviderId } : {}),
    ...(selection.selectedCapabilityId ? { selectedCapabilityId: selection.selectedCapabilityId } : {}),
    selectedReason: selection.selectedReason,
    // Every discarded candidate and its reasons. A routing decision without its
    // rejections is unexplainable the moment anything changes.
    candidates: selection.candidates,
    policy: selection.policy,
    createdAt: selection.createdAt,
    selectionHash: selection.selectionHash,
  })
}
