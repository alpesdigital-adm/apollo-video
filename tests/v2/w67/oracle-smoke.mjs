import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BASE, createOracle } from './oracle-config.mjs'

/**
 * Smoke of the real pixel oracle on DEVELOPMENT-split photographs (never calibration or holdout): inference only, no product renderer, no
 * defects. It shows that the bridge starts, both detectors read a frame, and the feature registration recovers a crop+scale made with a
 * plain ffmpeg filter whose parameters this script knows. Its results are not part of the W67 corpus and nothing was tuned from them.
 *
 *   node oracle-smoke.mjs <out-dir>
 */
const require = createRequire(import.meta.url)
const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
const outDirectory = process.argv[2]
if (!outDirectory) throw new Error('usage: oracle-smoke.mjs <out-dir>')
mkdirSync(outDirectory, { recursive: true })
const manifest = JSON.parse(readFileSync(`${BASE}/openimages-w61-v5-manifest.json`, 'utf8'))
const development = manifest.sets.development.selected.filter((item) => item.stratum === 'single').slice(0, 3)
const oracle = await createOracle()
const results = []
for (const item of development) {
  const source = join(outDirectory, `${item.id}-source.png`)
  const output = join(outDirectory, `${item.id}-output.png`)
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', item.mirrorPath, '-frames:v', '1', source], { windowsHide: true })
  const width = item.mirrorWidth, height = item.mirrorHeight
  // a 9:16 window, 60% of the height, at known offsets, scaled to 540x960
  const windowHeight = Math.round(height * 0.6 / 2) * 2, windowWidth = Math.round(windowHeight * 9 / 16 / 2) * 2
  const cropX = Math.round((width - windowWidth) * 0.4), cropY = Math.round((height - windowHeight) * 0.3)
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', item.mirrorPath, '-vf', `crop=${windowWidth}:${windowHeight}:${cropX}:${cropY},scale=540:960:flags=bicubic`, '-frames:v', '1', output], { windowsHide: true })
  const analysis = await oracle.analyze({ framesDirectory: outDirectory, frames: [{ id: 's', file: `${item.id}-source.png` }, { id: 'o', file: `${item.id}-output.png` }], pairs: [{ id: 'p', sourceId: 's', outputId: 'o' }] })
  const scale = 540 / windowWidth
  const expected = [[scale, 0, -cropX * scale], [0, scale, -cropY * scale]]
  const registration = analysis.registrations[0]
  const [sourceFrame, outputFrame] = analysis.frames
  results.push({
    id: item.id, stratum: item.stratum, humanBoxes: item.boxes.length, source: { width, height, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') },
    window: { cropX, cropY, windowWidth, windowHeight }, expectedMatrix: expected,
    registration: { status: registration.status, reason: registration.reason, matches: registration.matches, inliers: registration.inliers, scale: registration.scale, rotationDegrees: registration.rotationDegrees, medianResidualPixels: registration.medianResidualPixels, matrix: registration.matrix },
    matrixError: registration.matrix ? registration.matrix.map((row, r) => row.map((value, c) => Math.abs(value - expected[r][c]))) : null,
    readings: { source: sourceFrame.readings.map((r) => ({ model: r.modelId, status: r.status, boxes: r.boxes.length, tensor: r.rawOutputSha256 })), output: outputFrame.readings.map((r) => ({ model: r.modelId, status: r.status, boxes: r.boxes.length, tensor: r.rawOutputSha256 })) },
    receipt: analysis.receipt,
  })
}
writeFileSync(join(outDirectory, 'smoke.json'), JSON.stringify({ at: new Date().toISOString(), set: 'development (V5 manifest)', results }, null, 2))
for (const entry of results) console.log(JSON.stringify({ id: entry.id, registration: entry.registration.status, inliers: entry.registration.inliers, residual: entry.registration.medianResidualPixels, scale: entry.registration.scale, expectedScale: entry.expectedMatrix[0][0], maxMatrixError: entry.matrixError ? Math.max(...entry.matrixError.flat()) : null, source: entry.readings.source, output: entry.readings.output }))
copyFileSync(import.meta.filename, join(outDirectory, 'oracle-smoke.mjs'))
