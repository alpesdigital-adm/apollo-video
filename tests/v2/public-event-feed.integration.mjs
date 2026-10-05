import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

// W36 contract proof of GET /v1/events/feed on real PostgreSQL and a real
// `next start` HTTP server: authentication, scope, capability policy, workspace
// isolation, cursor tampering, ordering and a REAL late-committing writer.

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Next server did not become ready')
}

async function stopOwnedServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const terminal = (ms) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
  child.kill('SIGTERM')
  if (await terminal(3000)) return
  child.kill('SIGKILL')
  assert.equal(await terminal(3000), true, 'owned Next server did not reach terminal state')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('W36 persisted project event feed is authenticated, workspace-scoped, commit-safe and tamper-evident', async (t) => {
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

  const client = new PrismaClient()
  const extraClients = []
  const workspaceA = 'w36-feed-workspace-a'
  const workspaceB = 'w36-feed-workspace-b'
  const workspaceIds = [workspaceA, workspaceB]
  const writerId = 'w36-feed-writer-a'
  const readerOnlyId = 'w36-feed-noscope-a'
  const deniedId = 'w36-feed-denied-a'
  const writerBId = 'w36-feed-writer-b'
  let server
  let serverDiagnostics = ''

  const cleanup = async () => {
    const where = { workspaceId: { in: workspaceIds } }
    await client.v2ProjectAdministrationCommand.deleteMany({ where })
    await client.v2PublicEventOutbox.deleteMany({ where })
    await client.v2IdempotencyRecord.deleteMany({ where })
    await client.v2ApiAccessCommand.deleteMany({ where })
    await client.v2ProjectCreationCommand.deleteMany({ where })
    await client.v2Project.deleteMany({ where })
    await client.v2ApiAdministrationCommand.deleteMany({ where })
    await client.v2GovernancePolicyCommand.deleteMany({ where })
    await client.v2ApiCredential.deleteMany({ where })
    await client.v2ApiClient.deleteMany({ where })
    await client.v2Workspace.deleteMany({ where: { id: { in: workspaceIds } } })
  }

  try {
    await cleanup()
    const workspaces = new PrismaWorkspaceRepository(client)
    for (const [id, name] of [[workspaceA, 'W36 Feed A'], [workspaceB, 'W36 Feed B']]) {
      await workspaces.create(createWorkspace({
        id, slug: id, name, status: 'active', createdAt: '2026-10-04T12:00:00.000Z',
      }))
    }
    const issue = (id, workspaceId, scopes) => createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date('2026-10-04T12:01:00.000Z'),
    })({
      id, credentialId: `${id}-credential`, workspaceId, name: id,
      environment: 'production', scopes,
    })
    const writer = await issue(writerId, workspaceA, ['projects:read', 'projects:write'])
    const noScope = await issue(readerOnlyId, workspaceA, ['artifacts:read'])
    const denied = await issue(deniedId, workspaceA, ['projects:read', 'projects:write'])
    const writerB = await issue(writerBId, workspaceB, ['projects:read', 'projects:write'])
    const bearer = (issued) => ({ authorization: `Bearer ${issued.token}` })

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-p', String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production',
          APOLLO_API_CAPABILITY_POLICY_JSON: JSON.stringify({
            byClient: { [deniedId]: ['apollo.events.feed.list'] },
          }),
          APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '2000000000',
          APOLLO_GOVERNANCE_ANOMALY_SPEND_MINIMUM_MINOR_UNITS: '2000000000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const retain = (chunk) => {
      serverDiagnostics = `${serverDiagnostics}${chunk.toString('utf8')}`.slice(-64 * 1024)
    }
    server.stdout.on('data', retain)
    server.stderr.on('data', retain)
    await waitForServer(baseUrl, server)

    const feed = async (headers, query = '') => {
      const response = await fetch(`${baseUrl}/v1/events/feed${query ? `?${query}` : ''}`, { headers })
      return { status: response.status, body: await response.json(), headers: response.headers }
    }
    const post = async (headers, path, idempotencyKey, body) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    const createProject = async (issued, name, idempotencyKey) => {
      const response = await post(bearer(issued), '/v1/projects', idempotencyKey, {
        name, objective: 'discovery', format: '9:16', locale: 'pt-BR',
        briefing: 'Público: gestores. Oferta: conteúdo. Tom: direto e natural.',
      })
      assert.equal(response.status, 201)
      return response.body.data.project
    }
    const rename = async (issued, projectId, baseRevision, name, idempotencyKey) => {
      const response = await post(bearer(issued), `/v1/projects/${projectId}/rename`, idempotencyKey, { baseRevision, name })
      assert.equal(response.status, 200)
      return response.body.data
    }
    const oracle = (workspaceId, extra = {}) => client.v2PublicEventOutbox.findMany({
      where: {
        workspaceId,
        type: { in: ['project.created', 'project.name.changed', 'project.status.changed'] },
        ...extra,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    // Waits for the watermark to pass committed rows; never a fixed sleep for correctness.
    async function readUntil(headers, after, predicate, limit = 100) {
      const deadline = Date.now() + 15_000
      let last
      while (Date.now() < deadline) {
        last = await feed(headers, `after=${encodeURIComponent(after)}&limit=${limit}`)
        assert.equal(last.status, 200, JSON.stringify(last.body))
        if (predicate(last.body.data)) return last
        await sleep(100)
      }
      assert.fail(`feed never satisfied the expectation: ${JSON.stringify(last?.body)}`)
    }
    const decodeCursor = (cursor) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

    await t.test('authentication, scope, capability policy and query allowlist', async () => {
      const anonymous = await feed({})
      assert.equal(anonymous.status, 401)
      assert.equal(anonymous.body.error.code, 'AUTH_INVALID')
      const forged = await feed({ authorization: 'Bearer not-a-real-token' })
      assert.equal(forged.status, 401)
      const missingScope = await feed(bearer(noScope), 'startAt=latest')
      assert.equal(missingScope.status, 403)
      assert.equal(missingScope.body.error.code, 'AUTH_SCOPE_REQUIRED')
      const policyDenied = await feed(bearer(denied), 'startAt=latest')
      assert.equal(policyDenied.status, 403)
      assert.equal(policyDenied.body.error.code, 'AUTH_SCOPE_REQUIRED')
      for (const query of [
        'unknown=1', 'limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'startAt=oldest',
        'startAt=latest&startAt=latest', 'startAt=latest&after=AAAAAAAAAA',
      ]) {
        const response = await feed(bearer(writer), query)
        assert.equal(response.status, 422, query)
        assert.equal(response.body.error.code, 'INVALID_ARGUMENT', query)
      }
      const ok = await feed(bearer(writer), 'startAt=latest')
      assert.equal(ok.status, 200)
      assert.equal(ok.headers.get('cache-control'), 'no-store')
      assert.deepEqual(Object.keys(ok.body.data).toSorted(), ['events', 'hasMore', 'nextCursor', 'watermark'])
    })

    const project = await createProject(writer, 'W36 projeto feed', 'w36-feed-create-1')
    const renamedOnce = await rename(writer, project.id, 1, 'W36 feed renomeado 0', 'w36-feed-rename-0')
    assert.equal(renamedOnce.administration.revision, 2)
    await sleep(200)
    const head = await feed(bearer(writer), 'startAt=latest')
    assert.equal(head.status, 200)
    assert.deepEqual(head.body.data.events, [], 'history is never replayed from startAt=latest')
    assert.equal(head.body.data.hasMore, false)
    const headCursor = head.body.data.nextCursor
    const headPosition = decodeCursor(headCursor)
    assert.equal(headPosition.createdAt <= new Date().toISOString(), true)
    assert.equal(head.body.data.watermark <= new Date().toISOString(), true)
    const historyRows = await oracle(workspaceA)
    assert.deepEqual(
      historyRows.map((row) => row.type),
      ['project.created', 'project.name.changed'],
      'PostgreSQL holds the history that startAt=latest skipped',
    )
    const quiet = await feed(bearer(writer), `after=${encodeURIComponent(headCursor)}`)
    assert.deepEqual(quiet.body.data.events, [])

    let cursor = headCursor
    await t.test('an external rename becomes exactly one event matching PostgreSQL', async () => {
      const result = await rename(writer, project.id, 2, 'W36 feed renomeado 1', 'w36-feed-rename-1')
      assert.equal(result.administration.revision, 3)
      const rows = await oracle(workspaceA, { resourceId: project.id, sequence: 3 })
      assert.equal(rows.length, 1)
      const page = await readUntil(bearer(writer), cursor, (data) => data.events.length >= 1)
      assert.equal(page.body.data.events.length, 1)
      const [event] = page.body.data.events
      assert.equal(event.id, rows[0].id)
      assert.equal(event.type, 'project.name.changed')
      assert.equal(event.version, '1.0.0')
      assert.equal(event.workspaceId, workspaceA)
      assert.deepEqual(event.resource, { type: 'project', id: project.id })
      assert.equal(event.sequence, 3)
      assert.deepEqual(event.data, { action: 'rename', baseRevision: 2, resultRevision: 3 })
      assert.equal(event.actor.clientId, writerId)
      assert.notEqual(page.body.data.nextCursor, cursor)
      cursor = page.body.data.nextCursor
      const again = await feed(bearer(writer), `after=${encodeURIComponent(cursor)}`)
      assert.deepEqual(again.body.data.events, [], 'delivered exactly once per cursor lineage')
    })

    await t.test('ordering and pagination follow (createdAt, id) with no gaps or repeats', async () => {
      for (let revision = 3; revision <= 5; revision += 1) {
        await rename(writer, project.id, revision, `W36 feed renomeado ${revision - 1}`, `w36-feed-rename-${revision}`)
      }
      const expected = (await oracle(workspaceA, { resourceId: project.id, sequence: { gte: 4 } })).map((row) => row.id)
      assert.equal(expected.length, 3)
      const first = await readUntil(bearer(writer), cursor, (data) => data.events.length === 2 && data.hasMore, 2)
      assert.equal(first.body.data.hasMore, true)
      const second = await readUntil(bearer(writer), first.body.data.nextCursor, (data) => data.events.length === 1, 2)
      assert.equal(second.body.data.hasMore, false)
      assert.deepEqual(
        [...first.body.data.events, ...second.body.data.events].map((event) => event.id),
        expected,
      )
      assert.deepEqual(
        [...first.body.data.events, ...second.body.data.events].map((event) => event.sequence),
        [4, 5, 6],
      )
      cursor = second.body.data.nextCursor
    })

    await t.test('another workspace gets no event, no data and cannot use this cursor', async () => {
      const headB = await feed(bearer(writerB), 'startAt=latest')
      const cursorB = headB.body.data.nextCursor
      await sleep(150)
      const projectB = await createProject(writerB, 'W36 projeto feed B', 'w36-feed-create-b')
      await rename(writerB, projectB.id, 1, 'W36 feed B renomeado', 'w36-feed-rename-b')
      const rowsB = await oracle(workspaceB)
      assert.equal(rowsB.length, 2)
      const pageB = await readUntil(bearer(writerB), cursorB, (data) => data.events.length === 2)
      assert.deepEqual(pageB.body.data.events.map((event) => event.id), rowsB.map((row) => row.id))
      assert.ok(pageB.body.data.events.every((event) => event.workspaceId === workspaceB))
      await sleep(200)
      const pageA = await feed(bearer(writer), `after=${encodeURIComponent(cursor)}&limit=100`)
      assert.equal(pageA.status, 200)
      assert.deepEqual(pageA.body.data.events, [], 'workspace A sees nothing of workspace B')
      assert.equal(JSON.stringify(pageA.body).includes(projectB.id), false)
      const crossAB = await feed(bearer(writerB), `after=${encodeURIComponent(cursor)}`)
      assert.equal(crossAB.status, 422)
      assert.equal(crossAB.body.error.code, 'INVALID_ARGUMENT')
      const crossBA = await feed(bearer(writer), `after=${encodeURIComponent(pageB.body.data.nextCursor)}`)
      assert.equal(crossBA.status, 422)
      assert.equal(JSON.stringify(crossBA.body).includes(projectB.id), false)
    })

    await t.test('tampered, truncated, future and foreign-shaped cursors are rejected', async () => {
      const valid = decodeCursor(cursor)
      const candidates = [
        `${cursor.slice(0, -2)}AA`,
        cursor.slice(0, 20),
        encodeCursor({ ...valid, createdAt: '2099-01-01T00:00:00.000Z' }),
        encodeCursor({ ...valid, queryHash: 'f'.repeat(64) }),
        encodeCursor({ ...valid, id: 'nope' }),
        encodeCursor({ ...valid, v: 2 }),
        encodeCursor({ v: 1, createdAt: valid.createdAt }),
        Buffer.from('{"v":1}').toString('base64url'),
        'x'.repeat(2000),
        '%%%%%%%%%%',
      ]
      for (const candidate of candidates) {
        const response = await feed(bearer(writer), `after=${encodeURIComponent(candidate)}`)
        assert.equal(response.status, 422, candidate.slice(0, 24))
        assert.equal(response.body.error.code, 'INVALID_ARGUMENT', candidate.slice(0, 24))
      }
      const stillWorks = await feed(bearer(writer), `after=${encodeURIComponent(cursor)}`)
      assert.equal(stillWorks.status, 200)
    })

    await t.test('REAL late worker progress and annotation transactions are withheld, delivered in order and never skipped', async () => {
      const fresh = await feed(bearer(writer), 'startAt=latest')
      const start = fresh.body.data.nextCursor
      const startPosition = decodeCursor(start)
      const slowId = randomUUID()
      const fastId = randomUUID()
      const row = (id, resourceId, sequence) => ({
        id, workspaceId: workspaceA, type: id === slowId ? 'operation.progress.changed' : 'annotation.created', version: '1.0.0',
        occurredAt: new Date(), sequence, actorClientId: writerId,
        resourceType: id === slowId ? 'operation' : 'annotation', resourceId,
        dataJson: JSON.stringify(id === slowId
          ? { projectId: 'w36-late-project', phase: 'rendering', progress: { completed: 1, total: 4, unit: 'render-phases' } }
          : { projectId: 'w36-late-project', projectVersionId: 'w36-late-version', status: 'open' }),
      })
      // Separate clients: each pool holds one connection, and the open
      // transaction must not block the committer or the HTTP server.
      const slowClient = new PrismaClient()
      const fastClient = new PrismaClient()
      extraClients.push(slowClient, fastClient)
      let release
      const gate = new Promise((resolve) => { release = resolve })
      let inserted
      const insertedSignal = new Promise((resolve) => { inserted = resolve })
      const slowTransaction = slowClient.$transaction(async (transaction) => {
        await transaction.v2PublicEventOutbox.create({ data: row(slowId, 'w36-late-slow', 2) })
        inserted()
        await gate
      }, { timeout: 25_000, maxWait: 10_000 })
      await insertedSignal
      await sleep(250)
      await fastClient.v2PublicEventOutbox.create({ data: row(fastId, 'w36-late-fast', 2) })
      await sleep(300)

      const withheld = await feed(bearer(writer), `after=${encodeURIComponent(start)}`)
      assert.equal(withheld.status, 200)
      assert.deepEqual(
        withheld.body.data.events, [],
        'the later, already committed row is withheld while an earlier transaction is still open',
      )
      const naive = await client.v2PublicEventOutbox.findMany({
        where: { workspaceId: workspaceA, createdAt: { gt: new Date(startPosition.createdAt) }, id: { in: [slowId, fastId] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      assert.deepEqual(naive.map((event) => event.id), [fastId], 'a naive createdAt cursor would already have advanced past the fast row')
      release()
      await slowTransaction

      const both = await oracle(workspaceA, { id: { in: [slowId, fastId] } })
      assert.deepEqual(both.map((event) => event.id), [slowId, fastId], 'slow row sorts first although it committed last')
      const slowRow = both[0]
      const fastRow = both[1]
      assert.ok(slowRow.createdAt < fastRow.createdAt)
      assert.ok(
        Date.parse(withheld.body.data.watermark) < slowRow.createdAt.getTime(),
        'the withheld read reported a watermark behind the open transaction start',
      )
      // The naive cursor that had advanced to the fast row loses the slow row for good.
      const naiveAfterFast = await client.v2PublicEventOutbox.findMany({
        where: { workspaceId: workspaceA, createdAt: { gt: fastRow.createdAt }, id: slowId },
      })
      assert.deepEqual(naiveAfterFast, [], 'late write is real on this PostgreSQL: a naive cursor would skip it')

      const delivered = await readUntil(bearer(writer), start, (data) => data.events.length === 2)
      assert.deepEqual(delivered.body.data.events.map((event) => event.id), [slowId, fastId])
      const afterDelivery = await feed(bearer(writer), `after=${encodeURIComponent(delivered.body.data.nextCursor)}`)
      assert.deepEqual(afterDelivery.body.data.events, [])
      await slowClient.$disconnect()
      await fastClient.$disconnect()
    })
  } catch (error) {
    if (serverDiagnostics) console.error(serverDiagnostics.slice(-4000))
    throw error
  } finally {
    await stopOwnedServer(server)
    for (const extra of extraClients) await extra.$disconnect().catch(() => undefined)
    await cleanup().catch((error) => console.error('W36 feed cleanup failed', error))
    await client.$disconnect()
  }
})
