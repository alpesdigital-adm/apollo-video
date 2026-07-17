import { DomainError } from './errors.ts'

export interface AlignedWord { id: string; text: string; startMs: number; endMs: number; sentenceEnd?: boolean; subtitleChunkId: string }
export interface BeatSignal { wordId: string; intent: string; argumentId: string; pauseAfterMs: number; visualContext: string }
export interface EditorialBeat { id: string; startMs: number; endMs: number; wordIds: readonly string[]; intent: string; argumentId: string; visualContext: string; boundaryReasons: readonly string[]; adjustedBy?: string }

export function deriveEditorialBeats(words: readonly AlignedWord[], signals: readonly BeatSignal[], options: { longPhraseMs?: number; pauseBoundaryMs?: number } = {}): readonly Readonly<EditorialBeat>[] {
  if (!words.length) return Object.freeze([])
  const signalByWord = new Map(signals.map((signal) => [signal.wordId, signal]))
  const longPhraseMs = options.longPhraseMs ?? 8_000
  const pauseBoundaryMs = options.pauseBoundaryMs ?? 450
  const beats: EditorialBeat[] = []
  let current: AlignedWord[] = []
  let start = words[0].startMs
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const signal = signalByWord.get(word.id)
    if (!signal) throw new DomainError('INVALID_ARGUMENT', `Missing beat signal for word ${word.id}`)
    current.push(word)
    const nextSignal = words[index + 1] ? signalByWord.get(words[index + 1].id) : undefined
    const reasons = [word.sentenceEnd ? 'sentence' : '', signal.pauseAfterMs >= pauseBoundaryMs ? 'pause' : '', nextSignal && nextSignal.intent !== signal.intent ? 'intent-change' : '', nextSignal && nextSignal.argumentId !== signal.argumentId ? 'argument-change' : '', nextSignal && nextSignal.visualContext !== signal.visualContext ? 'visual-change' : '', word.endMs - start >= longPhraseMs ? 'long-phrase' : '', index === words.length - 1 ? 'end' : ''].filter(Boolean)
    if (reasons.length) {
      beats.push({ id: `beat_${beats.length + 1}`, startMs: start, endMs: word.endMs, wordIds: Object.freeze(current.map((value) => value.id)), intent: signal.intent, argumentId: signal.argumentId, visualContext: signal.visualContext, boundaryReasons: Object.freeze(reasons) })
      current = []; start = words[index + 1]?.startMs ?? word.endMs
    }
  }
  return Object.freeze(beats.map((beat) => Object.freeze(beat)))
}

export function adjustEditorialBeat(beat: EditorialBeat, input: { startMs: number; endMs: number; actor: string }, words: readonly AlignedWord[]): Readonly<{ beat: EditorialBeat; wordAlignmentUnchanged: true }> {
  if (input.endMs <= input.startMs) throw new DomainError('INVALID_ARGUMENT', 'Adjusted beat must have positive duration')
  const before = JSON.stringify(words)
  const adjusted = Object.freeze({ ...beat, startMs: input.startMs, endMs: input.endMs, adjustedBy: input.actor, boundaryReasons: Object.freeze([...beat.boundaryReasons, 'director-adjustment']) })
  if (JSON.stringify(words) !== before) throw new DomainError('INVALID_ARGUMENT', 'Word alignment is immutable')
  return Object.freeze({ beat: adjusted, wordAlignmentUnchanged: true as const })
}
