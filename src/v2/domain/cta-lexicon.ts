import type { DesiredAction, DesiredActionKind } from './desired-action.ts'

/**
 * The words with which a spoken call to action is recognised, by language (ADR-160, docs/specs/01 s7.4.3). A lexicon is a fact about a
 * language, not an editorial choice: it says which words a speaker of that language uses to ask for an action. The language comes from
 * the editorial policy resolution (the request, or the observed transcript); a language without a lexicon is not guessed at: the call to
 * action is then judged only on the explicit text the requester gave (`verbalCta` / `visualCta`) and otherwise reported as
 * `not-evaluable`, never as absent and never as present.
 */
export type SpokenCtaKind = Exclude<DesiredActionKind, 'continue-viewing'>

export interface CtaLexicon {
  /** Primary language subtag the lexicon is for (BCP 47, lower case). */
  language: string
  patterns: Readonly<Record<SpokenCtaKind, RegExp>>
}

const lexicon = (language: string, patterns: Record<SpokenCtaKind, RegExp>): Readonly<CtaLexicon> =>
  Object.freeze({ language, patterns: Object.freeze(patterns) })

// Patterns are tested against `normalizeSpeechForLexicon` (no accents, lower case, single spaces).
export const CTA_LEXICONS: readonly Readonly<CtaLexicon>[] = Object.freeze([
  lexicon('pt', {
    'submit-lead': /\b(cadastre|cadastro|inscreva|inscricao|formulario|deixe seu contato|contato|lead)\b/,
    buy: /\b(compre|comprar|compra|checkout|garanta|adquira)\b/,
    'message-whatsapp': /\bwhatsapp\b/,
    book: /\b(agende|agendar|agenda|marque|marcar|horario|consulta|reuniao)\b/,
    download: /\b(baixe|baixar|download|material|guia|arquivo)\b/,
  }),
  lexicon('en', {
    'submit-lead': /\b(sign up|signup|subscribe|register|fill (in|out)|the form|leave your (contact|details)|get in touch)\b/,
    buy: /\b(buy|purchase|order|checkout|get yours|grab yours)\b/,
    'message-whatsapp': /\bwhatsapp\b/,
    book: /\b(book|schedule|reserve|appointment|make an appointment)\b/,
    download: /\b(download|get the (guide|file|material)|grab the (guide|file))\b/,
  }),
  lexicon('es', {
    'submit-lead': /\b(registrate|registrese|inscribete|suscribete|formulario|deja tu contacto|contacto)\b/,
    buy: /\b(compra|comprar|adquiere|checkout|consigue el tuyo)\b/,
    'message-whatsapp': /\bwhatsapp\b/,
    book: /\b(agenda|agendar|reserva|reservar|cita|reunion)\b/,
    download: /\b(descarga|descargar|download|guia|archivo|material)\b/,
  }),
])

export function primaryLanguageOf(tag: string): string {
  return tag.trim().split(/[-_]/)[0]!.toLowerCase()
}

/** The lexicon of a language, or `null` when the product has none (unknown language, or one that is not covered). */
export function ctaLexiconFor(language: string | null | undefined): Readonly<CtaLexicon> | null {
  if (typeof language !== 'string' || language.trim().length === 0) return null
  const primary = primaryLanguageOf(language)
  return CTA_LEXICONS.find((entry) => entry.language === primary) ?? null
}

export function normalizeSpeechForLexicon(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

export type SpokenCtaObservation =
  | Readonly<{ state: 'not-required' }>
  | Readonly<{ state: 'present'; basis: 'explicit-text' | 'lexicon'; language?: string }>
  | Readonly<{ state: 'absent'; basis: 'lexicon'; language: string }>
  | Readonly<{ state: 'not-evaluable'; reason: 'no-lexicon-for-language' | 'language-unknown' ; language?: string }>

/**
 * Whether the call to action of `action` is present in the speech, judged by the words of the language the speech is in. `continue-viewing`
 * asks for no call. An explicit text the requester gave counts as the call; with none, the lexicon of the language decides; without a lexicon
 * the answer is `not-evaluable`.
 */
export function observeSpokenCta(input: Readonly<{ action: Readonly<DesiredAction>; spokenText: string; language?: string | null }>): SpokenCtaObservation {
  if (input.action.kind === 'continue-viewing') return Object.freeze({ state: 'not-required' as const })
  if (input.action.visualCta?.trim() || input.action.verbalCta?.trim()) return Object.freeze({ state: 'present' as const, basis: 'explicit-text' as const })
  const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : undefined
  const found = ctaLexiconFor(language)
  if (found === null) {
    return Object.freeze({ state: 'not-evaluable' as const, reason: language === undefined ? 'language-unknown' as const : 'no-lexicon-for-language' as const, ...(language ? { language } : {}) })
  }
  const spoken = normalizeSpeechForLexicon(input.spokenText)
  return found.patterns[input.action.kind].test(spoken)
    ? Object.freeze({ state: 'present' as const, basis: 'lexicon' as const, language: found.language })
    : Object.freeze({ state: 'absent' as const, basis: 'lexicon' as const, language: found.language })
}
