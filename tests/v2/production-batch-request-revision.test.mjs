import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { reviseProductionBatchEditorialRequestService } from '../../src/v2/application/batch-editorial-request.ts'
import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import {
  actOnProductionBatchItemService,
  actOnProductionBatchService,
  createProductionBatchService,
  readProductionBatchEditorialRequestService,
} from '../../src/v2/application/production-batches.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import {
  parseCreateProductionBatchBody,
  parseReviseProductionBatchEditorialRequestBody,
  presentProductionBatchEditorialRequestRevision,
} from '../../src/v2/public-api/production-batch-contract.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

// ADR-160 F8. The request of a batch is answered and changed after the batch exists, and until it is resolved the batch is not generated.
// The briefings are synthetic placeholders: the content of a batch belongs to its request, never to the product.
const BRIEFING = '<texto do pedido>'
const OTHER = '<outro texto do lote>'
const actor = () => {
  const auditContext = createExternalAuditContext({ workspaceId: 'workspace-fixture', clientId: 'client-fixture', credentialId: 'credential-fixture', environment: 'sandbox' })
  return Object.freeze({ ...auditContext, auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' })
}
const empty = { directives: [], unsupported: [], questions: [], coverage: [] }
const { EVERY_SENTENCE_IS_CONTEXT } = await import('./helpers/brief-interpreter-stand-in.mjs')
// Two layouts the briefing asks for (a closed question), a movement the Apollo does not do yet (unsupported) and a question in words.
const ASKING = {
  directives: [
    { kind: 'layout', value: 'source-native', param: null, quote: 'texto' },
    { kind: 'layout', value: 'fit-with-backdrop', param: null, quote: 'pedido' },
    { kind: 'movement', value: 'zoom-in', param: null, quote: 'pedido' },
  ],
  unsupported: [], questions: [{ question: 'Qual é o idioma da fala?', quote: 'texto' }], coverage: [{ topic: 'audience', quote: 'pedido' }],
}
function model(answerFor) {
  const calls = []
  return { provider: 'test-double', model: 'stub-1', costBasis: 'api-metered', calls,
    async interpret(request) {
      calls.push(request)
      const briefing = JSON.parse(request.user).briefing
      const given = typeof answerFor === 'function' ? answerFor(briefing) : answerFor
      const answer = given === empty ? EVERY_SENTENCE_IS_CONTEXT(briefing) : given
      if (answer instanceof Error) throw answer
      return { text: JSON.stringify(answer) }
    } }
}
const body = () => ({
  projectId: 'project-fixture', name: 'Lote de teste', objective: 'discovery', briefing: BRIEFING,
  sourceGroups: [{ id: 'group-a', name: 'Grupo A', sourceArtifactIds: ['artifact-a'] }],
  recipes: [{ id: 'recipe-a', name: 'Receita A', sourceGroupIds: ['group-a'] }],
  variants: [{ id: 'variant-a', name: 'Variante A', outputSpecId: 'spec-a', locale: 'pt-BR' }],
  budget: { currency: 'USD', maxCostMinorUnits: 10_000, reservedCostMinorUnits: 0 },
  items: [{ key: 'item-a', sourceGroupId: 'group-a', recipeId: 'recipe-a', variantId: 'variant-a' }],
})

async function world(answerFor = (briefing) => (briefing === BRIEFING ? ASKING : empty)) {
  const stub = model(answerFor)
  const interpretBrief = interpretBriefService({ model: stub })
  const revisions = []
  const replays = new Map()
  const actions = []
  let batch
  const repository = {
    revisions, actions,
    async findCreateReplay() { return null },
    async create(record) { batch = record.batch; return { batch, replayed: false } },
    async read() { return batch },
    async readCurrentEditorialRequest() { return revisions.at(-1) ?? null },
    async findRequestRevisionReplay({ idempotencyKey }) { return replays.get(idempotencyKey) ?? null },
    async persistRequestRevision(record) {
      const latest = revisions.at(-1)
      const currentHash = latest?.editorialRequest.request.requestHash ?? batch.editorialRequest?.request.requestHash ?? null
      if (currentHash !== record.previousRequestHash || (latest?.sequence ?? 0) + 1 !== record.sequence) {
        throw new DomainError('VERSION_CONFLICT', 'The request of the batch changed before this revision was committed')
      }
      const revision = Object.freeze({ id: record.id, workspaceId: record.workspaceId, batchId: record.batchId, sequence: record.sequence, previousRequestHash: record.previousRequestHash,
        editorialRequest: record.editorialRequest, change: record.change, createdAt: record.createdAt })
      revisions.push(revision)
      replays.set(record.idempotencyKey, { revision, requestFingerprint: record.requestFingerprint })
      return { revision, replayed: false }
    },
    async findActionReplay() { return null },
    async persistAction(record) { actions.push(record); return { batch: record.resultingBatch, replayed: false } },
  }
  let id = 0
  const created = await createProductionBatchService({
    repository, interpretBrief, clock: () => new Date('2026-10-22T12:00:00.000Z'),
    createBatchId: () => `production-batch-${++id}`, createItemId: () => `production-batch-item-${++id}`,
  })({ workspaceId: 'workspace-fixture', ...parseCreateProductionBatchBody(body()), actor: actor(), idempotencyKey: 'batch-briefing-1' })
  let keySequence = 0
  const revise = (revisionBody, extra = {}) => reviseProductionBatchEditorialRequestService({
    repository, interpretBrief, createRevisionId: () => `batch-request-revision-${++keySequence}`, clock: () => new Date('2026-10-22T12:05:00.000Z'),
  })({ workspaceId: 'workspace-fixture', batchId: created.batch.id, body: revisionBody, actor: actor(), idempotencyKey: `batch-request-revision-key-${keySequence + 1}`, ...extra })
  const read = () => readProductionBatchEditorialRequestService({ repository })({ workspaceId: 'workspace-fixture', batchId: created.batch.id })
  const itemAction = (action, extra = {}) => actOnProductionBatchItemService({ repository, clock: () => new Date('2026-10-22T12:10:00.000Z'), createActionId: () => `action-${actions.length + 1}` })({
    workspaceId: 'workspace-fixture', batchId: created.batch.id, itemId: created.batch.items[0].id, action,
    expectedBatchRevision: created.batch.revision, expectedItemRevision: created.batch.items[0].revision, actor: actor(), idempotencyKey: `item-action-key-${action}-${actions.length}`, ...extra,
  })
  const batchAction = (action) => actOnProductionBatchService({ repository, clock: () => new Date('2026-10-22T12:10:00.000Z'), createActionId: () => `action-${actions.length + 1}` })({
    workspaceId: 'workspace-fixture', batchId: created.batch.id, action, expectedBatchRevision: created.batch.revision, actor: actor(), idempotencyKey: `batch-action-key-${action}-${actions.length}`,
  })
  return { stub, repository, batch: created.batch, revise, read, itemAction, batchAction, revisions, actions }
}

const refusedAsBlocked = (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'editorial-request-blocked'

test('the request of a batch is the one it was created with (revision 0) until it is revised, and it says it blocks the generation', async () => {
  const { read, batch } = await world()
  const view = await read()
  assert.equal(view.state, 'interpreted')
  assert.deepEqual(view.revision && { sequence: view.revision.sequence }, { sequence: 0 })
  assert.equal(view.blocksGeneration, true)
  assert.equal(view.openQuestions.length, 2, 'the closed question and the question in words')
  assert.ok(view.unsupported.length >= 1, 'the zoom is something the Apollo does not do yet')
  assert.equal(view.hashes.requestHash, batch.editorialRequest.request.requestHash)
})

test('while a question is open or an item is unsupported nothing is generated: resume, start and retry are refused with the published reason; stopping is not', async () => {
  const { itemAction, batchAction, actions } = await world()
  await assert.rejects(itemAction('start-step', { step: 'planning' }), refusedAsBlocked)
  await assert.rejects(itemAction('retry-step', { step: 'planning' }), refusedAsBlocked)
  await assert.rejects(itemAction('resume'), refusedAsBlocked)
  await assert.rejects(batchAction('resume'), refusedAsBlocked)
  assert.equal(actions.length, 0, 'nothing was written')
  // The refusal tells what is missing, in its message and its details.
  await assert.rejects(batchAction('resume'), (error) => /question/.test(error.message) && error.details.openQuestions === 2 && error.details.unsupported >= 1)
  // Cancelling is not generating.
  const cancelled = await batchAction('cancel')
  assert.equal(cancelled.replayed, false)
  assert.equal(actions.length, 1)
})

test('the owner answers by choosing and in words, changes the briefing for the unsupported item, and only then is the batch generated; every step keeps the request it replaces', async () => {
  const { revise, read, itemAction, stub, revisions, batch } = await world()
  const first = await read()
  const closed = first.openQuestions.find((question) => question.choices)
  const free = first.openQuestions.find((question) => !question.choices)
  assert.deepEqual(closed.choices.map((choice) => choice.id), ['c1', 'c2'])
  // 1. Both questions answered: the choice becomes a directive of the request, the words stay as the owner's answer.
  const answered = await revise({ expectedRequestHash: first.hashes.requestHash, answers: [{ questionId: closed.id, choiceId: 'c2' }, { questionId: free.id, answer: 'Português do Brasil.' }] })
  assert.equal(stub.calls.length, 1, 'answering never reads the briefing again')
  assert.equal(answered.replayed, false)
  assert.equal(answered.view.openQuestions.length, 0)
  assert.deepEqual(answered.view.request.directives.map((directive) => [directive.id, directive.kind, directive.value]), [[`answer-${closed.id}`, 'layout', 'fit-with-backdrop']])
  assert.equal(answered.view.revision.sequence, 1)
  assert.deepEqual(answered.revision.change.answeredQuestionIds, [closed.id, free.id].toSorted())
  assert.equal(answered.view.blocksGeneration, true, 'the zoom is still something the Apollo does not do')
  await assert.rejects(itemAction('start-step', { step: 'planning' }), refusedAsBlocked)
  // 2. A new briefing is read again: the old answers fall with the old text, and the batch is released.
  const changed = await revise({ expectedRequestHash: answered.view.hashes.requestHash, briefing: OTHER })
  assert.equal(stub.calls.length, 2, 'a new briefing is read once')
  assert.equal(changed.revision.change.interpreted, true)
  assert.equal(changed.view.request.briefing.text, OTHER)
  assert.deepEqual(changed.view.request.directives, [], 'the choice made about the old text decides nothing about the new one')
  assert.equal(changed.view.blocksGeneration, false)
  assert.equal(changed.view.revision.sequence, 2)
  const started = await itemAction('start-step', { step: 'planning' })
  assert.equal(started.replayed, false)
  // 3. The requests it replaced are kept, in order, and the batch itself never changed.
  assert.deepEqual(revisions.map((revision) => revision.sequence), [1, 2])
  assert.equal(revisions[0].previousRequestHash, first.hashes.requestHash)
  assert.equal(revisions[1].previousRequestHash, revisions[0].editorialRequest.request.requestHash)
  assert.equal(batch.editorialRequest.request.briefing.text, BRIEFING)
  assert.equal((await read()).request.briefing.text, OTHER)
})

test('a replay never calls the model; the same key with another request is refused; a stale request is a conflict', async () => {
  const { revise, read, stub, revisions } = await world()
  const first = await read()
  const closed = first.openQuestions.find((question) => question.choices)
  const free = first.openQuestions.find((question) => !question.choices)
  const answers = [{ questionId: closed.id, choiceId: 'c1' }, { questionId: free.id, answer: 'Resposta.' }]
  const done = await revise({ expectedRequestHash: first.hashes.requestHash, answers }, { idempotencyKey: 'batch-request-same-key' })
  const calls = stub.calls.length
  const again = await revise({ expectedRequestHash: first.hashes.requestHash, answers }, { idempotencyKey: 'batch-request-same-key' })
  assert.equal(again.replayed, true)
  assert.equal(again.revision.sequence, done.revision.sequence)
  assert.equal(stub.calls.length, calls, 'a replay does not read the briefing again')
  assert.equal(revisions.length, 1)
  await assert.rejects(revise({ expectedRequestHash: first.hashes.requestHash, briefing: OTHER }, { idempotencyKey: 'batch-request-same-key' }), (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  // The owner was looking at a request that has since changed.
  await assert.rejects(revise({ expectedRequestHash: first.hashes.requestHash, briefing: OTHER }), (error) => error.code === 'VERSION_CONFLICT')
  await assert.rejects(revise({ expectedRequestHash: null, briefing: OTHER }), (error) => error.code === 'VERSION_CONFLICT')
})

test('the body is exact: a briefing or answers, never both and never neither; an answer to a question that is not asked is refused; an unchanged request is refused', async () => {
  const { revise, read } = await world()
  const hash = (await read()).hashes.requestHash
  await assert.rejects(revise({ expectedRequestHash: hash }), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(revise({ expectedRequestHash: hash, briefing: OTHER, answers: [{ questionId: 'q1', answer: 'x' }] }), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(revise({ expectedRequestHash: hash, answers: [{ questionId: 'q99', choiceId: 'c1' }] }), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(revise({ expectedRequestHash: hash, briefing: BRIEFING }), (error) => error.code === 'INVALID_ARGUMENT', 'the same text, read the same way, changes nothing')
  assert.throws(() => parseReviseProductionBatchEditorialRequestBody({ briefing: OTHER }), (error) => error.code === 'INVALID_ARGUMENT', 'expectedRequestHash is required')
  assert.throws(() => parseReviseProductionBatchEditorialRequestBody({ expectedRequestHash: 'not-a-hash', briefing: OTHER }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseReviseProductionBatchEditorialRequestBody({ expectedRequestHash: null, briefing: OTHER, verdict: 'ok' }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.deepEqual(parseReviseProductionBatchEditorialRequestBody({ expectedRequestHash: null, briefing: OTHER }), { expectedRequestHash: null, briefing: OTHER })
})

test('an interpreter that did not answer fails closed with a published reason and writes nothing', async () => {
  const failing = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const { revise, read, revisions } = await world((briefing) => (briefing === BRIEFING ? ASKING : failing))
  const hash = (await read()).hashes.requestHash
  await assert.rejects(revise({ expectedRequestHash: hash, briefing: OTHER }), (error) =>
    error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpretation-failed')
  assert.equal(revisions.length, 0)
})

test('the contract: a command with a body that has a ref, a result that validates against it, and examples of placeholders only', async () => {
  const { revise, read } = await world()
  const first = await read()
  const closed = first.openQuestions.find((question) => question.choices)
  const free = first.openQuestions.find((question) => !question.choices)
  const result = await revise({ expectedRequestHash: first.hashes.requestHash, answers: [{ questionId: closed.id, choiceId: 'c1' }, { questionId: free.id, answer: 'Resposta.' }] })
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.batches.editorial-request.revise')
  assert.equal(capability.endpoint.method, 'POST')
  assert.equal(capability.endpoint.path, '/v1/batches/{batchId}/editorial-request')
  assert.equal(capability.inputSchemaRef, 'apollo://schemas/batch-editorial-request-revise-request/v1')
  assert.equal(capability.outputSchemaRef, 'apollo://schemas/batch-editorial-request-revised/v2')
  assert.equal(capability.idempotency, 'required')
  assert.deepEqual(capability.requiredScopes, ['projects:write'])
  assert.equal(capability.toolName, 'apollo.batches.editorial-request.revise')
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  const published = JSON.parse(JSON.stringify({ data: presentProductionBatchEditorialRequestRevision(result), meta: { apiVersion: 'v1' } }))
  const output = ajv.compile(getPublicSchema('apollo://schemas/batch-editorial-request-revised/v2').schema)
  assert.equal(output(published), true, JSON.stringify(output.errors)?.slice(0, 600))
  for (const example of publicSchemaExamples(getPublicSchema('apollo://schemas/batch-editorial-request-revised/v2'))) assert.equal(output(example), true, JSON.stringify(output.errors)?.slice(0, 600))
  const input = ajv.compile(getPublicSchema('apollo://schemas/batch-editorial-request-revise-request/v1').schema)
  for (const example of publicSchemaExamples(getPublicSchema('apollo://schemas/batch-editorial-request-revise-request/v1'))) assert.equal(input(example), true, JSON.stringify(input.errors)?.slice(0, 600))
  for (const wrong of [{ expectedRequestHash: null }, { expectedRequestHash: null, briefing: 'a', answers: [{ questionId: 'q1', answer: 'b' }] }, { briefing: 'a' }]) {
    assert.equal(input(wrong), false, JSON.stringify(wrong))
  }
})
