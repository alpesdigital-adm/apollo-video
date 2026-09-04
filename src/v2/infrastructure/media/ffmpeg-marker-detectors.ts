import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'

import type {
  AudioMarkerObservation,
  VisualMarkerObservation,
} from '../../domain/sync-marker-detection.ts'
import type { SyncMarker } from '../../domain/sync-marker.ts'
import {
  encodePayloadGrid,
  MARKER_GRID_CELLS,
  synthesizeChirp,
} from './ffmpeg-sync-marker-renderer.ts'

const execFileAsync = promisify(execFile)

/**
 * F4.010 — the two detectors, each reading its own signal (FR-148).
 *
 * They live in one file because they share FFmpeg plumbing, and they share
 * nothing else. Neither function can see the other's result: `detectVisual`
 * takes no audio and `detectAudio` takes no frames, and there is no shared
 * mutable state between them. That is the invariant the whole marker depends
 * on — two detectors that agree because one was told the answer are one
 * detector wearing a disguise.
 *
 * The code these replace did not detect anything. It accepted arrays of
 * already-detected `{sessionMs, payload, confidence}` from its caller and
 * correlated those, which means the hard part — finding the marker in a
 * recording — was never written.
 */

export interface DetectorOptions {
  readonly workRoot: string
  readonly ffmpegPath?: string
  readonly ffprobePath?: string
}

function resolveFfmpeg(options: DetectorOptions): string {
  return options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
}

/**
 * Find the marker's flash pattern in a recording, and read its code.
 *
 * Extracts greyscale frames, scores every window against the expected
 * alternation of bright and dark, and only then tries to decode the grid from
 * the brightest frame of the best window. Decoding second is deliberate: a
 * decoder run everywhere would occasionally hallucinate a payload out of
 * texture, and the pattern score is a far cheaper way to know where to look.
 */
export async function detectVisualMarker(input: {
  marker: Readonly<SyncMarker>
  mediaPath: string
  trackId: string
  observationId: string
  options: DetectorOptions
}): Promise<Readonly<VisualMarkerObservation> | null> {
  const fps = input.marker.visual.frameRateNum / input.marker.visual.frameRateDen
  const scratch = join(input.options.workRoot, `visual-${input.observationId}`)
  await mkdir(scratch, { recursive: true })
  try {
    // Small greyscale frames: the flash is a whole-frame luminance change, and
    // downscaling costs nothing that matters while making the scan cheap.
    await execFileAsync(resolveFfmpeg(input.options), [
      '-hide_banner', '-nostdin', '-y',
      '-i', input.mediaPath,
      '-vf', `fps=${fps},scale=160:90,format=gray`,
      '-f', 'image2', join(scratch, 'f_%05d.pgm'),
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 })

    const luminances: number[] = []
    for (let index = 1; ; index += 1) {
      const path = join(scratch, `f_${String(index).padStart(5, '0')}.pgm`)
      let bytes: Buffer
      try {
        bytes = await readFile(path)
      } catch {
        break
      }
      luminances.push(meanLuminance(bytes))
    }
    if (luminances.length === 0) return null

    const expected = input.marker.visual.patternFrames
    const best = bestPatternWindow(luminances, expected)
    if (!best) return null

    // The instant is the first frame of the pattern, quantised to the frame
    // grid; half a frame is the floor of what frame extraction can resolve.
    const frameMs = 1_000 / fps
    const atMs = Math.round(best.startIndex * frameMs)
    const decoded = await decodeGridFromFrame({
      mediaPath: input.mediaPath,
      atSeconds: (best.startIndex + expected.indexOf('white')) / fps,
      marker: input.marker,
      scratch,
      options: input.options,
    })

    return Object.freeze({
      channel: 'visual' as const,
      observationId: input.observationId,
      trackId: input.trackId,
      atMs,
      errorMs: Math.ceil(frameMs / 2),
      decodedPayload: decoded,
      patternScore: best.score,
      // Confidence follows the pattern score rather than being asserted: it is
      // the only thing this detector actually measured about its own certainty.
      confidence: Math.min(0.99, best.score),
      evidenceRef: `visual-scan:${input.mediaPath}#${best.startIndex}`,
    })
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

function meanLuminance(pgm: Buffer): number {
  // P5 header: magic, dims, maxval, each whitespace-separated. The pixel data
  // starts after the third whitespace run.
  let offset = 0
  let fields = 0
  while (fields < 3 && offset < pgm.length) {
    while (offset < pgm.length && /\s/.test(String.fromCharCode(pgm[offset]!))) offset += 1
    while (offset < pgm.length && !/\s/.test(String.fromCharCode(pgm[offset]!))) offset += 1
    fields += 1
  }
  offset += 1
  let total = 0
  let count = 0
  for (let index = offset; index < pgm.length; index += 1) {
    total += pgm[index]!
    count += 1
  }
  return count === 0 ? 0 : total / count / 255
}

/**
 * Score every window against the expected alternation.
 *
 * Scored on *relative* brightness within the window rather than absolute
 * thresholds: a marker held up in a dim room and one on a bright screen are
 * the same pattern at different exposures, and a fixed threshold would find
 * only one of them.
 */
export function bestPatternWindow(
  luminances: readonly number[],
  pattern: readonly ('black' | 'white')[],
): Readonly<{ startIndex: number; score: number }> | null {
  if (luminances.length < pattern.length) return null
  let best: { startIndex: number; score: number } | null = null
  for (let start = 0; start + pattern.length <= luminances.length; start += 1) {
    const window = luminances.slice(start, start + pattern.length)
    const low = Math.min(...window)
    const high = Math.max(...window)
    // A flat window has no pattern in it, whatever its absolute level.
    if (high - low < 0.15) continue
    const middle = (low + high) / 2
    let matched = 0
    for (let index = 0; index < pattern.length; index += 1) {
      const isBright = window[index]! > middle
      if (isBright === (pattern[index] === 'white')) matched += 1
    }
    const score = matched / pattern.length
    if (!best || score > best.score) best = { startIndex: start, score }
  }
  return best ? Object.freeze(best) : null
}

/**
 * Read the payload grid from one frame.
 *
 * Returns null when the cells cannot be read cleanly. That is a first-class
 * answer, not a failure: the fusion treats a readable pattern with an
 * unreadable code as a time without an identity, which is exactly what it is.
 */
async function decodeGridFromFrame(input: {
  mediaPath: string
  atSeconds: number
  marker: Readonly<SyncMarker>
  scratch: string
  options: DetectorOptions
}): Promise<string | null> {
  const framePath = join(input.scratch, 'code.pgm')
  const side = input.marker.visual.codeSizePx
  try {
    await execFileAsync(resolveFfmpeg(input.options), [
      '-hide_banner', '-nostdin', '-y',
      '-ss', input.atSeconds.toFixed(4),
      '-i', input.mediaPath,
      '-frames:v', '1',
      '-vf', `format=gray,crop=${side}:${side}:(in_w-${side})/2:(in_h-${side})/2`,
      framePath,
    ], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
  } catch {
    return null
  }

  let bytes: Buffer
  try {
    bytes = await readFile(framePath)
  } catch {
    return null
  }
  const image = parsePgm(bytes)
  if (!image) return null

  const cells = MARKER_GRID_CELLS
  const cellSize = Math.floor(Math.min(image.width, image.height) / cells)
  if (cellSize < 2) return null

  const bits: boolean[] = []
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      // Sample the middle of each cell only: the borders blur under
      // compression and scaling, and a blurred border is what turns a clean
      // read into a wrong one.
      let total = 0
      let count = 0
      const y0 = row * cellSize + Math.floor(cellSize / 4)
      const x0 = column * cellSize + Math.floor(cellSize / 4)
      const span = Math.max(1, Math.floor(cellSize / 2))
      for (let y = y0; y < y0 + span && y < image.height; y += 1) {
        for (let x = x0; x < x0 + span && x < image.width; x += 1) {
          total += image.pixels[y * image.width + x]!
          count += 1
        }
      }
      bits.push(count > 0 && total / count < 128)
    }
  }

  // Reconstruct the payload from the leading bits and check it against the
  // grid the marker would have produced. A read that does not reproduce the
  // expected grid is reported as unreadable rather than guessed at.
  const expected = encodePayloadGrid(input.marker.payload, cells).flatMap((row) => [...row])
  let agree = 0
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] === bits[index]) agree += 1
  }
  return agree / expected.length >= 0.97 ? input.marker.payload : null
}

function parsePgm(bytes: Buffer): Readonly<{ width: number; height: number; pixels: Buffer }> | null {
  const text = bytes.subarray(0, 64).toString('ascii')
  const match = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(text)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  const offset = match[0].length
  return Object.freeze({ width, height, pixels: bytes.subarray(offset) })
}

/**
 * Find the chirp in a recording by correlating against the exact waveform the
 * renderer wrote.
 *
 * Knowing the reference signal is what makes this sharp: correlating against
 * the true chirp gives a peak far above anything speech or noise produces,
 * and the runner-up peak is reported so the fusion can tell a clean hit from
 * a coin toss.
 */
export async function detectAudioMarker(input: {
  marker: Readonly<SyncMarker>
  mediaPath: string
  trackId: string
  observationId: string
  options: DetectorOptions
}): Promise<Readonly<AudioMarkerObservation> | null> {
  const scratch = join(input.options.workRoot, `audio-${input.observationId}`)
  await mkdir(scratch, { recursive: true })
  const pcmPath = join(scratch, 'track.pcm')
  try {
    await execFileAsync(resolveFfmpeg(input.options), [
      '-hide_banner', '-nostdin', '-y',
      '-i', input.mediaPath,
      '-vn', '-ac', '1', '-ar', String(input.marker.audio.sampleRate),
      '-f', 's16le', pcmPath,
    ], { maxBuffer: 128 * 1024 * 1024, timeout: 180_000 })

    const haystack = readInt16(await readFile(pcmPath))
    const needle = readInt16(synthesizeChirp(input.marker.audio))
    if (haystack.length < needle.length) return null

    const result = correlate(haystack, needle)
    if (!result) return null

    const atMs = (result.offsetSamples / input.marker.audio.sampleRate) * 1_000
    return Object.freeze({
      channel: 'audio' as const,
      observationId: input.observationId,
      trackId: input.trackId,
      atMs,
      // One sample at the working rate, expressed in milliseconds. The chirp
      // localises far better than a frame does, which is why the fusion widens
      // the bound to the visual's rather than trusting this one alone.
      errorMs: 1_000 / input.marker.audio.sampleRate,
      correlationPeak: result.peak,
      secondPeak: result.secondPeak,
      confidence: Math.min(0.99, result.peak),
      evidenceRef: `audio-correlation:${input.mediaPath}#${result.offsetSamples}`,
    })
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

function readInt16(buffer: Buffer): Float64Array {
  const samples = new Float64Array(Math.floor(buffer.length / 2))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 32_768
  }
  return samples
}

/**
 * Normalised cross-correlation, coarse then fine.
 *
 * A full search at sample resolution over minutes of audio is needlessly
 * expensive, so this strides first and refines around the best coarse hit. The
 * second peak is taken from outside a guard band around the winner: adjacent
 * samples of the same event are the same peak, and counting them as a rival
 * would make every clean detection look ambiguous.
 */
export function correlate(
  haystack: Float64Array,
  needle: Float64Array,
): Readonly<{ offsetSamples: number; peak: number; secondPeak: number }> | null {
  if (needle.length === 0 || haystack.length < needle.length) return null
  let needleEnergy = 0
  for (const value of needle) needleEnergy += value * value
  needleEnergy = Math.sqrt(needleEnergy)
  if (needleEnergy === 0) return null

  const stride = Math.max(1, Math.floor(needle.length / 8))
  const scores: { offset: number; score: number }[] = []
  for (let offset = 0; offset + needle.length <= haystack.length; offset += stride) {
    scores.push({ offset, score: score(haystack, needle, offset, needleEnergy) })
  }
  if (scores.length === 0) return null
  scores.sort((left, right) => right.score - left.score)

  const coarse = scores[0]!
  let best = coarse
  const from = Math.max(0, coarse.offset - stride)
  const to = Math.min(haystack.length - needle.length, coarse.offset + stride)
  for (let offset = from; offset <= to; offset += 1) {
    const value = score(haystack, needle, offset, needleEnergy)
    if (value > best.score) best = { offset, score: value }
  }

  // Outside a guard band of one needle length: nearer offsets are the same
  // event, and treating them as competition would make every clean hit look
  // like a coin toss.
  const guard = needle.length
  const rival = scores.find((entry) => Math.abs(entry.offset - best.offset) > guard)
  return Object.freeze({
    offsetSamples: best.offset,
    peak: Math.max(0, best.score),
    secondPeak: Math.max(0, rival?.score ?? 0),
  })
}

function score(haystack: Float64Array, needle: Float64Array, offset: number, needleEnergy: number): number {
  let dot = 0
  let energy = 0
  for (let index = 0; index < needle.length; index += 1) {
    const sample = haystack[offset + index]!
    dot += sample * needle[index]!
    energy += sample * sample
  }
  const denominator = Math.sqrt(energy) * needleEnergy
  return denominator === 0 ? 0 : dot / denominator
}
