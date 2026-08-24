import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { EditorialProxyRenderer } from '../../application/ports/editorial-proxy-renderer.ts'
import { MAX_PARTIAL_RENDER_RANGES } from '../../application/ports/project-proxy-render-repository.ts'
import { assertClipRate, timelineSpanForRate } from '../../domain/clip-timing.ts'
import { DomainError } from '../../domain/errors.ts'
import { OUTPUT_FORMAT_REGISTRY } from '../../domain/output-format-registry.ts'
import { validateRenderPlacementPlan, type RenderPlacementPlanV1 } from '../../domain/render-placement-plan.ts'
import { validateRenderReframePlan, type RenderReframeRangeV1 } from '../../domain/render-reframe-plan.ts'
import { createEditorialAudioTimelineHash } from '../../domain/production-modes.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { parseProjectColorPlan } from '../../domain/project-color-plan.ts'
import { buildRenderElementMap } from '../../domain/review-system.ts'
import { subtitleAnchorDecisionFor, type SubtitleAnchorPlanV1 } from '../../domain/subtitle-anchor-plan.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'
import { FfmpegColorPipelineProcessor } from './ffmpeg-color-pipeline-processor.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

const FORMAT_DIMENSIONS: Readonly<Record<string, readonly [number, number]>> = Object.freeze(
  Object.fromEntries(Object.entries(OUTPUT_FORMAT_REGISTRY.presets).map(([ratio, preset]) => [
    ratio,
    Object.freeze([preset.exportDefaults.proxy.width, preset.exportDefaults.proxy.height]) as readonly [number, number],
  ])),
)

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial render work path escaped its root')
}

function assTimestamp(frame: number, fps: number): string {
  const centiseconds = Math.max(0, Math.round(frame / fps * 100))
  const hours = Math.floor(centiseconds / 360_000)
  const minutes = Math.floor(centiseconds % 360_000 / 6_000)
  const seconds = Math.floor(centiseconds % 6_000 / 100)
  const fraction = centiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
}

function wrapAssText(value: string, maxCharacters = 20): string {
  const lines: string[] = []
  let line = ''
  for (const word of value.replace(/[{}\\]/g, '').split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && candidate.length > maxCharacters && lines.length === 0) {
      lines.push(line)
      line = word
    } else line = candidate
  }
  if (line) lines.push(line)
  return lines.slice(0, 2).join('\\N')
}

function buildAssSubtitles(input: {
  width: number
  height: number
  fps: number
  cues: NonNullable<Parameters<EditorialProxyRenderer['render']>[0]['subtitleCues']>
  ctaOverlays?: NonNullable<Parameters<EditorialProxyRenderer['render']>[0]['ctaOverlays']>
  /**
   * F1.036 decision. When present it wins over `cue.anchor`: the Director's anchor is only the
   * face-safe fallback, while this plan is the one that actually consulted the perception
   * evidence. Positions come from the decided band, not from a constant written here, so the
   * pixels and the plan cannot disagree.
   */
  anchorPlan?: Readonly<SubtitleAnchorPlanV1> | null
}): string {
  const fontSize = Math.max(
    32,
    Math.min(
      72,
      Math.round(Math.min(input.width * 0.059, input.height * 0.067)),
    ),
  )
  const marginHorizontal = Math.round(input.width * 0.07)
  const marginVertical = Math.round(input.height * 0.075)
  const events = input.cues.flatMap((cue) => {
    const decision = input.anchorPlan ? subtitleAnchorDecisionFor(input.anchorPlan, cue.id) : null
    // A cue with nowhere safe to go is not drawn. Covering a face is never the cheaper option.
    if (decision?.suppressed) return []
    if (decision?.bounds) {
      // `\an5` centres the box on the point, so the point is the centre of the decided band.
      const centreX = Math.round((decision.bounds.x + decision.bounds.width / 2) * input.width)
      const centreY = Math.round((decision.bounds.y + decision.bounds.height / 2) * input.height)
      return [`Dialogue: 0,${assTimestamp(cue.startFrame, input.fps)},${assTimestamp(cue.endFrame, input.fps)},Default,,0,0,0,,{\\an5\\pos(${centreX},${centreY})}${wrapAssText(cue.text)}`]
    }
    const anchor = cue.anchor ?? 'bottom'
    const override = anchor === 'bottom' ? ''
      : anchor === 'lower-third' ? `{\\an2\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.76)})}`
        : anchor === 'center' ? `{\\an5\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.5)})}`
          : anchor === 'upper-third' ? `{\\an8\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.3)})}`
            : `{\\an8\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.08)})}`
    return [`Dialogue: 0,${assTimestamp(cue.startFrame, input.fps)},${assTimestamp(cue.endFrame, input.fps)},Default,,0,0,0,,${override}${wrapAssText(cue.text)}`]
  })
  const ctaEvents = (input.ctaOverlays ?? []).map((overlay) =>
    `Dialogue: 1,${assTimestamp(overlay.startFrame, input.fps)},${assTimestamp(overlay.endFrame, input.fps)},CTA,,0,0,0,,{\\an8\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.1)})}${wrapAssText(overlay.text, 28)}`)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${input.width}`,
    `PlayResY: ${input.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H0038AFE1,&H00111111,&H78000000,-1,0,0,0,100,100,0,0,3,1,0,2,${marginHorizontal},${marginHorizontal},${marginVertical},1`,
    `Style: CTA,Arial,${Math.max(28, Math.round(fontSize * 0.82))},&H00111111,&H00111111,&H00FFFFFF,&H00E1AF38,-1,0,0,0,100,100,0,0,3,2,0,8,${marginHorizontal},${marginHorizontal},${marginVertical},1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    ...ctaEvents,
    '',
  ].join('\n')
}

function escapeSubtitleFilterPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

type EditorialRenderInput = Parameters<EditorialProxyRenderer['render']>[0]

function normalizedCropFilter(
  crop: NonNullable<EditorialRenderInput['clips'][number]['crop']>,
  source: { width: number; height: number },
): string {
  const values = [crop.x, crop.y, crop.width, crop.height]
  if (
    values.some((value) => !Number.isFinite(value)) ||
    crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
    crop.width > 1 || crop.height > 1 ||
    crop.x + crop.width > 1 || crop.y + crop.height > 1
  ) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial clip crop is invalid')
  const availableWidth = source.width - source.width % 2
  const availableHeight = source.height - source.height % 2
  const x = Math.floor(crop.x * source.width / 2) * 2
  const y = Math.floor(crop.y * source.height / 2) * 2
  const right = Math.min(
    availableWidth,
    Math.ceil((crop.x + crop.width) * source.width / 2) * 2,
  )
  const bottom = Math.min(
    availableHeight,
    Math.ceil((crop.y + crop.height) * source.height / 2) * 2,
  )
  const width = right - x
  const height = bottom - y
  if (width < 2 || height < 2) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Editorial clip crop has no encodable pixels')
  }
  return `crop=${width}:${height}:${x}:${y},`
}

const evenFloor = (value: number, maximum: number): number =>
  Math.max(0, Math.min(maximum, Math.floor(value / 2) * 2))

/**
 * Deterministic crop for one reframe range.
 *
 * A single keyframe collapses to the constant `crop=w:h:x:y` the renderer already emitted. Two or
 * more keyframes become an FFmpeg expression on `n` — the crop filter re-evaluates `x`/`y` for
 * every frame, so the trajectory is computed by the filter itself instead of being approximated by
 * a stack of trimmed segments. Frame indices are integers and the piecewise slopes are fixed at
 * build time, so two runs of the same plan emit byte-identical filter strings.
 *
 * Crop *size* is constant by construction (the plan rejects a changing one), because a stream
 * whose frame size changes mid-clip cannot be encoded deterministically.
 */
export function buildReframeCropFilter(input: Readonly<{
  range: Readonly<RenderReframeRangeV1>
  source: Readonly<{ width: number; height: number }>
}>): string {
  const { range, source } = input
  const first = range.keyframes[0]!
  const availableWidth = source.width - source.width % 2
  const availableHeight = source.height - source.height % 2
  const width = Math.min(availableWidth, Math.floor(first.crop.width * source.width / 2) * 2)
  const height = Math.min(availableHeight, Math.floor(first.crop.height * source.height / 2) * 2)
  if (width < 2 || height < 2) throw new DomainError('INVALID_RENDER_INPUT', 'Reframe crop has no encodable pixels')
  const maxX = availableWidth - width
  const maxY = availableHeight - height
  if (range.keyframes.length === 1) {
    return `crop=${width}:${height}:${evenFloor(first.crop.x * source.width, maxX)}:${evenFloor(first.crop.y * source.height, maxY)},`
  }
  const axis = (key: 'x' | 'y', scale: number, limit: number): string => {
    const points = range.keyframes.map((keyframe) => Object.freeze({
      frame: keyframe.frame - range.startFrame,
      value: Math.max(0, Math.min(limit, keyframe.crop[key] * scale)),
    }))
    let expression = points.at(-1)!.value.toFixed(4)
    for (let index = points.length - 2; index >= 0; index -= 1) {
      const from = points[index]!
      const to = points[index + 1]!
      const slope = (to.value - from.value) / (to.frame - from.frame)
      const segment = range.interpolation === 'hold'
        ? from.value.toFixed(4)
        : `${from.value.toFixed(4)}+(${slope.toFixed(6)})*(n-${from.frame})`
      expression = `if(lt(n,${to.frame}),${segment},${expression})`
    }
    return `2*floor(min(max(${expression},0),${limit})/2)`
  }
  // Single quotes keep the commas of the expression inside one filter argument.
  return `crop=${width}:${height}:'${axis('x', source.width, maxX)}':'${axis('y', source.height, maxY)}',`
}

/**
 * Painter-ordered overlay chain for the drawable placements of a plan. Each asset is scaled to the
 * pixel box its normalized bounds describe and gated by `enable='between(n,start,end-1)'` — the
 * half-open `[startFrame, endFrame)` interval of the plan, expressed in FFmpeg's inclusive form.
 */
export function buildPlacementOverlayFilters(input: Readonly<{
  plan: Readonly<RenderPlacementPlanV1>
  assetInputIndexByElementId: Readonly<Record<string, number>>
  inputLabel: string
  outputLabel: string
}>): readonly string[] {
  const drawable = input.plan.placements.filter((placement) => placement.assetArtifactId !== null)
  if (!drawable.length) return Object.freeze([`[${input.inputLabel}]null[${input.outputLabel}]`])
  const { width, height } = input.plan.canvas
  const filters: string[] = []
  let current = input.inputLabel
  drawable.forEach((placement, index) => {
    const inputIndex = input.assetInputIndexByElementId[placement.elementId]
    if (inputIndex === undefined) throw new DomainError('INVALID_RENDER_INPUT', 'Placement asset input is missing')
    const boxWidth = Math.max(2, Math.round(placement.bounds.width * width / 2) * 2)
    const boxHeight = Math.max(2, Math.round(placement.bounds.height * height / 2) * 2)
    const x = Math.max(0, Math.min(width - boxWidth, Math.round(placement.bounds.x * width)))
    const y = Math.max(0, Math.min(height - boxHeight, Math.round(placement.bounds.y * height)))
    const next = index === drawable.length - 1 ? input.outputLabel : `geo${index + 1}`
    filters.push(`[${inputIndex}:v]scale=${boxWidth}:${boxHeight},format=rgba,setsar=1[plc${index}]`)
    filters.push(
      `[${current}][plc${index}]overlay=${x}:${y}:` +
      `enable='between(n,${placement.timeRange.startFrame},${placement.timeRange.endFrame - 1})':` +
      `eof_action=repeat[${next}]`,
    )
    current = next
  })
  return Object.freeze(filters)
}

type PartialRange = Readonly<{ startFrame: number; endFrame: number }>

export { assertClipRate }

/**
 * `atempo` only accepts factors in [0.5, 2.0], so a rate outside that window is
 * expressed as a chain (rate 4 becomes 2.0 x 2.0, rate 0.25 becomes 0.5 x 0.5).
 */
export function atempoFactors(rate: number): readonly number[] {
  const factors: number[] = []
  let remaining = rate
  while (remaining > 2) {
    factors.push(2)
    remaining /= 2
  }
  while (remaining < 0.5) {
    factors.push(0.5)
    remaining *= 2
  }
  factors.push(remaining)
  return Object.freeze(factors)
}

function assertClipTimeline(clip: EditorialRenderInput['clips'][number]): void {
  const rate = assertClipRate(clip.rate)
  const sourceSpan = clip.sourceOutFrame - clip.sourceInFrame
  const timelineSpan = clip.timelineOutFrame - clip.timelineInFrame
  if (
    !Number.isSafeInteger(clip.sourceInFrame) || !Number.isSafeInteger(clip.sourceOutFrame) ||
    !Number.isSafeInteger(clip.timelineInFrame) || !Number.isSafeInteger(clip.timelineOutFrame) ||
    clip.sourceInFrame < 0 || clip.timelineInFrame < 0 || sourceSpan < 1 || timelineSpan < 1
  ) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial clip frame range is invalid')
  if (timelineSpan !== timelineSpanForRate(sourceSpan, rate)) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      `Editorial clip timeline span ${timelineSpan} does not match its ${sourceSpan} source frames at rate ${rate}`,
    )
  }
}

export function mapTimelineRangeToSourceFrames(input: Readonly<{
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  overlapStartFrame: number
  overlapEndFrame: number
  rate: number
}>): Readonly<{ sourceInFrame: number; sourceOutFrame: number }> {
  const rate = assertClipRate(input.rate)
  if (
    ![input.sourceInFrame, input.sourceOutFrame, input.timelineInFrame, input.timelineOutFrame,
      input.overlapStartFrame, input.overlapEndFrame].every(Number.isSafeInteger) ||
    input.overlapStartFrame < input.timelineInFrame ||
    input.overlapEndFrame > input.timelineOutFrame ||
    input.overlapEndFrame <= input.overlapStartFrame
  ) throw new DomainError('INVALID_RENDER_INPUT', 'Partial proxy overlap is outside its timeline clip')
  // Map both absolute boundaries. Rounding the overlap length independently can
  // drift by one frame for fractional rates because round(a) + round(b) is not
  // generally equal to round(a + b).
  const sourceInFrame = input.sourceInFrame + Math.round(
    (input.overlapStartFrame - input.timelineInFrame) * rate,
  )
  const sourceOutFrame = input.sourceInFrame + Math.round(
    (input.overlapEndFrame - input.timelineInFrame) * rate,
  )
  if (sourceOutFrame <= sourceInFrame || sourceOutFrame > input.sourceOutFrame) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      'Partial proxy overlap cannot be represented by whole source frames at its rate',
    )
  }
  return Object.freeze({ sourceInFrame, sourceOutFrame })
}

/**
 * Canonical partial-render ranges: at least one, at most
 * `MAX_PARTIAL_RENDER_RANGES`, ordered, strictly disjoint (adjacency is fused
 * upstream by the domain) and never covering the whole timeline.
 */
function assertPartialRanges(
  ranges: readonly PartialRange[],
  fullExpectedFrames: number,
): readonly PartialRange[] {
  if (ranges.length < 1) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Partial proxy reuse requires at least one stale range')
  }
  if (ranges.length > MAX_PARTIAL_RENDER_RANGES) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      `Partial proxy reuse accepts at most ${MAX_PARTIAL_RENDER_RANGES} stale ranges`,
    )
  }
  let staleFrames = 0
  ranges.forEach((range, index) => {
    if (
      !Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrame) ||
      range.startFrame < 0 || range.endFrame <= range.startFrame ||
      range.endFrame > fullExpectedFrames
    ) throw new DomainError('INVALID_RENDER_INPUT', `Partial proxy range ${index} is invalid`)
    const previous = ranges[index - 1]
    if (previous && range.startFrame <= previous.endFrame) {
      throw new DomainError(
        'INVALID_RENDER_INPUT',
        `Partial proxy range ${index} is not ordered strictly after its predecessor`,
      )
    }
    staleFrames += range.endFrame - range.startFrame
  })
  if (staleFrames >= fullExpectedFrames) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      'Partial proxy ranges cover the whole timeline and cannot reuse a base proxy',
    )
  }
  return Object.freeze(ranges.map((range) =>
    Object.freeze({ startFrame: range.startFrame, endFrame: range.endFrame })))
}

function sliceRenderRange(input: EditorialRenderInput, range: {
  startFrame: number
  endFrame: number
}) {
  const clips = input.clips.flatMap((clip) => {
    const overlapStart = Math.max(range.startFrame, clip.timelineInFrame)
    const overlapEnd = Math.min(range.endFrame, clip.timelineOutFrame)
    if (overlapEnd <= overlapStart) return []
    const rate = assertClipRate(clip.rate)
    const { sourceInFrame, sourceOutFrame } = mapTimelineRangeToSourceFrames({
      sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
      overlapStartFrame: overlapStart, overlapEndFrame: overlapEnd, rate,
    })
    const leadingSourceFrames = sourceInFrame - clip.sourceInFrame
    const keptSourceFrames = sourceOutFrame - sourceInFrame
    const audioSourceInFrame = (clip.audioSourceInFrame ?? clip.sourceInFrame) + leadingSourceFrames
    const audioSourceOutFrame = audioSourceInFrame + keptSourceFrames
    return [Object.freeze({
      ...clip,
      sourceInFrame,
      sourceOutFrame,
      ...(clip.audioSourceArtifactId ? { audioSourceArtifactId: clip.audioSourceArtifactId } : {}),
      audioSourceInFrame,
      audioSourceOutFrame,
      timelineInFrame: overlapStart - range.startFrame,
      timelineOutFrame: overlapEnd - range.startFrame,
    })]
  })
  const subtitleCues = input.subtitleCues?.flatMap((cue) => {
    const overlapStart = Math.max(range.startFrame, cue.startFrame)
    const overlapEnd = Math.min(range.endFrame, cue.endFrame)
    return overlapEnd > overlapStart
      ? [Object.freeze({
          ...cue,
          startFrame: overlapStart - range.startFrame,
          endFrame: overlapEnd - range.startFrame,
        })]
      : []
  })
  const ctaOverlays = input.ctaOverlays?.flatMap((overlay) => {
    const overlapStart = Math.max(range.startFrame, overlay.startFrame)
    const overlapEnd = Math.min(range.endFrame, overlay.endFrame)
    return overlapEnd > overlapStart
      ? [Object.freeze({
          ...overlay,
          startFrame: overlapStart - range.startFrame,
          endFrame: overlapEnd - range.startFrame,
        })]
      : []
  })
  const transitions = input.transitions
    ?.filter((transition) =>
      transition.atFrame > range.startFrame && transition.atFrame < range.endFrame)
    .map((transition) => Object.freeze({
      ...transition,
      atFrame: transition.atFrame - range.startFrame,
    }))
  const coveredFrames = clips.reduce(
    (total, clip) => total + clip.timelineOutFrame - clip.timelineInFrame,
    0,
  )
  if (clips.length < 1 || coveredFrames !== range.endFrame - range.startFrame) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      'Partial proxy range is not fully covered by the compiled timeline',
    )
  }
  return Object.freeze({
    clips: Object.freeze(clips),
    ...(subtitleCues ? { subtitleCues: Object.freeze(subtitleCues) } : {}),
    ...(ctaOverlays ? { ctaOverlays: Object.freeze(ctaOverlays) } : {}),
    ...(transitions ? { transitions: Object.freeze(transitions) } : {}),
  })
}

export class FfmpegEditorialProxyRenderer implements EditorialProxyRenderer {
  private readonly workRoot: string
  private readonly ffmpegPath: string
  private readonly colorProcessor: FfmpegColorPipelineProcessor

  constructor(options: { workRoot: string; ffmpegPath?: string }) {
    this.workRoot = resolve(options.workRoot)
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.colorProcessor = new FfmpegColorPipelineProcessor({ ffmpegPath: this.ffmpegPath })
  }

  private directory(operationId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'operationId is invalid')
    const directory = join(this.workRoot, operationId)
    assertContained(this.workRoot, directory)
    return directory
  }

  async render(input: Parameters<EditorialProxyRenderer['render']>[0]) {
    if (
      !Number.isFinite(input.fps) ||
      input.fps <= 0 ||
      input.clips.length < 1 ||
      input.sources.length < 1 ||
      input.sources.length > 128 ||
      new Set(input.sources.map((source) => source.artifactId)).size !== input.sources.length ||
      input.sources.some((source) =>
        !isAbsolute(source.path) ||
        !['video', 'audio'].includes(source.mediaType) ||
        (source.mediaType === 'video') !== Boolean(source.colorPipelineCompilation))
    ) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial proxy render input is invalid')
    for (const clip of input.clips) assertClipTimeline(clip)
    const fullExpectedFrames = input.clips.reduce(
      (total, clip) => total + clip.timelineOutFrame - clip.timelineInFrame,
      0,
    )
    const rangeReuse = input.rangeReuse
    if (rangeReuse && (
      input.renderKind !== 'proxy' ||
      rangeReuse.schemaVersion !== 'project-proxy-range-reuse/v1' ||
      !isAbsolute(rangeReuse.path) ||
      !/^[a-f0-9]{64}$/.test(rangeReuse.sha256) ||
      !Number.isSafeInteger(rangeReuse.byteSize) || rangeReuse.byteSize <= 0
    )) throw new DomainError('INVALID_RENDER_INPUT', 'Partial proxy reuse input is invalid')
    const ranges = rangeReuse
      ? assertPartialRanges(rangeReuse.ranges, fullExpectedFrames)
      : []
    const slices = ranges.map((range) => sliceRenderRange(input, range))
    for (const slice of slices) for (const clip of slice.clips) assertClipTimeline(clip)
    const renderClips = rangeReuse ? slices.flatMap((slice) => slice.clips) : input.clips
    // Structural and content-address checks on the materialized geometry run
    // BEFORE any FFmpeg process starts. They need nothing but the plans
    // themselves, so a tampered `placementPlanHash`/`reframePlanHash` must never
    // buy even the colour-normalization pre-pass below. The richer checks that
    // depend on probes and canvas dimensions stay where they are.
    if (input.reframePlan) validateRenderReframePlan(input.reframePlan)
    if (input.placementPlan) validateRenderPlacementPlan(input.placementPlan)
    const directory = this.directory(input.operationId)
    await mkdir(directory, { recursive: true })
    const colorPlan = input.colorPlan ? parseProjectColorPlan(input.colorPlan) : null
    const colorTargetKey = (clip: EditorialRenderInput['clips'][number]) => calculateCanonicalHash({
      sourceId: clip.sourceArtifactId.trim().toLowerCase(),
      ...(clip.cameraId ? { cameraId: clip.cameraId.trim().toLowerCase() } : {}),
      segmentId: clip.id.trim().toLowerCase(),
    })
    const colorTargetByKey = new Map(
      colorPlan?.compiled.targets.map((target) => [calculateCanonicalHash(target.target), target]) ?? [],
    )
    if (colorPlan && (
      colorTargetByKey.size !== input.clips.length ||
      input.clips.some((clip) => !colorTargetByKey.has(colorTargetKey(clip)))
    )) throw new DomainError('INVALID_RENDER_INPUT', 'ColorPlan target manifest does not cover this EditPlan exactly')

    const renderSources: Array<Readonly<EditorialRenderInput['sources'][number] & { colorPipelineHash?: string }>> = []
    const sourceIndex = new Map<string, number>()
    const clipVideoIndex = new Map<string, number>()
    for (const [sourceOrdinal, source] of input.sources.entries()) {
      if (source.mediaType !== 'video') {
        sourceIndex.set(source.artifactId, renderSources.length)
        renderSources.push(source)
        continue
      }
      const clipsForSource = input.clips.filter((clip) => clip.sourceArtifactId === source.artifactId)
      const executions = colorPlan
        ? [...new Map(clipsForSource.map((clip) => {
            const target = colorTargetByKey.get(colorTargetKey(clip))!
            return [target.pipelineHash, target] as const
          })).values()]
        : [source.colorPipelineCompilation!.pipeline]
      if (executions.length < 1) throw new DomainError('INVALID_RENDER_INPUT', 'Video source has no ColorPlan execution')
      for (const [pipelineOrdinal, pipeline] of executions.entries()) {
        if (
          calculateCanonicalHash(pipeline.sourceMetadata) !== calculateCanonicalHash(source.colorPipelineCompilation!.pipeline.sourceMetadata) ||
          calculateCanonicalHash(pipeline.outputMetadata) !== calculateCanonicalHash(source.colorPipelineCompilation!.pipeline.outputMetadata)
        ) throw new DomainError('INVALID_RENDER_INPUT', 'ColorPlan pipeline diverges from trusted source colorimetry')
        const outputPath = join(directory, `color-source-${String(sourceOrdinal).padStart(3, '0')}-${String(pipelineOrdinal).padStart(3, '0')}.mp4`)
        await rm(outputPath, { force: true })
        await this.colorProcessor.process({
          sourcePath: source.path,
          outputPath,
          ...(colorPlan
            ? { execution: { pipeline, executionHash: colorPlan.compiled.manifestHash } }
            : { compilation: source.colorPipelineCompilation! }),
          lutPaths: input.lutPaths,
          signal: input.signal,
        })
        const index = renderSources.length
        renderSources.push(Object.freeze({ ...source, path: outputPath, colorPipelineHash: pipeline.pipelineHash }))
        if (!sourceIndex.has(source.artifactId)) sourceIndex.set(source.artifactId, index)
        for (const clip of clipsForSource) {
          const target = colorPlan ? colorTargetByKey.get(colorTargetKey(clip)) : null
          if (!colorPlan || target?.pipelineHash === pipeline.pipelineHash) clipVideoIndex.set(clip.id, index)
        }
      }
    }
    for (const clip of renderClips) {
      const video = renderSources[clipVideoIndex.get(clip.id) ?? -1]
      const audioArtifactId = clip.audioSourceArtifactId ?? clip.sourceArtifactId
      const audio = renderSources[sourceIndex.get(audioArtifactId) ?? -1]
      const audioInFrame = clip.audioSourceInFrame ?? clip.sourceInFrame
      const audioOutFrame = clip.audioSourceOutFrame ?? clip.sourceOutFrame
      if (
        !video ||
        video.mediaType !== 'video' ||
        !audio ||
        !Number.isSafeInteger(clip.sourceInFrame) ||
        !Number.isSafeInteger(clip.sourceOutFrame) ||
        clip.sourceInFrame < 0 ||
        clip.sourceOutFrame <= clip.sourceInFrame ||
        !Number.isSafeInteger(audioInFrame) ||
        !Number.isSafeInteger(audioOutFrame) ||
        audioInFrame < 0 ||
        audioOutFrame <= audioInFrame ||
        audioOutFrame - audioInFrame !== clip.sourceOutFrame - clip.sourceInFrame
      ) {
        throw new DomainError(
          'INVALID_RENDER_INPUT',
          'Editorial clip source binding is invalid',
        )
      }
    }
    const dimensions = input.renderKind === 'final' && input.outputSpec
      ? [input.outputSpec.width, input.outputSpec.height] as const
      : FORMAT_DIMENSIONS[input.format]
    if (!dimensions) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial proxy format is not supported')
    if (
      input.renderKind === 'final' && (
        !input.outputSpec ||
        Math.abs(input.outputSpec.fps - input.fps) > 0.01 ||
        !Number.isSafeInteger(input.outputSpec.width) || input.outputSpec.width <= 0 || input.outputSpec.width % 2 !== 0 ||
        !Number.isSafeInteger(input.outputSpec.height) || input.outputSpec.height <= 0 || input.outputSpec.height % 2 !== 0
      )
    ) throw new DomainError('INVALID_RENDER_INPUT', 'Final editorial output spec is invalid')
    const outputFps = input.renderKind === 'final'
      ? input.outputSpec!.fps
      : input.fps
    const videoSources = renderSources.filter(
      (source) => source.mediaType === 'video',
    )
    const videoProbes = await Promise.all(
      videoSources.map(async (source) => ({
        artifactId: source.artifactId,
        probe: await probeVideo(source.path, {
          signal: input.signal,
          requireAudio: false,
        }),
      })),
    )
    const videoProbeByArtifactId = new Map(
      videoProbes.map((item) => [item.artifactId, item.probe]),
    )
    const stagingProbe = videoProbes.toSorted(
      (left, right) =>
        right.probe.width * right.probe.height -
        left.probe.width * left.probe.height,
    )[0]?.probe
    if (!stagingProbe) {
      throw new DomainError(
        'INVALID_RENDER_INPUT',
        'Editorial render requires at least one probed video source',
      )
    }
    const stagingWidth = stagingProbe.width
    const stagingHeight = stagingProbe.height
    const outputPath = join(directory, input.renderKind === 'final' ? 'editorial-final.mp4' : 'editorial-proxy.mp4')
    const [width, height] = dimensions
    // ---- Materialized geometry: validated before a single frame is produced ----
    const reframePlan = input.reframePlan
    const reframeRangeByClipId = new Map<string, Readonly<RenderReframeRangeV1>>()
    if (reframePlan) {
      if (rangeReuse) throw new DomainError('INVALID_RENDER_INPUT', 'A reframe plan cannot be combined with partial range reuse')
      validateRenderReframePlan(reframePlan)
      if (
        reframePlan.format !== input.format ||
        reframePlan.durationFrames !== fullExpectedFrames ||
        Math.abs(reframePlan.fps - outputFps) > 0.01 ||
        reframePlan.ranges.length !== input.clips.length
      ) throw new DomainError('INVALID_RENDER_INPUT', 'Reframe plan does not describe this render input')
      for (const clip of input.clips) {
        const range = reframePlan.ranges.find((candidate) => candidate.clipId === clip.id)
        if (
          !range || range.startFrame !== clip.timelineInFrame || range.endFrame !== clip.timelineOutFrame
        ) throw new DomainError('INVALID_RENDER_INPUT', 'Reframe range does not cover its clip exactly')
        const probe = videoProbeByArtifactId.get(clip.sourceArtifactId)
        if (!probe || probe.width !== reframePlan.source.width || probe.height !== reframePlan.source.height) {
          throw new DomainError('INVALID_RENDER_INPUT', 'Reframe plan source dimensions do not match the rendered source')
        }
        // `n` inside the crop filter counts source frames, so a trajectory is only reproducible
        // frame-for-frame on a real-time clip. A retimed clip with a moving crop fails closed.
        if (range.keyframes.length > 1 && clip.rate !== 1) {
          throw new DomainError('INVALID_RENDER_INPUT', 'A reframe trajectory requires a real-time clip')
        }
        reframeRangeByClipId.set(clip.id, range)
      }
    }
    const placementPlan = input.placementPlan
    const placementAssets = input.placementAssets ?? []
    const assetInputIndexByElementId: Record<string, number> = {}
    const placementInputs: { elementId: string; path: string; sha256: string }[] = []
    if (placementPlan) {
      validateRenderPlacementPlan(placementPlan)
      if (
        placementPlan.format !== input.format ||
        placementPlan.canvas.width !== width || placementPlan.canvas.height !== height ||
        placementPlan.durationFrames !== fullExpectedFrames
      ) throw new DomainError('INVALID_RENDER_INPUT', 'Placement plan does not describe this render canvas')
      const anchorPlan = placementPlan.subtitleAnchorPlan
      if (anchorPlan) {
        // Fail closed: a decision that does not describe *these* cues would silently fall back to
        // the Director anchor for the cues it forgot, which is exactly the silent face-covering
        // this feature exists to prevent.
        if (Math.abs(anchorPlan.fps - outputFps) > 0.01) {
          throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle anchor plan was decided at another frame rate')
        }
        for (const cue of input.subtitleCues ?? []) {
          const decision = subtitleAnchorDecisionFor(anchorPlan, cue.id)
          if (!decision || decision.startFrame !== cue.startFrame || decision.endFrame !== cue.endFrame) {
            throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle anchor plan does not cover every cue of this render')
          }
        }
      }
      const drawable = placementPlan.placements.filter((placement) => placement.assetArtifactId !== null)
      if (drawable.length && rangeReuse) {
        throw new DomainError('INVALID_RENDER_INPUT', 'Drawable placements cannot be combined with partial range reuse')
      }
      for (const placement of drawable) {
        const asset = placementAssets.find((candidate) => candidate.elementId === placement.elementId)
        if (!asset || !isAbsolute(asset.path) || asset.sha256 !== placement.assetSha256) {
          throw new DomainError('INVALID_RENDER_INPUT', 'Placement asset is missing or does not match its planned digest')
        }
        // Last gate before pixels: the bytes on disk, not the promise about them.
        if (await calculateFileSha256(asset.path) !== placement.assetSha256) {
          throw new DomainError('INVALID_RENDER_INPUT', 'Placement asset bytes do not match their planned sha256')
        }
        assetInputIndexByElementId[placement.elementId] = renderSources.length + placementInputs.length
        placementInputs.push({ elementId: placement.elementId, path: asset.path, sha256: asset.sha256 })
      }
    }
    // A single stale range keeps the legacy `editorial-proxy-range.mp4` name so
    // existing partial-render goldens stay byte-for-byte comparable; two or more
    // ranges get one indexed composition file each.
    const suffix = (index: number) => ranges.length === 1 ? '' : `-${String(index).padStart(2, '0')}`
    const compositions = rangeReuse
      ? slices.map((slice, index) => Object.freeze({
        clips: slice.clips,
        subtitleCues: slice.subtitleCues,
        ctaOverlays: slice.ctaOverlays,
        transitions: slice.transitions,
        outputPath: join(directory, `editorial-proxy-range${suffix(index)}.mp4`),
        subtitlePath: join(directory, `captions${suffix(index)}.ass`),
      }))
      : [Object.freeze({
        clips: input.clips,
        subtitleCues: input.subtitleCues,
        ctaOverlays: input.ctaOverlays,
        transitions: input.transitions,
        outputPath,
        subtitlePath: join(directory, 'captions.ass'),
      })]
    await rm(outputPath, { force: true })
    for (const composition of compositions) {
      if (composition.outputPath !== outputPath) await rm(composition.outputPath, { force: true })
    }
    const buildCompositionFilters = async (composition: typeof compositions[number]) => {
      const filters: string[] = []
      composition.clips.forEach((clip, index) => {
        const videoIndex = clipVideoIndex.get(clip.id)!
        const audioIndex = sourceIndex.get(
          clip.audioSourceArtifactId ?? clip.sourceArtifactId,
        )!
        const audioInFrame = clip.audioSourceInFrame ?? clip.sourceInFrame
        const audioOutFrame = clip.audioSourceOutFrame ?? clip.sourceOutFrame
        const audioStart = audioInFrame / input.fps
        const audioEnd = audioOutFrame / input.fps
        const rate = clip.rate
        const timelineSpan = clip.timelineOutFrame - clip.timelineInFrame
        const sourceProbe = videoProbeByArtifactId.get(clip.sourceArtifactId)!
        const reframeRange = reframeRangeByClipId.get(clip.id)
        const cropFilter = reframeRange
          ? buildReframeCropFilter({ range: reframeRange, source: { width: sourceProbe.width, height: sourceProbe.height } })
          : clip.crop
            ? normalizedCropFilter(clip.crop, sourceProbe)
            : ''
        // Real-time clips keep the historical filtergraph verbatim. Retimed clips
        // rescale PTS, then re-sample to the output fps and hard-trim to the exact
        // timeline span so rounding never accumulates across the concat.
        filters.push(
          `[${videoIndex}:v:0]trim=start_frame=${clip.sourceInFrame}:end_frame=${clip.sourceOutFrame},` +
          (rate === 1
            ? `setpts=PTS-STARTPTS,${cropFilter}`
            : `setpts=(PTS-STARTPTS)/${rate.toFixed(6)},${cropFilter}`) +
          `scale=${stagingWidth}:${stagingHeight}:force_original_aspect_ratio=decrease,` +
          `pad=${stagingWidth}:${stagingHeight}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `fps=${outputFps},` +
          (rate === 1 ? '' : `trim=start_frame=0:end_frame=${timelineSpan},setpts=PTS-STARTPTS,`) +
          `setsar=1,format=yuv420p[v${index}]`,
        )
        const duration = (audioEnd - audioStart) / rate
        const before = composition.transitions?.find((transition) => transition.toClipId === clip.id)
        const after = composition.transitions?.find((transition) => transition.fromClipId === clip.id)
        const fadeIn = before ? Math.min(duration / 4, before.audioFadeMs / 1000) : 0
        const fadeOut = after ? Math.min(duration / 4, after.audioFadeMs / 1000) : 0
        const audioFilters = [`atrim=start=${audioStart.toFixed(6)}:end=${audioEnd.toFixed(6)}`, 'asetpts=PTS-STARTPTS']
        if (rate !== 1) {
          for (const factor of atempoFactors(rate)) audioFilters.push(`atempo=${factor.toFixed(6)}`)
          audioFilters.push(`atrim=start=0:end=${duration.toFixed(6)}`, 'asetpts=PTS-STARTPTS')
        }
        if (fadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(6)}`)
        if (fadeOut > 0) audioFilters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`)
        filters.push(`[${audioIndex}:a:0]${audioFilters.join(',')}[a${index}]`)
      })
      const concatInputs = composition.clips.map((_, index) => `[v${index}][a${index}]`).join('')
      filters.push(`${concatInputs}concat=n=${composition.clips.length}:v=1:a=1[joinedv][joineda]`)
      filters.push(
        '[joineda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]',
      )
      filters.push(`[joinedv]split=2[background0][foreground0]`)
      filters.push(`[background0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[background]`)
      const foregroundScale = input.composition?.foregroundScale ?? 1
      const verticalPosition = input.composition?.verticalPosition ?? 0.5
      filters.push(`[foreground0]scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=iw*${foregroundScale.toFixed(4)}:ih*${foregroundScale.toFixed(4)}[foreground]`)
      filters.push(`[background][foreground]overlay=(W-w)/2:max(0\\,min(H-h\\,H*${verticalPosition.toFixed(4)}-h/2)):shortest=1,format=yuv420p[composed]`)
      // Placement overlays land on the composed frame, under the caption layer: a logo or insert
      // never hides a subtitle the Director already positioned.
      const composedLabel = placementPlan && placementInputs.length ? 'placed' : 'composed'
      if (placementPlan && placementInputs.length) {
        filters.push(...buildPlacementOverlayFilters({
          plan: placementPlan,
          assetInputIndexByElementId,
          inputLabel: 'composed',
          outputLabel: 'placed',
        }))
      }
      if (composition.subtitleCues?.length || composition.ctaOverlays?.length) {
        await writeFile(
          composition.subtitlePath,
          buildAssSubtitles({
            width,
            height,
            fps: outputFps,
            cues: composition.subtitleCues ?? [],
            ctaOverlays: composition.ctaOverlays,
            anchorPlan: input.placementPlan?.subtitleAnchorPlan ?? null,
          }),
          'utf8',
        )
        filters.push(`[${composedLabel}]subtitles=filename='${escapeSubtitleFilterPath(composition.subtitlePath)}'[outv]`)
      } else filters.push(`[${composedLabel}]null[outv]`)
      return filters
    }
    try {
      for (const composition of compositions) {
        const filters = await buildCompositionFilters(composition)
        await execFileAsync(this.ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y',
          ...renderSources.flatMap((source) => ['-i', source.path]),
          ...placementInputs.flatMap((asset) => ['-i', asset.path]),
          '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]',
          '-r', String(outputFps), '-c:v', 'libx264', '-preset', input.renderKind === 'final' ? 'medium' : 'veryfast', '-crf', input.renderKind === 'final' ? '18' : '23',
          '-c:a', 'aac', '-b:a', input.renderKind === 'final' ? '192k' : '160k', '-ar', '48000', '-movflags', '+faststart', composition.outputPath,
        ], { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 2 * 1024 * 1024, signal: input.signal })
      }
      if (rangeReuse && ranges.length > 0) {
        const [reuseMetadata, reuseHash, reuseProbe] = await Promise.all([
          stat(rangeReuse.path),
          calculateFileSha256(rangeReuse.path),
          probeVideo(rangeReuse.path, { signal: input.signal }),
        ])
        const rangeProbes = await Promise.all(compositions.map((composition) =>
          probeVideo(composition.outputPath, { signal: input.signal })))
        const reuseFrames = Math.round(reuseProbe.duration * outputFps)
        const lastRange = ranges.at(-1)!
        const suffixRequired = lastRange.endFrame < fullExpectedFrames
        if (
          !reuseMetadata.isFile() || reuseMetadata.size !== rangeReuse.byteSize ||
          reuseHash !== rangeReuse.sha256 || reuseProbe.width !== width ||
          reuseProbe.height !== height || Math.abs(reuseProbe.fps - outputFps) > 0.01 ||
          (suffixRequired
            ? Math.abs(reuseFrames - fullExpectedFrames) > 3
            : reuseFrames + 3 < lastRange.startFrame)
        ) {
          throw new DomainError(
            'INVALID_RENDER_INPUT',
            'Reusable proxy identity is invalid',
          )
        }
        rangeProbes.forEach((rangeProbe, index) => {
          const rangeFrames = ranges[index]!.endFrame - ranges[index]!.startFrame
          if (
            rangeProbe.width !== width || rangeProbe.height !== height ||
            Math.abs(rangeProbe.fps - outputFps) > 0.01 ||
            Math.abs(rangeProbe.duration * outputFps - rangeFrames) > 3
          ) {
            throw new DomainError(
              'INVALID_RENDER_INPUT',
              `Rendered proxy range ${index} identity is invalid`,
            )
          }
        })
        // Interleave reused base segments with freshly rendered ranges:
        // base[0,r0) r0 base[r0,r1) r1 ... base[rN,end). Empty base segments are
        // omitted, so a range starting at frame 0 simply has no leading piece.
        const stitchFilters: string[] = []
        const pieces: string[] = []
        let cursor = 0
        ranges.forEach((range, index) => {
          if (range.startFrame > cursor) {
            stitchFilters.push(
              `[0:v:0]trim=start_frame=${cursor}:end_frame=${range.startFrame},setpts=PTS-STARTPTS[keptv${index}]`,
              `[0:a:0]atrim=start=${(cursor / outputFps).toFixed(6)}:end=${(range.startFrame / outputFps).toFixed(6)},asetpts=PTS-STARTPTS[kepta${index}]`,
            )
            pieces.push(`[keptv${index}][kepta${index}]`)
          }
          stitchFilters.push(
            `[${index + 1}:v:0]setpts=PTS-STARTPTS[rangev${index}]`,
            `[${index + 1}:a:0]asetpts=PTS-STARTPTS[rangea${index}]`,
          )
          pieces.push(`[rangev${index}][rangea${index}]`)
          cursor = range.endFrame
        })
        if (suffixRequired) {
          stitchFilters.push(
            `[0:v:0]trim=start_frame=${cursor}:end_frame=${fullExpectedFrames},setpts=PTS-STARTPTS[suffixv]`,
            `[0:a:0]atrim=start=${(cursor / outputFps).toFixed(6)}:end=${(fullExpectedFrames / outputFps).toFixed(6)},asetpts=PTS-STARTPTS[suffixa]`,
          )
          pieces.push('[suffixv][suffixa]')
        }
        stitchFilters.push(
          `${pieces.join('')}concat=n=${pieces.length}:v=1:a=1[stitchedv][stitcheda]`,
        )
        await execFileAsync(this.ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', rangeReuse.path,
          ...compositions.flatMap((composition) => ['-i', composition.outputPath]),
          '-filter_complex', stitchFilters.join(';'),
          '-map', '[stitchedv]', '-map', '[stitcheda]',
          '-r', String(outputFps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart',
          outputPath,
        ], { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 2 * 1024 * 1024, signal: input.signal })
      }
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        stderr?: string | Buffer
        killed?: boolean
        signal?: NodeJS.Signals
      }
      const stderr = typeof processError.stderr === 'string'
        ? processError.stderr
        : Buffer.isBuffer(processError.stderr)
          ? processError.stderr.toString('utf8')
          : ''
      const diagnostic = stderr
        .replaceAll(this.workRoot, '<render-work-root>')
        .slice(-8_000)
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        processError.code === 'ABORT_ERR'
          ? 'Editorial proxy render was cancelled'
          : 'Editorial proxy render failed',
        {
          processCode: String(processError.code ?? 'unknown'),
          killed: processError.killed === true,
          signal: processError.signal ?? null,
          ...(diagnostic ? { stderr: diagnostic } : {}),
        },
      )
    }
    const [metadata, sha256, probe] = await Promise.all([
      stat(outputPath),
      calculateFileSha256(outputPath),
      probeVideo(outputPath, { signal: input.signal }),
    ])
    if (!metadata.isFile() || metadata.size <= 0 || Math.abs(probe.duration * input.fps - fullExpectedFrames) > 3 || probe.width !== width || probe.height !== height) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Editorial proxy failed timing or dimension verification')
    }
    const renderElementMap = buildRenderElementMap({
      proxyHash: sha256,
      fps: outputFps,
      durationFrames: fullExpectedFrames,
      canvas: { width, height },
      source: { width: stagingProbe.width, height: stagingProbe.height },
      sourceDimensions: Object.fromEntries(videoProbes.map(({ artifactId, probe: sourceProbe }) => [
        artifactId,
        { width: sourceProbe.width, height: sourceProbe.height },
      ])),
      clips: input.clips,
      subtitleCues: input.subtitleCues,
      ctaOverlays: input.ctaOverlays,
      composition: input.composition,
      // Same decision the ASS above drew with, so the map is a description of the pixels rather
      // than a second opinion about them.
      subtitleAnchorPlan: input.placementPlan?.subtitleAnchorPlan ?? null,
    })
    return Object.freeze({ outputPath, sha256, byteSize: metadata.size, probe, renderElementMap })
  }

  async cleanup(operationId: string): Promise<void> {
    await rm(this.directory(operationId), { recursive: true, force: true })
  }
}

export function createFfmpegEditorialProxyRendererFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!root) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  return new FfmpegEditorialProxyRenderer({ workRoot: join(resolve(root), '.work'), ...(environment.FFMPEG_PATH?.trim() ? { ffmpegPath: environment.FFMPEG_PATH.trim() } : {}) })
}
