import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RESPONSIVE_VISUAL_GOLDENS, validateResponsivePlacement } from '../../src/v2/domain/responsive-output.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const colors = { subtitle: 'red', logo: 'green', cta: 'blue', insert: 'yellow' }
const dominantChannel = { subtitle: 0, logo: 1, cta: 2, insert: 0 }

test('T-FR-163 FFmpeg raster goldens materialize 20 format-specific placements inside exact canvases', { timeout: 5 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-responsive-placement-'))
  try {
    for (const golden of RESPONSIVE_VISUAL_GOLDENS) {
      validateResponsivePlacement(golden.placement)
      const placed = golden.placement.elements[0]
      assert.ok(placed, `${golden.id} must have one visible placement`)
      const { width, height } = golden.placement.canvas
      const x = Math.round(placed.x * width)
      const y = Math.round(placed.y * height)
      const boxWidth = Math.max(2, Math.round(placed.width * width))
      const boxHeight = Math.max(2, Math.round(placed.height * height))
      const outputPath = join(root, `${golden.id.replace(':', 'x')}.png`)
      execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=1:d=1`,
        '-vf', `drawbox=x=${x}:y=${y}:w=${boxWidth}:h=${boxHeight}:color=${colors[golden.kind]}:t=fill`,
        '-frames:v', '1', outputPath,
      ], { windowsHide: true })
      const probe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', outputPath], { encoding: 'utf8', windowsHide: true })).streams[0]
      assert.deepEqual([probe.width, probe.height, probe.codec_name], [width, height, 'png'])
      const raw = execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      const pixel = (sampleX, sampleY) => {
        const offset = (sampleY * width + sampleX) * 3
        return [raw[offset], raw[offset + 1], raw[offset + 2]]
      }
      const center = pixel(Math.min(width - 1, x + Math.floor(boxWidth / 2)), Math.min(height - 1, y + Math.floor(boxHeight / 2)))
      if (golden.kind === 'insert') assert.ok(center[0] > 90 && center[1] > 90 && center[2] < 80, `${golden.id} yellow insert pixel`)
      else {
        const dominant = dominantChannel[golden.kind]
        assert.ok(center[dominant] > 90, `${golden.id} dominant pixel`)
      }
      const safeX = Math.max(0, Math.floor(width * 0.01)); const safeY = Math.max(0, Math.floor(height * 0.01))
      assert.ok(pixel(safeX, safeY).every((channel) => channel < 30), `${golden.id} outside pixel remains background`)
      const presetSafe = golden.placement.elements[0]
      assert.ok(presetSafe.x >= 0 && presetSafe.y >= 0 && presetSafe.x + presetSafe.width <= 1 && presetSafe.y + presetSafe.height <= 1)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
