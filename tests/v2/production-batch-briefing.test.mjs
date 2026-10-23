import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { createProductionBatchService } from '../../src/v2/application/production-batches.ts'
import { createEditorialRequest } from '../../src/v2/domain/editorial-request.ts'
import { createProductionBatch, hydrateProductionBatch } from '../../src/v2/domain/production-batch.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { parseCreateProductionBatchBody, presentProductionBatchEditorialRequest, presentProductionBatchV2 } from '../../src/v2/public-api/production-batch-contract.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

// The briefings are synthetic placeholders: the content of a batch belongs to its request, never to the product.
const BRIEFING = '<texto do pedido>'
const body = (extra = {}) => ({
  projectId: 'project-fixture', name: 'Lote de teste', objective: 'discovery',
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
  return { provider: 'test-double', model: 'stub-1', costBasis: 'api-metered', calls, async interpret(request) { calls.push(request); return { text: JSON.stringify(answer) } } }
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
  const input = { id: 'batch-old', workspaceId: 'workspace-fixture', projectId: 'project-fixture', name: 'Lote antigo', objective: 'discovery',
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
    assert.equal(capability.version, '4.0.0')
    assert.equal(capability.inputSchemaRef, 'apollo://schemas/create-production-batch-request/v3')
    const schema = getPublicSchema('apollo://schemas/create-production-batch-request/v3')
    assert.ok(schema.schema.required.includes('briefing'))
    assert.equal(schema.schema.required.includes('objective'), false, 'the objective is optional: the Apollo presumes none')
    assert.equal(getPublicSchema('apollo://schemas/create-production-batch-request/v2').schema.required.includes('objective'), true)
    assert.equal(getPublicSchema('apollo://schemas/create-production-batch-request/v1').schema.required.includes('briefing'), false)
    assert.match(JSON.stringify(publicSchemaExamples(schema)), /<texto do pedido>/)
    assert.throws(() => parseCreateProductionBatchBody(body()), (error) => error.code === 'INVALID_ARGUMENT')
    assert.throws(() => parseCreateProductionBatchBody(body({ briefing: 3 })), (error) => error.code === 'INVALID_ARGUMENT')
    assert.equal(parseCreateProductionBatchBody(body({ briefing: 'any text at all' })).briefing, 'any text at all')
  })
})

test('the request of a batch is read through its own capability: briefing, reading, unsupported items and questions, and a batch without a request says so', async () => {
  const model = stubModel({
    directives: [{ kind: 'movement', value: 'zoom-in', quote: 'texto' }], unsupported: [], questions: [{ question: 'Qual é o idioma?', quote: 'pedido' }], coverage: [{ topic: 'audience', quote: 'pedido' }],
  })
  const { batch } = await service(memoryRepository(), model)(request())
  const { readProductionBatchEditorialRequestService } = await import('../../src/v2/application/production-batches.ts')
  const read = await readProductionBatchEditorialRequestService({ repository: { async read() { return batch }, async readCurrentEditorialRequest() { return null } } })({ workspaceId: 'workspace-fixture', batchId: batch.id })
  assert.equal(read.state, 'interpreted')
  assert.equal(read.request.briefing.text, BRIEFING)
  assert.equal(read.interpretation.coverage[0].topic, 'audience')
  assert.ok(read.unsupported.length >= 1, 'a movement the renderer does not execute is reported, never dropped')
  assert.equal(read.openQuestions.length, 1)
  assert.equal(read.hashes.requestHash, batch.editorialRequest.request.requestHash)
  const published = presentProductionBatchEditorialRequest(read)
  assert.equal(published.request.briefing.text, BRIEFING)
  assert.equal(published.batch.id, batch.id)
  const old = createProductionBatch({ id: 'batch-old', workspaceId: 'workspace-fixture', projectId: 'project-fixture', name: 'Lote antigo', objective: 'discovery',
    sourceGroups: batch.sourceGroups, recipes: batch.recipes, variants: batch.variants, budget: batch.budget,
    itemDefinitions: [{ id: 'item-old', key: 'item-a', sourceGroupId: 'group-a', recipeId: 'recipe-a', variantId: 'variant-a' }], createdBy: batch.createdBy, createdAt: batch.createdAt })
  const none = await readProductionBatchEditorialRequestService({ repository: { async read() { return old }, async readCurrentEditorialRequest() { return null } } })({ workspaceId: 'workspace-fixture', batchId: old.id })
  assert.equal(none.state, 'no-request')
  assert.equal(none.request, null)
  // The contract: a query with an immutable ref, an example of placeholders, and a response schema that accepts what is published.
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.batches.editorial-request.read')
  assert.equal(capability.endpoint.path, '/v1/batches/{batchId}/editorial-request')
  assert.equal(capability.outputSchemaRef, 'apollo://schemas/batch-editorial-request-response/v2')
  assert.equal(capability.toolName, 'apollo.batches.editorial-request.read')
  const schema = getPublicSchema('apollo://schemas/batch-editorial-request-response/v2')
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  const validate = ajv.compile(schema.schema)
  for (const value of [{ data: published, meta: { apiVersion: 'v1' } }, { data: presentProductionBatchEditorialRequest(none), meta: { apiVersion: 'v1' } }]) {
    assert.equal(validate(JSON.parse(JSON.stringify(value))), true, JSON.stringify(validate.errors)?.slice(0, 600))
  }
  for (const example of publicSchemaExamples(schema)) assert.equal(validate(example), true, JSON.stringify(validate.errors)?.slice(0, 600))
})

test('ADR-160: a batch may be created with no objective; the Apollo presumes none and the batch hashes without the key', async () => {
  const withObjective = await service(memoryRepository(), stubModel())(request())
  const { objective: _omitted, ...fields } = parseCreateProductionBatchBody(body({ briefing: BRIEFING }))
  void _omitted
  const created = await service(memoryRepository(), stubModel())({ workspaceId: 'workspace-fixture', ...fields, actor: actor(), idempotencyKey: 'batch-briefing-none' })
  assert.equal('objective' in created.batch, false)
  assert.notEqual(created.batch.definitionHash, withObjective.batch.definitionHash)
  assert.equal(hydrateProductionBatch(JSON.parse(JSON.stringify(created.batch))).definitionHash, created.batch.definitionHash)
  assert.equal(parseCreateProductionBatchBody(body({ briefing: BRIEFING })).objective, 'discovery')
  assert.equal('objective' in parseCreateProductionBatchBody((() => { const { objective: _o, ...rest } = body({ briefing: BRIEFING }); void _o; return rest })()), false)
})

test('ADR-160: a step that judges against an objective takes it from the batch, or from its own request when the batch has none; never both different, never presumed', async () => {
  const { objectiveOf } = await import('../../src/v2/application/variant-recipes.ts')
  assert.equal(objectiveOf('lead-generation', undefined), 'lead-generation')
  assert.equal(objectiveOf('lead-generation', 'lead-generation'), 'lead-generation')
  assert.equal(objectiveOf(undefined, 'sale'), 'sale')
  assert.throws(() => objectiveOf('lead-generation', 'sale'), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => objectiveOf(undefined, undefined), (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'objective-required')
})

test('ADR-160: the objective of a batch is one of the strategic objectives, never free text; an unknown id is refused before the briefing is read', async () => {
  const model = stubModel()
  const { objective: _o, ...fields } = parseCreateProductionBatchBody(body({ briefing: BRIEFING }))
  void _o
  await assert.rejects(service(memoryRepository(), model)({ workspaceId: 'workspace-fixture', ...fields, objective: 'content-distribution', actor: actor(), idempotencyKey: 'batch-unknown-objective' }),
    (error) => error.code === 'INVALID_ARGUMENT' && error.details.objective === 'content-distribution')
  assert.equal(model.calls.length, 0, 'nothing was paid for')
  assert.throws(() => createProductionBatch({ id: 'batch-x', workspaceId: 'workspace-fixture', projectId: 'project-fixture', name: 'x', objective: 'schedule', sourceGroups: [], recipes: [], variants: [], budget: { currency: 'USD', maxCostMinorUnits: 1, reservedCostMinorUnits: 0 }, itemDefinitions: [], createdBy: { type: 'api-client', id: 'client-fixture' }, createdAt: '2026-10-22T12:00:00.000Z' }), (error) => error.code === 'INVALID_ARGUMENT')
  const catalog = ['discovery', 'awareness', 'warming', 'lead-generation', 'sale', 'whatsapp', 'booking', 'download']
  for (const id of catalog) assert.equal(parseCreateProductionBatchBody(body({ briefing: BRIEFING, objective: id })).objective, id)
})

test('ADR-160: the audit of a reading is checked against the briefing it audits when a batch is made, and when a stored request is read back', async () => {
  const real = await interpretBriefService({ model: stubModel() })({ briefing: BRIEFING })
  const forged = { ...real.audit, inputHash: 'c'.repeat(64) }
  const forgedService = createProductionBatchService({
    repository: memoryRepository(), interpretBrief: async () => ({ interpretation: real.interpretation, audit: forged }), clock: () => new Date('2026-10-22T12:00:00.000Z'),
    createBatchId: () => 'production-batch-forged', createItemId: () => 'production-batch-item-forged',
  })
  await assert.rejects(forgedService(request({ idempotencyKey: 'batch-forged-audit' })), (error) => error.code === 'INVALID_ARGUMENT')
  const { sealedBatchEditorialRequest } = await import('../../src/v2/domain/production-batch.ts')
  const request0 = createEditorialRequest({ briefing: BRIEFING, interpretation: real.interpretation })
  assert.ok(sealedBatchEditorialRequest({ request: request0, interpretationAudit: JSON.parse(JSON.stringify(real.audit)) }))
  assert.throws(() => sealedBatchEditorialRequest({ request: request0, interpretationAudit: { ...real.audit, model: 'another' } }), (error) => error.code === 'INVALID_ARGUMENT')
})
