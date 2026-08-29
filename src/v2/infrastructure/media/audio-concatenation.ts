import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import {
  AUDIO_CONCATENATION_SCHEMA_VERSION,
  type AudioConcatenationBlockInput,
  type AudioConcatenationManifestEntry,
  type AudioConcatenationResult,
} from '../../domain/synthetic-block-concatenation.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'

const run = promisify(execFile)

/** Samples per MPEG-1 Layer III frame — constant for 32-48 kHz MP3. */
const MP3_SAMPLES_PER_FRAME = 1_152

interface ProbedAudio {
  codec: string
  sampleRate: number
  channels: number
  packets: number
  samples: number
}

async function probeAudio(ffprobePath: string, path: string): Promise<ProbedAudio> {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0', '-count_packets', '-count_frames',
    '-show_entries', 'stream=codec_name,sample_rate,channels,nb_read_packets,nb_read_frames,duration',
    '-of', 'json', path,
  ], { windowsHide: true })
  const stream = (JSON.parse(stdout).streams ?? [])[0]
  if (!stream) throw new DomainError('INVALID_ARGUMENT', 'Concatenation input has no audio stream')
  const sampleRate = Number(stream.sample_rate)
  const channels = Number(stream.channels)
  const packets = Number(stream.nb_read_packets)
  assertDomain(
    Number.isSafeInteger(sampleRate) && sampleRate > 0 &&
      Number.isSafeInteger(channels) && channels >= 1 && channels <= 2 &&
      Number.isSafeInteger(packets) && packets > 0,
    'INVALID_ARGUMENT',
    'Concatenation input audio stream is invalid',
  )
  const samples = stream.codec_name === 'mp3'
    ? packets * MP3_SAMPLES_PER_FRAME
    : Math.round(Number(stream.duration) * sampleRate)
  return { codec: String(stream.codec_name), sampleRate, channels, packets, samples }
}

function concatListEntry(path: string): string {
  return `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
}

/**
 * Deterministic FFmpeg concatenation of approved block audio.
 *
 * When every input shares codec, sample rate and channel layout, packets are
 * stream-copied — no reencode — and offsets derive frame-first from the real
 * packet counts (1152 samples per MP3 frame). Incompatible inputs are
 * normalized once, explicitly, to PCM WAV at the declared target, where
 * offsets are sample-exact. Configurable silence between blocks is generated
 * at the exact stream parameters and measured, never assumed: room tone sits
 * only in the gaps and can never cover or cut speech. Zero gap stays
 * supported. Same inputs and settings produce byte-identical output.
 */
export async function concatenateBlockAudio(input: {
  blocks: readonly Readonly<AudioConcatenationBlockInput>[]
  gapMs: number
  workDirectory: string
  ffmpegPath: string
  ffprobePath: string
  normalization?: { sampleRate: number; channels: 1 | 2 }
}): Promise<Readonly<AudioConcatenationResult>> {
  assertDomain(input.blocks.length >= 1 && input.blocks.length <= 500, 'INVALID_ARGUMENT', 'Concatenation requires one to five hundred blocks')
  assertDomain(Number.isSafeInteger(input.gapMs) && input.gapMs >= 0 && input.gapMs <= 10_000, 'INVALID_ARGUMENT', 'Concatenation gap is invalid')
  await mkdir(input.workDirectory, { recursive: true })

  for (const block of input.blocks) {
    const actual = await calculateFileSha256(block.path)
    assertDomain(actual === block.sha256, 'PERSISTENCE_CONFLICT', `Concatenation input ${block.blockId} does not match its immutable identity`)
  }
  const probes = await Promise.all(input.blocks.map(({ path }) => probeAudio(input.ffprobePath, path)))
  const first = probes[0]!
  const compatible = probes.every((probe) =>
    probe.codec === first.codec && probe.sampleRate === first.sampleRate && probe.channels === first.channels) &&
    ['mp3', 'pcm_s16le'].includes(first.codec)

  const normalization = input.normalization ?? { sampleRate: 44_100, channels: 1 as const }
  const target = compatible
    ? { codec: first.codec, sampleRate: first.sampleRate, channels: first.channels, container: first.codec === 'mp3' ? 'mp3' as const : 'wav' as const }
    : { codec: 'pcm_s16le', sampleRate: normalization.sampleRate, channels: normalization.channels, container: 'wav' as const }
  const processing: 'copy' | 'reencode' = compatible ? 'copy' : 'reencode'

  // Materialize the pieces that enter the concat list.
  const pieces: { path: string; samples: number }[] = []
  const encodeArguments = target.codec === 'mp3'
    ? ['-c:a', 'libmp3lame', '-b:a', '128k']
    : ['-c:a', 'pcm_s16le']
  let sources: readonly string[]
  if (compatible) {
    sources = input.blocks.map(({ path }) => path)
  } else {
    sources = await Promise.all(input.blocks.map(async (block, index) => {
      const normalized = join(input.workDirectory, `normalized-${index}.wav`)
      await run(input.ffmpegPath, [
        '-v', 'error', '-y', '-i', block.path,
        '-ar', String(target.sampleRate), '-ac', String(target.channels),
        ...encodeArguments, '-map_metadata', '-1', '-bitexact', normalized,
      ], { windowsHide: true })
      return normalized
    }))
  }
  const sourceProbes = compatible ? probes : await Promise.all(sources.map((path) => probeAudio(input.ffprobePath, path)))

  let silence: { path: string; samples: number } | null = null
  if (input.gapMs > 0 && input.blocks.length > 1) {
    const silencePath = join(input.workDirectory, `silence.${target.container}`)
    await run(input.ffmpegPath, [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', `anullsrc=r=${target.sampleRate}:cl=${target.channels === 1 ? 'mono' : 'stereo'}`,
      '-t', (input.gapMs / 1_000).toFixed(3),
      ...encodeArguments, '-map_metadata', '-1', '-bitexact', silencePath,
    ], { windowsHide: true })
    const probed = await probeAudio(input.ffprobePath, silencePath)
    silence = { path: silencePath, samples: probed.samples }
  }

  const listEntries: string[] = []
  const entries: AudioConcatenationManifestEntry[] = []
  let cursorSamples = 0
  for (const [index, block] of input.blocks.entries()) {
    const probe = sourceProbes[index]!
    const outputInMs = Math.round((cursorSamples / target.sampleRate) * 1_000)
    cursorSamples += probe.samples
    const outputOutMs = Math.round((cursorSamples / target.sampleRate) * 1_000)
    listEntries.push(concatListEntry(sources[index]!))
    pieces.push({ path: sources[index]!, samples: probe.samples })
    let gapAfterMs = 0
    if (silence && index < input.blocks.length - 1) {
      listEntries.push(concatListEntry(silence.path))
      cursorSamples += silence.samples
      gapAfterMs = Math.round((silence.samples / target.sampleRate) * 1_000)
    }
    entries.push({
      blockId: block.blockId,
      generationId: block.generationId,
      artifactSha256: block.sha256,
      sourceDurationMs: Math.round((probe.samples / target.sampleRate) * 1_000),
      outputInMs,
      outputOutMs,
      gapAfterMs,
      processing,
      alignmentOffsetMs: outputInMs,
    })
  }

  const listPath = join(input.workDirectory, 'concat-list.txt')
  await writeFile(listPath, `${listEntries.join('\n')}\n`, 'utf8')
  const outputPath = join(input.workDirectory, `concatenated.${target.container}`)
  await run(input.ffmpegPath, [
    '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-map_metadata', '-1', '-bitexact', outputPath,
  ], { windowsHide: true })

  const output = await probeAudio(input.ffprobePath, outputPath)
  assertDomain(
    output.codec === target.codec && output.sampleRate === target.sampleRate && output.channels === target.channels,
    'PERSISTENCE_CONFLICT',
    'Concatenated audio drifted from its declared stream parameters',
  )
  const expectedSamples = pieces.reduce((total, piece) => total + piece.samples, 0) +
    (silence ? silence.samples * (input.blocks.length - 1) : 0)
  assertDomain(
    output.samples === expectedSamples,
    'PERSISTENCE_CONFLICT',
    `Concatenated audio lost or gained samples (${output.samples} != ${expectedSamples})`,
  )
  const durationMs = Math.round((output.samples / target.sampleRate) * 1_000)
  const finalAudioSha256 = await calculateFileSha256(outputPath)
  const body = Object.freeze({
    schemaVersion: AUDIO_CONCATENATION_SCHEMA_VERSION,
    container: target.container,
    codec: target.codec,
    sampleRate: target.sampleRate,
    channels: target.channels,
    gapMs: input.gapMs,
    durationMs,
    finalAudioSha256,
    entries,
  })
  return Object.freeze({
    outputPath,
    container: target.container,
    codec: target.codec,
    sampleRate: target.sampleRate,
    channels: target.channels,
    durationMs,
    finalAudioSha256,
    entries: Object.freeze(entries),
    concatHash: calculateCanonicalHash(body),
  })
}
