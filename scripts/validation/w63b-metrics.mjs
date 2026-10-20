/**
 * W63b comparison of the server perception snapshot against the independent labels. Pure functions: they read a snapshot range
 * result (`result.observations`, `result.coverage` of server-perception-range/v1) and a corpus manifest entry, and nothing else.
 * Frozen with the pre-registration (its SHA-256 is recorded there).
 */
import { RULES, STRATA } from './w63b-thresholds.mjs'

const FPS = 30
export const OCR_INTERVAL = 15

// ------------------------------------------------------------------------------------------------------------ text helpers

export const normalizeText = (value) => String(value).normalize('NFC').replace(/\s+/gu, ' ').trim()

export function levenshtein(left, right) {
  const a = [...left]
  const b = [...right]
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    previous = row
  }
  return previous[b.length]
}

export const characterErrorRate = (reading, label) => levenshtein(reading, label) / Math.max(1, [...label].length)

export function boxIou(a, b) {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  const intersection = x * y
  const union = a[2] * a[3] + b[2] * b[3] - intersection
  return union <= 0 ? 0 : intersection / union
}

function overlapOfSmaller(a, b) {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  return (x * y) / Math.max(1e-12, Math.min(a[2] * a[3], b[2] * b[3]))
}

const unionBox = (boxes) => {
  const x0 = Math.min(...boxes.map((box) => box[0]))
  const y0 = Math.min(...boxes.map((box) => box[1]))
  const x1 = Math.max(...boxes.map((box) => box[0] + box[2]))
  const y1 = Math.max(...boxes.map((box) => box[1] + box[3]))
  return [x0, y0, x1 - x0, y1 - y0]
}

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const hasDiacritic = (text) => /[^\p{ASCII}]/u.test(text)

// ------------------------------------------------------------------------------------------------------------ clock mapping

/** Maps source frames to timeline frames through the label's own EditPlan (identity when the clip is played whole). */
export function clockOf(entry) {
  const plan = entry.spec.editPlan
  const clips = plan ? plan.clips : [{ sourceInFrame: 0, sourceOutFrame: entry.spec.frames, timelineInFrame: 0, timelineOutFrame: entry.spec.frames }]
  return Object.freeze({
    clips,
    durationFrames: plan ? plan.durationFrames : entry.spec.frames,
    sourceFrameToTimeline(frame) {
      const clip = clips.find((item) => frame >= item.sourceInFrame && frame < item.sourceOutFrame)
      return clip ? clip.timelineInFrame + frame - clip.sourceInFrame : null
    },
    timelineFrameToSource(frame) {
      const clip = clips.find((item) => frame >= item.timelineInFrame && frame < item.timelineOutFrame)
      return clip ? clip.sourceInFrame + frame - clip.timelineInFrame : null
    },
    /** the timeline pair of the source pair p -> p+1, or null when an edit removed it or the pair straddles a seam */
    sourcePairToTimeline(pair) {
      const clip = clips.find((item) => pair >= item.sourceInFrame && pair + 1 < item.sourceOutFrame)
      return clip ? clip.timelineInFrame + pair - clip.sourceInFrame : null
    },
    expectedPairs() {
      return clips.flatMap((item) => Array.from({ length: item.sourceOutFrame - item.sourceInFrame - 1 }, (_, index) => item.timelineInFrame + index))
    },
    seamPairs() {
      return clips.slice(0, -1).map((item) => item.timelineOutFrame - 1)
    },
  })
}

// ------------------------------------------------------------------------------------------------------------ OCR

export function sampledTimelineFrames(coverage) {
  const entry = coverage.find((item) => item.kind === 'ocr')
  if (!entry) return []
  return entry.ranges.map((range) => Math.round(range[0] * FPS / 1000))
}

function readLabel(words, label) {
  const [lx, ly, lw, lh] = label.box
  const marginX = RULES.text.marginX
  const marginY = RULES.text.marginYOfLabelHeight * lh
  const inside = words.filter((word) => {
    const cx = word.box[0] + word.box[2] / 2
    const cy = word.box[1] + word.box[3] / 2
    return cx >= lx - marginX && cx <= lx + lw + marginX && cy >= ly - marginY && cy <= ly + lh + marginY
  })
  const kept = []
  for (const word of [...inside].sort((a, b) => b.confidence - a.confidence)) {
    if (!kept.some((other) => overlapOfSmaller(other.box, word.box) >= RULES.text.dedupeOverlap)) kept.push(word)
  }
  kept.sort((a, b) => a.box[0] - b.box[0])
  return { inside, candidates: inside.length, kept, reading: normalizeText(kept.map((word) => word.text).join(' ')),
    box: kept.length ? unionBox(kept.map((word) => word.box)) : null }
}

export function evaluateOcr(entry, evidence) {
  const clock = clockOf(entry)
  const frames = sampledTimelineFrames(evidence.coverage)
  const words = new Map()
  for (const observation of evidence.observations) {
    if (observation.kind !== 'ocr') continue
    const frame = observation.value.timelineFrame
    if (!words.has(frame)) words.set(frame, [])
    words.get(frame).push({ text: observation.value.text, box: observation.value.box, confidence: observation.value.confidence })
  }
  const units = []
  const samples = []
  for (const frame of frames) {
    const source = clock.timelineFrameToSource(frame)
    const visible = entry.spec.text.filter((item) => source >= item.startFrame && source < item.endFrame)
    const present = words.get(frame) ?? []
    const claimed = new Set()
    for (const item of visible) {
      const read = readLabel(present, item)
      for (const word of read.inside) claimed.add(word)
      const expected = normalizeText(item.text)
      units.push({ clipId: entry.id, labelId: item.id, timelineFrame: frame, sourceFrame: source, expected, reading: read.reading,
        exact: read.reading === expected, cer: characterErrorRate(read.reading, expected), iou: read.box ? boxIou(read.box, item.box) : 0,
        read: read.kept.length > 0, duplicateReadings: read.candidates > read.kept.length, diacritic: hasDiacritic(item.text) })
    }
    samples.push({ timelineFrame: frame, sourceFrame: source, visible: visible.length, words: present.length, spurious: present.filter((word) => !claimed.has(word)).length })
  }
  return { units, samples, sampledFrames: frames }
}

export function aggregateOcr(perClip) {
  const units = perClip.flatMap((clip) => clip.units)
  const samples = perClip.flatMap((clip) => clip.samples)
  const diacritic = units.filter((unit) => unit.diacritic)
  const share = (list, predicate) => list.length ? list.filter(predicate).length / list.length : null
  return {
    units: units.length, samples: samples.length,
    exactRate: share(units, (unit) => unit.exact), meanCer: mean(units.map((unit) => unit.cer)),
    iouShare: share(units, (unit) => unit.iou >= RULES.text.iouMin),
    medianIou: median(units.map((unit) => unit.iou)),
    diacriticUnits: diacritic.length, diacriticExactRate: share(diacritic, (unit) => unit.exact),
    spuriousPerSample: samples.length ? samples.reduce((sum, sample) => sum + sample.spurious, 0) / samples.length : null,
    duplicateReadingRate: share(units, (unit) => unit.duplicateReadings),
  }
}

// ------------------------------------------------------------------------------------------------------------ temporal

export function shotPairs(observations) {
  const out = new Map()
  for (const observation of observations) if (observation.kind === 'shot') out.set(observation.value.startTimelineFrame, observation.value.changeScore)
  return out
}

export function motionPairs(observations) {
  const out = new Map()
  for (const observation of observations) {
    if (observation.kind !== 'motion') continue
    const { x, y } = observation.value.vectorPxPerSecond
    out.set(observation.value.startTimelineFrame, { x, y, magnitude: Math.hypot(x, y), residual: observation.value.residualMeanAbsoluteLuma, ambiguity: observation.value.ambiguity })
  }
  return out
}

/** Rule B. Returns events [{ pair, score }]. */
export function detectHardCuts(scores) {
  const rule = RULES.hardCut
  const pairs = [...scores.keys()].sort((a, b) => a - b)
  const flagged = []
  pairs.forEach((pair, index) => {
    const neighbours = []
    for (let offset = 1; offset <= rule.neighbours; offset += 1) {
      if (index - offset >= 0) neighbours.push(scores.get(pairs[index - offset]))
      if (index + offset < pairs.length) neighbours.push(scores.get(pairs[index + offset]))
    }
    const baseline = median(neighbours) ?? 0
    const score = scores.get(pair)
    if (score >= rule.floor && score >= rule.ratio * baseline) flagged.push(pair)
  })
  const events = []
  for (const pair of flagged) {
    const last = events.at(-1)
    if (last && pair - last.pairs.at(-1) <= 1) last.pairs.push(pair)
    else events.push({ pairs: [pair] })
  }
  return events.map((event) => {
    const best = event.pairs.reduce((winner, pair) => scores.get(pair) > scores.get(winner) ? pair : winner, event.pairs[0])
    return { pair: best, score: scores.get(best) }
  })
}

/** Rule C. Returns runs [{ start, end }] with `end` exclusive, in pair indices. */
export function detectFadeRuns(scores) {
  const rule = RULES.fadeRun
  const pairs = [...scores.keys()].sort((a, b) => a - b)
  const flagged = pairs.filter((pair) => {
    const window = pairs.filter((other) => Math.abs(other - pair) <= rule.window).map((other) => scores.get(other))
    return scores.get(pair) >= Math.max(rule.floor, rule.ratio * median(window))
  })
  const runs = []
  for (const pair of flagged) {
    const last = runs.at(-1)
    if (last && pair === last.end) last.end = pair + 1
    else runs.push({ start: pair, end: pair + 1 })
  }
  return runs.filter((run) => run.end - run.start >= rule.minRun)
}

const rangeIou = (a, b) => {
  const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
  const union = (a.end - a.start) + (b.end - b.start) - intersection
  return union <= 0 ? 0 : intersection / union
}

function labelledMotion(entry, clock) {
  return entry.spec.labels.motion.map((segment) => {
    // pairs of the segment that survive the edit, as timeline pairs
    const pairs = []
    for (let pair = segment.startPair; pair < segment.endPair; pair += 1) {
      const mapped = clock.sourcePairToTimeline(pair)
      if (mapped !== null) pairs.push(mapped)
    }
    return { ...segment, timelinePairs: pairs }
  })
}

export function evaluateTemporal(entry, evidence) {
  const clock = clockOf(entry)
  const scores = shotPairs(evidence.observations)
  const motion = motionPairs(evidence.observations)
  const labels = entry.spec.labels
  const tolerance = RULES.hardCut.matchTolerancePairs
  const events = detectHardCuts(scores)
  const cutPairs = labels.hardCuts.map((cut) => clock.sourcePairToTimeline(cut.frame - 1)).filter((pair) => pair !== null)
  const fadeLabels = labels.crossfades.map((fade) => ({ start: clock.sourcePairToTimeline(fade.startFrame) ?? fade.startFrame, end: (clock.sourcePairToTimeline(fade.startFrame) ?? fade.startFrame) + (fade.endFrame - fade.startFrame) }))
  const insertEdges = labels.inserts.flatMap((insert) => [clock.sourcePairToTimeline(insert.startFrame - 1), clock.sourcePairToTimeline(insert.endFrame - 1)]).filter((pair) => pair !== null)
  const matchedCuts = cutPairs.map((pair) => ({ pair, event: events.find((event) => Math.abs(event.pair - pair) <= tolerance) ?? null, score: scores.get(pair) ?? null }))
  const explained = (event) => cutPairs.some((pair) => Math.abs(event.pair - pair) <= tolerance) ||
    fadeLabels.some((fade) => event.pair >= fade.start - tolerance && event.pair < fade.end + tolerance) ||
    insertEdges.some((pair) => Math.abs(event.pair - pair) <= tolerance)
  const falseCutEvents = events.filter((event) => !explained(event))
  const moving = labelledMotion(entry, clock).some((segment) => segment.dxPxPerFrame !== 0 || segment.dyPxPerFrame !== 0)
  const runs = moving ? null : detectFadeRuns(scores)
  const falseRuns = runs ? runs.filter((run) => !fadeLabels.some((fade) => Math.min(run.end, fade.end) > Math.max(run.start, fade.start))) : []
  const fades = fadeLabels.map((fade) => {
    const best = (runs ?? []).reduce((winner, run) => rangeIou(run, fade) > (winner?.iou ?? 0) ? { run, iou: rangeIou(run, fade) } : winner, null)
    return { label: fade, iou: best?.iou ?? 0, run: best?.run ?? null }
  })
  // motion segments
  const boundaryPairs = new Set([...cutPairs, ...insertEdges, ...fadeLabels.flatMap((fade) => Array.from({ length: fade.end - fade.start }, (_, index) => fade.start + index))])
  const segments = labelledMotion(entry, clock).map((segment) => {
    const expectedMagnitude = Math.hypot(segment.dxPxPerFrame, segment.dyPxPerFrame) * FPS
    const observed = segment.timelinePairs.filter((pair) => motion.has(pair) && !boundaryPairs.has(pair)).map((pair) => ({ pair, ...motion.get(pair) }))
    const eligible = segment.timelinePairs.filter((pair) => !boundaryPairs.has(pair))
    const stationary = segment.dxPxPerFrame === 0 && segment.dyPxPerFrame === 0
    const base = { stationary, expectedMagnitudePxPerSecond: expectedMagnitude, pairs: eligible.length, observed: observed.length,
      coverage: eligible.length ? observed.length / eligible.length : null }
    if (stationary) {
      const fast = observed.filter((item) => item.magnitude >= RULES.motion.staticMaxPxPerSecond)
      return { ...base, falseMotionPairs: fast.length, maxVector: observed.length ? Math.max(...observed.map((item) => item.magnitude)) : null,
        maxResidual: observed.length ? Math.max(...observed.map((item) => item.residual)) : null }
    }
    const expected = [segment.dxPxPerFrame * FPS, segment.dyPxPerFrame * FPS]
    const cosine = (item) => (item.x * expected[0] + item.y * expected[1]) / Math.max(1e-9, item.magnitude * expectedMagnitude)
    const limit = Math.cos(RULES.motion.directionMaxAngleDegrees * Math.PI / 180)
    const direction = observed.filter((item) => item.magnitude > 0 && cosine(item) >= limit)
    const medianMagnitude = median(observed.map((item) => item.magnitude))
    return { ...base, expectedVector: expected, directionShare: observed.length ? direction.length / observed.length : null,
      medianMagnitude, magnitudeRelError: medianMagnitude === null ? null : Math.abs(medianMagnitude - expectedMagnitude) / expectedMagnitude,
      medianResidual: median(observed.map((item) => item.residual)),
      quantised: expectedMagnitude >= RULES.motion.quantumPxPerFrame * FPS }
  })
  const expectedPairs = new Set(clock.expectedPairs())
  const observedPairs = [...scores.keys()]
  return {
    footageMinutes: observedPairs.length / FPS / 60, observedPairs: observedPairs.length, maxShotScore: observedPairs.length ? Math.max(...scores.values()) : null,
    hardCuts: matchedCuts, events, falseCutEvents, fadeRuns: runs, falseFadeRuns: falseRuns, fades, segments,
    insertEdgeScores: insertEdges.map((pair) => ({ pair, score: scores.get(pair) ?? null, flagged: events.some((event) => Math.abs(event.pair - pair) <= tolerance) })),
    pairSetExact: observedPairs.length === expectedPairs.size && observedPairs.every((pair) => expectedPairs.has(pair)),
    seamPairsObserved: clock.seamPairs().filter((pair) => scores.has(pair) || motion.has(pair)).length,
    expectedPairs: expectedPairs.size,
  }
}

export function aggregateTemporal(perClip) {
  const segments = perClip.flatMap((clip) => clip.segments)
  const still = segments.filter((segment) => segment.stationary)
  const moving = segments.filter((segment) => !segment.stationary && segment.quantised)
  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0)
  const observedStill = sum(still, (segment) => segment.observed)
  const cuts = perClip.flatMap((clip) => clip.hardCuts)
  const fades = perClip.flatMap((clip) => clip.fades)
  const minutes = sum(perClip, (clip) => clip.footageMinutes)
  const falseCount = sum(perClip, (clip) => clip.falseCutEvents.length + clip.falseFadeRuns.length)
  return {
    clips: perClip.length, footageMinutes: minutes, observedPairs: sum(perClip, (clip) => clip.observedPairs),
    shotScore: Math.max(0, ...perClip.map((clip) => clip.maxShotScore ?? 0)),
    staticVectorPxPerSecond: still.length ? Math.max(0, ...still.map((segment) => segment.maxVector ?? 0)) : null,
    residual: still.length ? Math.max(0, ...still.map((segment) => segment.maxResidual ?? 0)) : null,
    staticFalseMotionShare: observedStill ? sum(still, (segment) => segment.falseMotionPairs) / observedStill : null,
    falseBoundaries: falseCount, falseBoundariesPerMinute: minutes > 0 ? falseCount / minutes : null,
    hardCutLabels: cuts.length, hardCutRecall: cuts.length ? cuts.filter((cut) => cut.event).length / cuts.length : null,
    hardCutScore: cuts.length ? Math.min(...cuts.map((cut) => cut.score ?? 0)) : null,
    fadeEvents: fades.length, fadeRecallAtIou: fades.length ? fades.filter((fade) => fade.iou >= STRATA['crossfade-high-contrast'].criteria.fadeIouMin).length / fades.length : null,
    fadeIouMedian: median(fades.map((fade) => fade.iou)),
    movingSegments: moving.length,
    movingDirectionShare: moving.length ? Math.min(...moving.map((segment) => segment.directionShare ?? 0)) : null,
    movingMagnitudeRelError: moving.length ? Math.max(...moving.map((segment) => segment.magnitudeRelError ?? Infinity)) : null,
    movingCoverage: moving.length ? Math.min(...moving.map((segment) => segment.coverage ?? 0)) : null,
    movingResidualMedian: moving.length ? Math.max(...moving.map((segment) => segment.medianResidual ?? Infinity)) : null,
    seamPairsObserved: sum(perClip, (clip) => clip.seamPairsObserved), observedPairsExact: perClip.every((clip) => clip.pairSetExact),
    insertEdgeScores: perClip.flatMap((clip) => clip.insertEdgeScores),
    subQuantumSegments: segments.filter((segment) => !segment.stationary && !segment.quantised).map((segment) => ({
      expectedMagnitude: segment.expectedMagnitudePxPerSecond, medianMagnitude: segment.medianMagnitude, directionShare: segment.directionShare, observed: segment.observed })),
  }
}

// ------------------------------------------------------------------------------------------------------------ snapshot claims

export function evaluateClaims(evidence) {
  const state = (kind) => evidence.coverage.find((entry) => entry.kind === kind)
  const insert = state('image-insert')
  const insertObservations = evidence.observations.filter((observation) => observation.kind === 'image-insert').length
  const otherClaims = evidence.observations.filter((observation) => ['object', 'speaker', 'silence'].includes(observation.kind)).length
  return { imageInsertClaimed: insert?.state !== 'absent' || insertObservations > 0, imageInsertReasonCode: insert?.reasonCode ?? null,
    insertObservations, otherClaims, completeKinds: evidence.coverage.filter((entry) => entry.state === 'complete').map((entry) => entry.kind) }
}

/** Time-after-cuts OCR clock check: every OCR observation sits on the timeline frame the label's own EditPlan gives its source frame. */
export function evaluateOcrClock(entry, evidence) {
  const clock = clockOf(entry)
  const observations = evidence.observations.filter((observation) => observation.kind === 'ocr')
  const wrong = observations.filter((observation) => clock.sourceFrameToTimeline(observation.value.sourceFrame) !== observation.value.timelineFrame)
  const sampled = sampledTimelineFrames(evidence.coverage)
  const expected = []
  for (const clip of clock.clips) for (let frame = clip.sourceInFrame; frame < clip.sourceOutFrame; frame += 1) if (frame % OCR_INTERVAL === 0) expected.push(clock.sourceFrameToTimeline(frame))
  expected.sort((a, b) => a - b)
  const sameSamples = expected.length === sampled.length && expected.every((frame, index) => frame === sampled[index])
  return { observations: observations.length, misplaced: wrong.length, sameSamples, expectedSamples: expected.length }
}

// ------------------------------------------------------------------------------------------------------------ stratum verdicts

const COMPARATORS = Object.freeze({
  Min: (value, threshold) => value !== null && value >= threshold,
  Max: (value, threshold) => value !== null && value <= threshold,
})

/** Criterion key -> metric key. `xMin` / `xMax` compare metric `x`; booleans/equalities are listed explicitly. */
export function judge(stratumId, metrics) {
  const spec = STRATA[stratumId]
  const results = []
  for (const [key, threshold] of Object.entries(spec.criteria)) {
    if (key === 'fadeIouMin') continue
    let value
    let pass
    let rule
    if (key === 'imageInsertClaimed') {
      value = metrics.claims.imageInsertClaimed
      pass = value === threshold
      rule = `== ${threshold}`
    } else if (key === 'timelineFrameExact') {
      value = metrics.clock.every((item) => item.misplaced === 0 && item.sameSamples)
      pass = value === threshold
      rule = `== ${threshold}`
    } else if (key === 'seamPairsObserved') {
      value = metrics.temporal.seamPairsObserved
      pass = value === threshold
      rule = `== ${threshold}`
    } else if (key === 'observedPairsExact') {
      value = metrics.temporal.observedPairsExact
      pass = value === threshold
      rule = `== ${threshold}`
    } else {
      const direction = key.endsWith('Min') ? 'Min' : 'Max'
      const name = key.slice(0, -3)
      const source = name
      value = metrics.ocr && source in metrics.ocr ? metrics.ocr[source] : metrics.temporal?.[source] ?? null
      pass = COMPARATORS[direction](value, threshold)
      rule = `${direction === 'Min' ? '>=' : '<='} ${threshold}`
    }
    results.push({ criterion: key, value, rule, pass })
  }
  const verdict = results.length === 0 ? 'informational' : results.every((item) => item.pass) ? 'pass' : 'fail'
  return { verdict, criteria: results }
}
