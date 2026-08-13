import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OUTPUT_FORMAT_REGISTRY } from '../../src/v2/domain/output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../src/v2/domain/output-spec.ts'
import { createReframeObservationSet, createReframePlan, REFRAME_OBSERVATION_FIXTURES } from '../../src/v2/domain/reframe-plan.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

test('T-FR-164 real FFmpeg goldens keep the tracked face visible in all five canonical formats', { timeout: 5 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-reframe-golden-'))
  const source = join(root, 'source.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=blue:s=640x360:r=30:d=3',
      '-vf', 'drawbox=x=269:y=72:w=102:h=86:color=red:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source,
    ], { windowsHide: true, timeout: 60_000 })
    const observations = createReframeObservationSet({
      id: 'observations-reframe-render', sourceArtifactId: 'artifact-reframe-render', sourceManifestId: 'manifest-reframe-render',
      sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'), sourceWidth: 640, sourceHeight: 360,
      fps: 30, durationFrames: 90, observations: REFRAME_OBSERVATION_FIXTURES.onePerson,
    })
    const evidence = []
    for (const format of OUTPUT_ASPECT_RATIOS) {
      const preset = OUTPUT_FORMAT_REGISTRY.presets[format]
      const plan = createReframePlan({ format, observationSet: observations })
      const segment = plan.segments[0]
      assert.equal(segment.mode, 'crop')
      const crop = segment.crop
      const cropWidth = Math.max(2, Math.floor(640 * crop.width / 2) * 2)
      const cropHeight = Math.max(2, Math.floor(360 * crop.height / 2) * 2)
      const cropX = Math.max(0, Math.min(640 - cropWidth, Math.round(640 * crop.x)))
      const cropY = Math.max(0, Math.min(360 - cropHeight, Math.round(360 * crop.y)))
      const { width, height } = preset.exportDefaults.proxy
      const output = join(root, `reframe-${format.replace(':', 'x')}.mp4`)
      execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-vf', `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=${width}:${height}:flags=neighbor`,
        '-frames:v', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', output,
      ], { windowsHide: true, timeout: 60_000 })
      const probe = JSON.parse(execFileSync(ffprobePath, [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', output,
      ], { encoding: 'utf8', windowsHide: true }))
      assert.deepEqual([probe.streams[0].width, probe.streams[0].height, Number(probe.streams[0].nb_read_frames)], [width, height, 90])
      const subjectX = Math.max(0, Math.min(width - 2, Math.floor(((0.5 * 640) - cropX) / cropWidth * width / 2) * 2))
      const subjectY = Math.max(0, Math.min(height - 2, Math.floor(((0.32 * 360) - cropY) / cropHeight * height / 2) * 2))
      const pixel = execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', output, '-frames:v', '1',
        '-vf', `crop=2:2:${subjectX}:${subjectY}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { windowsHide: true })
      assert.ok(pixel[0] > pixel[2] * 1.5 + 20, `${format} must preserve the red tracked subject`)
      evidence.push({ format, planHash: plan.planHash, width, height, frames: 90 })
    }
    assert.equal(evidence.length, 5)
    assert.equal(new Set(evidence.map((item) => item.planHash)).size, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
