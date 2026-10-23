import { createHash } from 'node:crypto'

import type { SpeechRemovalProposal } from '../domain/editorial-policy-resolution.ts'
import type { MediaTranscript, TranscriptSegment, TranscriptWord } from '../domain/media-transcript.ts'
import { defineEditorialPhraseRules, deriveEditorialExclusions, editorialSpeechTokens } from './editorial-phrase-rules.ts'

/**
 * A request to take a subject out of the speech ("tire o trecho que fala de X") becomes a QUESTION with candidates, never a cut. The transcript is
 * searched deterministically for the subject the request quotes - the same word-for-word comparison, and the same expansion to whole segments, that
 * the `remove-spoken-content` Command applies - so what is shown to the owner is exactly what the Command would take out. The owner's confirmation
 * is that Command, with the rule proposed here; nothing is cut without it and nothing is invented: a subject the speech does not say has no candidate.
 *
 * Searching is language-free. The whole subject is looked for as spoken; when it is not there as a phrase, its words longer than three letters are
 * looked for one by one (a search aid for the owner to read and confirm, not a decision), and the proposal says which of the two found what it shows.
 */
const MAX_PHRASE_TOKENS = 16
const MAX_ALTERNATIVES = 8
/** A word of the subject is searched alone only when it has more letters than this: "de", "do" and "e" would match nearly every sentence of any speech. */
const MIN_WORD_LETTERS = 3
const MAX_LABEL = 160
const MAX_TEXT = 140

/** The id a rule must carry to answer the request for a subject: the same words, in any case or punctuation, are always the same id. */
export function speechRemovalRuleId(subject: string): string {
  const tokens = editorialSpeechTokens(subject)
  return `speech-${createHash('sha256').update(tokens.join(' '), 'utf8').digest('hex').slice(0, 12)}`
}

function textBetween(words: readonly TranscriptWord[], startSeconds: number, endSeconds: number, fallback: string): string {
  const spoken = words.filter((word) => word.start >= startSeconds - 0.001 && word.end <= endSeconds + 0.001).map((word) => word.word.trim()).join(' ').trim()
  const text = spoken.length > 0 ? spoken : fallback
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/** The transcript as the cut reads it: the words, and the segments the cut expands a match to (none known: no expansion). */
export interface SearchableTranscript {
  words: readonly Readonly<TranscriptWord>[]
  segments?: readonly Readonly<TranscriptSegment>[]
}

export function proposeSpeechRemoval(subject: string, transcript: Readonly<SearchableTranscript>): Readonly<SpeechRemovalProposal> {
  const label = subject.replace(/\s+/gu, ' ').trim().slice(0, MAX_LABEL)
  const tokens = editorialSpeechTokens(subject)
  const ruleId = speechRemovalRuleId(subject)
  const asTranscript = { words: transcript.words, segments: transcript.segments ?? [] } as unknown as Readonly<MediaTranscript>
  const search = (alternatives: readonly string[]) => {
    const rules = defineEditorialPhraseRules([{ id: ruleId, label, alternatives }])
    return deriveEditorialExclusions(asTranscript, rules).map((range) => Object.freeze({
      startSeconds: range.sourceStartSeconds, endSeconds: range.sourceEndSeconds,
      text: textBetween(transcript.words, range.sourceStartSeconds, range.sourceEndSeconds, range.matchedText),
    }))
  }
  if (tokens.length === 0 || tokens.length > MAX_PHRASE_TOKENS) {
    return Object.freeze({ subject, ruleId, label, alternatives: Object.freeze([subject]), basis: 'phrase' as const, searchable: false, matches: Object.freeze([]) })
  }
  const asPhrase = search([subject])
  if (asPhrase.length > 0 || tokens.length === 1) {
    return Object.freeze({ subject, ruleId, label, alternatives: Object.freeze([subject]), basis: 'phrase' as const, searchable: true, matches: Object.freeze(asPhrase) })
  }
  const words = [...new Set(subject.split(/\s+/u).map((word) => word.replace(/[^\p{L}\p{N}]+/gu, '')).filter((word) => (word.match(/[\p{L}\p{N}]/gu) ?? []).length > MIN_WORD_LETTERS))]
    .slice(0, MAX_ALTERNATIVES)
  if (words.length === 0) {
    return Object.freeze({ subject, ruleId, label, alternatives: Object.freeze([subject]), basis: 'phrase' as const, searchable: true, matches: Object.freeze([]) })
  }
  return Object.freeze({ subject, ruleId, label, alternatives: Object.freeze(words), basis: 'words' as const, searchable: true, matches: Object.freeze(search(words)) })
}
