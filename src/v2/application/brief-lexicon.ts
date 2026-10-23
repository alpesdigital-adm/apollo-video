import type { CompiledBriefField } from './compile-brief.ts'

/**
 * The labeled-field path of a briefing ("Audience: ...", "Tone: ..."), by language (ADR-160: nothing is fixed to one language).
 *
 * A label is recognised in the language of the briefing WHEN THERE IS A LEXICON FOR IT; a briefing in a language without one has no labeled
 * fields to read here, and only the interpreter (an LLM, see `interpret-brief.ts`) reads it. A lexicon is a closed, reviewed word list: it
 * decides nothing about the video, it only names which compiled field a label opens. Adding a language is adding an entry; nothing else moves.
 */
export interface BriefLexicon {
  /** Labels (lowercase, as written, accents included) -> the compiled field they open. */
  labels: Readonly<Record<string, CompiledBriefField>>
  /** An outcome claim that needs external evidence ("guaranteed", "no risk"). */
  unsupportedClaim: RegExp
  /** An attempt to make the compiler ignore its safety policy. */
  overridesSafetyPolicy: RegExp
}

export const BRIEF_LEXICONS: Readonly<Record<string, Readonly<BriefLexicon>>> = Object.freeze({
  pt: Object.freeze({
    labels: Object.freeze({
      público: 'audience', publico: 'audience', audiência: 'audience', audiencia: 'audience', persona: 'audience',
      oferta: 'offer', produto: 'offer', serviço: 'offer', servico: 'offer',
      restrição: 'constraints', restricao: 'constraints', restrições: 'constraints', restricoes: 'constraints',
      'deve usar': 'mustUse', incluir: 'mustUse', obrigatório: 'mustUse', obrigatorio: 'mustUse',
      evitar: 'avoid', 'não usar': 'avoid', 'nao usar': 'avoid', proibido: 'avoid',
      tom: 'tone', estilo: 'tone', linguagem: 'tone',
      sucesso: 'successCriteria', meta: 'successCriteria', critério: 'successCriteria', criterio: 'successCriteria',
    } as const),
    unsupportedClaim: /\b(garantid[oa]s?|resultado garantido|sem risco)\b/iu,
    overridesSafetyPolicy: /(ignore|ignorem|desconsidere).{0,30}(segurança|guardrail|política|politica)/iu,
  }),
  en: Object.freeze({
    labels: Object.freeze({
      audience: 'audience', 'target audience': 'audience', persona: 'audience',
      offer: 'offer', product: 'offer', service: 'offer',
      constraint: 'constraints', constraints: 'constraints', restrictions: 'constraints',
      'must use': 'mustUse', include: 'mustUse', required: 'mustUse',
      avoid: 'avoid', 'do not use': 'avoid', "don't use": 'avoid', forbidden: 'avoid',
      tone: 'tone', style: 'tone', voice: 'tone',
      success: 'successCriteria', goal: 'successCriteria', criterion: 'successCriteria', criteria: 'successCriteria',
    } as const),
    unsupportedClaim: /\b(guaranteed|risk[- ]free|no risk)\b/iu,
    overridesSafetyPolicy: /(ignore|disregard|override).{0,30}(safety|guardrail|policy)/iu,
  }),
  es: Object.freeze({
    labels: Object.freeze({
      público: 'audience', publico: 'audience', audiencia: 'audience', persona: 'audience',
      oferta: 'offer', producto: 'offer', servicio: 'offer',
      restricción: 'constraints', restriccion: 'constraints', restricciones: 'constraints',
      'debe usar': 'mustUse', incluir: 'mustUse', obligatorio: 'mustUse',
      evitar: 'avoid', 'no usar': 'avoid', prohibido: 'avoid',
      tono: 'tone', estilo: 'tone', lenguaje: 'tone',
      éxito: 'successCriteria', exito: 'successCriteria', meta: 'successCriteria', criterio: 'successCriteria',
    } as const),
    unsupportedClaim: /\b(garantizad[oa]s?|resultado garantizado|sin riesgo)\b/iu,
    overridesSafetyPolicy: /(ignora|ignore|desconsidera).{0,30}(seguridad|guardrail|política|politica)/iu,
  }),
})

export const BRIEF_LEXICON_LANGUAGES: readonly string[] = Object.freeze(Object.keys(BRIEF_LEXICONS))

/** Every label of every lexicon, longest first (so "target audience" wins over "audience"). A label shared by two languages must open the same field. */
export function briefLabelIndex(): Readonly<Record<string, CompiledBriefField>> {
  const index: Record<string, CompiledBriefField> = {}
  for (const [language, lexicon] of Object.entries(BRIEF_LEXICONS)) {
    for (const [label, field] of Object.entries(lexicon.labels)) {
      if (index[label] !== undefined && index[label] !== field) {
        throw new Error(`Brief lexicon ${language} opens "${label}" as ${field}, another language opens it as ${index[label]}`)
      }
      index[label] = field
    }
  }
  return Object.freeze(index)
}

export function briefMentionsUnsupportedClaim(text: string): boolean {
  return Object.values(BRIEF_LEXICONS).some((lexicon) => lexicon.unsupportedClaim.test(text))
}

export function briefOverridesSafetyPolicy(text: string): boolean {
  return Object.values(BRIEF_LEXICONS).some((lexicon) => lexicon.overridesSafetyPolicy.test(text))
}
