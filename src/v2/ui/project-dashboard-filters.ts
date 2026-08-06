import { OUTPUT_ASPECT_RATIOS, type OutputAspectRatio } from '../domain/output-spec.ts'
import { PROJECT_STATUSES, type ProjectStatus } from '../domain/project.ts'
import {
  STRATEGIC_OBJECTIVES,
  type StrategicObjectiveId,
} from '../domain/strategic-objective.ts'

export const PROJECT_DASHBOARD_FILTER_SESSION_KEY =
  'apollo:v2:project-dashboard-filters/v1'

export interface ProjectDashboardFilters {
  text: string
  status: ProjectStatus | ''
  objective: StrategicObjectiveId | ''
  format: OutputAspectRatio | ''
  locale: string
  createdFrom: string
  createdTo: string
  ownerId: string
}

export const EMPTY_PROJECT_DASHBOARD_FILTERS: Readonly<ProjectDashboardFilters> =
  Object.freeze({
    text: '',
    status: '',
    objective: '',
    format: '',
    locale: '',
    createdFrom: '',
    createdTo: '',
    ownerId: '',
  })

const FILTER_KEYS = [
  'text', 'status', 'objective', 'format', 'locale',
  'createdFrom', 'createdTo', 'ownerId',
] as const
const OBJECTIVE_IDS = STRATEGIC_OBJECTIVES.map((objective) => objective.id)
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function bounded(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.trim().length <= maximum
    ? value.trim()
    : ''
}

function date(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim().slice(0, 10)
  const timestamp = DATE.test(candidate)
    ? Date.parse(`${candidate}T00:00:00.000Z`)
    : Number.NaN
  return Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === candidate
    ? candidate
    : ''
}

export function normalizeProjectDashboardFilters(
  input: Partial<Record<keyof ProjectDashboardFilters, unknown>>,
): Readonly<ProjectDashboardFilters> {
  const status = bounded(input.status, 32)
  const objective = bounded(input.objective, 64)
  const format = bounded(input.format, 8)
  const locale = bounded(input.locale, 35)
  const ownerId = bounded(input.ownerId, 128)
  const createdFrom = date(input.createdFrom)
  const createdTo = date(input.createdTo)
  return Object.freeze({
    text: bounded(input.text, 120),
    status: PROJECT_STATUSES.includes(status as ProjectStatus)
      ? status as ProjectStatus
      : '',
    objective: OBJECTIVE_IDS.includes(objective as StrategicObjectiveId)
      ? objective as StrategicObjectiveId
      : '',
    format: OUTPUT_ASPECT_RATIOS.includes(format as OutputAspectRatio)
      ? format as OutputAspectRatio
      : '',
    locale: LOCALE.test(locale) ? locale : '',
    createdFrom,
    createdTo:
      createdFrom && createdTo && createdTo < createdFrom ? '' : createdTo,
    ownerId: OWNER_ID.test(ownerId) ? ownerId : '',
  })
}

function paramsRecord(params: URLSearchParams) {
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? '']))
}

export function resolveProjectDashboardFilters(input: {
  urlSearch: string
  sessionValue?: string | null
}): Readonly<ProjectDashboardFilters> {
  const params = new URLSearchParams(input.urlSearch)
  if (FILTER_KEYS.some((key) => params.has(key))) {
    return normalizeProjectDashboardFilters(paramsRecord(params))
  }
  if (!input.sessionValue) return EMPTY_PROJECT_DASHBOARD_FILTERS
  try {
    const stored = JSON.parse(input.sessionValue) as Record<string, unknown>
    return normalizeProjectDashboardFilters(stored)
  } catch {
    return EMPTY_PROJECT_DASHBOARD_FILTERS
  }
}

export function projectDashboardUrlSearch(
  filters: Readonly<ProjectDashboardFilters>,
): string {
  const params = new URLSearchParams()
  for (const key of FILTER_KEYS) {
    if (filters[key]) params.set(key, filters[key])
  }
  const value = params.toString()
  return value ? `?${value}` : ''
}

export function projectDashboardApiSearch(
  filters: Readonly<ProjectDashboardFilters>,
  input: { limit: number; after?: string },
): string {
  const params = new URLSearchParams({ limit: String(input.limit) })
  for (const key of FILTER_KEYS) {
    const value = filters[key]
    if (!value) continue
    if (key === 'createdFrom') {
      params.set(key, `${value}T00:00:00.000Z`)
    } else if (key === 'createdTo') {
      params.set(key, `${value}T23:59:59.999Z`)
    } else {
      params.set(key, value)
    }
  }
  if (input.after) params.set('after', input.after)
  return params.toString()
}

export function hasProjectDashboardFilters(
  filters: Readonly<ProjectDashboardFilters>,
): boolean {
  return FILTER_KEYS.some((key) => Boolean(filters[key]))
}
