import { createHash } from 'node:crypto'

import { DomainError, assertDomain } from '../domain/errors.ts'
import type { ProjectQueryRepository } from './ports/project-query-repository.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/

interface ProjectCursor {
  v: 1
  createdAt: string
  id: string
  workspaceHash: string
}

function encodeCursor(cursor: ProjectCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, workspaceHash: string): ProjectCursor {
  assertDomain(CURSOR_PATTERN.test(value), 'INVALID_ARGUMENT', 'after must be a valid project cursor')
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    assertDomain(
      parsed.v === 1 && Object.keys(parsed).length === 4 &&
        typeof parsed.createdAt === 'string' && new Date(parsed.createdAt).toISOString() === parsed.createdAt &&
        typeof parsed.id === 'string' && ID_PATTERN.test(parsed.id) &&
        parsed.workspaceHash === workspaceHash,
      'INVALID_ARGUMENT',
      'after does not match this project query',
    )
    return parsed as unknown as ProjectCursor
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_ARGUMENT', 'after must be a valid project cursor')
  }
}

export function listProjectsService(dependencies: { projects: ProjectQueryRepository }) {
  return async function listProjects(input: { workspaceId: string; limit?: number; after?: string }) {
    const limit = input.limit ?? 20
    assertDomain(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_ARGUMENT', 'limit must be an integer from 1 to 100')
    const workspaceHash = createHash('sha256').update(input.workspaceId).digest('hex')
    const after = input.after?.trim() ? decodeCursor(input.after.trim(), workspaceHash) : undefined
    const records = await dependencies.projects.listByWorkspace({
      workspaceId: input.workspaceId,
      limit: limit + 1,
      ...(after ? { after: { createdAt: after.createdAt, id: after.id } } : {}),
    })
    const page = records.slice(0, limit)
    const last = page.at(-1)
    return Object.freeze({
      projects: Object.freeze(page),
      ...(records.length > limit && last
        ? { nextCursor: encodeCursor({ v: 1, createdAt: last.createdAt, id: last.id, workspaceHash }) }
        : {}),
    })
  }
}
