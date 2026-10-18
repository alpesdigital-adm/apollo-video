import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createProjectWithVariant } from './helpers/explicit-project-http.mjs'
import { registerPlayableVideo } from './helpers/misc-pg-sources.mjs'

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error
        ? reject(error)
        : resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next server exited with ${child.exitCode}`)
    }
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-053 duplicates a project copy-on-write through the public API with PostgreSQL lineage and idempotency', {
  skip: process.env.APOLLO_PROJECT_DUPLICATION_E2E !== '1' &&
    'set APOLLO_PROJECT_DUPLICATION_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(
    process.env.V2_DATABASE_URL,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )

  const { createApiClientService } = await import(
    '../../src/v2/application/create-api-client.ts'
  )
  const { createApiAccessAuditContext } = await import(
    '../../src/v2/domain/api-access-control.ts'
  )
  const { validateProjectCreationOutputCommandV2 } = await import(
    '../../src/v2/domain/project-creation-command.ts'
  )
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `duplication-workspace-${suffix}`
  const otherWorkspaceId = `duplication-other-workspace-${suffix}`
  const artifactId = `duplication-master-${suffix}`
  const createdAt = new Date('2026-07-27T01:30:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.v2Workspace.createMany({
      data: [
        {
          id: workspaceId,
          slug: workspaceId,
          name: 'Project duplication E2E',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: otherWorkspaceId,
          slug: otherWorkspaceId,
          name: 'Project duplication other workspace',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        },
      ],
    })
    const createClient = createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })
    const issued = await createClient({
      id: `duplication-client-${suffix}`,
      workspaceId,
      name: 'Project duplication E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const otherIssued = await createClient({
      id: `duplication-other-client-${suffix}`,
      workspaceId: otherWorkspaceId,
      name: 'Project duplication other workspace',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })

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
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

    const authorization = `Bearer ${issued.token}`
    // The 6.0.0 creation: the project is born without any output, and its head is the explicit variant created on top of it.
    const call = async (path, body, key) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      assert.ok([200, 201].includes(response.status), `${JSON.stringify(payload)}\n${serverLogs.slice(-4_000)}`)
      return payload.data
    }
    const source = await createProjectWithVariant(call, {
      project: {
        name: 'Original imutável',
        objective: 'discovery',
        locale: 'pt-BR',
        briefing: 'Descoberta com enquadramento seguro e sem texto sobre o rosto.',
      },
      aspectRatio: '9:16',
      key: `duplication-source-${suffix}`,
    })
    const sourceProject = source.created.projectAtCreation
    const sourceVersion = source.version

    // The shared master is a registered source (artifact, manifest and project link) with approved rights: the duplication
    // pins one exact manifest per linked artifact and evaluates the artifact's current rights for the copy's purpose.
    await registerPlayableVideo(client, {
      workspaceId,
      projectId: sourceProject.id,
      clientId: issued.client.id,
      artifactId,
      artifactKey: `duplication/${artifactId}.mp4`,
      sha256: 'a'.repeat(64),
      byteSize: 12_345,
      probe: { width: 360, height: 640, duration: 4, fps: 30 },
      originalFileName: 'master-original.mp4',
      createdAt,
      receipt: false,
    })

    // Copy-on-write: whatever the duplication, its replays and the copy of the copy do, the original's rows never move.
    const plain = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item))
    const readSourceRows = async () => plain({
      project: await client.v2Project.findUnique({ where: { id: sourceProject.id } }),
      versions: await client.v2ProjectVersion.findMany({ where: { projectId: sourceProject.id }, orderBy: { sequence: 'asc' } }),
      snapshots: await client.v2ProjectSnapshot.findMany({ where: { projectId: sourceProject.id }, orderBy: { id: 'asc' } }),
      editCommands: await client.v2EditCommand.count({ where: { projectId: sourceProject.id } }),
    })
    const sourceRowsBefore = await readSourceRows()

    const duplicateBody = {
      expectedVersionId: sourceVersion.id,
      expectedVersionHash: sourceVersion.baseHash,
      name: 'Cópia independente',
    }
    const duplicationKey = `duplicate-${suffix}`
    const duplicateResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': duplicationKey,
        },
        body: JSON.stringify(duplicateBody),
      },
    )
    const duplicatePayload = await duplicateResponse.json()
    assert.equal(
      duplicateResponse.status,
      201,
      `${JSON.stringify(duplicatePayload)}\n${serverLogs.slice(-4_000)}`,
    )
    assert.equal(duplicatePayload.data.replayed, false)
    assert.equal(duplicatePayload.data.project.name, 'Cópia independente')
    assert.equal(
      duplicatePayload.data.project.duplicatedFromProjectId,
      sourceProject.id,
    )
    assert.equal(
      duplicatePayload.data.version.forkedFromProjectId,
      sourceProject.id,
    )
    assert.equal(
      duplicatePayload.data.version.forkedFromVersionId,
      sourceVersion.id,
    )
    // Snapshot rows are owned by one project through a composite foreign key, so the
    // copy has its own snapshot ids; the content (and its hash) is what is preserved.
    assert.deepEqual(
      Object.keys(duplicatePayload.data.version.snapshotRefs).toSorted(),
      Object.keys(sourceVersion.snapshotRefs).toSorted(),
    )
    for (const [kind, id] of Object.entries(duplicatePayload.data.version.snapshotRefs)) {
      assert.notEqual(id, sourceVersion.snapshotRefs[kind])
    }
    assert.deepEqual(duplicatePayload.data.sharedArtifactIds, [artifactId])
    assert.equal(duplicatePayload.data.copiedBytes, 0)

    const duplicateProjectId = duplicatePayload.data.project.id
    const duplicateVersionId = duplicatePayload.data.version.id
    assert.notEqual(duplicateProjectId, sourceProject.id)
    assert.notEqual(duplicateVersionId, sourceVersion.id)

    const [
      artifactCount,
      artifactBytes,
      projectMedia,
      storedDuplicate,
      storedVersion,
    ] = await Promise.all([
      client.v2MediaArtifact.count({ where: { workspaceId } }),
      client.v2MediaArtifact.aggregate({
        where: { workspaceId },
        _sum: { byteSize: true },
      }),
      client.v2ProjectMediaAsset.findMany({
        where: { workspaceId, artifactId },
        orderBy: { projectId: 'asc' },
      }),
      client.v2Project.findUnique({ where: { id: duplicateProjectId } }),
      client.v2ProjectVersion.findUnique({ where: { id: duplicateVersionId } }),
    ])
    assert.equal(artifactCount, 1)
    assert.equal(artifactBytes._sum.byteSize, 12_345n)
    assert.equal(projectMedia.length, 2)
    assert.equal(new Set(projectMedia.map((item) => item.artifactId)).size, 1)
    assert.equal(new Set(projectMedia.map((item) => item.id)).size, 2)
    assert.equal(storedDuplicate?.currentVersionId, duplicateVersionId)
    assert.equal(storedDuplicate?.duplicatedFromProjectId, sourceProject.id)
    assert.equal(storedVersion?.forkedFromProjectId, sourceProject.id)
    assert.equal(storedVersion?.forkedFromVersionId, sourceVersion.id)
    assert.deepEqual(
      {
        brief: storedVersion?.briefSnapshotId,
        ...(storedVersion?.treatmentSnapshotId
          ? { treatment: storedVersion.treatmentSnapshotId }
          : {}),
        ...(storedVersion?.storySnapshotId
          ? { story: storedVersion.storySnapshotId }
          : {}),
        editPlan: storedVersion?.editPlanSnapshotId,
        policies: storedVersion?.policiesSnapshotId,
      },
      duplicatePayload.data.version.snapshotRefs,
    )
    const [sourceSnapshots, copySnapshots] = await Promise.all([
      client.v2ProjectSnapshot.findMany({
        where: { id: { in: Object.values(sourceVersion.snapshotRefs) } },
        orderBy: { kind: 'asc' },
      }),
      client.v2ProjectSnapshot.findMany({
        where: { id: { in: Object.values(duplicatePayload.data.version.snapshotRefs) } },
        orderBy: { kind: 'asc' },
      }),
    ])
    assert.equal(copySnapshots.length, sourceSnapshots.length)
    const { calculateCanonicalHash, stableSerialize } = await import(
      '../../src/v2/domain/canonical-hash.ts'
    )
    copySnapshots.forEach((snapshot, index) => {
      assert.equal(snapshot.projectId, duplicateProjectId)
      assert.equal(sourceSnapshots[index].projectId, sourceProject.id)
      assert.equal(snapshot.kind, sourceSnapshots[index].kind)
      if (snapshot.kind === 'edit-plan') {
        // Version-bound: the copy's EditPlan names the copy version; its hash is recomputed.
        const plan = JSON.parse(snapshot.contentJson)
        assert.equal(plan.projectVersionId, duplicateVersionId)
        assert.equal(JSON.parse(sourceSnapshots[index].contentJson).projectVersionId, sourceVersion.id)
        assert.equal(snapshot.contentJson, stableSerialize(plan))
        assert.equal(snapshot.contentHash, calculateCanonicalHash(plan))
        assert.notEqual(snapshot.contentHash, sourceSnapshots[index].contentHash)
      } else {
        assert.equal(snapshot.contentHash, sourceSnapshots[index].contentHash)
        assert.equal(snapshot.contentJson, sourceSnapshots[index].contentJson)
      }
    })

    const replayResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': duplicationKey,
        },
        body: JSON.stringify(duplicateBody),
      },
    )
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.project.id, duplicateProjectId)
    assert.equal(replayPayload.data.version.id, duplicateVersionId)
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      1,
    )
    assert.equal(
      await client.v2ProjectMediaAsset.count({
        where: { workspaceId, artifactId },
      }),
      2,
    )

    const mismatchResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': duplicationKey,
        },
        body: JSON.stringify({ ...duplicateBody, name: 'Outra carga' }),
      },
    )
    assert.equal(
      mismatchResponse.status,
      409,
      JSON.stringify(await mismatchResponse.json()),
    )

    const staleResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `duplicate-stale-${suffix}`,
        },
        body: JSON.stringify({
          ...duplicateBody,
          expectedVersionHash: '0'.repeat(64),
        }),
      },
    )
    assert.equal(
      staleResponse.status,
      409,
      JSON.stringify(await staleResponse.json()),
    )

    const injectionResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `duplicate-injection-${suffix}`,
        },
        body: JSON.stringify({
          ...duplicateBody,
          copiedBytes: 99,
          sharedArtifactIds: ['client-controlled-artifact'],
        }),
      },
    )
    assert.equal(
      injectionResponse.status,
      422,
      JSON.stringify(await injectionResponse.json()),
    )

    const crossWorkspaceResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${otherIssued.token}`,
          'content-type': 'application/json',
          'idempotency-key': `duplicate-cross-workspace-${suffix}`,
        },
        body: JSON.stringify(duplicateBody),
      },
    )
    assert.equal(
      crossWorkspaceResponse.status,
      404,
      JSON.stringify(await crossWorkspaceResponse.json()),
    )

    const post = (path, key, body) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    })
    // Retired: "Commands run on the copy" (a LUT selection, then a policy override, on the copy's head Version) and the same Command on
    // the copy of the copy. A copy's head is a Creation2 fork whose State is blocked ('fork-target-materialization-required'), and no
    // child Version may be built on it: buildOperationalOutputVersionBundleV3 (output-version-bundle.ts) refuses with
    // PRECONDITION_REQUIRED "Fork2 content requires target transcript/perception/geometry authority before child3", which the public
    // API answers 428 for POST /v1/projects/{copy}/output-variants (the single-output flows would also find no aspect ratio on the
    // inherited output, project-output-format.ts). Nothing in 6.0.0 grants a fork that authority yet, so no Command is reachable.
    assert.equal(
      await client.v2EditCommand.count({ where: { projectId: duplicateProjectId } }),
      0,
      'a duplicate is a Creation Command, not an edit: it starts with no edit Command of its own',
    )

    const replayAfterCommands = await post(
      `/v1/projects/${sourceProject.id}/duplicates`,
      duplicationKey,
      duplicateBody,
    )
    const replayAfterCommandsPayload = await replayAfterCommands.json()
    assert.equal(replayAfterCommands.status, 200, JSON.stringify(replayAfterCommandsPayload))
    assert.equal(replayAfterCommandsPayload.data.replayed, true)
    assert.equal(replayAfterCommandsPayload.data.project.id, duplicateProjectId)
    assert.equal(replayAfterCommandsPayload.data.version.id, duplicateVersionId)
    assert.equal(replayAfterCommandsPayload.data.version.sequence, 1)
    assert.equal(replayAfterCommandsPayload.data.project.name, 'Cópia independente')
    assert.deepEqual(replayAfterCommandsPayload.data.sharedArtifactIds, [artifactId])
    assert.equal(replayAfterCommandsPayload.data.copiedBytes, 0)
    const cloneEvents = await client.v2PublicEventOutbox.findMany({
      where: { workspaceId, OR: [{ resourceId: duplicateProjectId }, { resourceId: duplicateVersionId }] },
    })
    assert.equal(cloneEvents.filter((event) => event.type === 'project.created').length, 1,
      'duplicate replay never republishes its creation event')
    assert.equal(cloneEvents.filter((event) => event.type === 'project.version.created').length, 1)
    const mismatchAfterCommands = await post(
      `/v1/projects/${sourceProject.id}/duplicates`,
      duplicationKey,
      { ...duplicateBody, name: 'Outra carga depois' },
    )
    assert.equal(mismatchAfterCommands.status, 409)

    // A copy of a copy: its EditPlan names the new version and the lineage points at the copy, not at the original.
    const copyProject = await client.v2Project.findUniqueOrThrow({ where: { id: duplicateProjectId } })
    const copyCurrentVersion = await client.v2ProjectVersion.findUniqueOrThrow({
      where: { id: copyProject.currentVersionId },
    })
    const secondResponse = await post(
      `/v1/projects/${duplicateProjectId}/duplicates`,
      `duplicate-second-generation-${suffix}`,
      {
        expectedVersionId: copyCurrentVersion.id,
        expectedVersionHash: copyCurrentVersion.baseHash,
        name: 'Cópia da cópia',
      },
    )
    const secondPayload = await secondResponse.json()
    assert.equal(secondResponse.status, 201, JSON.stringify(secondPayload))
    assert.equal(secondPayload.data.version.forkedFromProjectId, duplicateProjectId)
    assert.equal(secondPayload.data.version.forkedFromVersionId, copyCurrentVersion.id)
    assert.deepEqual(
      await readSourceRows(),
      sourceRowsBefore,
      'Duplicating, replaying and copying the copy never touch the original',
    )

    const creationCommands = await client.v2ProjectCreationCommand.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    })
    assert.equal(creationCommands.length, 3, 'source create, first copy, second-generation copy')
    const sourceCommand = creationCommands.find((command) => command.action === 'create')
    const duplicateCommand = creationCommands.find((command) => command.action === 'duplicate' && command.projectId === duplicateProjectId)
    assert.equal(sourceCommand?.projectId, sourceProject.id)
    assert.equal(sourceCommand?.sourceProjectId, null)
    assert.equal(duplicateCommand?.projectId, duplicateProjectId)
    assert.equal(duplicateCommand?.versionId, duplicateVersionId)
    assert.equal(duplicateCommand?.sourceProjectId, sourceProject.id)
    assert.equal(duplicateCommand?.sourceVersionId, sourceVersion.id)
    assert.equal(duplicateCommand?.actorClientId, issued.client.id)
    assert.equal(duplicateCommand?.actorCredentialId, issued.credential.id)
    const expectedAudit = createApiAccessAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
      authenticationKind: 'bearer',
    })
    // The stored Command is the Creation2 document: the domain re-derives every seal from its content (payload, request and Command
    // hashes, the actor audit) and must arrive at the hash the row stores.
    const validatedDuplicateCommand = validateProjectCreationOutputCommandV2(JSON.parse(duplicateCommand.commandJson))
    assert.equal(validatedDuplicateCommand.id, duplicateCommand.id)
    assert.equal(validatedDuplicateCommand.projectId, duplicateProjectId)
    assert.equal(validatedDuplicateCommand.versionId, duplicateVersionId)
    assert.equal(validatedDuplicateCommand.requestFingerprint, duplicateCommand.requestFingerprint)
    assert.equal(validatedDuplicateCommand.audit.contextHash, expectedAudit.contextHash)
    assert.equal(duplicateCommand.actorContextHash, expectedAudit.contextHash)
    assert.equal(duplicateCommand.commandHash, validatedDuplicateCommand.commandHash)

    // Retired: corrupting the stored duplicate Command's audit column (UPDATE project_creation_commands) and expecting the replay to
    // answer 409. project_creation_commands is append-only (BEFORE UPDATE OR DELETE trigger), so the contradiction cannot be stored.
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    await client.$disconnect()
  }
})
