import { DomainError } from './errors.ts'

export interface OcrRegion { text: string; language: string; box: readonly [number, number, number, number]; confidence: number }
export interface ImageObservationInput {
  assetId: string; width: number; height: number; colors: readonly string[]; faces: readonly { label?: string; confidence: number }[]
  objects: readonly { label: string; confidence: number }[]; ocrRegions: readonly OcrRegion[]; model: string; modelVersion: string
}
export interface ImageCatalogRecord {
  assetId: string; dimensions: { width: number; height: number }; orientation: 'portrait' | 'landscape' | 'square'
  colors: readonly string[]; faces: ImageObservationInput['faces']; objects: ImageObservationInput['objects']; ocrRegions: readonly OcrRegion[]
  observedDescription: string; inferredTags: readonly { value: string; provenance: string; confidence: number }[]
  provenance: { source: 'image-analysis'; model: string; modelVersion: string }; derivatives: readonly { kind: 'thumbnail' | 'preview'; immutableOriginal: true; recipe: string }[]
}

export function catalogImage(input: ImageObservationInput): Readonly<ImageCatalogRecord> {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) throw new DomainError('INVALID_ARGUMENT', 'Image dimensions must be positive integers')
  const orientation = input.width === input.height ? 'square' : input.width > input.height ? 'landscape' : 'portrait'
  const visible = [...input.objects.map((value) => value.label), ...input.ocrRegions.map((value) => `texto “${value.text}”`)]
  const observedDescription = visible.length ? `Imagem ${orientation} com ${visible.join(', ')}.` : `Imagem ${orientation} sem objetos ou texto detectados.`
  const inferredTags = [...input.objects.map((value) => ({ value: value.label, provenance: `${input.model}@${input.modelVersion}:object`, confidence: value.confidence })), ...input.ocrRegions.flatMap((region) => region.text.toLocaleLowerCase().split(/\s+/u).filter((word) => word.length >= 4).map((word) => ({ value: word, provenance: `${input.model}@${input.modelVersion}:ocr:${region.language}`, confidence: region.confidence })))]
  return Object.freeze({ assetId: input.assetId, dimensions: Object.freeze({ width: input.width, height: input.height }), orientation, colors: Object.freeze([...input.colors]), faces: Object.freeze([...input.faces]), objects: Object.freeze([...input.objects]), ocrRegions: Object.freeze([...input.ocrRegions]), observedDescription, inferredTags: Object.freeze(inferredTags), provenance: Object.freeze({ source: 'image-analysis' as const, model: input.model, modelVersion: input.modelVersion }), derivatives: Object.freeze([{ kind: 'thumbnail' as const, immutableOriginal: true as const, recipe: 'image-thumbnail/v1' }, { kind: 'preview' as const, immutableOriginal: true as const, recipe: 'image-preview/v1' }]) })
}

export type ImageUsage = 'b-roll' | 'insert' | 'card'
export function searchImages(records: readonly ImageCatalogRecord[], query: { text: string; usage: ImageUsage }): readonly { record: ImageCatalogRecord; usage: ImageUsage; score: number }[] {
  const terms = query.text.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  return records.map((record) => ({ record, usage: query.usage, score: terms.filter((term) => `${record.observedDescription} ${record.inferredTags.map((tag) => tag.value).join(' ')}`.toLocaleLowerCase().includes(term)).length / Math.max(terms.length, 1) })).filter((match) => match.score > 0).toSorted((a, b) => b.score - a.score)
}

export const IMAGE_EVAL_FIXTURES = Object.freeze([
  { id: 'no-text', ocr: [], expected: 'sem texto detectado' },
  { id: 'small-text', ocr: [{ text: 'Oferta válida hoje', language: 'pt-BR', box: [0.7, 0.8, 0.2, 0.05], confidence: 0.61 }], expected: 'Oferta válida hoje' },
  { id: 'multilingual', ocr: [{ text: 'Olá', language: 'pt-BR', box: [0, 0, 0.2, 0.1], confidence: 0.97 }, { text: 'Welcome', language: 'en', box: [0, 0.2, 0.3, 0.1], confidence: 0.96 }], expected: 'Welcome' }
])
