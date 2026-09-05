import assert from 'node:assert/strict'
import test from 'node:test'

import {
  correlateAudioWindows,
  createCorrelationPlan,
  scoreAt,
} from '../../src/v2/infrastructure/media/ffmpeg-playback-fingerprint.ts'

/**
 * T-F4.012 — the lag search, on and off the grid.
 *
 * The F4.015 correlator has two search modes and they are not two speeds of one
 * answer. `grid` samples the offsets on a stride of an eighth of the needle;
 * the correlation of audio against itself has a main lobe about one sample
 * wide, so an off-grid peak is not located imprecisely, it is not seen at all.
 * Both F4.015 fixtures place their lags at integer seconds, which are multiples
 * of the stride, so nothing there could have shown this.
 *
 * These cases are synthetic arrays and no FFmpeg: the failure is arithmetic,
 * and proving it through a codec would only make it slower to read.
 */

const SAMPLE_RATE = 2_000

/** One second per sweep, each second a different one, all below Nyquist. */
function sweepSeconds(count) {
  const samples = new Float64Array(count * SAMPLE_RATE)
  for (let second = 0; second < count; second += 1) {
    const start = 180 + 13 * ((second * 7) % count)
    const span = second % 2 === 0 ? 150 : -150
    for (let index = 0; index < SAMPLE_RATE; index += 1) {
      const t = index / SAMPLE_RATE
      samples[second * SAMPLE_RATE + index] =
        0.55 * Math.sin(2 * Math.PI * (start * t + (span * t * t) / 2))
    }
  }
  return samples
}

function measureFirstLag(reference, candidate, search) {
  const windows = correlateAudioWindows({
    reference,
    candidate,
    sampleRate: SAMPLE_RATE,
    windowMs: 2_000,
    hopMs: 2_000,
    correlationRate: SAMPLE_RATE,
    ...(search ? { search } : {}),
  })
  return windows[0]
}

test('T-F4.012 the grid search cannot see a lag that falls between its samples', () => {
  const reference = sweepSeconds(20)
  // A needle of 2 s at 2 kHz gives a stride of 500 samples. 4 000 is a multiple
  // of it and 4 137 is not, which is the only difference between these two.
  const onGrid = reference.slice(4_000, 4_000 + 8 * SAMPLE_RATE)
  const offGrid = reference.slice(4_137, 4_137 + 8 * SAMPLE_RATE)

  const gridOnGrid = measureFirstLag(reference, onGrid, 'grid')
  const gridOffGrid = measureFirstLag(reference, offGrid, 'grid')
  const exhaustiveOffGrid = measureFirstLag(reference, offGrid, 'exhaustive')

  assert.equal(gridOnGrid.lagSamples, 4_000, 'a lag on the stride is found exactly')
  assert.equal(exhaustiveOffGrid.lagSamples, 4_137, 'every offset is scored, so the true one wins')
  assert.notEqual(
    gridOffGrid.lagSamples,
    4_137,
    'if the grid search ever finds an off-grid lag, this whole search mode can be deleted',
  )
  // The failure is not a near miss. It is a different place in the recording,
  // reported with a peak ratio that reads like a clean lock.
  console.log(
    `T-F4.012 off-grid lag 4137: grid=${gridOffGrid.lagSamples} (peak ${gridOffGrid.peak.toFixed(3)}, ` +
    `ratio ${gridOffGrid.peakRatio.toFixed(2)}) exhaustive=${exhaustiveOffGrid.lagSamples} ` +
    `(peak ${exhaustiveOffGrid.peak.toFixed(3)}, ratio ${exhaustiveOffGrid.peakRatio.toFixed(2)})`,
  )
  assert.ok(
    exhaustiveOffGrid.peak > gridOffGrid.peak,
    'the exhaustive winner must be at least as good as the grid winner, by construction',
  )
})

test('T-F4.012 the transform agrees with the direct correlation it replaces', () => {
  // The transform is only worth having if it computes the same number the
  // obvious loop does. Every offset is compared, not a sample of them.
  const reference = sweepSeconds(6)
  const needle = reference.slice(3_500, 3_500 + 1_024)
  let needleEnergy = 0
  for (const value of needle) needleEnergy += value * value
  needleEnergy = Math.sqrt(needleEnergy)

  const plan = createCorrelationPlan(reference, needle.length)
  const scores = plan.correlate(needle, needleEnergy)

  let worst = 0
  for (let offset = 0; offset <= plan.available; offset += 1) {
    worst = Math.max(worst, Math.abs(scores[offset] - scoreAt(reference, needle, offset, needleEnergy)))
  }
  console.log(`T-F4.012 transform vs direct: ${plan.available + 1} offsets, worst difference ${worst.toExponential(2)}`)
  assert.ok(worst < 1e-9, `worst difference ${worst} between the transform and the direct correlation`)
  assert.equal(scores.indexOf(Math.max(...scores)), 3_500)
})

test('T-F4.012 a needle longer than the reference is refused rather than searched', () => {
  const reference = sweepSeconds(2)
  const candidate = sweepSeconds(4)
  const windows = correlateAudioWindows({
    reference,
    candidate,
    sampleRate: SAMPLE_RATE,
    windowMs: 3_000,
    hopMs: 3_000,
    correlationRate: SAMPLE_RATE,
    search: 'exhaustive',
  })
  // The window does not fit inside the reference, so there is no offset to
  // report. Null, never zero: zero names the first sample of the reference as
  // the answer.
  assert.ok(windows.every((window) => window.lagSamples === null))
})
