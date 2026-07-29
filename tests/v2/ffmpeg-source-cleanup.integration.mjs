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
