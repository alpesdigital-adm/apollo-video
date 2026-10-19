// W66r ground-truth (GT) machinery for the frame-by-frame proof of the reframe trajectory on a RENDERED mp4.
//
// What is real and what is a stand-in:
// - The GT generator below decides, for every source frame, where each subject is. It DRAWS those subjects into the source video and, for
//   the same frames, produces the detector rows the product writers consume. The "detector" is therefore a STAND-IN: its boxes are the
//   generator's boxes, not the output of a model. Nothing here says anything about a real detector on real video.
// - Everything downstream of the rows is the product: raw tensor -> V9 decoder -> sealed envelope -> source evidence stream -> ROI ->
//   policy-sealed plan -> keyframed render plan -> FFmpeg crop expression -> encoded mp4.
// - The measurements below read the DECODED pixels of that mp4. The crop window of each frame is recovered from fiducial markers drawn
//   at known source positions (not from the RenderInput), and then compared with the RenderInput arithmetic. Only the foreground band of
//   the canvas is read: the rest of a vertical canvas is a blurred copy of the picture, which is no evidence of anything.
//
// This module is pure (no FFmpeg, no PG), so its arithmetic is unit-tested without a render (`reframe-gt-oracle.test.mjs`).

export const W = 1280
export const H = 720
export const FPS = 30

/** Dark grey background: distinguishable from the black pad the renderer adds around a contained frame. */
export const BACKGROUND = [40, 40, 40]
/** White vertical fiducials at known source columns; the renderer cannot change where they are, only where the crop shows them. */
export const MARKER_SPACING = 48
export const MARKER_CENTERS = Object.freeze(Array.from({ length: 26 }, (_unused, index) => 24 + MARKER_SPACING * index))
export const MARKER_HALF_WIDTH = 4
export const SUBJECT_COLORS = Object.freeze({ A: [230, 30, 30], B: [30, 200, 30], screen: [0, 220, 220] })

/** Tolerances, in SOURCE pixels. Named so the evidence can quote them. */
export const TOLERANCE = Object.freeze({
  /** The even-pixel crop quantization (<= 2 px) plus the sub-pixel blur of scaling and encoding. */
  window: 3,
  /** Where a decoded subject may sit against where the generator put it. */
  position: 6,
  /** The first and last non-black column of the foreground against the window the fit gives: two canvas pixels at the 0.42 scale of a vertical canvas. */
  footprint: 5.5,
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

/** The empty source frame: background and the fiducials. */
export function makeBaseFrame() {
  const base = Buffer.alloc(W * H * 3)
  base.fill(Buffer.from(BACKGROUND))
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
// What the renderer was told: the crop window of a frame, from the RenderInput alone (the same even-pixel arithmetic as the FFmpeg expression).
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
 * Where the foreground of the render lands on the canvas, the way the composition graph (and `caption-canvas-projection`) build it:
 *   1. the crop window is fitted into the STAGING frame (the largest video source: here the 1280x720 source) and centred (`pad`);
 *   2. the staging frame is fitted into the canvas (`decrease`), multiplied by `foregroundScale` and overlaid centred horizontally at
 *      `verticalPosition`; the rest of the canvas is a blurred copy of the picture (no face-bearing content, never measured).
 * A 9:16 crop of a 16:9 source therefore appears as a strip inside a 16:9 band of the vertical canvas; the 16:9 variant fills its canvas.
 *
 * Returns the scale (canvas px per source px), the canvas x of the window's left edge (`padX`), the canvas y of source row 0 (`padY`), and the
 * rows of the foreground band (`band`), all in canvas pixels. It is computed from the RenderInput alone.
 */
export function foregroundMapping(window, canvas, composition = { foregroundScale: 1, verticalPosition: 0.5 }) {
  const staging = { width: W, height: H }
  const toStaging = Math.min(staging.width / window.width, staging.height / H)
  const stagePadX = (staging.width - window.width * toStaging) / 2, stagePadY = (staging.height - H * toStaging) / 2
  const toCanvas = Math.min(canvas.width / staging.width, canvas.height / staging.height) * composition.foregroundScale
  const foregroundWidth = staging.width * toCanvas, foregroundHeight = staging.height * toCanvas
  const originX = (canvas.width - foregroundWidth) / 2
  const originY = Math.max(0, Math.min(canvas.height - foregroundHeight, canvas.height * composition.verticalPosition - foregroundHeight / 2))
  return {
    scale: toStaging * toCanvas,
    padX: originX + stagePadX * toCanvas,
    padY: originY + stagePadY * toCanvas,
    band: { top: originY, bottom: originY + foregroundHeight },
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// What the pixels say: the visible window and the subjects of one decoded frame.
// ---------------------------------------------------------------------------------------------------------------------------------------

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
 * Reads one decoded RGB24 frame, looking ONLY at the rows of the foreground band (the blurred backdrop copies the subjects and the
 * fiducials, dimmed and smeared, and is never evidence). `hint` is the RenderInput's own prediction (window + mapping); it says where the
 * band is and which fiducial is which (they are `MARKER_SPACING` source px apart and the prediction is good to a few pixels). It is never
 * the source of a measurement: the position of the crop is the linear fit `canvas x = scale * source x + offset` of the fiducials found.
 *
 * Returns
 *  - `fit`: that line (scale, offset) with the number of fiducials and the RMS residual;
 *  - `window`: the source columns shown by the foreground footprint the composition fixes on the canvas (left, right), through the fit;
 *  - `footprint`: the same, from the first and last non-black columns of the band (black is the staging pad), to cross-check the width;
 *  - `subjects`: each colour's box in source pixels, or null when the colour is absent.
 */
export function analyzeFrame(buffer, width, height, hint) {
  const band = hint.mapping.band
  const rowFrom = Math.max(0, Math.ceil(band.top) + 2), rowTo = Math.min(height, Math.floor(band.bottom) - 2)
  const white = new Uint32Array(width)
  const classes = { A: tally(width, height), B: tally(width, height), screen: tally(width, height) }
  let contentX0 = width, contentX1 = -1, contentY0 = height, contentY1 = -1
  for (let y = rowFrom; y < rowTo; y += 1) {
    let offset = y * width * 3
    for (let x = 0; x < width; x += 1, offset += 3) {
      const r = buffer[offset], g = buffer[offset + 1], b = buffer[offset + 2]
      if (r > 24 || g > 24 || b > 24) {
        if (x < contentX0) contentX0 = x
        if (x > contentX1) contentX1 = x
        if (y < contentY0) contentY0 = y
        if (y > contentY1) contentY1 = y
      }
      if (r > 175 && g > 175 && b > 175) white[x] += 1
      else if (r > 150 && g < 100 && b < 100) { classes.A.cols[x] += 1; classes.A.rows[y] += 1 }
      else if (g > 130 && r < 100 && b < 100) { classes.B.cols[x] += 1; classes.B.rows[y] += 1 }
      else if (r < 90 && g > 150 && b > 150) { classes.screen.cols[x] += 1; classes.screen.rows[y] += 1 }
    }
  }
  const none = { content: null, fit: null, window: null, footprint: null, subjects: { A: null, B: null, screen: null } }
  if (contentX1 < 0) return none
  const contentHeight = contentY1 - contentY0 + 1
  const threshold = Math.max(8, Math.floor(contentHeight * 0.2))
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
  // A fiducial cut by the edge of the footprint is a truncated stripe whose centroid is biased: it is not used.
  const centres = runs
    .filter((candidate) => candidate.last - candidate.first + 1 >= 2 && candidate.first > contentX0 + 1 && candidate.last < contentX1 - 1)
    .map((candidate) => candidate.moment / candidate.sum)
  const predicted = (outX) => hint.window.x0 + (outX - hint.mapping.padX) / hint.mapping.scale
  const points = []
  for (const centre of centres) {
    const source = predicted(centre)
    const index = Math.round((source - MARKER_CENTERS[0]) / MARKER_SPACING)
    if (index < 0 || index >= MARKER_CENTERS.length || Math.abs(source - MARKER_CENTERS[index]) > MARKER_SPACING * 0.4) continue
    points.push({ out: centre, src: MARKER_CENTERS[index] })
  }
  let fit = null
  if (points.length >= 3) {
    const n = points.length
    const meanSrc = points.reduce((sum, point) => sum + point.src, 0) / n
    const meanOut = points.reduce((sum, point) => sum + point.out, 0) / n
    let sxx = 0, sxy = 0
    for (const point of points) { sxx += (point.src - meanSrc) ** 2; sxy += (point.src - meanSrc) * (point.out - meanOut) }
    const scale = sxy / sxx
    const offset = meanOut - scale * meanSrc
    const residual = Math.sqrt(points.reduce((sum, point) => sum + (point.out - (scale * point.src + offset)) ** 2, 0) / n)
    fit = { scale, offset, markers: n, residualRms: residual }
  }
  const content = { x0: contentX0, x1: contentX1, y0: contentY0, y1: contentY1 }
  if (!fit) return { ...none, content }
  const toSourceX = (outX) => (outX - fit.offset) / fit.scale
  // The vertical placement of the band is the composition's geometry (the backdrop above it is not black, so its top row cannot be told
  // from the pixels); what the pixels measure is the horizontal crop, through the fiducials, and the vertical scale through the same fit.
  const toSourceY = (outY) => (outY - hint.mapping.padY) / fit.scale
  const subjects = { A: null, B: null, screen: null }
  for (const [name, counts] of Object.entries(classes)) {
    const bounds = boundsOf(counts, 3)
    if (bounds) subjects[name] = { x0: toSourceX(bounds.x0), x1: toSourceX(bounds.x1 + 1), y0: toSourceY(bounds.y0), y1: toSourceY(bounds.y1 + 1) }
  }
  // The footprint the composition fixes on the canvas: where the window's left and right edges are, through the measured fit.
  const footLeft = hint.mapping.padX, footRight = hint.mapping.padX + hint.window.width * hint.mapping.scale
  return {
    content, fit,
    window: { left: toSourceX(footLeft), right: toSourceX(footRight) },
    footprint: { left: toSourceX(contentX0), right: toSourceX(contentX1 + 1) },
    subjects,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The verdict of one scene: per decoded frame, the subjects against the measured crop; over the range, the measured velocity/acceleration.
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * @param analyses one `analyzeFrame` result per decoded timeline frame
 * @param renderPlan the RenderReframePlanV1 the renderer was given
 * @param issues the localized issues of the record (timeline frame ranges)
 * @param policy the pinned REFRAME_POLICY
 */
export function judgeScene({ scene, analyses, renderPlan, issues, policy, canvas }) {
  const margin = policy.tracking.safetyMargin
  const marginPx = margin * W
  const flaggedAt = (frame) => issues.some((issue) => issue.startFrame <= frame && frame < issue.endFrame)
  const frames = []
  for (let t = 0; t < analyses.length; t += 1) {
    const analysis = analyses[t]
    const oracle = oracleWindow(renderPlan, t)
    const measured = analysis.window
    const sourceFrame = sourceFrameOf(scene, t)
    const flagged = flaggedAt(t)
    const reasons = []
    const subjects = []
    if (!measured) reasons.push('window-not-measurable')
    const windowError = measured ? Math.max(Math.abs(measured.left - oracle.x0), Math.abs(measured.right - (oracle.x0 + oracle.width))) : Number.POSITIVE_INFINITY
    if (windowError > TOLERANCE.window) reasons.push('window-differs-from-render-input')
    const footprintError = analysis.footprint && measured ? Math.max(Math.abs(analysis.footprint.left - measured.left), Math.abs(analysis.footprint.right - measured.right)) : Number.POSITIVE_INFINITY
    if (footprintError > TOLERANCE.footprint) reasons.push('footprint-differs-from-window')
    for (const subject of scene.subjectsAtSource(sourceFrame)) {
      const truth = { x0: subject.box[0] * W, y0: subject.box[1] * H, x1: subject.box[2] * W, y1: subject.box[3] * H }
      const seen = analysis.subjects[subject.color]
      const entry = { id: subject.id, positionError: null, slack: null, visible: seen !== null }
      if (!seen) reasons.push(`subject-${subject.id}-not-visible`)
      else {
        entry.positionError = Math.max(Math.abs(seen.x0 - truth.x0), Math.abs(seen.x1 - truth.x1), Math.abs(seen.y0 - truth.y0), Math.abs(seen.y1 - truth.y1))
        if (entry.positionError > TOLERANCE.position) reasons.push(`subject-${subject.id}-position`)
      }
      if (measured) {
        // The safety margin is owed up to the edge of the frame, never beyond it.
        const needLeft = Math.max(0, truth.x0 - marginPx), needRight = Math.min(W, truth.x1 + marginPx)
        entry.slack = Math.min(needLeft - measured.left, measured.right - needRight)
        if (entry.slack < -TOLERANCE.window) reasons.push(`subject-${subject.id}-outside-crop-margin`)
      }
      subjects.push(entry)
    }
    frames.push({ t, flagged, oracle, measured, windowError, footprintError, subjects, reasons })
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
  const failing = frames.filter((frame) => frame.reasons.length > 0)
  const unflaggedFailing = failing.filter((frame) => !frame.flagged)
  const slacks = frames.flatMap((frame) => frame.subjects.map((entry) => entry.slack)).filter((value) => value !== null)
  const positionErrors = frames.flatMap((frame) => frame.subjects.map((entry) => entry.positionError)).filter((value) => value !== null)
  return {
    frames: frames.length,
    flaggedFrames: frames.filter((frame) => frame.flagged).length,
    failingFrames: failing.length,
    unflaggedFailingFrames: unflaggedFailing.length,
    firstUnflaggedFailure: unflaggedFailing[0] ? { t: unflaggedFailing[0].t, reasons: unflaggedFailing[0].reasons } : null,
    reasonCounts: Object.fromEntries([...new Set(failing.flatMap((frame) => frame.reasons))].sort().map((reason) =>
      [reason, failing.filter((frame) => frame.reasons.includes(reason)).length])),
    maxWindowError: Math.max(...frames.map((frame) => frame.windowError)),
    maxFootprintError: Math.max(...frames.map((frame) => frame.footprintError)),
    maxSubjectPositionError: positionErrors.length ? Math.max(...positionErrors) : null,
    minMarginSlackPx: slacks.length ? Math.min(...slacks) : null,
    allSubjectsVisibleEveryFrame: frames.every((frame) => frame.subjects.every((entry) => entry.visible)),
    dynamics, oracleDynamics,
    canvas,
    perFrame: frames,
  }
}
