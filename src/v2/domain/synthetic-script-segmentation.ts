import { createHash } from 'node:crypto'

import { assertDomain } from './errors.ts'

/**
 * Deterministic pt-BR-aware sentence segmentation for synthetic script plans.
 *
 * The algorithm version is part of every block cache key: changing any rule
 * here must bump the version so previously cached generations are never
 * silently reused against a different preparation.
 */
export const SYNTHETIC_SCRIPT_SEGMENTATION_VERSION = 'synthetic-script-segmentation/v1' as const

export interface ScriptSegmentationConstraints {
  minCharacters: number
  maxCharacters: number
}

export interface SegmentedScriptBlock {
  exactText: string
  normalizedText: string
  normalizedTextHash: string
  occurrence: number
}

const MAX_SCRIPT_CHARACTERS = 100_000

// Common pt-BR abbreviations whose trailing period never ends a sentence.
// Lowercased, stored without the final period; internal periods are kept.
const ABBREVIATIONS = new Set([
  'sr', 'sra', 'srta', 'dr', 'dra', 'prof', 'profa', 'eng', 'adv', 'exmo', 'exma',
  'av', 'al', 'esq', 'dir', 'jr', 'ltda', 'cia', 's.a',
  'km', 'kg', 'cm', 'mm', 'ml', 'seg', 'min',
  'etc', 'ex', 'obs', 'ref', 'tel', 'cel', 'cap', 'art', 'inc', 'par',
  'pag', 'pág', 'pp', 'vs', 'cf', 'fl', 'fls',
  'no', 'núm', 'num', 'p.ex', 'i.e', 'e.g', 'a.c', 'd.c',
])

const CLOSERS = new Set([')', ']', '}', '»', '”', '’', '"', "'"])
const TERMINATORS = new Set(['.', '!', '?', '…'])
const SOFT_SPLITTERS = [';', ':', ',', '—', '–']

// Control characters other than line breaks are rejected fail-closed.
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x7f || (code < 0x20 && code !== 0x0a && code !== 0x0d)) return true
  }
  return false
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9'
}

function isLetter(value: string | undefined): boolean {
  return value !== undefined && /\p{L}/u.test(value)
}

/** Word made of letters and internal periods immediately before `index`. */
function trailingWord(text: string, index: number): string {
  let start = index
  while (start > 0) {
    const previous = text[start - 1]!
    if (isLetter(previous) || (previous === '.' && start - 1 > 0 && isLetter(text[start - 2]))) start -= 1
    else break
  }
  return text.slice(start, index)
}

interface QuoteState {
  parenthesisDepth: number
  guillemetDepth: number
  curlyDoubleDepth: number
  curlySingleDepth: number
  straightDoubleOpen: boolean
}

function updateQuoteState(state: QuoteState, character: string): void {
  if (character === '(' || character === '[' || character === '{') state.parenthesisDepth += 1
  else if (character === ')' || character === ']' || character === '}') state.parenthesisDepth = Math.max(0, state.parenthesisDepth - 1)
  else if (character === '«') state.guillemetDepth += 1
  else if (character === '»') state.guillemetDepth = Math.max(0, state.guillemetDepth - 1)
  else if (character === '“') state.curlyDoubleDepth += 1
  else if (character === '”') state.curlyDoubleDepth = Math.max(0, state.curlyDoubleDepth - 1)
  else if (character === '‘') state.curlySingleDepth += 1
  else if (character === '’') state.curlySingleDepth = Math.max(0, state.curlySingleDepth - 1)
  else if (character === '"') state.straightDoubleOpen = !state.straightDoubleOpen
}

function insideProtectedRegion(state: QuoteState): boolean {
  return state.parenthesisDepth > 0 || state.guillemetDepth > 0 ||
    state.curlyDoubleDepth > 0 || state.curlySingleDepth > 0 || state.straightDoubleOpen
}

/**
 * Splits one hard segment (a deliberate line) into complete sentences.
 * Returns exact substrings of the segment, in order, covering all its text.
 */
function sentenceRanges(segment: string): string[] {
  const sentences: string[] = []
  const state: QuoteState = {
    parenthesisDepth: 0, guillemetDepth: 0, curlyDoubleDepth: 0, curlySingleDepth: 0, straightDoubleOpen: false,
  }
  let start = 0
  let index = 0
  while (index < segment.length) {
    const character = segment[index]!
    updateQuoteState(state, character)
    if (!TERMINATORS.has(character) || insideProtectedRegion(state)) {
      index += 1
      continue
    }
    // Consume the full terminator run (…, !?, !!!, ...).
    let terminatorEnd = index + 1
    let periodRun = character === '.' ? 1 : 0
    while (terminatorEnd < segment.length && TERMINATORS.has(segment[terminatorEnd]!)) {
      if (segment[terminatorEnd] === '.') periodRun += 1
      terminatorEnd += 1
    }
    const isEllipsis = character === '…' || periodRun >= 2
    if (character === '.' && periodRun === 1) {
      // A period between digits is a decimal or a date, never a boundary.
      if (isDigit(segment[index - 1]) && isDigit(segment[terminatorEnd])) {
        index = terminatorEnd
        continue
      }
      // Abbreviations and single-letter initials never end a sentence.
      const word = trailingWord(segment, index).toLocaleLowerCase('pt-BR')
      if (word.length === 1 || ABBREVIATIONS.has(word)) {
        index = terminatorEnd
        continue
      }
    }
    // Closing quotes and brackets belong to the finished sentence.
    while (terminatorEnd < segment.length && CLOSERS.has(segment[terminatorEnd]!)) {
      updateQuoteState(state, segment[terminatorEnd]!)
      terminatorEnd += 1
    }
    const atEnd = terminatorEnd >= segment.length
    const followedByWhitespace = !atEnd && /\s/.test(segment[terminatorEnd]!)
    if (!atEnd && !followedByWhitespace) {
      index = terminatorEnd
      continue
    }
    if (isEllipsis && !atEnd) {
      // An ellipsis only ends a reflection when a new one visibly starts.
      let nextVisible = terminatorEnd
      while (nextVisible < segment.length && /\s/.test(segment[nextVisible]!)) nextVisible += 1
      const next = segment[nextVisible]
      if (next !== undefined && isLetter(next) && next.toLocaleLowerCase('pt-BR') === next) {
        index = terminatorEnd
        continue
      }
    }
    sentences.push(segment.slice(start, terminatorEnd))
    start = terminatorEnd
    index = terminatorEnd
  }
  // The final block may deliberately end without punctuation.
  if (start < segment.length) sentences.push(segment.slice(start))
  return sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0)
}

/** Splits an oversized sentence at the safest boundary, never inside a word. */
function safeSplit(sentence: string, maxCharacters: number): string[] {
  if (sentence.length <= maxCharacters) return [sentence]
  const window = sentence.slice(0, maxCharacters + 1)
  let cut = -1
  for (const splitter of SOFT_SPLITTERS) {
    for (let index = window.length - 1; index > 0; index -= 1) {
      if (window[index] === splitter && index + 1 < sentence.length && /\s/.test(sentence[index + 1]!)) {
        cut = index + 1
        break
      }
    }
    if (cut > 0) break
  }
  if (cut <= 0) {
    for (let index = Math.min(maxCharacters, sentence.length - 1); index > 0; index -= 1) {
      if (/\s/.test(sentence[index]!)) {
        cut = index
        break
      }
    }
  }
  assertDomain(
    cut > 0,
    'INVALID_ARGUMENT',
    'Script sentence exceeds the provider limit and has no safe split point',
  )
  const head = sentence.slice(0, cut).trim()
  const tail = sentence.slice(cut).trim()
  return [head, ...safeSplit(tail, maxCharacters)]
}

/**
 * Deterministically segments an approved script into complete sentences or
 * reflections. Deliberate line breaks are hard boundaries; abbreviations,
 * decimals, dates, quotes, parentheses, diacritics and emojis are preserved;
 * the final block may end without punctuation. Blocks shorter than
 * `minCharacters` merge with a neighbour inside the same line when possible;
 * blocks longer than `maxCharacters` split at safe boundaries, never inside a
 * word. Identical sentences remain distinct occurrences, numbered in order.
 */
export function segmentSyntheticScript(input: {
  text: string
  constraints: ScriptSegmentationConstraints
}): readonly Readonly<SegmentedScriptBlock>[] {
  const { minCharacters, maxCharacters } = input.constraints
  assertDomain(
    Number.isSafeInteger(minCharacters) && minCharacters >= 1 &&
      Number.isSafeInteger(maxCharacters) && maxCharacters >= minCharacters && maxCharacters <= 10_000,
    'INVALID_ARGUMENT',
    'Script segmentation constraints are invalid',
  )
  assertDomain(typeof input.text === 'string', 'INVALID_ARGUMENT', 'Script text is required')
  const text = input.text.normalize('NFC').replace(/\t/g, ' ')
  assertDomain(
    !hasControlCharacters(text),
    'INVALID_ARGUMENT',
    'Script text contains control characters',
  )
  const trimmed = text.trim()
  assertDomain(
    trimmed.length > 0 && trimmed.length <= MAX_SCRIPT_CHARACTERS,
    'INVALID_ARGUMENT',
    'Script text is empty or too large',
  )

  const blocks: string[] = []
  // Any deliberate line break is a hard boundary between blocks.
  for (const line of trimmed.split(/\r?\n+/)) {
    const segment = line.trim()
    if (segment.length === 0) continue
    const sentences = sentenceRanges(segment).flatMap((sentence) => safeSplit(sentence, maxCharacters))
    // Best-effort merge of too-short sentences with a neighbour in the same
    // line; a line that is entirely short still yields its own block.
    const merged: string[] = []
    for (const sentence of sentences) {
      const previous = merged.at(-1)
      if (
        previous !== undefined &&
        (previous.length < minCharacters || sentence.length < minCharacters) &&
        previous.length + 1 + sentence.length <= maxCharacters
      ) {
        merged[merged.length - 1] = `${previous} ${sentence}`
      } else {
        merged.push(sentence)
      }
    }
    blocks.push(...merged)
  }
  assertDomain(blocks.length > 0, 'INVALID_ARGUMENT', 'Script text produced no blocks')

  const occurrences = new Map<string, number>()
  return Object.freeze(blocks.map((exactText) => {
    const normalizedText = normalizedWhitespace(exactText)
    const normalizedTextHash = sha256(normalizedText)
    const occurrence = (occurrences.get(normalizedTextHash) ?? 0) + 1
    occurrences.set(normalizedTextHash, occurrence)
    return Object.freeze({ exactText, normalizedText, normalizedTextHash, occurrence })
  }))
}
