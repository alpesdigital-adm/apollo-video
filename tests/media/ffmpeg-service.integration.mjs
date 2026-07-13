import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
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
  MediaOutputError,
  MediaProcessError,
  normalizeVideo,
} from '../../src/lib/services/ffmpeg.ts'
import {
  calculateFileSha256,
  inspectLocalMediaArtifact,
  writeLocalMediaArtifactManifest,
} from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

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

function hasMediaFailureCode(code) {
  return (error) => error instanceof MediaProcessError && error.code === code
}

async function assertMissing(filePath) {
  await assert.rejects(
    () => stat(filePath),
    (error) => error?.code === 'ENOENT',
  )
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
  const cancelledPath = path.join(directory, 'cancelled.mp4')
  const timedOutPath = path.join(directory, 'timed-out.mp4')
  const preservedPath = path.join(directory, 'preserved.mp4')
  const mutatedPath = path.join(directory, 'mutated.mp4')
  const manifestPath = path.join(directory, 'normalized.artifact.json')

  await createFixture(sourcePath)

  const source = await getVideoInfo(sourcePath)
  assert.deepEqual({ width: source.width, height: source.height, fps: source.fps }, {
    width: 320,
    height: 240,
    fps: 30,
  })
  assert.ok(source.duration >= 2.9 && source.duration <= 3.1)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => getVideoInfo(sourcePath, { signal: controller.signal }),
    hasMediaFailureCode('MEDIA_PROCESS_CANCELLED'),
  )
  const activeController = new AbortController()
  const activeCancellation = normalizeVideo(sourcePath, cancelledPath, {
    signal: activeController.signal,
  })
  const cancelTimer = setTimeout(() => activeController.abort(), 10)
  try {
    await assert.rejects(
      activeCancellation,
      hasMediaFailureCode('MEDIA_PROCESS_CANCELLED'),
    )
  } finally {
    clearTimeout(cancelTimer)
  }
  await assertMissing(cancelledPath)
  await assert.rejects(
    () => getVideoInfo(sourcePath, { timeoutMs: 1 }),
    hasMediaFailureCode('MEDIA_PROCESS_TIMEOUT'),
  )
  await assert.rejects(
    () => normalizeVideo(sourcePath, timedOutPath, { timeoutMs: 1 }),
    hasMediaFailureCode('MEDIA_PROCESS_TIMEOUT'),
  )
  await assertMissing(timedOutPath)
  await assert.rejects(
    () => getVideoInfo(path.join(directory, 'missing.mp4')),
    (error) =>
      error instanceof MediaProcessError &&
      error.code === 'MEDIA_PROCESS_FAILED' &&
      error.stderrTail.length > 0 &&
      error.stderrTail.length <= 4_000,
  )

  const sourceBeforeConflict = await readFile(sourcePath)
  await assert.rejects(
    () => normalizeVideo(sourcePath, sourcePath),
    (error) =>
      error instanceof MediaOutputError && error.code === 'MEDIA_OUTPUT_CONFLICT',
  )
  assert.deepEqual(await readFile(sourcePath), sourceBeforeConflict)

  await copyFile(sourcePath, preservedPath)
  const preservedBeforeFailure = await readFile(preservedPath)
  await assert.rejects(
    () => normalizeVideo(path.join(directory, 'missing-input.mp4'), preservedPath),
    hasMediaFailureCode('MEDIA_PROCESS_FAILED'),
  )
  assert.deepEqual(await readFile(preservedPath), preservedBeforeFailure)

  await copyFile(sourcePath, normalizedPath)
  const normalizedBeforePromotion = await readFile(normalizedPath)
  const normalized = await normalizeVideo(sourcePath, normalizedPath)
  assert.equal(normalized.width, 320)
  assert.equal(normalized.height, 240)
  assert.equal(normalized.fps, 30)
  assert.notDeepEqual(await readFile(normalizedPath), normalizedBeforePromotion)

  const sourceSha256 = await calculateFileSha256(sourcePath)
  const manifestInput = {
    filePath: normalizedPath,
    artifactKey: 'workspaces/test/artifacts/normalized.mp4',
    mediaType: 'video',
    container: 'mp4',
    recipe: {
      id: 'normalize-video',
      version: 'v1',
      parameters: { crf: 23, privatePrompt: 'must-not-be-persisted' },
    },
    sources: [
      {
        artifactKey: 'workspaces/test/masters/source.mp4',
        sha256: sourceSha256,
        role: 'primary',
      },
    ],
    probe: normalized,
  }
  const manifest = await inspectLocalMediaArtifact(manifestInput)
  const reorderedManifest = await inspectLocalMediaArtifact({
    ...manifestInput,
    recipe: {
      ...manifestInput.recipe,
      parameters: { privatePrompt: 'must-not-be-persisted', crf: 23 },
    },
  })
  assert.deepEqual(manifest, reorderedManifest)

  await writeLocalMediaArtifactManifest(manifestPath, manifest)
  const serializedManifest = await readFile(manifestPath, 'utf8')
  assert.deepEqual(JSON.parse(serializedManifest), manifest)
  assert.equal(serializedManifest.includes(directory), false)
  assert.equal(serializedManifest.includes('must-not-be-persisted'), false)

  await copyFile(normalizedPath, mutatedPath)
  await appendFile(mutatedPath, Buffer.from([0]))
  const mutatedManifest = await inspectLocalMediaArtifact({
    ...manifestInput,
    filePath: mutatedPath,
  })
  assert.notEqual(mutatedManifest.artifact.sha256, manifest.artifact.sha256)
  assert.notEqual(mutatedManifest.manifestHash, manifest.manifestHash)

  await generatePreviewProxy(sourcePath, proxyPath)
  const proxy = await getVideoInfo(proxyPath)
  assert.equal(proxy.width, 320)
  assert.equal(proxy.height, 240)

  await extractAudio(sourcePath, audioPath)
  await assert.rejects(
    () => detectSilences(audioPath, -35, 0.5, { maxBufferBytes: 64 }),
    hasMediaFailureCode('MEDIA_PROCESS_OUTPUT_LIMIT'),
  )
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

  const partials = (await readdir(directory)).filter((entry) => entry.includes('.partial'))
  assert.deepEqual(partials, [])
})
