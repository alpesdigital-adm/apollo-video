import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { readPublicEventFeedService } from '../../src/v2/application/read-public-event-feed.ts'
import {
  PROJECT_DASHBOARD_EVENT_TYPES,
  PUBLIC_EVENT_FEED_FLOOR_ID,
  PUBLIC_EVENT_FEED_SAFETY_MARGIN_MS,
} from '../../src/v2/domain/public-event-feed.ts'
import { createPublicEvent } from '../../src/v2/domain/public-event.ts'
import { persistPublicEvents } from '../../src/v2/infrastructure/prisma/public-event-outbox.ts'
import { PrismaPublicEventFeedRepository } from '../../src/v2/infrastructure/prisma/public-event-feed-repository.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { presentPublicEventFeed, presentSuccess } from '../../src/v2/public-api/presenters.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const WORKSPACE = 'w36-unit-workspace'
const OTHER_WORKSPACE = 'w36-unit-other-workspace'

test('W36 non-project operations are omitted without trapping the cursor on a filtered full page', async () => {
  const entries = [1, 2].map((index) => ({ event: createPublicEvent({
    id: uuid(index), type: 'operation.status.changed', version: '1.0.0', workspaceId: WORKSPACE,
    occurredAt: '2026-10-05T12:00:00.000Z', resource: { type: 'operation', id: `w36-operation-${index}` },
    data: { status: 'running', ...(index === 2 ? { projectId: 'w36-project' } : {}) },
  }), position: { id: uuid(index), createdAt: `2026-10-05T12:00:0${index}.000Z` } }))
  const read = readPublicEventFeedService({ feed: {
    async readCommittedWatermark() { return '2026-10-05T12:00:10.000Z' },
    async listCommitted({ after }) { return after ? entries.filter((entry) => entry.position.id > after.id) : entries },
  } })
  const first = await read({ workspaceId: WORKSPACE, limit: 1 })
  assert.deepEqual(first.events, [])
  assert.equal(first.hasMore, true)
  const second = await read({ workspaceId: WORKSPACE, limit: 1, after: first.nextCursor })
  assert.equal(second.events[0].id, uuid(2))
  assert.equal(second.hasMore, false)
  assert.notEqual(first.nextCursor, second.nextCursor)
})

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function renameEvent(index, workspaceId = WORKSPACE) {
  return createPublicEvent({
    id: uuid(index), type: 'project.name.changed', version: '1.0.0',
    workspaceId, occurredAt: '2026-10-04T12:00:00.000Z', sequence: index + 1,
    actor: { clientId: 'w36-client-1' },
    resource: { type: 'project', id: `w36-project-${index}` },
    data: { action: 'rename', baseRevision: index, resultRevision: index + 1 },
  })
}

/**
 * In-memory model of the repository contract: rows carry the database
 * `createdAt` (transaction start) and become visible only when committed; the
 * watermark is the earliest start among open transactions minus the margin.
 */
function modelFeed() {
  let clock = Date.parse('2026-10-04T12:00:00.000Z')
  const committed = []
  const open = new Map()
  return {
    tick(ms) { clock += ms },
    begin(name) { open.set(name, clock) },
    commit(name, event, workspaceId = WORKSPACE) {
      const createdAt = new Date(open.get(name)).toISOString()
      open.delete(name)
      committed.push({ event, workspaceId, createdAt })
    },
    repository: {
      calls: [],
      async readCommittedWatermark() {
        const starts = [clock, ...open.values()]
        return new Date(Math.min(...starts) - PUBLIC_EVENT_FEED_SAFETY_MARGIN_MS).toISOString()
      },
      async listCommitted(input) {
        this.calls.push(input)
        const rows = committed
          .filter((row) => row.workspaceId === input.workspaceId &&
            input.types.includes(row.event.type) &&
            Date.parse(row.createdAt) < Date.parse(input.committedBefore) &&
            (!input.after ||
              Date.parse(row.createdAt) > Date.parse(input.after.createdAt) ||
              (row.createdAt === input.after.createdAt && row.event.id > input.after.id)))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.event.id.localeCompare(b.event.id))
          .slice(0, input.limit)
        return rows.map((row) => ({
          event: row.event, position: { createdAt: row.createdAt, id: row.event.id },
        }))
      },
    },
  }
}

test('F1.001 event feed: startAt=latest follows only new events and history never replays', async () => {
  const model = modelFeed()
  model.begin('old'); model.tick(5); model.commit('old', renameEvent(1))
  model.tick(1000)
  const read = readPublicEventFeedService({ feed: model.repository })
  const head = await read({ workspaceId: WORKSPACE, startAt: 'latest' })
  assert.deepEqual(head.events, [])
  assert.equal(head.hasMore, false)
  model.begin('new'); model.tick(3); model.commit('new', renameEvent(2))
  model.tick(1000)
  const page = await read({ workspaceId: WORKSPACE, after: head.nextCursor })
  assert.deepEqual(page.events.map((event) => event.id), [uuid(2)])
  const again = await read({ workspaceId: WORKSPACE, after: page.nextCursor })
  assert.deepEqual(again.events, [])
})

test('F1.001 event feed: a late-committing transaction is never skipped behind the cursor', async () => {
  // MODEL of the commit-safety rule; the PostgreSQL proof is in
  // public-event-feed.integration.mjs.
  const model = modelFeed()
  const read = readPublicEventFeedService({ feed: model.repository })
  const head = await read({ workspaceId: WORKSPACE, startAt: 'latest' })
  model.begin('slow')            // starts first, commits last
  model.tick(10)
  model.begin('fast')            // starts later, commits first
  model.tick(10)
  model.commit('fast', renameEvent(2))
  model.tick(500)
  const first = await read({ workspaceId: WORKSPACE, after: head.nextCursor })
  assert.deepEqual(first.events, [], 'rows behind an open transaction are withheld')
  model.commit('slow', renameEvent(1))
  model.tick(500)
  const second = await read({ workspaceId: WORKSPACE, after: first.nextCursor })
  assert.deepEqual(
    second.events.map((event) => event.id), [uuid(1), uuid(2)],
    'late row is delivered, in createdAt order, after its transaction commits',
  )
})

test('F1.001 event feed: truncated pages keep the cursor on the last row and never skip or repeat', async () => {
  const model = modelFeed()
  const read = readPublicEventFeedService({ feed: model.repository })
  const head = await read({ workspaceId: WORKSPACE, startAt: 'latest' })
  for (let index = 1; index <= 5; index += 1) {
    model.begin(`t${index}`); model.tick(2); model.commit(`t${index}`, renameEvent(index))
    model.tick(1)
  }
  model.tick(500)
  const seen = []
  let cursor = head.nextCursor
  const sizes = []
  for (let guard = 0; guard < 6; guard += 1) {
    const page = await read({ workspaceId: WORKSPACE, after: cursor, limit: 2 })
    sizes.push(page.events.length)
    seen.push(...page.events.map((event) => event.id))
    cursor = page.nextCursor
    if (!page.hasMore) break
  }
  assert.deepEqual(sizes, [2, 2, 1])
  assert.deepEqual(seen, [1, 2, 3, 4, 5].map(uuid))
})

test('F1.001 event feed: workspace isolation, type allowlist and cursor binding', async () => {
  const model = modelFeed()
  const read = readPublicEventFeedService({ feed: model.repository })
  const head = await read({ workspaceId: WORKSPACE, startAt: 'latest' })
  model.begin('mine'); model.tick(1); model.commit('mine', renameEvent(1))
  model.begin('theirs'); model.tick(1); model.commit('theirs', renameEvent(2, OTHER_WORKSPACE), OTHER_WORKSPACE)
  model.tick(500)
  const page = await read({ workspaceId: WORKSPACE, after: head.nextCursor })
  assert.deepEqual(page.events.map((event) => event.workspaceId), [WORKSPACE])
  assert.equal(model.repository.calls.at(-1).workspaceId, WORKSPACE)
  assert.deepEqual(model.repository.calls.at(-1).types, [...PROJECT_DASHBOARD_EVENT_TYPES])
  await assert.rejects(
    read({ workspaceId: OTHER_WORKSPACE, after: head.nextCursor }),
    (error) => error.code === 'INVALID_ARGUMENT' && /does not match/.test(error.message),
  )
})

test('F1.001 event feed rejects tampered, malformed, future and combined cursors and bad limits', async () => {
  const model = modelFeed()
  const read = readPublicEventFeedService({ feed: model.repository })
  const head = await read({ workspaceId: WORKSPACE, startAt: 'latest' })
  const decoded = JSON.parse(Buffer.from(head.nextCursor, 'base64url').toString('utf8'))
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const invalid = [
    'x', '!!!!!!!!!!', 'a'.repeat(2000),
    Buffer.from('not json').toString('base64url'),
    encode({ ...decoded, v: 2 }),
    encode({ ...decoded, extra: true }),
    encode({ ...decoded, queryHash: 'f'.repeat(64) }),
    encode({ ...decoded, id: 'not-a-uuid' }),
    encode({ ...decoded, createdAt: 'yesterday' }),
    encode({ ...decoded, createdAt: '2036-10-04T12:00:00.000Z' }),
  ]
  for (const after of invalid) {
    await assert.rejects(
      read({ workspaceId: WORKSPACE, after }),
      (error) => error.code === 'INVALID_ARGUMENT',
      `cursor ${after.slice(0, 16)} must be rejected`,
    )
  }
  for (const limit of [0, 101, 1.5, Number.NaN]) {
    await assert.rejects(read({ workspaceId: WORKSPACE, limit }), (e) => e.code === 'INVALID_ARGUMENT')
  }
  await assert.rejects(read({ workspaceId: WORKSPACE, startAt: 'oldest' }), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(
    read({ workspaceId: WORKSPACE, startAt: 'latest', after: head.nextCursor }),
    (e) => e.code === 'INVALID_ARGUMENT',
  )
  assert.equal(decoded.id, PUBLIC_EVENT_FEED_FLOOR_ID)
})

test('F1.001 Prisma feed repository derives the watermark from open transactions and queries by (createdAt, id)', async () => {
  const executed = []
  const client = {
    async $queryRaw(query) {
      executed.push(query)
      return [{ watermark: new Date('2026-10-04T12:00:00.000Z') }]
    },
    v2PublicEventOutbox: {
      async findMany(input) { executed.push(input); return [] },
    },
  }
  const repository = new PrismaPublicEventFeedRepository(client)
  assert.equal(await repository.readCommittedWatermark(), '2026-10-04T12:00:00.000Z')
  const sql = executed[0].strings.join('?')
  assert.match(sql, /pg_stat_activity/)
  assert.match(sql, /min\(xact_start\)/)
  assert.match(sql, /backend_type = 'client backend'/)
  assert.match(sql, /datname = current_database\(\)/)
  await repository.listCommitted({
    workspaceId: WORKSPACE, types: ['project.name.changed'],
    after: { createdAt: '2026-10-04T11:00:00.000Z', id: uuid(1) },
    committedBefore: '2026-10-04T12:00:00.000Z', limit: 11,
  })
  const query = executed[1]
  assert.equal(query.where.workspaceId, WORKSPACE)
  assert.deepEqual(query.where.type, { in: ['project.name.changed'] })
  assert.deepEqual(query.where.createdAt, { lt: new Date('2026-10-04T12:00:00.000Z') })
  assert.deepEqual(query.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }])
  assert.equal(query.take, 11)
  assert.equal(query.where.OR.length, 2)

  const unavailable = new PrismaPublicEventFeedRepository({
    async $queryRaw() { return [{ watermark: null }] },
  })
  await assert.rejects(
    unavailable.readCommittedWatermark(),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
})

test('F1.001 outbox writers never set createdAt, so it stays the database transaction start', async () => {
  let data
  await persistPublicEvents({
    v2PublicEventOutbox: { async createMany(input) { data = input.data } },
  }, [renameEvent(1)])
  assert.equal(data.length, 1)
  assert.equal('createdAt' in data[0], false)
  const creation = readFileSync(
    new URL('../../src/v2/infrastructure/prisma/project-creation-repository.ts', import.meta.url), 'utf8',
  )
  const block = creation.slice(creation.indexOf('v2PublicEventOutbox.createMany'))
  assert.equal(/createdAt/.test(block.slice(0, block.indexOf('})') + 2)), false)
})

test('F1.001 capability, schema and presenter agree and expose only a refetch signal', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.events.feed.list')
  assert.ok(capability)
  assert.deepEqual(capability.endpoint, { method: 'GET', path: '/v1/events/feed' })
  assert.equal(capability.authMode, 'required')
  assert.deepEqual(capability.requiredScopes, ['projects:read'])
  assert.equal(capability.operationKind, 'query')
  assert.deepEqual(capability.queryParameters.map((parameter) => parameter.name), ['limit', 'after', 'startAt'])
  const schema = getPublicSchema(capability.outputSchemaRef)
  const validate = addFormats(new Ajv2020({ strict: true, allErrors: true })).compile(schema.schema)
  const body = presentSuccess(presentPublicEventFeed({
    events: [renameEvent(1)],
    nextCursor: 'bm90LWEtcmVhbC1jdXJzb3I', hasMore: false,
    watermark: '2026-10-04T12:00:00.000Z',
  }))
  assert.equal(validate(body), true, JSON.stringify(validate.errors))
  const foreign = structuredClone(body)
  foreign.data.events[0].type = 'budget.threshold.reached'
  assert.equal(validate(foreign), false, 'only dashboard invalidation events are served')
  const extra = structuredClone(body)
  extra.data.unexpected = true
  assert.equal(validate(extra), false)
  const route = readFileSync(new URL('../../src/app/v1/events/feed/route.ts', import.meta.url), 'utf8')
  assert.ok(route.indexOf('authenticateExternalRequest') < route.indexOf('createPublicEventFeedRepository()'))
  assert.match(route, /requireScope\(actor, 'projects:read'\)/)
  assert.match(route, /workspaceId: actor\.workspaceId/)
})

test('F1.001 dashboard follows the feed without synthetic events or event-derived cards', () => {
  const dashboard = readFileSync(new URL('../../src/app/ProjectsPageClient.tsx', import.meta.url), 'utf8')
  assert.match(dashboard, /useProjectEventFeed\(/)
  assert.match(dashboard, /apollo:project-updated/)
  assert.doesNotMatch(dashboard, /dispatchEvent/)
  const hook = readFileSync(new URL('../../src/app/useProjectEventFeed.ts', import.meta.url), 'utf8')
  assert.match(hook, /fetch\(`\/v1\/events\/feed\?/)
  assert.doesNotMatch(hook, /setProjects|dispatchEvent|EventSource|WebSocket/)
})
