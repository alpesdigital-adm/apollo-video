import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  FfmpegEditorialProxyRenderer,
  assertClipRate,
  atempoFactors,
  mapTimelineRangeToSourceFrames,
} from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { MAX_PARTIAL_RENDER_RANGES } from '../../src/v2/application/ports/project-proxy-render-repository.ts'

// Every assertion below is reached before the renderer touches the filesystem or
// spawns FFmpeg: input validation, clip timing and range canonicality all run
// ahead of `mkdir`. Visual proof of the accepted cases lives in the real-FFmpeg
// goldens in ffmpeg-editorial-proxy-renderer.integration.mjs.
const renderer = new FfmpegEditorialProxyRenderer({
  workRoot: join(tmpdir(), 'apollo-rate-range-validation'),
  ffmpegPath: 'ffmpeg',
})

const sourcePath = resolve(join(tmpdir(), 'apollo-rate-range-validation', 'never-read.mp4'))

function clip(overrides = {}) {
  return {
    id: 'clip-1',
    sourceArtifactId: 'artifact-master',
    sourceInFrame: 0,
    sourceOutFrame: 90,
    timelineInFrame: 0,
    timelineOutFrame: 90,
    rate: 1,
    ...overrides,
  }
}

function renderInput(overrides = {}) {
  return {
    operationId: 'rate-range-validation',
    renderKind: 'proxy',
    sources: [{
      artifactId: 'artifact-master',
      path: sourcePath,
      mediaType: 'video',
      colorPipelineCompilation: { id: 'compilation-stub' },
    }],
    lutPaths: {},
    clips: [clip()],
    fps: 30,
    format: '16:9',
    ...overrides,
  }
}

function rejects(input, matcher) {
  return assert.rejects(() => renderer.render(input), (error) => {
    assert.equal(error.code, 'INVALID_RENDER_INPUT', `expected INVALID_RENDER_INPUT, got ${error.code}: ${error.message}`)
    assert.match(error.message, matcher)
    return true
  })
}

function rangeReuse(ranges) {
  return {
    schemaVersion: 'project-proxy-range-reuse/v1',
    commandId: 'manual-command-validation',
    impactHash: 'a'.repeat(64),
    baseVersionId: 'project-version-validation',
    ranges,
    artifactId: 'artifact-base-proxy',
    manifestId: 'manifest-base-proxy',
    path: sourcePath,
    sha256: 'b'.repeat(64),
    byteSize: 1024,
  }
}

test('T-FR-233 renderer accepts retimed clips inside [0.25, 4] and fails closed outside it', () => {
  for (const rate of [0.25, 0.5, 1, 1.25, 2, 3, 4]) {
    assert.equal(assertClipRate(rate), rate, `rate ${rate} must be accepted`)
  }
  const rejected = [
    [Number.NaN, /finite number/],
    [Number.POSITIVE_INFINITY, /finite number/],
    [0, /greater than zero/],
    [-1, /greater than zero/],
    [-0.5, /reverse playback is not supported/],
    [0.2, /outside the supported range/],
    [5, /outside the supported range/],
    [0.24, /outside the supported range/],
    [4.01, /outside the supported range/],
  ]
  for (const [rate, matcher] of rejected) {
    assert.throws(() => assertClipRate(rate), (error) => {
      assert.equal(error.code, 'INVALID_RENDER_INPUT')
      assert.match(error.message, matcher)
      return true
    }, `rate ${rate} must be rejected`)
  }
})

test('T-FR-233 renderer rejects a rate the render input cannot prove', async () => {
  await rejects(renderInput({ clips: [clip({ rate: 0 })] }), /greater than zero/)
  await rejects(renderInput({ clips: [clip({ rate: -2, timelineOutFrame: 90 })] }), /reverse playback is not supported/)
  await rejects(renderInput({ clips: [clip({ rate: Number.NaN })] }), /finite number/)
  await rejects(renderInput({ clips: [clip({ rate: 8, timelineOutFrame: 11 })] }), /outside the supported range/)
  await rejects(renderInput({ clips: [clip({ rate: 0.1, timelineOutFrame: 900 })] }), /outside the supported range/)
})

test('T-FR-233 renderer enforces the frame-first rate invariant per clip', async () => {
  // rate 2 over 90 source frames must occupy exactly 45 timeline frames.
  await rejects(
    renderInput({ clips: [clip({ rate: 2, timelineOutFrame: 44 })] }),
    /timeline span 44 does not match its 90 source frames at rate 2/,
  )
  await rejects(
    renderInput({ clips: [clip({ rate: 0.5, timelineOutFrame: 90 })] }),
    /timeline span 90 does not match its 90 source frames at rate 0\.5/,
  )
  // Empty spans are refused before any rate arithmetic.
  await rejects(
    renderInput({ clips: [clip({ sourceOutFrame: 0 })] }),
    /Editorial clip frame range is invalid/,
  )
  await rejects(
    renderInput({ clips: [clip({ sourceInFrame: 1.5, sourceOutFrame: 90.5 })] }),
    /Editorial clip frame range is invalid/,
  )
})

test('T-FR-233 atempo decomposes any supported rate into factors FFmpeg accepts', () => {
  const cases = [[0.25, [0.5, 0.5]], [0.5, [0.5]], [1.25, [1.25]], [2, [2]], [3, [2, 1.5]], [4, [2, 2]]]
  for (const [rate, expected] of cases) {
    assert.deepEqual(atempoFactors(rate), expected, `rate ${rate}`)
  }
  for (const rate of [0.25, 0.4, 0.5, 0.75, 1.25, 1.5, 2, 2.5, 3, 3.75, 4]) {
    const factors = atempoFactors(rate)
    assert.ok(factors.length >= 1 && factors.length <= 2, `rate ${rate} needs at most two atempo stages`)
    assert.ok(
      factors.every((factor) => factor >= 0.5 && factor <= 2),
      `rate ${rate} produced a factor outside the atempo window: ${factors}`,
    )
    const product = factors.reduce((total, factor) => total * factor, 1)
    assert.ok(Math.abs(product - rate) < 1e-9, `rate ${rate} product drifted to ${product}`)
  }
})

test('T-FR-233 fractional-rate range mapping rounds absolute boundaries without accumulated drift', () => {
  assert.deepEqual(mapTimelineRangeToSourceFrames({
    sourceInFrame: 0, sourceOutFrame: 9, timelineInFrame: 0, timelineOutFrame: 6,
    overlapStartFrame: 1, overlapEndFrame: 2, rate: 1.5,
  }), { sourceInFrame: 2, sourceOutFrame: 3 })
  assert.deepEqual(mapTimelineRangeToSourceFrames({
    sourceInFrame: 30, sourceOutFrame: 120, timelineInFrame: 10, timelineOutFrame: 55,
    overlapStartFrame: 20, overlapEndFrame: 40, rate: 2,
  }), { sourceInFrame: 50, sourceOutFrame: 90 })
  assert.throws(() => mapTimelineRangeToSourceFrames({
    sourceInFrame: 0, sourceOutFrame: 45, timelineInFrame: 0, timelineOutFrame: 90,
    overlapStartFrame: 1, overlapEndFrame: 2, rate: 0.5,
  }), /cannot be represented by whole source frames/)
})

test('T-FR-233 renderer accepts several disjoint stale ranges and refuses non-canonical sets', async () => {
  // Canonical: ordered, strictly disjoint, inside the timeline, not covering it.
  const canonical = [{ startFrame: 10, endFrame: 20 }, { startFrame: 40, endFrame: 50 }]
  await assert.rejects(
    () => renderer.render(renderInput({ rangeReuse: rangeReuse(canonical) })),
    // Passes every range gate, then fails later on the unreadable stub source.
    (error) => error.code !== 'INVALID_RENDER_INPUT' || !/Partial proxy range/.test(error.message),
  )

  await rejects(renderInput({ rangeReuse: rangeReuse([]) }), /at least one stale range/)
  await rejects(
    renderInput({
      rangeReuse: rangeReuse(
        Array.from({ length: MAX_PARTIAL_RENDER_RANGES + 1 }, (_, index) => ({
          startFrame: index * 4, endFrame: index * 4 + 2,
        })),
      ),
    }),
    new RegExp(`at most ${MAX_PARTIAL_RENDER_RANGES} stale ranges`),
  )
  // Touching ranges are fused by the domain, so the renderer must never see them.
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 10, endFrame: 20 }, { startFrame: 20, endFrame: 30 }]) }),
    /range 1 is not ordered strictly after its predecessor/,
  )
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 10, endFrame: 25 }, { startFrame: 20, endFrame: 30 }]) }),
    /range 1 is not ordered strictly after its predecessor/,
  )
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 40, endFrame: 50 }, { startFrame: 10, endFrame: 20 }]) }),
    /range 1 is not ordered strictly after its predecessor/,
  )
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 10, endFrame: 20 }, { startFrame: 10, endFrame: 20 }]) }),
    /range 1 is not ordered strictly after its predecessor/,
  )
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 10, endFrame: 200 }]) }),
    /range 0 is invalid/,
  )
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: -1, endFrame: 20 }]) }),
    /range 0 is invalid/,
  )
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 20, endFrame: 20 }]) }),
    /range 0 is invalid/,
  )
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 0.5, endFrame: 20 }]) }),
    /range 0 is invalid/,
  )
  // Whole-timeline coverage has nothing to reuse. Strict disjointness means only
  // a single [0, end] range can ever reach this gate: two or more ranges always
  // leave at least one reusable frame between them.
  await rejects(
    renderInput({ rangeReuse: rangeReuse([{ startFrame: 0, endFrame: 90 }]) }),
    /cover the whole timeline/,
  )
  const twoRanges = [{ startFrame: 0, endFrame: 45 }, { startFrame: 46, endFrame: 90 }]
  const staleFrames = twoRanges.reduce((total, item) => total + item.endFrame - item.startFrame, 0)
  assert.equal(staleFrames, 89, 'two disjoint ranges must leave at least one reusable frame')
})

test('T-FR-233 the full timeline length is measured on the timeline, not on source spans', async () => {
  // A rate-2 clip spends 90 source frames in 45 timeline frames, so frame 60
  // is past the end of the timeline even though the source reaches frame 90.
  await rejects(
    renderInput({
      clips: [clip({ rate: 2, timelineOutFrame: 45 })],
      rangeReuse: rangeReuse([{ startFrame: 50, endFrame: 60 }]),
    }),
    /range 0 is invalid/,
  )
})
