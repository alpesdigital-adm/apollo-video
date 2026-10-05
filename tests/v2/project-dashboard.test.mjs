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

// ---------------------------------------------------------------------------
// W34: persisted aggregate, real absence and fail-closed inconsistent relations.
//
// Inconsistent relations are exercised here, with controlled injection into the
// repository Prisma port, and never by corrupting PostgreSQL in the E2E.
// ---------------------------------------------------------------------------

const W34_WORKSPACE = 'workspace-dashboard-1'

function w34Row(overrides = {}) {
  return {
    id: 'project-dashboard-1', workspaceId: W34_WORKSPACE,
    name: 'w34 aggregate', status: 'completed', objective: 'sale',
    format: '16:9', locale: 'pt-BR', ownerId: 'owner-dashboard-1',
    currentVersionId: 'project-version-dashboard-1',
    duplicatedFromProjectId: null,
    createdByType: 'api-client', createdById: 'client-dashboard-1',
    createdAt: new Date('2026-08-06T12:00:00.000Z'),
    updatedAt: new Date('2026-08-06T12:03:00.000Z'),
    administrationRevision: 1, archivedFromStatus: null,
    currentVersion: {
      id: 'project-version-dashboard-1', sequence: 3,
      createdAt: new Date('2026-08-06T12:01:00.000Z'),
      _count: { reviewAnnotations: 2 },
      finalExportOperations: [{
        outputArtifactId: 'artifact-dashboard-1', outputAspectRatio: '16:9',
      }],
    },
    publicOperations: [{
      id: 'operation-dashboard-1', type: 'project-final-export',
      status: 'succeeded', phase: 'completed',
      progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
      errorCode: null, errorRetryable: null,
      updatedAt: new Date('2026-08-06T12:04:00.000Z'),
    }],
    ...overrides,
  }
}

function w34Version(overrides = {}) {
  return {
    id: 'project-version-dashboard-1', sequence: 3,
    createdAt: new Date('2026-08-06T12:01:00.000Z'),
    _count: { reviewAnnotations: 0 }, finalExportOperations: [],
    ...overrides,
  }
}

function w34Operation(overrides = {}) {
  return {
    id: 'operation-dashboard-1', type: 'project-final-export',
    status: 'running', phase: 'rendering',
    progressCompleted: 1, progressTotal: 4, progressUnit: 'render',
    errorCode: null, errorRetryable: null,
    updatedAt: new Date('2026-08-06T12:04:00.000Z'),
    ...overrides,
  }
}

function w34Repository(rows) {
  return new PrismaProjectQueryRepository({
    v2Project: { async findMany() { return rows } },
  })
}

const w34List = (rows) => w34Repository(rows).listByWorkspace({
  workspaceId: W34_WORKSPACE, limit: 20,
})

test('W34 real absence is null or empty and the repository never invents a version, operation or output', async () => {
  const [record] = await w34List([w34Row({
    status: 'draft', currentVersionId: null, currentVersion: null,
    publicOperations: [],
  })])
  assert.equal(record.dashboard.currentVersion, null)
  assert.equal(record.dashboard.latestOperation, null)
  assert.equal(record.dashboard.openReviewIssueCount, 0)
  assert.deepEqual(record.dashboard.outputs, [])
  assert.equal(record.dashboard.outputCount, 0)
  assert.equal(record.currentVersionId, undefined)
  assert.equal(record.dashboard.lastActivityAt, '2026-08-06T12:03:00.000Z')

  // A current version without any review issue, output or operation reports
  // zeros and an empty list, not placeholders.
  const [bare] = await w34List([w34Row({
    status: 'draft', currentVersion: w34Version({ sequence: 1 }),
    publicOperations: [],
  })])
  assert.equal(bare.dashboard.currentVersion.sequence, 1)
  assert.equal(bare.dashboard.latestOperation, null)
  assert.equal(bare.dashboard.openReviewIssueCount, 0)
  assert.deepEqual(bare.dashboard.outputs, [])
})

test('W34 inconsistent relations fail closed with a domain error instead of a fabricated card', async () => {
  const cases = [
    ['project names a current version but the relation is missing',
      { currentVersion: null }, /current version is inconsistent/],
    ['a version relation exists for a project without current version',
      { currentVersionId: null }, /current version is inconsistent/],
    ['the version relation is not the project current version',
      { currentVersion: w34Version({ id: 'project-version-other-1' }) },
      /current version is inconsistent/],
    ['the version sequence is not a positive integer',
      { currentVersion: w34Version({ sequence: 0 }) },
      /current version is inconsistent/],
    ['an output has an unsupported aspect ratio',
      { currentVersion: w34Version({
        finalExportOperations: [{
          outputArtifactId: 'artifact-dashboard-1', outputAspectRatio: '2:3',
        }],
      }) }, /outputs are invalid/],
    ['the same output artifact is listed twice',
      { currentVersion: w34Version({
        finalExportOperations: [
          { outputArtifactId: 'artifact-dashboard-1', outputAspectRatio: '16:9' },
          { outputArtifactId: 'artifact-dashboard-1', outputAspectRatio: '16:9' },
        ],
      }) }, /outputs are invalid/],
    ['a negative number of open review issues',
      { currentVersion: w34Version({ _count: { reviewAnnotations: -1 } }) },
      /review issue count is invalid/],
    ['a failed operation without a persisted error code',
      { publicOperations: [w34Operation({
        status: 'failed', phase: 'failed', progressCompleted: 2,
      })] }, /operation is invalid/],
    ['operation progress beyond its own total',
      { publicOperations: [w34Operation({ progressCompleted: 5 })] },
      /progress is invalid/],
    ['an operation of a type the dashboard does not accept',
      { publicOperations: [w34Operation({ type: 'production-batch-item' })] },
      /operation is invalid/],
    ['activity that precedes the project itself',
      { updatedAt: new Date('2026-08-06T11:00:00.000Z'), publicOperations: [] },
      /activity precedes the project/],
    ['an archived-from fence on a project that is not archived',
      { archivedFromStatus: 'draft' }, /administration state is invalid/],
    ['an archived project whose fence names archived itself',
      { status: 'archived', archivedFromStatus: 'archived' },
      /administration state is invalid/],
  ]
  for (const [label, overrides, expected] of cases) {
    await assert.rejects(
      () => w34List([w34Row(overrides)]),
      (error) => expected.test(error.message),
      label,
    )
  }
})

test('W34 one inconsistent row rejects the whole page so no partial or invented list is returned', async () => {
  const valid = w34Row({ id: 'project-dashboard-valid' })
  const invalid = w34Row({ id: 'project-dashboard-broken', currentVersion: null })
  let delivered
  await assert.rejects(async () => {
    delivered = await w34List([valid, invalid])
  }, /current version is inconsistent/)
  assert.equal(delivered, undefined)
  const { listProjectsService } = await import('../../src/v2/application/list-projects.ts')
  await assert.rejects(
    () => listProjectsService({ projects: w34Repository([valid, invalid]) })({
      workspaceId: W34_WORKSPACE, limit: 5,
    }),
    /current version is inconsistent/,
  )
})

test('W34 operation progress without a total stays a contract shape and never gains a percentage', async () => {
  // PostgreSQL canonical progress CHECK makes every persisted operation
  // measured (proved by the W35 E2E). The Prisma port is still the boundary
  // that must not invent a total or a percentage when a row would lack one.
  const [record] = await w34List([w34Row({
    status: 'rendering-proxy',
    publicOperations: [w34Operation({
      type: 'project-proxy-render', progressTotal: null, progressUnit: null,
    })],
  })])
  assert.deepEqual(record.dashboard.latestOperation.progress, { completed: 1 })
  assert.equal('total' in record.dashboard.latestOperation.progress, false)
  assert.equal('percent' in record.dashboard.latestOperation.progress, false)
  const [absent] = await w34List([w34Row({
    status: 'rendering-proxy',
    publicOperations: [w34Operation({
      type: 'project-proxy-render', progressCompleted: null,
      progressTotal: null, progressUnit: null,
    })],
  })])
  assert.equal('progress' in absent.dashboard.latestOperation, false)
})

test('W34 public project-list v6 accepts real absence and rejects invented aggregate values', () => {
  const validate = addFormats(new Ajv2020({ strict: true, allErrors: true }))
    .compile(getPublicSchema('apollo://schemas/project-list/v6').schema)
  const bare = createProjectDashboardRecord({
    project: createProject({
      id: 'project-dashboard-bare', workspaceId: W34_WORKSPACE,
      name: 'w34 bare', status: 'draft',
      createdBy: { type: 'api-client', id: 'client-dashboard-1' },
      createdAt: '2026-08-06T12:00:00.000Z',
    }),
    currentVersion: null, latestOperation: null, openReviewIssueCount: 0,
    outputs: [], lastActivityAt: '2026-08-06T12:00:00.000Z',
    administrationRevision: 1, archivedFromStatus: null,
  })
  const body = {
    data: { projects: [presentProjectDashboard(bare)] },
    meta: { apiVersion: 'v1' },
  }
  assert.equal(body.data.projects[0].dashboard.currentVersion, null)
  assert.equal(body.data.projects[0].dashboard.latestOperation, null)
  assert.equal(validate(body), true, JSON.stringify(validate.errors))
  const invented = (mutate) => {
    const clone = structuredClone(body)
    mutate(clone.data.projects[0].dashboard)
    return validate(clone)
  }
  assert.equal(invented((dashboard) => {
    dashboard.currentVersion = {
      id: 'project-version-1', sequence: 0, createdAt: '2026-08-06T12:00:00.000Z',
    }
  }), false)
  assert.equal(invented((dashboard) => {
    dashboard.outputs = [{ artifactId: 'artifact-dashboard-1', aspectRatio: '2:3' }]
    dashboard.outputCount = 1
  }), false)
  assert.equal(invented((dashboard) => { dashboard.openReviewIssueCount = -1 }), false)
  assert.equal(invented((dashboard) => { delete dashboard.latestOperation }), false)
  assert.equal(invented((dashboard) => { delete dashboard.currentVersion }), false)
})

test('F1.003 a refused project administration keeps its error in the open dialog and recovers on the live revision', () => {
  assert.match(dashboardSource, /const \[quickActionError, setQuickActionError\] = useState<string \| null>\(null\)/)
  // The refusal is rendered as an alert inside the dialog, not only behind its backdrop.
  assert.match(dashboardSource, /role="alert"[^>]*data-testid="quick-action-error"|data-testid="quick-action-error"[^>]*role="alert"/)
  assert.match(dashboardSource, /\{quickActionError\}/)
  // A refusal (e.g. VERSION_CONFLICT from another client) triggers a refetch so
  // the next attempt is fenced by the revision the server holds now.
  assert.match(dashboardSource, /setQuickActionError\(error instanceof Error[\s\S]{0,200}setRefreshRevision\(\(value\) => value \+ 1\)/)
  // The dialog reads the live card row, so the retry carries the refreshed revision.
  assert.match(dashboardSource, /projects\.find\(\(item\) => item\.id === quickActionDialog\.project\.id\)/)
})
