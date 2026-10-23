import assert from 'node:assert/strict'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { describeEditorialRequest, readEditorialRequestService, reviseEditorialRequestService } from '../../src/v2/application/revise-editorial-request.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import { createEditorialRequestRevisionInvalidations } from '../../src/v2/domain/editorial-request-revision-impact.ts'
import { deriveEditorialRequestFromBrief } from '../../src/v2/domain/editorial-request.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import {
  parseReviseEditorialRequestBody, presentCurrentEditorialRequest, presentEditorialRequestRevisionResult,
} from '../../src/v2/public-api/editorial-request-contract.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { ingestedWorld } from './helpers/output-world.mjs'
import { persistedOutputQueries } from './helpers/persisted-output-client.mjs'
import { readPersistedOperationalOutputBundleV3 } from '../../src/v2/infrastructure/prisma/output-state-consumption.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'

// The briefings are synthetic and say nothing about any video: the product has no opinion about their content.
const BRIEFING = 'alpha beta gamma delta'
let worldPromise
const world = () => (worldPromise ??= ingestedWorld())
const empty = { directives: [], unsupported: [], questions: [], coverage: [] }

function stubModel(answer) {
  const calls = []
  return { provider: 'test-double', model: 'stub-1', costBasis: 'api-metered', calls, async interpret(request) { calls.push(request); return { text: JSON.stringify(typeof answer === 'function' ? answer(request) : answer) } } }
}

function briefDocument({ briefing, editorialRequest } = {}) {
  return {
    schemaVersion: 1, objective: 'discovery', desiredAction: createDesiredAction({ objective: 'discovery' }),
    productionBrief: createProductionBrief({ ...(briefing ? { ownerText: briefing } : {}) }), createdAt: '2026-10-22T12:00:00.000Z',
    ...(editorialRequest ? { editorialRequest } : {}),
  }
}

function memoryRepository(parent, options = {}) {
  const replays = new Map()
  const content = options.content ?? briefDocument({ briefing: BRIEFING })
  const repository = {
    commits: [], current: null,
    async findIdempotent({ idempotencyKey }) { return replays.get(idempotencyKey) ?? null },
    async readContext() {
      return Object.freeze({
        parent, project: { objective: 'discovery' },
        currentBriefSnapshot: Object.freeze({ id: parent.version.snapshotRefs.brief, contentSchemaVersion: 1, contentHash: 'c'.repeat(64), content }),
        currentDurationFrames: JSON.parse(operationalBundlePlanV3(parent).contentJson).durationFrames,
        outputReferences: options.outputReferences ?? [],
      })
    },
    async readCurrent() { return repository.current },
    async commitOrReplay(input) {
      const { command, requestFingerprint } = input.bundle.origin
      const briefSnapshot = input.bundle.snapshots.find((snapshot) => snapshot.id === input.bundle.version.snapshotRefs.brief)
      const result = Object.freeze({
        command, version: input.bundle.version, briefSnapshot, impact: command.payload.impact,
        invalidations: createEditorialRequestRevisionInvalidations({ impact: command.payload.impact, createdAt: command.createdAt }), replayed: false,
      })
      repository.commits.push(input)
      repository.current = Object.freeze({ version: input.bundle.version, briefSnapshot: Object.freeze({ ...briefSnapshot, content: JSON.parse(briefSnapshot.contentJson) }), objective: 'discovery' })
      replays.set(command.idempotencyKey, Object.freeze({ requestFingerprint, result }))
      return result
    },
  }
  return repository
}

function service(repository, model) {
  const ids = { command: 0, version: 0, snapshot: 0, 'edit-plan-snapshot': 0, state: 0, materialization: 0 }
  return reviseEditorialRequestService({
    repository, interpretBrief: interpretBriefService({ model }),
    createId: (kind) => `editorial-request-${kind}-${++ids[kind]}`,
    createEventId: () => '00000000-0000-4000-8000-000000000220',
    clock: () => new Date('2026-10-22T12:01:00.000Z'),
  })
}

function request(parent, actor, body, additions = {}) {
  return {
    workspaceId: parent.version.workspaceId, projectId: parent.version.projectId,
    baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
    body, actor, idempotencyKey: 'editorial-request-revision-1', ...additions,
  }
}

const requestOf = (result) => deriveEditorialRequestFromBrief({ ...JSON.parse(result.briefSnapshot.contentJson), objective: 'discovery' })

test('the briefing is read once by the interpreter and the reading is sealed in a new Brief Snapshot that nothing else replaces', async () => {
  const { parent, actor } = await world()
  const model = stubModel({ ...empty, directives: [{ kind: 'layout', value: 'source-native', param: null, quote: 'beta' }], coverage: [{ topic: 'tone', quote: 'gamma' }] })
  const repository = memoryRepository(parent)
  const result = await service(repository, model)(request(parent, actor, { briefing: BRIEFING }, { reason: 'ler o pedido' }))
  const bundle = repository.commits[0].bundle

  assert.equal(model.calls.length, 1)
  assert.deepEqual(JSON.parse(model.calls[0].user), { briefing: BRIEFING })
  assert.equal(result.command.type, 'revise-editorial-request')
  assert.deepEqual(bundle.origin.replaces, ['brief'])
  assert.equal(result.version.snapshotRefs.brief, result.briefSnapshot.id)
  assert.notEqual(result.version.snapshotRefs.brief, parent.version.snapshotRefs.brief)
  assert.equal(result.version.snapshotRefs.policies, parent.version.snapshotRefs.policies)
  assert.equal(result.version.sequence, parent.version.sequence + 1)
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.equal(JSON.parse(bundle.editPlanSnapshot.contentJson).durationFrames, JSON.parse(operationalBundlePlanV3(parent).contentJson).durationFrames)

  const content = JSON.parse(result.briefSnapshot.contentJson)
  const seen = requestOf(result)
  assert.equal(seen.briefing.text, BRIEFING)
  assert.equal(seen.interpretation.directives[0].excerpt.text, 'beta')
  assert.equal(content.editorialRequest.interpretationAudit.schemaVersion, 'brief-interpretation-audit/v1')
  assert.equal(content.editorialRequest.revision.commandId, result.command.id)
  // The production brief states the coverage the interpreter found; nothing a word list guessed.
  assert.deepEqual(content.productionBrief.summary.coverage, { audience: false, offer: false, tone: true })
  assert.deepEqual(content.productionBrief.assumptions, ['audience-not-specified', 'offer-not-specified'])
  assert.equal(result.command.payload.interpreted, true)
  assert.equal(result.command.payload.requestHash, seen.requestHash)
  assert.notEqual(result.command.payload.previousRequestHash, seen.requestHash)
  assert.equal(result.impact.renderBlockedUntilDirectorRun, true)
  assert.equal(result.impact.renderSemanticsChanged, true)
  assert.equal(repository.commits[0].event.data.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')

  // The reading is the request: the view says what blocks the Director and what does not.
  const view = describeEditorialRequest({ objective: 'discovery', briefSnapshot: { id: result.briefSnapshot.id, contentHash: result.briefSnapshot.contentHash, content } })
  assert.equal(view.state, 'interpreted')
  assert.equal(view.blocksDirector, false)
  assert.equal(view.hashes.interpretationHash, seen.interpretation.interpretationHash)
})

test('a replay never calls the model again; the same key with another request is refused', async () => {
  const { parent, actor } = await world()
  const model = stubModel(empty)
  const repository = memoryRepository(parent)
  const revise = service(repository, model)
  await revise(request(parent, actor, { briefing: BRIEFING }))
  const replay = await revise(request(parent, actor, { briefing: BRIEFING }))
  assert.equal(replay.replayed, true)
  assert.equal(model.calls.length, 1)
  assert.equal(repository.commits.length, 1)
  await assert.rejects(revise(request(parent, actor, { briefing: `${BRIEFING} again` })), (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  assert.equal(model.calls.length, 1)
})

test('with no interpreter configured a briefing with text fails closed before anything is written; with no briefing nothing needs one', async () => {
  const { parent, actor } = await world()
  const repository = memoryRepository(parent)
  await assert.rejects(service(repository, null)(request(parent, actor, { briefing: BRIEFING })), (error) =>
    error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpreter-unavailable')
  // The same stored briefing, named by structured directives only, is kept as it is and is not read again: with no reading it would be refused here.
  await assert.rejects(service(repository, null)(request(parent, actor, { directives: [{ id: 'f1', kind: 'movement', value: 'none' }] }, { idempotencyKey: 'editorial-request-revision-2' })),
    (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpreter-unavailable')
  assert.equal(repository.commits.length, 0)
  const bare = memoryRepository(parent, { content: briefDocument() })
  const result = await service(bare, null)(request(parent, actor, { directives: [{ id: 'f1', kind: 'movement', value: 'none' }] }))
  assert.equal(result.command.payload.interpreted, false)
  assert.equal(requestOf(result).briefing, undefined)
  assert.deepEqual(requestOf(result).directives.map((directive) => directive.id), ['f1'])
  assert.equal(describeEditorialRequest({ objective: 'discovery', briefSnapshot: { id: result.briefSnapshot.id, contentHash: result.briefSnapshot.contentHash, content: JSON.parse(result.briefSnapshot.contentJson) } }).state, 'no-briefing')
})

test('a stale base, an empty body and an unchanged request are refused before the model is paid for', async () => {
  const { parent, actor } = await world()
  const model = stubModel(empty)
  const repository = memoryRepository(parent)
  const revise = service(repository, model)
  await assert.rejects(revise(request(parent, actor, { briefing: BRIEFING }, { baseHash: 'f'.repeat(64) })), (error) => error.code === 'VERSION_CONFLICT')
  await assert.rejects(revise(request(parent, actor, {})), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(revise(request(parent, actor, { briefing: '   ' })), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(revise(request(parent, actor, { briefing: 'x'.repeat(10_001) })), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(revise(request(parent, actor, { directives: [{ id: 'f1', kind: 'tone', value: 'warm' }] })), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(revise(request(parent, actor, { unknown: true })), (error) => error.code === 'INVALID_ARGUMENT')
  assert.equal(model.calls.length, 0)
  // Already read, then asked again with nothing new: unchanged.
  const read = await service(memoryRepository(parent), stubModel(empty))(request(parent, actor, { briefing: BRIEFING }))
  const readContent = JSON.parse(read.briefSnapshot.contentJson)
  const again = memoryRepository(parent, { content: readContent })
  const second = stubModel(empty)
  await assert.rejects(service(again, second)(request(parent, actor, { briefing: BRIEFING })), /unchanged/)
  assert.equal(second.calls.length, 0)
})

test('structured changes to a request already read keep its reading: the model is not asked again', async () => {
  const { parent, actor } = await world()
  const read = await service(memoryRepository(parent), stubModel({ ...empty, coverage: [{ topic: 'offer', quote: 'alpha' }] }))(request(parent, actor, { briefing: BRIEFING }))
  const second = stubModel(empty)
  const repository = memoryRepository(parent, { content: JSON.parse(read.briefSnapshot.contentJson) })
  const result = await service(repository, second)(request(parent, actor, { directives: [{ id: 'f1', kind: 'cta', value: 'overlay-closing' }] }))
  assert.equal(second.calls.length, 0)
  assert.equal(result.command.payload.interpreted, false)
  assert.equal(requestOf(result).interpretation.interpretationHash, requestOf(read).interpretation.interpretationHash)
  assert.deepEqual(requestOf(result).directives.map((directive) => directive.kind), ['cta'])
  assert.deepEqual(result.command.payload.change, { briefing: 'kept', directives: 'replaced', variantOverrides: 'kept', desiredAction: 'kept', answeredQuestionIds: [] })
  // The desired action is replaceable too (a question about the call to action is answered by the text of it).
  const withAction = await service(memoryRepository(parent, { content: JSON.parse(read.briefSnapshot.contentJson) }), second)(request(parent, actor, { desiredAction: { visualCta: '<texto do chamado>' } }))
  assert.equal(requestOf(withAction).desiredAction.visualCta, '<texto do chamado>')
  assert.notEqual(requestOf(withAction).requestHash, requestOf(read).requestHash)
})

test('a question the reading raised is answered by naming it; the answer is the owner\'s and the reading is not repeated', async () => {
  const { parent, actor } = await world()
  const asking = stubModel({ ...empty, questions: [{ question: 'Which of the two is meant?', quote: 'alpha' }] })
  const read = await service(memoryRepository(parent), asking)(request(parent, actor, { briefing: BRIEFING }))
  const view = (result) => describeEditorialRequest({ objective: 'discovery', briefSnapshot: { id: result.briefSnapshot.id, contentHash: result.briefSnapshot.contentHash, content: JSON.parse(result.briefSnapshot.contentJson) } })
  assert.equal(view(read).blocksDirector, true)
  assert.deepEqual(view(read).openQuestions.map((question) => question.id), ['q1'])
  const repository = () => memoryRepository(parent, { content: JSON.parse(read.briefSnapshot.contentJson) })
  const second = stubModel(empty)
  const answered = await service(repository(), second)(request(parent, actor, { answers: [{ questionId: 'q1', answer: 'neither of them' }] }))
  assert.equal(second.calls.length, 0)
  assert.equal(view(answered).blocksDirector, false)
  assert.equal(requestOf(answered).interpretation.questions[0].answer, 'neither of them')
  assert.deepEqual(answered.command.payload.change.answeredQuestionIds, ['q1'])
  assert.notEqual(requestOf(answered).requestHash, requestOf(read).requestHash)
  // Only an open question of THIS reading can be answered, and not while the briefing is being read again.
  await assert.rejects(service(repository(), second)(request(parent, actor, { answers: [{ questionId: 'q9', answer: 'x' }] })), (error) => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(service(repository(), second)(request(parent, actor, { briefing: `${BRIEFING} edited`, answers: [{ questionId: 'q1', answer: 'x' }] })), (error) => error.code === 'INVALID_ARGUMENT')
  assert.equal(second.calls.length, 0)
  // Editing the briefing is the other way to answer: it is read again, and the old question is gone with the old text.
  const edited = await service(repository(), stubModel(empty))(request(parent, actor, { briefing: `${BRIEFING} edited` }))
  assert.equal(view(edited).blocksDirector, false)
})

test('the briefing can be removed, and an interpretation never outlives the text it read', async () => {
  const { parent, actor } = await world()
  const read = await service(memoryRepository(parent), stubModel(empty))(request(parent, actor, { briefing: BRIEFING }))
  const cleared = await service(memoryRepository(parent, { content: JSON.parse(read.briefSnapshot.contentJson) }), null)(request(parent, actor, { briefing: null }))
  const content = JSON.parse(cleared.briefSnapshot.contentJson)
  assert.equal(content.productionBrief.ownerInput, undefined)
  assert.equal(content.editorialRequest.interpretation, undefined)
  assert.equal(requestOf(cleared).briefing, undefined)
  assert.equal(cleared.command.payload.change.briefing, 'cleared')
  assert.deepEqual(content.productionBrief.assumptions.slice(0, 1), ['briefing-absent'])
})

test('the read lists what the Director would refuse: an unread briefing, an unsupported item, a movement the renderer does not execute', async () => {
  const unread = describeEditorialRequest({ objective: 'discovery', briefSnapshot: { id: 'snapshot-1', contentHash: 'a'.repeat(64), content: briefDocument({ briefing: BRIEFING }) } })
  assert.equal(unread.state, 'awaiting-interpretation')
  assert.equal(unread.blocksDirector, true)
  assert.equal(unread.interpretation, null)
  const { parent, actor } = await world()
  const stub = stubModel({ ...empty, directives: [{ kind: 'movement', value: 'zoom-in', param: null, quote: 'beta' }], unsupported: [{ summary: 'something outside the vocabulary', quote: 'delta' }] })
  const result = await service(memoryRepository(parent), stub)(request(parent, actor, { briefing: BRIEFING }))
  const view = describeEditorialRequest({ objective: 'discovery', briefSnapshot: { id: result.briefSnapshot.id, contentHash: result.briefSnapshot.contentHash, content: JSON.parse(result.briefSnapshot.contentJson) } })
  assert.equal(view.blocksDirector, true)
  assert.deepEqual(view.unsupported.map((item) => [item.source, item.reason, item.excerpt]), [['interpretation', 'outside-vocabulary', 'delta'], ['directive', 'not-executable', 'beta']])
  const read = await readEditorialRequestService({ repository: { async readCurrent() { return { version: result.version, briefSnapshot: { id: result.briefSnapshot.id, contentSchemaVersion: 1, contentHash: result.briefSnapshot.contentHash, content: JSON.parse(result.briefSnapshot.contentJson) }, objective: 'discovery' } } } })({ workspaceId: parent.version.workspaceId, projectId: parent.version.projectId })
  assert.equal(read.state, 'interpreted')
  await assert.rejects(readEditorialRequestService({ repository: { async readCurrent() { return null } } })({ workspaceId: 'workspace-1', projectId: 'project-1' }), (error) => error.code === 'PROJECT_NOT_FOUND')
})

test('the public contract: capabilities, body parser, presenters and schemas agree, and the examples carry only placeholders', async () => {
  const read = FOUNDATION_CAPABILITIES.find((capability) => capability.id === 'apollo.projects.editorial-request.read')
  const revise = FOUNDATION_CAPABILITIES.find((capability) => capability.id === 'apollo.projects.editorial-request.revise')
  assert.deepEqual([read.endpoint, revise.endpoint], [{ method: 'GET', path: '/v1/projects/{projectId}/editorial-request' }, { method: 'POST', path: '/v1/projects/{projectId}/editorial-request' }])
  assert.equal(revise.idempotency, 'required')
  assert.deepEqual(revise.requiredScopes, ['projects:write'])
  assert.deepEqual(read.requiredScopes, ['projects:read'])
  assert.deepEqual(parseReviseEditorialRequestBody({ baseVersionId: 'v1', baseHash: 'h', briefing: null, answers: [] }).body, { briefing: null, answers: [] })
  assert.throws(() => parseReviseEditorialRequestBody({ baseVersionId: 'v1', baseHash: 'h', briefing: 'x', extra: 1 }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseReviseEditorialRequestBody({ baseHash: 'h' }), (error) => error.code === 'INVALID_ARGUMENT')

  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true })
  addFormats(ajv)
  for (const name of ['editorial-request-revision-impact', 'editorial-request-revise-request', 'editorial-request-response', 'editorial-request-revised']) {
    const ref = `apollo://schemas/${name}/v1`
    const definition = getPublicSchema(ref)
    const validate = ajv.compile(definition.schema)
    const list = publicSchemaExamples(definition)
    assert.ok(list.length >= 1, `${ref} has an example`)
    for (const example of list) assert.ok(validate(example), `${ref}: ${JSON.stringify(validate.errors)}`)
    // A request example is a placeholder, never a sentence a requester could take for advice.
    assert.doesNotMatch(JSON.stringify(list), /\b(?:zoom|corte|sil[eê]ncio|cut|silence)\b/iu)
  }
  assert.match(JSON.stringify(publicSchemaExamples(getPublicSchema('apollo://schemas/editorial-request-revise-request/v1'))), /<texto do pedido>/)

  const { parent, actor } = await world()
  const result = await service(memoryRepository(parent), stubModel(empty))(request(parent, actor, { briefing: BRIEFING }))
  const presented = presentEditorialRequestRevisionResult(result)
  const validateRevised = ajv.compile(getPublicSchema('apollo://schemas/editorial-request-revised/v1').schema)
  assert.ok(validateRevised({ data: JSON.parse(JSON.stringify(presented)), meta: { apiVersion: 'v1' } }), JSON.stringify(validateRevised.errors))
  const validateResponse = ajv.compile(getPublicSchema('apollo://schemas/editorial-request-response/v1').schema)
  const current = presentCurrentEditorialRequest({ version: result.version, ...describeEditorialRequest({ objective: 'discovery', briefSnapshot: { id: result.briefSnapshot.id, contentHash: result.briefSnapshot.contentHash, content: JSON.parse(result.briefSnapshot.contentJson) } }) })
  assert.ok(validateResponse({ data: JSON.parse(JSON.stringify(current)), meta: { apiVersion: 'v1' } }), JSON.stringify(validateResponse.errors))
})

test('a Version that replaced the Brief Snapshot reads back from its sealed rows', async () => {
  const { parent, actor, chain } = await world(), repository = memoryRepository(parent)
  await service(repository, stubModel(empty))(request(parent, actor, { briefing: BRIEFING }, { idempotencyKey: 'editorial-request-read-back-1' }))
  const { bundle } = repository.commits[0]
  const client = { $queryRawUnsafe: persistedOutputQueries([...chain, bundle]) }
  const read = await readPersistedOperationalOutputBundleV3(client, { workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, versionId: bundle.version.id })
  assert.equal(stableSerialize(read), stableSerialize(bundle))
  assert.deepEqual(read.origin.replaces, ['brief'])
  assert.equal(read.version.snapshotRefs.policies, bundle.version.snapshotRefs.policies)
})

test('the questions the resolution asks (the language, where the call to action is drawn) are answered by revising the request', async () => {
  const { resolveEditorialPolicies } = await import('../../src/v2/domain/editorial-policy-resolution.ts')
  const { parent, actor } = await world()
  const media = { transcriptId: 'transcript-1', hasSelectedInsert: false, selectedInsertCount: 0, timelineDurationSeconds: 12, transcriptLanguage: 'pt' }
  const sale = { destination: { type: 'url', value: 'https://destination.example/action' }, visualCta: '<texto do chamado>' }
  const base = { content: { ...briefDocument(), objective: 'sale', desiredAction: createDesiredAction({ objective: 'sale', desiredAction: sale }) } }
  const open = (result) => resolveEditorialPolicies(requestOfObjective(result, 'sale'), media, []).openQuestions.map((question) => question.id)
  const requestOfObjective = (result, objective) => deriveEditorialRequestFromBrief({ ...JSON.parse(result.briefSnapshot.contentJson), objective })
  const repository = () => ({ ...memoryRepository(parent, base), async readContext() { return { ...(await memoryRepository(parent, base).readContext()), project: { objective: 'sale' } } } })
  // The visual call to action has no spoken call to follow: the resolution asks where to draw it.
  const asked = await service(repository(), null)(request(parent, actor, { directives: [{ id: 'c1', kind: 'cta', value: 'overlay-at-spoken-cta' }] }))
  assert.deepEqual(open(asked), ['cta-overlay-placement-unknown'])
  // Revising the request with the placement answers it: the closing of the speech is where it is drawn.
  const answered = await service({ ...repository(), async readContext() { return { ...(await repository().readContext()), currentBriefSnapshot: { ...(await repository().readContext()).currentBriefSnapshot, content: JSON.parse(asked.briefSnapshot.contentJson) } } } }, null)(
    request(parent, actor, { directives: [{ id: 'c1', kind: 'cta', value: 'overlay-closing' }] }, { idempotencyKey: 'editorial-request-revision-2' }))
  const withClosing = resolveEditorialPolicies(requestOfObjective(answered, 'sale'), { ...media, closingSentenceStartSeconds: 9.5 }, [])
  assert.deepEqual(withClosing.openQuestions.map((question) => question.id), [])
  assert.equal(withClosing.policies.ctaOverlay.origin, 'request-field')
  // The language of the captions is declared (or changed) the same way, and then it is the request that says it.
  const language = await service(repository(), null)(request(parent, actor, { directives: [{ id: 'l1', kind: 'caption-language', value: 'set', param: 'en-US' }] }, { idempotencyKey: 'editorial-request-revision-3' }))
  assert.equal(requestOfObjective(language, 'sale').directives[0].param, 'en-US')
})

test('a closed answer is chosen: the choice is the owner\'s answer and the directive of the same revision, and the Director is released', async () => {
  const { parent, actor } = await world()
  const asking = stubModel({ ...empty, directives: [
    { kind: 'layout', value: 'source-native', param: null, quote: 'alpha' }, { kind: 'layout', value: 'fit-with-backdrop', param: null, quote: 'beta' },
  ] })
  const read = await service(memoryRepository(parent), asking)(request(parent, actor, { briefing: BRIEFING }))
  const view = (result) => describeEditorialRequest({ objective: 'discovery', briefSnapshot: { id: result.briefSnapshot.id, contentHash: result.briefSnapshot.contentHash, content: JSON.parse(result.briefSnapshot.contentJson) } })
  const [question] = view(read).openQuestions
  assert.deepEqual(question.choices.map((choice) => choice.id), ['c1', 'c2'])
  assert.equal(view(read).blocksDirector, true)
  const repository = () => memoryRepository(parent, { content: JSON.parse(read.briefSnapshot.contentJson) })
  const second = stubModel(empty)
  const chosen = await service(repository(), second)(request(parent, actor, { answers: [{ questionId: 'q1', choiceId: 'c2' }] }))
  assert.equal(second.calls.length, 0, 'choosing never reads the briefing again')
  assert.equal(view(chosen).blocksDirector, false)
  const seen = requestOf(chosen)
  assert.deepEqual(seen.directives.map((directive) => [directive.id, directive.kind, directive.value]), [['answer-q1', 'layout', 'fit-with-backdrop']])
  assert.equal(seen.interpretation.questions[0].status, 'answered')
  assert.deepEqual(chosen.command.payload.change.answeredQuestionIds, ['q1'])
  // A word answer to a closed question is refused.
  await assert.rejects(service(repository(), second)(request(parent, actor, { answers: [{ questionId: 'q1', answer: 'texto livre' }] })), (error) => error.code === 'INVALID_ARGUMENT')
})
