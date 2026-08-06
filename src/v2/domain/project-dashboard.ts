import { assertDomain } from './errors.ts'
import { OUTPUT_ASPECT_RATIOS, type OutputAspectRatio } from './output-spec.ts'
import type { Project } from './project.ts'
import {
  PERSISTED_PUBLIC_OPERATION_PHASES,
  PERSISTED_PUBLIC_OPERATION_TYPES,
  PUBLIC_OPERATION_STATUSES,
  type PublicOperationPhase,
  type PublicOperationStatus,
  type PublicOperationType,
} from './public-operation.ts'

export const PROJECT_DASHBOARD_SCHEMA_VERSION =
  'project-dashboard-summary/v1' as const

export interface ProjectDashboardCurrentVersion {
  id: string
  sequence: number
  createdAt: string
}

export interface ProjectDashboardOperation {
  id: string
  type: Exclude<PublicOperationType, 'production-batch-item'>
  status: PublicOperationStatus
  phase: Exclude<PublicOperationPhase, 'planning' | 'reviewing'>
  progress?: Readonly<{
    completed: number
    total?: number
    unit?: string
  }>
  error?: Readonly<{ code: string; retryable: boolean }>
  updatedAt: string
}

export interface ProjectDashboardOutput {
  artifactId: string
  aspectRatio: OutputAspectRatio
}

export interface ProjectDashboardSummary {
  schemaVersion: typeof PROJECT_DASHBOARD_SCHEMA_VERSION
  currentVersion: Readonly<ProjectDashboardCurrentVersion> | null
  latestOperation: Readonly<ProjectDashboardOperation> | null
  openReviewIssueCount: number
  outputs: readonly Readonly<ProjectDashboardOutput>[]
  outputCount: number
  lastActivityAt: string
}

export type ProjectDashboardRecord = Readonly<Project> & Readonly<{
  dashboard: Readonly<ProjectDashboardSummary>
}>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_COUNT = 2_000_000_000

function instant(value: string, field: string): string {
  const timestamp = Date.parse(value)
  assertDomain(
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function currentVersion(
  input: ProjectDashboardCurrentVersion | null,
  project: Readonly<Project>,
) {
  assertDomain(
    (input === null && project.currentVersionId === undefined) ||
      (input !== null && input.id === project.currentVersionId &&
        ID.test(input.id) && Number.isSafeInteger(input.sequence) &&
        input.sequence >= 1),
    'INVALID_ARGUMENT',
    'project dashboard current version is inconsistent',
  )
  return input === null
    ? null
    : Object.freeze({
        id: input.id,
        sequence: input.sequence,
        createdAt: instant(
          input.createdAt,
          'project dashboard version timestamp',
        ),
      })
}

function latestOperation(input: ProjectDashboardOperation | null) {
  if (input === null) return null
  assertDomain(
    ID.test(input.id) &&
      PERSISTED_PUBLIC_OPERATION_TYPES.includes(input.type) &&
      PUBLIC_OPERATION_STATUSES.includes(input.status) &&
      PERSISTED_PUBLIC_OPERATION_PHASES.includes(input.phase) &&
      (input.error === undefined ||
        (input.status === 'failed' && TOKEN.test(input.error.code) &&
          typeof input.error.retryable === 'boolean')) &&
      (input.status !== 'failed' || input.error !== undefined),
    'INVALID_ARGUMENT',
    'project dashboard operation is invalid',
  )
  let progress: ProjectDashboardOperation['progress']
  if (input.progress) {
    const { completed, total, unit } = input.progress
    assertDomain(
      Number.isSafeInteger(completed) && completed >= 0 &&
        completed <= MAX_COUNT &&
        (total === undefined ||
          (Number.isSafeInteger(total) && total >= 1 && total <= MAX_COUNT &&
            completed <= total)) &&
        (unit === undefined || TOKEN.test(unit)),
      'INVALID_ARGUMENT',
      'project dashboard operation progress is invalid',
    )
    progress = Object.freeze({
      completed,
      ...(total !== undefined ? { total } : {}),
      ...(unit !== undefined ? { unit } : {}),
    })
  }
  return Object.freeze({
    id: input.id,
    type: input.type,
    status: input.status,
    phase: input.phase,
    ...(progress ? { progress } : {}),
    ...(input.error ? { error: Object.freeze({ ...input.error }) } : {}),
    updatedAt: instant(
      input.updatedAt,
      'project dashboard operation timestamp',
    ),
  })
}

function outputs(input: readonly ProjectDashboardOutput[]) {
  assertDomain(
    input.length <= 1000 &&
      input.every((item) =>
        ID.test(item.artifactId) &&
        OUTPUT_ASPECT_RATIOS.includes(item.aspectRatio)) &&
      new Set(input.map((item) => item.artifactId)).size === input.length,
    'INVALID_ARGUMENT',
    'project dashboard outputs are invalid',
  )
  return Object.freeze(input.map((item) => Object.freeze({ ...item })))
}

export function createProjectDashboardRecord(input: {
  project: Readonly<Project>
  currentVersion: ProjectDashboardCurrentVersion | null
  latestOperation: ProjectDashboardOperation | null
  openReviewIssueCount: number
  outputs: readonly ProjectDashboardOutput[]
  lastActivityAt: string
}): ProjectDashboardRecord {
  assertDomain(
    Number.isSafeInteger(input.openReviewIssueCount) &&
      input.openReviewIssueCount >= 0 &&
      input.openReviewIssueCount <= MAX_COUNT,
    'INVALID_ARGUMENT',
    'project dashboard review issue count is invalid',
  )
  const dashboardOutputs = outputs(input.outputs)
  const lastActivityAt = instant(
    input.lastActivityAt,
    'project dashboard activity timestamp',
  )
  assertDomain(
    Date.parse(lastActivityAt) >= Date.parse(input.project.createdAt),
    'INVALID_ARGUMENT',
    'project dashboard activity precedes the project',
  )
  return Object.freeze({
    ...input.project,
    dashboard: Object.freeze({
      schemaVersion: PROJECT_DASHBOARD_SCHEMA_VERSION,
      currentVersion: currentVersion(input.currentVersion, input.project),
      latestOperation: latestOperation(input.latestOperation),
      openReviewIssueCount: input.openReviewIssueCount,
      outputs: dashboardOutputs,
      outputCount: dashboardOutputs.length,
      lastActivityAt,
    }),
  })
}
