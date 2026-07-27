import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')

test('T-FR-221 renderer materializes B-roll video while preserving source-master audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multisource-render-'))
  const masterPath = join(root, 'master.mp4')
  const brollPath = join(root, 'broll.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-af', 'volume=16',
      '-c:a', 'aac', '-ar', '48000', masterPath,
    ], { windowsHide: true })
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', brollPath,
    ], { windowsHide: true })

    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'work'),
      ffmpegPath,
    })
    const result = await renderer.render({
      operationId: 'multisource-render-test',
      renderKind: 'proxy',
      sources: [
        { artifactId: 'artifact-master', path: masterPath, mediaType: 'video' },
        { artifactId: 'artifact-broll', path: brollPath, mediaType: 'video' },
      ],
      clips: [
        {
          id: 'clip-master',
          sourceArtifactId: 'artifact-master',
          sourceInFrame: 0,
          sourceOutFrame: 60,
          timelineInFrame: 0,
          timelineOutFrame: 60,
          rate: 1,
        },
        {
          id: 'clip-broll',
          sourceArtifactId: 'artifact-broll',
          audioSourceArtifactId: 'artifact-master',
          audioSourceInFrame: 60,
          audioSourceOutFrame: 120,
          sourceInFrame: 0,
          sourceOutFrame: 60,
          timelineInFrame: 60,
          timelineOutFrame: 120,
          rate: 1,
        },
      ],
      fps: 30,
      format: '16:9',
      transitions: [{
        id: 'transition-1',
        fromClipId: 'clip-master',
        toClipId: 'clip-broll',
        atFrame: 60,
        type: 'straight-cut',
        audioFadeMs: 40,
        reason: 'B-roll editorial comprovado.',
      }],
    })

    assert.equal(result.probe.width, 960)
    assert.equal(result.probe.height, 540)
    assert.equal(result.probe.audioCodec, 'aac')
    assert.ok(Math.abs(result.probe.duration - 4) <= 0.1)
    const audioAnalysis = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', result.outputPath,
      '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(audioAnalysis.status, 0, audioAnalysis.stderr)
    const peaks = [...audioAnalysis.stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/g)]
    assert.ok(peaks.length >= 1, 'True-peak analysis must produce a summary')
    assert.ok(
      Number(peaks.at(-1)[1]) <= -1,
      `Rendered audio true peak must stay at or below -1 dBTP: ${peaks.at(-1)[1]}`,
    )
    const pixel = execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', '3', '-i', result.outputPath,
      '-frames:v', '1', '-vf', 'scale=1:1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { windowsHide: true })
    assert.equal(pixel.byteLength, 3)
    assert.ok(pixel[2] > pixel[0] * 2, 'Second scene must visibly use the blue B-roll source')

    const final = await renderer.render({
      operationId: 'multisource-final-fps-test',
      renderKind: 'final',
      outputSpec: { width: 1920, height: 1080, fps: 30 },
      sources: [
        { artifactId: 'artifact-master', path: masterPath, mediaType: 'video' },
      ],
      clips: [{
        id: 'clip-final',
        sourceArtifactId: 'artifact-master',
        sourceInFrame: 0,
        sourceOutFrame: 30,
        timelineInFrame: 0,
        timelineOutFrame: 30,
        rate: 1,
      }],
      fps: 30.0000001,
      format: '16:9',
    })
    assert.equal(final.probe.width, 1920)
    assert.equal(final.probe.height, 1080)
    assert.ok(Math.abs(final.probe.fps - 30) <= 0.01)
    await renderer.cleanup('multisource-render-test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
