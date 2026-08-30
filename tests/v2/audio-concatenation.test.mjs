import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { concatenateBlockAudio } from '../../src/v2/infrastructure/media/audio-concatenation.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

let root
let blocks

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'apollo-audio-concat-'))
  const make = async (name, frequency, seconds, extra = []) => {
    const path = join(root, name)
    execFileSync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=${seconds}`,
      ...extra, '-map_metadata', '-1', '-bitexact', path,
    ], { windowsHide: true })
    return { path, sha256: await calculateFileSha256(path) }
  }
  const one = await make('block-1.mp3', 300, 1, ['-c:a', 'libmp3lame', '-b:a', '128k'])
  const two = await make('block-2.mp3', 340, 2, ['-c:a', 'libmp3lame', '-b:a', '128k'])
  const three = await make('block-3.mp3', 380, 1.5, ['-c:a', 'libmp3lame', '-b:a', '128k'])
  blocks = [
    { blockId: 'block-1', generationId: 'generation-1', ...one },
    { blockId: 'block-2', generationId: 'generation-2', ...two },
    { blockId: 'block-3', generationId: 'generation-3', ...three },
  ]
})

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

const probe = (path) => JSON.parse(execFileSync(ffprobePath, [
  '-v', 'error', '-select_streams', 'a:0', '-count_packets',
  '-show_entries', 'stream=codec_name,sample_rate,channels,nb_read_packets',
  '-of', 'json', path,
], { encoding: 'utf8', windowsHide: true })).streams[0]

test('T-FR-102 compatible MP3 blocks concatenate by stream copy with measured gaps', async () => {
  const workDirectory = join(root, 'copy-run')
  const result = await concatenateBlockAudio({ blocks, gapMs: 250, workDirectory, ffmpegPath, ffprobePath })
  assert.equal(result.container, 'mp3')
  assert.equal(result.codec, 'mp3')
  assert.deepEqual(result.entries.map(({ processing }) => processing), ['copy', 'copy', 'copy'])
  const output = probe(result.outputPath)
  assert.equal(output.codec_name, 'mp3')
  assert.equal(Number(output.sample_rate), 44100)
  // Frame accounting is exact for stream copy: output packets are the sum of
  // every piece's packets, including the two measured silence gaps.
  const inputPackets = blocks.map(({ path }) => Number(probe(path).nb_read_packets))
  const silencePackets = Number(probe(join(workDirectory, 'silence.mp3')).nb_read_packets)
  assert.equal(Number(output.nb_read_packets), inputPackets.reduce((a, b) => a + b, 0) + 2 * silencePackets)
  // Offsets are monotonic, gap-aware and end within the declared duration.
  let cursor = 0
  for (const [index, entry] of result.entries.entries()) {
    assert.equal(entry.outputInMs, cursor)
    assert.ok(entry.outputOutMs > entry.outputInMs)
    assert.equal(entry.alignmentOffsetMs, entry.outputInMs)
    assert.equal(entry.gapAfterMs > 0, index < result.entries.length - 1)
    cursor = entry.outputOutMs + entry.gapAfterMs
  }
  assert.equal(result.durationMs, cursor)
  assert.ok(Math.abs(result.entries[0].sourceDurationMs - 1_000) < 60)
})

test('T-FR-102 zero gap stays supported and loses no samples', async () => {
  const result = await concatenateBlockAudio({
    blocks, gapMs: 0, workDirectory: join(root, 'zero-gap-run'), ffmpegPath, ffprobePath,
  })
  assert.deepEqual(result.entries.map(({ gapAfterMs }) => gapAfterMs), [0, 0, 0])
  const inputPackets = blocks.map(({ path }) => Number(probe(path).nb_read_packets))
  assert.equal(Number(probe(result.outputPath).nb_read_packets), inputPackets.reduce((a, b) => a + b, 0))
})

test('T-FR-102 concatenation is deterministic for identical inputs and settings', async () => {
  const first = await concatenateBlockAudio({ blocks, gapMs: 120, workDirectory: join(root, 'det-a'), ffmpegPath, ffprobePath })
  const second = await concatenateBlockAudio({ blocks, gapMs: 120, workDirectory: join(root, 'det-b'), ffmpegPath, ffprobePath })
  assert.equal(first.finalAudioSha256, second.finalAudioSha256)
  assert.equal(first.concatHash, second.concatHash)
})

test('T-FR-102 incompatible inputs normalize once to explicit PCM WAV, sample-exact', async () => {
  const oddPath = join(root, 'block-odd.wav')
  execFileSync(ffmpegPath, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=420:sample_rate=48000:duration=1',
    '-ac', '2', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-bitexact', oddPath,
  ], { windowsHide: true })
  const mixed = [
    blocks[0],
    { blockId: 'block-odd', generationId: 'generation-odd', path: oddPath, sha256: await calculateFileSha256(oddPath) },
  ]
  const result = await concatenateBlockAudio({
    blocks: mixed, gapMs: 100, workDirectory: join(root, 'normalize-run'), ffmpegPath, ffprobePath,
  })
  assert.equal(result.container, 'wav')
  assert.equal(result.codec, 'pcm_s16le')
  assert.equal(result.sampleRate, 44100)
  assert.equal(result.channels, 1)
  assert.deepEqual(result.entries.map(({ processing }) => processing), ['reencode', 'reencode'])
  const output = probe(result.outputPath)
  assert.equal(output.codec_name, 'pcm_s16le')
  assert.equal(Number(output.sample_rate), 44100)
})

test('T-FR-102 a tampered input fails closed before any FFmpeg work', async () => {
  await mkdir(join(root, 'tamper-run'), { recursive: true })
  await assert.rejects(
    concatenateBlockAudio({
      blocks: [{ ...blocks[0], sha256: 'f'.repeat(64) }],
      gapMs: 0, workDirectory: join(root, 'tamper-run'), ffmpegPath, ffprobePath,
    }),
    (error) => error.code === 'PERSISTENCE_CONFLICT' && /immutable identity/.test(error.message),
  )
})
