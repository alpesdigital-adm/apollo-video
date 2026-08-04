import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createWorkspaceLutVersionService, importWorkspaceLutService, setWorkspaceLutDefaultService, setWorkspaceLutStatusService } from '../../src/v2/application/workspace-luts.ts'
import { createWorkspaceLutVersion, parseCube3d } from '../../src/v2/domain/workspace-lut.ts'
import { parseCreateWorkspaceLutVersionBody, parseImportWorkspaceLutBody, parseSetWorkspaceLutDefaultBody, parseSetWorkspaceLutStatusBody, presentWorkspaceLut } from '../../src/v2/public-api/workspace-lut-contract.ts'
import { PrismaWorkspaceLutRepository } from '../../src/v2/infrastructure/prisma/workspace-lut-repository.ts'

const identityCube = `# unicode comment
TITLE "Coração 🎞️"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`

function actor(credentialId = 'credential-lut-test') {
  const auditContext = createExternalAuditContext({
    clientId: 'client-lut-test',
    credentialId,
    workspaceId: 'workspace-lut-test',
    environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', name: 'Coração 🎞️', owner: 'Apollo Studio',
    license: { policy: 'owned', name: 'Propriedade do workspace' }, tags: ['Cinema', 'coração'],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.75,
    cubeContent: identityCube, actor: actor(), idempotencyKey: 'workspace-lut-import-1',
    ...overrides,
  }
}

test('T-FR-181 parses canonical unicode .cube with strict finite rows and domain', () => {
  const parsed = parseCube3d(identityCube.replace(/\n/g, '\r\n'))
  assert.equal(parsed.title, 'Coração 🎞️')
  assert.equal(parsed.size, 2)
  assert.equal(parsed.rows, 8)
  assert.match(parsed.contentHash, /^[a-f0-9]{64}$/)
  assert.equal(parsed.canonicalContent.includes('\r'), false)
  for (const invalid of [
    'LUT_3D_SIZE 2\n0 0 0\n',
    identityCube.replace('1 1 1\n', 'NaN 1 1\n'),
    identityCube.replace('DOMAIN_MAX 1 1 1', 'DOMAIN_MAX 0 1 1'),
    identityCube.replace('LUT_3D_SIZE 2', 'LUT_1D_SIZE 2'),
  ]) assert.throws(() => parseCube3d(invalid), /cube|DOMAIN|directive|row count|precede/)
})

test('T-FR-181 imports one immutable licensed version, generates preview once and replays exactly', async () => {
  let persisted
  let previews = 0
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const previewSha = createHash('sha256').update(png).digest('hex')
  const repository = {
    async findIdempotent() { return persisted?.value ?? null },
    async import(input) { persisted = input; return { value: input.value, replayed: false } },
  }
  const service = importWorkspaceLutService({
    repository,
    preview: { async generate() { previews += 1; return { png, width: 512, height: 288, sha256: previewSha } } },
    createVersionId: () => 'lut-version-test-1', clock: () => new Date('2026-07-31T11:00:00.000Z'),
  })
  const first = await service(request())
  const replay = await service(request())
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(previews, 1)
  assert.equal(first.value.record.currentVersion.version, 1)
  assert.equal(first.value.record.currentVersion.name, 'Coração 🎞️')
  assert.deepEqual(first.value.record.currentVersion.tags, ['cinema', 'coração'])
  assert.equal(first.value.record.currentVersion.preview.sha256, previewSha)
  assert.equal(first.value.audit.credentialId, 'credential-lut-test')
  assert.equal(first.value.audit.workspaceId, 'workspace-lut-test')
  assert.match(first.value.audit.contextHash, /^[a-f0-9]{64}$/)
  assert.equal(persisted.previewPng, png)
  const publicValue = presentWorkspaceLut(first.value.record)
  assert.equal('canonicalContent' in publicValue.currentVersion.cube, false)
  assert.match(publicValue.currentVersion.preview.path, /\/preview$/)
  await assert.rejects(service(request({ name: 'Outra LUT' })), /another LUT import/)
  await assert.rejects(
    service(request({ actor: actor('credential-lut-other') })),
    /another LUT import/,
  )
})

test('T-FR-181 public import contract rejects hidden fields and aggregate binds license and preview', () => {
  assert.throws(() => parseImportWorkspaceLutBody({ ...request(), actor: undefined, idempotencyKey: undefined, hidden: true }), /unknown fields/)
  const previewSha = 'a'.repeat(64)
  const value = createWorkspaceLutVersion({
    id: 'lut-version-contract', workspaceId: 'workspace-lut-test', lutId: 'lut-contract', version: 1,
    name: 'Coração 🎞️', owner: 'Apollo Studio', license: { policy: 'licensed', name: 'Licença editorial', usageNotes: 'Uso interno.' },
    tags: ['Brand'], compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'display-p3' }, intensity: 0.5,
    cubeContent: identityCube, preview: { byteSize: 1024, sha256: previewSha }, createdByClientId: 'client-lut-test', createdAt: '2026-07-31T11:01:00.000Z',
  })
  assert.match(value.recordHash, /^[a-f0-9]{64}$/)
  assert.equal(value.license.policy, 'licensed')
  assert.equal(value.compatibility.outputColorSpace, 'display-p3')
})

test('T-FR-181 creates only the next immutable version and rejects a stale base before preview', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7])
  const previewSha = createHash('sha256').update(png).digest('hex')
  const first = createWorkspaceLutVersion({
    id: 'lut-version-base-1', workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1,
    name: 'Base', owner: 'Apollo Studio', license: { policy: 'owned', name: 'Workspace' }, tags: [],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, cubeContent: identityCube,
    preview: { byteSize: png.byteLength, sha256: previewSha }, createdByClientId: 'client-lut-test', createdAt: '2026-07-31T12:00:00.000Z',
  })
  let current = { lutId: first.lutId, workspaceId: first.workspaceId, status: 'active', revision: 1, currentVersion: first }
  let persisted
  let previews = 0
  const repository = {
    async findIdempotent({ idempotencyKey }) { return persisted?.idempotencyKey === idempotencyKey ? persisted : null },
    async read() { return current },
    async createVersion(input) { persisted = input.value; current = input.value.record; return { value: input.value, replayed: false } },
  }
  const service = createWorkspaceLutVersionService({ repository, preview: { async generate() { previews += 1; return { png, width: 512, height: 288, sha256: previewSha } } }, createVersionId: () => 'lut-version-next-2', clock: () => new Date('2026-07-31T12:01:00.000Z') })
  const mutation = { ...request({ idempotencyKey: 'workspace-lut-version-2', name: 'VersÃ£o 2' }), baseVersion: 1 }
  const created = await service(mutation)
  assert.equal(created.value.record.currentVersion.version, 2)
  assert.equal(created.value.record.currentVersion.id, 'lut-version-next-2')
  assert.equal(previews, 1)
  assert.equal((await service(mutation)).replayed, true)
  assert.equal(previews, 1)
  await assert.rejects(service({ ...mutation, idempotencyKey: 'workspace-lut-stale-3', baseVersion: 1 }), /stale/)
  assert.equal(previews, 1)
  assert.equal(parseCreateWorkspaceLutVersionBody({ baseVersion: 2, name: 'V3', owner: 'Owner', license: { policy: 'owned', name: 'Owned' }, compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, cubeContent: identityCube }).baseVersion, 2)
})

test('T-FR-181 lifecycle command is revision-bound, replayable and preserves historical versions', async () => {
  const first = createWorkspaceLutVersion({
    id: 'lut-version-lifecycle-1', workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1,
    name: 'Lifecycle', owner: 'Apollo Studio', license: { policy: 'owned', name: 'Workspace' }, tags: [],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, cubeContent: identityCube,
    preview: { byteSize: 10, sha256: 'b'.repeat(64) }, createdByClientId: 'client-lut-test', createdAt: '2026-07-31T12:10:00.000Z',
  })
  let record = { lutId: first.lutId, workspaceId: first.workspaceId, status: 'active', revision: 1, currentVersion: first }
  let persisted
  const repository = {
    async findStatusIdempotent({ idempotencyKey }) { return persisted?.command.idempotencyKey === idempotencyKey ? persisted : null },
    async read() { return record },
    async setStatus({ command }) {
      if (record.revision !== command.baseRevision) throw new Error('Workspace LUT revision changed')
      record = { ...record, status: command.status, revision: command.resultRevision }
      persisted = { command, record }; return { ...persisted, replayed: false }
    },
  }
  const service = setWorkspaceLutStatusService({ repository, createCommandId: () => 'lut-status-test-1', clock: () => new Date('2026-07-31T12:11:00.000Z') })
  const input = { workspaceId: first.workspaceId, lutId: first.lutId, baseRevision: 1, status: 'inactive', actor: actor(), idempotencyKey: 'workspace-lut-status-1' }
  const applied = await service(input)
  assert.equal(applied.record.status, 'inactive')
  assert.equal(applied.record.revision, 2)
  assert.equal(applied.record.currentVersion.recordHash, first.recordHash)
  assert.equal((await service(input)).replayed, true)
  await assert.rejects(
    service({ ...input, actor: actor('credential-lut-other') }),
    /another LUT status command/,
  )
  assert.deepEqual(parseSetWorkspaceLutStatusBody({ baseRevision: 2, status: 'active' }), { baseRevision: 2, status: 'active' })
  assert.throws(() => parseSetWorkspaceLutStatusBody({ baseRevision: 1, status: 'deleted' }), /status/)
})

test('T-FR-181 workspace default versions active current LUT or explicit none with CAS', async () => {
  const version = createWorkspaceLutVersion({
    id: 'lut-version-default-1', workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1,
    name: 'Default', owner: 'Apollo Studio', license: { policy: 'owned', name: 'Workspace' }, tags: [],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, cubeContent: identityCube,
    preview: { byteSize: 10, sha256: 'c'.repeat(64) }, createdByClientId: 'client-lut-test', createdAt: '2026-07-31T12:20:00.000Z',
  })
  const lut = { lutId: version.lutId, workspaceId: version.workspaceId, status: 'active', revision: 1, currentVersion: version }
  let current = { workspaceId: version.workspaceId, revision: 0, current: null }
  const history = []
  const repository = {
    async readDefault() { return current }, async read() { return lut },
    async findDefaultIdempotent({ idempotencyKey }) { return history.find((item) => item.idempotencyKey === idempotencyKey) ?? null },
    async setDefault({ value, expectedRevision }) {
      if (current.revision !== expectedRevision) throw new Error('default revision changed')
      history.push(value); current = { workspaceId: value.workspaceId, revision: value.revision, current: value }; return { value, replayed: false }
    },
  }
  let ids = 0
  const service = setWorkspaceLutDefaultService({ repository, createVersionId: () => `lut-default-test-${++ids}`, clock: () => new Date('2026-07-31T12:21:00.000Z') })
  const select = { workspaceId: version.workspaceId, baseRevision: 0, selection: { mode: 'lut-version', lutId: version.lutId, version: 1 }, actor: actor(), idempotencyKey: 'workspace-lut-default-1' }
  const selected = await service(select)
  assert.equal(selected.value.mode, 'lut-version')
  assert.equal(selected.value.lutVersion.id, version.id)
  assert.equal((await service(select)).replayed, true)
  await assert.rejects(
    service({ ...select, actor: actor('credential-lut-other') }),
    /another workspace LUT default/,
  )
  await assert.rejects(service({ ...select, idempotencyKey: 'workspace-lut-default-stale', selection: { mode: 'none' } }), /revision changed/)
  const none = await service({ ...select, baseRevision: 1, selection: { mode: 'none' }, idempotencyKey: 'workspace-lut-default-none' })
  assert.equal(none.value.mode, 'none')
  assert.equal(none.value.revision, 2)
  assert.deepEqual(parseSetWorkspaceLutDefaultBody({ baseRevision: 2, selection: { mode: 'none' } }).selection, { mode: 'none' })
  assert.throws(() => parseSetWorkspaceLutDefaultBody({ baseRevision: 2, selection: { mode: 'none', lutId: 'hidden' } }), /cannot identify/)
})

test('T-FR-181 Prisma adapter commits head/version/preview atomically and detects preview tamper', async () => {
  let head
  const versions = []
  const statusCommands = []
  let defaultHead
  const defaultVersions = []
  const client = {
    v2WorkspaceLutVersion: {
      async findUnique({ where }) {
        if (where.workspaceId_createdByClientId_idempotencyKey) return versions.find((item) => item.workspaceId === where.workspaceId_createdByClientId_idempotencyKey.workspaceId && item.createdByClientId === where.workspaceId_createdByClientId_idempotencyKey.createdByClientId && item.idempotencyKey === where.workspaceId_createdByClientId_idempotencyKey.idempotencyKey) ?? null
        if (where.workspaceId_lutId_version) return versions.find((item) => item.workspaceId === where.workspaceId_lutId_version.workspaceId && item.lutId === where.workspaceId_lutId_version.lutId && item.version === where.workspaceId_lutId_version.version) ?? null
        if (where.id) return versions.find((item) => item.id === where.id) ?? null
        return null
      },
      async findFirst({ where }) { return versions.find((item) => item.id === where.id && item.workspaceId === where.workspaceId && item.lutId === where.lutId) ?? null }, async findMany() { return versions },
    },
    v2WorkspaceLut: { async findUnique() { return head ?? null }, async findMany() { return head ? [head] : [] } },
    v2WorkspaceLutStatusCommand: { async findUnique({ where }) { return statusCommands.find((item) => item.workspaceId === where.workspaceId_createdByClientId_idempotencyKey.workspaceId && item.createdByClientId === where.workspaceId_createdByClientId_idempotencyKey.createdByClientId && item.idempotencyKey === where.workspaceId_createdByClientId_idempotencyKey.idempotencyKey) ?? null } },
    v2WorkspaceLutDefault: { async findUnique() { return defaultHead ?? null } },
    v2WorkspaceLutDefaultVersion: { async findUnique({ where }) { if (where.id) return defaultVersions.find((item) => item.id === where.id) ?? null; return defaultVersions.find((item) => item.workspaceId === where.workspaceId_createdByClientId_idempotencyKey.workspaceId && item.createdByClientId === where.workspaceId_createdByClientId_idempotencyKey.createdByClientId && item.idempotencyKey === where.workspaceId_createdByClientId_idempotencyKey.idempotencyKey) ?? null } },
    async $transaction(action) {
      return action({
        v2Workspace: { async findFirst() { return { id: 'workspace-lut-test' } } },
        v2ApiClient: { async findFirst() { return { id: 'client-lut-test' } } },
        v2WorkspaceLut: {
          async findUnique() { return head ?? null },
          async create({ data }) { head = { ...data, revision: 1, currentVersionId: null }; return head },
          async update({ data }) { head = { ...head, ...data }; return head },
        },
        v2WorkspaceLutVersion: {
          async create({ data }) { const version = { ...data }; versions.push(version); return version },
          async findUnique({ where }) { return versions.find((item) => item.id === where.id) ?? null },
        },
        v2WorkspaceLutStatusCommand: { async create({ data }) { const command = { ...data }; statusCommands.push(command); return command } },
        v2WorkspaceLutDefault: {
          async findUnique() { return defaultHead ?? null },
          async create({ data }) { defaultHead = { ...data }; return defaultHead },
          async update({ data }) { defaultHead = { ...defaultHead, ...data }; return defaultHead },
        },
        v2WorkspaceLutDefaultVersion: { async create({ data }) { const value = { ...data }; defaultVersions.push(value); return value } },
      })
    },
  }
  const repository = new PrismaWorkspaceLutRepository(client)
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6])
  const previewSha = createHash('sha256').update(png).digest('hex')
  const created = await importWorkspaceLutService({
    repository, preview: { async generate() { return { png, width: 512, height: 288, sha256: previewSha } } },
    createVersionId: () => 'lut-version-prisma-1', clock: () => new Date('2026-07-31T11:02:00.000Z'),
  })(request({ idempotencyKey: 'workspace-lut-prisma-1' }))
  assert.equal(created.replayed, false)
  assert.equal(head.currentVersionId, 'lut-version-prisma-1')
  assert.equal((await repository.read({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test' })).currentVersion.recordHash, versions[0].recordHash)
  assert.equal((await repository.readPreview({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1 })).sha256, previewSha)
  const next = await createWorkspaceLutVersionService({
    repository, preview: { async generate() { return { png, width: 512, height: 288, sha256: previewSha } } },
    createVersionId: () => 'lut-version-prisma-2', clock: () => new Date('2026-07-31T11:03:00.000Z'),
  })({ ...request({ idempotencyKey: 'workspace-lut-prisma-version-2', name: 'Prisma V2' }), baseVersion: 1 })
  assert.equal(next.value.record.currentVersion.version, 2)
  assert.equal(versions.length, 2)
  const statusService = setWorkspaceLutStatusService({ repository, createCommandId: () => 'lut-status-prisma-1', clock: () => new Date('2026-07-31T11:04:00.000Z') })
  const statusInput = {
    workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', baseRevision: 1, status: 'inactive', actor: actor(), idempotencyKey: 'workspace-lut-prisma-status-1',
  }
  const status = await statusService(statusInput)
  assert.equal(status.record.revision, 2)
  assert.equal(statusCommands.length, 1)
  head = { ...head, status: 'active', revision: 3 }
  const exactReplay = await statusService(statusInput)
  assert.equal(exactReplay.record.status, 'inactive')
  assert.equal(exactReplay.record.revision, 2)
  assert.equal(exactReplay.record.currentVersion.id, 'lut-version-prisma-2')
  const defaultResult = await setWorkspaceLutDefaultService({ repository, createVersionId: () => 'lut-default-prisma-1', clock: () => new Date('2026-07-31T11:05:00.000Z') })({
    workspaceId: 'workspace-lut-test', baseRevision: 0, selection: { mode: 'lut-version', lutId: 'lut-cinema-test', version: 2 }, actor: actor(), idempotencyKey: 'workspace-lut-default-prisma-1',
  })
  assert.equal(defaultResult.value.lutVersion.id, 'lut-version-prisma-2')
  for (const row of [versions[0], versions[1], statusCommands[0], defaultVersions[0]]) {
    assert.equal(row.actorCredentialId, 'credential-lut-test')
    assert.equal(row.actorEnvironment, 'sandbox')
    assert.equal(row.actorAuthenticationKind, 'bearer')
    assert.match(row.actorContextHash, /^[a-f0-9]{64}$/)
  }
  assert.equal((await repository.readDefault({ workspaceId: 'workspace-lut-test' })).revision, 1)
  assert.equal((await repository.readVersion({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1 })).version, 1)
  versions[0].actorCredentialId = 'credential-lut-tampered'
  await assert.rejects(
    repository.readVersion({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1 }),
    /actor audit/,
  )
  versions[0].actorCredentialId = 'credential-lut-test'
  versions[0].previewPng = Buffer.from([0])
  await assert.rejects(repository.readPreview({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1 }), /integrity/)
})
