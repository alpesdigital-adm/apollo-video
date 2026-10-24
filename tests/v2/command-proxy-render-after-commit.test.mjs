import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { enqueueProjectProxyRenderAfterCommandService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { commandProxyRenderReplayed, presentCommandProxyRender } from '../../src/v2/public-api/command-proxy-render-contract.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'

/**
 * Found by the W70 rehearsal: `run-director`, `remove-spoken-content` and `lut-selection` on a project with TWO outputs committed their
 * Version and then answered `428 output-variant-required`, because the proxy they enqueue afterwards is rendered for ONE output.
 *
 * Contract chosen (docs/quality/w66-version-overlay-integration-v1.md section 18 says these Commands are project-wide: they apply to
 * every output): the Command commits and ANSWERS - success, no `operation`, `proxyRenders` lists the outputs whose proxy is still to be
 * requested. Deciding it BEFORE any write would have made the project-wide Commands impossible on a project with two outputs.
 */
const WORKSPACE = 'workspace-after-command'
const PROJECT = 'project-after-command'
const VERSION = 'project-version-after-command'
const auditContext = createExternalAuditContext({ clientId: 'client-after-command', credentialId: 'credential-after-command', workspaceId: WORKSPACE, environment: 'production' })
const actor = Object.freeze({
  ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
  workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
})
const TALL = { variantId: 'variant-tall-after-command', aspectRatio: '9:16' }
const WIDE = { variantId: 'variant-wide-after-command', aspectRatio: '16:9' }
const SENTINEL = new Error('the enqueue ran')

/** A repository that records every call and refuses to render: reaching `readCurrentSource` means the enqueue ran. */
function world({ outputs, withList = true } = {}) {
  const calls = { list: [], read: [], writes: 0 }
  const projects = {
    async readCurrentSource(input) { calls.read.push(input); throw SENTINEL },
  }
  if (withList) projects.listVersionOutputs = async (input) => { calls.list.push(input); return outputs }
  const operations = {
    async findReplay() { calls.writes += 1; throw new Error('must not run') },
    async createOrReplay() { calls.writes += 1; throw new Error('must not run') },
  }
  const service = enqueueProjectProxyRenderAfterCommandService({
    projects, operations, colorPipelines: { async readForSources() { calls.writes += 1; throw new Error('must not run') } },
    clock: () => new Date('2026-10-23T12:00:00.000Z'), createId: (kind) => `${kind}-after-command`,
  })
  const ask = (extra = {}) => service({ workspaceId: WORKSPACE, projectId: PROJECT, expectedProjectVersionId: VERSION, actor, idempotencyKey: 'after-command-proxy', ...extra })
  return { calls, ask }
}

test('a Version with two outputs commits without a proxy and says which proxies remain; nothing is read for render or written', async () => {
  const { calls, ask } = world({ outputs: [TALL, WIDE] })
  const first = await ask()
  assert.equal(first.status, 'per-output-request-required')
  assert.equal(first.reason, 'output-variant-required')
  assert.deepEqual(first.outputs, [TALL, WIDE])
  assert.deepEqual(calls.list, [{ workspaceId: WORKSPACE, projectId: PROJECT, projectVersionId: VERSION }], 'the outputs are those of the Version the Command sealed')
  assert.equal(calls.read.length, 0, 'no render source was consumed (so no 428 can come from it)')
  assert.equal(calls.writes, 0, 'nothing is written: no operation, no replay record')
  // Idempotent: asking again answers the same and still writes nothing.
  assert.deepEqual(await ask(), first)
  assert.equal(calls.writes, 0)
  assert.equal(commandProxyRenderReplayed(first), true, 'a deferral is never what makes an answer a first one')
})

test('a Version with one output (or none yet) goes through the enqueue as it always did', async () => {
  for (const outputs of [[TALL], []]) {
    const { calls, ask } = world({ outputs })
    await assert.rejects(ask(), (error) => error === SENTINEL)
    assert.equal(calls.read.length, 1, `${outputs.length} output(s): the enqueue consumed the head`)
    assert.equal(calls.read[0].variantId, undefined, 'the single output is never guessed by a name')
  }
})

test('a repository that cannot list outputs enqueues as before, and a caller that names the output is enqueued for that output', async () => {
  const bare = world({ withList: false })
  await assert.rejects(bare.ask(), (error) => error === SENTINEL)
  assert.equal(bare.calls.read.length, 1)
  const named = world({ outputs: [TALL, WIDE] })
  await assert.rejects(named.ask({ variantId: WIDE.variantId }), (error) => error === SENTINEL)
  assert.equal(named.calls.list.length, 0, 'the caller already chose the output')
  assert.equal(named.calls.read[0].variantId, WIDE.variantId)
})

test('the answer states proxyRenders instead of operation and validates against the published schemas', async () => {
  const { ask } = world({ outputs: [TALL, WIDE] })
  const presented = presentCommandProxyRender(await ask())
  assert.deepEqual(Object.keys(presented), ['proxyRenders'])
  assert.deepEqual(presented.proxyRenders.outputs, [TALL, WIDE])
  const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
  for (const ref of ['project-edit-command-applied/v10', 'project-lut-selection-applied/v4', 'project-color-plan-applied/v2', 'review-patch-applied/v4', 'review-patch-batch-applied/v4']) {
    const definition = getPublicSchema(`apollo://schemas/${ref}`)
    const validate = ajv.compile(definition.schema)
    const examples = publicSchemaExamples(definition)
    assert.ok(examples.length > 0)
    for (const example of examples) assert.equal(validate(example), true, `${ref}: ${JSON.stringify(validate.errors)}`)
    const withProxyRenders = examples.filter((example) => 'proxyRenders' in example.data)
    assert.ok(withProxyRenders.length > 0, `${ref} publishes an example of a project with several outputs`)
    for (const example of withProxyRenders) assert.equal('operation' in example.data, false, 'there is no operation when no proxy was enqueued')
  }
  // The earlier versions keep requiring the operation they were published with.
  const v9 = getPublicSchema('apollo://schemas/project-edit-command-applied/v9').schema
  assert.ok(v9.properties.data.oneOf[0].required.includes('operation'))
  assert.ok(!getPublicSchema('apollo://schemas/project-edit-command-applied/v10').schema.properties.data.oneOf[0].required.includes('operation'))
  assert.ok(!getPublicSchema('apollo://schemas/project-edit-command-applied/v10').schema.properties.data.oneOf[1].required.includes('operation'))
})

test('the capabilities publish the new response versions', () => {
  const by = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
  assert.equal(by.get('apollo.projects.commands.apply').outputSchemaRef, 'apollo://schemas/project-edit-command-applied/v10')
  assert.equal(by.get('apollo.projects.lut-selection.set').outputSchemaRef, 'apollo://schemas/project-lut-selection-applied/v4')
  assert.equal(by.get('apollo.projects.color-plan.set').outputSchemaRef, 'apollo://schemas/project-color-plan-applied/v2')
  assert.equal(by.get('apollo.projects.speech-removals.confirm').outputSchemaRef, 'apollo://schemas/project-edit-command-applied/v10')
  assert.equal(by.get('apollo.projects.review-patches.apply').outputSchemaRef, 'apollo://schemas/review-patch-applied/v4')
  assert.equal(by.get('apollo.projects.review-patch-batches.apply').outputSchemaRef, 'apollo://schemas/review-patch-batch-applied/v4')
  for (const id of ['apollo.projects.commands.apply', 'apollo.projects.lut-selection.set', 'apollo.projects.color-plan.set', 'apollo.projects.review-patches.apply', 'apollo.projects.review-patch-batches.apply', 'apollo.projects.speech-removals.confirm']) {
    assert.match(by.get(id).description, /never a 428 after the commit/)
  }
})

test('the routes of the project-wide Commands answer through the after-command service and never through the plain enqueue', async () => {
  for (const path of ['commands', 'lut-selection', 'color-plan', 'patch-proposals/[proposalId]/apply', 'patch-batches/[batchId]/apply', 'speech-removals']) {
    const route = await readFile(new URL(`../../src/app/v1/projects/[projectId]/${path}/route.ts`, import.meta.url), 'utf8')
    assert.match(route, /enqueueProjectProxyRenderAfterCommandService\(\{/, path)
    assert.doesNotMatch(route, /enqueueProjectProxyRenderService/, `${path} must not enqueue a single-output proxy after its commit`)
    assert.match(route, /presentCommandProxyRender\((proxy|render)\)|presentEditorialCutApplied\(result, proxy\)/, path)
  }
  // The routes that name an output (a manual edit's view, a restore's view) enqueue for that output.
  for (const path of ['manual-edits', 'version-comparisons']) {
    const route = await readFile(new URL(`../../src/app/v1/projects/[projectId]/${path}/route.ts`, import.meta.url), 'utf8')
    assert.match(route, /variantId: body\.variantId,\s+actor,/, `${path} asks for the proxy of the output it was made on`)
  }
})
