/**
 * Deterministic word variation for the search of a spoken subject (ADR-160): "sorteio", "sortear" and "sorteado" are one subject, "formulário" and
 * "formulários" are one. No model is asked and nothing is learned: the same word in the same language is always the same stem.
 *
 * Only SAFE variations of one lemma are joined, so that a word does not call another one that merely looks like it ("venda"/"vendo", "conta"/"contar",
 * "parte"/"partido", "banco"/"bancada", "plan"/"plane"):
 *  - the plural of a word ("formulários", "inscrições");
 *  - the forms of a VERB that end in a closed list of endings of its conjugation (infinitive, participle, gerund, the person endings): "sortear",
 *    "sorteado", "sorteamos"; a form stripped this way carries the mark of a verb, so it equals only another form of the same verb, never a noun that
 *    has the same letters ("sorte" is not "sortear");
 *  - for the verbs in -ear of Portuguese and Spanish, the forms in -eio/-eia/-eo (the noun "sorteio" and "eu sorteio" are the verb "sortear").
 * The gender endings -o/-a and the derivational endings (-mento, -dade, -mente...) are NOT stripped: they join words that are not the same word.
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

/** A stem shorter than this is not a stem: stripping would join unrelated words, so the word is left whole. */
const MIN_STEM_LETTERS = 4
/** What a stem carries when the word was a form of a verb: it equals only another form of a verb. */
const VERB_MARK = '~v'

interface Lexicon {
  id: string
  /** Whether a stem made from a verb form carries the mark of a verb (the lexicons whose base form of a verb is not a form of the verb itself do not need it). */
  marked: boolean
  /** Plural endings turned into the singular form of the same word, tried in order, first that fits. */
  plurals: readonly (readonly [string, string])[]
  /** The endings of the conjugation of a verb (infinitive, participle in its genders and numbers, gerund, person endings), longest first. */
  verbEndings: readonly string[]
  /** The forms in -eio/-eia/-eo of a verb in -ear: [ending of the form, what the stem of the verb ends with once the ending is taken away]. */
  earForms: readonly string[]
}

const byLength = (endings: readonly string[]) => Object.freeze([...endings].sort((left, right) => right.length - left.length || left.localeCompare(right)))

const LEXICONS: Readonly<Record<string, Lexicon>> = Object.freeze({
  pt: {
    id: 'pt-endings/v2',
    marked: true,
    plurals: [['oes', 'ao'], ['aes', 'ao'], ['aos', 'ao'], ['ais', 'al'], ['eis', 'el']],
    verbEndings: byLength(['ando', 'endo', 'indo', 'ados', 'adas', 'idos', 'idas', 'ado', 'ada', 'ido', 'ida', 'amos', 'emos', 'imos', 'aram', 'eram', 'iram', 'ar', 'er', 'ir', 'ou', 'eu', 'iu', 'am']),
    earForms: byLength(['eios', 'eias', 'eio', 'eia']),
  },
  es: {
    id: 'es-endings/v2',
    marked: true,
    plurals: [['ciones', 'cion'], ['siones', 'sion'], ['ales', 'al']],
    verbEndings: byLength(['ando', 'iendo', 'ados', 'adas', 'idos', 'idas', 'ado', 'ada', 'ido', 'ida', 'amos', 'emos', 'imos', 'aron', 'ieron', 'ar', 'er', 'ir']),
    earForms: byLength(['eos', 'eo']),
  },
  en: {
    id: 'en-endings/v2',
    marked: false,
    plurals: [['ies', 'y']],
    verbEndings: byLength(['ings', 'ing', 'ed']),
    earForms: [],
  },
})

function stemWith(lexicon: Lexicon, token: string): string {
  const fits = (candidate: string) => token.endsWith(candidate) && token.length - candidate.length >= MIN_STEM_LETTERS
  // A form of a verb: the longest ending of its conjugation.
  const verb = lexicon.verbEndings.find(fits)
  if (verb) return `${token.slice(0, token.length - verb.length)}${lexicon.marked ? VERB_MARK : ''}`
  // The forms in -eio/-eia/-eo of a verb in -ear: the stem is the one of the infinitive ("sorteio" -> "sorte", as "sortear" -> "sorte").
  const ear = lexicon.earForms.find((candidate) => token.endsWith(candidate) && token.length - candidate.length + 1 >= MIN_STEM_LETTERS)
  if (ear) {
    const root = token.slice(0, token.length - ear.length + 1)
    // The plural of the noun ("sorteios") is the noun.
    return `${root}${lexicon.marked ? VERB_MARK : ''}`
  }
  // The plural of a word is the word.
  const plural = lexicon.plurals.find(([ending]) => token.endsWith(ending) && token.length - ending.length + 1 >= MIN_STEM_LETTERS)
  if (plural) return `${token.slice(0, token.length - plural[0].length)}${plural[1]}`
  if (token.endsWith('s') && !token.endsWith('ss') && token.length - 1 >= MIN_STEM_LETTERS) return stemWith(lexicon, token.slice(0, -1))
  return token
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
