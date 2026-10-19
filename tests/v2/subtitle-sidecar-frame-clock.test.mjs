import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRenderElementMap } from '../../src/v2/domain/review-system.ts'
import {
  assertRenderedSubtitleCues,
  collectRenderedSubtitleCues,
  encodeSubtitleSidecar,
  parseSubtitleSidecar,
  subtitleSidecarFrameToMs,
  SUBTITLE_SIDECAR_RECIPE_VERSION,
} from '../../src/v2/domain/subtitle-sidecar.ts'

// Independent player model. A player shows a cue at media time t iff start <= t < end and presents frame k at
// exactly k / fps. With the rate scaled to whole microhertz everything below is exact integer arithmetic:
//   start_ms / 1000 <= k / fps  <=>  start_ms * microFps <= k * 1e9
const microHertz = (fps) => BigInt(Math.round(fps * 1_000_000))
const shown = (frame, startMs, endMs, fps) =>
  BigInt(startMs) * microHertz(fps) <= BigInt(frame) * 1_000_000_000n && BigInt(frame) * 1_000_000_000n < BigInt(endMs) * microHertz(fps)
const framesShown = (frames, startMs, endMs, fps) => Array.from({ length: frames }, (_unused, frame) => frame).filter((frame) => shown(frame, startMs, endMs, fps))
const legacyRound = (frame, fps) => Math.round((frame * 1000) / fps)

const RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 120]
const FRAMES = 96

test('sidecar boundaries cover exactly the frames of the cue for a player that compares presentation times', () => {
  for (const fps of RATES) {
    for (let start = 0; start < FRAMES; start += 1) for (let end = start + 1; end <= FRAMES; end += 1) {
      const startMs = subtitleSidecarFrameToMs(start, fps), endMs = subtitleSidecarFrameToMs(end, fps)
      assert.ok(endMs > startMs, `${fps} fps [${start},${end}) collapsed`)
      assert.deepEqual(framesShown(FRAMES + 1, startMs, endMs, fps),
        Array.from({ length: end - start }, (_unused, offset) => start + offset), `${fps} fps [${start},${end}) -> [${startMs},${endMs}) ms`)
    }
  }
})

test('the nearest-millisecond rule it replaces started cues after their own first frame', () => {
  // 30 fps frame 2 is presented at 66.67 ms; the old rule wrote 67 ms, so frame 2 was shown without its cue.
  assert.equal(legacyRound(2, 30), 67)
  // ...and the end 167 ms kept frame 5 (166.67 ms) inside the cue as well: late by one frame at both ends.
  assert.deepEqual(framesShown(10, legacyRound(2, 30), legacyRound(5, 30), 30), [3, 4, 5])
  assert.equal(subtitleSidecarFrameToMs(2, 30), 66)
  assert.deepEqual(framesShown(10, subtitleSidecarFrameToMs(2, 30), subtitleSidecarFrameToMs(5, 30), 30), [2, 3, 4])
  // Over a whole second the old rule misplaced a third of the 30 fps starts.
  const misplaced = Array.from({ length: 30 }, (_unused, frame) => frame)
    .filter((frame) => !shown(frame, legacyRound(frame, 30), legacyRound(frame + 1, 30), 30))
  assert.equal(misplaced.length, 10)
  for (const frame of Array.from({ length: 30 }, (_unused, index) => index)) {
    assert.ok(shown(frame, subtitleSidecarFrameToMs(frame, 30), subtitleSidecarFrameToMs(frame + 1, 30), 30), `frame ${frame}`)
  }
})

test('adjacent cues share their boundary millisecond: no gap and no overlap in the shown frames', () => {
  for (const fps of RATES) {
    for (const [a, b, c] of [[0, 1, 2], [1, 7, 8], [10, 33, 71], [FRAMES - 2, FRAMES - 1, FRAMES]]) {
      const first = [subtitleSidecarFrameToMs(a, fps), subtitleSidecarFrameToMs(b, fps)]
      const next = [subtitleSidecarFrameToMs(b, fps), subtitleSidecarFrameToMs(c, fps)]
      assert.equal(first[1], next[0])
      assert.deepEqual([...framesShown(FRAMES + 1, ...first, fps), ...framesShown(FRAMES + 1, ...next, fps)],
        Array.from({ length: c - a }, (_unused, offset) => a + offset), `${fps} fps ${a}/${b}/${c}`)
    }
  }
})

test('exact frame times are exact: whole-millisecond frames do not fall below their own millisecond', () => {
  // 100 fps frame 803 is exactly 8030 ms; an inexact floating-point division could give 8029.999 and floor to 8029.
  assert.equal(subtitleSidecarFrameToMs(803, 100), 8030)
  assert.equal(subtitleSidecarFrameToMs(111, 30), 3700)
  assert.equal(subtitleSidecarFrameToMs(6, 60), 100)
  for (const fps of [25, 30, 50, 60, 100]) for (let frame = 0; frame < 20000; frame += 1) {
    const exact = (BigInt(frame) * 1000n) / BigInt(fps)
    assert.equal(BigInt(subtitleSidecarFrameToMs(frame, fps)), exact, `${frame}@${fps}`)
  }
  assert.throws(() => subtitleSidecarFrameToMs(-1, 30), /non-negative/)
  assert.throws(() => subtitleSidecarFrameToMs(1.5, 30), /non-negative/)
  assert.throws(() => subtitleSidecarFrameToMs(1, 0), /positive fps/)
  assert.throws(() => subtitleSidecarFrameToMs(1, Number.NaN), /positive fps/)
  assert.throws(() => subtitleSidecarFrameToMs(1, 1e-9), /below one microhertz/)
})

test('a rate that cannot separate consecutive frames in milliseconds refuses the cue instead of publishing a wrong one', () => {
  const map = buildRenderElementMap({
    proxyHash: 'a'.repeat(64), fps: 2000, durationFrames: 4000,
    canvas: { width: 1080, height: 1920 }, source: { width: 1920, height: 1080 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 4000 }],
    subtitleCues: [{ id: 'cue-1', startFrame: 0, endFrame: 1, text: 'Ação' }],
  })
  assert.throws(() => collectRenderedSubtitleCues({ map, texts: { 'cue-1': 'Ação' } }), /range is not positive/)
  assert.throws(() => assertRenderedSubtitleCues([{ cueId: 'cue-1', startFrame: 0, endFrame: 1, startMs: 0, endMs: 0, text: 'Ação' }]), /range is not positive/)
})

test('cue boundaries survive the encoders: parsed SRT and VTT show the same frames as the rendered alignment', () => {
  const fps = 30
  const map = buildRenderElementMap({
    proxyHash: 'a'.repeat(64), fps, durationFrames: 120,
    canvas: { width: 1080, height: 1920 }, source: { width: 1920, height: 1080 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 120 }],
    subtitleCues: [{ id: 'cue-1', startFrame: 2, endFrame: 5, text: 'Ação' }, { id: 'cue-2', startFrame: 5, endFrame: 119, text: 'Última cue.' }],
  })
  const cues = collectRenderedSubtitleCues({ map, texts: { 'cue-1': 'Ação', 'cue-2': 'Última cue.' } })
  assert.deepEqual(cues.map((cue) => [cue.startMs, cue.endMs]), [[66, 166], [166, 3966]])
  for (const format of ['srt', 'vtt']) {
    const parsed = parseSubtitleSidecar(encodeSubtitleSidecar({ cues, format, locale: 'pt-BR', durationMs: subtitleSidecarFrameToMs(120, fps) }).bytes, format)
    assert.deepEqual(parsed.map((cue) => framesShown(120, cue.startMs, cue.endMs, fps)),
      [[2, 3, 4], Array.from({ length: 114 }, (_unused, offset) => 5 + offset)], format)
  }
  assert.equal(SUBTITLE_SIDECAR_RECIPE_VERSION, '1.2.0')
})
