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

export interface SubtitleStylePreset {
  schemaVersion: 'subtitle-style-preset/v1'
  id: SubtitlePresetId
  version: 1
  typography: Readonly<{
    fontFamily: string
    fallback: readonly string[]
    licensed: true
    licenseSpdx: 'OFL-1.1'
    licenseUrl: string
    glyphCoverage: 'latin-ext'
    weight: number
    uppercase: boolean
  }>
  lineBreaking: Readonly<{ maxLines: number; maxCharacters: number; chunkWords: number }>
  highlight: Readonly<{ mode: 'word' | 'phrase' | 'none'; color: string; inactiveColor: string }>
  background: Readonly<{ shape: 'none' | 'box' | 'pill'; color: string; opacity: number; radius: number; paddingXEm: number; paddingYEm: number }>
  /**
   * Legibility treatment for presets without an opaque container. `widthEm` is relative to the
   * rendered font size, so the outline holds its proportion at proxy and delivery resolutions.
   */
  stroke: Readonly<{ widthEm: number; color: string }>
  animation: Readonly<{ kind: 'scale' | 'karaoke' | 'fade'; version: 1; durationMs: number; reducedMotion: 'fade' | 'none' }>
  margins: Readonly<{ horizontal: number; vertical: number }>
  responsive: Readonly<{
    minFontPx: number
    maxFontPx: number
    formats: Readonly<Record<SubtitleMvpFormat, SubtitleFormatLimits>>
  }>
  presetHash: string
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
  const fontPx = Math.max(1, Math.round(limits.fontPx * (canvasHeight / limits.referenceHeight)))
  return Object.freeze({
    format,
    fontPx,
    bottomPx: Math.round(canvasHeight * limits.bottom),
    maxWidthPercent: limits.maxWidth * 100,
    strokePx: style.stroke.widthEm > 0 ? Math.max(MIN_RASTERIZED_STROKE_PX, style.stroke.widthEm * fontPx) : 0,
    limits,
  })
}
