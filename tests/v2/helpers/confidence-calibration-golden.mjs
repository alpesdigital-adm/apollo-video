/** Calibration samples for the decision-confidence tests. Test content, not product: the Director calibrates on the decisions of each real run. */
export const CONFIDENCE_CALIBRATION_GOLDEN = Object.freeze({
  datasetId: 'confidence-golden-v1',
  calibrationVersion: 'director-confidence-2026-08-v1',
  bins: 5,
  maximumEce: 0.18,
  samples: Object.freeze([
    { id: 'sample-01', predicted: 0.95, correct: true },
    { id: 'sample-02', predicted: 0.9, correct: true },
    { id: 'sample-03', predicted: 0.82, correct: true },
    { id: 'sample-04', predicted: 0.78, correct: true },
    { id: 'sample-05', predicted: 0.7, correct: false },
    { id: 'sample-06', predicted: 0.62, correct: true },
    { id: 'sample-07', predicted: 0.55, correct: false },
    { id: 'sample-08', predicted: 0.4, correct: false },
    { id: 'sample-09', predicted: 0.25, correct: false },
    { id: 'sample-10', predicted: 0.1, correct: false },
  ]),
})
