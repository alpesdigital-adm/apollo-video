import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

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
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-218 selects library first, verifies rights server-side, persists rejects and exposes no_insert through the API', {
  skip: process.env.APOLLO_ASSET_SELECTION_E2E !== '1' &&
    'set APOLLO_ASSET_SELECTION_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )
  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

  const client = new PrismaClient()
  const rightsRepository = new PrismaAssetRightsRepository(client)
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `asset-selection-workspace-${suffix}`
  const projectId = `asset-selection-project-${suffix}`
  const projectVersionId = `asset-selection-version-${suffix}`
  const createdAt = new Date('2026-07-26T22:30:00.000Z')
  const artifactIds = {
    rejectedLibrary: `asset-library-rejected-${suffix}`,
    acceptedLibrary: `asset-library-approved-${suffix}`,
    unusedStock: `asset-stock-unused-${suffix}`,
    deniedGenerated: `asset-generated-denied-${suffix}`,
  }
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Asset selection E2E',
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `asset-selection-client-${suffix}`,
      workspaceId,
      name: 'Asset selection E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Asset selection E2E',
        status: 'draft',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    const snapshots = [
      {
        id: `asset-selection-brief-${suffix}`,
        kind: 'brief',
        content: { schemaVersion: 1, objective: 'discovery' },
      },
      {
        id: `asset-selection-edit-plan-${suffix}`,
        kind: 'edit-plan',
        content: { schemaVersion: 2, id: `asset-selection-plan-${suffix}`, state: 'draft' },
      },
      {
        id: `asset-selection-policies-${suffix}`,
        kind: 'policies',
        content: { schemaVersion: 1, state: 'configured' },
      },
    ]
    for (const snapshot of snapshots) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: snapshot.id,
          workspaceId,
          projectId,
          kind: snapshot.kind,
          schemaVersion: snapshot.content.schemaVersion,
          contentJson: stableSerialize(snapshot.content),
          contentHash: calculateVersionHash(snapshot.content),
          createdAt,
        },
      })
    }
    const projectVersionHash = calculateVersionHash({ projectId, projectVersionId })
    await client.v2ProjectVersion.create({
      data: {
        id: projectVersionId,
        workspaceId,
        projectId,
        sequence: 1,
        briefSnapshotId: snapshots[0].id,
        editPlanSnapshotId: snapshots[1].id,
        policiesSnapshotId: snapshots[2].id,
        baseHash: projectVersionHash,
        createdBy: issued.client.id,
        createdAt,
      },
    })
    await client.v2Project.update({
      where: { id: projectId },
      data: { currentVersionId: projectVersionId },
    })
    for (const [index, artifactId] of Object.values(artifactIds).entries()) {
      await client.v2MediaArtifact.create({
        data: {
          id: artifactId,
          workspaceId,
          artifactKey: `asset-selection/${artifactId}.mp4`,
          sha256: String(index + 1).repeat(64),
          byteSize: BigInt(1_000 + index),
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
          createdAt,
        },
      })
      await setAssetRightsService({
        repository: rightsRepository,
        clock: () => createdAt,
        createId: () => `rights-${artifactId}`,
      })({
        workspaceId,
        artifactId,
        baseRevision: assetRightsRevision(artifactId, 0),
        draft: artifactId === artifactIds.deniedGenerated
          ? {
              status: 'revoked',
              allowedUses: [],
              prohibitedUses: [],
              consent: { status: 'not-required', allowedUses: [] },
            }
          : {
              status: 'approved',
              allowedUses: ['rendering'],
              prohibitedUses: [],
              allowedLocales: ['pt-BR'],
              consent: { status: 'not-required', allowedUses: [] },
            },
        actor: { type: 'api-client', id: issued.client.id },
      })
    }

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
    const brief = {
      intention: 'Reforçar a compreensão sem interromper a narrativa.',
      content: ['dashboard', 'resultado'],
      style: ['clean'],
      durationMs: { min: 1000, max: 4000 },
      entry: 'cut on sentence boundary',
      exit: 'return before next claim',
      prohibited: ['dinheiro falso'],
    }
    const candidate = (artifactId, source, patch = {}) => ({
      artifactId,
      source,
      content: ['dashboard', 'resultado'],
      style: ['clean'],
      durationMs: 2500,
      quality: 0.9,
      continuity: 0.88,
      novelty: 0.5,
      literalness: 0.2,
      ...patch,
    })
    const body = {
      projectVersionId,
      projectVersionHash,
      brief,
      candidates: [
        candidate(artifactIds.unusedStock, 'stock', { quality: 1 }),
        candidate(artifactIds.rejectedLibrary, 'library', { content: ['praia'] }),
        candidate(artifactIds.acceptedLibrary, 'library'),
      ],
    }
    const createResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `asset-selection-${suffix}`,
        },
        body: JSON.stringify(body),
      },
    )
    const createPayload = await createResponse.json()
    assert.equal(
      createResponse.status,
      201,
      `${JSON.stringify(createPayload)}\n${serverLogs.slice(-4_000)}`,
    )
    const selection = createPayload.data.selection
    assert.equal(createPayload.data.replayed, false)
    assert.equal(selection.decision, 'use_asset')
    assert.equal(selection.selectedArtifactId, artifactIds.acceptedLibrary)
    assert.equal(selection.selectedSource, 'library')
    assert.deepEqual(selection.searchStoppedBefore, ['stock', 'generated'])
    assert.deepEqual(
      selection.evaluations.map((evaluation) => evaluation.candidateId),
      [artifactIds.acceptedLibrary, artifactIds.rejectedLibrary],
    )
    assert.equal(
      selection.evaluations.find(
        (evaluation) => evaluation.candidateId === artifactIds.rejectedLibrary,
      ).reasons.includes('irrelevant'),
      true,
    )
    assert.equal(
      selection.evaluations.some(
        (evaluation) => evaluation.candidateId === artifactIds.unusedStock,
      ),
      false,
    )
    assert.equal(selection.rightsEvidence.every((evidence) => evidence.outcome === 'allow'), true)
    assert.match(selection.auditId, /^asset_selection_[a-f0-9]{64}$/)
    assert.match(selection.selectionHash, /^[a-f0-9]{64}$/)

    const replayResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `asset-selection-${suffix}`,
        },
        body: JSON.stringify(body),
      },
    )
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.selection.id, selection.id)

    const mismatchResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `asset-selection-${suffix}`,
        },
        body: JSON.stringify({
          ...body,
          brief: { ...brief, intention: 'Payload diferente com a mesma chave.' },
        }),
      },
    )
    assert.equal(mismatchResponse.status, 409, JSON.stringify(await mismatchResponse.json()))

    const staleResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `asset-selection-stale-${suffix}`,
        },
        body: JSON.stringify({ ...body, projectVersionHash: '0'.repeat(64) }),
      },
    )
    assert.equal(staleResponse.status, 409, JSON.stringify(await staleResponse.json()))

    const injectedRightsResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `asset-selection-rights-injection-${suffix}`,
        },
        body: JSON.stringify({
          ...body,
          candidates: [{ ...body.candidates[0], rights: 'approved' }],
        }),
      },
    )
    assert.equal(
      injectedRightsResponse.status,
      422,
      JSON.stringify(await injectedRightsResponse.json()),
    )

    const noInsertBody = {
      projectVersionId,
      projectVersionHash,
      brief,
      candidates: [candidate(artifactIds.deniedGenerated, 'generated')],
    }
    const noInsertResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `asset-selection-none-${suffix}`,
        },
        body: JSON.stringify(noInsertBody),
      },
    )
    const noInsertPayload = await noInsertResponse.json()
    assert.equal(noInsertResponse.status, 201, JSON.stringify(noInsertPayload))
    assert.equal(noInsertPayload.data.selection.decision, 'no_insert')
    assert.equal(noInsertPayload.data.selection.selectedArtifactId, null)
    assert.equal(noInsertPayload.data.selection.rightsEvidence[0].outcome, 'deny')
    assert.equal(
      noInsertPayload.data.selection.evaluations[0].reasons.includes('rights-unavailable'),
      true,
    )

    const listResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections?projectVersionId=${projectVersionId}&limit=10`,
      { headers: { authorization } },
    )
    const listPayload = await listResponse.json()
    assert.equal(listResponse.status, 200, JSON.stringify(listPayload))
    assert.equal(listPayload.data.selections.length, 2)
    assert.deepEqual(
      new Set(listPayload.data.selections.map((item) => item.decision)),
      new Set(['use_asset', 'no_insert']),
    )
    const stored = await client.v2AssetSelection.findUnique({ where: { id: selection.id } })
    assert.ok(stored)
    await client.v2AssetSelection.update({
      where: { id: selection.id },
      data: { selectionHash: '0'.repeat(64) },
    })
    const corruptedResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections?limit=10`,
      { headers: { authorization } },
    )
    assert.equal(corruptedResponse.status, 409, JSON.stringify(await corruptedResponse.json()))
    await client.v2AssetSelection.update({
      where: { id: selection.id },
      data: { selectionHash: stored.selectionHash },
    })
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE').catch(() => {})
    await client.$disconnect()
  }
})
