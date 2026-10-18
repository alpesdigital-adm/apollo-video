import assert from 'node:assert/strict'
import test from 'node:test'

import { planRequiredSourceWindows, projectTimelineSpansToSource } from '../../src/v2/domain/face-evidence-time-map.ts'

/**
 * W65b: a cue lives on the timeline; face evidence lives in the frames of the source. The projection through the clips of the EditPlan
 * (any Director cut: several clips, trims, reorders) tells which SOURCE frames a cue shows - and which windows of the source would
 * let the cue be certified.
 */
const clip = (id, sourceArtifactId, sourceIn, sourceOut, timelineIn, timelineOut, rate = 1) =>
  ({ id, sourceArtifactId, sourceInFrame: sourceIn, sourceOutFrame: sourceOut, timelineInFrame: timelineIn, timelineOutFrame: timelineOut, rate })
const FPS = { num: 30, den: 1 }

test('a span is translated through the clip it falls in: a trimmed clip starts later in the source', () => {
  const trimmed = [clip('c1', 's1', 50, 150, 0, 100)]
  assert.deepEqual(projectTimelineSpansToSource(trimmed, 's1', [{ startFrame: 10, endFrame: 40 }]), [{ startFrame: 60, endFrame: 90 }])
  assert.deepEqual(projectTimelineSpansToSource(trimmed, 's1', [{ startFrame: 0, endFrame: 100 }]), [{ startFrame: 50, endFrame: 150 }])
})

test('a span across a cut becomes two source spans that are NOT adjacent; clips can reorder the source', () => {
  const cut = [clip('c1', 's1', 150, 250, 0, 100), clip('c2', 's1', 20, 120, 100, 200)]
  assert.deepEqual(projectTimelineSpansToSource(cut, 's1', [{ startFrame: 90, endFrame: 110 }]), [
    { startFrame: 240, endFrame: 250 }, { startFrame: 20, endFrame: 30 },
  ])
  assert.deepEqual(projectTimelineSpansToSource(cut, 's1', [{ startFrame: 120, endFrame: 140 }]), [{ startFrame: 40, endFrame: 60 }],
    'the cue at timeline 120-140 shows source 40-60, not source 120-140')
})

test('only unit-rate, length-consistent clips of THAT source map; a span outside every clip maps to nothing', () => {
  const clips = [
    clip('c1', 's1', 0, 100, 0, 100),
    clip('c2', 's2', 0, 100, 100, 200),
    clip('c3', 's1', 0, 50, 200, 300, 2),          // a speed change: no pure offset
    clip('c4', 's1', 0, 90, 300, 400),             // source and timeline lengths differ
  ]
  assert.deepEqual(projectTimelineSpansToSource(clips, 's1', [{ startFrame: 0, endFrame: 400 }]), [{ startFrame: 0, endFrame: 100 }])
  assert.deepEqual(projectTimelineSpansToSource(clips, 's2', [{ startFrame: 0, endFrame: 400 }]), [{ startFrame: 0, endFrame: 100 }])
  assert.deepEqual(projectTimelineSpansToSource(clips, 's1', [{ startFrame: 500, endFrame: 600 }]), [])
  assert.deepEqual(projectTimelineSpansToSource(clips, 's3', [{ startFrame: 0, endFrame: 400 }]), [])
  assert.deepEqual(projectTimelineSpansToSource([], 's1', [{ startFrame: 0, endFrame: 10 }]), [])
})

test('the required windows are in SOURCE frames: widened by the sample gap, merged, cut at 300 frames, bounded by the source', () => {
  const windows = (spans, durationFrames = 1000) => planRequiredSourceWindows({ sourceDurationFrames: durationFrames, fps: FPS, spans })
  assert.deepEqual(windows([{ startFrame: 240, endFrame: 250 }, { startFrame: 20, endFrame: 30 }]), [
    { startSourceFrame: 5, endSourceFrame: 45 }, { startSourceFrame: 225, endSourceFrame: 265 },
  ])
  assert.deepEqual(windows([{ startFrame: 100, endFrame: 130 }, { startFrame: 140, endFrame: 170 }]), [{ startSourceFrame: 85, endSourceFrame: 185 }], 'close spans share a window')
  assert.deepEqual(windows([{ startFrame: 0, endFrame: 30 }]), [{ startSourceFrame: 0, endSourceFrame: 45 }], 'clamped at the source start')
  assert.deepEqual(windows([{ startFrame: 270, endFrame: 300 }], 300), [{ startSourceFrame: 255, endSourceFrame: 300 }], 'clamped at the source end')
  const long = windows([{ startFrame: 0, endFrame: 900 }], 1200)
  assert.deepEqual(long.map((window) => [window.startSourceFrame, window.endSourceFrame]), [[0, 300], [300, 600], [600, 900], [900, 915]])
  assert.deepEqual(windows([]), [])
})
