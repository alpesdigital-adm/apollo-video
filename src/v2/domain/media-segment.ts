import { DomainError } from './errors.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'

export interface MediaSegment {
  id: string
  workspaceId: string
  parentAssetId: string
  parentSegmentId?: string
  label: string
  description: string
  semanticRange: { startMs: number; endMs: number }
  sourceTimeMapping: { sourceStartMs: number; sourceEndMs: number; rate: 1 }
  physicalObjectKey: null
  sourceDurationMs: number
  segmentHash: string
  createdAt: string
}

export function createMediaSegment(input: {
  id: string; workspaceId: string; parentAssetId: string; parentDurationMs: number; parentSegment?: MediaSegment
  label: string; description?: string; startMs: number; endMs: number; createdAt?: string
}): Readonly<MediaSegment> {
  const label = input.label.trim()
  const description = input.description?.trim() ?? ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.workspaceId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.parentAssetId)) {
    throw new DomainError('INVALID_ARGUMENT', 'Segment identity is invalid')
  }
  if (!label || label.length > 240 || description.length > 1000) throw new DomainError('INVALID_ARGUMENT', 'Segment label or description is invalid')
  if (!Number.isSafeInteger(input.parentDurationMs) || input.parentDurationMs < 1) throw new DomainError('INVALID_ARGUMENT', 'Parent duration is invalid')
  const parentStart = input.parentSegment?.semanticRange.startMs ?? 0
  const parentEnd = input.parentSegment?.semanticRange.endMs ?? input.parentDurationMs
  if (!Number.isInteger(input.startMs) || !Number.isInteger(input.endMs) || input.startMs < parentStart || input.endMs > parentEnd || input.endMs <= input.startMs) {
    throw new DomainError('INVALID_ARGUMENT', 'Segment range must be inside its parent and have positive duration')
  }
  if (input.parentSegment && input.parentSegment.parentAssetId !== input.parentAssetId) throw new DomainError('INVALID_ARGUMENT', 'Nested segment must share the same parent asset')
  const createdAt = input.createdAt ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(createdAt))) throw new DomainError('INVALID_ARGUMENT', 'Segment createdAt is invalid')
  const content = {
    schemaVersion: 'media-segment/v1', workspaceId: input.workspaceId, parentAssetId: input.parentAssetId,
    ...(input.parentSegment ? { parentSegmentId: input.parentSegment.id } : {}), label, description,
    semanticRange: { startMs: input.startMs, endMs: input.endMs }, sourceTimeMapping: { sourceStartMs: input.startMs, sourceEndMs: input.endMs, rate: 1 as const }, sourceDurationMs: input.parentDurationMs,
  }
  return Object.freeze({
    id: input.id, workspaceId: input.workspaceId, parentAssetId: input.parentAssetId, parentSegmentId: input.parentSegment?.id,
    label, description, semanticRange: Object.freeze({ startMs: input.startMs, endMs: input.endMs }),
    sourceTimeMapping: Object.freeze({ sourceStartMs: input.startMs, sourceEndMs: input.endMs, rate: 1 as const }), physicalObjectKey: null,
    sourceDurationMs: input.parentDurationMs, segmentHash: calculateCanonicalHash(content), createdAt,
  })
}

export interface SegmentMaterializationRecipe {
  recipe: 'extract-range/v1'
  sourceAssetId: string
  sourceRangeMs: readonly [number, number]
  outputKey: string
  immutableSource: true
}

export function materializeSegment(segment: MediaSegment, consumer: { requiresPhysicalDerivative: boolean; key: string }): Readonly<SegmentMaterializationRecipe> | null {
  if (!consumer.requiresPhysicalDerivative) return null
  const key = consumer.key.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key)) throw new DomainError('INVALID_ARGUMENT', 'Segment consumer key is invalid')
  const sourceRangeMs: readonly [number, number] = Object.freeze([segment.semanticRange.startMs, segment.semanticRange.endMs])
  return Object.freeze({ recipe: 'extract-range/v1', sourceAssetId: segment.parentAssetId, sourceRangeMs, outputKey: `derivatives/segments/${segment.id}/${key}`, immutableSource: true })
}
