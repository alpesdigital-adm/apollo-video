import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { confirmSpeechRemovalService } from '../../src/v2/application/confirm-speech-removal.ts'
import { defineEditorialPhraseRules } from '../../src/v2/application/editorial-phrase-rules.ts'
import { proposeSpeechRemoval, speechRemovalRuleId } from '../../src/v2/application/speech-removal-proposal.ts'
import { API_SCOPE_MATRIX } from '../../src/v2/domain/api-client.ts'
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
function actorOf(kind, scopes) {
  const auditContext = createExternalAuditContext({ clientId: 'client-1', credentialId: 'credential-1', workspaceId: 'workspace-1', environment: 'production' })
  return Object.freeze({
    ...auditContext, scopes: new Set(scopes), authenticationKind: kind, clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}
/** A person on a screen: the user session. */
const UI_ACTOR = actorOf('ui-session', ['projects:write'])
/** A client the owner granted the confirmation to (the REST API key, or the key an MCP adapter calls with after the human approval of the tool). */
const GRANTED_ACTOR = actorOf('bearer', ['projects:write', 'speech-removals:confirm'])
/** A client that can write to the project and was never granted the confirmation. */
const UNGRANTED_ACTOR = actorOf('bearer', ['projects:write'])
const request = (overrides = {}) => ({
  workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'version-1', baseHash: 'b'.repeat(64), sourceTranscriptId: 'transcript-1', variantId: 'variant-1',
  subject: 'sorteio', proposalHash: proposeSpeechRemoval('sorteio', transcript).proposalHash, actor: UI_ACTOR, idempotency: { clientId: 'client-1', key: 'confirm-cut-1' }, ...overrides,
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
  // Without an adjustment the passage is the proposed one, and the Command records the bounds that were cut and that they were not moved.
  assert.equal(applied[0].confirmation.subject, 'sorteio')
  assert.equal(applied[0].confirmation.medium, 'ui-session')
  assert.equal(applied[0].confirmation.passages.length, 1)
  assert.deepEqual({ ...applied[0].confirmation.passages[0], id: undefined }, { id: undefined, startSeconds: 0, endSeconds: 1.5, proposedStartSeconds: 0, proposedEndSeconds: 1.5, adjusted: false })
  assert.deepEqual(applied[0].exclusionOverrides.map(({ sourceStartSeconds, sourceEndSeconds, ruleIds }) => ({ sourceStartSeconds, sourceEndSeconds, ruleIds })), [{ sourceStartSeconds: 0, sourceEndSeconds: 1.5, ruleIds: [speechRemovalRuleId('sorteio')] }])
  assert.equal(applied[0].actor, UI_ACTOR, 'the actor of the audit is the one who confirmed')
})

test('the media that confirm: the screen session and the granted client key (REST, or MCP behind the human approval of the tool) - each one recorded; an ungranted client is refused', async () => {
  for (const [label, actor, medium] of [['screen', UI_ACTOR, 'ui-session'], ['key with the scope', GRANTED_ACTOR, 'api-key-scope']]) {
    const { service, applied } = world()
    await service(request({ actor }))
    assert.deepEqual(applied.map((item) => [item.confirmation.subject, item.confirmation.medium]), [['sorteio', medium]], label)
  }
  const { service, applied } = world()
  await assert.rejects(service(request({ actor: UNGRANTED_ACTOR })), (error) => error.code === 'AUTH_SCOPE_REQUIRED' && error.details.requiredScope === 'speech-removals:confirm')
  const noWrite = actorOf('bearer', ['speech-removals:confirm'])
  await assert.rejects(service(request({ actor: noWrite })), (error) => error.code === 'AUTH_SCOPE_REQUIRED' && error.details.requiredScope === 'projects:write')
  assert.deepEqual(applied, [], 'nothing was applied for the ungranted')
  assert.ok(API_SCOPE_MATRIX['speech-removals'].includes('confirm'))
})

test('the general Command never carries the confirmation: a cut sent through it is a valid cut, and the proposal it matches is still asked', () => {
  const proposal = proposeSpeechRemoval('sorteio', transcript, { sourceTranscriptId: 'transcript-1' })
  const rule = () => defineEditorialPhraseRules([{ id: proposal.ruleId, label: proposal.label, alternatives: [...proposal.alternatives] }])[0]
  const ask = (requested) => proposeSpeechRemoval('sorteio', transcript, { sourceTranscriptId: 'transcript-1', requested }).confirmed
  assert.equal(ask([rule()]), undefined, 'the id and the words of a proposal are computable, so they prove nothing')
  assert.equal(ask([{ ...rule(), confirmation: { subject: 'sorteio', medium: 'ui-session' } }]), true)
  assert.equal(ask([{ ...rule(), confirmation: { subject: 'outro', medium: 'ui-session' } }]), undefined, 'a confirmation answers the subject it was given for')
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
    cuts: { async readContext() { return { transcript, parent: { state: { document: { entries: [{ variantId: 'variant-1' }] } } } } } }, clock: () => new Date(), createId: (kind) => kind, createEventId: () => 'event',
    apply: () => async (input) => input,
  })
  assert.equal((await overridden(request())).rules[0].alternatives[0], 'sorteio')
})

test('a cut asked for one output among several is refused: the cut takes the stretches out of the video every output plays', async () => {
  const build = (variantIds, editorialRequest) => {
    const applied = []
    const service = confirmSpeechRemovalService({
      requests: { async readCurrent() { const value = current([]); value.briefSnapshot.content.editorialRequest = editorialRequest; return value } },
      cuts: { async readContext() { return { transcript, parent: { state: { document: { entries: variantIds.map((variantId) => ({ variantId })) } } } } } },
      clock: () => new Date(), createId: (kind) => kind, createEventId: () => 'event',
      apply: () => async (input) => { applied.push(input); return { applied: true } },
    })
    return { service, applied }
  }
  const forOne = { variantOverrides: { 'variant-vertical': [directive('sorteio')] } }
  const several = build(['variant-vertical', 'variant-horizontal'], forOne)
  await assert.rejects(several.service(request({ variantId: 'variant-horizontal' })), (error) => error.code === 'INVALID_COMMAND' && /one output of several/.test(error.message))
  assert.deepEqual(several.applied, [])
  const only = build(['variant-vertical'], forOne)
  await only.service(request({ variantId: 'variant-vertical' }))
  assert.equal(only.applied.length, 1, 'the only output of the project is the plan')
  const forAll = build(['variant-vertical', 'variant-horizontal'], { directives: [directive('sorteio')] })
  await forAll.service(request({ variantId: 'variant-vertical' }))
  assert.equal(forAll.applied.length, 1, 'a request for the whole project cuts the video every output plays')
})

test('the capability needs human approval for an agent: the general Command does not carry the cut, and the proposal read from a refusal is not enough', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.speech-removals.confirm')
  assert.equal(capability.confirmation, 'human-approval')
  assert.equal(capability.operationKind, 'command')
  assert.equal(capability.idempotency, 'required')
  // The gateway admits whoever may write; the scope that proves a granted client is enforced by the service, which exempts the user session (a person).
  assert.deepEqual(capability.requiredScopes, ['projects:write'])
  assert.deepEqual(capability.endpoint, { method: 'POST', path: '/v1/projects/{projectId}/speech-removals' })
  assert.equal(capability.toolName, 'apollo.projects.speech-removals.confirm')
  assert.equal(capability.inputSchemaRef, 'apollo://schemas/confirm-speech-removal-request/v2')
  const rule = agentToolSafetyFor(capability, FOUNDATION_AGENT_TOOL_SAFETY)
  assert.equal(rule.confirmation, 'human-approval')
  const fingerprint = 'c'.repeat(64)
  const now = new Date('2026-10-23T12:00:00.000Z')
  assert.throws(() => requireAgentToolExecutionGate(capability, rule, fingerprint, undefined, now), (error) => error.code === 'TOOL_CONFIRMATION_REQUIRED')
  assert.doesNotThrow(() => requireAgentToolExecutionGate(capability, rule, fingerprint, {
    kind: 'human-approval', capabilityId: capability.id, inputFingerprint: fingerprint, issuedAt: '2026-10-23T11:59:00.000Z', expiresAt: '2026-10-23T12:05:00.000Z',
  }, now))
  // The body carries the subject and the transcript, never rules.
  const schema = getPublicSchema('apollo://schemas/confirm-speech-removal-request/v2').schema
  assert.equal(schema.additionalProperties, false)
  assert.equal('rules' in schema.properties, false)
  assert.ok(publicSchemaExamples(getPublicSchema('apollo://schemas/confirm-speech-removal-request/v2')).length >= 2)
  // The v1 contract stays published, unchanged: the new capability reads a new ref.
  assert.equal('adjustments' in getPublicSchema('apollo://schemas/confirm-speech-removal-request/v1').schema.properties, false)
})

test('nothing is cut that the person was not shown: the seal of the proposal must be the one the Apollo finds now', async () => {
  const { service, applied } = world()
  for (const [label, proposalHash] of [['absent', undefined], ['another proposal', 'f'.repeat(64)], ['not a hash', 'x']]) {
    await assert.rejects(service(request({ proposalHash })), (error) => error.code === 'VERSION_CONFLICT' && error.details?.reason === 'speech-removal-proposal-changed', label)
  }
  // The transcript changed after the person looked: the text of the same sentence is not the one that was shown.
  const shown = proposeSpeechRemoval('sorteio', transcript).proposalHash
  const changed = createMediaTranscript({
    language: 'pt', text: 'um sorteio hoje. depois o conteúdo.', provider: 'controlled', model: 'stub/v1',
    words: transcript.words, segments: [{ id: 0, text: 'um sorteio de hoje.', start: 0, end: 1.5 }, { id: 1, text: 'depois o conteúdo.', start: 2, end: 3.4 }],
  })
  const moved = confirmSpeechRemovalService({
    requests: { async readCurrent() { return current([directive('sorteio')]) } }, cuts: { async readContext() { return { transcript: changed } } },
    clock: () => new Date(), createId: (kind) => kind, createEventId: () => 'event', apply: () => async (input) => { applied.push(input); return { applied: true } },
  })
  await assert.rejects(moved(request({ proposalHash: shown })), (error) => error.code === 'VERSION_CONFLICT')
  assert.deepEqual(applied, [], 'nothing was applied')
  await service(request())
  assert.equal(applied.length, 1)
  assert.equal(applied[0].confirmation.discarded, undefined, 'nothing was kept on purpose')
})
