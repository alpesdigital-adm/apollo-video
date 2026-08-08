import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import type { ImageVisionProvider } from '../../application/ports/image-analysis.ts'
import type { ImageOcrRegion, NormalizedImageBox } from '../../domain/image-analysis.ts'
import { DomainError } from '../../domain/errors.ts'

const execFileAsync = promisify(execFile)
const LANGUAGE: Readonly<Record<string, string>> = Object.freeze({ por: 'pt-BR', eng: 'en' })
export function parseTesseractTsv(tsv: string, input: { width: number; height: number; language: string }): readonly ImageOcrRegion[] {
  const lines = tsv.replaceAll('\r', '').split('\n'); const header = lines.shift()?.split('\t') ?? []
  const indexes = Object.fromEntries(header.map((value, index) => [value, index])) as Record<string, number>
  if (['level', 'left', 'top', 'width', 'height', 'conf', 'text'].some((field) => indexes[field] === undefined)) throw new DomainError('RENDER_OUTPUT_INVALID', 'Tesseract TSV schema is invalid')
  return Object.freeze(lines.flatMap((line) => {
    const columns = line.split('\t'); if (columns.length < header.length || columns[indexes.level] !== '5') return []
    const text = columns[indexes.text]?.trim() ?? ''; const confidence = Number(columns[indexes.conf]); const left = Number(columns[indexes.left]); const top = Number(columns[indexes.top]); const width = Number(columns[indexes.width]); const height = Number(columns[indexes.height])
    if (!text || !Number.isFinite(confidence) || confidence < 0 || ![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return []
    const x = Math.min(1, Math.max(0, left / input.width)); const y = Math.min(1, Math.max(0, top / input.height))
    const box: NormalizedImageBox = Object.freeze([x, y, Math.min(1 - x, width / input.width), Math.min(1 - y, height / input.height)])
    const area = box[2] * box[3]; const normalizedConfidence = Math.min(1, confidence / 100); const importance = area >= 0.04 || normalizedConfidence >= 0.9 ? 'high' as const : area >= 0.015 || normalizedConfidence >= 0.7 ? 'medium' as const : 'low' as const
    return [Object.freeze({ text, language: LANGUAGE[input.language] ?? 'und', box, confidence: normalizedConfidence, importance })]
  }))
}

function overlaps(left: ImageOcrRegion, right: ImageOcrRegion) { const [lx, ly, lw, lh] = left.box; const [rx, ry, rw, rh] = right.box; const intersection = Math.max(0, Math.min(lx + lw, rx + rw) - Math.max(lx, rx)) * Math.max(0, Math.min(ly + lh, ry + rh) - Math.max(ly, ry)); return intersection / Math.min(lw * lh, rw * rh) >= 0.65 }
function mergeRegions(regions: readonly ImageOcrRegion[]) { const selected: ImageOcrRegion[] = []; for (const region of [...regions].sort((a, b) => b.confidence - a.confidence)) { const duplicate = selected.some((current) => overlaps(current, region) && current.text.toLocaleLowerCase().replace(/\W/gu, '') === region.text.toLocaleLowerCase().replace(/\W/gu, '')); if (!duplicate) selected.push(region) } return Object.freeze(selected.toSorted((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) }

export class TesseractImageVisionProvider implements ImageVisionProvider {
  private readonly binary: string; private readonly languages: readonly string[]
  constructor(input: { binary: string; languages?: readonly string[] }) { if (!isAbsolute(input.binary)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Tesseract binary path must be absolute'); this.binary = input.binary; this.languages = Object.freeze([...(input.languages ?? ['por', 'eng'])]); if (!this.languages.length || this.languages.some((language) => !Object.hasOwn(LANGUAGE, language))) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Tesseract languages are invalid') }
  async analyze(input: { sourcePath: string; width: number; height: number; signal?: AbortSignal }) {
    const outputs = await Promise.all(this.languages.map(async (language) => { try { return parseTesseractTsv((await execFileAsync(this.binary, [input.sourcePath, 'stdout', '-l', language, 'tsv'], { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, signal: input.signal, encoding: 'utf8' })).stdout, { width: input.width, height: input.height, language }) } catch (error) { throw new DomainError('RENDER_EXECUTION_FAILED', (error as NodeJS.ErrnoException).code === 'ABORT_ERR' ? 'Image OCR was cancelled' : 'Image OCR failed') } }))
    const values = mergeRegions(outputs.flat()); const producer = Object.freeze({ provider: 'tesseract', model: this.languages.join('-'), version: 'v5' })
    const unavailable = (reason: string) => Object.freeze({ state: 'unavailable' as const, values: Object.freeze([]), producer: Object.freeze({ provider: 'not-configured', model: 'none', version: 'v1' }), reasonCodes: Object.freeze([reason]) })
    const inferredTags = Object.freeze(values.flatMap((region) => region.text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4).map((value) => Object.freeze({ value, confidence: region.confidence, provenance: `tesseract@v5:ocr:${region.language}` }))))
    return Object.freeze({ ocr: Object.freeze({ state: 'available' as const, values, producer, reasonCodes: Object.freeze([]) }), faces: unavailable('FACE_PROVIDER_NOT_CONFIGURED'), objects: unavailable('OBJECT_PROVIDER_NOT_CONFIGURED'), inferredTags })
  }
}
