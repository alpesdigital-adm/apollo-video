/**
 * Deterministic word variation for the search of a spoken subject (ADR-160): "venda", "vender" and "vendido" are one subject, "curso" and
 * "cursos" are one. A word is reduced to its stem by stripping the longest ending of a closed list that the language has, and two words are the
 * same subject when their stems are equal. No model is asked and nothing is learned: the same word in the same language is always the same stem.
 *
 * The lists are LEXICONS OF A LANGUAGE (endings of its words), not words of any subject. A language without a lexicon here has no variation at all: the
 * search is then literal (the word as spoken), and the proposal says so. A match found by variation is a candidate for a person to read and confirm,
 * never a decision.
 */
export interface SpeechStemmer {
  /** The lexicon this stemmer is: language and version, written into the proposal. */
  id: string
  /** The stem of a word already normalised like the editorial cut compares words (lower case, no diacritics, no punctuation). */
  stem(token: string): string
}

/** A stem shorter than this is not a stem: stripping would join unrelated words ("casa" and "casamento"), so the word is left whole. */
const MIN_STEM_LETTERS = 4

interface Lexicon {
  id: string
  /** Plural endings turned into the singular form of the same family, tried in order, first that fits. */
  plurals: readonly (readonly [string, string])[]
  /** Endings stripped (derivation, verb and gender), longest first. */
  endings: readonly string[]
}

const byLength = (endings: readonly string[]) => Object.freeze([...endings].sort((left, right) => right.length - left.length || left.localeCompare(right)))

const LEXICONS: Readonly<Record<string, Lexicon>> = Object.freeze({
  pt: {
    id: 'pt-endings/v1',
    plurals: [['oes', 'ao'], ['aes', 'ao'], ['aos', 'ao'], ['ais', 'al'], ['eis', 'el'], ['ns', 'm']],
    endings: byLength([
      'amentos', 'imentos', 'amento', 'imento', 'adores', 'adora', 'ador', 'idade', 'mente', 'avel', 'ivel', 'acao', 'icao', 'cao', 'sao',
      'ando', 'endo', 'indo', 'ados', 'adas', 'ado', 'ada', 'ido', 'ida', 'aram', 'eram', 'iram', 'amos', 'emos', 'imos',
      'ar', 'er', 'ir', 'ou', 'eu', 'iu', 'am', 'em', 'ia', 'io', 'a', 'o', 'e',
    ]),
  },
  es: {
    id: 'es-endings/v1',
    plurals: [['ciones', 'cion'], ['siones', 'sion'], ['ales', 'al']],
    endings: byLength([
      'amientos', 'imientos', 'amiento', 'imiento', 'adores', 'adora', 'ador', 'idad', 'mente', 'cion', 'sion',
      'ando', 'iendo', 'ados', 'adas', 'ado', 'ada', 'ido', 'ida', 'aron', 'ieron', 'amos', 'emos', 'imos',
      'ar', 'er', 'ir', 'an', 'en', 'ia', 'io', 'a', 'o', 'e',
    ]),
  },
  en: {
    id: 'en-endings/v1',
    plurals: [['ies', 'y']],
    endings: byLength(['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'ers', 'er', 'ied', 'ed', 'es', 'ly', 'e', 's']),
  },
})

function stemWith(lexicon: Lexicon, token: string): string {
  // An ending that itself ends in "s" (a plural or a person of the verb: "ados", "amos") is stripped whole, before the plural "s" is taken away alone.
  const withS = lexicon.endings.find((candidate) => candidate.endsWith('s') && token.endsWith(candidate) && token.length - candidate.length >= MIN_STEM_LETTERS)
  if (withS) return token.slice(0, token.length - withS.length)
  let word = token
  const plural = lexicon.plurals.find(([ending]) => word.endsWith(ending) && word.length - ending.length + 1 >= MIN_STEM_LETTERS)
  if (plural) word = `${word.slice(0, word.length - plural[0].length)}${plural[1]}`
  else if (word.endsWith('s') && !word.endsWith('ss') && word.length - 1 >= MIN_STEM_LETTERS) word = word.slice(0, -1)
  const ending = lexicon.endings.find((candidate) => word.endsWith(candidate) && word.length - candidate.length >= MIN_STEM_LETTERS)
  return ending ? word.slice(0, word.length - ending.length) : word
}

/** The stemmer of the language of a transcript (`pt`, `pt-BR`, `es-MX`, `en-US`...), or undefined when the Apollo has no lexicon for it: the search is then literal. */
export function speechStemmerFor(language: string | undefined): SpeechStemmer | undefined {
  const primary = (language ?? '').trim().toLowerCase().split(/[-_]/u)[0] ?? ''
  const lexicon = Object.hasOwn(LEXICONS, primary) ? LEXICONS[primary] : undefined
  return lexicon ? Object.freeze({ id: lexicon.id, stem: (token: string) => stemWith(lexicon, token) }) : undefined
}

/** Two normalised words are the same subject: equal as spoken, or (when the language has a lexicon and both have more than three letters) equal in stem. */
export function sameSpeechWord(stemmer: SpeechStemmer | undefined, left: string, right: string): boolean {
  if (left === right) return left.length > 0
  if (!stemmer || left.length <= MIN_STEM_LETTERS - 1 || right.length <= MIN_STEM_LETTERS - 1) return false
  return stemmer.stem(left) === stemmer.stem(right)
}
