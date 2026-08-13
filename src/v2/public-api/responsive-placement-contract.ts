import { DomainError } from '../domain/errors.ts'
import { createOutputSpec, type OutputAspectRatio } from '../domain/output-spec.ts'
import type {
  PlacementAnchor,
  PlacementElement,
  PlacementKind,
  ProtectedPlacementRegion,
  ProtectedRegionKind,
  ResponsivePlacementInput,
} from '../domain/responsive-output.ts'

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  const parsed = value as Record<string, unknown>
  if (Object.keys(parsed).some((key) => !keys.includes(key))) throw new DomainError('INVALID_ARGUMENT', `${field} contains an unsupported field`)
  return parsed
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 128) throw new DomainError('INVALID_ARGUMENT', `${field} must be bounded text`)
  return value.trim()
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be finite`)
  return value
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an integer`)
  return value as number
}

function member<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new DomainError('INVALID_ARGUMENT', `${field} is unsupported`)
  return value as T
}

function placementElement(value: unknown, index: number): PlacementElement {
  const field = `elements[${index}]`
  const item = record(value, field, ['id', 'kind', 'anchor', 'priority', 'readingOrder', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'])
  return {
    id: text(item.id, `${field}.id`),
    kind: member(item.kind, `${field}.kind`, ['subtitle', 'logo', 'cta', 'insert']) as PlacementKind,
    anchor: member(item.anchor, `${field}.anchor`, ['auto', 'top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right']) as PlacementAnchor,
    priority: integer(item.priority, `${field}.priority`), readingOrder: integer(item.readingOrder, `${field}.readingOrder`),
    minWidth: finite(item.minWidth, `${field}.minWidth`), maxWidth: finite(item.maxWidth, `${field}.maxWidth`),
    minHeight: finite(item.minHeight, `${field}.minHeight`), maxHeight: finite(item.maxHeight, `${field}.maxHeight`),
  }
}

function protectedRegion(value: unknown, index: number): ProtectedPlacementRegion {
  const field = `protectedRegions[${index}]`
  const item = record(value, field, ['id', 'kind', 'x', 'y', 'width', 'height'])
  return {
    id: text(item.id, `${field}.id`), kind: member(item.kind, `${field}.kind`, ['face', 'roi', 'reading-order']) as ProtectedRegionKind,
    x: finite(item.x, `${field}.x`), y: finite(item.y, `${field}.y`), width: finite(item.width, `${field}.width`), height: finite(item.height, `${field}.height`),
  }
}

export function parseResponsivePlacementBody(value: unknown): ResponsivePlacementInput {
  const body = record(value, 'body', ['outputSpec', 'elements', 'protectedRegions'])
  const output = record(body.outputSpec, 'body.outputSpec', ['schemaVersion', 'id', 'locale', 'aspectRatio', 'width', 'height', 'fps', 'safeArea', 'deliveryProfileId'])
  const safe = record(output.safeArea, 'body.outputSpec.safeArea', ['top', 'right', 'bottom', 'left'])
  if (!Array.isArray(body.elements) || body.elements.length < 1 || body.elements.length > 64) throw new DomainError('INVALID_ARGUMENT', 'body.elements must be a bounded array')
  if (body.protectedRegions !== undefined && (!Array.isArray(body.protectedRegions) || body.protectedRegions.length > 128)) throw new DomainError('INVALID_ARGUMENT', 'body.protectedRegions must be a bounded array')
  if (output.schemaVersion !== 1) throw new DomainError('INVALID_ARGUMENT', 'body.outputSpec.schemaVersion is unsupported')
  return {
    spec: createOutputSpec({
      id: text(output.id, 'body.outputSpec.id'), locale: text(output.locale, 'body.outputSpec.locale'),
      aspectRatio: member(output.aspectRatio, 'body.outputSpec.aspectRatio', ['9:16', '16:9', '4:5', '1:1', '21:9']) as OutputAspectRatio,
      width: integer(output.width, 'body.outputSpec.width'), height: integer(output.height, 'body.outputSpec.height'), fps: integer(output.fps, 'body.outputSpec.fps'),
      safeArea: { top: finite(safe.top, 'body.outputSpec.safeArea.top'), right: finite(safe.right, 'body.outputSpec.safeArea.right'), bottom: finite(safe.bottom, 'body.outputSpec.safeArea.bottom'), left: finite(safe.left, 'body.outputSpec.safeArea.left') },
      ...(output.deliveryProfileId === undefined ? {} : { deliveryProfileId: text(output.deliveryProfileId, 'body.outputSpec.deliveryProfileId') }),
    }),
    elements: body.elements.map(placementElement),
    protectedRegions: (body.protectedRegions as unknown[] | undefined)?.map(protectedRegion) ?? [],
  }
}
