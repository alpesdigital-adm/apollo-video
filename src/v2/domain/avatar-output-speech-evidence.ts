import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const AVATAR_AUDIO_COMPARISON_POLICY_VERSION = 'avatar-audio-pcm-comparison/1.1.0' as const
export const AVATAR_OUTPUT_SPEECH_EVIDENCE_VERSION = 'avatar-output-speech-evidence/v1' as const

export interface AvatarAudioComparison {
  policyVersion: typeof AVATAR_AUDIO_COMPARISON_POLICY_VERSION
  sourcePcmSha256: string
  outputPcmSha256: string
  sampleRateHz: 16_000
  sourceDurationMs: number
  outputDurationMs: number
  alignedLagSamples: number
  comparedSampleCount: number
  sourceCoverageBps: number
  outputCoverageBps: number
  correlationBps: number
  normalizedErrorBps: number
  worstWindowCorrelationBps: number
  worstWindowNormalizedErrorBps: number
  failedWindowCount: number
  comparedWindowCount: number
  sourceRmsBps: number
  outputRmsBps: number
  passed: boolean
}

export interface AvatarOutputSpeechEvidence extends AvatarAudioComparison {
  schemaVersion: typeof AVATAR_OUTPUT_SPEECH_EVIDENCE_VERSION
  jobId: string
  videoArtifactId: string
  videoArtifactSha256: string
  sourceAudioArtifactId: string
  sourceAudioRangeHash: string
  speechEvidence: Readonly<{
    kind: 'measured' | 'controlled'
    evaluatorId: string
    evaluatorVersion: string
    outputTranscriptHash: string
    observedIdentityRef: string
  }>
  evidenceHash: string
}

const SAMPLE_RATE = 16_000
const MAX_LAG_SAMPLES = 1_600
const MAX_DURATION_DELTA_MS = 80
const MIN_CORRELATION_BPS = 9_200
const MAX_NORMALIZED_ERROR_BPS = 3_500
const MIN_RMS_BPS = 20
const WINDOW_SAMPLES = 4_000
const MIN_WINDOW_CORRELATION_BPS = 8_500
const MAX_WINDOW_ERROR_BPS = 5_000
const CONSISTENT_SILENCE_RMS_BPS = 80
const CONSISTENT_SILENCE_ERROR_BPS = 100

function pcmHash(samples: Int16Array): string {
  return createHash('sha256').update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex')
}

function durationMs(samples: Int16Array): number {
  return Math.round(samples.length * 1_000 / SAMPLE_RATE)
}

function rmsBps(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let squares = 0
  for (const sample of samples) squares += sample * sample
  return Math.round(Math.sqrt(squares / samples.length) * 10_000 / 32_768)
}

function scoreAtLag(source: Int16Array, output: Int16Array, lag: number, stride: number) {
  const sourceStart = lag < 0 ? -lag : 0
  const outputStart = lag > 0 ? lag : 0
  const count = Math.min(source.length - sourceStart, output.length - outputStart)
  if (count < 1_000) return null
  let sourceSquares = 0
  let outputSquares = 0
  let cross = 0
  let squaredError = 0
  let compared = 0
  for (let index = 0; index < count; index += stride) {
    const left = source[sourceStart + index]!
    const right = output[outputStart + index]!
    sourceSquares += left * left
    outputSquares += right * right
    cross += left * right
    const delta = left - right
    squaredError += delta * delta
    compared += 1
  }
  const sourceWindowRmsBps = Math.round(Math.sqrt(sourceSquares / compared) * 10_000 / 32_768)
  const outputWindowRmsBps = Math.round(Math.sqrt(outputSquares / compared) * 10_000 / 32_768)
  const absoluteErrorBps = Math.round(Math.sqrt(squaredError / compared) * 10_000 / 32_768)
  if (
    sourceWindowRmsBps <= CONSISTENT_SILENCE_RMS_BPS &&
    outputWindowRmsBps <= CONSISTENT_SILENCE_RMS_BPS &&
    absoluteErrorBps <= CONSISTENT_SILENCE_ERROR_BPS
  ) {
    return {
      correlationBps: 10_000,
      normalizedErrorBps: absoluteErrorBps,
      comparedSampleCount: compared,
      sourceCoverageBps: Math.round(count * 10_000 / source.length),
      outputCoverageBps: Math.round(count * 10_000 / output.length),
    }
  }
  if (sourceSquares === 0 || outputSquares === 0) {
    return {
      correlationBps: sourceSquares === 0 && outputSquares === 0 ? 10_000 : 0,
      normalizedErrorBps: sourceSquares === 0 && outputSquares === 0 ? 0 : 10_000,
      comparedSampleCount: compared,
      sourceCoverageBps: Math.round(count * 10_000 / source.length),
      outputCoverageBps: Math.round(count * 10_000 / output.length),
    }
  }
  const correlationBps = Math.round(cross / Math.sqrt(sourceSquares * outputSquares) * 10_000)
  const normalizedErrorBps = Math.round(Math.sqrt(squaredError / compared) / Math.max(Math.sqrt(sourceSquares / compared), 1) * 10_000)
  return {
    correlationBps, normalizedErrorBps, comparedSampleCount: compared,
    sourceCoverageBps: Math.round(count * 10_000 / source.length),
    outputCoverageBps: Math.round(count * 10_000 / output.length),
  }
}

/** Compares decoded mono PCM, not container bytes. Codec padding and a bounded
 * encoder delay are aligned away; silence, replacement and missing duration
 * still fail with versioned, persisted measurements. */
export function compareAvatarAudioPcm(input: {
  source: Int16Array
  output: Int16Array
}): Readonly<AvatarAudioComparison> {
  assertDomain(input.source.length > 0 && input.output.length > 0, 'RENDER_OUTPUT_INVALID', 'Avatar audio comparison requires decoded PCM')
  const sourceDurationMs = durationMs(input.source)
  const outputDurationMs = durationMs(input.output)
  let best: (NonNullable<ReturnType<typeof scoreAtLag>> & { lag: number }) | null = null
  const searchStride = Math.max(1, Math.floor(Math.min(input.source.length, input.output.length) / 32_000))
  for (let lag = -MAX_LAG_SAMPLES; lag <= MAX_LAG_SAMPLES; lag += 80) {
    const score = scoreAtLag(input.source, input.output, lag, searchStride)
    if (score && (!best || score.correlationBps > best.correlationBps || (score.correlationBps === best.correlationBps && score.normalizedErrorBps < best.normalizedErrorBps))) {
      best = { ...score, lag }
    }
  }
  const coarseLag = best?.lag ?? 0
  for (let lag = Math.max(-MAX_LAG_SAMPLES, coarseLag - 79); lag <= Math.min(MAX_LAG_SAMPLES, coarseLag + 79); lag += 1) {
    const score = scoreAtLag(input.source, input.output, lag, searchStride)
    if (score && (!best || score.correlationBps > best.correlationBps || (score.correlationBps === best.correlationBps && score.normalizedErrorBps < best.normalizedErrorBps))) best = { ...score, lag }
  }
  const sourceRmsBps = rmsBps(input.source)
  const outputRmsBps = rmsBps(input.output)
  const finalScore = scoreAtLag(input.source, input.output, best?.lag ?? 0, 1)
  const comparison = finalScore && best
    ? { ...finalScore, lag: best.lag }
    : { lag: 0, correlationBps: 0, normalizedErrorBps: 10_000, comparedSampleCount: 0, sourceCoverageBps: 0, outputCoverageBps: 0 }
  const sourceStart = comparison.lag < 0 ? -comparison.lag : 0
  const outputStart = comparison.lag > 0 ? comparison.lag : 0
  const windowCorrelations: number[] = []
  const windowErrors: number[] = []
  const overlapSamples = Math.min(input.source.length - sourceStart, input.output.length - outputStart)
  const windowOffsets = new Set<number>()
  for (let offset = 0; offset + WINDOW_SAMPLES <= overlapSamples; offset += WINDOW_SAMPLES) windowOffsets.add(offset)
  if (overlapSamples >= 1_000) windowOffsets.add(Math.max(0, overlapSamples - Math.min(WINDOW_SAMPLES, overlapSamples)))
  for (const offset of [...windowOffsets].toSorted((left, right) => left - right)) {
    const windowSize = Math.min(WINDOW_SAMPLES, overlapSamples - offset)
    const window = scoreAtLag(
      input.source.subarray(sourceStart + offset, sourceStart + offset + windowSize),
      input.output.subarray(outputStart + offset, outputStart + offset + windowSize),
      0,
      1,
    )
    windowCorrelations.push(window?.correlationBps ?? 0)
    windowErrors.push(window?.normalizedErrorBps ?? 10_000)
  }
  const failedWindowCount = windowCorrelations.reduce((count, correlation, index) => count + Number(correlation < MIN_WINDOW_CORRELATION_BPS || windowErrors[index]! > MAX_WINDOW_ERROR_BPS), 0)
  return Object.freeze({
    policyVersion: AVATAR_AUDIO_COMPARISON_POLICY_VERSION,
    sourcePcmSha256: pcmHash(input.source),
    outputPcmSha256: pcmHash(input.output),
    sampleRateHz: SAMPLE_RATE,
    sourceDurationMs,
    outputDurationMs,
    alignedLagSamples: comparison.lag,
    comparedSampleCount: comparison.comparedSampleCount,
    sourceCoverageBps: comparison.sourceCoverageBps,
    outputCoverageBps: comparison.outputCoverageBps,
    correlationBps: comparison.correlationBps,
    normalizedErrorBps: comparison.normalizedErrorBps,
    worstWindowCorrelationBps: windowCorrelations.length > 0 ? Math.min(...windowCorrelations) : 0,
    worstWindowNormalizedErrorBps: windowErrors.length > 0 ? Math.max(...windowErrors) : 10_000,
    failedWindowCount,
    comparedWindowCount: windowCorrelations.length,
    sourceRmsBps,
    outputRmsBps,
    passed: Math.abs(sourceDurationMs - outputDurationMs) <= MAX_DURATION_DELTA_MS &&
      sourceRmsBps >= MIN_RMS_BPS && outputRmsBps >= MIN_RMS_BPS &&
      comparison.sourceCoverageBps >= 9_800 && comparison.outputCoverageBps >= 9_800 &&
      windowCorrelations.length > 0 && failedWindowCount === 0 &&
      comparison.correlationBps >= MIN_CORRELATION_BPS && comparison.normalizedErrorBps <= MAX_NORMALIZED_ERROR_BPS,
  })
}

export function createAvatarOutputSpeechEvidence(input: Omit<AvatarOutputSpeechEvidence, 'schemaVersion' | 'evidenceHash'>): Readonly<AvatarOutputSpeechEvidence> {
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
  const HASH = /^[a-f0-9]{64}$/
  assertDomain([input.jobId, input.videoArtifactId, input.sourceAudioArtifactId, input.speechEvidence.evaluatorId, input.speechEvidence.evaluatorVersion, input.speechEvidence.observedIdentityRef].every((value) => ID.test(value)), 'INVALID_ARGUMENT', 'Avatar output speech evidence identity is invalid')
  assertDomain([input.videoArtifactSha256, input.sourceAudioRangeHash, input.sourcePcmSha256, input.outputPcmSha256, input.speechEvidence.outputTranscriptHash].every((value) => HASH.test(value)), 'INVALID_ARGUMENT', 'Avatar output speech evidence hash is invalid')
  assertDomain(input.policyVersion === AVATAR_AUDIO_COMPARISON_POLICY_VERSION && input.sampleRateHz === SAMPLE_RATE, 'INVALID_ARGUMENT', 'Avatar output audio policy is invalid')
  assertDomain(input.speechEvidence.kind === 'measured' || input.speechEvidence.kind === 'controlled', 'INVALID_ARGUMENT', 'Avatar output speech evidence kind is invalid')
  const passed = Math.abs(input.sourceDurationMs - input.outputDurationMs) <= MAX_DURATION_DELTA_MS && input.sourceRmsBps >= MIN_RMS_BPS && input.outputRmsBps >= MIN_RMS_BPS && input.sourceCoverageBps >= 9_800 && input.outputCoverageBps >= 9_800 && input.comparedWindowCount > 0 && input.failedWindowCount === 0 && input.worstWindowCorrelationBps >= MIN_WINDOW_CORRELATION_BPS && input.worstWindowNormalizedErrorBps <= MAX_WINDOW_ERROR_BPS && input.correlationBps >= MIN_CORRELATION_BPS && input.normalizedErrorBps <= MAX_NORMALIZED_ERROR_BPS
  assertDomain(input.passed === passed, 'INVALID_ARGUMENT', 'Avatar output audio verdict does not match its persisted measurements')
  for (const value of [input.sourceDurationMs, input.outputDurationMs, input.comparedSampleCount, input.sourceCoverageBps, input.outputCoverageBps, input.normalizedErrorBps, input.worstWindowNormalizedErrorBps, input.failedWindowCount, input.comparedWindowCount, input.sourceRmsBps, input.outputRmsBps]) assertDomain(Number.isSafeInteger(value) && value >= 0, 'INVALID_ARGUMENT', 'Avatar output audio metric is invalid')
  assertDomain([input.correlationBps, input.worstWindowCorrelationBps].every((value) => Number.isSafeInteger(value) && value >= -10_000 && value <= 10_000), 'INVALID_ARGUMENT', 'Avatar output audio correlation is invalid')
  assertDomain(input.sourceDurationMs > 0 && input.outputDurationMs > 0 && input.comparedSampleCount > 0 && input.comparedWindowCount > 0 && input.failedWindowCount <= input.comparedWindowCount, 'INVALID_ARGUMENT', 'Avatar output audio counts are invalid')
  assertDomain(Number.isSafeInteger(input.alignedLagSamples) && Math.abs(input.alignedLagSamples) <= MAX_LAG_SAMPLES, 'INVALID_ARGUMENT', 'Avatar output audio lag is invalid')
  assertDomain([input.sourceCoverageBps, input.outputCoverageBps, input.sourceRmsBps, input.outputRmsBps].every((value) => value <= 10_000), 'INVALID_ARGUMENT', 'Avatar output audio bounded metric is invalid')
  const body = Object.freeze({
    schemaVersion: AVATAR_OUTPUT_SPEECH_EVIDENCE_VERSION,
    jobId: input.jobId, videoArtifactId: input.videoArtifactId, videoArtifactSha256: input.videoArtifactSha256,
    sourceAudioArtifactId: input.sourceAudioArtifactId, sourceAudioRangeHash: input.sourceAudioRangeHash,
    policyVersion: input.policyVersion, sourcePcmSha256: input.sourcePcmSha256, outputPcmSha256: input.outputPcmSha256,
    sampleRateHz: input.sampleRateHz, sourceDurationMs: input.sourceDurationMs, outputDurationMs: input.outputDurationMs,
    alignedLagSamples: input.alignedLagSamples, comparedSampleCount: input.comparedSampleCount,
    sourceCoverageBps: input.sourceCoverageBps, outputCoverageBps: input.outputCoverageBps,
    correlationBps: input.correlationBps, normalizedErrorBps: input.normalizedErrorBps,
    worstWindowCorrelationBps: input.worstWindowCorrelationBps, worstWindowNormalizedErrorBps: input.worstWindowNormalizedErrorBps,
    failedWindowCount: input.failedWindowCount, comparedWindowCount: input.comparedWindowCount,
    sourceRmsBps: input.sourceRmsBps, outputRmsBps: input.outputRmsBps, passed: input.passed,
    speechEvidence: Object.freeze({ kind: input.speechEvidence.kind, evaluatorId: input.speechEvidence.evaluatorId, evaluatorVersion: input.speechEvidence.evaluatorVersion, outputTranscriptHash: input.speechEvidence.outputTranscriptHash, observedIdentityRef: input.speechEvidence.observedIdentityRef }),
  })
  return Object.freeze({ ...body, evidenceHash: calculateCanonicalHash(body) })
}
