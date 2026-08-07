import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { createProjectDashboardRecord } from '../../src/v2/domain/project-dashboard.ts'
import { createProject } from '../../src/v2/domain/project.ts'
import { PrismaProjectQueryRepository } from '../../src/v2/infrastructure/prisma/project-query-repository.ts'
import { presentProjectDashboard } from '../../src/v2/public-api/presenters.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const dashboardSource = readFileSync(
  new URL('../../src/app/ProjectsPageClient.tsx', import.meta.url),
  'utf8',
)

test('T-FR-012 project creation previews canonical briefing coverage before submission', () => {
  assert.match(dashboardSource, /createProductionBrief\(\{ ownerText: briefing \}\)/)
  assert.match(dashboardSource, /data-testid="production-brief-preview"/)
  assert.match(dashboardSource, /data-testid="production-brief-preview-summary"/)
  assert.match(dashboardSource, /data-testid="production-brief-preview-coverage"/)
  assert.match(dashboardSource, /data-testid="production-brief-preview-assumptions"/)
  assert.match(dashboardSource, /Geração ainda não iniciada/)
})

test('T-FR-236 dashboard consumes the public visible-state contract without inferring legacy statuses', () => {
  assert.match(dashboardSource, /visibleState: VisibleState/)
  assert.match(dashboardSource, /projectBucket\(project\.visibleState\)/)
  assert.match(dashboardSource, /PROJECT_TONE_CLASSES\[project\.visibleState\.tone\]/)
  assert.match(dashboardSource, /PROJECT_STATE_LABELS\[project\.visibleState\.label\]/)
  assert.match(dashboardSource, /PROJECT_ACTION_LABELS\[project\.visibleState\.primaryAction\]/)
  assert.doesNotMatch(dashboardSource, /function projectState\(status:/)
  assert.doesNotMatch(
    dashboardSource,
    /status === ['"](?:complete|error|ready|awaiting-review|directing|rendering)['"]/,
  )
  assert.equal(
    existsSync(new URL('../../src/v2/domain/project-dashboard.ts', import.meta.url)),
    true,
  )
  assert.match(dashboardSource, /apollo:project-updated/)
  assert.match(dashboardSource, /latestOperation\.progress!\.completed/)
  assert.match(dashboardSource, /measuredTotal[\s\S]*measuredPercent/)
  assert.match(dashboardSource, /measuredPercent !== null[\s\S]*role="progressbar"/)
  assert.match(dashboardSource, /sem total medido/)
  assert.match(dashboardSource, /PROJECT_DASHBOARD_FILTER_SESSION_KEY/)
  assert.match(dashboardSource, /window\.history\.replaceState/)
  assert.match(dashboardSource, /projectDashboardApiSearch/)
  assert.match(dashboardSource, /nextCursor/)
  assert.match(dashboardSource, /Carregar mais projetos/)
  for (const action of ['Abrir', 'Revisar', 'Duplicar', 'Renomear', 'Arquivar', 'Restaurar']) {
    assert.match(dashboardSource, new RegExp(`>${action}<`))
  }
  assert.match(dashboardSource, /administrationRevision/)
  assert.match(dashboardSource, /archivedFromStatus/)
  assert.match(dashboardSource, /confirmed: true/)
  assert.doesNotMatch(dashboardSource, /optimisticProjectPatch/)
  assert.doesNotMatch(dashboardSource, /project\.name\.toLocaleLowerCase/)
})

function project(status = 'rendering-proxy') {
  return createProject({
    id: 'project-dashboard-1', workspaceId: 'workspace-dashboard-1',
    name: 'Dashboard aggregate', status,
    currentVersionId: 'project-version-dashboard-1',
    createdBy: { type: 'api-client', id: 'client-dashboard-1' },
    createdAt: '2026-08-06T12:00:00.000Z',
  })
}

test('F1.001 dashboard aggregate exposes only measured progress and current-version evidence', () => {
  const record = createProjectDashboardRecord({
    project: project(),
    currentVersion: {
      id: 'project-version-dashboard-1', sequence: 3,
      createdAt: '2026-08-06T12:01:00.000Z',
    },
    latestOperation: {
      id: 'operation-dashboard-1', type: 'project-proxy-render',
      status: 'running', phase: 'rendering',
      progress: { completed: 60, unit: 'frames' },
      updatedAt: '2026-08-06T12:02:00.000Z',
    },
    openReviewIssueCount: 2,
    outputs: [{ artifactId: 'artifact-dashboard-1', aspectRatio: '9:16' }],
    lastActivityAt: '2026-08-06T12:02:00.000Z',
    administrationRevision: 1,
    archivedFromStatus: null,
  })
  assert.equal(record.dashboard.outputCount, 1)
  assert.deepEqual(record.dashboard.latestOperation.progress, {
    completed: 60, unit: 'frames',
  })
  assert.equal('percent' in record.dashboard.latestOperation.progress, false)
  assert.equal(Object.isFrozen(record.dashboard), true)
  assert.equal(Object.isFrozen(record.dashboard.outputs), true)
  assert.throws(
    () => createProjectDashboardRecord({
      project: project(),
      currentVersion: {
        id: 'wrong-version-dashboard-1', sequence: 3,
        createdAt: '2026-08-06T12:01:00.000Z',
      },
      latestOperation: null, openReviewIssueCount: 0, outputs: [],
      lastActivityAt: '2026-08-06T12:02:00.000Z',
      administrationRevision: 1, archivedFromStatus: null,
    }),
    /current version is inconsistent/,
  )
})

test('F1.001 Prisma query aggregates the current version, latest real job, issues and outputs', async () => {
  let query
  const repository = new PrismaProjectQueryRepository({
    v2Project: {
      async findMany(input) {
        query = input
        return [{
          id: 'project-dashboard-1', workspaceId: 'workspace-dashboard-1',
          name: 'Dashboard aggregate', status: 'completed', objective: 'sale',
          format: '16:9', locale: 'pt-BR', ownerId: 'owner-dashboard-1',
          currentVersionId: 'project-version-dashboard-1',
          duplicatedFromProjectId: null,
          createdByType: 'api-client', createdById: 'client-dashboard-1',
          createdAt: new Date('2026-08-06T12:00:00.000Z'),
          updatedAt: new Date('2026-08-06T12:03:00.000Z'),
          administrationRevision: 4, archivedFromStatus: null,
          currentVersion: {
            id: 'project-version-dashboard-1', sequence: 3,
            createdAt: new Date('2026-08-06T12:01:00.000Z'),
            _count: { reviewAnnotations: 2 },
            finalExportOperations: [{
              outputArtifactId: 'artifact-dashboard-1',
              outputAspectRatio: '16:9',
            }],
          },
          publicOperations: [{
            id: 'operation-dashboard-1', type: 'project-final-export',
            status: 'succeeded', phase: 'completed',
            progressCompleted: 240, progressTotal: 240,
            progressUnit: 'frames', errorCode: null, errorRetryable: null,
            updatedAt: new Date('2026-08-06T12:04:00.000Z'),
          }],
        }]
      },
    },
  })
  const [record] = await repository.listByWorkspace({
    workspaceId: 'workspace-dashboard-1', limit: 20,
    filters: { text: 'aggregate' },
  })
  assert.equal(query.where.workspaceId, 'workspace-dashboard-1')
  assert.deepEqual(query.where.name, {
    contains: 'aggregate', mode: 'insensitive',
  })
  assert.deepEqual(query.orderBy, [
    { createdAt: 'desc' }, { id: 'desc' },
  ])
  assert.deepEqual(query.include.publicOperations.orderBy, [
    { updatedAt: 'desc' }, { id: 'desc' },
  ])
  assert.deepEqual(
    query.include.currentVersion.select._count.select.reviewAnnotations,
    { where: { status: 'open' } },
  )
  assert.deepEqual(
    query.include.currentVersion.select.finalExportOperations.where,
    { operation: { status: 'succeeded' } },
  )
  assert.equal(record.dashboard.currentVersion.sequence, 3)
  assert.equal(record.dashboard.openReviewIssueCount, 2)
  assert.equal(record.dashboard.outputCount, 1)
  assert.equal(record.dashboard.administrationRevision, 4)
  assert.equal(record.dashboard.archivedFromStatus, null)
  assert.deepEqual(record.dashboard.latestOperation.progress, {
    completed: 240, total: 240, unit: 'frames',
  })
  assert.equal(record.dashboard.lastActivityAt, '2026-08-06T12:04:00.000Z')
})

test('F1.003 public project-list v6 validates administration evidence and rejects fabricated progress', () => {
  const record = createProjectDashboardRecord({
    project: project(),
    currentVersion: {
      id: 'project-version-dashboard-1', sequence: 3,
      createdAt: '2026-08-06T12:01:00.000Z',
    },
    latestOperation: {
      id: 'operation-dashboard-1', type: 'project-proxy-render',
      status: 'running', phase: 'rendering', progress: { completed: 60 },
      updatedAt: '2026-08-06T12:02:00.000Z',
    },
    openReviewIssueCount: 0, outputs: [],
    lastActivityAt: '2026-08-06T12:02:00.000Z',
    administrationRevision: 1, archivedFromStatus: null,
  })
  const body = {
    data: { projects: [presentProjectDashboard(record)] },
    meta: { apiVersion: 'v1' },
  }
  const validate = addFormats(new Ajv2020({ strict: true, allErrors: true }))
    .compile(getPublicSchema('apollo://schemas/project-list/v6').schema)
  assert.equal(validate(body), true, JSON.stringify(validate.errors))
  const fabricated = structuredClone(body)
  fabricated.data.projects[0].dashboard.latestOperation.progress.percent = 60
  assert.equal(validate(fabricated), false)
})
