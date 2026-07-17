import { createHash } from 'node:crypto'

import { DomainError, assertDomain } from '../domain/errors.ts'
import { PROJECT_STATUSES } from '../domain/project.ts'
import type { ProjectQueryRepository } from './ports/project-query-repository.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/

interface ProjectCursor {
  v: 1
  createdAt: string
  id: string
  queryHash: string
}

function encodeCursor(cursor: ProjectCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, queryHash: string): ProjectCursor {
  assertDomain(CURSOR_PATTERN.test(value), 'INVALID_ARGUMENT', 'after must be a valid project cursor')
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    assertDomain(
      parsed.v === 1 && Object.keys(parsed).length === 4 &&
        typeof parsed.createdAt === 'string' && new Date(parsed.createdAt).toISOString() === parsed.createdAt &&
        typeof parsed.id === 'string' && ID_PATTERN.test(parsed.id) &&
        parsed.queryHash === queryHash,
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
  return async function listProjects(input: {
    workspaceId: string
    limit?: number
    after?: string
    text?: string
    status?: string
    objective?: string
    format?: string
    locale?: string
    createdFrom?: string
    createdTo?: string
    ownerId?: string
  }) {
    const limit = input.limit ?? 20
    assertDomain(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_ARGUMENT', 'limit must be an integer from 1 to 100')
    const filters = Object.fromEntries(Object.entries({
      text: input.text,
      status: input.status,
      objective: input.objective,
      format: input.format,
      locale: input.locale,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      ownerId: input.ownerId,
    }).filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => [key, (value as string).trim()]))
    assertDomain(!filters.text || filters.text.length <= 120, 'INVALID_ARGUMENT', 'text must contain at most 120 characters')
    assertDomain(!filters.status || PROJECT_STATUSES.includes(filters.status as (typeof PROJECT_STATUSES)[number]), 'INVALID_ARGUMENT', 'status is not supported')
    assertDomain(!filters.format || ['9:16', '16:9', '4:5', '1:1', '21:9'].includes(filters.format), 'INVALID_ARGUMENT', 'format is not supported')
    assertDomain(!filters.locale || /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(filters.locale), 'INVALID_ARGUMENT', 'locale must be a valid language tag')
    assertDomain(!filters.objective || /^[a-z0-9][a-z0-9-]{0,63}$/.test(filters.objective), 'INVALID_ARGUMENT', 'objective is not supported')
    assertDomain(!filters.ownerId || ID_PATTERN.test(filters.ownerId), 'INVALID_ARGUMENT', 'ownerId is invalid')
    for (const field of ['createdFrom', 'createdTo'] as const) assertDomain(!filters[field] || !Number.isNaN(Date.parse(filters[field])), 'INVALID_ARGUMENT', `${field} must be a valid date-time`)
    assertDomain(!filters.createdFrom || !filters.createdTo || Date.parse(filters.createdFrom) <= Date.parse(filters.createdTo), 'INVALID_ARGUMENT', 'createdFrom must not be after createdTo')
    const queryHash = createHash('sha256').update(JSON.stringify({ workspaceId: input.workspaceId, filters })).digest('hex')
    const after = input.after?.trim() ? decodeCursor(input.after.trim(), queryHash) : undefined
    const records = await dependencies.projects.listByWorkspace({
      workspaceId: input.workspaceId,
      limit: limit + 1,
      ...(Object.keys(filters).length ? { filters } : {}),
      ...(after ? { after: { createdAt: after.createdAt, id: after.id } } : {}),
    })
    const page = records.slice(0, limit)
    const last = page.at(-1)
    return Object.freeze({
      projects: Object.freeze(page),
      ...(records.length > limit && last
        ? { nextCursor: encodeCursor({ v: 1, createdAt: last.createdAt, id: last.id, queryHash }) }
        : {}),
    })
  }
}
