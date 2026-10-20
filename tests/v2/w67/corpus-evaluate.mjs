/**
 * W67 controlled corpus - the comparison of the critic's sealed reports with the labels the generator wrote before the first render.
 *
 * The unit is defect x format x interval. For each output and each defect class the critic's FLAGGED frames are the frames covered by a
 * hard issue of that class (a code, and for ink codes the overlay kind). Against the labelled interval I of that class:
 *   - detected         : flagged frames == I exactly (a cue is never shifted by one frame to dodge a collision, and the adjacent frames
 *                        are negatives);
 *   - missed           : the class has a label and flagged does not cover I; its frames of I that the critic judged `pass` make the
 *                        unit FALSE-SAFE, frames it judged `unknown` make it unknown;
 *   - extra frames     : flagged frames outside I (or any flagged frame of a class with no label) are false positives, by frame and by
 *                        critic range.
 * Any hard issue of an unmapped code is a false positive too, and every unknown (a check the pixels could not establish) is counted:
 * the acceptance threshold is zero false-safe, 100% recall, 100% precision and zero unknown. Nothing here is tuned to a result.
 */
export const CLASSES = Object.freeze({
  'caption-over-face': { codes: ['SUBTITLE_FACE_OVERLAP_IN_PIXELS'], kind: null, check: 'captionFaceOverlap' },
  'crop-lost': { codes: ['SUBJECT_NOT_VISIBLE_IN_PIXELS', 'SUBJECT_CLIPPED_IN_PIXELS'], kind: null, check: 'subjectVisibility' },
  'cta-outside-safe-area': { codes: ['INK_OUTSIDE_SAFE_AREA_IN_PIXELS', 'INK_CLIPPED_BY_CANVAS_IN_PIXELS'], kind: 'cta', check: 'safeArea' },
})
/** Checks that are part of a class' evidence: a frame `unknown` in the class' own check is an unknown of that unit. */
const OTHER_CHECKS = Object.freeze(['ctaFaceOverlap', 'canvasClipping', 'density'])

const range = (start, end) => Array.from({ length: Math.max(0, end - start) }, (_unused, index) => start + index)
const covers = (issue, frame) => frame >= issue.evidenceRange.startFrame && frame < issue.evidenceRange.endFrame
const classOfIssue = (issue) => Object.entries(CLASSES).find(([, spec]) => spec.codes.includes(issue.code) && (spec.kind === null || issue.elementIds.some((id) => id.endsWith(`:${spec.kind}`)) ))?.[0] ?? null

/** Frames of a report the class flags. */
export function flaggedFrames(report, className) {
  const frames = new Set()
  for (const issue of report.issues) {
    if (issue.severity !== 'hard' || classOfIssue(issue) !== className) continue
    for (const frame of range(issue.evidenceRange.startFrame, issue.evidenceRange.endFrame)) frames.add(frame)
  }
  return frames
}

const verdictsOf = (report, check) => new Map(report.samples.map((sample) => [sample.frameIndex, sample.verdict.checks[check].verdict]))

export function evaluateOutput({ outputId, format, variant, labels, report }) {
  const units = []
  const frameFacts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 }
  for (const [className, spec] of Object.entries(CLASSES)) {
    const label = labels.find((entry) => entry.defect === className) ?? null
    const flagged = flaggedFrames(report, className)
    const verdicts = verdictsOf(report, spec.check)
    const interval = label ? new Set(range(label.startFrame, label.endFrame)) : new Set()
    const inside = [...flagged].filter((frame) => interval.has(frame))
    const outside = [...flagged].filter((frame) => !interval.has(frame))
    const exact = label !== null && inside.length === interval.size && outside.length === 0
    const missedFrames = label ? [...interval].filter((frame) => !flagged.has(frame)) : []
    const falseSafeFrames = missedFrames.filter((frame) => verdicts.get(frame) === 'pass' || verdicts.get(frame) === 'not-applicable')
    const unknownFrames = [...verdicts].filter(([, verdict]) => verdict === 'unknown').map(([frame]) => frame)
    frameFacts.truePositive += inside.length
    frameFacts.falsePositive += outside.length
    frameFacts.falseNegative += missedFrames.length
    frameFacts.trueNegative += report.samples.length - inside.length - outside.length - missedFrames.length
    units.push({
      outputId, format, variant, className, labelled: label !== null, interval: label ? [label.startFrame, label.endFrame] : null,
      flaggedFrames: flagged.size, insideFrames: inside.length, outsideFrames: outside.length, exact,
      detected: label !== null && inside.length > 0, falseSafe: label !== null && falseSafeFrames.length > 0, falseSafeFrames: falseSafeFrames.length,
      missedFrames: missedFrames.length, unknownFrames: unknownFrames.length,
      // a critic range that does not overlap the label (or any range of an unlabelled class) is a false-positive unit
      falsePositiveUnit: outside.length > 0 || (label === null && flagged.size > 0),
    })
  }
  const mapped = new Set(Object.values(CLASSES).flatMap((spec) => spec.codes))
  const unmappedHard = report.issues.filter((issue) => issue.severity === 'hard' && (!mapped.has(issue.code) || classOfIssue(issue) === null))
    .map((issue) => ({ code: issue.code, range: [issue.evidenceRange.startFrame, issue.evidenceRange.endFrame], elementIds: issue.elementIds }))
  const unknownByCheck = {}
  for (const sample of report.samples) {
    for (const [check, result] of Object.entries(sample.verdict.checks)) {
      if (result.verdict === 'unknown') unknownByCheck[check] = (unknownByCheck[check] ?? 0) + 1
    }
  }
  const warnings = report.issues.filter((issue) => issue.severity === 'warning').map((issue) => ({ code: issue.code, range: [issue.evidenceRange.startFrame, issue.evidenceRange.endFrame], message: issue.message }))
  return { outputId, format, variant, units, unmappedHard, unknownByCheck, warnings, decode: report.decode.status, verdict: report.verdict, frameFacts, otherChecks: OTHER_CHECKS.map((check) => [check, report.checks[check].verdict]) }
}

const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator)

/** Aggregates per class x format and overall, and decides acceptance against the frozen threshold. */
export function summarize(evaluations) {
  const rows = []
  const groups = new Map()
  for (const evaluation of evaluations) for (const unit of evaluation.units) {
    const key = `${unit.className}|${unit.format}`
    groups.set(key, [...(groups.get(key) ?? []), unit])
  }
  for (const [key, units] of [...groups].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const [className, format] = key.split('|')
    const labelled = units.filter((unit) => unit.labelled)
    rows.push({
      className, format, labelledUnits: labelled.length, detectedUnits: labelled.filter((unit) => unit.detected).length, exactUnits: labelled.filter((unit) => unit.exact).length,
      falseSafeUnits: labelled.filter((unit) => unit.falseSafe).length, unlabelledUnits: units.length - labelled.length, falsePositiveUnits: units.filter((unit) => unit.falsePositiveUnit).length,
      extraFrames: units.reduce((sum, unit) => sum + unit.outsideFrames, 0), unknownFrames: units.reduce((sum, unit) => sum + unit.unknownFrames, 0),
    })
  }
  const labelledUnits = rows.reduce((sum, row) => sum + row.labelledUnits, 0)
  const exactUnits = rows.reduce((sum, row) => sum + row.exactUnits, 0)
  const detectedUnits = rows.reduce((sum, row) => sum + row.detectedUnits, 0)
  const falseSafeUnits = rows.reduce((sum, row) => sum + row.falseSafeUnits, 0)
  const falsePositiveUnits = rows.reduce((sum, row) => sum + row.falsePositiveUnits, 0)
  const unknownFrames = evaluations.reduce((sum, evaluation) => sum + Object.values(evaluation.unknownByCheck).reduce((a, b) => a + b, 0), 0)
  const unmappedHard = evaluations.reduce((sum, evaluation) => sum + evaluation.unmappedHard.length, 0)
  const decodeFailures = evaluations.filter((evaluation) => evaluation.decode !== 'complete').length
  // precision at unit level: units the critic got exactly right over those plus the units it polluted with frames that are not defect
  const precision = rate(exactUnits, exactUnits + falsePositiveUnits)
  const accepted = labelledUnits > 0 && detectedUnits === labelledUnits && exactUnits === labelledUnits && falseSafeUnits === 0 && falsePositiveUnits === 0 &&
    unmappedHard === 0 && unknownFrames === 0 && decodeFailures === 0
  return {
    rows, totals: { outputs: evaluations.length, labelledUnits, detectedUnits, exactUnits, recallDetected: rate(detectedUnits, labelledUnits), recallExact: rate(exactUnits, labelledUnits), falseSafeUnits, falsePositiveUnits, precisionExact: precision, unmappedHard, unknownFrames, decodeFailures },
    thresholds: { falseSafeUnits: 0, recall: 1, precision: 1, unknownFrames: 0, decodeFailures: 0 }, accepted,
  }
}
