import { createHash } from 'node:crypto'

import type { SpeechRemovalConfirmationRecord } from '../domain/editorial-cut-impact.ts'
import type { SpeechRemovalPassage, SpeechRemovalProposal, SpeechRemovalSearch } from '../domain/editorial-policy-resolution.ts'
import { speechSearchLiteralNotice } from '../domain/editorial-request-texts.ts'
import type { TranscriptSegment, TranscriptWord } from '../domain/media-transcript.ts'
import { defineEditorialPhraseRules, editorialSpeechTokens, type EditorialPhraseRule } from './editorial-phrase-rules.ts'
import { groupSpeechPassages, SPEECH_PASSAGE_POLICY, type SpeechMention } from './speech-passage.ts'
import { sameSpeechWord, speechStemmerFor, type SpeechStemmer } from './speech-stemming.ts'

/**
 * A request to take a subject out of the speech ("tire o trecho que fala de X") becomes a QUESTION with candidates, never a cut. The transcript is
 * searched deterministically for the subject the request quotes; what is found is shown as PASSAGES (the block of speech from the first sentence that
 * mentions the subject to the last, with the sentences between: see `speech-passage.ts`), because a subject is spoken in a stretch, not in a word. The owner's
 * confirmation is the `remove-spoken-content` Command with the rule proposed here and the passages as confirmed (each one adjustable by the person, within
 * limits); nothing is cut without it and nothing is invented: a subject the speech does not say has no candidate.
 *
 * What counts as a mention: the whole subject as a phrase, and each of its words longer than three letters (a search aid for the owner to read and confirm,
 * not a decision). A word is the same word when it is equal as spoken or, in a language the Apollo has a lexicon for (`speech-stemming.ts`), when it varies from
 * it ("venda", "vender", "vendido"). For any other language the search is literal, and the proposal says so.
 */
const MAX_PHRASE_TOKENS = 16
const MAX_ALTERNATIVES = 8
/** A word of the subject is searched alone only when it has more letters than this: "de", "do" and "e" would match nearly every sentence of any speech. */
const MIN_WORD_LETTERS = 3
const MAX_LABEL = 160
const MAX_TEXT = 140
const EPSILON = 0.001

/** The id a rule must carry to answer the request for a subject: the same words, in any case or punctuation, are always the same id. */
export function speechRemovalRuleId(subject: string): string {
  const tokens = editorialSpeechTokens(subject)
  return `speech-${createHash('sha256').update(tokens.join(' '), 'utf8').digest('hex').slice(0, 12)}`
}

function shorten(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/** The transcript as the cut reads it: the words, the segments the passages are made of (none known: sentences are found from the words), and the language. */
export interface SearchableTranscript {
  words: readonly Readonly<TranscriptWord>[]
  segments?: readonly Readonly<TranscriptSegment>[]
  /** The language of the transcript as recorded: it decides whether variations of a word are searched (a lexicon exists) or only the word as spoken. */
  language?: string
}

/**
 * The proposal for one subject. `requested` are the rules of the removal Commands the project already holds: the proposal is `confirmed` only by a rule with its id
 * AND its words (the same id with other alternatives is another cut, and confirms nothing), and, when the confirmation recorded passages, only when they hold every
 * mention the proposal found.
 */
export function proposeSpeechRemoval(
  subject: string,
  transcript: Readonly<SearchableTranscript>,
  options: Readonly<{ sourceTranscriptId?: string; requested?: readonly Readonly<EditorialPhraseRule>[] }> = {},
): Readonly<SpeechRemovalProposal> {
  const proposal = proposeWithoutConfirmation(subject, transcript)
  const words = (alternatives: readonly (readonly string[])[]) => JSON.stringify(alternatives.map((tokens) => tokens.join(' ')).toSorted())
  // Confirmed only by a removal Command that CONFIRMED this proposal (it carries the subject it answers): the id and the words of a proposal can be computed, so an
  // explicit Command of the client with the same rule is a valid cut and still not the confirmation.
  const confirmed = proposal.searchable && (options.requested ?? []).some((rule) => rule.id === proposal.ruleId && rule.confirmation?.subject === subject &&
    words(rule.alternatives) === words(defineEditorialPhraseRules([{ id: proposal.ruleId, label: proposal.label, alternatives: proposal.alternatives }])[0]!.alternatives) &&
    confirmationHoldsEveryMention(rule.confirmation, proposal.passages ?? []))
  return Object.freeze({ ...proposal, ...(options.sourceTranscriptId !== undefined ? { sourceTranscriptId: options.sourceTranscriptId } : {}), ...(confirmed ? { confirmed: true } : {}) })
}

/** A confirmation made before passages existed holds the cut of the phrase; one that recorded passages holds every mention of the proposal inside them. */
function confirmationHoldsEveryMention(confirmation: Readonly<SpeechRemovalConfirmationRecord>, passages: readonly Readonly<SpeechRemovalPassage>[]): boolean {
  if (confirmation.passages === undefined) return true
  return passages.every((passage) => passage.mentions.every((mention) => {
    const middle = (mention.startSeconds + mention.endSeconds) / 2
    return confirmation.passages!.some((confirmed) => middle >= confirmed.startSeconds - EPSILON && middle <= confirmed.endSeconds + EPSILON)
  }))
}

interface RawMention {
  first: number
  last: number
  /** The words of the mention as spoken, lower case, without punctuation: what the rule of the cut will look for. */
  form: string
  /** The same, as the editorial cut compares words. */
  key: string
}

const letters = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, '')

function searchOf(language: string | undefined, stemmer: SpeechStemmer | undefined): Readonly<SpeechRemovalSearch> {
  const recorded = language !== undefined && language.trim().length > 0 ? language.trim() : null
  return Object.freeze({
    language: recorded,
    matching: stemmer ? 'stem' as const : 'literal' as const,
    lexicon: stemmer?.id ?? null,
    ...(stemmer ? {} : { notice: speechSearchLiteralNotice(recorded) }),
    policy: SPEECH_PASSAGE_POLICY,
  })
}

function proposeWithoutConfirmation(subject: string, transcript: Readonly<SearchableTranscript>): Readonly<SpeechRemovalProposal> {
  const label = subject.replace(/\s+/gu, ' ').trim().slice(0, MAX_LABEL)
  const tokens = editorialSpeechTokens(subject)
  const ruleId = speechRemovalRuleId(subject)
  const stemmer = speechStemmerFor(transcript.language)
  const search = searchOf(transcript.language, stemmer)
  const notSearchable = () => Object.freeze({ subject, ruleId, label, alternatives: Object.freeze([subject]), basis: 'phrase' as const, searchable: false, matches: Object.freeze([]), search })
  if (tokens.length === 0 || tokens.length > MAX_PHRASE_TOKENS) return notSearchable()

  const spoken = transcript.words.map((word) => editorialSpeechTokens(word.word).join(''))
  const raw: RawMention[] = []
  const at = (first: number, last: number): RawMention => ({
    first, last,
    form: transcript.words.slice(first, last + 1).map((word) => letters(word.word).toLowerCase()).filter(Boolean).join(' '),
    key: spoken.slice(first, last + 1).join(' '),
  })
  // The whole subject as a phrase, each of its words equal or varied (several words).
  let phraseFound = false
  if (tokens.length >= 2) {
    for (let start = 0; start + tokens.length <= spoken.length; start += 1) {
      if (tokens.every((token, offset) => sameSpeechWord(stemmer, spoken[start + offset]!, token))) {
        raw.push(at(start, start + tokens.length - 1))
        phraseFound = true
      }
    }
  }
  // Each word of the subject longer than three letters, alone (a lone word of three letters or fewer is searched only as the whole subject, as spoken).
  const contentWords = [...new Set(tokens.filter((token) => token.length > MIN_WORD_LETTERS))].slice(0, MAX_ALTERNATIVES)
  const lone = tokens.length === 1 && contentWords.length === 0 ? [tokens[0]!] : contentWords
  if (lone.length > 0) {
    for (let index = 0; index < spoken.length; index += 1) {
      if (lone.some((word) => sameSpeechWord(stemmer, spoken[index]!, word))) raw.push(at(index, index))
    }
  }

  // What is shown: a word that stands inside a phrase mention is shown with it.
  const shown = raw.filter((mention, index) => !raw.some((other, otherIndex) => otherIndex !== index && other.first <= mention.first && other.last >= mention.last &&
    (other.last - other.first > mention.last - mention.first || (other.last - other.first === mention.last - mention.first && otherIndex < index))))
  const mentions: SpeechMention[] = shown.toSorted((left, right) => left.first - right.first).map((mention) => Object.freeze({
    startSeconds: transcript.words[mention.first]!.start,
    endSeconds: transcript.words[mention.last]!.end,
    text: transcript.words.slice(mention.first, mention.last + 1).map((word) => word.word.trim()).join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''),
  }))
  const passages = groupSpeechPassages({ ruleId, words: transcript.words, segments: transcript.segments ?? [], mentions })

  // The rule of the cut looks for the forms the speech actually says (at most eight): the fewest that leave no passage without one of its own mentions.
  const forms = new Map<string, { form: string; count: number; passages: Set<number> }>()
  for (const mention of raw) {
    if (mention.key.length === 0) continue
    const middle = (transcript.words[mention.first]!.start + transcript.words[mention.last]!.end) / 2
    const place = passages.findIndex((passage) => middle >= passage.startSeconds - EPSILON && middle <= passage.endSeconds + EPSILON)
    const entry = forms.get(mention.key) ?? { form: mention.form, count: 0, passages: new Set<number>() }
    entry.count += 1
    if (place >= 0) entry.passages.add(place)
    forms.set(mention.key, entry)
  }
  const chosen: string[] = []
  const covered = new Set<number>()
  const order = (left: [string, { count: number }], right: [string, { count: number }]) => right[1].count - left[1].count || left[0].localeCompare(right[0])
  while (covered.size < passages.length && chosen.length < MAX_ALTERNATIVES) {
    const best = [...forms.entries()].filter(([key]) => !chosen.includes(key))
      .map(([key, entry]) => [key, entry, [...entry.passages].filter((place) => !covered.has(place)).length] as const)
      .filter(([, , gain]) => gain > 0)
      .sort((left, right) => right[2] - left[2] || order([left[0], left[1]], [right[0], right[1]]))[0]
    if (best === undefined) break
    chosen.push(best[0])
    best[1].passages.forEach((place) => covered.add(place))
  }
  if (covered.size < passages.length) return notSearchable()
  for (const [key] of [...forms.entries()].sort(order)) {
    if (chosen.length >= MAX_ALTERNATIVES) break
    if (!chosen.includes(key)) chosen.push(key)
  }
  const alternatives = passages.length === 0 ? [subject] : chosen.map((key) => forms.get(key)!.form)
  const basis = tokens.length === 1 || phraseFound ? 'phrase' as const : 'words' as const
  return Object.freeze({
    subject, ruleId, label, alternatives: Object.freeze(alternatives), basis, searchable: true,
    matches: Object.freeze(passages.map((passage) => Object.freeze({ startSeconds: passage.startSeconds, endSeconds: passage.endSeconds, text: shorten(passage.text) }))),
    passages, search,
  })
}
