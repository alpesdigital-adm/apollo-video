import type { PreparedEditorialComposition, EditorialCompositionPrefix } from '../../application/ports/subtitle-clock-collector.ts'
import type { EditorialProxyRenderer } from '../../application/ports/editorial-proxy-renderer.ts'
import type { RenderPlacementPlan } from '../../domain/render-placement-plan.ts'
import type { RenderReframeRangeV1 } from '../../domain/render-reframe-plan.ts'
import { DomainError } from '../../domain/errors.ts'

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
  plan: Readonly<RenderPlacementPlan>
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

/** Pure extraction of the product's pre-libass closure. Renderer preparation
 * retains its existing validation and supplies its actual prepared context. */
export function buildEditorialCompositionPrefix(input: Readonly<PreparedEditorialComposition>): Readonly<EditorialCompositionPrefix> {
  const { renderSources, width, height, stagingWidth, stagingHeight, outputFps, backgroundMusic, placementPlan, placementInputs, assetInputIndexByElementId } = input
  const composition = { clips: input.clips, transitions: input.transitions }
  const clipVideoIndex = new Map(Object.entries(input.clipVideoIndex)), sourceIndex = new Map(Object.entries(input.sourceIndex))
  const videoProbeByArtifactId = new Map(Object.entries(input.videoProbeByArtifactId)), reframeRangeByClipId = new Map(Object.entries(input.reframeRangeByClipId))
  const videoInputs = composition.clips.map((clip) => {
    const source = renderSources[clipVideoIndex.get(clip.id)!]!
    return Object.freeze({ path: source.path, ss: Math.max(0, (clip.sourceInFrame - 0.5) / input.fps).toFixed(6),
      t: ((clip.sourceOutFrame - clip.sourceInFrame + 1) / input.fps).toFixed(6) })
  })
  const filters: string[] = []
  // W66r. A clip whose reframe range is active is laid on the canvas by itself, in one step: its crop window is scaled by the cover factor and
  // centred, so the subject-following crop FILLS the canvas (no staging band, no blurred backdrop). When any clip is reframed every other clip is
  // composed the way it always was (staging frame, then a foreground over a blurred copy) but one clip at a time, so the join is of canvas-sized
  // frames. A render with no reframed clip keeps the historical graph verbatim.
  const composeEachClip = reframeRangeByClipId.size > 0
  const foregroundScale = input.compositionLayout?.foregroundScale ?? 1
  const verticalPosition = input.compositionLayout?.verticalPosition ?? 0.5
  const composeOnCanvas = (from: string, to: string, tag: string): readonly string[] => [
    `[${from}]split=2[background0${tag}][foreground0${tag}]`,
    `[background0${tag}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[background${tag}]`,
    `[foreground0${tag}]scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=iw*${foregroundScale.toFixed(4)}:ih*${foregroundScale.toFixed(4)}[foreground${tag}]`,
    `[background${tag}][foreground${tag}]overlay=(W-w)/2:max(0\\,min(H-h\\,H*${verticalPosition.toFixed(4)}-h/2)):shortest=1,format=yuv420p[${to}]`,
  ]
  composition.clips.forEach((clip, index) => {
    const videoIndex = renderSources.length + index
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
    const head =
      `[${videoIndex}:v:0]trim=start_frame=0:end_frame=${clip.sourceOutFrame - clip.sourceInFrame},` +
      (rate === 1
        ? `setpts=PTS-STARTPTS,${cropFilter}`
        : `setpts=(PTS-STARTPTS)/${rate.toFixed(6)},${cropFilter}`)
    const tail =
      `fps=${outputFps},` +
      (rate === 1 ? '' : `trim=start_frame=0:end_frame=${timelineSpan},setpts=PTS-STARTPTS,`) +
      `setsar=1,format=yuv420p`
    const staged =
      `scale=${stagingWidth}:${stagingHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${stagingWidth}:${stagingHeight}:(ow-iw)/2:(oh-ih)/2:color=black,`
    if (reframeRange) {
      filters.push(`${head}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${tail}[v${index}]`)
    } else if (composeEachClip) {
      filters.push(`${head}${staged}${tail}[staged${index}]`, ...composeOnCanvas(`staged${index}`, `v${index}`, String(index)))
    } else {
      filters.push(`${head}${staged}${tail}[v${index}]`)
    }
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
  if (backgroundMusic) {
    const musicIndex = sourceIndex.get(backgroundMusic.artifactId)!
    const musicStart = backgroundMusic.sourceInFrame / input.fps
    const musicEnd = backgroundMusic.sourceOutFrame / input.fps
    const fadeIn = backgroundMusic.fadeInFrames / input.fps
    const fadeOut = backgroundMusic.fadeOutFrames / input.fps
    const duration = backgroundMusic.timelineOutFrame / input.fps
    const musicFilters = [`atrim=start=${musicStart.toFixed(6)}:end=${musicEnd.toFixed(6)}`, 'asetpts=PTS-STARTPTS', `atrim=start=0:end=${duration.toFixed(6)}`, `volume=${backgroundMusic.gainDb.toFixed(2)}dB`]
    if (fadeIn > 0) musicFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(6)}`)
    if (fadeOut > 0) musicFilters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`)
    filters.push(`[${musicIndex}:a:0]${musicFilters.join(',')}[musicbed]`)
    filters.push('[joineda][musicbed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixeda]')
    filters.push('[mixeda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]')
  } else filters.push('[joineda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]')
  if (composeEachClip) {
    // every clip is already a canvas-sized frame
    filters.push('[joinedv]null[composed]')
  } else {
    filters.push(`[joinedv]split=2[background0][foreground0]`)
    filters.push(`[background0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[background]`)
    filters.push(`[foreground0]scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=iw*${foregroundScale.toFixed(4)}:ih*${foregroundScale.toFixed(4)}[foreground]`)
    filters.push(`[background][foreground]overlay=(W-w)/2:max(0\\,min(H-h\\,H*${verticalPosition.toFixed(4)}-h/2)):shortest=1,format=yuv420p[composed]`)
  }
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

  return Object.freeze({ filters: Object.freeze(filters), videoInputs: Object.freeze(videoInputs),
    inputArgs: Object.freeze([...renderSources.flatMap((source) => ['-i', source.path]),
      ...videoInputs.flatMap((clipInput) => ['-ss', clipInput.ss, '-t', clipInput.t, '-i', clipInput.path]),
      ...placementInputs.flatMap((asset) => ['-i', asset.path])]), videoLabel: composedLabel, audioLabel: 'outa' })
}

/**
 * Last stage before libass (`ass-frame-clock/v3`, clock `settb-setpts-consecutive-pts/v1`).
 * `settb=1/<rate>,setpts=N` publishes the inverse of the rate as the time base and numbers the
 * frames 0, 1, 2, ... without touching their count, so the clock `vf_subtitles` converts into
 * milliseconds is a closed form of the frame index and the rate. Whatever time base the composition
 * ends in (concat publishes 1/1000000, lavfi 1/rate, the overlay inherits) does not reach libass,
 * and the binary64 skew of that time base cannot move a boundary.
 *
 * Why not `fps=<rate>` (ass-frame-clock/v2): it published the same (pts = index, time base 1/rate)
 * but, on FFmpeg 6.1.1 (the ffmpeg-static build), dropped the final frame after
 * `overlay=shortest=1` at every rate from 24 to 120 fps (T-FR-227: 899 of 900 frames); FFmpeg 8.1.1
 * kept it, which is why the v2 pixel proof passed. `eof_action=pass` did not repair it (still short
 * on 6.1.1, one frame too many on 8.1.1 at 24 and 60 fps). Used by the renderer and by the clock
 * collector so both observe the same stream. Evidence: docs/quality/w69-materialized-subtitle-clock-v2.md.
 */
export function buildPreLibassClockStage(input: { inputLabel: string; outputFps: number }) {
  if (!Number.isSafeInteger(input.outputFps) || input.outputFps <= 0 || !/^[A-Za-z0-9_]+$/.test(input.inputLabel)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'The pre-libass clock stage requires an integer rate and a plain label')
  }
  return Object.freeze({ filters: Object.freeze([`[${input.inputLabel}]settb=1/${input.outputFps},setpts=N[clocked]`]), outputLabel: 'clocked' as const })
}
