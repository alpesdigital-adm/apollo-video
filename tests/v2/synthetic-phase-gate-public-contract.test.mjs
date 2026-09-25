import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateSyntheticPhaseGateRecordHash } from '../../src/v2/application/run-synthetic-phase-gate.ts'
import {
  SYNTHETIC_PHASE_GATE_CRITERIA,
  SYNTHETIC_PHASE_GATE_CRITERION_CHECKS,
  SYNTHETIC_PHASE_GATE_EVIDENCE_TYPES,
  evaluateSyntheticPhaseGate,
} from '../../src/v2/domain/synthetic-phase-gate.ts'
import { FOUNDATION_AGENT_TOOL_SAFETY } from '../../src/v2/public-api/agent-tool-safety.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import {
  SYNTHETIC_PHASE_GATE_CHECK_CODES,
  parseRunSyntheticPhaseGateBody,
  presentSyntheticPhaseGate,
} from '../../src/v2/public-api/synthetic-phase-gate-contract.ts'

const digest = (character) => character.repeat(64)
const versionIdentity = {
  projectVersionId: 'project-version-synthetic-gate-1',
  projectVersionHash: digest('a'),
}

function capability(id) {
  const found = FOUNDATION_CAPABILITIES.find((entry) => entry.id === id)
  assert.ok(found, `${id} must be registered`)
  return found
}

function rejectsBody(body, fragment) {
  assert.throws(
    () => parseRunSyntheticPhaseGateBody(body),
    (error) => error.code === 'INVALID_ARGUMENT' && (
      error.message.includes(fragment) ||
      JSON.stringify(error.details ?? {}).includes(fragment)
    ),
  )
}

test('T-F3-GATE public run/list contracts expose only version identity and server results', () => {
  const run = capability('apollo.projects.synthetic-phase-gates.run')
  assert.equal(run.endpoint.method, 'POST')
  assert.equal(run.endpoint.path, '/v1/projects/{projectId}/synthetic-phase-gates')
  assert.deepEqual([...run.requiredScopes], ['projects:write'])
  assert.deepEqual([...run.successStatuses], [200, 201])
  assert.equal(run.idempotency, 'required')
  assert.equal(run.requestBodyRequired, true)
  assert.equal(FOUNDATION_AGENT_TOOL_SAFETY[run.toolName].confirmation, 'none')

  const list = capability('apollo.projects.synthetic-phase-gates.list')
  assert.equal(list.endpoint.method, 'GET')
  assert.equal(list.endpoint.path, run.endpoint.path)
  assert.deepEqual([...list.requiredScopes], ['projects:read'])
  assert.deepEqual([...list.successStatuses], [200])
  assert.deepEqual(list.queryParameters, [{
    name: 'limit',
    description: 'Maximum evaluations to return, newest first.',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  }])

  const requestSchema = getPublicSchema(run.inputSchemaRef).schema
  assert.equal(requestSchema.additionalProperties, false)
  assert.deepEqual(requestSchema.required, ['projectVersionId', 'projectVersionHash'])
  assert.deepEqual(Object.keys(requestSchema.properties), ['projectVersionId', 'projectVersionHash'])
  assert.deepEqual(parseRunSyntheticPhaseGateBody(versionIdentity), versionIdentity)

  for (const field of ['evidence', 'approved', 'missing', 'failed', 'report', 'actor']) {
    rejectsBody({ ...versionIdentity, [field]: true }, field)
  }
  rejectsBody({ projectVersionId: versionIdentity.projectVersionId }, 'projectVersionHash')
  rejectsBody({ ...versionIdentity, projectVersionHash: 'not-a-hash' }, 'projectVersionHash')
})

test('T-F3-GATE public schemas are closed over the domain enums and missing evidence model', () => {
  const runSchema = getPublicSchema('apollo://schemas/synthetic-phase-gate-run/v1').schema
  const gateSchema = runSchema.properties.data.properties.gate
  const reportSchema = gateSchema.properties.report
  const criterionSchema = reportSchema.properties.evidence.items
  const checkSchema = criterionSchema.properties.checks.items
  const referenceSchema = checkSchema.properties.references.items

  assert.deepEqual(reportSchema.properties.missing.items.enum, [...SYNTHETIC_PHASE_GATE_CRITERIA])
  assert.deepEqual(reportSchema.properties.failed.items.enum, [...SYNTHETIC_PHASE_GATE_CRITERIA])
  assert.deepEqual(criterionSchema.properties.criterion.enum, [...SYNTHETIC_PHASE_GATE_CRITERIA])
  assert.deepEqual(checkSchema.properties.code.enum, [...SYNTHETIC_PHASE_GATE_CHECK_CODES])
  assert.deepEqual(
    checkSchema.properties.missingEvidenceTypes.items.enum,
    [...SYNTHETIC_PHASE_GATE_EVIDENCE_TYPES],
  )
  assert.deepEqual(referenceSchema.properties.type.enum, [...SYNTHETIC_PHASE_GATE_EVIDENCE_TYPES])
  assert.equal(reportSchema.properties.total.const, SYNTHETIC_PHASE_GATE_CRITERIA.length)
  assert.equal(gateSchema.additionalProperties, false)
  assert.equal(reportSchema.additionalProperties, false)
  assert.equal(criterionSchema.additionalProperties, false)
  assert.equal(checkSchema.additionalProperties, false)

  const expectedChecks = new Set(Object.values(SYNTHETIC_PHASE_GATE_CRITERION_CHECKS).flat())
  assert.deepEqual(new Set(SYNTHETIC_PHASE_GATE_CHECK_CODES), expectedChecks)
})

test('T-F3-GATE presenter preserves incomplete diagnostics and withholds replay secrets', () => {
  const report = evaluateSyntheticPhaseGate({
    workspaceId: 'workspace-synthetic-gate-contract',
    projectId: 'project-synthetic-gate-contract',
    ...versionIdentity,
    evidence: [{
      criterion: 'F3-GATE-001',
      checks: [{
        code: 'elevenlabs-audio-alignment-live',
        passed: true,
        references: [{ type: 'provider-job', id: 'provider-job-contract-1', hash: digest('b') }],
      }],
    }],
    evaluatedAt: '2026-09-23T12:00:00.000Z',
  })
  const content = {
    schemaVersion: 'synthetic-phase-gate/v1',
    id: 'synthetic-phase-gate-contract-1',
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    projectVersionId: report.projectVersionId,
    projectVersionHash: report.projectVersionHash,
    report,
    reportFingerprint: report.fingerprint,
    idempotencyKey: 'synthetic-gate-contract-key',
    requestFingerprint: digest('c'),
    createdBy: { type: 'api-client', id: 'client-synthetic-gate-contract' },
    createdAt: report.evaluatedAt,
  }
  const presented = presentSyntheticPhaseGate({
    ...content,
    recordHash: calculateSyntheticPhaseGateRecordHash(content),
  })

  assert.equal(presented.report.approved, false)
  assert.deepEqual(presented.report.missing, ['F3-GATE-002', 'F3-GATE-003', 'F3-GATE-004'])
  assert.deepEqual(presented.report.evidence[0].missingChecks, [
    'heygen-generated-audio-avatar-live',
    'heygen-ready-audio-avatar-live',
  ])
  assert.deepEqual(presented.report.evidence[0].checks[0].missingEvidenceTypes, [
    'provider-result-artifact',
    'alignment-artifact',
  ])
  assert.equal('idempotencyKey' in presented, false)
  assert.equal('requestFingerprint' in presented, false)
  assert.equal('status' in presented, false)
  assert.equal('status' in presented.report, false)
})
