import assert from 'node:assert/strict'
import test from 'node:test'

import { buildScopeWorld, scopeTokens } from './helpers/capture-scope-world.mjs'

/**
 * T-FR-143/145/147/149 - the capture persistence families are workspace-scoped.
 *
 * A capture session, a track, a source and a marker are named by the caller, so
 * two workspaces can both call theirs "camera-main". Every row id these
 * repositories used to build from such a token alone (`<track>:coverage`,
 * `<session>:clock`, `<session>:v<n>`, ...) was a global primary key, and the
 * writers that upserted by that id could replace another workspace's row
 * instead of failing.
 *
 * The repositories take their Prisma client by constructor, so this runs them
 * against an in-memory client that enforces the one thing the old ids relied on
 * the database to forgive: a primary key (`id`) is unique across the whole
 * table, whatever the workspace. The PostgreSQL round trip of the same scenario
 * is in sync-diagnostic-persistence.e2e.mjs.
 */

class UniqueViolation extends Error {
  constructor(model, target) {
    super(`Unique constraint failed on ${model}: ${target}`)
    this.code = 'P2002'
  }
}

/** `{ workspaceId_trackId: { workspaceId, trackId } }` becomes `{ workspaceId, trackId }`. */
function flatten(where) {
  const flat = {}
  for (const [key, value] of Object.entries(where ?? {})) {
    const compound = key.includes('_') && value !== null && typeof value === 'object' && !(value instanceof Date)
    if (compound) Object.assign(flat, flatten(value))
    else if (value === null || typeof value !== 'object' || value instanceof Date) flat[key] = value
  }
  return flat
}

/** The workspace a `where` pins the statement to, directly or through a compound key. */
function pinnedWorkspace(where) {
  return flatten(where).workspaceId ?? null
}

/** The `@@unique` constraints of prisma/v2/schema.prisma, besides the primary key. */
const NATURAL_KEYS = {
  v2CaptureSessionVersion: ['workspaceId', 'sessionId', 'version'],
  v2CaptureSessionHead: ['sessionId', 'workspaceId'],
  v2CaptureSessionClock: ['sessionId', 'workspaceId'],
  v2CaptureClockMap: ['workspaceId', 'sessionId', 'sourceId'],
  v2CaptureClockMapPiece: ['workspaceId', 'mapId', 'ordinal'],
  v2CaptureTrackCoverage: ['workspaceId', 'trackId'],
  v2CaptureSyncEvidence: ['workspaceId', 'sessionId', 'trackId'],
  v2CaptureSessionProtocol: ['sessionId', 'workspaceId'],
  v2CaptureProtocolEvaluation: ['workspaceId', 'sessionId', 'sessionVersion', 'protocolId', 'protocolVersion'],
  v2SyncMarker: ['workspaceId', 'sessionId', 'sequence'],
  v2SyncMarkerDetection: ['workspaceId', 'markerId', 'trackId'],
  v2SyncDiagnostic: ['workspaceId', 'sessionId', 'version'],
  v2SyncDiagnosticHead: ['sessionId', 'workspaceId'],
}

function memoryPrisma() {
  const tables = new Map()
  const calls = []
  const table = (model) => {
    if (!tables.has(model)) tables.set(model, [])
    return tables.get(model)
  }
  const matches = (row, where) => Object.entries(flatten(where)).every(([key, value]) =>
    row[key] instanceof Date && value instanceof Date ? row[key].getTime() === value.getTime() : row[key] === value)

  const create = (model, data) => {
    if (table(model).some((row) => row.id === data.id)) throw new UniqueViolation(model, `id = ${data.id}`)
    const natural = NATURAL_KEYS[model]
    if (natural && table(model).some((row) => natural.every((key) => row[key] === data[key]))) {
      throw new UniqueViolation(model, `(${natural.join(', ')})`)
    }
    const row = { ...data }
    table(model).push(row)
    return { ...row }
  }

  const delegate = (model) => ({
    async create({ data }) {
      calls.push({ model, op: 'create', args: { data } })
      return create(model, data)
    },
    async createMany(args) {
      calls.push({ model, op: 'createMany', args })
      for (const data of args.data) create(model, data)
      return { count: args.data.length }
    },
    async upsert(args) {
      calls.push({ model, op: 'upsert', args })
      const found = table(model).find((row) => matches(row, args.where))
      if (!found) return create(model, args.create)
      if (args.update.id !== undefined && args.update.id !== found.id
        && table(model).some((row) => row.id === args.update.id)) {
        throw new UniqueViolation(model, `id = ${args.update.id}`)
      }
      Object.assign(found, args.update)
      return { ...found }
    },
    async update(args) {
      calls.push({ model, op: 'update', args })
      const found = table(model).find((row) => matches(row, args.where))
      if (!found) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' })
      Object.assign(found, args.data)
      return { ...found }
    },
    async updateMany(args) {
      calls.push({ model, op: 'updateMany', args })
      const found = table(model).filter((row) => matches(row, args.where))
      for (const row of found) Object.assign(row, args.data)
      return { count: found.length }
    },
    async deleteMany(args) {
      calls.push({ model, op: 'deleteMany', args })
      const gone = table(model).filter((row) => matches(row, args.where))
      const keep = table(model).filter((row) => !matches(row, args.where))
      tables.set(model, keep)
      if (model === 'v2CaptureClockMap') {
        // ON DELETE CASCADE on (mapId, workspaceId) -> (id, workspaceId).
        tables.set('v2CaptureClockMapPiece', table('v2CaptureClockMapPiece').filter((piece) =>
          !gone.some((map) => map.id === piece.mapId && map.workspaceId === piece.workspaceId)))
      }
      return { count: gone.length }
    },
    async findFirst(args = {}) {
      calls.push({ model, op: 'findFirst', args })
      const found = table(model).find((row) => matches(row, args.where))
      if (!found) return null
      const row = { ...found }
      // The foreign key `(mapId, workspaceId) -> (id, workspaceId)` is what makes
      // a piece belong to a map, so the join is done on both columns.
      if (model === 'v2CaptureClockMap' && args.include?.pieces) {
        row.pieces = table('v2CaptureClockMapPiece')
          .filter((piece) => piece.mapId === found.id && piece.workspaceId === found.workspaceId)
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((piece) => ({ ...piece }))
      }
      return row
    },
    async findMany(args = {}) {
      calls.push({ model, op: 'findMany', args })
      return table(model).filter((row) => matches(row, args.where)).map((row) => ({ ...row }))
    },
  })

  const client = new Proxy({}, {
    get(_target, property) {
      if (property === '$transaction') return (callback) => callback(client)
      return delegate(String(property))
    },
  })
  return { client, calls, table }
}

test('T-FR-143/145/147/149 two workspaces with the same capture tokens neither collide nor see each other', async () => {
  const { PrismaCaptureSessionRepository } = await import(
    '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
  )
  const { PrismaCaptureProtocolRepository } = await import(
    '../../src/v2/infrastructure/prisma/capture-protocol-repository.ts'
  )
  const { PrismaSyncDiagnosticRepository } = await import(
    '../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts'
  )

  const { client, calls, table } = memoryPrisma()
  const sessions = new PrismaCaptureSessionRepository(client)
  const protocols = new PrismaCaptureProtocolRepository(client)
  const diagnostics = new PrismaSyncDiagnosticRepository(client)

  const tokens = scopeTokens('pure')
  const owners = []
  for (const variant of [0, 1]) {
    const workspaceId = `scope-workspace-${variant}`
    owners.push({
      variant,
      workspaceId,
      world: await buildScopeWorld({
        workspaceId,
        projectId: `scope-project-${variant}`,
        tokens,
        variant,
      }),
    })
  }
  const [a, b] = owners
  assert.notEqual(a.world.session2.sessionHash, b.world.session2.sessionHash)
  assert.notEqual(a.world.coverage.coverageHash, b.world.coverage.coverageHash)
  assert.notEqual(a.world.clockMap.mapHash, b.world.clockMap.mapHash)
  assert.notEqual(a.world.clock.clockHash, b.world.clock.clockHash)
  assert.notEqual(a.world.evaluation.evaluationHash, b.world.evaluation.evaluationHash)
  assert.notEqual(a.world.diagnostic.diagnosticHash, b.world.diagnostic.diagnosticHash)
  assert.notEqual(a.world.detection.detectionHash, b.world.detection.detectionHash)

  // Each write is attempted whatever happened to the one before it, so a run
  // against a repository that still collides lists every site that does.
  const failures = []
  const step = async (label, action) => {
    try {
      await action()
    } catch (error) {
      failures.push(`${label}: ${error.code ?? error.name} ${error.message}`)
    }
  }

  for (const { variant, workspaceId, world } of owners) {
    const label = `workspace ${variant}`
    const { sessionId } = tokens
    await step(`${label} session version 1`, () =>
      sessions.appendVersion({ session: world.session1, occurredAt: world.at(3) }))
    await step(`${label} session version 2`, () =>
      sessions.appendVersion({ session: world.session2, expectedVersion: 1, occurredAt: world.at(4) }))
    await step(`${label} session clock`, () =>
      sessions.persistClock({ workspaceId, clock: world.clock, createdAt: world.at(5) }))
    await step(`${label} clock map`, () =>
      sessions.persistClockMap({ map: world.clockMap, createdAt: world.at(5) }))
    await step(`${label} coverage`, () =>
      sessions.persistCoverage({ coverage: world.coverage, sessionId, createdAt: world.at(6) }))
    await step(`${label} sync evidence`, () =>
      sessions.persistSyncEvidence({ workspaceId, record: world.evidence, createdAt: world.at(6) }))
    await step(`${label} protocol attachment`, () => protocols.attach({
      workspaceId,
      sessionId,
      protocol: world.protocol,
      attachedByKind: 'human',
      attachedById: world.attachedById,
      attachedAt: world.at(6),
    }))
    await step(`${label} protocol evaluation`, () =>
      protocols.persistEvaluation({ evaluation: world.evaluation, createdAt: world.at(7) }))
    await step(`${label} marker detection`, () =>
      diagnostics.persistDetection({ workspaceId, detection: world.detection, detectedAt: world.at(10) }))
    await step(`${label} diagnostic version 1`, () =>
      diagnostics.appendVersion({ diagnostic: world.diagnostic, occurredAt: world.at(11) }))
  }
  // One row per workspace in every family, and no two rows share a primary key.
  // A statement that silently replaced the other workspace's row throws nothing,
  // so it only shows here, as a table that holds fewer rows than it should.
  const expectedRows = {
    v2CaptureSessionVersion: 4,
    v2CaptureSessionHead: 2,
    v2CaptureSessionClock: 2,
    v2CaptureClockMap: 2,
    v2CaptureClockMapPiece: 2,
    v2CaptureTrackCoverage: 2,
    v2CaptureSyncEvidence: 2,
    v2CaptureSessionProtocol: 2,
    v2CaptureProtocolEvaluation: 2,
    v2SyncMarkerDetection: 2,
    v2SyncDiagnostic: 2,
    v2SyncDiagnosticHead: 2,
  }
  const rowProblems = []
  for (const [model, count] of Object.entries(expectedRows)) {
    const rows = table(model)
    if (rows.length !== count) rowProblems.push(`${model} holds ${rows.length} rows, expected ${count}`)
    for (const owner of owners) {
      if (!rows.some((row) => row.workspaceId === owner.workspaceId)) {
        rowProblems.push(`${model} has no row for ${owner.workspaceId}`)
      }
    }
  }
  const problems = [...failures, ...rowProblems]
  assert.deepEqual(
    problems,
    [],
    `writes that collided, were refused or replaced another workspace's row:\n${problems.join('\n')}`,
  )

  // Each workspace reads back its own aggregates, by value.
  for (const { workspaceId, world } of owners) {
    const { sessionId, trackId, phoneTrackId, sourceId } = tokens
    const head = await sessions.readHead({ workspaceId, sessionId })
    assert.equal(head?.sessionHash, world.session2.sessionHash, `${workspaceId} read another workspace's session`)
    assert.equal((await sessions.readVersion({ workspaceId, sessionId, version: 1 }))?.sessionHash, world.session1.sessionHash)
    assert.equal((await sessions.listVersions({ workspaceId, sessionId })).length, 2)
    assert.equal((await sessions.readClock({ workspaceId, sessionId }))?.clockHash, world.clock.clockHash)
    const map = await sessions.readClockMap({ workspaceId, sessionId, sourceId })
    assert.equal(map?.mapHash, world.clockMap.mapHash, `${workspaceId} read another workspace's clock map`)
    assert.equal(map?.pieces.length, 1, 'a clock map lost its piece')
    assert.equal((await sessions.readCoverage({ workspaceId, trackId }))?.coverageHash, world.coverage.coverageHash)
    assert.deepEqual(
      (await sessions.listCoverage({ workspaceId, sessionId })).map((entry) => entry.coverageHash),
      [world.coverage.coverageHash],
    )
    assert.ok(await sessions.readSyncEvidence({ workspaceId, sessionId, trackId: phoneTrackId }))
    assert.equal((await protocols.readAttachment({ workspaceId, sessionId }))?.attachedById, world.attachedById)
    assert.equal(
      (await protocols.readEvaluation({
        workspaceId,
        sessionId,
        sessionVersion: world.session2.version,
        protocolId: world.protocol.protocolId,
        protocolVersion: world.protocol.version,
      }))?.evaluationHash,
      world.evaluation.evaluationHash,
      `${workspaceId} read or lost its protocol evaluation`,
    )
    assert.equal(
      (await diagnostics.listDetections({ workspaceId, sessionId })).map((entry) => entry.detectionHash).join(),
      world.detection.detectionHash,
    )
    assert.equal((await diagnostics.readHead({ workspaceId, sessionId }))?.diagnosticHash, world.diagnostic.diagnosticHash)
  }

  // A workspace that wrote nothing sees nothing under the very same tokens.
  const stranger = 'scope-workspace-stranger'
  const { sessionId, trackId, sourceId } = tokens
  assert.equal(await sessions.readHead({ workspaceId: stranger, sessionId }), null)
  assert.equal(await sessions.readClock({ workspaceId: stranger, sessionId }), null)
  assert.equal(await sessions.readClockMap({ workspaceId: stranger, sessionId, sourceId }), null)
  assert.equal(await sessions.readCoverage({ workspaceId: stranger, trackId }), null)
  assert.deepEqual(await sessions.listCoverage({ workspaceId: stranger, sessionId }), [])
  assert.equal(await protocols.readAttachment({ workspaceId: stranger, sessionId }), null)
  assert.deepEqual(await diagnostics.listDetections({ workspaceId: stranger, sessionId }), [])
  assert.equal(await diagnostics.readHead({ workspaceId: stranger, sessionId }), null)

  // Attaching a render to a marker that was stored without one is the single
  // statement of these three repositories that updates a row by its id.
  const marker = a.world.marker
  await diagnostics.persistMarker({ marker, createdAt: a.world.at(8) })
  const withArtifact = await diagnostics.persistMarker({
    marker,
    artifact: { artifactId: 'artifact-marker-1', sha256: 'c'.repeat(64), byteSize: 19_650 },
    createdAt: a.world.at(9),
  })
  assert.equal(withArtifact.replayed, true)
  assert.equal(table('v2SyncMarker')[0].artifactId, 'artifact-marker-1')

  // Statements that change or find a row name its workspace, and a re-write
  // never changes a row's primary key.
  const exempt = new Set(['v2CaptureProtocol'])
  const unscoped = calls
    .filter((call) => !exempt.has(call.model))
    .filter((call) => ['upsert', 'update', 'updateMany', 'deleteMany', 'findFirst', 'findMany'].includes(call.op))
    .filter((call) => pinnedWorkspace(call.args.where) === null)
    .map((call) => `${call.model}.${call.op} where ${JSON.stringify(call.args.where)}`)
  assert.deepEqual(unscoped, [], `statements that do not name a workspace:\n${unscoped.join('\n')}`)

  const rewritesKey = calls
    .filter((call) => call.op === 'upsert' && 'id' in call.args.update)
    .map((call) => call.model)
  assert.deepEqual(rewritesKey, [], 'an upsert rewrites the primary key of the row it found')
})

test('T-FR-143/145/147/149 rows stored under the earlier id format stay readable and are rewritten in place', async () => {
  const { PrismaCaptureSessionRepository } = await import(
    '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
  )
  const { PrismaCaptureProtocolRepository } = await import(
    '../../src/v2/infrastructure/prisma/capture-protocol-repository.ts'
  )
  const { PrismaSyncDiagnosticRepository } = await import(
    '../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts'
  )

  const { client, table } = memoryPrisma()
  const sessions = new PrismaCaptureSessionRepository(client)
  const protocols = new PrismaCaptureProtocolRepository(client)
  const diagnostics = new PrismaSyncDiagnosticRepository(client)

  const tokens = scopeTokens('legacy')
  const { sessionId, trackId, phoneTrackId, sourceId } = tokens
  const workspaceId = 'scope-workspace-legacy'
  const projectId = 'scope-project-legacy'
  const first = await buildScopeWorld({ workspaceId, projectId, tokens, variant: 0 })
  const second = await buildScopeWorld({ workspaceId, projectId, tokens, variant: 1 })

  await sessions.appendVersion({ session: first.session1, occurredAt: first.at(3) })
  await sessions.persistClock({ workspaceId, clock: first.clock, createdAt: first.at(5) })
  await sessions.persistClockMap({ map: first.clockMap, createdAt: first.at(5) })
  await sessions.persistCoverage({ coverage: first.coverage, sessionId, createdAt: first.at(6) })
  await sessions.persistSyncEvidence({ workspaceId, record: first.evidence, createdAt: first.at(6) })
  await protocols.attach({
    workspaceId,
    sessionId,
    protocol: first.protocol,
    attachedByKind: 'human',
    attachedById: first.attachedById,
    attachedAt: first.at(6),
  })
  await protocols.persistEvaluation({ evaluation: first.evaluation, createdAt: first.at(7) })
  await diagnostics.persistDetection({ workspaceId, detection: first.detection, detectedAt: first.at(10) })
  await diagnostics.appendVersion({ diagnostic: first.diagnostic, occurredAt: first.at(11) })

  // Put the database back the way it was before ids were workspace-scoped: the
  // formats the repositories used to build, global primary keys included.
  const legacy = {
    v2CaptureSessionVersion: (row) => `${row.sessionId}:v${row.version}`,
    v2CaptureSessionHead: (row) => row.sessionId,
    v2CaptureSessionClock: (row) => `${row.sessionId}:clock`,
    v2CaptureClockMap: (row) => `${row.sessionId}:${row.sourceId}`,
    v2CaptureTrackCoverage: (row) => `${row.trackId}:coverage`,
    v2CaptureSyncEvidence: (row) => `${row.sessionId}:${row.trackId}:sync`,
    v2CaptureSessionProtocol: (row) => `${row.sessionId}:protocol`,
    v2CaptureProtocolEvaluation: (row) =>
      `${row.sessionId}:v${row.sessionVersion}:${row.protocolId}:v${row.protocolVersion}`,
    v2SyncMarkerDetection: (row) => `${row.markerId}:${row.trackId}`,
    v2SyncDiagnostic: (row) => `${row.sessionId}:d${row.version}`,
    v2SyncDiagnosticHead: (row) => row.sessionId,
  }
  const mapIds = new Map()
  for (const [model, idOf] of Object.entries(legacy)) {
    for (const row of table(model)) {
      if (model === 'v2CaptureClockMap') mapIds.set(row.id, idOf(row))
      row.id = idOf(row)
    }
  }
  for (const piece of table('v2CaptureClockMapPiece')) {
    piece.mapId = mapIds.get(piece.mapId)
    piece.id = `${piece.mapId}:${piece.pieceId}`
  }
  const idsBefore = Object.fromEntries(Object.keys(legacy).map((model) => [model, table(model).map((row) => row.id)]))

  // Readable by the workspace and the natural key, whatever id the row carries.
  assert.equal((await sessions.readHead({ workspaceId, sessionId }))?.sessionHash, first.session1.sessionHash)
  assert.equal((await sessions.readClock({ workspaceId, sessionId }))?.clockHash, first.clock.clockHash)
  assert.equal((await sessions.readClockMap({ workspaceId, sessionId, sourceId }))?.mapHash, first.clockMap.mapHash)
  assert.equal((await sessions.readCoverage({ workspaceId, trackId }))?.coverageHash, first.coverage.coverageHash)
  assert.ok(await sessions.readSyncEvidence({ workspaceId, sessionId, trackId: phoneTrackId }))
  assert.equal((await protocols.readAttachment({ workspaceId, sessionId }))?.attachedById, first.attachedById)
  assert.equal((await diagnostics.readHead({ workspaceId, sessionId }))?.diagnosticHash, first.diagnostic.diagnosticHash)

  // A re-write replaces what the row says and neither moves its primary key nor
  // adds a second row.
  await sessions.persistCoverage({ coverage: first.coverage, sessionId, createdAt: first.at(8) })
  await sessions.persistCoverage({ coverage: second.coverage, sessionId, createdAt: first.at(9) })
  assert.equal((await sessions.readCoverage({ workspaceId, trackId }))?.coverageHash, second.coverage.coverageHash)
  await sessions.persistSyncEvidence({ workspaceId, record: second.evidence, createdAt: first.at(9) })
  await protocols.persistEvaluation({ evaluation: second.evaluation, createdAt: first.at(9) })
  assert.equal(
    (await protocols.readEvaluation({
      workspaceId,
      sessionId,
      sessionVersion: second.evaluation.sessionVersion,
      protocolId: second.protocol.protocolId,
      protocolVersion: second.protocol.version,
    }))?.evaluationHash,
    second.evaluation.evaluationHash,
  )
  await diagnostics.persistDetection({ workspaceId, detection: second.detection, detectedAt: first.at(10) })
  await protocols.attach({
    workspaceId,
    sessionId,
    protocol: second.protocol,
    attachedByKind: 'human',
    attachedById: second.attachedById,
    attachedAt: first.at(9),
  })
  assert.equal((await protocols.readAttachment({ workspaceId, sessionId }))?.attachedById, second.attachedById)
  assert.equal((await sessions.persistClock({ workspaceId, clock: first.clock, createdAt: first.at(9) })).replayed, true)

  for (const [model, ids] of Object.entries(idsBefore)) {
    assert.deepEqual(table(model).map((row) => row.id), ids, `${model} changed its stored ids or its row count`)
  }

  // A map is replaced through its natural key, so the legacy-id map goes and the
  // new one takes its place with its pieces; the chain continues past version 1.
  await sessions.persistClockMap({ map: second.clockMap, createdAt: first.at(9) })
  assert.equal(table('v2CaptureClockMap').length, 1)
  assert.equal(table('v2CaptureClockMapPiece').length, 1)
  assert.equal(table('v2CaptureClockMapPiece')[0].mapId, table('v2CaptureClockMap')[0].id)
  assert.equal((await sessions.readClockMap({ workspaceId, sessionId, sourceId }))?.mapHash, second.clockMap.mapHash)

  await sessions.appendVersion({ session: first.session2, expectedVersion: 1, occurredAt: first.at(4) })
  assert.equal((await sessions.readHead({ workspaceId, sessionId }))?.sessionHash, first.session2.sessionHash)
  assert.equal((await sessions.listVersions({ workspaceId, sessionId })).length, 2)
})

test('T-FR-143 a scoped row id is injective, bounded, and cannot equal a caller-chosen identifier', async () => {
  const { scopedRowId } = await import('../../src/v2/infrastructure/prisma/scoped-row-id.ts')
  const domainIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

  const id = scopedRowId('csh', 'workspace-1', 'session-1')
  assert.equal(scopedRowId('csh', 'workspace-1', 'session-1'), id, 'the id is not stable')
  assert.notEqual(scopedRowId('csh', 'workspace-2', 'session-1'), id, 'two workspaces share an id')
  assert.notEqual(scopedRowId('csc', 'workspace-1', 'session-1'), id, 'two row kinds share an id')

  // A separator-joined encoding cannot tell these apart; an array cannot fail to.
  assert.notEqual(scopedRowId('ccp', 'w', 'a:b', 'c'), scopedRowId('ccp', 'w', 'a', 'b:c'))
  assert.notEqual(scopedRowId('ccp', 'w:a', 'b', 'c'), scopedRowId('ccp', 'w', 'a:b', 'c'))
  assert.notEqual(scopedRowId('csv', 'w', 's', 1), scopedRowId('csv', 'w', 's', '1'))

  const longest = 'x'.repeat(128)
  assert.ok(scopedRowId('cpe', longest, longest, 1, longest, 1).length <= 128, 'a long token overflows the column')
  assert.equal(domainIdentifier.test(id), false, 'a scoped id could equal an identifier a caller chose')

  assert.throws(() => scopedRowId('csh', '', 'session-1'), TypeError)
  assert.throws(() => scopedRowId('csh', 'workspace-1'), TypeError)
  assert.throws(() => scopedRowId('csh', 'workspace-1', ''), TypeError)
  assert.throws(() => scopedRowId('NOPE', 'workspace-1', 'session-1'), TypeError)
})
