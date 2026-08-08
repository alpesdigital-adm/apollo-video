import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export type NormalizedImageBox = readonly [number, number, number, number]
export interface ImageObservationProducer { provider: string; model: string; version: string }
export interface ImageObservation<T> {
  state: 'available' | 'unavailable'
  values: readonly T[]
  producer: Readonly<ImageObservationProducer>
  reasonCodes: readonly string[]
}
export interface ImageOcrRegion { text: string; language: string; box: NormalizedImageBox; confidence: number; importance: 'low' | 'medium' | 'high' }
export interface ImageDetectedEntity { label: string; box: NormalizedImageBox; confidence: number }
export interface ImageAnalysis {
  schemaVersion: 'image-analysis/v1'; id: string; workspaceId: string; artifactId: string; manifestId: string; sourceSha256: string
  dimensions: Readonly<{ width: number; height: number }>; orientation: 'portrait' | 'landscape' | 'square'; dominantColors: readonly string[]
  ocr: Readonly<ImageObservation<ImageOcrRegion>>; faces: Readonly<ImageObservation<ImageDetectedEntity>>; objects: Readonly<ImageObservation<ImageDetectedEntity>>
  observedDescription: string; inferredTags: readonly Readonly<{ value: string; confidence: number; provenance: string }>[]
  derivatives: Readonly<{ thumbnailArtifactId: string; previewArtifactId: string; immutableOriginal: true }>; createdAt: string; analysisHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{64}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,95}$/
function box(value: NormalizedImageBox): NormalizedImageBox {
  if (!Array.isArray(value) || value.length !== 4 || value.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 1) || value[2] <= 0 || value[3] <= 0 || value[0] + value[2] > 1.000001 || value[1] + value[3] > 1.000001) throw new DomainError('INVALID_ARGUMENT', 'Image observation box is invalid')
  return Object.freeze([...value]) as NormalizedImageBox
}
function producer(value: ImageObservationProducer) {
  const normalized = { provider: value.provider.trim().toLowerCase(), model: value.model.trim().toLowerCase(), version: value.version.trim().toLowerCase() }
  if (!TOKEN.test(normalized.provider) || !TOKEN.test(normalized.model) || !TOKEN.test(normalized.version)) throw new DomainError('INVALID_ARGUMENT', 'Image observation producer is invalid')
  return Object.freeze(normalized)
}
function observation<T>(value: ImageObservation<T>, map: (entry: T) => T): Readonly<ImageObservation<T>> {
  const values = Object.freeze(value.values.map(map)); const reasonCodes = Object.freeze([...value.reasonCodes].map((reason) => reason.trim().toUpperCase()))
  if ((value.state === 'available' && reasonCodes.length) || (value.state === 'unavailable' && (values.length || reasonCodes.length === 0)) || reasonCodes.some((reason) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(reason))) throw new DomainError('INVALID_ARGUMENT', 'Image observation availability is inconsistent')
  return Object.freeze({ state: value.state, values, producer: producer(value.producer), reasonCodes })
}
function confidence(value: number) { if (!Number.isFinite(value) || value < 0 || value > 1) throw new DomainError('INVALID_ARGUMENT', 'Image observation confidence is invalid'); return value }

export function createImageAnalysis(input: Omit<ImageAnalysis, 'schemaVersion' | 'orientation' | 'analysisHash'>): Readonly<ImageAnalysis> {
  if (![input.id, input.workspaceId, input.artifactId, input.manifestId, input.derivatives.thumbnailArtifactId, input.derivatives.previewArtifactId].every((value) => ID.test(value)) || !SHA.test(input.sourceSha256)) throw new DomainError('INVALID_ARGUMENT', 'Image analysis identity is invalid')
  if (!Number.isSafeInteger(input.dimensions.width) || !Number.isSafeInteger(input.dimensions.height) || input.dimensions.width < 16 || input.dimensions.height < 16 || input.dimensions.width > 100_000 || input.dimensions.height > 100_000) throw new DomainError('INVALID_ARGUMENT', 'Image analysis dimensions are invalid')
  const dimensions = Object.freeze({ ...input.dimensions }); const orientation = dimensions.width === dimensions.height ? 'square' as const : dimensions.width > dimensions.height ? 'landscape' as const : 'portrait' as const
  const dominantColors = Object.freeze([...input.dominantColors].map((value) => value.toLowerCase()))
  if (!dominantColors.length || dominantColors.length > 8 || dominantColors.some((value) => !/^#[a-f0-9]{6}$/.test(value))) throw new DomainError('INVALID_ARGUMENT', 'Image dominant colors are invalid')
  const ocr = observation(input.ocr, (entry) => { const text = entry.text.trim(); if (!text || text.length > 2000 || !/^[a-z]{2}(?:-[A-Z]{2})?$|^und$/.test(entry.language)) throw new DomainError('INVALID_ARGUMENT', 'OCR region is invalid'); return Object.freeze({ ...entry, text, box: box(entry.box), confidence: confidence(entry.confidence) }) })
  const entity = (entry: ImageDetectedEntity) => { const label = entry.label.trim(); if (!label || label.length > 120) throw new DomainError('INVALID_ARGUMENT', 'Detected entity label is invalid'); return Object.freeze({ label, box: box(entry.box), confidence: confidence(entry.confidence) }) }
  const faces = observation(input.faces, entity); const objects = observation(input.objects, entity)
  const observedDescription = input.observedDescription.trim(); if (!observedDescription || observedDescription.length > 2000) throw new DomainError('INVALID_ARGUMENT', 'Observed image description is invalid')
  const inferredTags = Object.freeze(input.inferredTags.map((tag) => { const value = tag.value.trim().toLocaleLowerCase(); if (!value || value.length > 120 || !tag.provenance.trim()) throw new DomainError('INVALID_ARGUMENT', 'Inferred image tag is invalid'); return Object.freeze({ value, confidence: confidence(tag.confidence), provenance: tag.provenance.trim() }) }))
  const createdAt = input.createdAt; if (Number.isNaN(Date.parse(createdAt))) throw new DomainError('INVALID_ARGUMENT', 'Image analysis createdAt is invalid')
  const body = { schemaVersion: 'image-analysis/v1' as const, id: input.id, workspaceId: input.workspaceId, artifactId: input.artifactId, manifestId: input.manifestId, sourceSha256: input.sourceSha256, dimensions, orientation, dominantColors, ocr, faces, objects, observedDescription, inferredTags, derivatives: Object.freeze({ ...input.derivatives, immutableOriginal: true as const }), createdAt }
  return Object.freeze({ ...body, analysisHash: calculateCanonicalHash(body) })
}
