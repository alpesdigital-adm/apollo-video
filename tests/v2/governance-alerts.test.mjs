import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { listGovernanceAlertsService } from '../../src/v2/application/list-governance-alerts.ts'
import { createGovernanceAlert } from '../../src/v2/domain/governance-alert.ts'

function actor(workspaceId = 'workspace-alerts', scopes = ['clients:admin']) {
  const auditContext = createExternalAuditContext({
    clientId: 'admin-client', credentialId: 'admin-credential',
    workspaceId, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(scopes), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function anomalyAlert(alertHash) {
  return createGovernanceAlert({
    schemaVersion: 'governance-alert/v2',
    alertHash,
    workspaceId: 'workspace-alerts',
    clientId: 'client-alerts',
    admissionId: 'governance-admission-alerts',
    admissionHash: '1'.repeat(64),
    scopeType: 'workspace',
    reasonCode: 'ERROR_RATE_ANOMALY',
    observed: 6000,
    threshold: 5000,
    policyHash: '2'.repeat(64),
    anomalyRecoveryBypassed: false,
    windowStartedAt: '2026-08-06T11:55:00.000Z',
    windowEndedAt: '2026-08-06T12:00:00.000Z',
    createdAt: '2026-08-06T12:00:00.000Z',
  })
}

test('F0.103 governance alert is content-addressed and rejects tampering', () => {
  const alert = createGovernanceAlert({
    schemaVersion: 'governance-alert/v2',
    workspaceId: 'workspace-alerts',
    clientId: 'client-alerts',
    admissionId: 'governance-admission-alerts',
    admissionHash: '1'.repeat(64),
    scopeType: 'workspace',
    reasonCode: 'ERROR_RATE_ANOMALY',
    observed: 6000,
    threshold: 5000,
    policyHash: '2'.repeat(64),
    anomalyRecoveryBypassed: false,
    windowStartedAt: '2026-08-06T11:55:00.000Z',
    windowEndedAt: '2026-08-06T12:00:00.000Z',
    createdAt: '2026-08-06T12:00:00.000Z',
  })
  assert.match(alert.alertHash, /^[a-f0-9]{64}$/)
  assert.throws(
    () => anomalyAlert('0'.repeat(64)),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => createGovernanceAlert({
      workspaceId: 'workspace-alerts', clientId: 'client-alerts',
      admissionId: 'governance-admission-alerts',
      admissionHash: '1'.repeat(64), scopeType: 'workspace',
      reasonCode: 'RATE_LIMIT', observed: 2, threshold: 1,
      createdAt: 'not-an-instant',
    }),
    (error) => error?.code === 'INVALID_ARGUMENT',
  )
})

test('F0.103 administrative alert query is workspace-bound, redacted and paginated', async () => {
  const firstAlert = createGovernanceAlert({
    schemaVersion: 'governance-alert/v2',
    workspaceId: 'workspace-alerts', clientId: 'client-alerts',
    admissionId: 'governance-admission-alerts-2',
    admissionHash: '3'.repeat(64), scopeType: 'client',
    reasonCode: 'REQUEST_RATE_ANOMALY', observed: 21, threshold: 20,
    policyHash: '2'.repeat(64), anomalyRecoveryBypassed: true,
    windowStartedAt: '2026-08-06T12:00:00.000Z',
    windowEndedAt: '2026-08-06T12:01:00.000Z',
    createdAt: '2026-08-06T12:01:00.000Z',
  })
  const secondAlert = createGovernanceAlert({
    workspaceId: 'workspace-alerts', clientId: 'client-alerts',
    admissionId: 'governance-admission-alerts-1',
    admissionHash: '4'.repeat(64), scopeType: 'workspace',
    reasonCode: 'RATE_LIMIT', observed: 101, threshold: 100,
    createdAt: '2026-08-06T12:00:00.000Z',
  })
  const rows = [firstAlert, secondAlert]
  const repository = {
    async listAlerts(input) {
      const start = input.after
        ? rows.findIndex((item) => item.alertHash === input.after.alertHash) + 1
        : 0
      return rows.slice(start, start + input.limit)
    },
  }
  const list = listGovernanceAlertsService({ repository })
  const first = await list({
    actor: actor(), workspaceId: 'workspace-alerts', limit: 1,
  })
  assert.equal(first.entries[0].reasonCode, 'REQUEST_RATE_ANOMALY')
  assert.equal(first.entries[0].anomalyRecoveryBypassed, true)
  assert.equal('admissionHash' in first.entries[0], false)
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/)
  const second = await list({
    actor: actor(), workspaceId: 'workspace-alerts', limit: 1,
    after: first.nextCursor,
  })
  assert.equal(second.entries[0].reasonCode, 'RATE_LIMIT')
  assert.equal(second.entries[0].anomalyRecoveryBypassed, false)
  assert.equal('nextCursor' in second, false)
  await assert.rejects(
    list({ actor: actor('workspace-other'), workspaceId: 'workspace-alerts' }),
    /Workspace was not found/,
  )
})
