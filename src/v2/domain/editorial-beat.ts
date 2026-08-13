import type { TranscriptWord } from './media-transcript.ts'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { DomainError, assertDomain } from './errors.ts'

export const EDITORIAL_BEAT_DERIVATION_VERSION = 'editorial-beat-derivation/v1' as const
export const EDITORIAL_BEAT_BOUNDARY_REASONS = [
  'sentence-end', 'intent-change', 'pause', 'argument-change', 'visual-change', 'max-duration',
] as const
export type EditorialBeatBoundaryReason = (typeof EDITORIAL_BEAT_BOUNDARY_REASONS)[number]

export interface AlignedBeatWord {
  readonly id: string
  readonly index: number
  readonly text: string
  readonly startMs: number
  readonly endMs: number
}
export interface BeatSignal {
  readonly wordId: string
  readonly intent: string
  readonly argumentId: string
  readonly visualContext: string
}
export interface EditorialBeat {
  readonly schemaVersion: 'editorial-beat/v1'
  readonly id: string
  readonly ordinal: number
  readonly startMs: number
  readonly endMs: number
  readonly wordIds: readonly string[]
  readonly intent: string
  readonly argumentId: string
  readonly visualContext: string
  readonly boundaryReasons: readonly EditorialBeatBoundaryReason[]
  readonly beatHash: string
}

const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/

export function createAlignedBeatWords(transcriptHash: string, words: readonly TranscriptWord[]): readonly Readonly<AlignedBeatWord>[] {
  assertDomain(/^[a-f0-9]{64}$/.test(transcriptHash), 'INVALID_ARGUMENT', 'Transcript hash is invalid')
  return Object.freeze(words.map((word, index) => Object.freeze({
    id: `word-${transcriptHash.slice(0, 20)}-${String(index).padStart(6, '0')}`,
    index, text: word.word, startMs: Math.round(word.start * 1_000), endMs: Math.round(word.end * 1_000),
  })))
}

function normalizedSignal(signal: BeatSignal): Readonly<BeatSignal> {
  const intent = signal.intent.trim().toLowerCase()
  const argumentId = signal.argumentId.trim().toLowerCase()
  const visualContext = signal.visualContext.trim().toLowerCase()
  assertDomain(TOKEN.test(intent) && TOKEN.test(argumentId) && TOKEN.test(visualContext), 'INVALID_ARGUMENT', 'Editorial beat signal is invalid')
  return Object.freeze({ wordId: signal.wordId, intent, argumentId, visualContext })
}

function buildBeat(input: Omit<EditorialBeat, 'schemaVersion' | 'id' | 'beatHash'>): Readonly<EditorialBeat> {
  const body = { schemaVersion: 'editorial-beat/v1' as const, ...input }
  const beatHash = calculateCanonicalHash(body)
  return Object.freeze({ ...body, id: `beat-${beatHash.slice(0, 48)}`, beatHash })
}

export function deriveEditorialBeats(input: {
  transcriptHash: string
  words: readonly TranscriptWord[]
  signals: readonly BeatSignal[]
  pauseBoundaryMs?: number
  maxDurationMs?: number
}): Readonly<{ derivationVersion: typeof EDITORIAL_BEAT_DERIVATION_VERSION; words: readonly Readonly<AlignedBeatWord>[]; wordsHash: string; signals: readonly Readonly<BeatSignal>[]; signalsHash: string; beats: readonly Readonly<EditorialBeat>[]; beatsHash: string }> {
  const words = createAlignedBeatWords(input.transcriptHash, input.words)
  if (words.length === 0) throw new DomainError('INVALID_ARGUMENT', 'Editorial beats require aligned transcript words')
  const pauseBoundaryMs = input.pauseBoundaryMs ?? 450
  const maxDurationMs = input.maxDurationMs ?? 8_000
  assertDomain(Number.isSafeInteger(pauseBoundaryMs) && pauseBoundaryMs >= 100 && pauseBoundaryMs <= 5_000, 'INVALID_ARGUMENT', 'Editorial beat pause threshold is invalid')
  assertDomain(Number.isSafeInteger(maxDurationMs) && maxDurationMs >= 1_000 && maxDurationMs <= 30_000, 'INVALID_ARGUMENT', 'Editorial beat maximum duration is invalid')
  assertDomain(input.signals.length === words.length, 'INVALID_ARGUMENT', 'Editorial beat signals must cover every aligned word exactly once')
  const signals = input.signals.map(normalizedSignal)
  const signalByWord = new Map(signals.map((signal) => [signal.wordId, signal]))
  assertDomain(signalByWord.size === words.length && words.every((word) => signalByWord.has(word.id)), 'INVALID_ARGUMENT', 'Editorial beat signal word IDs do not match transcript alignment')

  const beats: EditorialBeat[] = []
  let startIndex = 0
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const signal = signalByWord.get(word.id)!
    const nextWord = words[index + 1]
    const nextSignal = nextWord ? signalByWord.get(nextWord.id)! : undefined
    const reasons: EditorialBeatBoundaryReason[] = []
    if (/[.!?…]["')\]]?$/.test(word.text)) reasons.push('sentence-end')
    if (nextSignal?.intent !== undefined && nextSignal.intent !== signal.intent) reasons.push('intent-change')
    if (nextWord && nextWord.startMs - word.endMs >= pauseBoundaryMs) reasons.push('pause')
    if (nextSignal?.argumentId !== undefined && nextSignal.argumentId !== signal.argumentId) reasons.push('argument-change')
    if (nextSignal?.visualContext !== undefined && nextSignal.visualContext !== signal.visualContext) reasons.push('visual-change')
    if (word.endMs - words[startIndex].startMs >= maxDurationMs) reasons.push('max-duration')
    if (reasons.length > 0 || !nextWord) {
      const firstSignal = signalByWord.get(words[startIndex].id)!
      beats.push(buildBeat({
        ordinal: beats.length,
        startMs: words[startIndex].startMs,
        endMs: word.endMs,
        wordIds: Object.freeze(words.slice(startIndex, index + 1).map((item) => item.id)),
        intent: firstSignal.intent,
        argumentId: firstSignal.argumentId,
        visualContext: firstSignal.visualContext,
        boundaryReasons: Object.freeze(reasons),
      }))
      startIndex = index + 1
    }
  }
  const wordsHash = calculateCanonicalHash(words)
  const signalsHash = calculateCanonicalHash(signals)
  const beatsHash = calculateCanonicalHash({ derivationVersion: EDITORIAL_BEAT_DERIVATION_VERSION, transcriptHash: input.transcriptHash, pauseBoundaryMs, maxDurationMs, beats })
  return Object.freeze({ derivationVersion: EDITORIAL_BEAT_DERIVATION_VERSION, words, wordsHash, signals: Object.freeze(signals), signalsHash, beats: Object.freeze(beats), beatsHash })
}

export function adjustEditorialBeat(input: {
  beat: EditorialBeat
  allWords: readonly AlignedBeatWord[]
  startWordId: string
  endWordId: string
  directorRunId: string
  reason: string
}): Readonly<{ adjustedBeat: EditorialBeat; sourceBeatHash: string; wordAlignmentHash: string; wordAlignmentUnchanged: true; adjustmentHash: string }> {
  const before = stableSerialize(input.allWords)
  const start = input.allWords.findIndex((word) => word.id === input.startWordId)
  const end = input.allWords.findIndex((word) => word.id === input.endWordId)
  assertDomain(start >= 0 && end >= start, 'INVALID_ARGUMENT', 'Editorial beat adjustment word range is invalid')
  assertDomain(input.directorRunId.trim().length >= 3 && input.reason.trim().length >= 3 && input.reason.trim().length <= 500, 'INVALID_ARGUMENT', 'Editorial beat Director adjustment evidence is invalid')
  const selected = input.allWords.slice(start, end + 1)
  const adjustedBeat = buildBeat({
    ordinal: input.beat.ordinal,
    startMs: selected[0].startMs,
    endMs: selected.at(-1)!.endMs,
    wordIds: Object.freeze(selected.map((word) => word.id)),
    intent: input.beat.intent,
    argumentId: input.beat.argumentId,
    visualContext: input.beat.visualContext,
    boundaryReasons: input.beat.boundaryReasons,
  })
  const wordAlignmentHash = calculateCanonicalHash(input.allWords)
  const adjustmentHash = calculateCanonicalHash({ schemaVersion: 'editorial-beat-adjustment/v1', sourceBeatHash: input.beat.beatHash, adjustedBeatHash: adjustedBeat.beatHash, wordAlignmentHash, directorRunId: input.directorRunId, reason: input.reason.trim() })
  if (stableSerialize(input.allWords) !== before) throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial beat adjustment altered source word alignment')
  return Object.freeze({ adjustedBeat, sourceBeatHash: input.beat.beatHash, wordAlignmentHash, wordAlignmentUnchanged: true, adjustmentHash })
}
