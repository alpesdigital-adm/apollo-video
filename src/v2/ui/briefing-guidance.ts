/**
 * ADR-160 F7/F8. What the product may say about a briefing, and nothing more.
 *
 * The briefing is the request of the video (or of the batch): any non-empty text is valid, even one line. The product only points at
 * the TOPICS that make a briefing better. It offers no sentence to copy, no example, no placeholder and no recommendation of content:
 * an example would become a default, and "nothing is fixed, everything comes from the request of each video" is the rule.
 * Every topic is optional, and what the owner does not say the Apollo does not invent.
 */

export interface BriefingGuidanceTopic {
  readonly id: 'audience' | 'goal' | 'keep-or-remove' | 'language' | 'format' | 'pace'
  readonly label: string
  /** What the topic is about, as a noun phrase. Never a sentence to copy and never a value. */
  readonly about: string
}

export const BRIEFING_GUIDANCE_TITLE = 'O que ajuda num bom briefing'

export const BRIEFING_GUIDANCE_INTRO =
  'Escreva do seu jeito. Qualquer texto vale, até uma linha. Os tópicos abaixo são opcionais e só ajudam se fizerem sentido para este vídeo. O que você não disser, o Apollo não inventa.'

export const BRIEFING_GUIDANCE_TOPICS: readonly Readonly<BriefingGuidanceTopic>[] = Object.freeze([
  Object.freeze({ id: 'audience', label: 'Público', about: 'para quem o vídeo é' }),
  Object.freeze({ id: 'goal', label: 'Objetivo', about: 'o que o vídeo deve provocar em quem assiste' }),
  Object.freeze({ id: 'keep-or-remove', label: 'O que manter ou remover', about: 'falas, trechos ou elementos' }),
  Object.freeze({ id: 'language', label: 'Idioma', about: 'da fala e das legendas' }),
  Object.freeze({ id: 'format', label: 'Formato', about: 'onde o vídeo será publicado e a proporção da tela' }),
  Object.freeze({ id: 'pace', label: 'Ritmo', about: 'como o vídeo deve andar' }),
] as const)

/** The field label of the briefing: it names the field, it does not suggest what to write in it. */
export const BRIEFING_FIELD_LABEL = 'Briefing'

/** The error shown when the field is empty: the only constraint is that there is some text. */
export const BRIEFING_REQUIRED_MESSAGE = 'Escreva o briefing. Qualquer texto vale, até uma linha.'

export const BRIEFING_MAX_LENGTH = 10_000

/** The briefing the owner typed, ready to send: surrounding blanks removed, and `null` when there is nothing to send. */
export function normalizeBriefingInput(value: string): string | null {
  const text = value.trim()
  return text.length > 0 ? text : null
}
