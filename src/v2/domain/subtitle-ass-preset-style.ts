import { DomainError } from './errors.ts'
import { readSubtitlePreset, type SubtitlePresetId } from './subtitle-system.ts'

/**
 * W68. What the FFmpeg/libass caption path can draw of a subtitle preset.
 *
 * The editorial render burns captions with libass: one `Default` style for every cue, sized from the canvas. A per-segment `style`
 * exception (an `apply-subtitle-segment-override` style dimension) names a registered preset, and this module is the whole of how that
 * preset reaches the pixels of that path: its text colour, its opaque container (or outline), its weight and its casing. It does NOT
 * claim the full preset (typeface, animation, word highlight and grouping belong to the Remotion composition); that bound is stated here
 * and in the W68 note rather than discovered in a review.
 *
 * The `Default` style is untouched: a render without a style exception emits exactly the ASS it always emitted.
 */
export type AssPresetStyle = Readonly<{
  /** The ASS style name a cue refers to. */
  name: string
  /** The complete `Style:` line. */
  line: string
  /** Casing the cue text must be put in before it is drawn (libass has no text-transform). */
  casing: 'none' | 'uppercase' | 'lowercase' | 'title'
}>

const HEX = /^#[0-9A-Fa-f]{6}$/

/** `#RRGGBB` and an opacity in [0, 1] to libass `&HAABBGGRR` (alpha 00 is opaque). */
function assColour(hex: string, opacity = 1): string {
  if (!HEX.test(hex)) throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle preset colour is not #RRGGBB')
  if (!(opacity >= 0 && opacity <= 1)) throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle preset opacity is outside [0, 1]')
  const channel = (index: number) => hex.slice(index, index + 2).toUpperCase()
  const alpha = Math.round((1 - opacity) * 255).toString(16).toUpperCase().padStart(2, '0')
  return `&H${alpha}${channel(5)}${channel(3)}${channel(1)}`
}

export function assPresetStyleName(presetId: SubtitlePresetId): string {
  return `Preset-${presetId}`
}

export function assPresetStyle(presetId: SubtitlePresetId, metrics: Readonly<{ fontSize: number; marginHorizontal: number; marginVertical: number }>): AssPresetStyle {
  const preset = readSubtitlePreset(presetId)
  const boxed = preset.background.shape !== 'none'
  const bold = preset.typography.weight >= 700 ? -1 : 0
  const outlineWidth = boxed ? 1 : Math.max(1, Math.round(metrics.fontSize * preset.stroke.widthEm))
  const fields = [
    assPresetStyleName(presetId), 'Arial', metrics.fontSize,
    assColour(preset.highlight.inactiveColor),
    assColour(preset.highlight.color),
    // libass draws the opaque container of BorderStyle 3 with the OUTLINE colour; the outline of BorderStyle 1 with the same field.
    boxed ? assColour(preset.background.color, preset.background.opacity) : assColour(preset.stroke.color),
    boxed ? assColour(preset.background.color, preset.background.opacity) : assColour('#000000', 0.5),
    bold, 0, 0, 0, 100, 100, 0, 0,
    boxed ? 3 : 1, outlineWidth, 0, 2,
    metrics.marginHorizontal, metrics.marginHorizontal, metrics.marginVertical, 1,
  ]
  return Object.freeze({
    name: assPresetStyleName(presetId),
    line: `Style: ${fields.join(',')}`,
    casing: preset.casing,
  })
}

/** The cue text in the casing the preset asks for. */
export function applyAssCasing(text: string, casing: AssPresetStyle['casing']): string {
  if (casing === 'uppercase') return text.toLocaleUpperCase('pt-BR')
  if (casing === 'lowercase') return text.toLocaleLowerCase('pt-BR')
  if (casing === 'title') return text.replace(/\p{L}[\p{L}\p{M}'’]*/gu, (word) => word.charAt(0).toLocaleUpperCase('pt-BR') + word.slice(1).toLocaleLowerCase('pt-BR'))
  return text
}
