import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AlertingOperationTelemetry,
  evaluateOperationTelemetryAlerts,
  operationAlertThresholdsFromEnvironment,
} from '../../src/v2/infrastructure/alerting-operation-telemetry.ts'

const common = {
  occurredAt: '2026-08-02T20:00:00.000Z', traceId: 'trace-alert-test',
  jobId: 'operation-alert-test', workspaceId: 'workspace-alert-test',
  projectId: 'project-alert-test', operationType: 'project-proxy-render',
}

test('alert policy is deterministic, bounded and excludes operation payloads', () => {
  const thresholds = { queueWaitMs: 100, runDurationMs: 200, spanDurationMs: 300, costMinorUnits: 400 }
  const lifecycle = {
    ...common, schemaVersion: 'public-operation-telemetry/v1', event: 'operation.failed',
    status: 'failed', phase: 'failed', attempt: 2, queueWaitMs: 100, runDurationMs: 201,
  }
  const alerts = evaluateOperationTelemetryAlerts(lifecycle, thresholds)
  assert.deepEqual(alerts.map((alert) => alert.alertKind), ['operation-failed', 'queue-wait-high', 'run-duration-high'])
  assert.equal(alerts.every(Object.isFrozen), true)
  assert.equal(JSON.stringify(alerts).includes('payload'), false)

  const span = {
    ...common, schemaVersion: 'public-operation-span-telemetry/v1', event: 'operation.span-succeeded',
    spanId: 'span-alert-test', attempt: 2, spanKind: 'provider', spanName: 'long-form-transcript',
    durationMs: 300, costMinorUnits: 401,
  }
  assert.deepEqual(evaluateOperationTelemetryAlerts(span, thresholds).map((alert) => alert.alertKind), ['span-duration-high', 'cost-high'])
})

test('configured thresholds fail closed and alert delivery cannot alter telemetry', async () => {
  assert.throws(() => operationAlertThresholdsFromEnvironment({ APOLLO_V2_ALERT_COST_MINOR_UNITS: '0' }), /invalid/)
  const forwarded = []
  const alerts = []
  const telemetry = new AlertingOperationTelemetry(
    { emit(event) { forwarded.push(event) } },
    { queueWaitMs: 1, runDurationMs: 1, spanDurationMs: 1, costMinorUnits: 1 },
    { error(message) { alerts.push(JSON.parse(message)) } },
  )
  const event = {
    ...common, schemaVersion: 'public-operation-span-telemetry/v1', event: 'operation.span-succeeded',
    spanId: 'span-alert-test', attempt: 1, spanKind: 'renderer', spanName: 'ffmpeg-editorial-proxy',
    durationMs: 10,
  }
  await telemetry.emit(event)
  assert.equal(forwarded[0], event)
  assert.equal(alerts[0].alertKind, 'span-duration-high')
  await new AlertingOperationTelemetry(
    { emit() { throw new Error('collector down') } },
    { queueWaitMs: 1, runDurationMs: 1, spanDurationMs: 1, costMinorUnits: 1 },
    { error() { throw new Error('alert sink down') } },
  ).emit(event)
})
