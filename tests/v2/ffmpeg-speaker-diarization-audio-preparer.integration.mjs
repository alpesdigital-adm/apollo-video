import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  FfmpegSpeakerDiarizationAudioPreparer,
} from '../../src/v2/infrastructure/media/ffmpeg-speaker-diarization-audio-preparer.ts'
import {
  calculateFileSha256,
} from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const execFileAsync = promisify(execFile)

test('T-FR-133 FFmpeg prepares a bounded mono speech input without mutating its source', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'apollo-diarization-ffmpeg-'),
  )
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  const sourceDirectory = join(artifactRoot, 'masters')
  const sourcePath = join(sourceDirectory, 'source.mp4')
  try {
    await mkdir(sourceDirectory, { recursive: true })
    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x180:r=25:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=1',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        sourcePath,
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    )
    const sourceMetadata = await stat(sourcePath)
    const sourceSha256 = await calculateFileSha256(sourcePath)
    const preparer =
      new FfmpegSpeakerDiarizationAudioPreparer({
        artifactRoot,
        workRoot,
        ffmpegPath,
        ffprobePath,
        timeoutMs: 60_000,
      })
    const prepared = await preparer.prepare({
      operationId: 'operation-ffmpeg-diarization',
      sourceArtifactKey: 'masters/source.mp4',
      sourceArtifactSha256: sourceSha256,
      sourceArtifactByteSize: BigInt(sourceMetadata.size),
      expectedDurationMs: 1_000,
      signal: new AbortController().signal,
    })
    assert.match(prepared.audioPath, /provider-input\.mp3$/)
    assert.match(prepared.sha256, /^[a-f0-9]{64}$/)
    assert.ok(prepared.byteSize > 0)
    assert.ok(Math.abs(prepared.durationMs - 1_000) <= 100)
    assert.equal(prepared.preparation.toolId, 'ffmpeg')
    assert.match(
      prepared.preparation.configurationHash,
      /^[a-f0-9]{64}$/,
    )
    assert.equal(
      await calculateFileSha256(sourcePath),
      sourceSha256,
    )
    await preparer.cleanup('operation-ffmpeg-diarization')
    await assert.rejects(access(prepared.audioPath))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
