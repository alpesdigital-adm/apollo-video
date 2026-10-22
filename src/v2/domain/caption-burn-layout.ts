import { DomainError } from './errors.ts'
import { CAPTION_TEXT_LAYOUT_ID, captionFontPx, captionTextWidthPx, canonicalCaptionText, layoutCaption, type CaptionLayout } from './caption-text-layout.ts'
import { applyAssCasing, assPresetOutlineWidth } from './subtitle-ass-preset-style.ts'
import { frameToMs, subtitleAnchorDecisionFor, type SubtitleAnchorPlan } from './subtitle-anchor-plan.ts'
import { readSubtitlePreset, resolveSubtitleMvpFormat, resolveSubtitleRenderMetrics, type SubtitlePresetId } from './subtitle-system.ts'

/**
 * W70 readiness (R3). How a BURNED caption is laid out, in one place: the FFmpeg/libass renderer draws exactly these lines, and the render
 * workers decide - before anything is rendered - what a caption that does not fit its band costs.
 *
 * `layoutCaption` reports `fits: false` when the text needs more than the preset's `maxLines` lines of the certified band, or a line wider than
 * the band. Such a caption is still laid out in full (cutting it would burn a text nobody wrote) and it overflows the band the plan certified.
 * The W65 pixel critic sees it only beyond its tolerance: a three-line caption in the two-line 16:9 band overflows by less than its 6 px, so it
 * used to pass. The layout's own verdict is now the authority:
 *  - in a PROXY the cue is drawn as it is and `CAPTION_TEXT_DOES_NOT_FIT` is a HARD issue (the proxy is blocked until the text is shortened);
 *  - in a FINAL the cue is OMITTED (never burned) and LISTED as a review item in the caption certification receipt (the W65b rule).
 */
export const CAPTION_TEXT_DOES_NOT_FIT = 'CAPTION_TEXT_DOES_NOT_FIT' as const

export type CaptionGeometry = Readonly<{ fontPx: number; maxLines: number; bandWidthPx: number; bandHeightPx: number }>

/**
 * The geometry every caption of a render is drawn with, derived from the placement plan that certified its bands (single geometry): the
 * font is the preset's own size at this canvas (reduced only when the certified band is too short for `maxLines` lines of it) and a line
 * may take the width of the band. The plan must describe this canvas, or the render does not start.
 */
export function deriveCaptionGeometry(plan: Readonly<SubtitleAnchorPlan>, canvas: Readonly<{ width: number; height: number }>): CaptionGeometry {
  if (plan.canvas.width !== canvas.width || plan.canvas.height !== canvas.height) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle anchor plan was decided on another canvas than the one being drawn')
  }
  const preset = readSubtitlePreset(plan.presetId)
  const metrics = resolveSubtitleRenderMetrics(preset, resolveSubtitleMvpFormat(plan.format), canvas.height)
  const bandWidthPx = plan.bands.bottom.width * canvas.width
  const bandHeightPx = plan.bands.bottom.height * canvas.height
  const maxLines = preset.lineBreaking.maxLines
  return Object.freeze({ fontPx: captionFontPx({ metrics, bandHeightPx, maxLines }), maxLines, bandWidthPx, bandHeightPx })
}

/**
 * The lines one caption is burned in. `presetId` is the preset of a per-segment `style` exception (W68): its casing is applied and its
 * outline (or box padding) takes room beside the text; a cue without one is drawn with the `Default` style (outline 1, the text as written).
 * The five bands share one box, so the result does not depend on the band the cue was placed in.
 */
export function layoutBurnedCaption(input: Readonly<{ text: string; presetId?: SubtitlePresetId; geometry: CaptionGeometry }>): Readonly<{
  layout: CaptionLayout; outlinePx: number; maxWidthPx: number
}> {
  const outlinePx = input.presetId ? assPresetOutlineWidth(input.presetId, input.geometry.fontPx) : 1
  const canonical = canonicalCaptionText(input.text)
  const text = input.presetId ? applyAssCasing(canonical, readSubtitlePreset(input.presetId).casing) : canonical
  const maxWidthPx = captionTextWidthPx(input.geometry.bandWidthPx, outlinePx)
  return Object.freeze({
    layout: layoutCaption({ text, fontPx: input.geometry.fontPx, maxLines: input.geometry.maxLines, maxWidthPx }),
    outlinePx, maxWidthPx,
  })
}

export type CaptionLayoutOverflowV1 = Readonly<{
  code: typeof CAPTION_TEXT_DOES_NOT_FIT
  layoutId: typeof CAPTION_TEXT_LAYOUT_ID
  cueId: string
  /** Half-open timeline frames of the cue. */
  startFrame: number
  endFrame: number
  rangeMs: readonly [number, number]
  lines: number
  maxLines: number
  widthPx: number
  maxWidthPx: number
  fontPx: number
  message: string
}>

/**
 * The cues the plan DRAWS (placed in a band) whose text does not fit that band. A cue the plan does not draw (suppressed, omitted for want of
 * evidence) is not burned, so it cannot overflow anything. Nothing here depends on pixels: it is known before the render starts.
 */
export function captionLayoutOverflows(input: Readonly<{
  anchorPlan: Readonly<SubtitleAnchorPlan> | null | undefined
  cues: readonly Readonly<{ id: string; text: string; startFrame: number; endFrame: number; presetId?: SubtitlePresetId }>[]
  canvas: Readonly<{ width: number; height: number }>
}>): readonly CaptionLayoutOverflowV1[] {
  const plan = input.anchorPlan
  if (!plan || input.cues.length === 0) return Object.freeze([])
  const geometry = deriveCaptionGeometry(plan, input.canvas)
  const overflows: CaptionLayoutOverflowV1[] = []
  for (const cue of input.cues) {
    const decision = subtitleAnchorDecisionFor(plan, cue.id)
    if (!decision || decision.suppressed || decision.bounds === null) continue
    const { layout, maxWidthPx } = layoutBurnedCaption({ text: cue.text, ...(cue.presetId ? { presetId: cue.presetId } : {}), geometry })
    if (layout.fits) continue
    const widthPx = Math.round(layout.widthPx * 10) / 10
    const lineWidth = Math.round(maxWidthPx * 10) / 10
    overflows.push(Object.freeze({
      code: CAPTION_TEXT_DOES_NOT_FIT, layoutId: CAPTION_TEXT_LAYOUT_ID,
      cueId: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame,
      rangeMs: Object.freeze([frameToMs(cue.startFrame, plan.fps), frameToMs(cue.endFrame, plan.fps)] as const),
      lines: layout.lines.length, maxLines: geometry.maxLines, widthPx, maxWidthPx: lineWidth, fontPx: geometry.fontPx,
      message: layout.lines.length > geometry.maxLines
        ? `Caption ${cue.id} needs ${layout.lines.length} lines of ${geometry.fontPx} px; its band holds ${geometry.maxLines}. Shorten the text.`
        : `Caption ${cue.id} has a line ${widthPx} px wide; its band takes ${lineWidth} px. Shorten the text.`,
    }))
  }
  return Object.freeze(overflows)
}
