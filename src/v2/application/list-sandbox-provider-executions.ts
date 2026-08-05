import { stableSerialize } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  SandboxProviderExecutionRepository,
} from './ports/sandbox-provider-execution-repository.ts'

interface Cursor {
  v: 1
  workspaceId: string
  createdAt: string
  receiptHash: string
}

const CURSOR = /^[A-Za-z0-9_-]{16,1024}$/
const SHA256 = /^[a-f0-9]{64}$/

function encodeCursor(value: Cursor): string {
  return Buffer.from(stableSerialize(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string, workspaceId: string) {
  assertDomain(CURSOR.test(value), 'INVALID_CURSOR', 'cursor is invalid')
  try {
    const decoded = Buffer.from(value, 'base64url')
    assertDomain(decoded.toString('base64url') === value, 'INVALID_CURSOR', 'cursor is invalid')
    const parsed = JSON.parse(decoded.toString('utf8')) as Cursor
    assertDomain(
      typeof parsed === 'object' && parsed !== null &&
        Object.keys(parsed).toSorted().join(',') ===
          'createdAt,receiptHash,v,workspaceId' && parsed.v === 1 &&
        parsed.workspaceId === workspaceId && SHA256.test(parsed.receiptHash) &&
        new Date(parsed.createdAt).toISOString() === parsed.createdAt,
      'INVALID_CURSOR',
      'cursor does not match this sandbox execution query',
    )
    return Object.freeze({
      createdAt: parsed.createdAt,
      receiptHash: parsed.receiptHash,
    })
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_CURSOR', 'cursor is invalid')
  }
}

export function listSandboxProviderExecutionsService(dependencies: {
  repository: SandboxProviderExecutionRepository
}) {
  return async function query(input: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    limit?: number
    after?: string
  }) {
    requireScope(input.actor, 'clients:admin')
    const audit = materializeActorAuditContext(input.actor)
    const workspaceId = input.workspaceId.trim()
    assertDomain(
      audit.workspaceId === workspaceId,
      'WORKSPACE_NOT_FOUND',
      'Workspace was not found',
    )
    const limit = input.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    const rows = await dependencies.repository.list({
      workspaceId,
      limit: limit + 1,
      ...(input.after ? { after: decodeCursor(input.after, workspaceId) } : {}),
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return Object.freeze({
      entries: Object.freeze(page.map(({ receipt, createdAt }) =>
        Object.freeze({ ...receipt, createdAt }))),
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor({
            v: 1,
            workspaceId,
            createdAt: last.createdAt,
            receiptHash: last.receipt.receiptHash,
          }) }
        : {}),
    })
  }
}
