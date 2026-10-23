/**
 * The languages a screen offers to choose from. A list of choices is not a default: no screen pre-selects one, and "Não informar" is always the
 * first option (the Apollo then detects the language from the speech, or leaves the check that needs it unevaluated).
 */
export const LOCALE_OPTIONS: readonly Readonly<{ value: string; label: string }>[] = Object.freeze([
  Object.freeze({ value: 'pt-BR', label: 'Português (Brasil)' }),
  Object.freeze({ value: 'en-US', label: 'English (US)' }),
  Object.freeze({ value: 'es-ES', label: 'Español' }),
])

export const LOCALE_NOT_INFORMED_LABEL = 'Não informar'
