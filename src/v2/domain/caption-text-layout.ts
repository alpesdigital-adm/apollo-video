import { assertDomain } from './errors.ts'
import { SUBTITLE_LINE_HEIGHT, type SubtitleRenderMetrics } from './subtitle-style-tokens.ts'

/**
 * W69-tail / W70-prep. The geometry of a burned-in caption, in one place.
 *
 * Before this module the FFmpeg/libass path broke a caption at a fixed 20 characters whatever the canvas, and sized its font from the canvas
 * alone (`min(w * 0.059, h * 0.067)`). The subtitle band the placement plan certifies is derived from the PRESET (`deriveSubtitleRegion`:
 * `maxLines` lines at the preset's own font size). At 16:9 the two disagreed - a font of 36 px asked for ~74 rows, the band had 56 - so any
 * caption over 20 characters was drawn taller than the band the plan had checked, and the W65 pixel critic (rightly) blocked it, in the
 * proxy and in the final.
 *
 * Here the caption is sized FROM the band: the font never exceeds what `maxLines` lines of the band's height allow (the preset's own size
 * in every ordinary case), a line is broken by the measured width of the text against the band's width, and the lines come out as the text
 * needs them. The caller draws all of them: a text that cannot fit in `maxLines` lines is not cut (cutting would burn a caption the sidecar
 * and the author never wrote) - it overflows the band, and the pixel critic reports exactly that.
 *
 * Measurement. libass draws the ASS `Arial` style with the Arial Bold face (or Liberation Sans Bold, which is metric-compatible with it). The
 * advance widths below are those of Arial Bold in 1/1000 em for U+0020..U+007E; letters with a diacritic take the width of their base
 * letter, a few typographic marks are listed, and anything else is measured as a full em (a wider-than-real guess, never a narrower one).
 * libass sizes the em so that ascent + descent equals the requested font size, which for Arial is 2048 / 2288 = 0.895 of it: measured on
 * the delivered pixels (Arial Bold, FFmpeg 6.1.1 with libass), a line of text is 0.87 - 0.89 of `advance * fontSize` wide, and a line is
 * `fontSize` tall. The estimate adds 3 % and the box padding on top, so it can only be wider than the pixels. The proof is
 * `tests/v2/caption-text-layout-pixels.integration.mjs`; a host whose `Arial` resolves to a wider face (DejaVu) is outside this claim.
 */
export const CAPTION_TEXT_LAYOUT_ID = 'caption-text-layout/v1' as const

/** libass: the em is `fontSize * 2048 / (1854 + 434)` for Arial (ascent + descent = the requested size). */
export const LIBASS_ARIAL_EM_PER_FONT_SIZE = 2048 / (1854 + 434)
/** Safety factor on the measured width. */
const WIDTH_SAFETY = 1.03

const ADVANCE: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {
    ' ': 278, '!': 333, '"': 474, '#': 556, '$': 556, '%': 889, '&': 722, "'": 238, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278,
    '-': 333, '.': 278, '/': 278, ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975, '[': 333, ']': 333, '^': 584,
    '_': 556, '`': 333, '{': 389, '|': 280, '}': 389, '~': 584,
    // typographic marks that appear in Portuguese captions
    '‘': 278, '’': 278, '‚': 278, '“': 500, '”': 500, '„': 500, '–': 556, '—': 1000, '…': 1000,
    '«': 556, '»': 556, '¿': 611, '¡': 333, 'º': 365, 'ª': 370, '°': 400, '€': 556, 'ß': 611,
    ' ': 278,
  }
  table[String.fromCharCode(92)] = 278
  for (const digit of '0123456789') table[digit] = 556
  const upper = [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611]
  const lower = [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500]
  upper.forEach((width, index) => { table[String.fromCharCode(65 + index)] = width })
  lower.forEach((width, index) => { table[String.fromCharCode(97 + index)] = width })
  return Object.freeze(table)
})()

/** Advance of one user-perceived character in 1/1000 em. Accented letters are measured as their base letter; unknown ones as a full em. */
function advanceOf(character: string): number {
  const direct = ADVANCE[character]
  if (direct !== undefined) return direct
  const base = character.normalize('NFD').replace(/\p{M}/gu, '')
  if (base.length > 0 && base !== character) {
    let total = 0
    for (const part of base) total += ADVANCE[part] ?? 1000
    return total
  }
  return 1000
}

/**
 * The text a caption burns, and the text a sidecar of that caption carries: one canonical form for both. NFC; line breaks are `\n`; the
 * characters libass reads as markup (`{`, `}`) or as an escape (`\`) are not drawn and are therefore not part of it; every line is trimmed
 * with its inner white space collapsed; empty lines are dropped. Explicit line breaks of the author are kept (a caption breaks where the
 * author said it must, and wraps only inside a line).
 */
export function canonicalCaptionText(value: string): string {
  return value.normalize('NFC').replace(/\r\n|\r/g, '\n').replace(/[{}\\]/g, '')
    .split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim()).filter((line) => line.length > 0).join('\n')
}

/** Width in canvas pixels of one line drawn with the ASS Arial Bold style at `fontPx`, before the box padding. */
export function measureCaptionLine(line: string, fontPx: number): number {
  assertDomain(Number.isFinite(fontPx) && fontPx > 0, 'INVALID_RENDER_INPUT', 'Caption font size must be positive')
  let total = 0
  for (const character of line) total += advanceOf(character)
  return total / 1000 * fontPx * LIBASS_ARIAL_EM_PER_FONT_SIZE * WIDTH_SAFETY
}

export type CaptionLayout = Readonly<{
  schemaVersion: typeof CAPTION_TEXT_LAYOUT_ID
  lines: readonly string[]
  fontPx: number
  /** Widest line, in canvas pixels, as estimated. */
  widthPx: number
  /** Height of the block libass draws: `lines * fontPx`. */
  heightPx: number
  /** The text fits `maxLines` lines inside `maxWidthPx`. A caption that does not fit is still laid out in full. */
  fits: boolean
}>

/**
 * Lays out one caption. Greedy by measured width; a paragraph that needs exactly two lines is split where the wider of the two is
 * narrowest (a balanced pair, not a long line over a short one). A single word wider than the line stays on a line of its own.
 */
export function layoutCaption(input: Readonly<{ text: string; fontPx: number; maxWidthPx: number; maxLines: number }>): CaptionLayout {
  assertDomain(
    Number.isFinite(input.maxWidthPx) && input.maxWidthPx > 0 && Number.isInteger(input.maxLines) && input.maxLines >= 1,
    'INVALID_RENDER_INPUT', 'Caption layout needs a positive width and at least one line',
  )
  const text = canonicalCaptionText(input.text)
  assertDomain(text.length > 0, 'INVALID_RENDER_INPUT', 'Drawable ASS text is empty')
  const width = (line: string) => measureCaptionLine(line, input.fontPx)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ')
    const greedy: string[] = []
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (current && width(candidate) > input.maxWidthPx) { greedy.push(current); current = word } else current = candidate
    }
    greedy.push(current)
    if (greedy.length !== 2) { lines.push(...greedy); continue }
    // Exactly two lines are needed: keep the pair whose wider line is the narrowest.
    let best = greedy
    let bestWidth = Math.max(width(greedy[0]!), width(greedy[1]!))
    for (let split = 1; split < words.length; split += 1) {
      const pair = [words.slice(0, split).join(' '), words.slice(split).join(' ')]
      const widest = Math.max(width(pair[0]!), width(pair[1]!))
      if (widest < bestWidth - 1e-9) { best = pair; bestWidth = widest }
    }
    lines.push(...best)
  }
  const widthPx = Math.max(...lines.map(width))
  return Object.freeze({
    schemaVersion: CAPTION_TEXT_LAYOUT_ID,
    lines: Object.freeze(lines),
    fontPx: input.fontPx,
    widthPx,
    heightPx: lines.length * input.fontPx,
    fits: lines.length <= input.maxLines && widthPx <= input.maxWidthPx,
  })
}

/** libass draws an opaque box (BorderStyle 3) or an outline of `outline` px around the glyphs: the room a line needs beside its text. */
export const CAPTION_BOX_PADDING_PX = 2

/**
 * The ASS font size of the captions of one render: the preset's own size at this canvas, reduced only when the band the plan certified
 * is too short for `maxLines` lines of it (a band clamped by the safe area). A band can never be taller than the lines the preset asks for
 * plus its padding, so for every ordinary preset and canvas this IS the preset size.
 */
export function captionFontPx(input: Readonly<{ metrics: Pick<SubtitleRenderMetrics, 'fontPx' | 'strokePx'>; bandHeightPx: number; maxLines: number }>): number {
  const room = Math.floor((input.bandHeightPx - 2 * input.metrics.strokePx) / (SUBTITLE_LINE_HEIGHT * input.maxLines))
  return Math.max(1, Math.min(input.metrics.fontPx, room))
}

/** The width the text of a caption may take inside a band of `bandWidthPx`: the band less the room for the box or outline on both sides. */
export function captionTextWidthPx(bandWidthPx: number, outlinePx: number): number {
  return Math.max(1, bandWidthPx - 2 * (outlinePx + CAPTION_BOX_PADDING_PX))
}
