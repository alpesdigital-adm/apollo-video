import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { FfmpegIngestProcessor } from '../../src/v2/infrastructure/media/ffmpeg-ingest-processor.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

test('V2 FFmpeg ingest creates an inspectable proxy and speech derivative from a real master', async (t) => {
  assert.equal(typeof ffmpegPath, 'string')
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-ffmpeg-ingest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'master.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1.2',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
  ], { windowsHide: true, timeout: 60_000 })

  const processor = new FfmpegIngestProcessor({ workRoot: join(root, 'work'), ffmpegPath })
  const result = await processor.normalize({ sourcePath, operationId: 'operation-real-ingest-1' })

  assert.equal(result.probe.width, 640)
  assert.equal(result.probe.height, 360)
  assert.ok(result.probe.duration >= 1 && result.probe.duration <= 2)
  assert.equal(result.probe.codec, 'h264')
  assert.match(result.proxySha256, /^[a-f0-9]{64}$/)
  assert.ok(result.proxyByteSize > 0)
  assert.ok((await stat(result.audioPath)).size > 0)
  await access(result.proxyPath)

  await processor.cleanup('operation-real-ingest-1')
  await assert.rejects(() => access(result.proxyPath), { code: 'ENOENT' })
})

test('V2 editorial renderer materializes exact retained clips as a format-aware MP4 without crop zoom', async (t) => {
  assert.equal(typeof ffmpegPath, 'string')
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-ffmpeg-editorial-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'master.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1.6',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1.6',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
  ], { windowsHide: true, timeout: 60_000 })

  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  const result = await renderer.render({
    operationId: 'operation-editorial-render-1',
    sourcePath,
    fps: 25,
    format: '9:16',
    clips: [
      { id: 'clip-1', sourceArtifactId: 'artifact-1', sourceInFrame: 0, sourceOutFrame: 10, timelineInFrame: 0, timelineOutFrame: 10, rate: 1 },
      { id: 'clip-2', sourceArtifactId: 'artifact-1', sourceInFrame: 20, sourceOutFrame: 30, timelineInFrame: 10, timelineOutFrame: 20, rate: 1 },
    ],
  })

  assert.equal(result.probe.width, 540)
  assert.equal(result.probe.height, 960)
  assert.ok(result.probe.duration >= 0.75 && result.probe.duration <= 0.85)
  assert.equal(result.probe.codec, 'h264')
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.ok(result.byteSize > 0)
  await access(result.outputPath)

  await renderer.cleanup('operation-editorial-render-1')
  await assert.rejects(() => access(result.outputPath), { code: 'ENOENT' })
})
