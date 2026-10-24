import assert from 'node:assert/strict'
import test from 'node:test'

import { confirmSpeechRemovalService } from '../../src/v2/application/confirm-speech-removal.ts'
import { speechRemovalRuleId } from '../../src/v2/application/speech-removal-proposal.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { FOUNDATION_AGENT_TOOL_SAFETY, agentToolSafetyFor, requireAgentToolExecutionGate } from '../../src/v2/public-api/agent-tool-safety.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'

/**
 * ADR-160. The confirmation of a cut the Apollo proposed is a capability of its own, with human approval for agents; the caller names the SUBJECT and the Apollo
 * proposes the words, so a caller can neither confirm in the owner's place through the general Command nor dress another cut up as a confirmation.
 */
const transcript = createMediaTranscript({
  language: 'pt', text: 'um sorteio hoje. depois o conteúdo.', provider: 'controlled', model: 'stub/v1',
  words: [{ word: 'um', start: 0, end: 0.3 }, { word: 'sorteio', start: 0.4, end: 1 }, { word: 'hoje.', start: 1.1, end: 1.5 }, { word: 'depois', start: 2, end: 2.4 }, { word: 'o', start: 2.5, end: 2.6 }, { word: 'conteúdo.', start: 2.7, end: 3.4 }],
  segments: [{ id: 0, text: 'um sorteio hoje.', start: 0, end: 1.5 }, { id: 1, text: 'depois o conteúdo.', start: 2, end: 3.4 }],
})
const directive = (subject) => ({ id: 'cut', kind: 'remove-speech', value: 'about', param: subject })
const current = (directives, version = 'version-1') => ({
  version: { id: version }, objective: 'discovery',
  briefSnapshot: { id: 'snapshot-1', contentHash: 'a'.repeat(64), content: {
    schemaVersion: 1, objective: 'discovery', desiredAction: createDesiredAction({ objective: 'discovery' }), productionBrief: createProductionBrief({ ownerText: 'texto' }),
    editorialRequest: { directives },
  } },
})
const request = (overrides = {}) => ({
  workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'version-1', baseHash: 'b'.repeat(64), sourceTranscriptId: 'transcript-1', variantId: 'variant-1',
  subject: 'sorteio', actor: { clientId: 'client-1' }, idempotency: { clientId: 'client-1', key: 'confirm-cut-1' }, ...overrides,
})
function world(directives = [directive('sorteio')], version = 'version-1') {
  const applied = []
  const service = confirmSpeechRemovalService({
    requests: { async readCurrent() { return current(directives, version) } },
    cuts: { async readContext() { return { transcript } } },
    clock: () => new Date(), createId: (kind) => kind, createEventId: () => 'event',
    apply: () => async (input) => { applied.push(input); return { applied: true } },
  })
  return { service, applied }
}

test('the cut that is applied is the Apollo\'s proposal for the subject: its id, its words, the transcript it was searched in', async () => {
  const { service, applied } = world()
  await service(request({ reason: ' conferido ' }))
  assert.equal(applied.length, 1)
  assert.deepEqual(applied[0].rules, [{ id: speechRemovalRuleId('sorteio'), label: 'sorteio', alternatives: ['sorteio'] }])
  assert.equal(applied[0].reason, 'conferido')
  assert.equal(applied[0].sourceTranscriptId, 'transcript-1')
  assert.equal(applied[0].variantId, 'variant-1')
})

test('nothing is applied for a subject the request does not ask to cut, one the speech does not say, an unsearchable one, or a base that moved', async () => {
  for (const [label, run, expected] of [
    ['not asked', () => world().service(request({ subject: 'conteúdo' })), 'INVALID_ARGUMENT'],
    ['the subject is the caller\'s words', () => world().service(request({ subject: 'Sorteio' })), 'INVALID_ARGUMENT'],
    ['empty', () => world().service(request({ subject: '  ' })), 'INVALID_ARGUMENT'],
    ['not in the speech', () => world([directive('garantia')]).service(request({ subject: 'garantia' })), 'INVALID_COMMAND'],
    ['too long to search', () => world([directive('a b c d e f g h i j k l m n o p q')]).service(request({ subject: 'a b c d e f g h i j k l m n o p q' })), 'INVALID_COMMAND'],
    ['the base moved', () => world([directive('sorteio')], 'version-2').service(request()), 'VERSION_CONFLICT'],
  ]) {
    await assert.rejects(run(), (error) => error.code === expected, label)
  }
  const { service, applied } = world()
  await assert.rejects(service(request({ subject: 'conteúdo' })))
  assert.deepEqual(applied, [])
  // A request for one output of the project is a request of the project: the subject is found there too.
  const overridden = confirmSpeechRemovalService({
    requests: { async readCurrent() { const value = current([]); value.briefSnapshot.content.editorialRequest = { variantOverrides: { 'variant-1': [directive('sorteio')] } }; return value } },
    cuts: { async readContext() { return { transcript } } }, clock: () => new Date(), createId: (kind) => kind, createEventId: () => 'event',
    apply: () => async (input) => input,
  })
  assert.equal((await overridden(request())).rules[0].alternatives[0], 'sorteio')
})

test('the capability needs human approval for an agent: the general Command does not carry the cut, and the proposal read from a refusal is not enough', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.speech-removals.confirm')
  assert.equal(capability.confirmation, 'human-approval')
  assert.equal(capability.operationKind, 'command')
  assert.equal(capability.idempotency, 'required')
  assert.deepEqual(capability.requiredScopes, ['projects:write'])
  assert.deepEqual(capability.endpoint, { method: 'POST', path: '/v1/projects/{projectId}/speech-removals' })
  assert.equal(capability.toolName, 'apollo.projects.speech-removals.confirm')
  assert.equal(capability.inputSchemaRef, 'apollo://schemas/confirm-speech-removal-request/v1')
  const rule = agentToolSafetyFor(capability, FOUNDATION_AGENT_TOOL_SAFETY)
  assert.equal(rule.confirmation, 'human-approval')
  const fingerprint = 'c'.repeat(64)
  const now = new Date('2026-10-23T12:00:00.000Z')
  assert.throws(() => requireAgentToolExecutionGate(capability, rule, fingerprint, undefined, now), (error) => error.code === 'TOOL_CONFIRMATION_REQUIRED')
  assert.doesNotThrow(() => requireAgentToolExecutionGate(capability, rule, fingerprint, {
    kind: 'human-approval', capabilityId: capability.id, inputFingerprint: fingerprint, issuedAt: '2026-10-23T11:59:00.000Z', expiresAt: '2026-10-23T12:05:00.000Z',
  }, now))
  // The body carries the subject and the transcript, never rules.
  const schema = getPublicSchema('apollo://schemas/confirm-speech-removal-request/v1').schema
  assert.equal(schema.additionalProperties, false)
  assert.equal('rules' in schema.properties, false)
  assert.ok(publicSchemaExamples(getPublicSchema('apollo://schemas/confirm-speech-removal-request/v1')).length >= 1)
})
