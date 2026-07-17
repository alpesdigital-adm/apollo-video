import { assertDomain } from './errors.ts'

export interface ProductionBrief {
  schemaVersion: 1
  ownerInput?: { text: string; trust: 'owner-authorized' }
  ingestedContext?: { ref: string; trust: 'untrusted-media-derived' }
  summary: { text: string; supplied: boolean }
  assumptions: readonly string[]
  readyForExpensiveGeneration: false
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, ' ') }

export function createProductionBrief(input: { ownerText?: string; ingestedContextRef?: string }): Readonly<ProductionBrief> {
  const ownerText = normalize(input.ownerText ?? '')
  const ingestedContextRef = input.ingestedContextRef?.trim()
  assertDomain(ownerText.length <= 10_000, 'INVALID_ARGUMENT', 'Briefing must contain at most 10000 characters')
  assertDomain(!ingestedContextRef || /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(ingestedContextRef), 'INVALID_ARGUMENT', 'ingestedContextRef is invalid')
  const lower = ownerText.toLocaleLowerCase('pt-BR')
  const assumptions = ownerText ? [!/(públic|publico|audiência|audiencia|persona)/.test(lower) ? 'audience-not-specified' : '', !/(oferta|produto|serviço|servico|material)/.test(lower) ? 'offer-not-specified' : '', !/(tom|linguagem|estilo)/.test(lower) ? 'tone-not-specified' : ''].filter(Boolean) : ['briefing-absent', 'audience-not-specified', 'offer-not-specified', 'tone-not-specified']
  return Object.freeze({ schemaVersion: 1, ...(ownerText ? { ownerInput: Object.freeze({ text: ownerText, trust: 'owner-authorized' as const }) } : {}), ...(ingestedContextRef ? { ingestedContext: Object.freeze({ ref: ingestedContextRef, trust: 'untrusted-media-derived' as const }) } : {}), summary: Object.freeze({ text: ownerText ? ownerText.slice(0, 280) : 'Sem briefing livre; análise seguirá apenas objetivo, ação e mídia.', supplied: Boolean(ownerText) }), assumptions: Object.freeze(assumptions), readyForExpensiveGeneration: false })
}
