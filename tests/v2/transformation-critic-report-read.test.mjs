import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { readTransformationCriticReportService } from '../../src/v2/application/transformation-quality.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { PUBLIC_ERROR_CATALOG } from '../../src/v2/public-api/public-error-catalog.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { presentSuccess } from '../../src/v2/public-api/presenters.ts'
import { presentTransformationCriticReport } from '../../src/v2/public-api/transformation-quality-contract.ts'

const actor = Object.freeze({
  clientId: 'client-critic-1', credentialId: 'credential-critic-1', workspaceId: 'workspace-1',
  environment: 'production', scopes: new Set(['projects:read']), authenticationKind: 'bearer',
  clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
  clientAccessStatus: 'active', workspaceAccessStatus: 'active',
  auditContext: { clientId: 'client-critic-1', credentialId: 'credential-critic-1', workspaceId: 'workspace-1',
    environment: 'production', actor: { type: 'api-client', id: 'client-critic-1' } },
})

const report = Object.freeze({
  schemaVersion: 'transformation-critic-report/v1', id: 'critic-report-1', workspaceId: 'workspace-1', projectId: 'project-1',
  briefId: 'brief-1', briefHash: 'a'.repeat(64), providerJobId: 'job-1', policyId: 'policy-1', policyHash: 'b'.repeat(64),
  sourceArtifactId: 'source-1', sourceArtifactSha256: 'c'.repeat(64), resultArtifactId: 'result-1', resultArtifactSha256: 'd'.repeat(64),
  evaluators: [{ id: 'evaluator-1', kind: 'measured', version: '1.0.0', scope: 'integrity', internalSecret: 'hidden' }],
  measurements: [{ dimension: 'media-integrity', status: 'measured', evaluatorId: 'evaluator-1', scoreBps: 9000,
    thresholdBps: 8000, frameRange: null, region: null, internalSecret: 'hidden' }],
  issues: [], hardGates: [], decision: 'approved', action: 'approve', confidenceBps: 9000, intentScoreBps: 9000,
  evaluatedAt: '2029-03-01T10:04:12.000Z', reportHash: 'e'.repeat(64), internalSecret: 'hidden',
})

test('critic report query scopes the exact persisted ID and exposes only public report fields', async () => {
  const reads = []
  const execute = readTransformationCriticReportService({ quality: { readCriticReport: async (key) => {
    reads.push(key)
    return key.workspaceId === report.workspaceId && key.projectId === report.projectId && key.reportId === report.id ? report : null
  } } })
  const selected = await execute({ workspaceId: 'workspace-1', projectId: 'project-1', reportId: 'critic-report-1', actor })
  assert.deepEqual(reads, [{ workspaceId: 'workspace-1', projectId: 'project-1', reportId: 'critic-report-1' }])
  const publicReport = presentTransformationCriticReport(selected).report
  assert.equal(publicReport.id, report.id)
  assert.equal(publicReport.reportHash, report.reportHash)
  assert.equal(publicReport.decision, report.decision)
  assert.equal(JSON.stringify(publicReport).includes('internalSecret'), false)
  await assert.rejects(execute({ workspaceId: 'workspace-1', projectId: 'project-2', reportId: 'critic-report-1', actor }),
    { code: 'ASSET_NOT_FOUND' })
  await assert.rejects(execute({ workspaceId: 'workspace-2', projectId: 'project-1', reportId: 'critic-report-1',
    actor: { ...actor, workspaceId: 'workspace-2', auditContext: { ...actor.auditContext, workspaceId: 'workspace-2' } } }),
    { code: 'ASSET_NOT_FOUND' })
  await assert.rejects(execute({ workspaceId: 'workspace-1', projectId: 'project-1', reportId: 'missing-report', actor }),
    { code: 'ASSET_NOT_FOUND' })
  await assert.rejects(execute({ workspaceId: 'workspace-2', projectId: 'project-1', reportId: 'critic-report-1', actor }),
    { code: 'AUTH_INVALID' })
  await assert.rejects(execute({ workspaceId: 'workspace-1', projectId: 'project-1', reportId: 'critic-report-1',
    actor: { ...actor, scopes: new Set() } }), { code: 'AUTH_SCOPE_REQUIRED' })
})

test('critic report GET publishes the exact read capability and a closed response contract', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.transformation-critic-reports.get')
  assert.ok(capability)
  assert.deepEqual(capability.endpoint, { method: 'GET', path: '/v1/projects/{projectId}/transformation-critic-reports/{reportId}' })
  assert.deepEqual(capability.requiredScopes, ['projects:read'])
  assert.equal(capability.costClass, 'free')
  const validate = addFormats(new Ajv2020({ strict: true, allErrors: true }))
    .compile(getPublicSchema(capability.outputSchemaRef).schema)
  const response = presentSuccess(presentTransformationCriticReport(report))
  assert.equal(validate(response), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...response, data: { report: {} } }), false)
  assert.equal(validate({ ...response, data: { report: { ...response.data.report, internalSecret: 'hidden' } } }), false)
})

test('critic report access errors retain the published HTTP classification', () => {
  assert.equal(PUBLIC_ERROR_CATALOG.ASSET_NOT_FOUND.status, 422)
  assert.equal(PUBLIC_ERROR_CATALOG.INVALID_ARGUMENT.status, 422)
  assert.equal(PUBLIC_ERROR_CATALOG.AUTH_INVALID.status, 401)
})
