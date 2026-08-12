import { readFile } from 'node:fs/promises'

import type { ImageVisionProvider } from '../../application/ports/image-analysis.ts'
import type {
  ImageDetectedEntity,
  ImageObservation,
  ImageOcrRegion,
  NormalizedImageBox,
} from '../../domain/image-analysis.ts'
import { DomainError } from '../../domain/errors.ts'

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

interface Vertex { x?: unknown; y?: unknown }
interface Annotation {
  name?: unknown
  score?: unknown
  detectionConfidence?: unknown
  boundingPoly?: {
    vertices?: Vertex[]
    normalizedVertices?: Vertex[]
  }
}

interface VisionPayload {
  responses?: Array<{
    error?: { code?: unknown; message?: unknown }
    faceAnnotations?: Annotation[]
    localizedObjectAnnotations?: Annotation[]
  }>
}

function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizedBox(
  vertices: readonly Vertex[] | undefined,
  dimensions: { width: number; height: number },
  normalized: boolean,
): NormalizedImageBox | undefined {
  if (!Array.isArray(vertices) || vertices.length < 2) return undefined
  const points = vertices.map((vertex) => {
    const x = finite(vertex.x) ?? 0
    const y = finite(vertex.y) ?? 0
    return {
      x: normalized ? x : x / dimensions.width,
      y: normalized ? y : y / dimensions.height,
    }
  })
  if (points.some((point) =>
    point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return undefined
  const left = Math.min(...points.map((point) => point.x))
  const top = Math.min(...points.map((point) => point.y))
  const right = Math.max(...points.map((point) => point.x))
  const bottom = Math.max(...points.map((point) => point.y))
  if (right <= left || bottom <= top) return undefined
  return Object.freeze([left, top, right - left, bottom - top])
}

function entities(
  annotations: readonly Annotation[] | undefined,
  input: { width: number; height: number; kind: 'face' | 'object' },
): readonly ImageDetectedEntity[] {
  if (annotations === undefined) return Object.freeze([])
  if (!Array.isArray(annotations)) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'Image entity provider returned invalid annotations',
    )
  }
  return Object.freeze(annotations.map((annotation) => {
    const confidence = finite(
      input.kind === 'face' ? annotation.detectionConfidence : annotation.score,
    )
    const label = input.kind === 'face'
      ? 'face'
      : typeof annotation.name === 'string' ? annotation.name.trim() : ''
    const box = normalizedBox(
      input.kind === 'face'
        ? annotation.boundingPoly?.vertices
        : annotation.boundingPoly?.normalizedVertices,
      input,
      input.kind === 'object',
    )
    if (!label || confidence === undefined || confidence < 0 || confidence > 1 || !box) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Image entity provider returned an invalid observation',
      )
    }
    return Object.freeze({ label, box, confidence })
  }).toSorted((left, right) =>
    left.box[1] - right.box[1] ||
    left.box[0] - right.box[0] ||
    left.label.localeCompare(right.label)))
}

function available<T>(
  values: readonly T[],
  model: string,
): Readonly<ImageObservation<T>> {
  return Object.freeze({
    state: 'available',
    values,
    producer: Object.freeze({
      provider: 'google-cloud-vision',
      model,
      version: 'v1',
    }),
    reasonCodes: Object.freeze([]),
  })
}

function unavailable<T>(reason: string): Readonly<ImageObservation<T>> {
  return Object.freeze({
    state: 'unavailable',
    values: Object.freeze([]),
    producer: Object.freeze({
      provider: 'google-cloud-vision',
      model: 'unsupported',
      version: 'v1',
    }),
    reasonCodes: Object.freeze([reason]),
  })
}

export class GoogleCloudImageVisionProvider implements ImageVisionProvider {
  private readonly apiKey: string
  private readonly fetcher: typeof fetch

  constructor(input: { apiKey: string; fetchImplementation?: typeof fetch }) {
    if (input.apiKey.trim().length < 20) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Google Cloud Vision credential is not configured',
      )
    }
    this.apiKey = input.apiKey.trim()
    this.fetcher = input.fetchImplementation ?? fetch
  }

  async analyze(input: Parameters<ImageVisionProvider['analyze']>[0]) {
    const bytes = await readFile(input.sourcePath)
    if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Image entity analysis requires at most 20 MB',
      )
    }
    let response: Response
    try {
      response = await this.fetcher(`${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: bytes.toString('base64') },
            features: [
              { type: 'FACE_DETECTION', maxResults: 50 },
              { type: 'OBJECT_LOCALIZATION', maxResults: 50 },
            ],
          }],
        }),
        signal: input.signal ?? AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        (error as Error).name === 'AbortError'
          ? 'Image entity analysis was cancelled'
          : 'Image entity provider request failed',
      )
    }
    if (!response.ok) {
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        `Image entity provider returned HTTP ${response.status}`,
      )
    }
    let payload: VisionPayload
    try { payload = await response.json() as VisionPayload } catch {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Image entity provider returned invalid JSON',
      )
    }
    const result = payload.responses?.[0]
    if (!result || result.error) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Image entity provider returned an incomplete result',
      )
    }
    const faces = entities(result.faceAnnotations, {
      width: input.width,
      height: input.height,
      kind: 'face',
    })
    const objects = entities(result.localizedObjectAnnotations, {
      width: input.width,
      height: input.height,
      kind: 'object',
    })
    const inferredTags = objects.map((entity) => Object.freeze({
      value: entity.label.toLocaleLowerCase(),
      confidence: entity.confidence,
      provenance: 'google-cloud-vision:object-localization@v1:object',
    }))
    return Object.freeze({
      ocr: unavailable<ImageOcrRegion>('OCR_PROVIDER_NOT_SUPPORTED'),
      faces: available(faces, 'face-detection'),
      objects: available(objects, 'object-localization'),
      inferredTags: Object.freeze(inferredTags),
    })
  }
}
