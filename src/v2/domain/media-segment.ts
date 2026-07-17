import { DomainError } from './errors.ts'

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
}

export function createMediaSegment(input: {
  id: string; workspaceId: string; parentAssetId: string; parentDurationMs: number; parentSegment?: MediaSegment
  label: string; description?: string; startMs: number; endMs: number
}): Readonly<MediaSegment> {
  const parentStart = input.parentSegment?.semanticRange.startMs ?? 0
  const parentEnd = input.parentSegment?.semanticRange.endMs ?? input.parentDurationMs
  if (!Number.isInteger(input.startMs) || !Number.isInteger(input.endMs) || input.startMs < parentStart || input.endMs > parentEnd || input.endMs <= input.startMs) {
    throw new DomainError('INVALID_ARGUMENT', 'Segment range must be inside its parent and have positive duration')
  }
  if (input.parentSegment && input.parentSegment.parentAssetId !== input.parentAssetId) throw new DomainError('INVALID_ARGUMENT', 'Nested segment must share the same parent asset')
  return Object.freeze({
    id: input.id, workspaceId: input.workspaceId, parentAssetId: input.parentAssetId, parentSegmentId: input.parentSegment?.id,
    label: input.label.trim(), description: input.description?.trim() ?? '', semanticRange: Object.freeze({ startMs: input.startMs, endMs: input.endMs }),
    sourceTimeMapping: Object.freeze({ sourceStartMs: input.startMs, sourceEndMs: input.endMs, rate: 1 as const }), physicalObjectKey: null
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
  const sourceRangeMs: readonly [number, number] = Object.freeze([segment.semanticRange.startMs, segment.semanticRange.endMs])
  return Object.freeze({ recipe: 'extract-range/v1', sourceAssetId: segment.parentAssetId, sourceRangeMs, outputKey: `derivatives/segments/${segment.id}/${consumer.key}`, immutableSource: true })
}
