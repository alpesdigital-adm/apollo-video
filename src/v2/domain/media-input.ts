import { assertDomain } from './errors.ts'
import type { MediaUploadKind } from './media-transfer.ts'

export interface SniffedMediaInput { kind: MediaUploadKind; mimeType: string; extension: string }
export interface MediaProbe { codec: string; duration?: number; width?: number; height?: number }
export interface MediaIngestDecision { status: 'usable' | 'quarantined'; media: SniffedMediaInput; probe?: MediaProbe; error?: { code: string; message: string; action: string } }

const extensionKind: Record<string, MediaUploadKind> = { mp4: 'video', mov: 'video', webm: 'video', wav: 'audio', mp3: 'audio', m4a: 'audio', ogg: 'audio', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image' }
const allowedCodecs: Record<MediaUploadKind, Set<string>> = { video: new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']), audio: new Set(['aac', 'mp3', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le']), image: new Set(['png', 'mjpeg', 'webp', 'gif']) }

export function sniffMediaInput(input: { filename: string; declaredMime?: string; bytes: Uint8Array; byteSize: number }): SniffedMediaInput {
  assertDomain(input.byteSize > 0 && input.byteSize <= 5_000_000_000_000, 'INVALID_ARGUMENT', 'media size is outside the supported range')
  const b = input.bytes
  let detected: SniffedMediaInput | undefined
  if (b.length >= 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...b.slice(8, 12)).toLowerCase()
    detected = brand.includes('qt') ? { kind: 'video', mimeType: 'video/quicktime', extension: 'mov' } : brand.includes('m4a') ? { kind: 'audio', mimeType: 'audio/mp4', extension: 'm4a' } : { kind: 'video', mimeType: 'video/mp4', extension: 'mp4' }
  } else if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) detected = { kind: 'video', mimeType: 'video/webm', extension: 'webm' }
  else if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WAVE') detected = { kind: 'audio', mimeType: 'audio/wav', extension: 'wav' }
  else if (b.length >= 3 && String.fromCharCode(...b.slice(0, 3)) === 'ID3') detected = { kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3' }
  else if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) detected = { kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3' }
  else if (b.length >= 8 && b[0] === 0x89 && String.fromCharCode(...b.slice(1, 4)) === 'PNG') detected = { kind: 'image', mimeType: 'image/png', extension: 'png' }
  else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) detected = { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg' }
  else if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') detected = { kind: 'image', mimeType: 'image/webp', extension: 'webp' }
  else if (b.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...b.slice(0, 6)))) detected = { kind: 'image', mimeType: 'image/gif', extension: 'gif' }
  assertDomain(detected, 'INVALID_ARGUMENT', 'media signature is unsupported or file is corrupted')
  const extension = input.filename.split('.').pop()?.toLowerCase() ?? ''
  assertDomain(extensionKind[extension] === detected.kind, 'INVALID_ARGUMENT', 'file extension does not match detected media type')
  const declared = input.declaredMime?.toLowerCase().trim()
  assertDomain(!declared || declared === 'application/octet-stream' || declared.split('/')[0] === detected.kind, 'INVALID_ARGUMENT', 'declared MIME does not match detected media type')
  return detected
}

export function evaluateMediaProbe(media: SniffedMediaInput, probe: MediaProbe): MediaIngestDecision {
  const codec = probe.codec.toLowerCase()
  if (!allowedCodecs[media.kind].has(codec)) return Object.freeze({ status: 'quarantined', media, probe, error: Object.freeze({ code: 'UNSUPPORTED_CODEC', message: `Codec ${codec || 'desconhecido'} não é suportado.`, action: 'Converta o arquivo para H.264/AAC, MP3, PNG, JPEG ou WebP e tente novamente.' }) })
  if (media.kind !== 'image' && (!Number.isFinite(probe.duration) || probe.duration! < .1 || probe.duration! > 14_400)) return Object.freeze({ status: 'quarantined', media, probe, error: Object.freeze({ code: 'INVALID_DURATION', message: 'A duração da mídia está fora do intervalo de 0,1s a 4h.', action: 'Recorte ou gere novamente o arquivo e tente outra vez.' }) })
  if (media.kind === 'image' && (!Number.isFinite(probe.width) || !Number.isFinite(probe.height) || probe.width! < 16 || probe.height! < 16)) return Object.freeze({ status: 'quarantined', media, probe, error: Object.freeze({ code: 'INVALID_DIMENSIONS', message: 'A imagem não possui dimensões utilizáveis.', action: 'Exporte uma imagem com pelo menos 16×16 pixels.' }) })
  return Object.freeze({ status: 'usable', media, probe: Object.freeze({ ...probe, codec }) })
}

export interface ResumableTransferState { totalBytes: number; uploadedBytes: number; completedParts: readonly number[]; status: 'uploading' | 'paused' | 'canceled' | 'completed'; lastError?: string }
export function updateResumableTransfer(state: ResumableTransferState, event: { type: 'part-completed'; partNumber: number; byteSize: number } | { type: 'network-failed'; message: string } | { type: 'resume' } | { type: 'cancel' }): Readonly<ResumableTransferState> {
  if (event.type === 'cancel') return Object.freeze({ ...state, status: 'canceled' })
  assertDomain(state.status !== 'canceled' && state.status !== 'completed', 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'transfer is terminal')
  if (event.type === 'network-failed') return Object.freeze({ ...state, status: 'paused', lastError: event.message })
  if (event.type === 'resume') return Object.freeze({ ...state, status: 'uploading', lastError: undefined })
  assertDomain(Number.isInteger(event.partNumber) && event.partNumber >= 1 && event.byteSize > 0, 'INVALID_ARGUMENT', 'completed part is invalid')
  if (state.completedParts.includes(event.partNumber)) return state
  const uploadedBytes = Math.min(state.totalBytes, state.uploadedBytes + event.byteSize)
  return Object.freeze({ ...state, uploadedBytes, completedParts: Object.freeze([...state.completedParts, event.partNumber].sort((a, b) => a - b)), status: uploadedBytes === state.totalBytes ? 'completed' : 'uploading', lastError: undefined })
}
