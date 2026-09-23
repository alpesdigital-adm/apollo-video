import assert from 'node:assert/strict'
import test from 'node:test'

import { FOUNDATION_AGENT_TOOL_SAFETY } from '../../src/v2/public-api/agent-tool-safety.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import {
  parseCreateSyntheticProductionRenderOperationBody,
  presentSyntheticProductionRenderOperation,
} from '../../src/v2/public-api/synthetic-production-contract.ts'

const digest = (character) => character.repeat(64)

test('synthetic production render accepts only output kind and aspect ratio', () => {
  const body = { output: { kind: 'final', aspectRatio: '9:16' } }
  assert.deepEqual(parseCreateSyntheticProductionRenderOperationBody(body), body)
  for (const raw of [
    { ...body, renderInputHash: digest('a') },
    { ...body, artifactId: 'artifact-caller' },
    { ...body, approved: true },
    { output: { ...body.output, manifestId: 'manifest-caller' } },
    { output: { kind: 'mp4', aspectRatio: '9:16' } },
    { output: { kind: 'final', aspectRatio: '3:2' } },
  ]) {
    assert.throws(
      () => parseCreateSyntheticProductionRenderOperationBody(raw),
      (error) => error?.code === 'INVALID_ARGUMENT',
    )
  }
})

test('synthetic production render capability is an idempotent project write job', () => {
  const capability = FOUNDATION_CAPABILITIES.find((entry) =>
    entry.id === 'apollo.projects.synthetic-production-runs.render-operations.create')
  assert.ok(capability)
  assert.equal(capability.endpoint.method, 'POST')
  assert.equal(capability.endpoint.path, '/v1/projects/{projectId}/synthetic-production-runs/{runId}/render-operations')
  assert.deepEqual([...capability.requiredScopes], ['projects:write'])
  assert.deepEqual([...capability.successStatuses], [200, 202])
  assert.equal(capability.idempotency, 'required')
  assert.equal(capability.requestBodyRequired, true)
  assert.equal(FOUNDATION_AGENT_TOOL_SAFETY[capability.id].confirmation, 'none')

  const request = getPublicSchema(capability.inputSchemaRef).schema
  assert.equal(request.additionalProperties, false)
  assert.deepEqual(request.required, ['output'])
  assert.equal(request.properties.output.additionalProperties, false)
  assert.deepEqual(request.properties.output.required, ['kind', 'aspectRatio'])
  const response = getPublicSchema(capability.outputSchemaRef).schema.properties.data
  assert.equal(response.additionalProperties, false)
  assert.deepEqual(response.required, ['operation', 'render', 'replayed'])
  assert.equal(response.properties.render.additionalProperties, false)
})

test('render presenter publishes reserved identity without unpersisted terminal evidence', () => {
  const createdAt = '2029-09-01T10:00:00.000Z'
  const operation = {
    schemaVersion: 'public-operation/v1',
    id: 'operation-synthetic-render-contract',
    workspaceId: 'workspace-synthetic-render-contract',
    projectId: 'project-synthetic-render-contract',
    clientId: 'client-synthetic-render-contract',
    type: 'synthetic-production-render',
    status: 'queued',
    phase: 'queued',
    progress: { completed: 0, total: 4, unit: 'render' },
    cancelable: true,
    retryable: false,
    target: {
      type: 'project-version',
      id: 'project-version-synthetic-render-contract',
    },
    attempt: 0,
    maxAttempts: 3,
    createdAt,
    updatedAt: createdAt,
  }
  const presented = presentSyntheticProductionRenderOperation({
    operation,
    render: {
      runId: 'synthetic-run-contract',
      projectVersionId: 'project-version-synthetic-render-contract',
      editPlanSnapshotId: 'snapshot-synthetic-render-contract',
      renderInputHash: digest('b'),
      outputArtifactId: 'artifact-synthetic-render-contract',
      outputManifestId: 'manifest-synthetic-render-contract',
    },
    replayed: false,
  })
  assert.equal(presented.operation.type, 'synthetic-production-render')
  assert.equal(presented.operation.visibleState.label, 'queued')
  assert.equal(presented.render.outputArtifactId, 'artifact-synthetic-render-contract')
  for (const field of ['manifestHash', 'technicalReport', 'attestation', 'checkpoint', 'outputSha256']) {
    assert.equal(field in presented.render, false)
  }
})
