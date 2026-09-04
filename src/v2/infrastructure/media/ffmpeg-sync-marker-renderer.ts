import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createRequire } from 'node:module'

import ffmpegStatic from 'ffmpeg-static'

const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static') as { path?: string }

import { DomainError } from '../../domain/errors.ts'
import { visualPatternDurationMs, type SyncMarker } from '../../domain/sync-marker.ts'

const execFileAsync = promisify(execFile)

/**
 * F4.010 — turning a marker into media somebody can actually play (FR-148).
 *
 * The marker aggregate describes an event; this renders the artifact an
 * operator holds up to a camera or plays through a room. It has to be real
 * media, because the detectors that look for it later look at frames and
 * samples — and a specification that has never been rendered has never been
 * shown to be detectable.
 *
 * **Every pixel and every sample is generated here, in Node.** A first draft
 * built the flash with FFmpeg's `geq` and the chirp with `sine`, which failed
 * for two different reasons worth keeping: the filter expression needs comma
 * escaping that fights with `filter_complex`'s own comma parsing, and `sine`
 * emits a constant tone rather than the sweep the marker specifies. Composing
 * the frames and the PCM directly removes both problems and buys something
 * better — the detector can be tested against exactly the waveform that was
 * written, rather than against whatever a filter expression happened to mean.
 *
 * FFmpeg is left with the one job it is uniquely good at: muxing.
 */

export interface RenderedMarkerArtifact {
  readonly markerId: string
  readonly filePath: string
  readonly byteSize: number
  readonly sha256: string
  readonly durationMs: number
  readonly width: number
  readonly height: number
  readonly frameRate: string
  readonly videoCodec: string
  readonly audioCodec: string
  readonly sampleRate: number
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  sample_rate?: string
}

export const MARKER_FRAME_WIDTH = 640
export const MARKER_FRAME_HEIGHT = 360
/** Cells per side of the visual code. */
export const MARKER_GRID_CELLS = 24

/**
 * A square of black and white cells encoding the payload.
 *
 * Deliberately not a QR library. A real QR is better at long range and worse
 * in the way that matters here: an external decoder is a dependency whose
 * failures are opaque. This grid is decoded by the same code that writes it,
 * so a partial read reports which cells were unreadable instead of returning
 * nothing at all.
 */
export function encodePayloadGrid(payload: string, cells: number): readonly (readonly boolean[])[] {
  const bytes = Buffer.from(payload, 'utf8')
  const digest = createHash('sha256').update(bytes).digest()
  const bits: boolean[] = []
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit -= 1) bits.push(((byte >> bit) & 1) === 1)
  }
  // Padding derived from a digest of the payload: deterministic, and a decoder
  // reading past the payload finds a checkable pattern rather than dead fill.
  let padIndex = 0
  while (bits.length < cells * cells) {
    const byte = digest[padIndex % digest.length]!
    for (let bit = 7; bit >= 0 && bits.length < cells * cells; bit -= 1) {
      bits.push(((byte >> bit) & 1) === 1)
    }
    padIndex += 1
  }
  const grid: boolean[][] = []
  for (let row = 0; row < cells; row += 1) grid.push(bits.slice(row * cells, (row + 1) * cells))
  return Object.freeze(grid.map((row) => Object.freeze(row)))
}

/**
 * One frame of the marker, as 8-bit greyscale.
 *
 * The background carries the flash and the centred grid carries the payload.
 * The grid keeps its own contrast on both background colours — on a white
 * frame the dark cells read, on a black frame the light ones do — so the code
 * survives whichever frame a detector happens to sample.
 */
export function composeMarkerFrame(input: {
  background: 'black' | 'white'
  grid: readonly (readonly boolean[])[]
  codeSizePx: number
  width: number
  height: number
}): Buffer {
  const pixels = Buffer.alloc(input.width * input.height, input.background === 'white' ? 235 : 16)
  const cells = input.grid.length
  const scale = Math.max(1, Math.floor(input.codeSizePx / cells))
  const side = scale * cells
  const originX = Math.floor((input.width - side) / 2)
  const originY = Math.floor((input.height - side) / 2)
  for (let y = 0; y < side; y += 1) {
    const row = input.grid[Math.floor(y / scale)]!
    const target = (originY + y) * input.width
    for (let x = 0; x < side; x += 1) {
      pixels[target + originX + x] = row[Math.floor(x / scale)] ? 0 : 255
    }
  }
  return pixels
}

/**
 * A linear frequency sweep as signed 16-bit PCM.
 *
 * The phase is integrated over the sweep rather than evaluated pointwise:
 * `sin(2π·f(t)·t)` looks right and is wrong, because it makes the instantaneous
 * frequency `f(t) + t·f'(t)` — roughly double the intended sweep rate. The
 * correct instantaneous phase for a linear chirp is `2π(f0·t + k·t²/2)`.
 *
 * A short raised-cosine fade at each end keeps the discontinuity at the edges
 * from ringing across the whole spectrum, which would smear the correlation
 * peak the detector depends on.
 */
export function synthesizeChirp(input: {
  startHz: number
  endHz: number
  durationMs: number
  sampleRate: number
}): Buffer {
  const samples = Math.round((input.durationMs / 1_000) * input.sampleRate)
  const buffer = Buffer.alloc(samples * 2)
  const duration = input.durationMs / 1_000
  const sweepRate = (input.endHz - input.startHz) / duration
  const fadeSamples = Math.min(Math.floor(samples / 8), Math.floor(input.sampleRate * 0.005))
  for (let index = 0; index < samples; index += 1) {
    const t = index / input.sampleRate
    const phase = 2 * Math.PI * (input.startHz * t + (sweepRate * t * t) / 2)
    let amplitude = 0.7
    if (index < fadeSamples) {
      amplitude *= 0.5 * (1 - Math.cos((Math.PI * index) / fadeSamples))
    } else if (index >= samples - fadeSamples) {
      amplitude *= 0.5 * (1 - Math.cos((Math.PI * (samples - 1 - index)) / fadeSamples))
    }
    const value = Math.round(Math.sin(phase) * amplitude * 32_767)
    buffer.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), index * 2)
  }
  return buffer
}

/**
 * Where ffprobe is.
 *
 * ffmpeg-static ships ffmpeg and nothing else, so a bare 'ffprobe' resolves
 * only on a machine that happens to have one installed — mine, and not a CI
 * runner. The repository already depends on ffprobe-static for exactly this
 * reason and every other media module resolves it the same way.
 */
export function resolveFfprobeBinary(
  configured?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = configured?.trim() || environment.FFPROBE_PATH?.trim()
  if (explicit) return explicit
  const bundled = typeof ffprobeStatic?.path === 'string' ? ffprobeStatic.path.trim() : ''
  return bundled || 'ffprobe'
}

export class FfmpegSyncMarkerRenderer {
  private readonly ffmpegPath: string
  private readonly ffprobePath: string
  private readonly workRoot: string

  constructor(options: { workRoot: string; ffmpegPath?: string; ffprobePath?: string }) {
    this.workRoot = options.workRoot
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.ffprobePath = resolveFfprobeBinary(options.ffprobePath)
  }

  /**
   * Render the marker to an MP4 and verify it with ffprobe.
   *
   * The probe is not a formality. Everything downstream trusts that this file
   * has the frame rate and sample rate the marker declared, and a renderer
   * that silently produced 25 fps for a 30 fps marker would put every later
   * detection off by a frame with nothing to say so.
   */
  async render(marker: Readonly<SyncMarker>): Promise<Readonly<RenderedMarkerArtifact>> {
    const scratch = join(this.workRoot, `marker-${marker.markerId}-${marker.markerHash.slice(0, 12)}`)
    await mkdir(scratch, { recursive: true })
    const outputPath = join(scratch, 'marker.mp4')
    try {
      const grid = encodePayloadGrid(marker.payload, MARKER_GRID_CELLS)
      const header = Buffer.from(`P5\n${MARKER_FRAME_WIDTH} ${MARKER_FRAME_HEIGHT}\n255\n`, 'ascii')
      await Promise.all(marker.visual.patternFrames.map(async (background, index) => {
        const pixels = composeMarkerFrame({
          background,
          grid,
          codeSizePx: marker.visual.codeSizePx,
          width: MARKER_FRAME_WIDTH,
          height: MARKER_FRAME_HEIGHT,
        })
        await writeFile(
          join(scratch, `frame_${String(index).padStart(3, '0')}.pgm`),
          Buffer.concat([header, pixels]),
        )
      }))

      const pcmPath = join(scratch, 'chirp.pcm')
      await writeFile(pcmPath, synthesizeChirp(marker.audio))

      const durationMs = visualPatternDurationMs(marker.visual)
      const durationSeconds = durationMs / 1_000
      const fps = `${marker.visual.frameRateNum}/${marker.visual.frameRateDen}`

      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-nostdin', '-y',
        '-framerate', fps,
        '-i', join(scratch, 'frame_%03d.pgm'),
        '-f', 's16le', '-ar', String(marker.audio.sampleRate), '-ac', '1', '-i', pcmPath,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', String(marker.audio.sampleRate),
        '-t', durationSeconds.toFixed(4),
        // Deterministic bytes: no wall-clock timestamps or encoder banner in
        // the container, so the same marker always hashes the same.
        '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
        outputPath,
      ], { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 })

      const bytes = await readFile(outputPath)
      const probe = await this.probe(outputPath)
      const video = probe.streams.find((stream) => stream.codec_type === 'video')
      const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio')
      if (!video || !audioStream) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          `the rendered marker ${marker.markerId} is missing a video or audio stream`,
        )
      }
      if (video.r_frame_rate !== fps) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          `the marker declared ${fps} fps but the file reports ${video.r_frame_rate}`,
        )
      }
      if (Number(audioStream.sample_rate) !== marker.audio.sampleRate) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          `the marker declared ${marker.audio.sampleRate} Hz but the file reports ${audioStream.sample_rate}`,
        )
      }

      return Object.freeze({
        markerId: marker.markerId,
        filePath: outputPath,
        byteSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        durationMs,
        width: video.width ?? 0,
        height: video.height ?? 0,
        frameRate: video.r_frame_rate ?? '',
        videoCodec: video.codec_name ?? '',
        audioCodec: audioStream.codec_name ?? '',
        sampleRate: Number(audioStream.sample_rate ?? 0),
      })
    } catch (error) {
      // Leave nothing behind on failure: a half-written marker that a later run
      // mistakes for a good one is worse than no marker at all.
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async probe(path: string): Promise<{ streams: ProbeStream[] }> {
    const { stdout } = await execFileAsync(this.ffprobePath, [
      '-hide_banner', '-loglevel', 'error',
      '-print_format', 'json', '-show_streams', path,
    ], { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 })
    return JSON.parse(stdout) as { streams: ProbeStream[] }
  }
}
