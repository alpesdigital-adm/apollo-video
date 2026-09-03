import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import sharp from 'sharp'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  FfmpegSourceCleanupProcessor,
} from '../../src/v2/infrastructure/media/ffmpeg-source-cleanup-processor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)
const fixture = resolve(
  'tests/fixtures/contamination/logo-watermark.mp4',
)

async function frame(videoPath, outputPath, seconds = 1) {
  await execFileAsync(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(seconds),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    outputPath,
  ], { windowsHide: true })
  return outputPath
}

test('T-FR-122 FFmpeg visual goldens execute trim, crop/reframe and cover while rejecting reject', {
  timeout: 120_000,
}, async () => {
  const workRoot = await mkdtemp(
    join(tmpdir(), 'apollo-source-cleanup-'),
  )
  const processor = new FfmpegSourceCleanupProcessor({
    workRoot,
    ffmpegPath,
  })
  try {
    const trim = await processor.process({
      operationId: 'cleanup-golden-trim',
      sourcePath: fixture,
      sourceDurationMs: 2_000,
      action: {
        strategy: 'trim',
        keepRangeMs: [500, 2_000],
        removedRangeMs: [0, 500],
      },
    })
    assert.equal(trim.visual.passed, true)
    assert.ok(Math.abs(trim.probe.duration - 1.5) < 0.25)
    assert.equal(trim.probe.width, 320)
    assert.equal(trim.probe.height, 568)

    const crop = await processor.process({
      operationId: 'cleanup-golden-crop',
      sourcePath: fixture,
      sourceDurationMs: 2_000,
      action: {
        strategy: 'crop-reframe',
        crop: { x: 0, y: 0, width: 0.75, height: 1 },
        removedRegion: {
          x: 0.77,
          y: 0.03,
          width: 0.2,
          height: 0.08,
        },
      },
    })
    assert.equal(crop.visual.passed, true)
    assert.equal(crop.probe.width, 320)
    assert.equal(crop.probe.height, 568)
    assert.notEqual(crop.sha256, trim.sha256)

    const cover = await processor.process({
      operationId: 'cleanup-golden-cover',
      sourcePath: fixture,
      sourceDurationMs: 2_000,
      action: {
        strategy: 'cover',
        rangeMs: [0, 2_000],
        region: {
          x: 0.77,
          y: 0.03,
          width: 0.2,
          height: 0.08,
        },
        color: '#111111',
      },
    })
    assert.equal(cover.visual.passed, true)
    assert.equal(cover.probe.width, 320)
    assert.equal(cover.probe.height, 568)

    const coveredFrame = await frame(
      cover.outputPath,
      join(workRoot, 'covered.png'),
    )
    const { data: sample, info } = await sharp(coveredFrame)
      .extract({ left: 265, top: 25, width: 10, height: 10 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 3)
    const means = [0, 1, 2].map((channel) => {
      let sum = 0
      for (let index = channel; index < sample.length; index += 3) {
        sum += sample[index]
      }
      return sum / (sample.length / 3)
    })
    for (const mean of means) {
      assert.ok(
        mean >= 8 && mean <= 30,
        `covered region mean ${mean} must match #111111`,
      )
    }

    await assert.rejects(
      processor.process({
        operationId: 'cleanup-golden-reject',
        sourcePath: fixture,
        sourceDurationMs: 2_000,
        action: {
          strategy: 'reject',
          reasonCodes: ['NO_MVP_STRATEGY_MEETS_THRESHOLDS'],
        },
      }),
      (error) =>
        error instanceof DomainError &&
        error.code === 'INVALID_RENDER_INPUT',
    )
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
})

function toneAmplitude(pcm, sampleRate, frequency) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
  let real = 0
  let imaginary = 0
  for (let index = 0; index < samples.length; index += 1) {
    const angle = 2 * Math.PI * frequency * index / sampleRate
    real += samples[index] * Math.cos(angle)
    imaginary -= samples[index] * Math.sin(angle)
  }
  return Math.hypot(real, imaginary) / Math.max(1, samples.length)
}

test('T-FR-123 FFmpeg remuxes a provider-isolated speech stem and removes the measured music tone', {
  timeout: 120_000,
}, async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-source-separation-'))
  const sourcePath = join(workRoot, 'mixed-source.mp4')
  const isolatedPath = join(workRoot, 'isolated-speech.mp3')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
    '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]',
    '-map', '0:v:0', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', sourcePath,
  ], { windowsHide: true })
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:a', 'libmp3lame', '-b:a', '128k', isolatedPath,
  ], { windowsHide: true })
  const sourceSha256 = await calculateFileSha256(sourcePath)
  const isolatedSha256 = await calculateFileSha256(isolatedPath)
  const offer = Object.freeze({
    adapterId: 'controlled-voice-isolation', adapterVersion: '1.0.0',
    provider: 'controlled-provider', modelRef: 'controlled-model/v1',
    configHash: '1'.repeat(64), capabilityHash: '2'.repeat(64),
    minDurationMs: 1_000,
    maxDurationMs: 60_000, normalizedCost: 0.6,
    predictedSpeechRetention: 0.95, predictedMusicRemoval: 0.95,
    predictedIntegrity: 0.95,
    billing: Object.freeze({ unit: 'provider-characters', quantity: 1_000 }),
  })
  let calls = 0
  const processor = new FfmpegSourceCleanupProcessor({
    workRoot,
    ffmpegPath,
    separationProvider: {
      offer: () => offer,
      isolate: async (input) => {
        calls += 1
        assert.equal(input.sourceSha256, sourceSha256)
        assert.deepEqual(input.expectedOffer, offer)
        return Object.freeze({
          isolatedAudioPath: isolatedPath,
          isolatedAudioSha256: isolatedSha256,
          isolatedAudioByteSize: 32_000,
          providerRequestId: 'controlled-isolation-request',
          offer,
        })
      },
    },
  })
  try {
    const result = await processor.process({
      operationId: 'cleanup-golden-separation',
      sourcePath,
      sourceSha256,
      sourceDurationMs: 2_000,
      action: { strategy: 'separation', rangeMs: [0, 2_000], offer },
    })
    assert.equal(calls, 1)
    assert.equal(result.visual.passed, true)
    assert.equal(result.audio.passed, true)
    assert.equal(result.audio.providerBindingVerified, true)
    assert.equal(result.separation.isolatedAudioSha256, isolatedSha256)
    assert.equal(result.probe.audioCodec, 'aac')
    const { stdout } = await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', result.outputPath,
      '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1',
    ], { windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
    const speech = toneAmplitude(stdout, 8_000, 440)
    const music = toneAmplitude(stdout, 8_000, 880)
    assert.ok(speech > music * 20, `speech/music amplitude ratio ${speech / Math.max(1, music)}`)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
})
