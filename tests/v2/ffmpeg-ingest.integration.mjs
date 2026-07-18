import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { FfmpegIngestProcessor } from '../../src/v2/infrastructure/media/ffmpeg-ingest-processor.ts'

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
