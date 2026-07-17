import assert from 'node:assert/strict'
import test from 'node:test'
import { enforceOperationalSafetyService, environmentKillSwitch } from '../../src/v2/application/operational-safety.ts'

test('anomalies emit bounded alerts and kill switch blocks before execution', async () => {
  const alerts = []
  const enforce = enforceOperationalSafetyService({ alerts: { async emit(alert) { alerts.push(alert) } }, killSwitch: environmentKillSwitch({}) })
  assert.deepEqual(await enforce({ workspaceId: 'workspace-1', clientId: 'client-1', metric: 'spend-spike', observed: 101, threshold: 100 }), { allowed: false, anomalous: true })
  assert.equal(alerts[0].code, 'SPEND_SPIKE')
  const killed = enforceOperationalSafetyService({ alerts: { async emit() {} }, killSwitch: environmentKillSwitch({ APOLLO_OPERATIONAL_KILL_SWITCH: 'true' }) })
  await assert.rejects(() => killed({ workspaceId: 'workspace-1', clientId: 'client-1', metric: 'error-rate', observed: 0, threshold: 1 }), /kill switch/)
})
