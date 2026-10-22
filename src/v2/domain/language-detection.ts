/**
 * Turning what a speech-recognition provider reports as the language of a speech into a BCP-47 tag, deterministically (ADR-160 F3).
 *
 * Whisper-family providers (measured on Groq `whisper-large-v3-turbo`, `verbose_json`, no `language` sent) report the language they detected as
 * the capitalised English name of the language - `"Portuguese"` - not as a code. The names are a closed table (the languages Whisper knows, with the
 * aliases it accepts); a code is accepted as it is. The result is the BASE language: detection does not tell a region (Whisper does not tell pt-BR
 * from pt-PT), so none is invented - a region exists only where the requester declared one. What cannot be resolved is `null` and the transcript
 * records the undetermined language (`und`), which the Director turns into a question.
 */
const WHISPER_LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  english: 'en', chinese: 'zh', german: 'de', spanish: 'es', russian: 'ru', korean: 'ko', french: 'fr', japanese: 'ja', portuguese: 'pt', turkish: 'tr',
  polish: 'pl', catalan: 'ca', dutch: 'nl', arabic: 'ar', swedish: 'sv', italian: 'it', indonesian: 'id', hindi: 'hi', finnish: 'fi', vietnamese: 'vi',
  hebrew: 'he', ukrainian: 'uk', greek: 'el', malay: 'ms', czech: 'cs', romanian: 'ro', danish: 'da', hungarian: 'hu', tamil: 'ta', norwegian: 'no',
  thai: 'th', urdu: 'ur', croatian: 'hr', bulgarian: 'bg', lithuanian: 'lt', latin: 'la', maori: 'mi', malayalam: 'ml', welsh: 'cy', slovak: 'sk',
  telugu: 'te', persian: 'fa', latvian: 'lv', bengali: 'bn', serbian: 'sr', azerbaijani: 'az', slovenian: 'sl', kannada: 'kn', estonian: 'et',
  macedonian: 'mk', breton: 'br', basque: 'eu', icelandic: 'is', armenian: 'hy', nepali: 'ne', mongolian: 'mn', bosnian: 'bs', kazakh: 'kk',
  albanian: 'sq', swahili: 'sw', galician: 'gl', marathi: 'mr', punjabi: 'pa', sinhala: 'si', khmer: 'km', shona: 'sn', yoruba: 'yo', somali: 'so',
  afrikaans: 'af', occitan: 'oc', georgian: 'ka', belarusian: 'be', tajik: 'tg', sindhi: 'sd', gujarati: 'gu', amharic: 'am', yiddish: 'yi', lao: 'lo',
  uzbek: 'uz', faroese: 'fo', 'haitian creole': 'ht', pashto: 'ps', turkmen: 'tk', nynorsk: 'nn', maltese: 'mt', sanskrit: 'sa', luxembourgish: 'lb',
  myanmar: 'my', tibetan: 'bo', tagalog: 'tl', malagasy: 'mg', assamese: 'as', tatar: 'tt', hawaiian: 'haw', lingala: 'ln', hausa: 'ha', bashkir: 'ba',
  javanese: 'jw', sundanese: 'su', cantonese: 'yue',
  // the aliases Whisper accepts for the same languages
  burmese: 'my', valencian: 'ca', flemish: 'nl', haitian: 'ht', letzeburgesch: 'lb', pushto: 'ps', panjabi: 'pa', moldavian: 'ro', moldovan: 'ro',
  sinhalese: 'si', castilian: 'es',
})

/** The BCP-47 tag a provider's language report stands for, or `null` when it cannot be resolved without guessing. */
export function normalizeDetectedLanguage(reported: unknown): string | null {
  if (typeof reported !== 'string') return null
  const text = reported.trim()
  if (text.length === 0 || text.length > 64) return null
  if (/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(text)) {
    try {
      const canonical = Intl.getCanonicalLocales(text.replace('_', '-'))[0]
      return canonical === undefined || canonical === 'und' ? null : canonical
    } catch { return null }
  }
  return WHISPER_LANGUAGE_NAMES[text.toLowerCase().replace(/\s+/g, ' ')] ?? null
}

/** The primary language subtag of a tag, lower case (`pt-BR` -> `pt`). */
export function primaryLanguageSubtag(tag: string): string {
  return tag.trim().split(/[-_]/)[0]!.toLowerCase()
}
