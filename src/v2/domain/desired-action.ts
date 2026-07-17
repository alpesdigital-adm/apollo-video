import { assertDomain } from './errors.ts'
import type { StrategicObjectiveId } from './strategic-objective.ts'

export type DesiredActionKind = 'continue-viewing' | 'submit-lead' | 'buy' | 'message-whatsapp' | 'book' | 'download'
export type DesiredActionDestinationType = 'url' | 'handle' | 'whatsapp' | 'calendar' | 'file'
export interface DesiredAction {
  schemaVersion: 1
  kind: DesiredActionKind
  destination?: { type: DesiredActionDestinationType; value: string }
  verbalCta?: string
  visualCta?: string
  disclosures: readonly string[]
}

const objectiveAction: Record<StrategicObjectiveId, DesiredActionKind> = {
  discovery: 'continue-viewing', awareness: 'continue-viewing', warming: 'continue-viewing',
  'lead-generation': 'submit-lead', sale: 'buy', whatsapp: 'message-whatsapp', booking: 'book', download: 'download',
}
const destinationType: Partial<Record<DesiredActionKind, DesiredActionDestinationType>> = {
  'submit-lead': 'url', buy: 'url', 'message-whatsapp': 'whatsapp', book: 'calendar', download: 'file',
}

export function createDesiredAction(input: { objective: StrategicObjectiveId; destination?: string; destinationType?: DesiredActionDestinationType; verbalCta?: string; visualCta?: string; disclosures?: readonly string[] }): Readonly<DesiredAction> {
  const kind = objectiveAction[input.objective]
  const value = input.destination?.trim()
  const requiredType = destinationType[kind]
  assertDomain(!requiredType || Boolean(value), 'INVALID_ARGUMENT', `Objective ${input.objective} requires an explicit destination`)
  if (value) {
    assertDomain(value.length <= 2048 && !/[\r\n]/.test(value), 'INVALID_ARGUMENT', 'destination is invalid')
    if ((input.destinationType ?? requiredType) === 'url') assertDomain(/^https:\/\//i.test(value), 'INVALID_ARGUMENT', 'URL destination must use HTTPS')
  }
  const verbalCta = input.verbalCta?.trim()
  const visualCta = input.visualCta?.trim()
  for (const [field, text] of Object.entries({ verbalCta, visualCta })) assertDomain(!text || text.length <= 160, 'INVALID_ARGUMENT', `${field} is too long`)
  return Object.freeze({ schemaVersion: 1, kind, ...(value ? { destination: Object.freeze({ type: input.destinationType ?? requiredType ?? 'url', value }) } : {}), ...(verbalCta ? { verbalCta } : {}), ...(visualCta ? { visualCta } : {}), disclosures: Object.freeze([...(input.disclosures ?? [])].map((item) => item.trim()).filter(Boolean)) })
}

export function desiredActionConsumers(action: DesiredAction) {
  const canonical = Object.freeze({ kind: action.kind, destination: action.destination, verbalCta: action.verbalCta, visualCta: action.visualCta, disclosures: action.disclosures })
  return Object.freeze({ storyPlan: canonical, subtitle: canonical, overlay: canonical, critic: canonical })
}

export function validateDesiredActionAlignment(input: { objective: StrategicObjectiveId; action: DesiredAction; spokenCta?: string }) {
  const expected = objectiveAction[input.objective]
  const issues: string[] = []
  if (input.action.kind !== expected) issues.push('objective-action-mismatch')
  const spoken = input.spokenCta?.toLocaleLowerCase('pt-BR') ?? ''
  if (spoken && input.action.kind === 'message-whatsapp' && !spoken.includes('whatsapp')) issues.push('spoken-cta-mismatch')
  if (spoken && input.action.kind === 'download' && !/(baix|material|guia|arquivo)/.test(spoken)) issues.push('spoken-cta-mismatch')
  if (destinationType[input.action.kind] && !input.action.destination) issues.push('destination-missing')
  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze([...new Set(issues)]) })
}
