import { assertDomain, DomainError } from './errors.ts'

export const PRODUCTION_BRIEF_ASSUMPTIONS = Object.freeze([
  'briefing-absent',
  'audience-not-specified',
  'offer-not-specified',
  'tone-not-specified',
] as const)

export type ProductionBriefAssumption =
  (typeof PRODUCTION_BRIEF_ASSUMPTIONS)[number]

export interface ProductionBrief {
  schemaVersion: 1
  ownerInput?: { text: string; trust: 'owner-authorized' }
  ingestedContext?: { ref: string; trust: 'untrusted-media-derived' }
  summary: {
    text: string
    supplied: boolean
    coverage: Readonly<{ audience: boolean; offer: boolean; tone: boolean }>
  }
  assumptions: readonly ProductionBriefAssumption[]
  readyForExpensiveGeneration: false
}

function normalize(value: string): string {
  return value.trim()
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[^\S\r\n]+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

function searchable(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function canonicalBriefValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalBriefValue(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalBriefValue(record[key])}`).join(',')}}`
}

export function createProductionBrief(input: {
  ownerText?: string
  ingestedContextRef?: string
}): Readonly<ProductionBrief> {
  const ownerText = normalize(input.ownerText ?? '')
  const ingestedContextRef = input.ingestedContextRef?.trim()
  assertDomain(ownerText.length <= 10_000, 'INVALID_ARGUMENT', 'Briefing must contain at most 10000 characters')
  assertDomain(!ingestedContextRef || /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(ingestedContextRef), 'INVALID_ARGUMENT', 'ingestedContextRef is invalid')
  const normalized = searchable(ownerText)
  const coverage = Object.freeze({
    audience: /\b(publico|audiencia|persona)\b/.test(normalized),
    offer: /\b(oferta|produto|servico|material)\b/.test(normalized),
    tone: /\b(tom|linguagem|estilo)\b/.test(normalized),
  })
  const assumptions: ProductionBriefAssumption[] = [
    ...(!ownerText ? ['briefing-absent' as const] : []),
    ...(!coverage.audience ? ['audience-not-specified' as const] : []),
    ...(!coverage.offer ? ['offer-not-specified' as const] : []),
    ...(!coverage.tone ? ['tone-not-specified' as const] : []),
  ]
  return Object.freeze({
    schemaVersion: 1,
    ...(ownerText
      ? { ownerInput: Object.freeze({ text: ownerText, trust: 'owner-authorized' as const }) }
      : {}),
    ...(ingestedContextRef
      ? { ingestedContext: Object.freeze({ ref: ingestedContextRef, trust: 'untrusted-media-derived' as const }) }
      : {}),
    summary: Object.freeze({
      text: ownerText
        ? ownerText.slice(0, 280)
        : 'Sem briefing livre; análise seguirá apenas objetivo, ação e mídia.',
      supplied: Boolean(ownerText),
      coverage,
    }),
    assumptions: Object.freeze(assumptions),
    readyForExpensiveGeneration: false,
  })
}

export function parseProductionBrief(value: unknown): Readonly<ProductionBrief> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'PERSISTENCE_CONFLICT',
    'Stored production brief is invalid',
  )
  const record = value as Record<string, unknown>
  const ownerInput = record.ownerInput as Record<string, unknown> | undefined
  const ingestedContext = record.ingestedContext as Record<string, unknown> | undefined
  const summary = record.summary as Record<string, unknown> | undefined
  const coverage = summary?.coverage as Record<string, unknown> | undefined
  assertDomain(
    Object.keys(record).every((key) => [
      'schemaVersion', 'ownerInput', 'ingestedContext', 'summary',
      'assumptions', 'readyForExpensiveGeneration',
    ].includes(key)) &&
      record.schemaVersion === 1 &&
      (ownerInput === undefined || (
        typeof ownerInput === 'object' && ownerInput !== null &&
        Object.keys(ownerInput).length === 2 &&
        typeof ownerInput.text === 'string' && ownerInput.trust === 'owner-authorized'
      )) &&
      (ingestedContext === undefined || (
        typeof ingestedContext === 'object' && ingestedContext !== null &&
        Object.keys(ingestedContext).length === 2 &&
        typeof ingestedContext.ref === 'string' &&
        ingestedContext.trust === 'untrusted-media-derived'
      )) &&
      typeof summary === 'object' && summary !== null &&
      Object.keys(summary).length === 3 &&
      typeof summary.text === 'string' && typeof summary.supplied === 'boolean' &&
      typeof coverage === 'object' && coverage !== null &&
      Object.keys(coverage).length === 3 &&
      ['audience', 'offer', 'tone'].every((field) => typeof coverage[field] === 'boolean') &&
      Array.isArray(record.assumptions) &&
      record.assumptions.every((item) =>
        typeof item === 'string' &&
        PRODUCTION_BRIEF_ASSUMPTIONS.includes(item as ProductionBriefAssumption)) &&
      record.readyForExpensiveGeneration === false,
    'PERSISTENCE_CONFLICT',
    'Stored production brief is invalid',
  )
  let parsed: Readonly<ProductionBrief>
  try {
    parsed = createProductionBrief({
      ...(ownerInput ? { ownerText: ownerInput.text as string } : {}),
      ...(ingestedContext ? { ingestedContextRef: ingestedContext.ref as string } : {}),
    })
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored production brief is invalid')
    }
    throw error
  }
  assertDomain(
    canonicalBriefValue(parsed) === canonicalBriefValue(record),
    'PERSISTENCE_CONFLICT',
    'Stored production brief is not canonical',
  )
  return parsed
}
