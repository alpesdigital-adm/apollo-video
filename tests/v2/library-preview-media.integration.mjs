import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import sharp from 'sharp'
import { resolveFfmpegBinary } from '../../src/v2/infrastructure/media/ffmpeg-binary.ts'
import { FfmpegLibraryPreviewProcessor } from '../../src/v2/infrastructure/media/ffmpeg-library-preview-processor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
const require = createRequire(import.meta.url)
const execute = promisify(execFile)
test('W44 real video thumbnail and waveform preserve original pixels and audio signal', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-library-preview-'))
  const sourcePath = join(root, 'master.mp4'); const processor = new FfmpegLibraryPreviewProcessor(join(root, 'work'))
  try {
    await execute(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath], { windowsHide: true, timeout: 30_000 })
    const sourceHash = await calculateFileSha256(sourcePath)
    const outputs = await processor.generate({ operationId: 'preview-real-media', sourcePath, mediaType: 'video' })
    assert.deepEqual(outputs.map((output) => output.kind), ['thumbnail', 'waveform'])
    const binary = resolveFfmpegBinary()
    const binaryHash = await calculateFileSha256(binary)
    const version = /^ffmpeg version (\S+)/m.exec((await execute(binary, ['-version'], { windowsHide: true, timeout: 10000 })).stdout)?.[1]
    for (const output of outputs) { assert.equal(output.tool.id, 'ffmpeg'); assert.equal(output.tool.digest, binaryHash); assert.equal(output.tool.version, version) }
    assert.strictEqual(outputs[0].tool, outputs[1].tool, 'outputs share measured executable identity')
    const replay = await processor.generate({ operationId: 'preview-real-media-cache', sourcePath, mediaType: 'video' })
    assert.strictEqual(replay[0].tool, outputs[0].tool, 'process cache reuses executable identity')
    await processor.cleanup('preview-real-media-cache')
    const thumbnail = await sharp(outputs[0].path).raw().toBuffer({ resolveWithObject: true })
    assert.equal(thumbnail.info.width, 320); assert.equal(thumbnail.info.height, 180)
    assert.ok(thumbnail.data[2] > 230 && thumbnail.data[0] < 20, 'thumbnail retains the blue master frame')
    const waveform = await sharp(outputs[1].path).stats()
    assert.ok(waveform.channels.some((channel) => channel.stdev > 10), 'waveform contains observed audio variation')
    assert.equal(outputs[1].width, 640); assert.equal(outputs[1].height, 120)
    assert.equal(await calculateFileSha256(sourcePath), sourceHash)
    await processor.cleanup('preview-real-media'); assert.deepEqual(await readdir(join(root, 'work')), [])
    const controller = new AbortController(); controller.abort()
    await assert.rejects(() => processor.generate({ operationId: 'preview-cancelled', sourcePath, mediaType: 'video', signal: controller.signal }), /cannot start/)
  } finally { await processor.cleanup('preview-real-media'); await rm(root, { recursive: true, force: true }) }
})
