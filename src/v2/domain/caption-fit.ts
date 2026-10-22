import { layoutBurnedCaption, type CaptionGeometry } from './caption-burn-layout.ts'
import { captionFontPx } from './caption-text-layout.ts'
import type { OutputSpec } from './output-spec.ts'
import { deriveSubtitleRegion } from './subtitle-region.ts'
import { readSubtitlePreset, resolveSubtitleMvpFormat, resolveSubtitleRenderMetrics, type SubtitlePresetId } from './subtitle-system.ts'

/**
 * Whether a caption fits the output it is burned into, measured the way the renderer draws it (ADR-160 F3; the W69 layout of
 * `caption-burn-layout.ts`). The Director plans one cue track for every output of a project, so a cue is acceptable only when it fits the
 * band of EVERY output that burns captions: the width is the output's own, never a number the planner carries.
 *
 * The geometry is derived from the OutputSpec and the preset alone - the same `deriveSubtitleRegion` the placement planner starts from -
 * so it can be computed before any perception exists and recomputed later from the numbers a policy sealed.
 */
export type CaptionDeliveryMode = 'none' | 'burn-in' | 'sidecar'

/** What a burn-in output contributes to the fit: the geometry its captions are drawn with. All numbers are canvas pixels. */
export type CaptionFitGeometry = Readonly<{
  variantId: string
  aspectRatio: string
  fontPx: number
  maxLines: number
  bandWidthPx: number
  bandHeightPx: number
}>

const round = (value: number): number => Math.round(value * 1_000) / 1_000

export function captionFitGeometryFor(input: Readonly<{ variantId: string; spec: Readonly<OutputSpec>; presetId: SubtitlePresetId }>): CaptionFitGeometry {
  const preset = readSubtitlePreset(input.presetId)
  const region = deriveSubtitleRegion({ spec: input.spec, presetId: input.presetId })
  const metrics = resolveSubtitleRenderMetrics(preset, resolveSubtitleMvpFormat(input.spec.aspectRatio), input.spec.height)
  const bandWidthPx = round(region.bounds.width * input.spec.width)
  const bandHeightPx = round(region.bounds.height * input.spec.height)
  const maxLines = preset.lineBreaking.maxLines
  return Object.freeze({
    variantId: input.variantId, aspectRatio: input.spec.aspectRatio,
    fontPx: captionFontPx({ metrics, bandHeightPx, maxLines }), maxLines, bandWidthPx, bandHeightPx,
  })
}

/** True when `text` is laid out in `geometry` within its lines and its width. */
export function captionTextFitsGeometry(text: string, geometry: Readonly<CaptionFitGeometry>): boolean {
  if (text.trim().length === 0) return true
  const frame: CaptionGeometry = Object.freeze({ fontPx: geometry.fontPx, maxLines: geometry.maxLines, bandWidthPx: geometry.bandWidthPx, bandHeightPx: geometry.bandHeightPx })
  return layoutBurnedCaption({ text, geometry: frame }).layout.fits
}

export function captionTextFitsEveryOutput(text: string, geometries: readonly Readonly<CaptionFitGeometry>[]): boolean {
  return geometries.every((geometry) => captionTextFitsGeometry(text, geometry))
}

/** The cues (by id) whose text does not fit some burn-in output, with the first output that refuses them. */
export function captionCuesThatDoNotFit(
  cues: readonly Readonly<{ id: string; text: string }>[],
  geometries: readonly Readonly<CaptionFitGeometry>[],
): readonly Readonly<{ cueId: string; variantId: string }>[] {
  const refused: { cueId: string; variantId: string }[] = []
  for (const cue of cues) {
    const geometry = geometries.find((candidate) => !captionTextFitsGeometry(cue.text, candidate))
    if (geometry) refused.push(Object.freeze({ cueId: cue.id, variantId: geometry.variantId }))
  }
  return Object.freeze(refused)
}
