/**
 * W63b acceptance criteria. Frozen BEFORE any producer was run on any split (see docs/quality/w63b-perception-label-eval-prereg.md,
 * which records the SHA-256 of this file; the evaluator refuses to run if it differs). A number here is never changed to fit an
 * output: a failing stratum is reported as failing, and the modality stays partial/review in the product.
 *
 * Where each number comes from (documented capability, not a measurement of this evaluation):
 *  - 0.03 / 2 px/s / 0.03 / 0.20 / 0.80: the W63 temporal preflight (docs/quality/w63-temporal-preflight.md) goldens;
 *  - 0.35: UNRELIABLE_CHANGE, the temporal analyzer's own gate between a usable and an unusable frame pair;
 *  - 12 px/frame: one 160x90 analysis-grid pixel at 1920x1080, the quantum of the translation estimator (search +-4 grid px);
 *  - text sizes: Tesseract's documented degradation below roughly 20 px capital height.
 */
export const PREREG_VERSION = 'w63b-prereg/v1'

/** Rules applied to the RAW measurements to compare them with boundary labels. They are evaluation rules, not product behaviour. */
export const RULES = Object.freeze({
  // Rule B (hard cut): a pair is flagged when its change score is >= floor AND >= ratio x the median of the (up to) `neighbours`
  // observed pairs on each side; adjacent flagged pairs are one event placed at the largest score.
  hardCut: Object.freeze({ floor: 0.10, ratio: 4, neighbours: 5, matchTolerancePairs: 1 }),
  // Rule C (crossfade): a pair is flagged when its score >= max(floor, ratio x median of observed pairs within +-window pairs);
  // a run is >= minRun consecutive flagged pairs.
  fadeRun: Object.freeze({ floor: 0.006, ratio: 3, window: 24, minRun: 3 }),
  // Motion
  motion: Object.freeze({ staticMaxPxPerSecond: 2, directionMaxAngleDegrees: 45, quantumPxPerFrame: 12 }),
  // Text: words are assigned to a label when their centre lies inside the label box grown by these margins (fractions of the frame);
  // words are then de-duplicated by confidence (a lower-confidence word overlapping a kept one by >= overlap of the smaller area is dropped).
  text: Object.freeze({ marginX: 0.01, marginYOfLabelHeight: 0.3, dedupeOverlap: 0.5, iouMin: 0.5 }),
})

const OCR_BASE = { spuriousPerSampleMax: 0.25 }

/**
 * Per stratum: `kind` selects the evaluator, `criteria` the pass/fail comparisons (all must hold). A stratum without criteria is
 * `informational`: it is measured and published, and it can neither pass nor fail.
 */
export const STRATA = Object.freeze({
  'text-normal': { kind: 'ocr', criteria: { exactRateMin: 0.90, meanCerMax: 0.03, iouShareMin: 0.90, ...OCR_BASE } },
  'text-small-20': { kind: 'ocr', criteria: { exactRateMin: 0.70, meanCerMax: 0.10, iouShareMin: 0.80, spuriousPerSampleMax: 0.5 } },
  'text-small-16': { kind: 'ocr', criteria: { exactRateMin: 0.50, meanCerMax: 0.20, iouShareMin: 0.70, spuriousPerSampleMax: 0.5 } },
  'text-small-12': { kind: 'ocr', criteria: { exactRateMin: 0.25, meanCerMax: 0.40, spuriousPerSampleMax: 1.0 } },
  'text-multilingual': { kind: 'ocr', criteria: { exactRateMin: 0.85, meanCerMax: 0.05, iouShareMin: 0.90, diacriticExactRateMin: 0.80, ...OCR_BASE } },
  static: { kind: 'temporal', criteria: { shotScoreMax: 0.03, staticVectorPxPerSecondMax: 2, residualMax: 0.03, falseBoundariesPerMinuteMax: 0 } },
  'hard-cut-high-contrast': { kind: 'temporal', criteria: { hardCutRecallMin: 1.0, hardCutScoreMin: 0.80, falseBoundariesPerMinuteMax: 1.0 } },
  'hard-cut-textured': { kind: 'temporal', criteria: { hardCutRecallMin: 0.90, falseBoundariesPerMinuteMax: 1.0, staticFalseMotionShareMax: 0.05 } },
  'crossfade-high-contrast': { kind: 'temporal', criteria: { fadeIouMin: 0.6, fadeRecallAtIouMin: 1.0, falseBoundariesPerMinuteMax: 1.0 } },
  'crossfade-low-contrast': { kind: 'temporal', criteria: {} },
  'pan-subquantum': { kind: 'temporal', criteria: {} },
  'pan-slow': { kind: 'temporal', criteria: { movingDirectionShareMin: 0.90, movingMagnitudeRelErrorMax: 0.25, movingCoverageMin: 0.90, movingResidualMedianMax: 0.20, staticFalseMotionShareMax: 0.05, falseBoundariesPerMinuteMax: 1.0 } },
  'pan-fast': { kind: 'temporal', criteria: { movingDirectionShareMin: 0.90, movingMagnitudeRelErrorMax: 0.25, movingCoverageMin: 0.90, movingResidualMedianMax: 0.20, staticFalseMotionShareMax: 0.05, falseBoundariesPerMinuteMax: 1.0 } },
  'inserted-image': { kind: 'temporal', criteria: { imageInsertClaimed: false, falseBoundariesPerMinuteMax: 1.0, staticFalseMotionShareMax: 0.05 } },
  'talking-head-synthetic': { kind: 'combined', criteria: { exactRateMin: 0.85, meanCerMax: 0.05, iouShareMin: 0.90, spuriousPerSampleMax: 0.25, staticFalseMotionShareMax: 0.05, falseBoundariesPerMinuteMax: 1.0 } },
  'audio-no-face': { kind: 'combined', criteria: { exactRateMin: 0.90, meanCerMax: 0.03, iouShareMin: 0.90, spuriousPerSampleMax: 0.25, staticFalseMotionShareMax: 0.05, falseBoundariesPerMinuteMax: 1.0 } },
  'time-after-cuts': { kind: 'time-after-cuts', criteria: { timelineFrameExact: true, exactRateMin: 0.85, hardCutRecallMin: 1.0, seamPairsObserved: 0, observedPairsExact: true, movingDirectionShareMin: 0.90, falseBoundariesPerMinuteMax: 1.0 } },
})

/** Strata whose clips carry no moving segment: Rule C (fade runs) is evaluated on them, and only on them. */
export const FADE_RULE_EXCLUDED_WHEN_MOVING = true

/** Robustness expectations (the W63a contract), evaluated by the runner. */
export const ROBUSTNESS = Object.freeze({
  duplicateEnvelope: 'the same idempotency key replays the same operation; the assembler lists exactly one DUPLICATE_ENVELOPE and keeps the timeline hash',
  gap: 'an unexamined range stays partial/absent: no kind other than a fully examined one is complete; image-insert/object/speaker/silence stay absent',
  reorder: 'a non-CFR/gapped-PTS source is refused by both producers (operation failed, no envelope row); the snapshot then carries no ocr/temporal input; the same evidence in reversed order assembles to the same snapshot hash',
  adversarialSource: 'envelope rows bound to other source bytes are refused at read (PERSISTENCE_CONFLICT); a source whose bytes differ from the declared SHA-256 is refused by the producers',
  replay: 'repeated and fresh-connection reads return the same snapshot hash and the same row',
})
