/**
 * ADR-160. The words the owner reads on the Lotes screen for what the compatibility map and the recipe say: one catalog, in plain Portuguese, for every
 * code the Apollo records (reasons of a link, the roles of a script, the relation between two takes, the objective of a batch). The API keeps the codes;
 * no code reaches a person. An unknown code is shown as a neutral sentence, never as itself.
 *
 * `tests/v2/screen-language.test.mjs` reads the words of these screens and fails on a code or an English term.
 */
import { STRATEGIC_OBJECTIVES } from '../domain/strategic-objective.ts'

export const ROLE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  hook: 'Abertura', body: 'Corpo', proof: 'Prova', objection: 'Objeção', bridge: 'Ponte', offer: 'Oferta', cta: 'Chamada final', integrity: 'Integridade',
})

export const RELATION_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'hook-body': 'Abertura → corpo',
  'body-proof': 'Corpo → prova',
  'body-cta': 'Corpo → chamada final',
  'proof-cta': 'Prova → chamada final',
})

/** What each reason of a link means, in one short sentence. */
export const COMPATIBILITY_REASON_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  COMPATIBLE: 'Combinam',
  BORDERLINE_SOFT_SCORE: 'No limite: vale uma olhada sua',
  LOW_SOFT_SCORE: 'Combinam pouco',
  CONTEXT_NOT_EVALUABLE: 'Faltou contexto para conferir tudo',
  CONTEXT_REQUIRED_FOR_DECISION: 'O Apollo não decide esta ligação sozinho: falta contexto',
  OFFER_MISMATCH: 'As ofertas são diferentes',
  AUDIENCE_CONFLICT: 'Os públicos entram em conflito',
  PERSONA_MISMATCH: 'Quem fala não é a mesma pessoa',
  LOCALE_MISMATCH: 'Os idiomas são diferentes',
  CTA_ACTION_MISMATCH: 'A chamada final pede outra ação',
  CLAIM_CONTRADICTION: 'As afirmações se contradizem',
  REQUIRED_CONTINUITY_MISSING: 'Falta uma continuidade exigida',
})

export function reasonText(code: string): string {
  return COMPATIBILITY_REASON_TEXTS[code] ?? 'Motivo registrado pelo Apollo'
}

/** The name of an objective for a person: its label, "sem objetivo" when the batch has none, and a neutral phrase for an id the catalog does not hold. */
export function objectiveName(id: string | null | undefined): string {
  if (id === undefined || id === null || id === '') return 'sem objetivo'
  return STRATEGIC_OBJECTIVES.find((objective) => objective.id === id)?.label ?? 'objetivo registrado antes do catálogo'
}

export interface EdgeForHeadline {
  decision: 'accepted' | 'borderline' | 'blocked'
  softScore: number
  reasonCodes: readonly string[]
}

/**
 * The headline of a link. A link the Apollo could not decide for lack of context was judged by the length of the takes alone: its percentage says almost
 * nothing, so it is not shown as a result. The owner is told what was judged and asked to confirm.
 */
export function edgeHeadline(edge: Readonly<EdgeForHeadline>): { highlighted: boolean; text: string } {
  if (edge.reasonCodes.includes('CONTEXT_REQUIRED_FOR_DECISION')) {
    return { highlighted: false, text: 'Só a duração pôde ser avaliada — confirme' }
  }
  return { highlighted: true, text: `${Math.round(edge.softScore)}%` }
}

/** What a supposition sealed in a recipe says, for a person (the code and its English statement stay in the API). */
export function assumptionText(code: string): string {
  if (code.startsWith('OWNER_CONFIRMED_LINK_')) return 'Ligação confirmada por você'
  if (code === 'PROOF_OMITTED_BY_POLICY') return 'Sem prova, porque o objetivo permite'
  return 'Suposição registrada com a receita'
}

export const PROOF_REASON_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  PROOF_REQUIRED_BY_OBJECTIVE: 'o objetivo exige uma prova',
  PROOF_REQUIRED_BY_STRICTER_REQUEST: 'você pediu uma prova',
  PROOF_OPTIONAL_BY_OBJECTIVE: 'o objetivo permite ficar sem prova',
})

export function proofReasonText(code: string): string {
  return PROOF_REASON_TEXTS[code] ?? 'regra registrada pelo Apollo'
}
