import assert from 'node:assert/strict'
import test from 'node:test'

import { REFRAME_COMPOSITION_ID } from '../../src/v2/domain/render-reframe-plan.ts'
import { buildRenderElementMap } from '../../src/v2/domain/review-system.ts'
import { buildEditorialCompositionPrefix } from '../../src/v2/infrastructure/media/ffmpeg-editorial-composition-graph.ts'

/**
 * W66r: a reframed range FILLS the variant canvas. The crop window is scaled by the cover factor and centred; nothing is staged, padded or
 * blurred behind it. A clip that is not reframed keeps the composition it always had (staging frame, then a foreground over a blurred copy),
 * and a render with no reframed clip keeps the historical graph verbatim. The same rule is mirrored by the caption projection
 * (caption-canvas-projection.test.mjs) and by the render element map (below), so placement, review and render agree.
 */
const clipOf = (id, from, to) => ({ id, sourceArtifactId: 's', sourceInFrame: from, sourceOutFrame: to, timelineInFrame: from, timelineOutFrame: to, rate: 1 })
const CLIPS = [clipOf('a', 0, 30), clipOf('b', 30, 60)]
const rangeOf = (clipId, from, to) => ({
  clipId, startFrame: from, endFrame: to, interpolation: 'linear', source: 'plan', keyframes: [{ frame: from, crop: { x: 0.1, y: 0, width: 0.31640625, height: 1 } }],
})
const prepared = (reframeRangeByClipId) => ({
  clips: CLIPS, transitions: [], fps: 30, outputFps: 30, width: 540, height: 960, stagingWidth: 1280, stagingHeight: 720,
  renderSources: [{ artifactId: 's', path: 'x.mp4', mediaType: 'video' }], sourceIndex: { s: 0 }, clipVideoIndex: { a: 0, b: 0 },
  videoProbeByArtifactId: { s: { width: 1280, height: 720 } }, reframeRangeByClipId, backgroundMusic: null,
  compositionLayout: { foregroundScale: 1, verticalPosition: 0.5 }, placementPlan: null, placementInputs: [], assetInputIndexByElementId: {},
})
const STAGED = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,'
const COVER = 'scale=540:960:force_original_aspect_ratio=increase,crop=540:960,'
const TAIL = 'fps=30,setsar=1,format=yuv420p'

test('W66r a render with no reframed clip keeps the historical graph verbatim', () => {
  const { filters, videoLabel } = buildEditorialCompositionPrefix(prepared({}))
  assert.deepEqual([...filters], [
    `[1:v:0]trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS,${STAGED}${TAIL}[v0]`,
    '[0:a:0]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0]',
    `[2:v:0]trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS,${STAGED}${TAIL}[v1]`,
    '[0:a:0]atrim=start=1.000000:end=2.000000,asetpts=PTS-STARTPTS[a1]',
    '[v0][a0][v1][a1]concat=n=2:v=1:a=1[joinedv][joineda]',
    '[joineda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]',
    '[joinedv]split=2[background0][foreground0]',
    '[background0]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,gblur=sigma=28[background]',
    '[foreground0]scale=540:960:force_original_aspect_ratio=decrease,scale=iw*1.0000:ih*1.0000[foreground]',
    '[background][foreground]overlay=(W-w)/2:max(0\\,min(H-h\\,H*0.5000-h/2)):shortest=1,format=yuv420p[composed]',
  ])
  assert.equal(videoLabel, 'composed')
})

test('W66r a reframed clip is cropped, then scaled to cover the canvas and centred: no staging, no pad, no blurred backdrop', () => {
  const { filters } = buildEditorialCompositionPrefix(prepared({ a: rangeOf('a', 0, 30), b: rangeOf('b', 30, 60) }))
  const video = filters.filter((line) => line.includes(':v:0]'))
  assert.equal(video.length, 2)
  for (const line of video) {
    assert.match(line, /crop=404:720:\d+:0,scale=540:960:force_original_aspect_ratio=increase,crop=540:960,fps=30,setsar=1,format=yuv420p\[v\d\]$/)
    assert.doesNotMatch(line, /pad=|decrease/)
  }
  assert.ok(!filters.some((line) => line.includes('gblur') || line.includes('overlay=') || line.includes('split=')), 'nothing is laid over a backdrop')
  assert.ok(filters.includes('[v0][a0][v1][a1]concat=n=2:v=1:a=1[joinedv][joineda]'))
  assert.equal(filters.at(-1), '[joinedv]null[composed]', 'the join is already canvas-sized and is the composed frame')
})

test('W66r with a reframed clip, the clips that are not reframed keep their staging and blurred-backdrop composition, one clip at a time', () => {
  const { filters } = buildEditorialCompositionPrefix(prepared({ a: rangeOf('a', 0, 30) }))
  const historic = buildEditorialCompositionPrefix(prepared({})).filters
  // clip a: the cover fit; clip b: staged exactly as before, then composed over its own blurred copy, then joined
  assert.ok(filters.includes(`[1:v:0]trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS,crop=404:720:128:0,${COVER}${TAIL}[v0]`))
  assert.ok(filters.includes(`[2:v:0]trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS,${STAGED}${TAIL}[staged1]`))
  const relabel = (line, tag) => line.replaceAll('background0', `background0${tag}`).replaceAll('foreground0', `foreground0${tag}`)
    .replaceAll('[background]', `[background${tag}]`).replaceAll('[foreground]', `[foreground${tag}]`).replace('[joinedv]', '[staged1]').replace('[composed]', `[v${tag}]`)
  const historicComposition = historic.slice(historic.indexOf('[joinedv]split=2[background0][foreground0]'))
  for (const line of historicComposition) assert.ok(filters.includes(relabel(line, '1')), `the unreframed clip keeps: ${line}`)
  assert.equal(filters.at(-1), '[joinedv]null[composed]')
  // a plan whose ranges are all fallbacks reframes nothing: the empty map is the historical graph (see the first test)
  assert.deepEqual([...buildEditorialCompositionPrefix(prepared({})).filters], [...historic])
})

test('W66r the render element map says a reframed clip is the whole canvas, and describes no backdrop behind it', () => {
  const base = { proxyHash: 'a'.repeat(64), fps: 30, durationFrames: 60, canvas: { width: 540, height: 960 }, source: { width: 1280, height: 720 } }
  const map = buildRenderElementMap({ ...base, clips: [{ ...CLIPS[0], reframed: true }, CLIPS[1]] })
  const ofClip = (clipId) => map.elements.filter((element) => element.clipId === clipId)
  const first = ofClip('a')
  assert.deepEqual([...new Set(first.map((element) => element.type))], ['presenter'], 'no background element behind a picture that is the whole canvas')
  assert.ok(first.every((element) => element.bounds.x === 0 && element.bounds.y === 0 && element.bounds.width === 540 && element.bounds.height === 960))
  const second = ofClip('b')
  assert.deepEqual([...new Set(second.map((element) => element.type))].toSorted(), ['background', 'presenter'])
  const band = second.find((element) => element.type === 'presenter').bounds
  assert.deepEqual([band.x, band.width], [0, 540])
  assert.ok(band.y > 300 && band.y < 340 && band.height > 295 && band.height < 310, `today's band: ${JSON.stringify(band)}`)
  // nothing reframed: the map is what it always was
  const plain = buildRenderElementMap({ ...base, clips: CLIPS })
  assert.equal(plain.elements.length, 60 * 2, "a background and a presenter per frame of the 60 frames")
  assert.equal(REFRAME_COMPOSITION_ID, 'reframe-fills-canvas/v1')
})
