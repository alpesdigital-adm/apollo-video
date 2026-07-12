import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  cutSilencesFromVideo,
  detectSilences,
  extractAudio,
  extractThumbnail,
  generatePreviewProxy,
  getVideoInfo,
  normalizeVideo,
} from '../../src/lib/services/ffmpeg.ts'

const execFileAsync = promisify(execFile)
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const ffmpegPath = path.join(
  process.cwd(),
  'node_modules',
  'ffmpeg-static',
  `ffmpeg${executableSuffix}`,
)

async function createFixture(outputPath) {
  await execFileAsync(ffmpegPath, [
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000:duration=1',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=mono:sample_rate=48000:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=700:sample_rate=48000:duration=1',
    '-filter_complex',
    '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]',
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    outputPath,
  ])
}

test('direct FFmpeg adapter preserves the characterized media flow', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apollo-ffmpeg-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const sourcePath = path.join(directory, 'source.mp4')
  const normalizedPath = path.join(directory, 'normalized.mp4')
  const proxyPath = path.join(directory, 'proxy.mp4')
  const audioPath = path.join(directory, 'audio.wav')
  const thumbnailPath = path.join(directory, 'thumbnail.jpg')
  const cutPath = path.join(directory, 'cut.mp4')

  await createFixture(sourcePath)

  const source = await getVideoInfo(sourcePath)
  assert.deepEqual({ width: source.width, height: source.height, fps: source.fps }, {
    width: 320,
    height: 240,
    fps: 30,
  })
  assert.ok(source.duration >= 2.9 && source.duration <= 3.1)

  const normalized = await normalizeVideo(sourcePath, normalizedPath)
  assert.equal(normalized.width, 320)
  assert.equal(normalized.height, 240)
  assert.equal(normalized.fps, 30)

  await generatePreviewProxy(sourcePath, proxyPath)
  const proxy = await getVideoInfo(proxyPath)
  assert.equal(proxy.width, 320)
  assert.equal(proxy.height, 240)

  await extractAudio(sourcePath, audioPath)
  const silences = await detectSilences(audioPath, -35, 0.5)
  const middleSilence = silences.find(
    (silence) => silence.startTime <= 1.2 && silence.endTime >= 1.8,
  )
  assert.ok(middleSilence, `expected middle silence, received ${JSON.stringify(silences)}`)

  const cut = await cutSilencesFromVideo(sourcePath, cutPath, silences, source.duration)
  assert.ok(cut.cutSilences.length >= 1)
  assert.ok(cut.outputDuration >= 1.8 && cut.outputDuration < source.duration)

  await extractThumbnail(sourcePath, 1.5, thumbnailPath, 180)
  assert.ok((await stat(thumbnailPath)).size > 0)
})
