import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { CaptionPixelCritic, CaptionPixelVerification, PixelFaceVetoDetector } from '../../application/ports/caption-pixel-critic.ts'
import { captionSampleFrames, evaluateCaptionPixels, type CaptionFootprintSample } from '../../domain/caption-pixel-verdict.ts'
import { DomainError } from '../../domain/errors.ts'
import type { RenderPlacementPlan } from '../../domain/render-placement-plan.ts'
import { resolveFfmpegBinary } from './ffmpeg-binary.ts'

const execFileAsync = promisify(execFile)

/**
 * Pixel critic of the burned captions (W65). It decodes the sampled frames of the delivered MP4 and of the same render without
 * the burned cues, and the pixels that differ are the captions: their bounding box is compared with the band the plan decided,
 * with the drawn placements, and (when a veto detector is wired) with the faces it finds on the caption-free frame. Nothing here
 * reads the renderer's element map or the detector that produced the clearance.
 *
 * A pixel counts as changed when its luma differs by more than `LUMA_THRESHOLD` AND at least two of its four neighbours do too:
 * the two files are separate encodes, and an isolated difference is codec noise, not a glyph. A frame with fewer than
 * `MIN_CHANGED_PIXELS` surviving pixels has no caption.
 */
export const LUMA_THRESHOLD = 60
export const MIN_CHANGED_PIXELS = 40
const MAX_FRAME_BYTES = 256 * 1024 * 1024

function luma(rgb: Uint8Array, offset: number): number {
  return (299 * rgb[offset]! + 587 * rgb[offset + 1]! + 114 * rgb[offset + 2]!) / 1000
}

/** Pure: the footprint of the pixels that differ between a delivered frame and its caption-free control. */
export function captionFootprintOf(
  delivered: Uint8Array, control: Uint8Array, width: number, height: number,
): Readonly<{ footprint: CaptionFootprintSample['footprint']; changedPixels: number }> {
  const changed = new Uint8Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    if (Math.abs(luma(delivered, index * 3) - luma(control, index * 3)) > LUMA_THRESHOLD) changed[index] = 1
  }
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (!changed[index]) continue
      const neighbours = (x > 0 ? changed[index - 1]! : 0) + (x < width - 1 ? changed[index + 1]! : 0) +
        (y > 0 ? changed[index - width]! : 0) + (y < height - 1 ? changed[index + width]! : 0)
      if (neighbours < 2) continue
      count += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (count < MIN_CHANGED_PIXELS) return Object.freeze({ footprint: null, changedPixels: count })
  return Object.freeze({
    footprint: Object.freeze({ x: minX / width, y: minY / height, width: (maxX - minX + 1) / width, height: (maxY - minY + 1) / height }),
    changedPixels: count,
  })
}

export class FfmpegCaptionPixelCritic implements CaptionPixelCritic {
  private readonly ffmpegPath: string
  private readonly faceVeto: PixelFaceVetoDetector | undefined

  constructor(options: Readonly<{ ffmpegPath?: string; faceVeto?: PixelFaceVetoDetector }> = {}) {
    this.ffmpegPath = resolveFfmpegBinary(options.ffmpegPath)
    this.faceVeto = options.faceVeto
  }

  private async decode(path: string, frames: readonly number[], width: number, height: number, signal?: AbortSignal): Promise<readonly Uint8Array[]> {
    const select = frames.map((frame) => `eq(n,${frame})`).join('+')
    const frameBytes = width * height * 3
    const { stdout } = await execFileAsync(this.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select='${select}'`, '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: Math.min(MAX_FRAME_BYTES, frameBytes * frames.length + 1024), windowsHide: true, ...(signal ? { signal } : {}) })
    if (stdout.byteLength !== frameBytes * frames.length) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'The caption pixel critic could not decode every sampled frame')
    }
    return frames.map((_frame, index) => new Uint8Array(stdout.buffer, stdout.byteOffset + index * frameBytes, frameBytes))
  }

  async verify(request: Readonly<{
    plan: Readonly<RenderPlacementPlan>
    deliveredPath: string
    renderControl: () => Promise<Readonly<{ path: string }>>
    signal?: AbortSignal
  }>): Promise<Readonly<CaptionPixelVerification>> {
    const { plan } = request
    const frames = captionSampleFrames(plan)
    const faceVeto: 'ran' | 'unavailable' = this.faceVeto ? 'ran' : 'unavailable'
    try {
      const control = await request.renderControl()
      const { width, height } = plan.canvas
      const [delivered, controlFrames] = await Promise.all([
        this.decode(request.deliveredPath, frames, width, height, request.signal),
        this.decode(control.path, frames, width, height, request.signal),
      ])
      const placedFrames = new Set(plan.subtitleAnchorPlan!.decisions
        .filter((decision) => decision.anchor !== null)
        .flatMap((decision) => frames.filter((frame) => frame >= decision.startFrame && frame < decision.endFrame)))
      const samples: CaptionFootprintSample[] = []
      for (const [index, frame] of frames.entries()) {
        const measured = captionFootprintOf(delivered[index]!, controlFrames[index]!, width, height)
        const faceBoxes = this.faceVeto && placedFrames.has(frame)
          ? await this.faceVeto.detect({ width, height, rgb: controlFrames[index]! }) : undefined
        samples.push(Object.freeze({ frame, footprint: measured.footprint, changedPixels: measured.changedPixels, ...(faceBoxes ? { faceBoxes } : {}) }))
      }
      return Object.freeze({ issues: evaluateCaptionPixels({ plan, samples, faceVeto }), samples: Object.freeze(samples) })
    } catch (error) {
      if (request.signal?.aborted) throw error
      // A critic that was wired and could not measure leaves the proxy waiting for a person; it does not fail the render.
      return Object.freeze({ issues: evaluateCaptionPixels({ plan, samples: [], faceVeto, measurementFailed: true }), samples: Object.freeze([]) })
    }
  }
}
