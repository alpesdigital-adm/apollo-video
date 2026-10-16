import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { createProjectService, createProjectOutputVariantService, parseCreateProjectOutputVariantBody } from '../../src/v2/application/create-project.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { buildCreationOutputVersionBundleV2, buildOperationalOutputVersionBundleV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { presentOutputBoundVersion } from '../../src/v2/public-api/project-output-variant-contract.ts'

const clone = value => structuredClone(value)
const body = () => clone(publicSchemaExamples(getPublicSchema('apollo://schemas/create-project-output-variant-request/v1'))[0])
function actor(overrides = {}) {
  const auditContext = createExternalAuditContext({ workspaceId: 'workspace-output-http', clientId: 'client-output-http',
    credentialId: 'credential-output-http', environment: 'sandbox', ...overrides })
  return { ...auditContext, auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
}
function fixture() {
  const roots = new Map(), commands = new Map(), bundles = new Map()
  let head, writes = 0, beforeCommit = () => {}, counter = 0
  const clockIds = { clock: () => new Date('2026-10-13T12:00:00.000Z'),
    createId: kind => `${kind}-${++counter}`, createEventId: randomUUID }
  const creationRepository = { async persist(input) {
    const identity = input.proposal.author.id + ':' + input.idempotencyKey, existing = roots.get(identity)
    if (existing) {
      if (existing.command.requestFingerprint !== input.proposal.requestFingerprint)
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Different creation intent')
      return { bundle: existing, replayed: true }
    }
    const bundle = buildCreationOutputVersionBundleV2(input.recompose(null))
    roots.set(identity, bundle); bundles.set(bundle.version.id, bundle); head = bundle.version.id; writes++
    return { bundle, replayed: false }
  } }
  const operationalRepository = {
    async read(scope) { return [...bundles.values()].find(b => b.version.id === scope.versionId &&
      b.version.projectId === scope.projectId && b.version.workspaceId === scope.workspaceId) ?? null },
    async persistChild(input) {
      const result = input.proposal.origin.result, c = result.command, existing = commands.get(c.idempotencyKey)
      if (existing) {
        if (existing.origin.result.requestFingerprint !== result.requestFingerprint)
          throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Different variant intent')
        return { bundle: existing, replayed: true }
      }
      beforeCommit()
      if (head !== input.proposal.parent.version.id) throw new DomainError('VERSION_CONFLICT', 'Head changed')
      const bundle = buildOperationalOutputVersionBundleV3(input.recompose({ parent: bundles.get(head), restoreTarget: null, normalizations: [] }))
      commands.set(c.idempotencyKey, bundle); bundles.set(bundle.version.id, bundle); head = bundle.version.id; writes++
      return { bundle, replayed: false }
    },
  }
  return { create: createProjectService({ ...clockIds, repository: creationRepository }),
    variant: createProjectOutputVariantService({ ...clockIds, repository: operationalRepository }),
    actor: actor(), counts: () => writes, head: () => head, changeHeadBeforeCommit: value => { beforeCommit = () => { head = value } } }
}
const creationRequest = f => ({ workspaceId: f.actor.workspaceId, actor: f.actor, name: 'Empty explicit project',
  objective: 'discovery', locale: 'pt-BR', idempotencyKey: 'root-request-http' })
const variantRequest = (f, parent, key = 'variant-request-http') => ({ ...body(), workspaceId: f.actor.workspaceId,
  projectId: parent.version.projectId, baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
  actor: f.actor, idempotencyKey: key })

test('W66 public creation is one sealed empty root, without implicit format or current head claims', async () => {
  const f = fixture(), created = await f.create(creationRequest(f))
  assert.equal(created.creationVersion.outputContractVersion, 2)
  assert.equal(created.creationVersion.sequence, 1)
  assert.equal(created.creationVersion.outputStateHash, created.bundle.state.stateHash)
  assert.equal(created.projectAtCreation.format, undefined)
  assert.equal(created.projectAtCreation.currentVersionId, undefined)
  assert.deepEqual(created.bundle.state.document.entries, [])
  assert.equal(JSON.parse(created.bundle.command.payload.snapshots.find(s => s.kind === 'brief').contentJson).outputSpec, undefined)
  assert.equal(presentOutputBoundVersion(created.creationVersion).visibleState, undefined)
  await assert.rejects(() => f.create({ ...creationRequest(f), format: '9:16' }), e => e.code === 'INVALID_ARGUMENT')
  assert.equal(f.counts(), 1)
})

test('W66 public variant service creates two independent siblings of the same format and preserves root bytes', async () => {
  const f = fixture(), root = (await f.create(creationRequest(f))).bundle, rootBytes = JSON.stringify(root)
  const first = await f.variant(variantRequest(f, root)), second = await f.variant(variantRequest(f, first.bundle, 'variant-sibling-http'))
  const entries = second.bundle.state.document.entries
  assert.equal(entries.length, 2)
  assert.equal(entries[0].spec.output.aspectRatio, entries[1].spec.output.aspectRatio)
  assert.notEqual(entries[0].variantId, entries[1].variantId)
  assert.notEqual(entries[0].outputSpecRevisionId, entries[1].outputSpecRevisionId)
  assert.deepEqual(entries.find(e => e.variantId === first.bundle.origin.result.command.payload.variantId).spec,
    first.bundle.state.document.entries[0].spec)
  assert.ok(entries.every(e => e.consumption.status === 'blocked' && e.consumption.reasons.includes('empty-project')))
  assert.equal(JSON.stringify(root), rootBytes)
  const count = f.counts(), replay = await f.create(creationRequest(f))
  assert.equal(replay.replayed, true)
  assert.equal(replay.creationVersion.id, root.version.id)
  assert.equal(replay.projectAtCreation.currentVersionId, undefined)
  assert.equal(f.head(), second.bundle.version.id)
  assert.equal(f.counts(), count)
})

test('W66 fresh HTTP allocations replay the original variant; full intent and actor changes reject', async () => {
  const f = fixture(), root = (await f.create(creationRequest(f))).bundle, request = variantRequest(f, root)
  const first = await f.variant(request), writes = f.counts(), replay = await f.variant(request)
  assert.equal(replay.replayed, true); assert.equal(replay.bundle.version.id, first.bundle.version.id)
  assert.deepEqual(replay.bundle.state.document.entries, first.bundle.state.document.entries)
  assert.equal(f.counts(), writes)
  await assert.rejects(() => f.variant({ ...request, reason: 'Different owner intent' }), e => e.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  await assert.rejects(() => f.variant({ ...request, actor: actor({ credentialId: 'credential-output-other' }) }), e => e.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  assert.equal(f.counts(), writes)
})

test('W66 unknown or missing profile facts, injected identities and authenticated scope failures close before a write', async () => {
  const f = fixture(), root = (await f.create(creationRequest(f))).bundle
  const request = variantRequest(f, root), before = f.counts()
  for (const mutate of [r => { r.output.id = 'injected-output' }, r => { r.profile.final.audio.extra = true },
    r => { delete r.profile.final.audio.channels }, r => { r.profile.faceApproved = true }, r => { r.variantId = '16:9' }]) {
    const bad = clone(request); mutate(bad)
    await assert.rejects(() => f.variant(bad), e => e.code === 'INVALID_ARGUMENT')
  }
  await assert.rejects(() => f.variant({ ...request, actor: { ...f.actor, scopes: new Set(['projects:read']) } }), e => e.code === 'AUTH_SCOPE_REQUIRED')
  await assert.rejects(() => f.variant({ ...request, workspaceId: 'workspace-other' }), e => e.code === 'AUTH_INVALID')
  await assert.rejects(() => f.variant({ ...request, baseHash: 'f'.repeat(64) }), e => e.code === 'VERSION_CONFLICT')
  f.changeHeadBeforeCommit('version-concurrent-owner')
  await assert.rejects(() => f.variant(request), e => e.code === 'VERSION_CONFLICT')
  assert.equal(f.counts(), before)
})

test('W66 public capability and new schemas preserve old contracts and require full output facts', () => {
  const create = FOUNDATION_CAPABILITIES.find(c => c.id === 'apollo.projects.create')
  assert.equal(create.version, '6.0.0'); assert.equal(create.inputSchemaRef, 'apollo://schemas/create-project-request/v4')
  const variant = FOUNDATION_CAPABILITIES.find(c => c.id === 'apollo.projects.output-variants.create')
  assert.deepEqual(variant.requiredScopes, ['projects:write']); assert.equal(variant.authMode, 'required')
  assert.equal(variant.idempotency, 'required'); assert.equal(variant.endpoint.path, '/v1/projects/{projectId}/output-variants')
  for (const ref of ['create-project-request/v3', 'project-created/v4', 'project-workspace/v13'])
    assert.equal(getPublicSchema('apollo://schemas/' + ref).ref, 'apollo://schemas/' + ref)
  for (const ref of ['create-project-request/v4', 'project-created/v5', 'create-project-output-variant-request/v1', 'project-output-variant-created/v1']) {
    const definition = getPublicSchema('apollo://schemas/' + ref), validate = addFormats(new Ajv2020({ strict: false })).compile(definition.schema)
    for (const example of publicSchemaExamples(definition)) assert.equal(validate(example), true, JSON.stringify(validate.errors))
  }
  const validate = addFormats(new Ajv2020({ strict: false })).compile(getPublicSchema('apollo://schemas/create-project-output-variant-request/v1').schema)
  const injected = body(); injected.output.id = 'client-chosen-id'; assert.equal(validate(injected), false)
  assert.throws(() => parseCreateProjectOutputVariantBody(injected), e => e.code === 'INVALID_ARGUMENT')
})
