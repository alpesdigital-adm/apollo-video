import { assertDomain, DomainError } from './errors.ts'
import {
  resolveStrategicObjective,
  type StrategicObjectiveId,
} from './strategic-objective.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'

export const DESIRED_ACTION_DESTINATION_TYPES = Object.freeze([
  'url', 'handle', 'whatsapp', 'calendar', 'file',
] as const)

export type DesiredActionKind =
  | 'continue-viewing'
  | 'submit-lead'
  | 'buy'
  | 'message-whatsapp'
  | 'book'
  | 'download'
export type DesiredActionDestinationType =
  (typeof DESIRED_ACTION_DESTINATION_TYPES)[number]

export interface DesiredActionDestination {
  type: DesiredActionDestinationType
  value: string
}

export interface DesiredActionInput {
  destination?: Readonly<DesiredActionDestination>
  verbalCta?: string
  visualCta?: string
  disclosures?: readonly string[]
}

export interface DesiredAction {
  schemaVersion: 1
  kind: DesiredActionKind
  destination?: Readonly<DesiredActionDestination>
  verbalCta?: string
  visualCta?: string
  disclosures: readonly string[]
}

export interface DesiredActionReference {
  schemaVersion: 'desired-action-ref/v1'
  id: string
  actionHash: string
  action: Readonly<DesiredAction>
}

export function createDesiredActionReference(
  action: Readonly<DesiredAction>,
): Readonly<DesiredActionReference> {
  const actionHash = calculateCanonicalHash(action)
  return Object.freeze({
    schemaVersion: 'desired-action-ref/v1',
    id: `desired-action-${actionHash.slice(0, 24)}`,
    actionHash,
    action,
  })
}

export function parseDesiredActionInput(value: unknown): Readonly<DesiredActionInput> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    'desiredAction must be an object',
  )
  const action = value as Record<string, unknown>
  assertDomain(
    Object.keys(action).every((key) => [
      'destination', 'verbalCta', 'visualCta', 'disclosures',
    ].includes(key)),
    'INVALID_ARGUMENT',
    'desiredAction contains unsupported fields',
  )
  for (const field of ['verbalCta', 'visualCta'] as const) {
    assertDomain(
      action[field] === undefined || typeof action[field] === 'string',
      'INVALID_ARGUMENT',
      `desiredAction.${field} must be a string`,
    )
  }
  assertDomain(
    action.disclosures === undefined || (
      Array.isArray(action.disclosures) &&
      action.disclosures.every((item) => typeof item === 'string')
    ),
    'INVALID_ARGUMENT',
    'desiredAction.disclosures must be an array of strings',
  )
  let destination: DesiredActionDestination | undefined
  if (action.destination !== undefined) {
    assertDomain(
      typeof action.destination === 'object' && action.destination !== null &&
        !Array.isArray(action.destination),
      'INVALID_ARGUMENT',
      'desiredAction.destination must be an object',
    )
    const candidate = action.destination as Record<string, unknown>
    assertDomain(
      Object.keys(candidate).every((key) => ['type', 'value'].includes(key)) &&
        typeof candidate.type === 'string' &&
        DESIRED_ACTION_DESTINATION_TYPES.includes(
          candidate.type as DesiredActionDestinationType,
        ) &&
        typeof candidate.value === 'string',
      'INVALID_ARGUMENT',
      'desiredAction.destination is invalid',
    )
    destination = {
      type: candidate.type as DesiredActionDestinationType,
      value: candidate.value as string,
    }
  }
  return Object.freeze({
    ...(destination ? { destination: Object.freeze(destination) } : {}),
    ...(typeof action.verbalCta === 'string' ? { verbalCta: action.verbalCta } : {}),
    ...(typeof action.visualCta === 'string' ? { visualCta: action.visualCta } : {}),
    ...(Array.isArray(action.disclosures)
      ? { disclosures: Object.freeze([...(action.disclosures as string[])]) }
      : {}),
  })
}

export type DesiredActionAlignmentIssue =
  | 'objective-action-mismatch'
  | 'spoken-cta-mismatch'
  | 'destination-missing'
  | 'destination-mismatch'

const objectiveAction: Readonly<Record<StrategicObjectiveId, DesiredActionKind>> = Object.freeze({
  discovery: 'continue-viewing',
  awareness: 'continue-viewing',
  warming: 'continue-viewing',
  'lead-generation': 'submit-lead',
  sale: 'buy',
  whatsapp: 'message-whatsapp',
  booking: 'book',
  download: 'download',
})

const requiredDestinationType: Readonly<Partial<Record<DesiredActionKind, DesiredActionDestinationType>>> = Object.freeze({
  'submit-lead': 'url',
  buy: 'url',
  'message-whatsapp': 'whatsapp',
  book: 'calendar',
  download: 'file',
})

const spokenCtaPattern: Readonly<Record<Exclude<DesiredActionKind, 'continue-viewing'>, RegExp>> = Object.freeze({
  'submit-lead': /\b(cadastre|cadastro|inscreva|inscricao|formulario|contato|lead)\b/,
  buy: /\b(compre|comprar|compra|checkout|garanta|adquira)\b/,
  'message-whatsapp': /\bwhatsapp\b/,
  book: /\b(agende|agendar|agenda|horario|consulta|reuniao)\b/,
  download: /\b(baixe|baixar|download|material|guia|arquivo)\b/,
})

function normalizedSpeech(value: string): string {
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizedText(value: string | undefined, field: string): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  assertDomain(
    normalized.length <= 160 && !/[\u0000-\u001f\u007f]/.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function normalizeDestination(
  input: Readonly<DesiredActionDestination>,
): Readonly<DesiredActionDestination> {
  assertDomain(
    DESIRED_ACTION_DESTINATION_TYPES.includes(input.type) &&
      typeof input.value === 'string',
    'INVALID_ARGUMENT',
    'Desired action destination is invalid',
  )
  const value = input.value.trim()
  assertDomain(
    value.length >= 1 && value.length <= 2_048 &&
      !/[\r\n\u0000]/.test(value),
    'INVALID_ARGUMENT',
    'Desired action destination is invalid',
  )
  if (input.type === 'handle') {
    assertDomain(
      /^@?[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(value),
      'INVALID_ARGUMENT',
      'Handle destination is invalid',
    )
  } else if (input.type === 'whatsapp' && !/^https:\/\//i.test(value)) {
    assertDomain(
      /^\+[1-9][0-9]{7,14}$/.test(value),
      'INVALID_ARGUMENT',
      'WhatsApp destination must be E.164 or an approved HTTPS URL',
    )
  } else {
    let url: URL | undefined
    try {
      url = new URL(value)
    } catch {}
    assertDomain(
      url?.protocol === 'https:' && !url.username && !url.password,
      'INVALID_ARGUMENT',
      'URL destination must use HTTPS without embedded credentials',
    )
    if (input.type === 'whatsapp') {
      assertDomain(
        ['wa.me', 'api.whatsapp.com'].includes(url.hostname.toLowerCase()),
        'INVALID_ARGUMENT',
        'WhatsApp URL destination must use an approved host',
      )
    }
  }
  return Object.freeze({ type: input.type, value })
}

function normalizeDisclosures(input: readonly string[] | undefined): readonly string[] {
  assertDomain(
    input === undefined || (Array.isArray(input) && input.length <= 12),
    'INVALID_ARGUMENT',
    'Desired action disclosures are invalid',
  )
  const disclosures = (input ?? []).map((item) => {
    assertDomain(typeof item === 'string', 'INVALID_ARGUMENT', 'Desired action disclosure is invalid')
    const normalized = item.trim()
    assertDomain(
      normalized.length >= 1 && normalized.length <= 300 &&
        !/[\u0000-\u001f\u007f]/.test(normalized),
      'INVALID_ARGUMENT',
      'Desired action disclosure is invalid',
    )
    return normalized
  })
  assertDomain(
    new Set(disclosures).size === disclosures.length &&
      disclosures.join('').length <= 2_000,
    'INVALID_ARGUMENT',
    'Desired action disclosures must be unique and bounded',
  )
  return Object.freeze(disclosures)
}

export function createDesiredAction(input: {
  objective: StrategicObjectiveId
  desiredAction?: Readonly<DesiredActionInput>
}): Readonly<DesiredAction> {
  const objective = resolveStrategicObjective(input.objective)
  const kind = objectiveAction[objective.id]
  const destination = input.desiredAction?.destination
    ? normalizeDestination(input.desiredAction.destination)
    : undefined
  const requiredType = requiredDestinationType[kind]
  assertDomain(
    !requiredType || Boolean(destination),
    'INVALID_ARGUMENT',
    `Objective ${objective.id} requires an explicit destination`,
  )
  assertDomain(
    !requiredType || destination?.type === requiredType,
    'INVALID_ARGUMENT',
    `Objective ${objective.id} requires destination type ${requiredType}`,
  )
  assertDomain(
    kind !== 'continue-viewing' || destination === undefined ||
      ['url', 'handle'].includes(destination.type),
    'INVALID_ARGUMENT',
    'Awareness destinations must be an HTTPS URL or handle',
  )
  const verbalCta = normalizedText(input.desiredAction?.verbalCta, 'verbalCta')
  const visualCta = normalizedText(input.desiredAction?.visualCta, 'visualCta')
  return Object.freeze({
    schemaVersion: 1,
    kind,
    ...(destination ? { destination } : {}),
    ...(verbalCta ? { verbalCta } : {}),
    ...(visualCta ? { visualCta } : {}),
    disclosures: normalizeDisclosures(input.desiredAction?.disclosures),
  })
}

export function parseDesiredAction(
  value: unknown,
  objective: StrategicObjectiveId,
): Readonly<DesiredAction> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'PERSISTENCE_CONFLICT',
    'Stored desired action is invalid',
  )
  const record = value as Record<string, unknown>
  assertDomain(
    Object.keys(record).every((key) => [
      'schemaVersion', 'kind', 'destination', 'verbalCta', 'visualCta', 'disclosures',
    ].includes(key)) &&
      record.schemaVersion === 1 &&
      typeof record.kind === 'string' &&
      (record.destination === undefined || (
        typeof record.destination === 'object' && record.destination !== null &&
        !Array.isArray(record.destination)
      )) &&
      (record.verbalCta === undefined || typeof record.verbalCta === 'string') &&
      (record.visualCta === undefined || typeof record.visualCta === 'string') &&
      Array.isArray(record.disclosures),
    'PERSISTENCE_CONFLICT',
    'Stored desired action is invalid',
  )
  const destination = record.destination as Record<string, unknown> | undefined
  let action: Readonly<DesiredAction>
  try {
    action = createDesiredAction({
      objective,
      desiredAction: {
        ...(destination
          ? { destination: {
              type: destination.type as DesiredActionDestinationType,
              value: destination.value as string,
            } }
          : {}),
        ...(typeof record.verbalCta === 'string' ? { verbalCta: record.verbalCta } : {}),
        ...(typeof record.visualCta === 'string' ? { visualCta: record.visualCta } : {}),
        disclosures: record.disclosures as string[],
      },
    })
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored desired action is invalid')
    }
    throw error
  }
  assertDomain(
    action.kind === record.kind,
    'PERSISTENCE_CONFLICT',
    'Stored desired action does not match its objective',
  )
  return action
}

export function validateDesiredActionAlignment(input: {
  objective: StrategicObjectiveId
  action: DesiredAction
  spokenCta?: string
}): Readonly<{
  valid: boolean
  issues: readonly DesiredActionAlignmentIssue[]
}> {
  const expectedKind = objectiveAction[resolveStrategicObjective(input.objective).id]
  const issues: DesiredActionAlignmentIssue[] = []
  if (input.action.kind !== expectedKind) issues.push('objective-action-mismatch')
  const expectedDestination = requiredDestinationType[input.action.kind]
  if (expectedDestination && !input.action.destination) {
    issues.push('destination-missing')
  } else if (expectedDestination && input.action.destination?.type !== expectedDestination) {
    issues.push('destination-mismatch')
  }
  const spoken = normalizedSpeech(input.spokenCta ?? '')
  if (spoken && input.action.kind !== 'continue-viewing') {
    const configuredVerbal = normalizedSpeech(input.action.verbalCta ?? '')
    if (
      !spokenCtaPattern[input.action.kind].test(spoken) ||
      (configuredVerbal && !spoken.includes(configuredVerbal))
    ) issues.push('spoken-cta-mismatch')
  }
  const uniqueIssues = Object.freeze([...new Set(issues)])
  return Object.freeze({ valid: uniqueIssues.length === 0, issues: uniqueIssues })
}
