import { spawn } from 'node:child_process'

import { createMusicAnalysis, type MusicSection } from '../../domain/music-led-montage.ts'
import { DomainError } from '../../domain/errors.ts'
import type { MusicSignalAnalyzer } from '../../application/ports/music-led-montage.ts'
import { MUSIC_ANALYZER_ID, MUSIC_ANALYZER_VERSION } from '../../application/analyze-music-for-montage.ts'
import { resolveFfmpegBinary } from '../media/ffmpeg-binary.ts'

const SAMPLE_RATE = 22_050
const WINDOW_SIZE = 1_024
const HOP_SIZE = 512
const MAX_DURATION_SECONDS = 60 * 60

function normalized(values: readonly number[]): number[] {
  let maximum = 0
  for (const value of values) if (value > maximum) maximum = value
  return maximum > 0 ? values.map((value) => value / maximum) : values.map(() => 0)
}

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor(ordered.length * ratio)))] ?? 0
}

function inferSections(energy: readonly number[], durationMs: number): readonly MusicSection[] {
  if (energy.length === 0) return []
  const sectionCount = Math.max(1, Math.min(8, Math.round(durationMs / 15_000)))
  const sections: MusicSection[] = []
  for (let index = 0; index < sectionCount; index += 1) {
    const start = Math.floor(index * energy.length / sectionCount)
    const end = Math.max(start + 1, Math.floor((index + 1) * energy.length / sectionCount))
    const slice = energy.slice(start, end)
    const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length
    const previous = index === 0 ? mean : sections[index - 1]!.energy
    const nextSlice = index + 1 >= sectionCount ? slice : energy.slice(end, Math.max(end + 1, Math.floor((index + 2) * energy.length / sectionCount)))
    const next = nextSlice.reduce((sum, value) => sum + value, 0) / nextSlice.length
    const role: MusicSection['role'] = index === 0 ? 'intro' : index === sectionCount - 1 ? 'outro' : mean >= percentile(energy, .8) ? 'peak' : mean + .12 < previous || mean + .12 < next ? 'break' : next > mean + .1 ? 'build' : 'unknown'
    sections.push(Object.freeze({ id: `section-${index + 1}`, rangeMs: Object.freeze([Math.round(index * durationMs / sectionCount), Math.round((index + 1) * durationMs / sectionCount)] as const), energy: Math.round(mean * 10_000) / 10_000, confidence: .42, role }))
  }
  return Object.freeze(sections)
}

function analyzeEnvelope(rawEnergy: readonly number[]) {
  const energy = normalized(rawEnergy)
  const flux = energy.map((value, index) => Math.max(0, value - (energy[index - 1] ?? value)))
  const threshold = percentile(flux, .75)
  const onset = flux.map((value) => value >= threshold && value > 0 ? value : 0)
  const framesPerSecond = SAMPLE_RATE / HOP_SIZE
  let bestLag = 0
  let bestCorrelation = 0
  const correlations: Array<{ lag: number; value: number }> = []
  const minimumLag = Math.floor(framesPerSecond * 60 / 200)
  const maximumLag = Math.ceil(framesPerSecond * 60 / 60)
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let correlation = 0
    for (let index = lag; index < onset.length; index += 1) correlation += onset[index]! * onset[index - lag]!
    correlations.push({ lag, value: correlation })
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag }
  }
  const harmonic = correlations.filter((candidate) => candidate.value >= bestCorrelation * .9).sort((left, right) => left.lag - right.lag)[0]
  if (harmonic) { bestLag = harmonic.lag; bestCorrelation = harmonic.value }
  if (bestLag === 0 || bestCorrelation <= 0) return { energy, tempo: { bpm: null, confidence: 0 }, beats: [] as Array<{ atMs: number; strength: number; confidence: number; kind: 'beat' }> }
  let secondCorrelation = 0
  for (const candidate of correlations) if (Math.abs(candidate.lag - bestLag) > 2 && candidate.value > secondCorrelation) secondCorrelation = candidate.value
  const contrast = Math.max(0, (bestCorrelation - secondCorrelation) / bestCorrelation)
  const tempoConfidence = Math.max(.35, Math.min(1, contrast + Math.min(.8, bestCorrelation / Math.max(.0001, onset.reduce((sum, value) => sum + value * value, 0)))))
  let phase = 0
  let phaseScore = -1
  for (let candidate = 0; candidate < bestLag; candidate += 1) {
    let score = 0
    for (let index = candidate; index < onset.length; index += bestLag) score += onset[index] ?? 0
    if (score > phaseScore) { phaseScore = score; phase = candidate }
  }
  const beats = []
  for (let index = phase; index < onset.length; index += bestLag) {
    const searchStart = Math.max(0, index - Math.floor(bestLag / 4))
    const searchEnd = Math.min(onset.length, index + Math.floor(bestLag / 4) + 1)
    let peak = searchStart
    for (let cursor = searchStart + 1; cursor < searchEnd; cursor += 1) if ((onset[cursor] ?? 0) > (onset[peak] ?? 0)) peak = cursor
    beats.push({ atMs: Math.round((peak * HOP_SIZE + WINDOW_SIZE / 2) * 1000 / SAMPLE_RATE), strength: Math.round((onset[peak] ?? 0) * 10_000) / 10_000, confidence: Math.round(tempoConfidence * Math.min(1, (onset[peak] ?? 0) / Math.max(threshold, .0001)) * 10_000) / 10_000, kind: 'beat' as const })
  }
  return { energy, tempo: { bpm: Math.round(60 * framesPerSecond / bestLag * 100) / 100, confidence: Math.round(tempoConfidence * 10_000) / 10_000 }, beats }
}

export class FfmpegMusicSignalAnalyzer implements MusicSignalAnalyzer {
  private readonly ffmpegPath: string
  constructor(options: { ffmpegPath?: string; environment?: NodeJS.ProcessEnv } = {}) { this.ffmpegPath = resolveFfmpegBinary(options.ffmpegPath, options.environment) }

  async analyzeVerifiedFile(input: Parameters<MusicSignalAnalyzer['analyzeVerifiedFile']>[0]) {
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Music analysis was aborted')
    const child = spawn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', input.filePath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const abort = () => child.kill('SIGKILL')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
    input.signal?.addEventListener('abort', abort, { once: true })
    const rawEnergy: number[] = []
    let samples: number[] = []
    let sampleCount = 0
    let stderr = ''
    let pendingByte: number | null = null
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { if (stderr.length < 16_384) stderr += chunk })
    child.stdout.on('data', (chunk: Buffer) => {
      let bytes = chunk
      if (pendingByte !== null) { bytes = Buffer.concat([Buffer.from([pendingByte]), chunk]); pendingByte = null }
      if (bytes.length % 2 === 1) { pendingByte = bytes[bytes.length - 1]!; bytes = bytes.subarray(0, bytes.length - 1) }
      for (let offset = 0; offset < bytes.length; offset += 2) {
        samples.push(bytes.readInt16LE(offset) / 32768); sampleCount += 1
        if (sampleCount > SAMPLE_RATE * MAX_DURATION_SECONDS) { child.kill('SIGKILL'); return }
        if (samples.length === WINDOW_SIZE) {
          rawEnergy.push(Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / WINDOW_SIZE))
          samples = samples.slice(HOP_SIZE)
        }
      }
    })
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => { clearTimeout(timeout); input.signal?.removeEventListener('abort', abort) })
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Music analysis was aborted')
    if (sampleCount > SAMPLE_RATE * MAX_DURATION_SECONDS) throw new DomainError('INVALID_ARGUMENT', 'Music exceeds the one hour automatic analysis limit')
    if (exitCode !== 0 || sampleCount === 0) throw new DomainError('RENDER_EXECUTION_FAILED', 'FFmpeg could not decode music to PCM', { stderr: stderr.trim().slice(0, 2_000) })
    const durationMs = Math.round(sampleCount * 1000 / SAMPLE_RATE)
    const result = analyzeEnvelope(rawEnergy)
    const confidence = Math.round(Math.min(result.tempo.confidence, result.beats.length >= 4 ? 1 : result.beats.length / 4) * 10_000) / 10_000
    return createMusicAnalysis({ id: `music-analysis-${input.sourceSha256.slice(0, 24)}-${MUSIC_ANALYZER_VERSION.replaceAll('.', '-')}`, sourceArtifactId: input.sourceArtifactId, sourceSha256: input.sourceSha256, sourceByteSize: input.sourceByteSize, analyzer: Object.freeze({ id: MUSIC_ANALYZER_ID, version: MUSIC_ANALYZER_VERSION, sampleRate: SAMPLE_RATE, windowSize: WINDOW_SIZE, hopSize: HOP_SIZE }), durationMs, tempo: Object.freeze(result.tempo), beats: result.beats, sections: inferSections(result.energy, durationMs), energyCurve: Object.freeze(result.energy.map((value, index) => Object.freeze({ atMs: Math.round(index * HOP_SIZE * 1000 / SAMPLE_RATE), value: Math.round(value * 10_000) / 10_000 }))), confidence, limitations: Object.freeze(['downbeats-not-inferred-without-independent-meter-evidence', 'section-labels-are-energy-heuristics', 'tempo-derived-from-pcm-onset-autocorrelation']) })
  }
}
