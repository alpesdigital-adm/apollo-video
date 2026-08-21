import { createHash } from 'node:crypto'

import { stableSerialize } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import type { RenderElementMap } from './review-system.ts'

/**
 * FR-175 — subtitle sidecars.
 *
 * A sidecar is only allowed to describe the alignment that the renderer actually
 * burned into the MP4. The single source of truth for cue identity and timing is
 * the persisted `RenderElementMap` of the exact artifact; the only thing the map
 * does not carry is the cue text, which is read back from the immutable EditPlan
 * snapshot of the same ProjectVersion and cross-checked cue by cue. A transcript,
 * a live EditPlan or a pre-render cue list may never reach this module.
 */
export const SUBTITLE_SIDECAR_SCHEMA_VERSION = 'subtitle-sidecar/v1'
export const SUBTITLE_SIDECAR_RECIPE_ID = 'subtitle-sidecar'
export const SUBTITLE_SIDECAR_RECIPE_VERSION = '1.0.0'
export const SUBTITLE_SIDECAR_ELEMENT_PREFIX = 'subtitle:'
export const SUBTITLE_SIDECAR_FORMATS = Object.freeze(['srt', 'vtt'] as const)
export type SubtitleSidecarFormat = (typeof SUBTITLE_SIDECAR_FORMATS)[number]

/** UTF-8 with an explicit byte order mark, identical for both formats. */
export const SUBTITLE_SIDECAR_ENCODING = 'utf-8-bom'
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * SRT is a CRLF format and VTT is an LF format. The bytes are assembled from
 * these constants, never from the platform EOL, so a Windows host and a Linux
 * container produce the same checksum.
 */
export const SUBTITLE_SIDECAR_EOL = Object.freeze({ srt: '\r\n', vtt: '\n' } as const)

/** BCP-47 subset accepted for the sidecar locale tag. */
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/
const CUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Rejects every C0 control except the line feed, plus DEL. A raw carriage return
 * never survives normalization, so finding one here means the text reaching the
 * encoder was not normalized. Written as code points on purpose: a literal
 * control range inside a regex would put raw control bytes in this source file.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return true
  }
  return false
}

export interface RenderedSubtitleCue {
  cueId: string
  startFrame: number
  endFrame: number
  startMs: number
  endMs: number
  text: string
}

export interface EncodedSubtitleSidecar {
  format: SubtitleSidecarFormat
  locale: string
  encoding: typeof SUBTITLE_SIDECAR_ENCODING
  eol: '\r\n' | '\n'
  bytes: Buffer
  byteSize: number
  sha256: string
  cueCount: number
}

/**
 * Frames are converted with a single documented rule: the frame index is divided
 * by the canonical fps of the map (already rounded to six decimals when the map
 * was built) and rounded half-up to the nearest millisecond. Rounding happens
 * once, on the frame boundary, so re-deriving the same map always yields the same
 * milliseconds.
 */
export function subtitleSidecarFrameToMs(frame: number, fps: number): number {
  assertDomain(
    Number.isSafeInteger(frame) && frame >= 0 && Number.isFinite(fps) && fps > 0,
    'INVALID_ARGUMENT',
    'Subtitle sidecar frame conversion requires a non-negative frame and a positive fps',
  )
  return Math.round((frame * 1000) / fps)
}

export function normalizeSubtitleCueText(value: string, cueId: string): string {
  const normalized = value.normalize('NFC').replace(/\r\n|\r/g, '\n').trim()
  assertDomain(
    normalized.length > 0 && normalized.length <= 512,
    'INVALID_ARGUMENT',
    `Subtitle cue ${cueId} text is empty or too long`,
  )
  assertDomain(
    !hasControlCharacter(normalized),
    'INVALID_ARGUMENT',
    `Subtitle cue ${cueId} text contains control characters`,
  )
  assertDomain(
    !normalized.includes('-->'),
    'INVALID_ARGUMENT',
    `Subtitle cue ${cueId} text contains a cue timing separator`,
  )
  const lines = normalized.split('\n')
  assertDomain(
    lines.length <= 4 && lines.every((line) => line.trim().length > 0),
    'INVALID_ARGUMENT',
    `Subtitle cue ${cueId} line breaks are invalid`,
  )
  return lines.map((line) => line.trim()).join('\n')
}

/**
 * Fail-closed invariants shared by both formats: positive ranges, monotonic and
 * non-overlapping cues, and a last cue that closes inside the rendered duration.
 */
export function assertRenderedSubtitleCues(
  cues: readonly RenderedSubtitleCue[],
  durationMs?: number,
): readonly Readonly<RenderedSubtitleCue>[] {
  assertDomain(
    cues.length > 0,
    'INVALID_ARGUMENT',
    'A subtitle sidecar requires at least one rendered cue',
  )
  const seen = new Set<string>()
  cues.forEach((cue, index) => {
    const previous = index > 0 ? cues[index - 1]! : undefined
    assertDomain(
      CUE_ID_PATTERN.test(cue.cueId) && !seen.has(cue.cueId),
      'INVALID_ARGUMENT',
      'Subtitle cue identity is invalid or duplicated',
    )
    seen.add(cue.cueId)
    assertDomain(
      Number.isSafeInteger(cue.startMs) && Number.isSafeInteger(cue.endMs) &&
        cue.startMs >= 0 && cue.endMs > cue.startMs,
      'INVALID_ARGUMENT',
      `Subtitle cue ${cue.cueId} range is not positive`,
    )
    assertDomain(
      previous === undefined || cue.startMs >= previous.endMs,
      'INVALID_ARGUMENT',
      `Subtitle cue ${cue.cueId} is not monotonic or overlaps the previous cue`,
    )
  })
  const last = cues[cues.length - 1]!
  assertDomain(
    durationMs === undefined || last.endMs <= durationMs,
    'INVALID_ARGUMENT',
    'The last subtitle cue closes after the rendered duration',
  )
  return Object.freeze(cues.map((cue) => Object.freeze({ ...cue })))
}

/**
 * Extracts the exact rendered cues from the persisted RenderElementMap.
 *
 * Every `subtitle:<cueId>` element contributes one frame. The frames of one cue
 * must form a single contiguous run — a hole would mean the map and the burned
 * subtitle disagree — and every rendered cue must have exactly one text in the
 * immutable snapshot. Any divergence in either direction is a conflict, never a
 * silently narrower sidecar.
 */
export function collectRenderedSubtitleCues(input: {
  map: Readonly<RenderElementMap>
  texts: Readonly<Record<string, string>>
}): readonly Readonly<RenderedSubtitleCue>[] {
  const frames = new Map<string, number[]>()
  for (const element of input.map.elements) {
    if (element.type !== 'subtitle') continue
    assertDomain(
      element.elementId.startsWith(SUBTITLE_SIDECAR_ELEMENT_PREFIX),
      'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
      'Rendered subtitle element identity is invalid',
    )
    const cueId = element.elementId.slice(SUBTITLE_SIDECAR_ELEMENT_PREFIX.length)
    const bucket = frames.get(cueId)
    if (bucket) bucket.push(element.frame)
    else frames.set(cueId, [element.frame])
  }
  if (frames.size === 0) {
    throw new DomainError(
      'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
      'The rendered artifact carries no subtitle element; a sidecar cannot be derived',
    )
  }
  const rendered = [...frames.keys()]
  const missing = rendered.filter((cueId) => typeof input.texts[cueId] !== 'string')
  const extra = Object.keys(input.texts).filter((cueId) => !frames.has(cueId))
  if (missing.length > 0 || extra.length > 0) {
    throw new DomainError(
      'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
      'Rendered subtitle cues and the immutable snapshot cues do not match',
      { missing, extra },
    )
  }
  const cues = rendered.map((cueId) => {
    const ordered = [...frames.get(cueId)!].sort((left, right) => left - right)
    const startFrame = ordered[0]!
    const endFrame = ordered[ordered.length - 1]! + 1
    assertDomain(
      ordered.every((frame, index) => frame === startFrame + index),
      'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
      `Rendered subtitle cue ${cueId} does not occupy a contiguous frame range`,
    )
    return {
      cueId,
      startFrame,
      endFrame,
      startMs: subtitleSidecarFrameToMs(startFrame, input.map.fps),
      endMs: subtitleSidecarFrameToMs(endFrame, input.map.fps),
      text: normalizeSubtitleCueText(input.texts[cueId]!, cueId),
    }
  })
  cues.sort((left, right) =>
    left.startFrame - right.startFrame || left.cueId.localeCompare(right.cueId))
  return assertRenderedSubtitleCues(
    cues,
    subtitleSidecarFrameToMs(input.map.durationFrames, input.map.fps),
  )
}

function stamp(ms: number, format: SubtitleSidecarFormat): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(millis).padStart(3, '0')}`
}

export function renderSubtitleSidecarText(
  cues: readonly Readonly<{ startMs: number; endMs: number; text: string }>[],
  format: SubtitleSidecarFormat,
): string {
  assertDomain(
    SUBTITLE_SIDECAR_FORMATS.includes(format),
    'INVALID_ARGUMENT',
    'Subtitle sidecar format must be srt or vtt',
  )
  const eol = SUBTITLE_SIDECAR_EOL[format]
  const blocks = cues.map((cue, index) => {
    const header = format === 'srt' ? `${index + 1}${eol}` : ''
    const timing = `${stamp(cue.startMs, format)} --> ${stamp(cue.endMs, format)}`
    return `${header}${timing}${eol}${cue.text.split('\n').join(eol)}`
  })
  const head = format === 'vtt' ? `WEBVTT${eol}${eol}` : ''
  return `${head}${blocks.join(`${eol}${eol}`)}${eol}`
}

/**
 * Produces the exact bytes persisted as the sidecar artifact: BOM, then the
 * format-specific body with explicit line terminators. No clock, no host state
 * and no counter enters the file, so the same rendered alignment always
 * reconstructs to the same SHA-256.
 */
export function encodeSubtitleSidecar(input: {
  cues: readonly RenderedSubtitleCue[]
  format: SubtitleSidecarFormat
  locale: string
  durationMs?: number
}): Readonly<EncodedSubtitleSidecar> {
  assertDomain(
    SUBTITLE_SIDECAR_FORMATS.includes(input.format),
    'INVALID_ARGUMENT',
    'Subtitle sidecar format must be srt or vtt',
  )
  assertDomain(
    LOCALE_PATTERN.test(input.locale),
    'INVALID_ARGUMENT',
    'Subtitle sidecar locale must be a BCP-47 tag',
  )
  const cues = assertRenderedSubtitleCues(input.cues, input.durationMs)
  const text = renderSubtitleSidecarText(cues, input.format)
  const bytes = Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')])
  return Object.freeze({
    format: input.format,
    locale: input.locale,
    encoding: SUBTITLE_SIDECAR_ENCODING,
    eol: SUBTITLE_SIDECAR_EOL[input.format],
    bytes,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    cueCount: cues.length,
  })
}

function parseStamp(value: string, format: SubtitleSidecarFormat): number {
  const pattern = format === 'srt'
    ? /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/
    : /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/
  const match = pattern.exec(value)
  assertDomain(Boolean(match), 'INVALID_ARGUMENT', 'Subtitle sidecar timestamp is invalid')
  const [, hours, minutes, seconds, millis] = match!
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 +
    Number(seconds) * 1000 + Number(millis)
}

/**
 * Reads a sidecar back into cues. Used by the round-trip proof: the parsed text
 * and timing must equal the rendered alignment the file was derived from.
 */
export function parseSubtitleSidecar(
  bytes: Buffer,
  format: SubtitleSidecarFormat,
): readonly Readonly<{ startMs: number; endMs: number; text: string }>[] {
  assertDomain(
    bytes.length > UTF8_BOM.length && bytes.subarray(0, 3).equals(UTF8_BOM),
    'INVALID_ARGUMENT',
    'Subtitle sidecar must start with a UTF-8 byte order mark',
  )
  const eol = SUBTITLE_SIDECAR_EOL[format]
  const body = bytes.subarray(UTF8_BOM.length).toString('utf8')
  const lineTerminatorsMatch = format === 'vtt'
    ? !body.includes('\r')
    : body.split('\n').every((line, index, all) => index === all.length - 1 || line.endsWith('\r'))
  assertDomain(
    lineTerminatorsMatch,
    'INVALID_ARGUMENT',
    'Subtitle sidecar line terminators do not match the format',
  )
  let payload = body
  if (format === 'vtt') {
    assertDomain(
      body.startsWith(`WEBVTT${eol}${eol}`),
      'INVALID_ARGUMENT',
      'VTT sidecar is missing its header',
    )
    payload = body.slice(`WEBVTT${eol}${eol}`.length)
  }
  assertDomain(payload.endsWith(eol), 'INVALID_ARGUMENT', 'Subtitle sidecar is not terminated')
  const blocks = payload.slice(0, payload.length - eol.length).split(`${eol}${eol}`)
  return Object.freeze(blocks.map((block, index) => {
    const lines = block.split(eol)
    const timingIndex = format === 'srt' ? 1 : 0
    if (format === 'srt') {
      assertDomain(
        lines[0] === String(index + 1),
        'INVALID_ARGUMENT',
        'SRT cue numbering is not sequential',
      )
    }
    const timing = lines[timingIndex]?.split(' --> ')
    assertDomain(timing?.length === 2, 'INVALID_ARGUMENT', 'Subtitle sidecar cue timing is invalid')
    const text = lines.slice(timingIndex + 1).join('\n')
    assertDomain(text.length > 0, 'INVALID_ARGUMENT', 'Subtitle sidecar cue text is empty')
    return Object.freeze({
      startMs: parseStamp(timing![0]!, format),
      endMs: parseStamp(timing![1]!, format),
      text,
    })
  }))
}

export interface SubtitleSidecarLineage {
  schemaVersion: typeof SUBTITLE_SIDECAR_SCHEMA_VERSION
  workspaceId: string
  projectId: string
  projectVersionId: string
  variantId: string
  outputArtifactId: string
  outputSha256: string
  outputKind: 'proxy' | 'final'
  renderInputHash: string
  editPlanSnapshotId: string
  editPlanHash: string
  renderElementMapHash: string
  format: SubtitleSidecarFormat
  locale: string
}

/**
 * Content address of one sidecar: the exact rendered artifact, the exact cue
 * alignment and the exact requested format/locale. Two requests that agree on
 * all of it are the same sidecar and must replay onto the same artifact.
 */
export function subtitleSidecarLineageHash(lineage: Readonly<SubtitleSidecarLineage>): string {
  assertDomain(
    lineage.schemaVersion === SUBTITLE_SIDECAR_SCHEMA_VERSION &&
      /^[a-f0-9]{64}$/.test(lineage.outputSha256) &&
      /^[a-f0-9]{64}$/.test(lineage.renderElementMapHash) &&
      /^[a-f0-9]{64}$/.test(lineage.renderInputHash) &&
      /^[a-f0-9]{64}$/.test(lineage.editPlanHash) &&
      SUBTITLE_SIDECAR_FORMATS.includes(lineage.format) &&
      LOCALE_PATTERN.test(lineage.locale) &&
      ['proxy', 'final'].includes(lineage.outputKind) &&
      [lineage.workspaceId, lineage.projectId, lineage.projectVersionId, lineage.variantId,
        lineage.outputArtifactId, lineage.editPlanSnapshotId].every((value) => Boolean(value.trim())),
    'INVALID_ARGUMENT',
    'Subtitle sidecar lineage is incomplete',
  )
  return createHash('sha256').update(stableSerialize(lineage)).digest('hex')
}
