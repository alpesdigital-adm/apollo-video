import { randomUUID } from 'node:crypto'

import { DomainError, assertDomain } from './errors.ts'

export type PublicEventResourceType =
  | 'project'
  | 'project-version'
  | 'operation'
  | 'annotation'
  | 'quality-report'
  | 'approval'
  | 'media-artifact'
  | 'workspace'
  | 'api-client'

export interface PublicEventDescriptor {
  type: string
  version: '1.0.0'
  resourceType: PublicEventResourceType
  description: string
}

export type PublicEventJson =
  | null
  | boolean
  | number
  | string
  | readonly PublicEventJson[]
  | { readonly [key: string]: PublicEventJson }

export interface PublicEventActor {
  clientId?: string
  userId?: string
}

export interface PublicEvent {
  id: string
  type: string
  version: '1.0.0'
  workspaceId: string
  occurredAt: string
  sequence?: number
  actor?: Readonly<PublicEventActor>
  resource: Readonly<{
    type: PublicEventResourceType
    id: string
  }>
  data: Readonly<Record<string, PublicEventJson>>
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DATA_BYTES = 65_536
const MAX_JSON_DEPTH = 8
const MAX_COLLECTION_ITEMS = 1_024

function defineEventCatalog(
  descriptors: readonly PublicEventDescriptor[],
): readonly Readonly<PublicEventDescriptor>[] {
  const identities = new Set<string>()
  const types = new Set<string>()
  return Object.freeze(descriptors.map((descriptor) => {
    const identity = `${descriptor.type}@${descriptor.version}`
    assertDomain(
      /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(descriptor.type) &&
        descriptor.description.trim().length > 0 &&
        !identities.has(identity) &&
        !types.has(descriptor.type),
      'INVALID_PUBLIC_EVENT',
      'Public event catalog entries must be unique and well formed',
      { identity },
    )
    identities.add(identity)
    types.add(descriptor.type)
    return Object.freeze({ ...descriptor })
  }))
}

export const PUBLIC_EVENT_CATALOG = defineEventCatalog([
  { type: 'project.created', version: '1.0.0', resourceType: 'project', description: 'A project was created.' },
  { type: 'project.version.created', version: '1.0.0', resourceType: 'project-version', description: 'An immutable project version was created.' },
  { type: 'project.status.changed', version: '1.0.0', resourceType: 'project', description: 'A project status changed.' },
  { type: 'operation.status.changed', version: '1.0.0', resourceType: 'operation', description: 'A public operation changed status.' },
  { type: 'operation.succeeded', version: '1.0.0', resourceType: 'operation', description: 'A public operation completed successfully.' },
  { type: 'operation.failed', version: '1.0.0', resourceType: 'operation', description: 'A public operation reached a failed terminal state.' },
  { type: 'annotation.created', version: '1.0.0', resourceType: 'annotation', description: 'A review annotation was created.' },
  { type: 'annotation.resolved', version: '1.0.0', resourceType: 'annotation', description: 'A review annotation was resolved.' },
  { type: 'quality.report.created', version: '1.0.0', resourceType: 'quality-report', description: 'A quality report was created.' },
  { type: 'approval.changed', version: '1.0.0', resourceType: 'approval', description: 'An approval decision changed.' },
  { type: 'artifact.ready', version: '1.0.0', resourceType: 'media-artifact', description: 'A media artifact became available.' },
  { type: 'artifact.rejected', version: '1.0.0', resourceType: 'media-artifact', description: 'A media artifact was rejected.' },
  { type: 'budget.threshold.reached', version: '1.0.0', resourceType: 'workspace', description: 'A workspace budget threshold was reached.' },
  { type: 'client.suspended', version: '1.0.0', resourceType: 'api-client', description: 'An API client was suspended.' },
] as const)

function invalidEvent(message: string, details: Record<string, unknown> = {}): never {
  throw new DomainError('INVALID_PUBLIC_EVENT', message, details)
}

function normalizeJson(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): PublicEventJson {
  if (depth > MAX_JSON_DEPTH) invalidEvent('Public event data exceeds maximum depth')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidEvent('Public event data numbers must be finite')
    return value
  }
  if (typeof value !== 'object') invalidEvent('Public event data must be JSON-compatible')
  if (ancestors.has(value)) invalidEvent('Public event data cannot contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_ITEMS) invalidEvent('Public event data array is too large')
      return Object.freeze(value.map((item) => normalizeJson(item, depth + 1, ancestors)))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      invalidEvent('Public event data objects must be plain records')
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > MAX_COLLECTION_ITEMS) invalidEvent('Public event data object is too large')
    const normalized: Record<string, PublicEventJson> = {}
    for (const [key, item] of entries) {
      if (key.length < 1 || key.length > 128 || FORBIDDEN_KEYS.has(key)) {
        invalidEvent('Public event data contains an invalid key', { key })
      }
      normalized[key] = normalizeJson(item, depth + 1, ancestors)
    }
    return Object.freeze(normalized)
  } finally {
    ancestors.delete(value)
  }
}

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    ID_PATTERN.test(normalized),
    'INVALID_PUBLIC_EVENT',
    `${field} must contain 3 to 128 safe characters`,
  )
  return normalized
}

export function createPublicEventId(
  uuid: () => string = randomUUID,
): string {
  const id = uuid().toLowerCase()
  assertDomain(
    UUID_V4_PATTERN.test(id),
    'INVALID_PUBLIC_EVENT',
    'Public event id must be a UUID v4',
  )
  return id
}

export function createPublicEvent(input: {
  id: string
  type: string
  version: string
  workspaceId: string
  occurredAt: string
  sequence?: number
  actor?: PublicEventActor
  resource: { type: string; id: string }
  data: Record<string, unknown>
}): Readonly<PublicEvent> {
  const id = input.id.trim().toLowerCase()
  assertDomain(UUID_V4_PATTERN.test(id), 'INVALID_PUBLIC_EVENT', 'Public event id must be a UUID v4')
  const descriptor = PUBLIC_EVENT_CATALOG.find(
    (candidate) => candidate.type === input.type && candidate.version === input.version,
  )
  assertDomain(
    descriptor,
    'INVALID_PUBLIC_EVENT',
    'Public event type and version are not supported',
    { type: input.type, version: input.version },
  )
  const occurredAtDate = new Date(input.occurredAt)
  assertDomain(
    !Number.isNaN(occurredAtDate.getTime()) && occurredAtDate.toISOString() === input.occurredAt,
    'INVALID_PUBLIC_EVENT',
    'Public event occurredAt must be canonical UTC',
  )
  assertDomain(
    input.sequence === undefined ||
      (Number.isSafeInteger(input.sequence) && input.sequence >= 1),
    'INVALID_PUBLIC_EVENT',
    'Public event sequence must be a positive safe integer',
  )
  assertDomain(
    input.resource.type === descriptor.resourceType,
    'INVALID_PUBLIC_EVENT',
    'Public event resource type does not match the catalog',
  )

  let actor: Readonly<PublicEventActor> | undefined
  if (input.actor) {
    const keys = Object.keys(input.actor)
    assertDomain(
      keys.length >= 1 &&
        keys.every((key) => key === 'clientId' || key === 'userId') &&
        Boolean(input.actor.clientId || input.actor.userId),
      'INVALID_PUBLIC_EVENT',
      'Public event actor must identify a client or user',
    )
    actor = Object.freeze({
      ...(input.actor.clientId
        ? { clientId: validateId(input.actor.clientId, 'actor.clientId') }
        : {}),
      ...(input.actor.userId
        ? { userId: validateId(input.actor.userId, 'actor.userId') }
        : {}),
    })
  }

  const data = normalizeJson(input.data, 0, new WeakSet())
  assertDomain(
    !Array.isArray(data) && data !== null && typeof data === 'object',
    'INVALID_PUBLIC_EVENT',
    'Public event data must be an object',
  )
  assertDomain(
    Buffer.byteLength(JSON.stringify(data), 'utf8') <= MAX_DATA_BYTES,
    'INVALID_PUBLIC_EVENT',
    'Public event data exceeds 64 KiB',
  )

  return Object.freeze({
    id,
    type: descriptor.type,
    version: descriptor.version,
    workspaceId: validateId(input.workspaceId, 'workspaceId'),
    occurredAt: input.occurredAt,
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    ...(actor ? { actor } : {}),
    resource: Object.freeze({
      type: descriptor.resourceType,
      id: validateId(input.resource.id, 'resource.id'),
    }),
    data: data as Readonly<Record<string, PublicEventJson>>,
  })
}

export function assertUniquePublicEventIds(events: readonly PublicEvent[]): void {
  const ids = new Set<string>()
  for (const event of events) {
    assertDomain(
      !ids.has(event.id),
      'INVALID_PUBLIC_EVENT',
      'Public event ids must be unique',
      { eventId: event.id },
    )
    ids.add(event.id)
  }
}
