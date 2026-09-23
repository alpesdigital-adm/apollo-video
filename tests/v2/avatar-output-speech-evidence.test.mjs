import assert from 'node:assert/strict'
import test from 'node:test'

import { compareAvatarAudioPcm, createAvatarOutputSpeechEvidence } from '../../src/v2/domain/avatar-output-speech-evidence.ts'
import { FfmpegAvatarAudioComparison } from '../../src/v2/infrastructure/media/ffmpeg-avatar-audio-comparison.ts'

function speechSamples(durationMs = 2_000, gain = 1, offset = 0) {
  const count = Math.round(durationMs * 16)
  const samples = new Int16Array(count + offset)
  for (let index = 0; index < count; index += 1) {
    const speech = Math.sin(index / 17 + index * index / 1_000_000) * 8_000 + Math.sin(index / 43 + index * index / 3_000_000) * 3_000
    samples[index + offset] = Math.round(speech * gain)
  }
  return samples
}

test('avatar PCM evidence accepts measured lossy-like transcode and non-grid encoder delay', () => {
  const comparison = compareAvatarAudioPcm({ source: speechSamples(), output: speechSamples(2_000, 0.98, 333) })
  assert.equal(comparison.passed, true)
  assert.notEqual(comparison.sourcePcmSha256, comparison.outputPcmSha256)
  assert.ok(comparison.correlationBps >= 9_200)
  const evidence = createAvatarOutputSpeechEvidence({
    ...comparison, jobId: 'avatar-job-1', videoArtifactId: 'avatar-video-1', videoArtifactSha256: 'a'.repeat(64),
    sourceAudioArtifactId: 'audio-master-1', sourceAudioRangeHash: 'b'.repeat(64),
    speechEvidence: { kind: 'controlled', evaluatorId: 'controlled-output-asr', evaluatorVersion: '1.0.0', outputTranscriptHash: 'c'.repeat(64), observedIdentityRef: 'avatar-identity-1' },
  })
  assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/)
})

test('avatar PCM comparison waits for both decoder processes before surfacing a failure', async () => {
  let releaseOutput
  let outputFinished = false
  const outputBlocked = new Promise((resolve) => { releaseOutput = resolve })
  const evaluator = new FfmpegAvatarAudioComparison({}, async (path) => {
    if (path === 'source.mp4') throw new Error('source decode failed')
    await outputBlocked
    outputFinished = true
    return speechSamples()
  })
  const comparison = evaluator.compare({
    sourcePath: 'source.mp4', resultPath: 'output.mp4', sourceStartMs: 0, sourceDurationMs: 2_000,
  })
  let rejected = false
  void comparison.catch(() => { rejected = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(rejected, false)
  assert.equal(outputFinished, false)
  releaseOutput()
  await assert.rejects(comparison, /source decode failed/)
  assert.equal(outputFinished, true)
})

test('avatar PCM evidence rejects replacement, silence and truncated speech', () => {
  const source = speechSamples()
  const replacement = Int16Array.from(source, (_sample, index) => Math.round(Math.sin(index / 7) * 9_000))
  assert.equal(compareAvatarAudioPcm({ source, output: replacement }).passed, false)
  assert.equal(compareAvatarAudioPcm({ source, output: new Int16Array(source.length) }).passed, false)
  assert.equal(compareAvatarAudioPcm({ source, output: speechSamples(1_500) }).passed, false)
  const measuredFailure = compareAvatarAudioPcm({ source, output: replacement })
  const evidence = createAvatarOutputSpeechEvidence({
    ...measuredFailure, jobId: 'avatar-job-rejected', videoArtifactId: 'avatar-video-rejected', videoArtifactSha256: 'd'.repeat(64),
    sourceAudioArtifactId: 'audio-master-rejected', sourceAudioRangeHash: 'e'.repeat(64),
    speechEvidence: { kind: 'controlled', evaluatorId: 'controlled-output-asr', evaluatorVersion: '1.0.0', outputTranscriptHash: 'f'.repeat(64), observedIdentityRef: 'avatar-identity-rejected' },
  })
  assert.equal(evidence.passed, false, 'measured audio divergence remains durable evidence for a rejected critic report')
})

test('avatar PCM verdict evaluates every overlap sample after lag search', () => {
  const source = speechSamples(4_000)
  const changed = speechSamples(4_000)
  for (let index = 1; index < changed.length; index += 2) changed[index] = -changed[index]
  const comparison = compareAvatarAudioPcm({ source, output: changed })
  assert.equal(comparison.comparedSampleCount, source.length)
  assert.equal(comparison.passed, false)
})

test('avatar PCM verdict rejects a short substituted word-sized window in long audio', () => {
  const source = speechSamples(60_000)
  const changed = Int16Array.from(source)
  const start = 30 * 16_000
  for (let index = start; index < start + 3_200; index += 1) changed[index] = Math.round(Math.sin(index / 5) * 11_000)
  const comparison = compareAvatarAudioPcm({ source, output: changed })
  assert.ok(comparison.correlationBps > 9_200, 'global score demonstrates why window evidence is required')
  assert.ok(comparison.failedWindowCount > 0)
  assert.equal(comparison.passed, false)
})

test('avatar PCM verdict accepts matching pauses and checks the final partial window', () => {
  const source = speechSamples(2_100)
  source.fill(0, 8_000, 12_000)
  const matchingPause = Int16Array.from(source)
  assert.equal(compareAvatarAudioPcm({ source, output: matchingPause }).passed, true)
  const changedTail = Int16Array.from(source)
  changedTail.fill(12_000, changedTail.length - 1_200)
  const comparison = compareAvatarAudioPcm({ source, output: changedTail })
  assert.ok(comparison.failedWindowCount > 0)
  assert.equal(comparison.passed, false)
})

test('avatar PCM verdict accepts bounded codec noise during a matching silent pause', () => {
  const source = speechSamples(4_000)
  const output = speechSamples(4_000)
  for (let index = 16_000; index < 22_400; index += 1) {
    source[index] = 0
    output[index] = Math.round(Math.sin(index / 11) * 90)
  }
  const comparison = compareAvatarAudioPcm({ source, output })
  assert.equal(comparison.passed, true)
  assert.equal(comparison.failedWindowCount, 0)
})

test('avatar speech evidence rejects out-of-domain server metrics', () => {
  const comparison = compareAvatarAudioPcm({ source: speechSamples(), output: speechSamples() })
  const valid = {
    ...comparison, jobId: 'avatar-job-1', videoArtifactId: 'avatar-video-1', videoArtifactSha256: 'a'.repeat(64),
    sourceAudioArtifactId: 'audio-master-1', sourceAudioRangeHash: 'b'.repeat(64),
    speechEvidence: { kind: 'measured', evaluatorId: 'output-asr', evaluatorVersion: '1.0.0', outputTranscriptHash: 'c'.repeat(64), observedIdentityRef: 'avatar-identity-1' },
  }
  assert.throws(() => createAvatarOutputSpeechEvidence({ ...valid, sourceCoverageBps: 10_001 }), /bounded metric/)
  assert.throws(() => createAvatarOutputSpeechEvidence({ ...valid, alignedLagSamples: 1_601 }), /lag is invalid/)
})

test('avatar PCM verdict folds a sub-window tail into the final measured window', () => {
  const source = speechSamples(60_000)
  const changed = Int16Array.from(source)
  for (let index = changed.length - 640; index < changed.length; index += 1) changed[index] = Math.round(Math.sin(index / 3) * 14_000)
  const comparison = compareAvatarAudioPcm({ source, output: changed })
  assert.ok(comparison.failedWindowCount > 0)
  assert.equal(comparison.passed, false)
})
