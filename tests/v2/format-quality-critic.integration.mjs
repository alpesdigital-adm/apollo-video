import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { critiqueOutputFormat, selectExportableVariants } from '../../src/v2/domain/format-quality-critic.ts'

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe'
const HASH = 'e'.repeat(64)

function run(command, args, encoding = 'utf8') {
  const result = spawnSync(command, args, { encoding, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, `${command} failed: ${String(result.stderr)}`)
  return result.stdout
}
function render(path, width, height, subject, subtitle) {
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=30:d=1`, '-vf', `drawbox=x=${subject.x}:y=${subject.y}:w=${subject.width}:h=${subject.height}:color=green:t=fill,drawbox=x=${subtitle.x}:y=${subtitle.y}:w=${subtitle.width}:h=${subtitle.height}:color=white:t=fill`, '-frames:v', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path])
}
function sample(path, x, y) {
  const bytes = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', path, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], null)
  return [...bytes.subarray(0, 3)]
}
function element(id, type, bounds) {
  return { elementId: id, type, clipId: 'clip-golden-1', sceneId: 'scene-golden-1', sourceId: 'source-golden-1', frame: 15, bounds, zIndex: type === 'subtitle' ? 10 : 1, opacity: 1, priority: 1 }
}

test('T-FR-165 real MP4 golden rejects 9:16 collision and preserves export approval for 16:9', { timeout: 5 * 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-f1032-'))
  try {
    const verticalPath = join(directory, 'vertical.mp4'); const landscapePath = join(directory, 'landscape.mp4')
    const verticalSubject = { x: 135, y: 528, width: 270, height: 288 }; const verticalSubtitle = { x: 45, y: 700, width: 450, height: 170 }
    const landscapeSubject = { x: 336, y: 81, width: 288, height: 189 }; const landscapeSubtitle = { x: 100, y: 410, width: 760, height: 80 }
    render(verticalPath, 540, 960, verticalSubject, verticalSubtitle); render(landscapePath, 960, 540, landscapeSubject, landscapeSubtitle)
    const probe = (path) => JSON.parse(run(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', path])).streams[0]
    assert.deepEqual(probe(verticalPath), { width: 540, height: 960, nb_read_frames: '30' })
    assert.deepEqual(probe(landscapePath), { width: 960, height: 540, nb_read_frames: '30' })
    const verticalCollisionPixel = sample(verticalPath, 270, 750); const verticalFacePixel = sample(verticalPath, 270, 600)
    const landscapeFacePixel = sample(landscapePath, 480, 170); const landscapeSubtitlePixel = sample(landscapePath, 480, 450)
    assert.ok(verticalCollisionPixel.every((channel) => channel > 220), `vertical overlap must visibly carry subtitle: ${verticalCollisionPixel}`)
    assert.ok(verticalFacePixel[1] > 80 && verticalFacePixel[0] < 30, `vertical face evidence must be green: ${verticalFacePixel}`)
    assert.ok(landscapeFacePixel[1] > 80 && landscapeFacePixel[0] < 30, `landscape subject must remain visible: ${landscapeFacePixel}`)
    assert.ok(landscapeSubtitlePixel.every((channel) => channel > 220), `landscape subtitle evidence must be visible: ${landscapeSubtitlePixel}`)
    const vertical = critiqueOutputFormat({ outputSpecId: 'preset-9x16', format: '9:16', proxyHash: HASH, map: { schemaVersion: 'render-element-map/v1', proxyHash: HASH, fps: 30, durationFrames: 30, canvas: { width: 540, height: 960 }, elements: [element('presenter-v', 'presenter', verticalSubject), element('subtitle-v', 'subtitle', verticalSubtitle)] }, subjects: [{ id: 'face-v', startFrame: 0, endFrame: 30, bounds: { x: .25, y: .55, width: .5, height: .3 }, critical: true }] })
    const landscape = critiqueOutputFormat({ outputSpecId: 'preset-16x9', format: '16:9', proxyHash: HASH, map: { schemaVersion: 'render-element-map/v1', proxyHash: HASH, fps: 30, durationFrames: 30, canvas: { width: 960, height: 540 }, elements: [element('presenter-h', 'presenter', landscapeSubject), element('subtitle-h', 'subtitle', landscapeSubtitle)] }, subjects: [{ id: 'face-h', startFrame: 0, endFrame: 30, bounds: { x: .35, y: .15, width: .3, height: .35 }, critical: true }] })
    // Negative pixel evidence: in 16:9 the band under the subject is still black, so no collision exists.
    const landscapeGapPixel = sample(landscapePath, 480, 330)
    assert.ok(landscapeGapPixel.every((channel) => channel < 40), `landscape must keep an empty gap between subject and subtitle: ${landscapeGapPixel}`)
    assert.equal(vertical.status, 'blocked'); assert.equal(landscape.status, 'passed')
    const selection = selectExportableVariants([vertical, landscape])
    assert.deepEqual(selection.approvedOutputSpecIds, ['preset-16x9'])
    assert.deepEqual(selection.blockedOutputSpecIds, ['preset-9x16'])
    const [landscapeDecision, verticalDecision] = selection.decisions
    assert.deepEqual(verticalDecision.blockingCodes, ['SUBTITLE_SUBJECT_COLLISION'])
    assert.deepEqual(landscapeDecision.blockingCodes, [])
    assert.match(verticalDecision.explanation, /Only this output is blocked/)
    assert.match(landscapeDecision.explanation, /passed every format check/)
    // The pixels that carry the vertical collision are exactly the frames the issue points at.
    const collision = vertical.issues.find((issue) => issue.code === 'SUBTITLE_SUBJECT_COLLISION')
    assert.deepEqual(collision.evidenceRange, { startFrame: 15, endFrame: 16 })
    assert.deepEqual(collision.elementIds, ['subtitle-v'])
    assert.ok(collision.evidenceIds.includes('face-v'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
