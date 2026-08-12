import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError, assertDomain } from './errors.ts'
import type { ImageAnalysis } from './image-analysis.ts'

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

export interface ImageReuseSearchQuery {
  workspaceId: string
  text: string
  usage: ImageUsage
  limit?: number
}

export interface ReusableImageCandidateInput {
  analysis: Readonly<ImageAnalysis>
  label: string
  rightsSnapshotId: string
  rightsSnapshotHash: string
  rightsValidUntil: string
}

export interface ImageReuseCandidate {
  artifactId: string
  manifestId: string
  analysisId: string
  analysisHash: string
  label: string
  usage: ImageUsage
  score: number
  matchedTerms: readonly string[]
  orientation: ImageAnalysis['orientation']
  previewArtifactId: string
  rightsSnapshotId: string
  rightsSnapshotHash: string
  rightsValidUntil: string
}

export interface ImageReuseReference {
  schemaVersion: 'image-reuse-reference/v1'
  id: string
  workspaceId: string
  projectId: string
  artifactId: string
  manifestId: string
  mediaAssetReferenceId: string
  analysisId: string
  analysisHash: string
  rightsSnapshotId: string
  rightsSnapshotHash: string
  usage: ImageUsage
  query: string
  score: number
  bytesDuplicated: false
  lineageHash: string
  replayed: boolean
  createdAt: string
}

const REUSE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function normalizeSearchText(value: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', 'Image search text must be a string')
  const normalized = value.trim().toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ')
  assertDomain(normalized.length >= 2 && normalized.length <= 240 && !normalized.includes('\n'), 'INVALID_ARGUMENT', 'Image search text must contain 2 to 240 characters')
  return normalized
}

export function normalizeImageReuseSearchQuery(query: ImageReuseSearchQuery): Readonly<Required<ImageReuseSearchQuery>> {
  const workspaceId = query.workspaceId.trim()
  assertDomain(REUSE_ID.test(workspaceId), 'INVALID_ARGUMENT', 'Image search workspaceId is invalid')
  assertDomain(['b-roll', 'insert', 'card'].includes(query.usage), 'INVALID_ARGUMENT', 'Image search usage is invalid')
  const limit = query.limit ?? 12
  assertDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'INVALID_ARGUMENT', 'Image search limit must be between 1 and 50')
  return Object.freeze({ workspaceId, text: normalizeSearchText(query.text), usage: query.usage, limit })
}

function searchTerms(text: string): readonly string[] {
  return Object.freeze([...new Set(text.split(/[\s,.;:!?()[\]{}"'/-]+/u).filter((term) => term.length >= 2))])
}

function purposeScore(analysis: Readonly<ImageAnalysis>, usage: ImageUsage): number {
  const ocrArea = analysis.ocr.state === 'available'
    ? analysis.ocr.values.reduce((total, region) => total + region.box[2] * region.box[3], 0)
    : 0
  const hasObjects = analysis.objects.state === 'available' && analysis.objects.values.length > 0
  const hasFaces = analysis.faces.state === 'available' && analysis.faces.values.length > 0
  if (usage === 'card') return Math.min(1, (ocrArea * 4) + (analysis.ocr.values.some((region) => region.importance === 'high') ? 0.35 : 0.05))
  if (usage === 'b-roll') return Math.max(0, Math.min(1, (hasObjects ? 0.55 : 0.15) + (hasFaces ? 0.25 : 0) + (ocrArea <= 0.08 ? 0.2 : -0.25)))
  return Math.max(0, Math.min(1, (hasObjects ? 0.45 : 0.15) + (hasFaces ? 0.15 : 0) + (ocrArea > 0 && ocrArea <= 0.25 ? 0.25 : 0.1)))
}

export function rankReusableImages(
  rawQuery: ImageReuseSearchQuery,
  candidates: readonly ReusableImageCandidateInput[],
): readonly ImageReuseCandidate[] {
  const query = normalizeImageReuseSearchQuery(rawQuery)
  const terms = searchTerms(query.text)
  return candidates.map((candidate) => {
    assertDomain(candidate.analysis.workspaceId === query.workspaceId, 'INVALID_ARGUMENT', 'Image candidate belongs to another workspace')
    assertDomain(candidate.analysis.artifactId.length > 0 && candidate.rightsSnapshotId.length > 0 && /^[a-f0-9]{64}$/.test(candidate.rightsSnapshotHash), 'INVALID_ARGUMENT', 'Image candidate rights evidence is invalid')
    const searchable = `${candidate.label} ${candidate.analysis.observedDescription} ${candidate.analysis.inferredTags.map((tag) => tag.value).join(' ')} ${candidate.analysis.ocr.values.map((region) => region.text).join(' ')}`.toLocaleLowerCase('pt-BR')
    const matchedTerms = Object.freeze(terms.filter((term) => searchable.includes(term)))
    const lexical = matchedTerms.length / terms.length
    const confidence = candidate.analysis.inferredTags
      .filter((tag) => matchedTerms.some((term) => tag.value.includes(term)))
      .reduce((highest, tag) => Math.max(highest, tag.confidence), 0)
    const score = Number((lexical * 0.65 + confidence * 0.1 + purposeScore(candidate.analysis, query.usage) * 0.25).toFixed(6))
    return Object.freeze({
      artifactId: candidate.analysis.artifactId,
      manifestId: candidate.analysis.manifestId,
      analysisId: candidate.analysis.id,
      analysisHash: candidate.analysis.analysisHash,
      label: candidate.label,
      usage: query.usage,
      score,
      matchedTerms,
      orientation: candidate.analysis.orientation,
      previewArtifactId: candidate.analysis.derivatives.previewArtifactId,
      rightsSnapshotId: candidate.rightsSnapshotId,
      rightsSnapshotHash: candidate.rightsSnapshotHash,
      rightsValidUntil: candidate.rightsValidUntil,
    })
  }).filter((candidate) => candidate.matchedTerms.length > 0)
    .toSorted((left, right) => right.score - left.score || left.artifactId.localeCompare(right.artifactId))
    .slice(0, query.limit)
}

export function imageReuseLineage(input: Omit<ImageReuseReference, 'schemaVersion' | 'id' | 'lineageHash' | 'replayed' | 'bytesDuplicated' | 'createdAt'>): string {
  return calculateCanonicalHash({ schemaVersion: 'image-reuse-lineage/v1', ...input })
}
