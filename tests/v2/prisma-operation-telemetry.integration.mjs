import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { PrismaOperationTelemetryRepository } from '../../src/v2/infrastructure/prisma/operation-telemetry-repository.ts'

test('operation telemetry persists idempotently and summarizes only the requested workspace and window', async () => {
  const client = new PrismaClient()
  const repository = new PrismaOperationTelemetryRepository(client)
  const workspaceId = 'telemetry-integration-workspace'
  const otherWorkspaceId = 'telemetry-integration-other'
  const cleanup = async () => {
    await client.v2OperationTelemetryAlert.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await client.v2OperationTelemetryEvent.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await client.v2Workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
  }
  const lifecycle = {
    schemaVersion: 'public-operation-telemetry/v1', event: 'operation.failed', occurredAt: '2026-08-02T10:00:00.000Z',
    traceId: 'trace-telemetry-integration', jobId: 'job-telemetry-integration', workspaceId,
    operationType: 'project-proxy-render', status: 'failed', phase: 'failed', attempt: 2,
    queueWaitMs: 15, runDurationMs: 120,
  }
  const span = {
    schemaVersion: 'public-operation-span-telemetry/v1', event: 'operation.span-succeeded', occurredAt: '2026-08-02T10:00:01.000Z',
    traceId: 'trace-telemetry-integration', spanId: 'span-telemetry-integration', jobId: 'job-telemetry-integration', workspaceId,
    operationType: 'project-proxy-render', attempt: 2, spanKind: 'renderer', spanName: 'ffmpeg-editorial-proxy',
    durationMs: 100, inputBytes: 1000, outputBytes: 500, costMinorUnits: 7,
  }
  const alert = {
    schemaVersion: 'public-operation-alert/v1', event: 'operation.alert-triggered', occurredAt: lifecycle.occurredAt,
    alertKind: 'operation-failed', severity: 'critical', traceId: lifecycle.traceId, jobId: lifecycle.jobId,
    workspaceId, operationType: lifecycle.operationType, observed: 1, threshold: 1,
  }
  try {
    await cleanup()
    await client.v2Workspace.createMany({ data: [
      { id: workspaceId, slug: 'telemetry-integration', name: 'Telemetry Integration' },
      { id: otherWorkspaceId, slug: 'telemetry-integration-other', name: 'Telemetry Integration Other' },
    ] })
    await repository.recordEvent(lifecycle)
    await repository.recordEvent(lifecycle)
    await repository.recordEvent(span)
    await repository.recordAlert(alert)
    await repository.recordAlert(alert)
    await repository.recordEvent({ ...lifecycle, workspaceId: otherWorkspaceId, jobId: 'job-other' })
    const summary = await repository.summarize({ workspaceId, from: '2026-08-02T09:00:00.000Z', to: '2026-08-02T11:00:00.000Z' })
    assert.deepEqual(summary.events, { total: 2, created: 0, succeeded: 0, failed: 1, canceled: 0, spansSucceeded: 1, spansFailed: 0 })
    assert.deepEqual(summary.alerts, { total: 1, warning: 0, critical: 1, operationFailed: 1, queueWaitHigh: 0, runDurationHigh: 0, spanDurationHigh: 0, costHigh: 0 })
    assert.deepEqual(summary.metrics.queueWaitMs, { sampleCount: 1, total: '15', maximum: '15' })
    assert.deepEqual(summary.metrics.outputBytes, { sampleCount: 1, total: '500', maximum: '500' })
    assert.deepEqual(summary.metrics.costMinorUnits, { sampleCount: 1, total: '7', maximum: '7' })
    assert.equal(await client.v2OperationTelemetryEvent.count({ where: { workspaceId } }), 2)
    assert.equal(await client.v2OperationTelemetryAlert.count({ where: { workspaceId } }), 1)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
