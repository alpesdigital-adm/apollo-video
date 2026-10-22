import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { createProductionBatchService } from '../../src/v2/application/production-batches.ts'
import { createEditorialRequest } from '../../src/v2/domain/editorial-request.ts'
import { createProductionBatch, hydrateProductionBatch } from '../../src/v2/domain/production-batch.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { parseCreateProductionBatchBody, presentProductionBatchV2 } from '../../src/v2/public-api/production-batch-contract.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

// The briefings are synthetic placeholders: the content of a batch belongs to its request, never to the product.
const BRIEFING = '<texto do pedido>'
const body = (extra = {}) => ({
  projectId: 'project-fixture', name: 'Lote de teste', objective: 'content-distribution',
  sourceGroups: [{ id: 'group-a', name: 'Grupo A', sourceArtifactIds: ['artifact-a'] }],
  recipes: [{ id: 'recipe-a', name: 'Receita A', sourceGroupIds: ['group-a'] }],
  variants: [{ id: 'variant-a', name: 'Variante A', outputSpecId: 'spec-a', locale: 'pt-BR' }],
  budget: { currency: 'USD', maxCostMinorUnits: 10_000, reservedCostMinorUnits: 0 },
  items: [{ key: 'item-a', sourceGroupId: 'group-a', recipeId: 'recipe-a', variantId: 'variant-a' }],
  ...extra,
})
const actor = () => {
  const auditContext = createExternalAuditContext({ workspaceId: 'workspace-fixture', clientId: 'client-fixture', credentialId: 'credential-fixture', environment: 'sandbox' })
  return Object.freeze({ ...auditContext, auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' })
}
function stubModel(answer = { directives: [], unsupported: [], questions: [], coverage: [] }) {
  const calls = []
  return { provider: 'test-double', model: 'stub-1', calls, async interpret(request) { calls.push(request); return { text: JSON.stringify(answer) } } }
}
function memoryRepository() {
  const stored = new Map()
  return {
    created: [],
    async findCreateReplay({ idempotencyKey }) {
      const record = stored.get(idempotencyKey)
      return record ? { batch: record.batch, requestFingerprint: record.requestFingerprint } : null
    },
    async create(record) { this.created.push(record); stored.set(record.idempotencyKey, record); return { batch: record.batch, replayed: false } },
  }
}
const service = (repository, model) => {
  let id = 0
  return createProductionBatchService({
    repository, interpretBrief: interpretBriefService({ model }), clock: () => new Date('2026-10-22T12:00:00.000Z'),
    createBatchId: () => `production-batch-${++id}`, createItemId: () => `production-batch-item-${++id}`,
  })
}
const request = (extra = {}) => ({ workspaceId: 'workspace-fixture', ...parseCreateProductionBatchBody(body({ briefing: BRIEFING })), actor: actor(), idempotencyKey: 'batch-briefing-1', ...extra })

test('a batch needs a briefing, accepts any non-empty text, and reads it once before the batch exists', async () => {
  const model = stubModel({ directives: [], unsupported: [], questions: [], coverage: [{ topic: 'audience', quote: 'pedido' }] })
  const repository = memoryRepository()
  const { batch, replayed } = await service(repository, model)(request())
  assert.equal(replayed, false)
  assert.equal(model.calls.length, 1)
  assert.deepEqual(JSON.parse(model.calls[0].user), { briefing: BRIEFING })
  const stored = batch.editorialRequest
  assert.equal(stored.request.briefing.text, BRIEFING)
  assert.equal(stored.request.interpretation.coverage[0].excerpt.text, 'pedido')
  assert.equal(stored.interpretationAudit.provider, 'test-double')
  assert.match(stored.request.requestHash, /^[a-f0-9]{64}$/)
  assert.equal(repository.created[0].batch, batch)
  // A one-word briefing is a briefing.
  const short = await service(memoryRepository(), stubModel())(request({ idempotencyKey: 'batch-briefing-2', briefing: 'x' }))
  assert.equal(short.batch.editorialRequest.request.briefing.text, 'x')
  // The request is part of the definition: another briefing is another batch definition.
  const other = await service(memoryRepository(), stubModel())(request({ idempotencyKey: 'batch-briefing-3', briefing: 'y' }))
  assert.notEqual(other.batch.definitionHash, short.batch.definitionHash)
})

test('a replay never reads the briefing again; no interpreter or an empty briefing refuses before anything is written', async () => {
  const model = stubModel()
  const repository = memoryRepository()
  const create = service(repository, model)
  await create(request())
  const replay = await create(request())
  assert.equal(replay.replayed, true)
  assert.equal(model.calls.length, 1)
  assert.equal(repository.created.length, 1)
  const none = memoryRepository()
  await assert.rejects(service(none, null)(request({ idempotencyKey: 'batch-briefing-4' })), (error) =>
    error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpreter-unavailable')
  await assert.rejects(service(none, model)(request({ idempotencyKey: 'batch-briefing-5', briefing: '   ' })), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(service(none, model)(request({ idempotencyKey: 'batch-briefing-6', briefing: undefined })), (error) => error.code === 'INVALID_ARGUMENT')
  assert.equal(none.created.length, 0)
})

test('the request is sealed with the batch: it hydrates, and a changed request or hash is refused', async () => {
  const { batch } = await service(memoryRepository(), stubModel())(request())
  const wire = JSON.parse(JSON.stringify(batch))
  assert.equal(hydrateProductionBatch(wire).definitionHash, batch.definitionHash)
  const tampered = structuredClone(wire)
  tampered.editorialRequest.request.briefing.text = 'another text'
  assert.throws(() => hydrateProductionBatch(tampered), (error) => error.code === 'INVALID_ARGUMENT' || error.code === 'PERSISTENCE_CONFLICT')
  const rehashed = structuredClone(wire)
  rehashed.editorialRequest.request.requestHash = 'f'.repeat(64)
  assert.throws(() => hydrateProductionBatch(rehashed), (error) => error.code === 'PERSISTENCE_CONFLICT')
  // A batch created before the request existed has none, and hashes exactly as it did.
  const input = { id: 'batch-old', workspaceId: 'workspace-fixture', projectId: 'project-fixture', name: 'Lote antigo', objective: 'content-distribution',
    sourceGroups: batch.sourceGroups, recipes: batch.recipes, variants: batch.variants, budget: batch.budget,
    itemDefinitions: [{ id: 'item-old', key: 'item-a', sourceGroupId: 'group-a', recipeId: 'recipe-a', variantId: 'variant-a' }],
    createdBy: batch.createdBy, createdAt: batch.createdAt }
  const old = createProductionBatch(input)
  assert.equal('editorialRequest' in old, false)
  assert.equal(hydrateProductionBatch(JSON.parse(JSON.stringify(old))).definitionHash, old.definitionHash)
  const withRequest = createProductionBatch({ ...input, editorialRequest: { request: createEditorialRequest({ briefing: BRIEFING }), interpretationAudit: null } })
  assert.notEqual(withRequest.definitionHash, old.definitionHash)
})

test('the published batch does not carry its stored request, and the contract asks for the briefing', () => {
  return service(memoryRepository(), stubModel())(request()).then(({ batch }) => {
    assert.equal('editorialRequest' in presentProductionBatchV2(batch), false)
    const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.batches.create')
    assert.equal(capability.version, '3.0.0')
    assert.equal(capability.inputSchemaRef, 'apollo://schemas/create-production-batch-request/v2')
    const schema = getPublicSchema('apollo://schemas/create-production-batch-request/v2')
    assert.ok(schema.schema.required.includes('briefing'))
    assert.equal(getPublicSchema('apollo://schemas/create-production-batch-request/v1').schema.required.includes('briefing'), false)
    assert.match(JSON.stringify(publicSchemaExamples(schema)), /<texto do pedido>/)
    assert.throws(() => parseCreateProductionBatchBody(body()), (error) => error.code === 'INVALID_ARGUMENT')
    assert.throws(() => parseCreateProductionBatchBody(body({ briefing: 3 })), (error) => error.code === 'INVALID_ARGUMENT')
    assert.equal(parseCreateProductionBatchBody(body({ briefing: 'any text at all' })).briefing, 'any text at all')
  })
})
