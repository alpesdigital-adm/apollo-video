import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import { renderElementMapHash, validateRenderElementMap, type RenderElementMap } from './review-system.ts'

/**
 * A producer-side account of subtitle ASS events emitted for one output.
 * It is structural lineage, not evidence that the final pixels are face-safe.
 * The renderer must construct this from the same finalized ASS bytes it passes
 * to FFmpeg; an EditPlan or an older proxy cannot synthesize the receipt.
 */
export const RENDERED_SUBTITLE_RECEIPT_VERSION = 'rendered-subtitle-receipt/v1'

export interface DrawnSubtitleCueReceipt {
  cueId: string
  startFrame: number
  endFrame: number
  /** Text after the exact ASS wrapping/escaping used by the renderer; \N becomes LF. */
  displayText: string
  /** Exact subtitle-layer Dialogue line written to the ASS file. */
  assEventLine: string
  anchorDecisionHash: string
}

export interface RenderedSubtitleReceipt {
  schemaVersion: typeof RENDERED_SUBTITLE_RECEIPT_VERSION
  workspaceId: string
  projectId: string
  projectVersionId: string
  variantId: string
  outputSpec: Readonly<{ format: string; width: number; height: number; fps: number }>
  producer: Readonly<{ operationId: string; attempt: number }>
  outputArtifactId: string
  outputSha256: string
  outputByteSize: number
  renderInputHash: string
  renderElementMapHash: string
  assSha256: string
  ffmpegBinarySha256: string
  durationFrames: number
  /** Map is sampled; this does not assert that every output frame was inspected. */
  mapCoverage: 'sampled'
  drawnCues: readonly Readonly<DrawnSubtitleCueReceipt>[]
  suppressedCueIds: readonly string[]
  receiptHash: string
}

const HASH = /^[a-f0-9]{64}$/
const CUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function assertHash(value: string, name: string): void {
  assertDomain(HASH.test(value), 'INVALID_RENDER_INPUT', `${name} must be a SHA-256 hash`)
}

function assTimestamp(frame: number, fps: number): string {
  const cs = Math.max(0, Math.round(frame / fps * 100))
  return `${Math.floor(cs / 360_000)}:${String(Math.floor(cs % 360_000 / 6_000)).padStart(2, '0')}:` +
    `${String(Math.floor(cs % 6_000 / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

function displayTextFromAssEvent(line: string): string {
  const parts = line.split(',', 10)
  assertDomain(parts.length === 10 && parts[0] === 'Dialogue: 0' &&
    parts[3] === 'Default' && parts[4] === '' &&
    parts[5] === '0' && parts[6] === '0' && parts[7] === '0' && parts[8] === '',
    'INVALID_RENDER_INPUT', 'Subtitle receipt event is not a subtitle-layer ASS Dialogue')
  // Split by the first nine commas: commas in subtitle text remain text.
  let comma = -1
  for (let index = 0; index < 9; index += 1) {
    comma = line.indexOf(',', comma + 1)
    assertDomain(comma >= 0, 'INVALID_RENDER_INPUT', 'Subtitle ASS event is incomplete')
  }
  const payload = line.slice(comma + 1)
  const position = /^\{\\an5\\pos\(\d+,\d+\)\}/.exec(payload)
  assertDomain(Boolean(position), 'INVALID_RENDER_INPUT',
    'Subtitle receipt ASS event lacks the supported anchor override')
  const visible = payload.slice(position![0].length).replaceAll('\\N', '\n')
  assertDomain(visible.length > 0 && visible.normalize('NFC') === visible &&
      !/[{}\\\r]/.test(visible), 'INVALID_RENDER_INPUT',
  'Subtitle receipt text does not match the normalized ASS display text')
  return visible
}

export function createRenderedSubtitleReceipt(input: {
  workspaceId: string
  projectId: string
  projectVersionId: string
  variantId: string
  outputSpec: Readonly<{ format: string; width: number; height: number; fps: number }>
  producer: Readonly<{ operationId: string; attempt: number }>
  outputArtifactId: string
  outputSha256: string
  outputByteSize: number
  renderInputHash: string
  map: Readonly<RenderElementMap>
  assBytes: Uint8Array
  ffmpegBinarySha256: string
  drawnCues: readonly Readonly<DrawnSubtitleCueReceipt>[]
  suppressedCueIds: readonly string[]
}): Readonly<RenderedSubtitleReceipt> {
  for (const [name, value] of Object.entries({
    workspaceId: input.workspaceId, projectId: input.projectId,
    projectVersionId: input.projectVersionId, variantId: input.variantId,
    format: input.outputSpec.format, operationId: input.producer.operationId,
    outputArtifactId: input.outputArtifactId,
  })) {
    assertDomain(typeof value === 'string' && value.trim().length > 0,
      'INVALID_RENDER_INPUT', `Subtitle receipt ${name} is missing`)
  }
  for (const [name, value] of Object.entries({
    outputSha256: input.outputSha256, renderInputHash: input.renderInputHash,
    ffmpegBinarySha256: input.ffmpegBinarySha256,
  })) assertHash(value, name)
  assertDomain(Number.isSafeInteger(input.producer.attempt) && input.producer.attempt > 0 &&
    Number.isSafeInteger(input.outputByteSize) && input.outputByteSize > 0 &&
    Number.isSafeInteger(input.outputSpec.width) && input.outputSpec.width > 0 &&
    Number.isSafeInteger(input.outputSpec.height) && input.outputSpec.height > 0 &&
    Number.isFinite(input.outputSpec.fps) && input.outputSpec.fps > 0,
  'INVALID_RENDER_INPUT', 'Subtitle receipt output or producer identity is invalid')
  assertDomain(input.map.proxyHash === input.outputSha256 &&
    input.map.canvas.width === input.outputSpec.width &&
    input.map.canvas.height === input.outputSpec.height &&
    Math.abs(input.map.fps - input.outputSpec.fps) <= 0.000001,
  'INVALID_RENDER_INPUT', 'Subtitle receipt map does not describe the output')
  validateRenderElementMap(input.map, input.outputSha256)

  let ass: string
  try {
    ass = new TextDecoder('utf-8', { fatal: true }).decode(input.assBytes)
  } catch {
    throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle ASS bytes are not valid UTF-8')
  }
  const scriptEvents = ass.split(/\r?\n/).filter((line) => line.startsWith('Dialogue: 0,'))
  assertDomain(new Set(scriptEvents).size === scriptEvents.length &&
    scriptEvents.length === input.drawnCues.length,
  'INVALID_RENDER_INPUT', 'Subtitle receipt does not cover exactly the emitted ASS events')
  const seen = new Set<string>()
  const seenEvents = new Set<string>()
  const drawn = input.drawnCues.map((cue) => {
    assertDomain(CUE_ID.test(cue.cueId) && !seen.has(cue.cueId) &&
      Number.isSafeInteger(cue.startFrame) && cue.startFrame >= 0 &&
      Number.isSafeInteger(cue.endFrame) && cue.endFrame > cue.startFrame &&
      cue.endFrame <= input.map.durationFrames,
    'INVALID_RENDER_INPUT', 'Subtitle receipt cue identity or frame interval is invalid')
    assertHash(cue.anchorDecisionHash, 'anchorDecisionHash')
    const fields = cue.assEventLine.split(',', 4)
    assertDomain(fields[1] === assTimestamp(cue.startFrame, input.outputSpec.fps) &&
      fields[2] === assTimestamp(cue.endFrame, input.outputSpec.fps),
    'INVALID_RENDER_INPUT', 'Subtitle receipt ASS timestamps differ from cue frames')
    assertDomain(scriptEvents.includes(cue.assEventLine) && !seenEvents.has(cue.assEventLine) &&
      cue.displayText === displayTextFromAssEvent(cue.assEventLine),
    'INVALID_RENDER_INPUT', 'Subtitle receipt text differs from the emitted ASS event')
    seen.add(cue.cueId)
    seenEvents.add(cue.assEventLine)
    return Object.freeze({ ...cue })
  })
  const suppressed = [...input.suppressedCueIds]
  assertDomain(new Set(suppressed).size === suppressed.length &&
    suppressed.every((id) => CUE_ID.test(id) && !seen.has(id)),
  'INVALID_RENDER_INPUT', 'Suppressed subtitle cue was drawn or duplicated')
  const mapCues = new Map<string, number[]>()
  for (const element of input.map.elements) {
    if (element.type !== 'subtitle') continue
    assertDomain(element.elementId.startsWith('subtitle:'),
      'INVALID_RENDER_INPUT', 'Subtitle map element identity is invalid')
    const id = element.elementId.slice('subtitle:'.length)
    assertDomain(seen.has(id), 'INVALID_RENDER_INPUT', 'Subtitle map includes an unrendered cue')
    const frames = mapCues.get(id) ?? []
    frames.push(element.frame)
    mapCues.set(id, frames)
  }
  for (const cue of drawn) {
    const frames = mapCues.get(cue.cueId) ?? []
    assertDomain(frames.length > 0 && frames.every((frame) =>
      frame >= cue.startFrame && frame < cue.endFrame),
    'INVALID_RENDER_INPUT', 'Sampled subtitle map disagrees with emitted cue interval')
  }
  const withoutHash = {
    schemaVersion: RENDERED_SUBTITLE_RECEIPT_VERSION as typeof RENDERED_SUBTITLE_RECEIPT_VERSION,
    workspaceId: input.workspaceId, projectId: input.projectId,
    projectVersionId: input.projectVersionId, variantId: input.variantId,
    outputSpec: Object.freeze({ ...input.outputSpec }),
    producer: Object.freeze({ ...input.producer }),
    outputArtifactId: input.outputArtifactId, outputSha256: input.outputSha256,
    outputByteSize: input.outputByteSize, renderInputHash: input.renderInputHash,
    renderElementMapHash: renderElementMapHash(input.map),
    assSha256: createHash('sha256').update(input.assBytes).digest('hex'),
    ffmpegBinarySha256: input.ffmpegBinarySha256,
    durationFrames: input.map.durationFrames, mapCoverage: 'sampled' as const,
    drawnCues: Object.freeze(drawn), suppressedCueIds: Object.freeze(suppressed),
  }
  return Object.freeze({ ...withoutHash, receiptHash: calculateCanonicalHash(withoutHash) })
}
