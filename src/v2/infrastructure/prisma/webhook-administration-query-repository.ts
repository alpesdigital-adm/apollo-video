import type {
  PrismaClient,
  V2WebhookEndpoint,
  V2WebhookSubscription,
} from '@prisma/client'

import type {
  WebhookAdministrationQueryRepository,
  WebhookSigningSecretMetadata,
} from '../../application/ports/webhook-administration-query-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createWebhookEndpoint,
  createWebhookSubscription,
  type WebhookEndpoint,
  type WebhookSubscription,
} from '../../domain/webhook.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function endpoint(row: V2WebhookEndpoint): Readonly<WebhookEndpoint> {
  return createWebhookEndpoint({
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    status: row.status as WebhookEndpoint['status'],
    createdByClientId: row.createdByClientId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
    ...(row.suspendedAt ? { suspendedAt: row.suspendedAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  })
}

function parseStringArray(value: string | null, required: boolean): readonly string[] | undefined {
  if (value === null) {
    if (required) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook filter is invalid')
    return undefined
  }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('invalid')
    }
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook filter is invalid')
  }
}

function subscription(row: V2WebhookSubscription): Readonly<WebhookSubscription> {
  const eventTypes = parseStringArray(row.filterEventTypesJson, true)!
  const resourceIds = parseStringArray(row.filterResourceIdsJson, false)
  try {
    return createWebhookSubscription({
      id: row.id,
      workspaceId: row.workspaceId,
      endpointId: row.endpointId,
      status: row.status as WebhookSubscription['status'],
      filter: { eventTypes, ...(resourceIds ? { resourceIds } : {}) },
      createdByClientId: row.createdByClientId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.pausedAt ? { pausedAt: row.pausedAt.toISOString() } : {}),
      ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook subscription is invalid')
  }
}

function secret(value: {
  version: number
  fingerprint: string
  status: string
  createdAt: Date
  retiredAt: Date | null
  revokedAt: Date | null
}): Readonly<WebhookSigningSecretMetadata> {
  if (!['active', 'retired', 'revoked'].includes(value.status)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook secret metadata is invalid')
  }
  return Object.freeze({
    version: value.version,
    fingerprint: value.fingerprint,
    status: value.status as WebhookSigningSecretMetadata['status'],
    createdAt: value.createdAt.toISOString(),
    ...(value.retiredAt ? { retiredAt: value.retiredAt.toISOString() } : {}),
    ...(value.revokedAt ? { revokedAt: value.revokedAt.toISOString() } : {}),
  })
}

function validateList(query: { workspaceId: string; limit: number; after?: { id: string; createdAt: string }; endpointId?: string }) {
  const afterDate = query.after ? new Date(query.after.createdAt) : undefined
  if (
    !SAFE_ID_PATTERN.test(query.workspaceId) ||
    !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 101 ||
    (query.endpointId !== undefined && !UUID_V4_PATTERN.test(query.endpointId)) ||
    (query.after !== undefined && (!UUID_V4_PATTERN.test(query.after.id) || Number.isNaN(afterDate?.getTime())))
  ) throw new DomainError('INVALID_WEBHOOK', 'Webhook administration list query is invalid')
  return afterDate
}

const secretSelect = {
  version: true,
  fingerprint: true,
  status: true,
  createdAt: true,
  retiredAt: true,
  revokedAt: true,
} as const

export class PrismaWebhookAdministrationQueryRepository implements WebhookAdministrationQueryRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  async listEndpoints(query: Parameters<WebhookAdministrationQueryRepository['listEndpoints']>[0]) {
    const afterDate = validateList(query)
    const rows = await this.client.v2WebhookEndpoint.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.after && afterDate ? { OR: [{ createdAt: { lt: afterDate } }, { createdAt: afterDate, id: { lt: query.after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      include: { secrets: { select: secretSelect, orderBy: { version: 'desc' }, take: 1 } },
    })
    return Object.freeze(rows.map((row) => Object.freeze({
      endpoint: endpoint(row),
      ...(row.secrets[0] ? { currentSecret: secret(row.secrets[0]) } : {}),
    })))
  }

  async findEndpointById(workspaceId: string, endpointId: string) {
    if (!SAFE_ID_PATTERN.test(workspaceId) || !UUID_V4_PATTERN.test(endpointId)) throw new DomainError('INVALID_WEBHOOK', 'Webhook endpoint identity is invalid')
    const row = await this.client.v2WebhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId },
      include: { secrets: { select: secretSelect, orderBy: { version: 'asc' }, take: 101 } },
    })
    if (!row) return null
    if (row.secrets.length > 100) throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint has too many secret versions')
    const signingSecrets = Object.freeze(row.secrets.map(secret))
    return Object.freeze({
      endpoint: endpoint(row),
      ...(signingSecrets.at(-1) ? { currentSecret: signingSecrets.at(-1) } : {}),
      signingSecrets,
    })
  }

  async listSubscriptions(query: Parameters<WebhookAdministrationQueryRepository['listSubscriptions']>[0]) {
    const afterDate = validateList(query)
    const rows = await this.client.v2WebhookSubscription.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.endpointId ? { endpointId: query.endpointId } : {}),
        ...(query.after && afterDate ? { OR: [{ createdAt: { lt: afterDate } }, { createdAt: afterDate, id: { lt: query.after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    })
    return Object.freeze(rows.map(subscription))
  }

  async findSubscriptionById(workspaceId: string, subscriptionId: string) {
    if (!SAFE_ID_PATTERN.test(workspaceId) || !UUID_V4_PATTERN.test(subscriptionId)) throw new DomainError('INVALID_WEBHOOK', 'Webhook subscription identity is invalid')
    const row = await this.client.v2WebhookSubscription.findFirst({ where: { id: subscriptionId, workspaceId } })
    return row ? subscription(row) : null
  }
}
