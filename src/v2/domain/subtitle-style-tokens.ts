import { DomainError } from './errors.ts'
import { OUTPUT_ASPECT_RATIOS, type OutputAspectRatio } from './output-spec.ts'

/**
 * Bundler-safe half of the subtitle style registry (FR-170).
 *
 * `subtitle-system.ts` owns the content-addressed registry and therefore depends on `crypto`.
 * The Remotion composition is bundled for the browser and cannot take that dependency, so the
 * token shape and the pure resolvers live here and are re-exported by `subtitle-system.ts`.
 * Compiler, RenderInput, Remotion renderer, CSS preview and the public schemas all read these
 * exact definitions — there is no second copy of the geometry anywhere.
 */

export type SubtitlePresetId = 'kinetic' | 'karaoke-box' | 'karaoke-pill' | 'caps-stroke' | 'clean-color'
export type SubtitleMvpFormat = Extract<OutputAspectRatio, '9:16' | '16:9'>

export const SUBTITLE_PRESET_IDS: readonly SubtitlePresetId[] =
  Object.freeze(['kinetic', 'karaoke-box', 'karaoke-pill', 'caps-stroke', 'clean-color'] as const)

/** Every registered family (Inter, Archivo Black) and every materialized font asset ships under this licence. */
export const OFL_LICENSE_URL = 'https://openfontlicense.org/open-font-license-official-text/'

/**
 * `fontPx`/`bottom` are authored at `referenceHeight`; a renderer scales `fontPx` linearly by
 * `canvasHeight / referenceHeight` so the same token means the same optical size at proxy and
 * delivery resolutions. `bottom`/`maxWidth` are already canvas fractions.
 */
export type SubtitleFormatLimits = Readonly<{ referenceHeight: number; fontPx: number; maxWidth: number; bottom: number }>

/**
 * Casing is a token of its own, not a boolean hidden inside typography (FR-172). The union is
 * closed so an unknown casing fails validation instead of silently rendering untransformed text.
 */
export const SUBTITLE_CASINGS = Object.freeze(['none', 'uppercase', 'lowercase', 'title'] as const)
export type SubtitleCasing = (typeof SUBTITLE_CASINGS)[number]

/** Vertical band the block is anchored to. Same vocabulary the perception anchor (FR-173) speaks. */
export const SUBTITLE_STYLE_ANCHORS = Object.freeze(['top', 'upper-third', 'center', 'lower-third', 'bottom'] as const)
export type SubtitleStyleAnchor = (typeof SUBTITLE_STYLE_ANCHORS)[number]

/** Canvas fractions the block may never cross. Authored per format — a 16:9 frame has different UI chrome. */
export type SubtitleSafeArea = Readonly<{ top: number; bottom: number; horizontal: number }>
export type SubtitlePlacementFormat = Readonly<{ anchor: SubtitleStyleAnchor; safeArea: SubtitleSafeArea }>

/**
 * The block is laid out as `maxLines` lines at this line-height. It is the same 1.1 the Remotion
 * container and the CSS preview use, so the height the validator bounds against the safe area is
 * the height that is actually painted — not an independent guess.
 */
export const SUBTITLE_LINE_HEIGHT = 1.1

export interface SubtitleStylePreset {
  schemaVersion: 'subtitle-style-preset/v2'
  id: SubtitlePresetId
  /** Immutable content version of *this* preset. The shape around it evolved to v2; the five canonical presets are still their first authored revision. */
  presetVersion: 1
  typography: Readonly<{
    fontFamily: string
    fallback: readonly string[]
    licensed: true
    licenseSpdx: 'OFL-1.1'
    licenseUrl: string
    glyphCoverage: 'latin-ext'
    weight: number
  }>
  casing: SubtitleCasing
  lineBreaking: Readonly<{ maxLines: number; maxCharacters: number }>
  /**
   * How words become on-screen groups and for how long each group may hold. `maxWordsPerGroup` is
   * what the renderer chunks by (it replaced the old `lineBreaking.chunkWords`); the cadence bounds
   * are enforced against the real cues when the subtitle section is materialized.
   */
  grouping: Readonly<{ maxWordsPerGroup: number; minOnScreenMs: number; maxOnScreenMs: number; gapMergeMs: number }>
  highlight: Readonly<{ mode: 'word' | 'phrase' | 'none'; color: string; inactiveColor: string }>
  background: Readonly<{ shape: 'none' | 'box' | 'pill'; color: string; opacity: number; radius: number; paddingXEm: number; paddingYEm: number }>
  /**
   * Legibility treatment for presets without an opaque container. `widthEm` is relative to the
   * rendered font size, so the outline holds its proportion at proxy and delivery resolutions.
   */
  stroke: Readonly<{ widthEm: number; color: string }>
  /**
   * Cast shadow behind the glyphs. Authored in absolute pixels because that is what the renderer
   * has always painted: a blur that scaled with the font would read as a different treatment at
   * proxy and delivery resolutions.
   */
  shadow: Readonly<{ enabled: boolean; offsetXPx: number; offsetYPx: number; blurPx: number; color: string; opacity: number }>
  animation: Readonly<{ kind: 'scale' | 'karaoke' | 'fade'; version: 1; durationMs: number; reducedMotion: 'fade' | 'none' }>
  placement: Readonly<{ formats: Readonly<Record<SubtitleMvpFormat, SubtitlePlacementFormat>> }>
  margins: Readonly<{ horizontal: number; vertical: number }>
  responsive: Readonly<{
    minFontPx: number
    maxFontPx: number
    formats: Readonly<Record<SubtitleMvpFormat, SubtitleFormatLimits>>
  }>
  presetHash: string
}

/** CSS `text-transform` for a casing token. Single source for the preview and the Remotion renderer. */
export function subtitleTextTransform(casing: SubtitleCasing): 'none' | 'uppercase' | 'lowercase' | 'capitalize' {
  return casing === 'title' ? 'capitalize' : casing
}

/** CSS `text-shadow` for a shadow token, or `undefined` when the preset declares none. */
export function subtitleTextShadowCss(shadow: Readonly<SubtitleStylePreset['shadow']>): string | undefined {
  if (!shadow.enabled) return undefined
  const channels = [1, 3, 5].map((index) => parseInt(shadow.color.slice(index, index + 2), 16))
  return `${shadow.offsetXPx}px ${shadow.offsetYPx}px ${shadow.blurPx}px rgba(${channels[0]},${channels[1]},${channels[2]},${shadow.opacity})`
}

/**
 * Every renderable aspect ratio declares — as versioned, hash-covered data — which MVP subtitle
 * format carries its tokens. Nothing is inferred from pixel dimensions at render time, so 16:9
 * can never silently inherit the portrait tokens (nor a generic hardcoded default).
 */
export const SUBTITLE_FORMAT_BY_ASPECT_RATIO: Readonly<Record<OutputAspectRatio, SubtitleMvpFormat>> = Object.freeze({
  '9:16': '9:16', '4:5': '9:16', '16:9': '16:9', '1:1': '16:9', '21:9': '16:9',
})

export function resolveSubtitleMvpFormat(aspectRatio: string): SubtitleMvpFormat {
  const format = (SUBTITLE_FORMAT_BY_ASPECT_RATIO as Record<string, SubtitleMvpFormat | undefined>)[aspectRatio]
  if (!format || !OUTPUT_ASPECT_RATIOS.includes(aspectRatio as OutputAspectRatio)) {
    throw new DomainError('INVALID_ARGUMENT', 'Aspect ratio has no registered subtitle format')
  }
  return format
}

/**
 * Deterministic font stack: the materialized licensed asset first (when the render input carries
 * one), then the preset's registered family, then its registered fallbacks. Same order in the CSS
 * preview and in the Remotion renderer, so the preview never promises a face the render drops.
 */
export function subtitleFontStack(style: Readonly<SubtitleStylePreset>, materializedFamily?: string): readonly string[] {
  const families = [...(materializedFamily ? [materializedFamily] : []), style.typography.fontFamily, ...style.typography.fallback]
  return Object.freeze(families.filter((family, index) => families.indexOf(family) === index))
}

export function subtitleFontStackCss(style: Readonly<SubtitleStylePreset>, materializedFamily?: string): string {
  return subtitleFontStack(style, materializedFamily)
    .map((family) => family === 'sans-serif' ? family : JSON.stringify(family)).join(',')
}

export type SubtitleRenderMetrics = Readonly<{
  format: SubtitleMvpFormat
  fontPx: number
  bottomPx: number
  maxWidthPercent: number
  strokePx: number
  limits: SubtitleFormatLimits
  /** Placement actually resolved for this format — never inferred from the canvas. */
  anchor: SubtitleStyleAnchor
  safeArea: SubtitleSafeArea
  /** Painted height of the block at `maxLines`, the quantity bounded against the safe area. */
  blockPx: number
}>

/**
 * An outline thinner than this does not survive rasterization — it degrades into antialiasing and
 * stops carrying contrast. Proxy renders scale `fontPx` down, so the em-relative stroke is floored
 * here; at delivery resolutions the authored width is always well above the floor and unaffected.
 */
export const MIN_RASTERIZED_STROKE_PX = 3

/**
 * Single source of the geometry every renderer must use. `format` is the resolved MVP format —
 * never inferred from the canvas — and an unregistered one fails closed instead of silently
 * falling back to a generic style.
 */
export function resolveSubtitleRenderMetrics(
  style: Readonly<SubtitleStylePreset>,
  format: SubtitleMvpFormat,
  canvasHeight: number,
): SubtitleRenderMetrics {
  const limits = style.responsive.formats?.[format]
  if (!limits) throw new DomainError('INVALID_ARGUMENT', 'Subtitle preset has no limits for the requested format')
  if (!Number.isFinite(canvasHeight) || canvasHeight <= 0) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle canvas height is invalid')
  }
  const placement = style.placement?.formats?.[format]
  if (!placement) throw new DomainError('INVALID_ARGUMENT', 'Subtitle preset has no placement for the requested format')
  const fontPx = Math.max(1, Math.round(limits.fontPx * (canvasHeight / limits.referenceHeight)))
  const blockPx = Math.round(fontPx * SUBTITLE_LINE_HEIGHT * style.lineBreaking.maxLines)
  const bottomPx = resolveSubtitleBottomPx(placement.anchor, limits.bottom, canvasHeight, blockPx)
  // Fail-closed bounds: the resolved band must sit inside the safe area authored for THIS format.
  // A landscape preset that would push the block under a platform UI bar stops the render here
  // instead of producing an unreadable frame.
  if (bottomPx < Math.floor(canvasHeight * placement.safeArea.bottom) ||
      bottomPx + blockPx > Math.ceil(canvasHeight * (1 - placement.safeArea.top))) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle placement leaves the safe area for this format')
  }
  return Object.freeze({
    format,
    fontPx,
    bottomPx,
    maxWidthPercent: limits.maxWidth * 100,
    strokePx: style.stroke.widthEm > 0 ? Math.max(MIN_RASTERIZED_STROKE_PX, style.stroke.widthEm * fontPx) : 0,
    limits,
    anchor: placement.anchor,
    safeArea: placement.safeArea,
    blockPx,
  })
}

/**
 * Distance from the bottom edge for each anchor. `bottom` and `top` use the authored per-format
 * offset (measured from their own edge); the three band anchors are fixed fractions of the canvas
 * so "center" means the same thing in 9:16 and 16:9.
 */
export function resolveSubtitleBottomPx(anchor: SubtitleStyleAnchor, offset: number, canvasHeight: number, blockPx: number): number {
  switch (anchor) {
    case 'bottom': return Math.round(canvasHeight * offset)
    case 'lower-third': return Math.round(canvasHeight / 4 - blockPx / 2)
    case 'center': return Math.round(canvasHeight / 2 - blockPx / 2)
    case 'upper-third': return Math.round(canvasHeight * 3 / 4 - blockPx / 2)
    case 'top': return Math.round(canvasHeight * (1 - offset)) - blockPx
  }
}
