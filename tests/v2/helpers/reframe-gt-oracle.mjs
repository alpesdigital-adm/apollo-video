// W66r ground-truth (GT) machinery for the frame-by-frame proof of the reframe trajectory on a RENDERED mp4.
//
// What is real and what is a stand-in:
// - The GT generator below decides, for every source frame, where each subject is. It DRAWS those subjects into the source video and, for
//   the same frames, produces the detector rows the product writers consume. The "detector" is therefore a STAND-IN: its boxes are the
//   generator's boxes, not the output of a model. Nothing here says anything about a real detector on real video.
// - Everything downstream of the rows is the product: raw tensor -> V9 decoder -> sealed envelope -> source evidence stream -> ROI ->
//   policy-sealed plan -> keyframed render plan -> FFmpeg graph -> encoded mp4.
//
// What the oracle expects, and where that expectation comes from:
// - The expectation comes from the SPECIFICATION of a reframe, never from the layout a renderer happens to produce: a range the plan reframes
//   (`plan` or `manual`) shows the crop window FILLING the variant canvas (a cover fit: no letterbox band, no blurred backdrop); an unreframed
//   range (`fallback`) shows the whole source frame. The measurements read the DECODED pixels and know nothing about the composition: a render
//   that lays the crop out some other way is reported as a mismatch, it is not accommodated here.
// - Every measurement is made in OUTPUT frame coordinates: where the sharp picture is (a texture that a blurred backdrop cannot reproduce),
//   how much of the canvas it covers, where the subjects are, and - through fiducials whose gaps are irregular, so that any four of them name
//   themselves - which part of the source the picture shows.
//
// This module is pure (no FFmpeg, no PG), so its arithmetic is unit-tested without a render (`reframe-gt-oracle.test.mjs`).

export const W = 1280
export const H = 720
export const FPS = 30

/** Checker texture of the background: fine enough that every 8 px block of a filled canvas holds an edge, and lost by any blur. */
export const TEXTURE_CELL = 10
export const TEXTURE_LOW = [28, 28, 28]
export const TEXTURE_HIGH = [52, 52, 52]
/**
 * White vertical fiducials at known source columns. The gaps are irregular and all different, so the pattern of any few consecutive stripes
 * identifies which stripes they are without being told where the picture is (the measurement needs no layout hint).
 */
// (Found by a search over random gap sequences for one whose alignments are never ambiguous at the three scales the renders use, with up to
// 1 canvas px of noise on the stripe centres; see the fiducial test.)
const MARKER_GAPS = [86, 50, 98, 87, 33, 87, 45, 44, 31, 64, 46, 41, 47, 76, 78, 95, 65, 52, 41]
export const MARKER_CENTERS = Object.freeze(MARKER_GAPS.reduce((centers, gap) => [...centers, centers.at(-1) + gap], [24]))
export const MARKER_HALF_WIDTH = 4
export const SUBJECT_COLORS = Object.freeze({ A: [230, 30, 30], B: [30, 200, 30], screen: [0, 220, 220] })

/** Tolerances. Named so the evidence can quote them. Source pixels unless said otherwise. */
export const TOLERANCE = Object.freeze({
  /** The even-pixel crop quantization (<= 2 px) plus the sub-pixel blur of scaling and encoding. */
  window: 3,
  /** Where a decoded subject may sit against where the generator put it. */
  position: 6,
  /** CANVAS pixels: where a decoded subject sits on the output frame against where the specification puts it. */
  outputPosition: 8,
  /** Share of the canvas width and of the canvas height that a reframed range's sharp picture must cover. */
  coverage: 0.98,
  /** Relative: the scale of the picture on the canvas against the cover scale of the crop. */
  scale: 0.02,
})

const face = (x, y = 0.2) => [x, y, x + 0.1, y + 0.3]
export const faceBox = face

/**
 * The scenes. `subjectsAtSource(sourceFrame)` is the GT: every subject with its box (normalized x1, y1, x2, y2) and the colour it is drawn in.
 * `kind: 'face'` subjects are what the stand-in detector reports; `kind: 'screen'` is a subject no verified detector exists for.
 */
export const SCENES = Object.freeze({
  'one-person': {
    sourceFrames: 150, clips: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150 }],
    subjectsAtSource: (frame) => [{ id: 'A', kind: 'face', color: 'A', box: face(0.2 + 0.06 * frame / 30) }],
  },
  'moving-subject': {
    sourceFrames: 150, clips: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150 }],
    subjectsAtSource: (frame) => [{ id: 'A', kind: 'face', color: 'A', box: face(0.1 + 0.2 * Math.min(frame, 60) / 30) }],
  },
  // Right at 0.2 per second for two seconds, back at the same speed for two seconds: the crop must reverse without leaving the subject.
  'subject-reverses': {
    sourceFrames: 150, clips: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150 }],
    subjectsAtSource: (frame) => [{ id: 'A', kind: 'face', color: 'A', box: face(0.15 + 0.2 * (frame < 60 ? frame : Math.max(0, 120 - frame)) / 30) }],
  },
  'two-people-far-apart': {
    sourceFrames: 150, clips: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150 }],
    subjectsAtSource: () => [{ id: 'A', kind: 'face', color: 'A', box: face(0.05) }, { id: 'B', kind: 'face', color: 'B', box: face(0.85) }],
  },
  'screen-only': {
    sourceFrames: 150, clips: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150 }],
    subjectsAtSource: () => [{ id: 'screen', kind: 'screen', color: 'screen', box: [0.3, 0.2, 0.7, 0.7] }],
  },
  'subject-too-fast': {
    sourceFrames: 150, clips: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150 }],
    subjectsAtSource: (frame) => [{ id: 'A', kind: 'face', color: 'A', box: face(0.05 + 0.5 * Math.min(frame, 48) / 30) }],
  },
  // One timeline, two kinds of clip: clip A has one person (the plan reframes it: the crop fills the canvas) and clip B plays the frames where
  // two people stand too far apart for any crop (the plan leaves it unreframed: it keeps the composition it always had, the whole frame in its
  // band). Clip B's source frames [100, 175) are those of the 'two-people-far-apart' scene, so the same pixels can be rendered on their own.
  'reframed-then-whole': {
    sourceFrames: 200, clips: [
      { clipId: 'clip-a', sourceInFrame: 0, sourceOutFrame: 75, timelineInFrame: 0, timelineOutFrame: 75 },
      { clipId: 'clip-b', sourceInFrame: 100, sourceOutFrame: 175, timelineInFrame: 75, timelineOutFrame: 150 },
    ],
    subjectsAtSource: (frame) => (frame < 75
      ? [{ id: 'A', kind: 'face', color: 'A', box: face(0.3) }]
      : frame < 100 ? [{ id: 'A', kind: 'face', color: 'A', box: face(0.46) }]
        : [{ id: 'A', kind: 'face', color: 'A', box: face(0.05) }, { id: 'B', kind: 'face', color: 'B', box: face(0.85) }]),
  },
  // The subject is at the far left of source frames [0, 75) (clip A), in the middle of [75, 100) (trimmed away) and at the far right of
  // [100, 175) (clip B): the cut jumps across the frame, and the trimmed frames hold a third position that interpolating across the cut
  // would drag into the plan (the sample after clip A's last one is not clip A's).
  'cut-between-clips': {
    sourceFrames: 200, clips: [
      { clipId: 'clip-a', sourceInFrame: 0, sourceOutFrame: 75, timelineInFrame: 0, timelineOutFrame: 75 },
      { clipId: 'clip-b', sourceInFrame: 100, sourceOutFrame: 175, timelineInFrame: 75, timelineOutFrame: 150 },
    ],
    subjectsAtSource: (frame) => [{ id: 'A', kind: 'face', color: 'A', box: face(frame < 75 ? 0.12 : frame < 100 ? 0.46 : 0.8) }],
  },
})

/** The timeline length of a scene. */
export const sceneDurationFrames = (scene) => Math.max(...scene.clips.map((clip) => clip.timelineOutFrame))

/** The source frame a timeline frame plays (real-time clips only, which is all the reframe renders). */
export function sourceFrameOf(scene, timelineFrame) {
  const clip = scene.clips.find((candidate) => candidate.timelineInFrame <= timelineFrame && timelineFrame < candidate.timelineOutFrame)
  if (!clip) throw new Error(`timeline frame ${timelineFrame} is outside every clip`)
  return clip.sourceInFrame + (timelineFrame - clip.timelineInFrame)
}

/** The detector rows [score, xmin, ymin, xmax, ymax] the STAND-IN reports for one source frame: the generator's own face boxes. */
export const standInDetectorRows = (scene, sourceFrame) =>
  scene.subjectsAtSource(sourceFrame).filter((subject) => subject.kind === 'face').map((subject) => [0.95, ...subject.box])

const pixelBox = (box) => [Math.round(box[0] * W), Math.round(box[1] * H), Math.round(box[2] * W), Math.round(box[3] * H)]

/** The empty source frame: the checker texture and the fiducials. */
export function makeBaseFrame() {
  const base = Buffer.alloc(W * H * 3)
  const low = Buffer.from(TEXTURE_LOW), high = Buffer.from(TEXTURE_HIGH)
  for (let y = 0; y < H; y += 1) {
    for (let x0 = 0; x0 < W; x0 += TEXTURE_CELL) {
      const colour = (Math.floor(x0 / TEXTURE_CELL) + Math.floor(y / TEXTURE_CELL)) % 2 === 0 ? low : high
      base.fill(colour, (y * W + x0) * 3, (y * W + Math.min(W, x0 + TEXTURE_CELL)) * 3)
    }
  }
  for (const center of MARKER_CENTERS) {
    for (let y = 0; y < H; y += 1) {
      const offset = (y * W + center - MARKER_HALF_WIDTH) * 3
      base.fill(255, offset, offset + MARKER_HALF_WIDTH * 2 * 3)
    }
  }
  return base
}

/** Draws the subjects of one frame over a copy of the base frame, into `target`. */
export function drawSourceFrame(target, base, subjects) {
  base.copy(target)
  for (const subject of subjects) {
    const [x0, y0, x1, y1] = pixelBox(subject.box)
    const color = Buffer.from(SUBJECT_COLORS[subject.color])
    for (let y = y0; y < y1; y += 1) target.fill(color, (y * W + x0) * 3, (y * W + x1) * 3)
  }
  return target
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// What the specification says the render shows: the crop window of a frame, from the RenderInput alone (the same even-pixel arithmetic as the
// FFmpeg expression), and where a reframed range puts it on the canvas.
// ---------------------------------------------------------------------------------------------------------------------------------------

function cropAtFrame(range, frame) {
  let previous = range.keyframes[0]
  let next
  for (const keyframe of range.keyframes) {
    if (keyframe.frame <= frame) previous = keyframe
    else { next = keyframe; break }
  }
  if (!next) return { x: previous.crop.x, width: previous.crop.width }
  const ratio = (frame - previous.frame) / (next.frame - previous.frame)
  return { x: previous.crop.x + (next.crop.x - previous.crop.x) * ratio, width: previous.crop.width }
}

/** The window of the source the plan shows at one timeline frame: `{ x0, width }` in source pixels (full height, pan only). */
export function oracleWindow(renderPlan, timelineFrame) {
  const range = renderPlan.ranges.find((candidate) => candidate.startFrame <= timelineFrame && timelineFrame < candidate.endFrame)
  if (!range) throw new Error(`no range covers timeline frame ${timelineFrame}`)
  if (range.source === 'fallback' || range.keyframes.length === 0) return { x0: 0, width: W, rangeSource: 'fallback' }
  const width = Math.min(W, Math.floor(range.keyframes[0].crop.width * W / 2) * 2)
  const crop = cropAtFrame(range, timelineFrame)
  const x0 = 2 * Math.floor(Math.min(Math.max(crop.x * W, 0), W - width) / 2)
  return { x0, width, rangeSource: range.source }
}

/**
 * Where a REFRAMED range's picture lands on the canvas, by the specification: the crop window (full source height) is scaled by the cover
 * factor and centred, so it fills the canvas whole. `visibleLeft`/`visibleWidth` are the source columns the canvas then shows (the whole crop
 * when the crop has the canvas's aspect ratio, a centred part of it otherwise); `offsetY` is the canvas row of source row 0.
 */
export function coverExpectation(window, canvas) {
  const scale = Math.max(canvas.width / window.width, canvas.height / H)
  const visibleWidth = canvas.width / scale
  return { scale, visibleLeft: window.x0 + (window.width - visibleWidth) / 2, visibleWidth, offsetY: -(scale * H - canvas.height) / 2 }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// What the pixels say, with no idea how the composition was laid out: the sharp picture, the fiducials and the subjects of one decoded frame.
// ---------------------------------------------------------------------------------------------------------------------------------------

const SHARP_GRADIENT = 8
const MIN_SHARP_PIXELS = 8

function tally(width, height) {
  return { cols: new Uint32Array(width), rows: new Uint32Array(height) }
}
function boundsOf(counts, minimum) {
  const first = (array) => { for (let index = 0; index < array.length; index += 1) if (array[index] >= minimum) return index; return -1 }
  const last = (array) => { for (let index = array.length - 1; index >= 0; index -= 1) if (array[index] >= minimum) return index; return -1 }
  const x0 = first(counts.cols), x1 = last(counts.cols), y0 = first(counts.rows), y1 = last(counts.rows)
  return x0 < 0 || y0 < 0 ? null : { x0, x1, y0, y1 }
}

/**
 * Finds which fiducials a list of stripe centres (canvas px, ascending) is, from their irregular gaps alone: the consecutive run of
 * `MARKER_CENTERS` whose best linear fit `canvas x = scale * source x + offset` has the smallest residual, accepted only when it is clearly
 * better than every other alignment. Returns null when no alignment is clear.
 */
export function matchFiducials(centres) {
  const n = centres.length
  if (n < 4) return null
  const candidates = []
  for (let first = 0; first + n <= MARKER_CENTERS.length; first += 1) {
    const sources = MARKER_CENTERS.slice(first, first + n)
    const meanSrc = sources.reduce((sum, value) => sum + value, 0) / n
    const meanOut = centres.reduce((sum, value) => sum + value, 0) / n
    let sxx = 0, sxy = 0
    for (let index = 0; index < n; index += 1) { sxx += (sources[index] - meanSrc) ** 2; sxy += (sources[index] - meanSrc) * (centres[index] - meanOut) }
    const scale = sxy / sxx
    const offset = meanOut - scale * meanSrc
    const residual = Math.sqrt(centres.reduce((sum, value, index) => sum + (value - (scale * sources[index] + offset)) ** 2, 0) / n)
    if (scale >= 0.3 && scale <= 2.6) candidates.push({ first, scale, offset, residualRms: residual })
  }
  candidates.sort((left, right) => left.residualRms - right.residualRms)
  const best = candidates[0]
  if (!best || best.residualRms > 1.2) return null
  const second = candidates[1]
  if (second && second.residualRms < Math.max(3 * best.residualRms, 2.5)) return null
  return { scale: best.scale, offset: best.offset, markers: n, residualRms: best.residualRms, firstMarker: best.first }
}

/**
 * Reads one decoded RGB24 frame. It is told nothing about the composition. Returns
 *  - `footprint`: the box of the SHARP picture on the canvas (first/last column and row with edge content, snapped to the canvas edge when it
 *    reaches it) and `coverage`: the share of canvas columns and of canvas rows that hold sharp picture;
 *  - `fit`: `canvas x = scale * source x + offset`, from the fiducials found (null when they do not name themselves);
 *  - `window`: the source columns the footprint shows, through the fit;
 *  - `subjects`: each colour's box on the canvas (`canvas`) and in source pixels (`source`), or null when absent. Only the footprint is read:
 *    a blurred backdrop copies the subjects smeared and is never evidence.
 */
export function analyzeFrame(buffer, width, height) {
  const white = new Uint32Array(width)
  const sharp = tally(width, height)
  for (let y = 1; y < height; y += 1) {
    let offset = y * width * 3
    for (let x = 1; x < width; x += 1) {
      offset += 3
      const r = buffer[offset], g = buffer[offset + 1], b = buffer[offset + 2]
      if (r > 175 && g > 175 && b > 175) white[x] += 1
      const gradient = Math.abs(g - buffer[offset - 3 + 1]) + Math.abs(g - buffer[offset - width * 3 + 1])
      if (gradient > SHARP_GRADIENT) { sharp.cols[x] += 1; sharp.rows[y] += 1 }
    }
  }
  const none = { footprint: null, coverage: { width: 0, height: 0 }, fit: null, window: null, subjects: { A: null, B: null, screen: null } }
  // A white fiducial is a flat tall stripe: it has no texture of its own, but it is picture (it is as sharp as it gets).
  const stripeThreshold = Math.max(24, Math.floor(height * 0.08))
  const pictureColumns = Uint32Array.from(sharp.cols, (value, x) => (value >= MIN_SHARP_PIXELS || white[x] >= stripeThreshold ? MIN_SHARP_PIXELS : 0))
  const sharpBounds = boundsOf({ cols: pictureColumns, rows: sharp.rows }, MIN_SHARP_PIXELS)
  if (!sharpBounds) return none
  // A hard edge puts its gradient on the first pixel past it: the near edge of the picture is its first row/column, the far edge is the first
  // row/column of what lies beyond, so the far edge moves back by one unless the picture reaches the canvas edge.
  const snapNear = (value) => (value <= 2 ? 0 : value)
  const snapFar = (value, limit) => (value >= limit - 3 ? limit - 1 : value - 1)
  const footprint = { x0: snapNear(sharpBounds.x0), x1: snapFar(sharpBounds.x1, width), y0: snapNear(sharpBounds.y0), y1: snapFar(sharpBounds.y1, height) }
  const columnsWithPicture = pictureColumns.reduce((count, value) => count + (value >= MIN_SHARP_PIXELS ? 1 : 0), 0)
  const rowsWithPicture = sharp.rows.reduce((count, value) => count + (value >= MIN_SHARP_PIXELS ? 1 : 0), 0)
  const coverage = { width: columnsWithPicture / width, height: rowsWithPicture / height }

  // Fiducials: columns where white is a tall stripe. A stripe cut by the edge of the picture is truncated and is not used.
  const threshold = stripeThreshold
  const runs = []
  let run = null
  for (let x = 0; x < width; x += 1) {
    if (white[x] < threshold) continue
    if (run && x - run.last <= 2) { run.last = x; run.sum += white[x]; run.moment += white[x] * (x + 0.5) }
    else {
      if (run) runs.push(run)
      run = { first: x, last: x, sum: white[x], moment: white[x] * (x + 0.5) }
    }
  }
  if (run) runs.push(run)
  const centres = runs
    .filter((candidate) => candidate.last - candidate.first + 1 >= 2 && candidate.first > footprint.x0 + 1 && candidate.last < footprint.x1 - 1)
    .map((candidate) => candidate.moment / candidate.sum)
  const fit = matchFiducials(centres)
  if (!fit) return { ...none, footprint, coverage }
  const toSourceX = (outX) => (outX - fit.offset) / fit.scale
  const toSourceY = (outY) => (outY - footprint.y0) / fit.scale

  // Subjects: only inside the footprint, and a few pixels inside it where it does not reach the canvas edge: its edge blends with whatever lies
  // beyond (a blurred copy of a saturated subject is just as saturated as the subject), and that blend is not the picture.
  const EDGE_BLEND = 3
  const inner = {
    x0: footprint.x0 === 0 ? 0 : footprint.x0 + EDGE_BLEND, x1: footprint.x1 >= width - 1 ? width - 1 : footprint.x1 - EDGE_BLEND,
    y0: footprint.y0 === 0 ? 0 : footprint.y0 + EDGE_BLEND, y1: footprint.y1 >= height - 1 ? height - 1 : footprint.y1 - EDGE_BLEND,
  }
  const classes = { A: tally(width, height), B: tally(width, height), screen: tally(width, height) }
  for (let y = inner.y0; y <= inner.y1; y += 1) {
    let offset = (y * width + inner.x0) * 3
    for (let x = inner.x0; x <= inner.x1; x += 1, offset += 3) {
      const r = buffer[offset], g = buffer[offset + 1], b = buffer[offset + 2]
      if (r > 150 && g < 100 && b < 100) { classes.A.cols[x] += 1; classes.A.rows[y] += 1 }
      else if (g > 130 && r < 100 && b < 100) { classes.B.cols[x] += 1; classes.B.rows[y] += 1 }
      else if (r < 90 && g > 150 && b > 150) { classes.screen.cols[x] += 1; classes.screen.rows[y] += 1 }
    }
  }
  const subjects = { A: null, B: null, screen: null }
  for (const [name, counts] of Object.entries(classes)) {
    const bounds = boundsOf(counts, 3)
    if (!bounds) continue
    const canvasBox = { x0: bounds.x0, x1: bounds.x1 + 1, y0: bounds.y0, y1: bounds.y1 + 1 }
    subjects[name] = { canvas: canvasBox, x0: toSourceX(canvasBox.x0), x1: toSourceX(canvasBox.x1), y0: toSourceY(canvasBox.y0), y1: toSourceY(canvasBox.y1) }
  }
  return { footprint, coverage, fit, window: { left: toSourceX(footprint.x0), right: toSourceX(footprint.x1 + 1) }, subjects }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The verdict of one scene: per decoded frame, the picture and the subjects against the specification; over the range, the measured
// velocity/acceleration of the crop.
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * @param analyses one `analyzeFrame` result per decoded timeline frame
 * @param renderPlan the RenderReframePlanV1 the renderer was given
 * @param issues the localized issues of the record (timeline frame ranges)
 * @param policy the pinned REFRAME_POLICY
 * @param canvas the output canvas of the variant
 *
 * A frame has `reasons` that a reported issue excuses (the crop lost a subject the plan said it could not keep) and `structural` ones that
 * nothing excuses: a reframed range whose picture does not fill the canvas, or whose scale is not the cover scale of its crop.
 */
export function judgeScene({ scene, analyses, renderPlan, issues, policy, canvas }) {
  const margin = policy.tracking.safetyMargin
  const marginPx = margin * W
  const flaggedAt = (frame) => issues.some((issue) => issue.startFrame <= frame && frame < issue.endFrame)
  const frames = []
  for (let t = 0; t < analyses.length; t += 1) {
    const analysis = analyses[t]
    const oracle = oracleWindow(renderPlan, t)
    const reframed = oracle.rangeSource !== 'fallback'
    const cover = reframed ? coverExpectation(oracle, canvas) : null
    const expected = cover ? { x0: cover.visibleLeft, width: cover.visibleWidth } : oracle
    const measured = analysis.window
    const sourceFrame = sourceFrameOf(scene, t)
    const flagged = flaggedAt(t)
    const reasons = []
    const structural = []
    const subjects = []
    if (reframed) {
      if (analysis.coverage.width < TOLERANCE.coverage || analysis.coverage.height < TOLERANCE.coverage) structural.push('foreground-does-not-fill-canvas')
      if (analysis.fit && Math.abs(analysis.fit.scale - cover.scale) / cover.scale > TOLERANCE.scale) structural.push('scale-differs-from-cover')
    }
    if (!measured) reasons.push('window-not-measurable')
    const windowError = measured ? Math.max(Math.abs(measured.left - expected.x0), Math.abs(measured.right - (expected.x0 + expected.width))) : Number.POSITIVE_INFINITY
    if (windowError > TOLERANCE.window) reasons.push('window-differs-from-render-input')
    for (const subject of scene.subjectsAtSource(sourceFrame)) {
      const truth = { x0: subject.box[0] * W, y0: subject.box[1] * H, x1: subject.box[2] * W, y1: subject.box[3] * H }
      const seen = analysis.subjects[subject.color]
      const entry = { id: subject.id, positionError: null, outputError: null, slack: null, visible: seen !== null }
      if (!seen) reasons.push(`subject-${subject.id}-not-visible`)
      else {
        entry.positionError = Math.max(Math.abs(seen.x0 - truth.x0), Math.abs(seen.x1 - truth.x1), Math.abs(seen.y0 - truth.y0), Math.abs(seen.y1 - truth.y1))
        if (entry.positionError > TOLERANCE.position) reasons.push(`subject-${subject.id}-position`)
        if (reframed) {
          // OUTPUT frame coordinates, straight from the pixels, against where the specification puts the subject on the canvas.
          const expectedBox = {
            x0: cover.scale * (truth.x0 - cover.visibleLeft), x1: cover.scale * (truth.x1 - cover.visibleLeft),
            y0: cover.scale * truth.y0 + cover.offsetY, y1: cover.scale * truth.y1 + cover.offsetY,
          }
          entry.outputError = Math.max(Math.abs(seen.canvas.x0 - expectedBox.x0), Math.abs(seen.canvas.x1 - expectedBox.x1),
            Math.abs(seen.canvas.y0 - expectedBox.y0), Math.abs(seen.canvas.y1 - expectedBox.y1))
          if (entry.outputError > TOLERANCE.outputPosition) reasons.push(`subject-${subject.id}-output-position`)
        }
      }
      if (measured) {
        // The safety margin is owed up to the edge of the frame, never beyond it.
        const needLeft = Math.max(0, truth.x0 - marginPx), needRight = Math.min(W, truth.x1 + marginPx)
        entry.slack = Math.min(needLeft - measured.left, measured.right - needRight)
        if (entry.slack < -TOLERANCE.window) reasons.push(`subject-${subject.id}-outside-crop-margin`)
      }
      subjects.push(entry)
    }
    frames.push({ t, flagged, oracle, measured, windowError, coverage: analysis.coverage, reframed, subjects, reasons, structural })
  }
  // Velocity and acceleration of the MEASURED crop centre, over windows of K frames so a 2 px quantization step is not read as motion.
  const K = 15
  const seconds = K / FPS
  const centre = (frame) => (frame.measured.left + frame.measured.right) / 2 / W
  const touchesEdge = (frame) => frame.measured.left <= 2 || frame.measured.right >= W - 2
  const dynamics = { windowFrames: K, maxSpeed: 0, maxAcceleration: 0, speedWindows: 0, accelerationWindows: 0, skippedAtEdge: 0 }
  const oracleDynamics = { maxSpeed: 0, maxAcceleration: 0 }
  for (const range of renderPlan.ranges) {
    if (range.source === 'fallback') continue
    const inRange = frames.filter((frame) => range.startFrame <= frame.t && frame.t < range.endFrame && frame.measured && !frame.flagged)
    const byT = new Map(inRange.map((frame) => [frame.t, frame]))
    const speedAt = (t) => {
      const a = byT.get(t), b = byT.get(t + K)
      if (!a || !b) return null
      for (let u = t; u <= t + K; u += 1) { const f = byT.get(u); if (!f) return null }
      if (touchesEdge(a) || touchesEdge(b)) { dynamics.skippedAtEdge += 1; return null }
      return {
        measured: (centre(b) - centre(a)) / seconds,
        oracle: ((b.oracle.x0 + b.oracle.width / 2) - (a.oracle.x0 + a.oracle.width / 2)) / W / seconds,
      }
    }
    for (let t = range.startFrame; t + K < range.endFrame; t += 1) {
      const v = speedAt(t)
      if (!v) continue
      dynamics.speedWindows += 1
      dynamics.maxSpeed = Math.max(dynamics.maxSpeed, Math.abs(v.measured))
      oracleDynamics.maxSpeed = Math.max(oracleDynamics.maxSpeed, Math.abs(v.oracle))
      const next = speedAt(t + K)
      if (!next) continue
      dynamics.accelerationWindows += 1
      dynamics.maxAcceleration = Math.max(dynamics.maxAcceleration, Math.abs(next.measured - v.measured) / seconds)
      oracleDynamics.maxAcceleration = Math.max(oracleDynamics.maxAcceleration, Math.abs(next.oracle - v.oracle) / seconds)
    }
  }
  const failing = frames.filter((frame) => frame.reasons.length > 0 || frame.structural.length > 0)
  const unflaggedFailing = failing.filter((frame) => frame.structural.length > 0 || !frame.flagged)
  const slacks = frames.flatMap((frame) => frame.subjects.map((entry) => entry.slack)).filter((value) => value !== null)
  const positionErrors = frames.flatMap((frame) => frame.subjects.map((entry) => entry.positionError)).filter((value) => value !== null)
  const outputErrors = frames.flatMap((frame) => frame.subjects.map((entry) => entry.outputError)).filter((value) => value !== null)
  const reframedFrames = frames.filter((frame) => frame.reframed)
  const allReasons = (frame) => [...frame.structural, ...frame.reasons]
  return {
    frames: frames.length,
    reframedFrames: reframedFrames.length,
    flaggedFrames: frames.filter((frame) => frame.flagged).length,
    failingFrames: failing.length,
    unflaggedFailingFrames: unflaggedFailing.length,
    firstUnflaggedFailure: unflaggedFailing[0] ? { t: unflaggedFailing[0].t, reasons: allReasons(unflaggedFailing[0]) } : null,
    reasonCounts: Object.fromEntries([...new Set(failing.flatMap(allReasons))].sort().map((reason) =>
      [reason, failing.filter((frame) => allReasons(frame).includes(reason)).length])),
    maxWindowError: Math.max(...frames.map((frame) => frame.windowError)),
    maxSubjectPositionError: positionErrors.length ? Math.max(...positionErrors) : null,
    maxSubjectOutputError: outputErrors.length ? Math.max(...outputErrors) : null,
    minMarginSlackPx: slacks.length ? Math.min(...slacks) : null,
    // The share of the canvas the sharp picture covers on the worst reframed frame, per axis (the specification asks for >= `TOLERANCE.coverage`).
    minCoverage: reframedFrames.length
      ? { width: Math.min(...reframedFrames.map((frame) => frame.coverage.width)), height: Math.min(...reframedFrames.map((frame) => frame.coverage.height)) }
      : null,
    allSubjectsVisibleEveryFrame: frames.every((frame) => frame.subjects.every((entry) => entry.visible)),
    dynamics, oracleDynamics,
    canvas,
    perFrame: frames,
  }
}
