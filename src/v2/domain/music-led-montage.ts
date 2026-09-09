import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export const MUSIC_ANALYSIS_SCHEMA_VERSION = 'music-analysis/v1' as const

export interface MusicBeat {
  readonly atMs: number
  readonly strength: number
  readonly confidence: number
  readonly kind: 'beat' | 'downbeat-candidate'
}

export interface MusicSection {
  readonly id: string
  readonly rangeMs: readonly [number, number]
  readonly energy: number
  readonly confidence: number
  readonly role: 'intro' | 'build' | 'peak' | 'break' | 'outro' | 'unknown'
}

export interface MusicAnalysisV1 {
  readonly schemaVersion: typeof MUSIC_ANALYSIS_SCHEMA_VERSION
  readonly id: string
  readonly sourceArtifactId: string
  readonly sourceSha256: string
  readonly sourceByteSize: number
  readonly analyzer: Readonly<{ id: string; version: string; sampleRate: number; windowSize: number; hopSize: number }>
  readonly durationMs: number
  readonly tempo: Readonly<{ bpm: number | null; confidence: number }>
  readonly beats: readonly Readonly<MusicBeat>[]
  readonly sections: readonly Readonly<MusicSection>[]
  readonly energyCurve: readonly Readonly<{ atMs: number; value: number }>[]
  readonly confidence: number
  readonly limitations: readonly string[]
  readonly analysisHash: string
}

export function createMusicAnalysis(input: Omit<MusicAnalysisV1, 'schemaVersion' | 'analysisHash'>): MusicAnalysisV1 {
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256) || !Number.isSafeInteger(input.sourceByteSize) || input.sourceByteSize <= 0) throw new DomainError('INVALID_ARGUMENT', 'Music source identity is invalid')
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) throw new DomainError('INVALID_ARGUMENT', 'Music duration is invalid')
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.tempo.confidence) || input.tempo.confidence < 0 || input.tempo.confidence > 1 || (input.tempo.bpm !== null && (!Number.isFinite(input.tempo.bpm) || input.tempo.bpm <= 0))) throw new DomainError('INVALID_ARGUMENT', 'Music analysis confidence or tempo is invalid')
  const ordered = [...input.beats].map((beat) => Object.freeze({ ...beat })).sort((a, b) => a.atMs - b.atMs)
  if (ordered.some((beat, index) => !Number.isFinite(beat.atMs) || !Number.isFinite(beat.strength) || !Number.isFinite(beat.confidence) || beat.atMs < 0 || beat.atMs > input.durationMs || beat.strength < 0 || beat.strength > 1 || beat.confidence < 0 || beat.confidence > 1 || (index > 0 && beat.atMs <= ordered[index - 1]!.atMs))) throw new DomainError('INVALID_ARGUMENT', 'Music beats are invalid')
  const sections = input.sections.map((section) => Object.freeze({ ...section, rangeMs: Object.freeze([...section.rangeMs] as [number, number]) }))
  if (sections.some((section) => !Number.isFinite(section.rangeMs[0]) || !Number.isFinite(section.rangeMs[1]) || section.rangeMs[0] < 0 || section.rangeMs[1] <= section.rangeMs[0] || section.rangeMs[1] > input.durationMs || !Number.isFinite(section.energy) || section.energy < 0 || section.energy > 1 || !Number.isFinite(section.confidence) || section.confidence < 0 || section.confidence > 1)) throw new DomainError('INVALID_ARGUMENT', 'Music sections are invalid')
  const energyCurve = input.energyCurve.map((point) => Object.freeze({ ...point }))
  if (energyCurve.some((point) => !Number.isFinite(point.atMs) || !Number.isFinite(point.value) || point.atMs < 0 || point.atMs > input.durationMs || point.value < 0 || point.value > 1)) throw new DomainError('INVALID_ARGUMENT', 'Music energy curve is invalid')
  const value = Object.freeze({ ...input, schemaVersion: MUSIC_ANALYSIS_SCHEMA_VERSION, analyzer: Object.freeze({ ...input.analyzer }), tempo: Object.freeze({ ...input.tempo }), beats: Object.freeze(ordered), sections: Object.freeze(sections), energyCurve: Object.freeze(energyCurve), limitations: Object.freeze([...new Set(input.limitations)].sort()) })
  return Object.freeze({ ...value, analysisHash: calculateCanonicalHash(value) })
}

export interface ProtectedSpeechRange {
  readonly id: string
  readonly rangeMs: readonly [number, number]
  readonly reason: 'word' | 'claim' | 'qualifier' | 'narrative-dependency'
}

export interface MusicMontagePlanV1 {
  readonly schemaVersion: 'music-montage-plan/v1'
  readonly mode: 'music-led' | 'hybrid' | 'narrative-led'
  readonly analysisId: string
  readonly analysisHash: string
  readonly cutDecisions: readonly Readonly<{ requestedAtMs: number; atMs: number; source: 'downbeat' | 'beat' | 'semantic'; distanceMs: number; reason: string }>[]
  readonly protectedSpeechRanges: readonly ProtectedSpeechRange[]
  readonly fallbackReasons: readonly string[]
  readonly planHash: string
}

const intersectsInterior = (atMs: number, range: readonly [number, number]) => atMs > range[0] && atMs < range[1]

export function compileMusicLedMontage(input: {
  analysis: MusicAnalysisV1
  semanticCutCandidatesMs: readonly number[]
  protectedSpeechRanges: readonly ProtectedSpeechRange[]
  minimumConfidence?: number
  maximumSnapDistanceMs?: number
  fps?: number
}): MusicMontagePlanV1 {
  const minimumConfidence = input.minimumConfidence ?? 0.68
  const maximumSnapDistanceMs = input.maximumSnapDistanceMs ?? 120
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1 || !Number.isFinite(maximumSnapDistanceMs) || maximumSnapDistanceMs < 0 || (input.fps !== undefined && (!Number.isFinite(input.fps) || input.fps <= 0))) throw new DomainError('INVALID_ARGUMENT', 'Music montage thresholds are invalid')
  const quantize = (milliseconds: number) => input.fps === undefined ? milliseconds : Math.round(milliseconds * input.fps / 1000) * 1000 / input.fps
  const confident = input.analysis.confidence >= minimumConfidence && input.analysis.beats.some((beat) => beat.confidence >= minimumConfidence)
  const fallbackReasons = confident ? [] : ['beat-confidence-below-threshold']
  const decisions = [...new Set(input.semanticCutCandidatesMs.map(quantize))].sort((a, b) => a - b).map((requestedAtMs) => {
    if (!Number.isFinite(requestedAtMs) || requestedAtMs < 0 || requestedAtMs > input.analysis.durationMs) throw new DomainError('INVALID_ARGUMENT', 'Semantic cut candidate is invalid')
    if (!confident) return { requestedAtMs, atMs: requestedAtMs, source: 'semantic' as const, distanceMs: 0, reason: 'confidence-fallback-preserves-semantic-boundary' }
    const candidate = input.analysis.beats
      .filter((beat) => beat.confidence >= minimumConfidence)
      .map((beat) => ({ beat: { ...beat, atMs: quantize(beat.atMs) }, distanceMs: Math.abs(quantize(beat.atMs) - requestedAtMs) }))
      .filter(({ beat, distanceMs }) => distanceMs <= maximumSnapDistanceMs && !input.protectedSpeechRanges.some((range) => intersectsInterior(beat.atMs, range.rangeMs)))
      .sort((left, right) => left.distanceMs - right.distanceMs || Number(right.beat.kind === 'downbeat-candidate') - Number(left.beat.kind === 'downbeat-candidate') || left.beat.atMs - right.beat.atMs)[0]
    if (!candidate) return { requestedAtMs, atMs: requestedAtMs, source: 'semantic' as const, distanceMs: 0, reason: 'no-safe-confident-beat-within-distance' }
    return { requestedAtMs, atMs: candidate.beat.atMs, source: candidate.beat.kind === 'downbeat-candidate' ? 'downbeat' as const : 'beat' as const, distanceMs: candidate.distanceMs, reason: 'safe-confident-grid-snap' }
  })
  const mode = confident && decisions.some((decision) => decision.source !== 'semantic') ? (decisions.every((decision) => decision.source !== 'semantic') ? 'music-led' : 'hybrid') : 'narrative-led'
  const value = Object.freeze({ schemaVersion: 'music-montage-plan/v1' as const, mode, analysisId: input.analysis.id, analysisHash: input.analysis.analysisHash, cutDecisions: Object.freeze(decisions), protectedSpeechRanges: Object.freeze([...input.protectedSpeechRanges]), fallbackReasons: Object.freeze(fallbackReasons) })
  return Object.freeze({ ...value, planHash: calculateCanonicalHash(value) })
}

export function critiqueMusicMontage(input: { plan: MusicMontagePlanV1; durationMs: number; minimumCutSpacingMs?: number; maximumCutsPer10s?: number }) {
  const minimumCutSpacingMs = input.minimumCutSpacingMs ?? 650
  const maximumCutsPer10s = input.maximumCutsPer10s ?? 8
  const cuts = [...input.plan.cutDecisions].sort((a, b) => a.atMs - b.atMs)
  const issues: Array<Readonly<{ code: string; hard: boolean; atMs: number; evidence: string }>> = []
  for (let index = 1; index < cuts.length; index += 1) if (cuts[index]!.atMs - cuts[index - 1]!.atMs < minimumCutSpacingMs) issues.push({ code: 'CUT_SPACING_TOO_DENSE', hard: false, atMs: cuts[index]!.atMs, evidence: `${cuts[index]!.atMs - cuts[index - 1]!.atMs}ms spacing` })
  for (const cut of cuts) if (input.plan.protectedSpeechRanges.some((range) => intersectsInterior(cut.atMs, range.rangeMs))) issues.push({ code: 'PROTECTED_SPEECH_CUT', hard: true, atMs: cut.atMs, evidence: 'cut intersects protected speech' })
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || !Number.isFinite(minimumCutSpacingMs) || minimumCutSpacingMs < 0 || !Number.isSafeInteger(maximumCutsPer10s) || maximumCutsPer10s < 1) throw new DomainError('INVALID_ARGUMENT', 'Music critic thresholds are invalid')
  for (let index = 0; index < cuts.length; index += 1) {
    const count = cuts.filter((cut) => cut.atMs >= cuts[index]!.atMs && cut.atMs < cuts[index]!.atMs + 10_000).length
    if (count > maximumCutsPer10s) issues.push({ code: 'OVER_EDITING_DENSITY', hard: false, atMs: cuts[index]!.atMs, evidence: `${count} cuts in sliding 10s` }); else continue
    break
  }
  return Object.freeze({ passed: issues.length === 0, eligibleForAutomaticRender: issues.length === 0, issues: Object.freeze(issues), densityPerMinute: cuts.length * 60_000 / input.durationMs })
}
