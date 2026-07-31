import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { importWorkspaceLutService } from '../../src/v2/application/workspace-luts.ts'
import { createWorkspaceLutVersion, parseCube3d } from '../../src/v2/domain/workspace-lut.ts'
import { parseImportWorkspaceLutBody, presentWorkspaceLut } from '../../src/v2/public-api/workspace-lut-contract.ts'
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

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', name: 'Coração 🎞️', owner: 'Apollo Studio',
    license: { policy: 'owned', name: 'Propriedade do workspace' }, tags: ['Cinema', 'coração'],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.75,
    cubeContent: identityCube, actor: { type: 'api-client', id: 'client-lut-test' }, idempotencyKey: 'workspace-lut-import-1',
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
  assert.equal(persisted.previewPng, png)
  const publicValue = presentWorkspaceLut(first.value.record)
  assert.equal('canonicalContent' in publicValue.currentVersion.cube, false)
  assert.match(publicValue.currentVersion.preview.path, /\/preview$/)
  await assert.rejects(service(request({ name: 'Outra LUT' })), /another LUT import/)
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

test('T-FR-181 Prisma adapter commits head/version/preview atomically and detects preview tamper', async () => {
  let head
  let version
  const client = {
    v2WorkspaceLutVersion: {
      async findUnique({ where }) {
        if (where.workspaceId_createdByClientId_idempotencyKey) return version ?? null
        if (where.workspaceId_lutId_version) return version && version.version === where.workspaceId_lutId_version.version ? { previewPng: version.previewPng, previewSha256: version.previewSha256 } : null
        return null
      },
      async findFirst() { return version ?? null }, async findMany() { return version ? [version] : [] },
    },
    v2WorkspaceLut: { async findUnique() { return head ?? null }, async findMany() { return head ? [head] : [] } },
    async $transaction(action) {
      return action({
        v2Workspace: { async findFirst() { return { id: 'workspace-lut-test' } } },
        v2ApiClient: { async findFirst() { return { id: 'client-lut-test' } } },
        v2WorkspaceLut: {
          async findUnique() { return head ?? null },
          async create({ data }) { head = { ...data, currentVersionId: null }; return head },
          async update({ data }) { head = { ...head, ...data }; return head },
        },
        v2WorkspaceLutVersion: { async create({ data }) { version = { ...data }; return version } },
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
  assert.equal((await repository.read({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test' })).currentVersion.recordHash, version.recordHash)
  assert.equal((await repository.readPreview({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1 })).sha256, previewSha)
  version.previewPng = Buffer.from([0])
  await assert.rejects(repository.readPreview({ workspaceId: 'workspace-lut-test', lutId: 'lut-cinema-test', version: 1 }), /integrity/)
})
