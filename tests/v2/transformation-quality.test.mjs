import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MANDATORY_TRANSFORMATION_CRITIC_DIMENSIONS,
  TRANSFORMATION_CRITIC_DIMENSIONS,
  assertTransformationCriticReport,
  createTransformationCriticReport,
  isTransformationApproval,
  rejectedProtectedContent,
} from '../../src/v2/domain/transformation-critic-report.ts'
import {
  assertTransformationFallbackLedger,
  availableFallbackActions,
  createTransformationFallbackLedger,
  descendFallbackLadder,
  isValidFallbackAttempt,
  minimumIntentScoreBps,
  nextFallbackRung,
  recordFallbackAttempt,
  resolveFallbackLadder,
} from '../../src/v2/domain/transformation-fallback.ts'
import { createTransformationBrief } from '../../src/v2/domain/transformation-brief.ts'

const digest = (character) => character.repeat(64)

const BRIEF = createTransformationBrief({
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  projectVersionId: 'version-1',
  storyPlanId: 'story-1',
  storyPlanHash: digest('b'),
  sourceArtifactId: 'artifact-source',
  sourceArtifactHash: digest('c'),
  sourceRange: { startFrame: 30, endFrame: 210 },
  intent: 'world-shift',
  editorialIntent: 'Colocar o especialista numa vila medieval para ilustrar gestão de tráfego medieval.',
  mode: 'background-replacement',
  prompt: 'Medieval British village street at midday.',
  negativeConstraints: ['no weapons'],
  preserve: ['identity', 'lips', 'expression', 'body-motion', 'wardrobe', 'speech', 'foreground'],
  allowedChanges: ['background'],
  target: { era: 'medieval' },
  outputSpecIds: ['output-spec-16x9'],
  intensityBps: 6_500,
  noveltyBps: 7_000,
  safety: ['no-identity-change'],
  safeZones: [{ x: 0.32, y: 0.08, width: 0.36, height: 0.62, purpose: 'subject' }],
  fallbackLadder: ['video-to-video', 'actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged'],
  rightsSnapshotId: 'rights-1',
  rightsSnapshotHash: digest('d'),
  identitySnapshotId: 'identity-1',
  identitySnapshotHash: digest('e'),
  createdAt: '2029-03-01T10:00:00.000Z',
})

function ledger() {
  return createTransformationFallbackLedger({
    workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    brief: BRIEF, sourceArtifactId: 'artifact-source', sourceArtifactSha256: digest('c'),
    costCurrency: 'USD', createdAt: '2029-03-01T10:00:00.000Z',
  })
}

function attempt(overrides) {
  return {
    rung: 'video-to-video',
    providerJobId: 'provider-job-1',
    providerId: 'atelier-v2v',
    artifactId: 'transformation-result-1',
    artifactSha256: digest('1'),
    outcome: 'approved',
    intentScoreBps: 8_600,
    criticReportHash: digest('9'),
    violatesProtectedContent: false,
    estimatedCostMinorUnits: 900,
    observedCostMinorUnits: 900,
    costCurrency: 'USD',
    reason: 'video-to-video produced a usable result',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// F3.015 — fallback ladder
// ---------------------------------------------------------------------------

test('T-FR-115 the ladder may skip rungs but never reorder them, and always has a floor', () => {
  assert.deepEqual(resolveFallbackLadder(BRIEF), [
    'video-to-video', 'actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged',
  ])
  const skipping = createTransformationBrief({ ...BRIEF, fallbackLadder: ['video-to-video', 'source-unchanged'] })
  assert.deepEqual(resolveFallbackLadder(skipping), ['video-to-video', 'source-unchanged'])

  // Inverting the ladder would mean preferring a cutaway over a video-to-video
  // that worked.
  assert.throws(
    () => resolveFallbackLadder(createTransformationBrief({ ...BRIEF, fallbackLadder: ['generated-cutaway', 'video-to-video', 'source-unchanged'] })),
    /never reorder/,
  )
  // A ladder with no floor is a workflow that runs out of options with nothing
  // to fall back to. The brief aggregate refuses it outright.
  assert.throws(
    () => createTransformationBrief({ ...BRIEF, fallbackLadder: ['video-to-video', 'actor-composite'] }),
    /must end with source-unchanged/,
  )
  assert.equal(nextFallbackRung(resolveFallbackLadder(BRIEF), 'source-unchanged'), null)
})

test('T-FR-115 a protected-content violation can never become the best artifact', () => {
  // The whole reason this rule is explicit: the violating result here scores
  // 9_900 on intent — better than anything else in the ledger — and is still
  // disqualified. Aesthetics do not buy back a changed face.
  const beautifulAndWrong = attempt({
    intentScoreBps: 9_900, violatesProtectedContent: true, outcome: 'rejected',
    artifactId: 'transformation-result-wrong', artifactSha256: digest('2'),
    reason: 'stunning, and it changed the subject wardrobe',
  })
  assert.equal(isValidFallbackAttempt(beautifulAndWrong), false)

  let state = recordFallbackAttempt({ ledger: ledger(), attempt: beautifulAndWrong, occurredAt: '2029-03-01T10:01:00.000Z' })
  assert.equal(state.bestArtifactId, null)
  assert.equal(state.incurredCostMinorUnits, 900, 'a rejected provider result was still paid for')

  state = descendFallbackLadder({ ledger: state, because: 'critic-rejected-protected-content', occurredAt: '2029-03-01T10:02:00.000Z' })
  assert.equal(state.currentRung, 'actor-composite')
  assert.match(state.attempts.at(-1).reason, /no amount of visual quality buys that back/)

  state = recordFallbackAttempt({
    ledger: state,
    attempt: attempt({ rung: 'actor-composite', intentScoreBps: 7_400, artifactId: 'transformation-result-composite', artifactSha256: digest('3'), observedCostMinorUnits: 600, reason: 'composite preserved the subject' }),
    occurredAt: '2029-03-01T10:03:00.000Z',
  })
  assert.equal(state.bestArtifactId, 'transformation-result-composite')
  // Cost accumulates across every attempt, including the one that was thrown away.
  assert.equal(state.incurredCostMinorUnits, 1_500)

  // A stored ledger that claims a violating artifact as best is corrupt, not
  // merely unusual — and the dedicated invariant fires before the hash check,
  // so the error says *what* is wrong and not merely *that* something is.
  assert.throws(
    () => assertTransformationFallbackLedger({ ...state, bestArtifactId: 'transformation-result-wrong' }),
    /names an artifact that violates protected content as its best/,
  )
})

test('T-FR-115 no derivative may claim the source identity, and keeping the source is free', () => {
  assert.throws(
    () => recordFallbackAttempt({
      ledger: ledger(),
      attempt: attempt({ artifactId: 'artifact-source' }),
      occurredAt: '2029-03-01T10:01:00.000Z',
    }),
    /never claim the source artifact/,
  )
  assert.throws(
    () => recordFallbackAttempt({
      ledger: ledger(),
      attempt: attempt({ rung: 'source-unchanged', artifactId: 'transformation-result-x', observedCostMinorUnits: 0 }),
      occurredAt: '2029-03-01T10:01:00.000Z',
    }),
    /produces no artifact/,
  )
})

test('T-FR-115 a ladder descends and never climbs back', () => {
  let state = descendFallbackLadder({ ledger: ledger(), because: 'capability-unavailable', occurredAt: '2029-03-01T10:01:00.000Z' })
  assert.equal(state.currentRung, 'actor-composite')
  assert.match(state.attempts.at(-1).reason, /without contacting an incompatible one/)
  assert.throws(
    () => recordFallbackAttempt({ ledger: state, attempt: attempt({ rung: 'video-to-video' }), occurredAt: '2029-03-01T10:02:00.000Z' }),
    /never climbs back/,
  )
})

test('T-FR-115 lower rungs are held to a lower bar, never to no bar', () => {
  assert.ok(minimumIntentScoreBps('video-to-video') > minimumIntentScoreBps('actor-composite'))
  assert.ok(minimumIntentScoreBps('actor-composite') > minimumIntentScoreBps('generated-cutaway'))
  assert.ok(minimumIntentScoreBps('generated-cutaway') > minimumIntentScoreBps('still-parallax'))
  assert.equal(minimumIntentScoreBps('source-unchanged'), 0)

  // A still-parallax that says nothing is still a failure.
  assert.equal(isValidFallbackAttempt(attempt({ rung: 'still-parallax', intentScoreBps: 5_999 })), false)
  assert.equal(isValidFallbackAttempt(attempt({ rung: 'still-parallax', intentScoreBps: 6_000 })), true)
})

test('T-FR-115 review offers exactly the actions the ledger can honour', () => {
  const fresh = ledger()
  // Nothing valid yet: accepting is not on the table, and saying so is more
  // honest than offering a button that fails.
  assert.deepEqual(availableFallbackActions(fresh), ['descend', 'keep-source'])

  const withResult = recordFallbackAttempt({ ledger: fresh, attempt: attempt(), occurredAt: '2029-03-01T10:01:00.000Z' })
  assert.deepEqual(availableFallbackActions(withResult), ['accept', 'retry', 'descend', 'keep-source'])

  // Keeping the source is a decision, always available, and never an error.
  const atFloor = ['actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged'].reduce(
    (state, _rung, index) => descendFallbackLadder({ ledger: state, because: 'no-improvement', occurredAt: `2029-03-01T10:1${index}:00.000Z` }),
    fresh,
  )
  assert.equal(atFloor.currentRung, 'source-unchanged')
  assert.ok(availableFallbackActions(atFloor).includes('keep-source'))
  assert.equal(availableFallbackActions(atFloor).includes('descend'), false)
})

test('T-FR-115 a second currency would make the incurred total a number with no unit', () => {
  assert.throws(
    () => recordFallbackAttempt({
      ledger: ledger(),
      attempt: attempt({ costCurrency: 'BRL' }),
      occurredAt: '2029-03-01T10:01:00.000Z',
    }),
    /number with no unit/,
  )
})

// ---------------------------------------------------------------------------
// F3.016 — transformation critic
// ---------------------------------------------------------------------------

const EVALUATORS = [
  { id: 'ffprobe-integrity', kind: 'measured', version: '1.0.0', scope: 'decodability, duration, frame count and stream geometry read from the bytes' },
  { id: 'region-differ', kind: 'measured', version: '1.0.0', scope: 'per-region pixel difference between source and result inside declared safe zones' },
  { id: 'controlled-identity-probe', kind: 'controlled', version: '1.0.0', scope: 'deterministic stand-in for a perceptual identity model that is not deployed; it is not a production visual evaluation' },
]

function measurement(dimension, overrides = {}) {
  return {
    dimension,
    status: 'measured',
    evaluatorId: 'region-differ',
    scoreBps: 9_000,
    thresholdBps: 7_000,
    frameRange: null,
    region: null,
    ...overrides,
  }
}

function unavailable(dimension, note) {
  return { dimension, status: 'unavailable', scoreBps: null, thresholdBps: null, frameRange: null, region: null, note }
}

function report(overrides = {}) {
  const measurements = TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) => measurement(dimension))
  return createTransformationCriticReport({
    workspaceId: 'workspace-1', projectId: 'project-1',
    briefId: BRIEF.id, briefHash: BRIEF.briefHash,
    providerJobId: 'provider-job-1',
    policyId: 'transformation-critic-policy-v1', policyHash: digest('a'),
    sourceArtifactId: 'artifact-source', sourceArtifactSha256: digest('c'),
    resultArtifactId: 'transformation-result-1', resultArtifactSha256: digest('1'),
    evaluators: EVALUATORS,
    measurements,
    issues: [],
    hardGates: [],
    decision: 'approved',
    action: 'approve',
    confidenceBps: null,
    intentScoreBps: 8_600,
    evaluatedAt: '2029-03-01T10:05:00.000Z',
    ...overrides,
  })
}

test('T-FR-116 every dimension answers, and silence is never a pass', () => {
  const approved = report()
  assert.equal(approved.measurements.length, TRANSFORMATION_CRITIC_DIMENSIONS.length)
  assert.equal(isTransformationApproval(approved), true)
  assert.equal(assertTransformationCriticReport(approved), approved)

  // An omitted dimension is not "fine", it is unknown.
  assert.throws(
    () => report({ measurements: TRANSFORMATION_CRITIC_DIMENSIONS.slice(1).map((dimension) => measurement(dimension)) }),
    /was not answered/,
  )
  // A dimension that could not be measured has to say why, in words.
  assert.throws(
    () => report({
      measurements: TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) =>
        dimension === 'anatomy' ? { ...unavailable(dimension, 'short'), note: 'short' } : measurement(dimension)),
    }),
    /must explain itself/,
  )
  // And it cannot carry a score it did not earn.
  assert.throws(
    () => report({
      measurements: TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) =>
        dimension === 'anatomy'
          ? { ...unavailable(dimension, 'no anatomy model is deployed for this material'), scoreBps: 9_000 }
          : measurement(dimension)),
    }),
    /cannot carry a score/,
  )
})

test('T-FR-116 a protected-content violation is a hard gate no aesthetic score can buy back', () => {
  const rejected = report({
    measurements: TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) =>
      dimension === 'preserve-list'
        ? measurement(dimension, { scoreBps: 2_000, frameRange: { startFrame: 30, endFrame: 210 }, region: { x: 0.32, y: 0.08, width: 0.36, height: 0.62 } })
        // Everything else is close to perfect. That is the point.
        : measurement(dimension, { scoreBps: 9_800 })),
    issues: [{
      dimension: 'preserve-list', severity: 'blocking',
      frameRange: { startFrame: 96, endFrame: 152 },
      region: { x: 0.34, y: 0.30, width: 0.28, height: 0.34 },
      violatedPreserve: 'wardrobe',
      description: 'the subject tunic changed colour and cut inside the protected subject zone',
    }],
    hardGates: ['preserve-list'],
    decision: 'rejected',
    action: 'fallback',
    intentScoreBps: 9_700,
  })
  assert.equal(isTransformationApproval(rejected), false)
  assert.equal(rejectedProtectedContent(rejected), true)
  assert.equal(rejected.issues[0].violatedPreserve, 'wardrobe')
  // Localized, not a global verdict: an editor can go straight to the frames.
  assert.deepEqual(rejected.issues[0].frameRange, { startFrame: 96, endFrame: 152 })

  // A hard gate with an approval is refused by the aggregate itself, even when
  // the gate is fully evidenced.
  const evidencedGate = {
    hardGates: ['preserve-list'],
    issues: [{
      dimension: 'preserve-list', severity: 'blocking',
      frameRange: { startFrame: 96, endFrame: 152 }, region: null,
      violatedPreserve: 'wardrobe',
      description: 'the subject tunic changed inside the protected zone',
    }],
  }
  assert.throws(
    () => report({ ...evidencedGate, decision: 'approved', action: 'approve' }),
    /only be a rejection/,
  )
  // And a hard gate has to be backed by something an editor can look at: a gate
  // with no localized issue is an assertion nobody can check.
  assert.throws(() => report({ hardGates: ['identity'], decision: 'rejected', action: 'fallback' }), /backed by a blocking issue/)
})

test('T-FR-116 missing evidence on a mandatory dimension fails closed', () => {
  for (const dimension of MANDATORY_TRANSFORMATION_CRITIC_DIMENSIONS) {
    const measurements = TRANSFORMATION_CRITIC_DIMENSIONS.map((entry) =>
      entry === dimension
        ? unavailable(entry, 'the probe that answers this dimension did not run on this material')
        : measurement(entry))
    // "We could not tell" is not "it is fine".
    assert.throws(
      () => report({ measurements, decision: 'approved', action: 'approve' }),
      /can only produce evidence-unavailable/,
      `${dimension} without evidence must not be approvable`,
    )
    const held = report({ measurements, decision: 'evidence-unavailable', action: 'review' })
    assert.equal(isTransformationApproval(held), false)
    assert.equal(held.action, 'review')
  }
  // Missing evidence is a question for a human, never an automatic retry.
  assert.throws(
    () => report({
      measurements: TRANSFORMATION_CRITIC_DIMENSIONS.map((entry) =>
        entry === 'risk' ? unavailable(entry, 'the risk classifier is not deployed for this locale') : measurement(entry)),
      decision: 'evidence-unavailable', action: 'retry',
    }),
    /never an automatic retry/,
  )
})

test('T-FR-116 evaluators declare what they are, and controlled is never called measured', () => {
  const approved = report()
  const controlled = approved.evaluators.filter((evaluator) => evaluator.kind === 'controlled')
  assert.equal(controlled.length, 1)
  // The scope has to say so in words, because a number attached to a lie is
  // worse than no number.
  assert.match(controlled[0].scope, /not a production visual evaluation/)
  assert.throws(
    () => report({ evaluators: [{ id: 'nameless', kind: 'measured', version: '1.0.0', scope: 'short' }] }),
    /what it can and cannot speak to/,
  )
  // A measurement without an evaluator is an opinion.
  assert.throws(
    () => report({
      measurements: TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) =>
        dimension === 'identity' ? { ...measurement(dimension), evaluatorId: 'not-declared' } : measurement(dimension)),
    }),
    /must name a declared evaluator/,
  )
})

test('T-FR-116 the report is content-addressed and rejects tampering', () => {
  const original = report()
  assert.equal(original.id, `transformation-critic-${original.reportHash.slice(0, 32)}`)
  assert.throws(() => assertTransformationCriticReport({ ...original, decision: 'rejected' }), /hash does not match/)
  assert.throws(() => assertTransformationCriticReport({ ...original, id: 'transformation-critic-forged' }), /id does not match/)
  // Source and result are both named, so a report can never be re-attached to a
  // different pair of bytes than the one it judged.
  assert.equal(original.sourceArtifactSha256, digest('c'))
  assert.equal(original.resultArtifactSha256, digest('1'))
})

test('T-FR-116 confidence stays null when nothing produced one', () => {
  // No model here emits a calibrated confidence, so the field says null rather
  // than inventing a plausible number.
  assert.equal(report().confidenceBps, null)
  assert.equal(report({ confidenceBps: 7_000 }).confidenceBps, 7_000)
  assert.throws(() => report({ confidenceBps: 10_001 }), /basis points/)
})
