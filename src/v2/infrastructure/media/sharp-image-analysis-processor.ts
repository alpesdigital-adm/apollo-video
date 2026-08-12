import { mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import sharp from 'sharp'

import type { ImageAnalysisProcessor, ImageVisionProvider } from '../../application/ports/image-analysis.ts'
import type { ImageObservation } from '../../domain/image-analysis.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'

const unavailable = <T>(reason: string): ImageObservation<T> => Object.freeze({ state: 'unavailable', values: Object.freeze([]), producer: Object.freeze({ provider: 'not-configured', model: 'none', version: 'v1' }), reasonCodes: Object.freeze([reason]) })
const hex = (red: number, green: number, blue: number) => `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`

export class SharpImageAnalysisProcessor implements ImageAnalysisProcessor {
  private readonly root: string; private readonly vision?: ImageVisionProvider
  constructor(root: string, vision?: ImageVisionProvider) { this.root = resolve(root); this.vision = vision }
  private directory(operationId: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'Image analysis operationId is invalid'); const directory = resolve(this.root, operationId); const rel = relative(this.root, directory); if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('INVALID_ARGUMENT', 'Image analysis path escaped its root'); return directory }
  async analyze(input: { operationId: string; sourcePath: string; signal?: AbortSignal }) {
    if (!isAbsolute(input.sourcePath)) throw new DomainError('INVALID_ARGUMENT', 'Image analysis source path must be absolute')
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Image analysis was cancelled')
    const directory = this.directory(input.operationId); await mkdir(directory, { recursive: true }); const thumbnailPath = join(directory, 'thumbnail.webp'); const previewPath = join(directory, 'preview.webp')
    let metadata; let statistics
    try { const image = sharp(input.sourcePath, { failOn: 'warning', limitInputPixels: 100_000_000 }); [metadata, statistics] = await Promise.all([image.metadata(), image.stats()]) } catch { throw new DomainError('RENDER_OUTPUT_INVALID', 'Image technical analysis failed') }
    const width = metadata.autoOrient.width ?? 0; const height = metadata.autoOrient.height ?? 0
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16) throw new DomainError('RENDER_OUTPUT_INVALID', 'Image dimensions are unavailable')
    const [thumbnailInfo, previewInfo] = await Promise.all([sharp(input.sourcePath).rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(thumbnailPath), sharp(input.sourcePath).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toFile(previewPath)])
    const observations = this.vision ? await this.vision.analyze({ sourcePath: input.sourcePath, width, height, signal: input.signal }) : { ocr: unavailable<never>('OCR_PROVIDER_NOT_CONFIGURED'), faces: unavailable<never>('FACE_PROVIDER_NOT_CONFIGURED'), objects: unavailable<never>('OBJECT_PROVIDER_NOT_CONFIGURED'), inferredTags: Object.freeze([]) }
    const orientation = width === height ? 'square' : width > height ? 'landscape' : 'portrait'; const dominantColors = Object.freeze([hex(statistics.dominant.r, statistics.dominant.g, statistics.dominant.b)])
    const visible = [
      ...(observations.faces.values.length > 0
        ? [`${observations.faces.values.length} ${observations.faces.values.length === 1 ? 'rosto observado' : 'rostos observados'}`]
        : []),
      ...observations.objects.values.map((value) => value.label),
      ...observations.ocr.values.map((value) => `texto “${value.text}”`),
    ]
    const observedDescription = visible.length ? `Imagem ${orientation} ${width}×${height} com ${visible.join(', ')}.` : `Imagem ${orientation} ${width}×${height}; objetos e texto não observados ou indisponíveis.`
    const derivative = async (path: string, info: { width: number; height: number; size: number }) => { const [bytes, sha256] = await Promise.all([stat(path), calculateFileSha256(path)]); if (!info.width || !info.height || info.size !== bytes.size || bytes.size < 1) throw new DomainError('RENDER_OUTPUT_INVALID', 'Image derivative is invalid'); return Object.freeze({ path, sha256, byteSize: bytes.size, width: info.width, height: info.height }) }
    const [thumbnail, preview] = await Promise.all([derivative(thumbnailPath, thumbnailInfo), derivative(previewPath, previewInfo)])
    return Object.freeze({ width, height, dominantColors, ...observations, observedDescription, thumbnail, preview })
  }
  async cleanup(operationId: string) { await rm(this.directory(operationId), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}
