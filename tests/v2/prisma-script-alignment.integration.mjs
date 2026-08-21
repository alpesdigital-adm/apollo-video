import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import test from 'node:test'

import {
  Prisma,
  PrismaClient,
} from '../../generated/prisma-v2/index.js'

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address
        ? address.port
        : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next server exited with ${server.exitCode}`)
    }
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for Next server')
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

function transcriptFixture(text, createMediaTranscript) {
  const words = text.split(/\s+/).filter(Boolean).map((word, index) => ({
    word,
    start: index * 0.27,
    end: index * 0.27 + 0.22,
  }))
  return createMediaTranscript({
    language: 'pt-BR',
    text,
    words,
    segments: [{
      id: 1,
      start: 0,
      end: words.at(-1)?.end ?? 0,
      text,
      confidence: 0.97,
    }],
    provider: 'fixture',
    model: 'script-alignment-e2e',
  })
}

test('T-FR-081 imports, aligns and reviews grouped recordings through PostgreSQL and the public API', {
  skip:
    process.env.APOLLO_SCRIPT_ALIGNMENT_E2E !== '1' &&
    'set APOLLO_SCRIPT_ALIGNMENT_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(
    process.env.V2_DATABASE_URL,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const databaseName = new URL(process.env.V2_DATABASE_URL)
    .pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )

  const { createMediaTranscript } =
    await import('../../src/v2/domain/media-transcript.ts')
  const { stableSerialize } =
    await import('../../src/v2/domain/canonical-hash.ts')
  const { assetRightsRevision } =
    await import('../../src/v2/domain/asset-rights.ts')
  const { createApiClientService } =
    await import('../../src/v2/application/create-api-client.ts')
  const { createExternalAuditContext, materializeActorAuditContext } =
    await import('../../src/v2/application/authenticate-api-client.ts')
  const { setAssetRightsService } =
    await import('../../src/v2/application/set-asset-rights.ts')
  const { PrismaApiClientRepository } =
    await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
  const { PrismaAssetRightsRepository } =
    await import(
      '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
    )
  const { nodeApiCredentialCrypto } =
    await import(
      '../../src/v2/infrastructure/security/api-credential.ts'
    )

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `alignment-e2e-workspace-${suffix}`
  const projectId = `alignment-e2e-project-${suffix}`
  const hooksArtifactId = `alignment-e2e-hooks-${suffix}`
  const bodyArtifactId = `alignment-e2e-body-${suffix}`
  const hooksManifestId = `alignment-e2e-hooks-manifest-${suffix}`
  const bodyManifestId = `alignment-e2e-body-manifest-${suffix}`
  const createdAt = new Date('2026-07-27T22:00:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe(
      'TRUNCATE TABLE "workspaces" CASCADE',
    )
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Script alignment E2E',
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
      id: `alignment-e2e-client-${suffix}`,
      workspaceId,
      name: 'Script alignment E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const auditContext = createExternalAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
    })
    const authenticatedActor = Object.freeze({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
      scopes: new Set(['projects:read', 'projects:write']),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext,
    })
    const expectedAuthenticationAudit = materializeActorAuditContext(authenticatedActor)
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Campanha de descoberta',
        status: 'draft',
        objective: 'content-distribution',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    await client.v2MediaArtifact.createMany({
      data: [
        {
          id: hooksArtifactId,
          workspaceId,
          artifactKey:
            `workspaces/${workspaceId}/alignment/hooks.mp4`,
          sha256: '1'.repeat(64),
          byteSize: 18000n,
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
          createdAt,
        },
        {
          id: bodyArtifactId,
          workspaceId,
          artifactKey:
            `workspaces/${workspaceId}/alignment/body-cta.mp4`,
          sha256: '2'.repeat(64),
          byteSize: 42000n,
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
          createdAt,
        },
      ],
    })
    await client.v2MediaArtifactManifest.createMany({
      data: [
        {
          id: hooksManifestId,
          workspaceId,
          artifactId: hooksArtifactId,
          schemaVersion: 'media-artifact-manifest/v1',
          manifestHash: '3'.repeat(64),
          recipeId: 'source-upload',
          recipeVersion: '1',
          parametersHash: '4'.repeat(64),
          manifestJson: JSON.stringify({
            probe: {
              width: 1080,
              height: 1920,
              duration: 18,
              fps: 30,
            },
          }),
          createdAt,
        },
        {
          id: bodyManifestId,
          workspaceId,
          artifactId: bodyArtifactId,
          schemaVersion: 'media-artifact-manifest/v1',
          manifestHash: '5'.repeat(64),
          recipeId: 'source-upload',
          recipeVersion: '1',
          parametersHash: '6'.repeat(64),
          manifestJson: JSON.stringify({
            probe: {
              width: 1080,
              height: 1920,
              duration: 42,
              fps: 30,
            },
          }),
          createdAt,
        },
      ],
    })
    await client.v2ProjectMediaAsset.createMany({
      data: [
        {
          id: randomUUID(),
          workspaceId,
          projectId,
          artifactId: hooksArtifactId,
          role: 'source-master',
          originalFileName: 'hooks-gravados.mp4',
          createdAt,
        },
        {
          id: randomUUID(),
          workspaceId,
          projectId,
          artifactId: bodyArtifactId,
          role: 'source-master',
          originalFileName: 'corpos-provas-ctas.mp4',
          createdAt,
        },
      ],
    })
    for (const [index, artifactId] of [
      hooksArtifactId,
      bodyArtifactId,
    ].entries()) {
      await setAssetRightsService({
        repository: new PrismaAssetRightsRepository(client),
        clock: () => createdAt,
        createId: () =>
          `alignment-e2e-rights-${index}-${suffix}`,
      })({
        workspaceId,
        artifactId,
        baseRevision: assetRightsRevision(artifactId, 0),
        draft: {
          status: 'approved',
          allowedUses: ['paid-ad', 'editorial-reuse'],
          prohibitedUses: [],
          allowedLocales: ['pt-BR'],
          consent: {
            status: 'not-required',
            allowedUses: [],
          },
        },
        actor: { type: 'api-client', id: issued.client.id },
      })
    }

    const hooksTranscript = transcriptFixture(
      'Preparando Pare de perder dinheiro com anuncios intervalo ' +
      'Pare de perder dinheiro com anuncios encerrando',
      createMediaTranscript,
    )
    const bodyTranscript = transcriptFixture(
      'Alinhe oferta publico e mensagem ' +
      'Mais de duzentos clientes aplicaram este metodo ' +
      'Clique no link e agende uma conversa obrigado',
      createMediaTranscript,
    )
    const hooksTranscriptId = `alignment-e2e-transcript-hooks-${suffix}`
    const bodyTranscriptId = `alignment-e2e-transcript-body-${suffix}`
    await client.v2MediaTranscript.createMany({
      data: [
        {
          id: hooksTranscriptId,
          workspaceId,
          projectId,
          sourceArtifactId: hooksArtifactId,
          sourceManifestId: hooksManifestId,
          schemaVersion: hooksTranscript.schemaVersion,
          language: hooksTranscript.language,
          provider: hooksTranscript.provider,
          model: hooksTranscript.model,
          transcriptHash: hooksTranscript.transcriptHash,
          transcriptJson: stableSerialize(hooksTranscript),
          createdAt,
        },
        {
          id: bodyTranscriptId,
          workspaceId,
          projectId,
          sourceArtifactId: bodyArtifactId,
          sourceManifestId: bodyManifestId,
          schemaVersion: bodyTranscript.schemaVersion,
          language: bodyTranscript.language,
          provider: bodyTranscript.provider,
          model: bodyTranscript.model,
          transcriptHash: bodyTranscript.transcriptHash,
          transcriptJson: stableSerialize(bodyTranscript),
          createdAt,
        },
      ],
    })

    const port = await freePort()
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
    server.stdout.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    server.stderr.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    await waitForServer(baseUrl, server)

    const authorization = `Bearer ${issued.token}`
    const headers = {
      authorization,
      'content-type': 'application/json',
    }
    const batchResponse = await fetch(`${baseUrl}/v1/batches`, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `alignment-batch-${suffix}`,
      },
      body: JSON.stringify({
        projectId,
        name: 'Variações de descoberta',
        objective: 'content-distribution',
        sourceGroups: [
          {
            id: 'source-group-hooks',
            name: 'Hooks',
            sourceArtifactIds: [hooksArtifactId],
          },
          {
            id: 'source-group-body',
            name: 'Corpo, prova e CTA',
            sourceArtifactIds: [bodyArtifactId],
          },
        ],
        recipes: [{
          id: 'recipe-complete',
          name: 'Hook + corpo + prova + CTA',
          sourceGroupIds: [
            'source-group-hooks',
            'source-group-body',
          ],
        }],
        variants: [{
          id: 'variant-vertical',
          name: 'Vertical',
          outputSpecId: '9:16',
          locale: 'pt-BR',
        }],
        budget: {
          currency: 'USD',
          maxCostMinorUnits: 1000,
          reservedCostMinorUnits: 0,
        },
        items: [{
          key: 'complete/vertical',
          sourceGroupId: 'source-group-hooks',
          recipeId: 'recipe-complete',
          variantId: 'variant-vertical',
        }],
      }),
    })
    const batchPayload = await batchResponse.json()
    assert.equal(
      batchResponse.status,
      201,
      JSON.stringify(batchPayload),
    )
    const batch = batchPayload.data.batch
    const endpoint =
      `${baseUrl}/v1/batches/${batch.id}/script-alignments`

    const unauthenticated = await fetch(endpoint)
    assert.equal(unauthenticated.status, 401)

    const alignmentBody = {
      title: 'Roteiro gravado em blocos',
      locale: 'pt-BR',
      rawText: [
        'HOOK 1: Pare de perder dinheiro com anuncios.',
        'CORPO 1: Alinhe oferta publico e mensagem.',
        'PROVA 1: Mais de cem clientes aplicaram este metodo.',
        'CTA 1: Clique no link e agende uma conversa.',
      ].join('\n'),
      sources: [
        {
          transcriptId: hooksTranscriptId,
          expectedTranscriptHash: hooksTranscript.transcriptHash,
          roleHint: 'hook',
        },
        {
          transcriptId: bodyTranscriptId,
          expectedTranscriptHash: bodyTranscript.transcriptHash,
          roleHint: 'body',
        },
      ],
    }
    const createKey = `alignment-create-${suffix}`
    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify(alignmentBody),
    })
    const createPayload = await createResponse.json()
    assert.equal(
      createResponse.status,
      201,
      JSON.stringify(createPayload),
    )
    assert.equal(createPayload.data.replayed, false)
    let alignment = createPayload.data.alignment
    assert.equal(alignment.document.blocks.length, 4)
    assert.equal(alignment.document.rawText, alignmentBody.rawText)
    assert.equal(alignment.status, 'review-required')
    assert.ok(alignment.summary.reviewRequiredCount > 0)
    assert.ok(alignment.extraTakes.length > 0)
    assert.ok(alignment.alignments.some((item) => item.ambiguous))
    assert.ok(alignment.alignments.some((item) =>
      item.selectedCandidate?.deviations.some((deviation) =>
        deviation.kind === 'number-claim-change')))
    assert.ok(alignment.alignments.every((item) =>
      item.selectedCandidate === null ||
      (
        item.selectedCandidate.sourceRangeMs[1] >
        item.selectedCandidate.sourceRangeMs[0] &&
        item.selectedCandidate.evidenceWordIndices.length > 0
      )))

    const replayResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify(alignmentBody),
    })
    assert.equal(replayResponse.status, 200)
    assert.equal((await replayResponse.json()).data.replayed, true)

    const mismatchResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify({
        ...alignmentBody,
        title: 'Outro roteiro',
      }),
    })
    assert.equal(mismatchResponse.status, 409)

    const listResponse = await fetch(`${endpoint}?limit=20`, {
      headers: { authorization },
    })
    const listPayload = await listResponse.json()
    assert.equal(listResponse.status, 200)
    assert.equal(listPayload.data.alignments.length, 1)
    assert.equal(listPayload.data.alignments[0].id, alignment.id)

    const readResponse = await fetch(
      `${endpoint}/${alignment.id}`,
      { headers: { authorization } },
    )
    assert.equal(readResponse.status, 200)
    assert.equal(
      (await readResponse.json()).data.alignment.runHash,
      alignment.runHash,
    )

    const decisions = [
      ...alignment.alignments
        .filter((item) => item.reviewStatus === 'review-required')
        .map((item) => item.selectedCandidate
          ? {
              targetKind: 'block',
              blockId: item.blockId,
              resolution: 'accept',
            }
          : {
              targetKind: 'block',
              blockId: item.blockId,
              resolution: 'mark-missing',
            }),
      ...alignment.extraTakes
        .filter((extra) => extra.reviewStatus === 'review-required')
        .map((extra) => ({
          targetKind: 'extra-take',
          extraTakeId: extra.id,
          resolution: 'reject-extra',
        })),
    ]
    const reviewBody = {
      expectedRevision: alignment.revision,
      decisions,
    }
    const reviewKey = `alignment-review-${suffix}`
    const reviewResponse = await fetch(
      `${endpoint}/${alignment.id}/reviews`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': reviewKey,
        },
        body: JSON.stringify(reviewBody),
      },
    )
    const reviewPayload = await reviewResponse.json()
    assert.equal(
      reviewResponse.status,
      201,
      JSON.stringify(reviewPayload),
    )
    alignment = reviewPayload.data.alignment
    assert.equal(alignment.revision, 2)
    assert.equal(alignment.status, 'reviewed')
    assert.equal(alignment.summary.reviewRequiredCount, 0)
    assert.equal(alignment.reviews.length, 1)
    assert.ok(alignment.extraTakes.every((extra) =>
      extra.reviewStatus === 'rejected'))

    const reviewReplay = await fetch(
      `${endpoint}/${alignment.id}/reviews`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': reviewKey,
        },
        body: JSON.stringify(reviewBody),
      },
    )
    assert.equal(reviewReplay.status, 200)
    const reviewReplayPayload = await reviewReplay.json()
    assert.equal(reviewReplayPayload.data.replayed, true)
    assert.equal(reviewReplayPayload.data.alignment.revision, 2)
    assert.equal(
      reviewReplayPayload.data.alignment.runHash,
      alignment.runHash,
    )

    const staleResponse = await fetch(
      `${endpoint}/${alignment.id}/reviews`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `alignment-stale-${suffix}`,
        },
        body: JSON.stringify(reviewBody),
      },
    )
    assert.equal(staleResponse.status, 409)

    assert.equal(
      await client.v2ScriptAlignmentRun.count({
        where: { workspaceId },
      }),
      1,
    )
    assert.equal(
      await client.v2ScriptAlignmentReview.count({
        where: { workspaceId },
      }),
      1,
    )
    for (const row of [
      ...(await client.v2ScriptAlignmentRun.findMany({ where: { workspaceId } })),
      ...(await client.v2ScriptAlignmentReview.findMany({ where: { workspaceId } })),
    ]) {
      assert.equal(row.actorCredentialId, expectedAuthenticationAudit.credentialId)
      assert.equal(row.actorContextHash, expectedAuthenticationAudit.contextHash)
      assert.equal(row.actorAuthenticationKind, 'bearer')
    }
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "script_alignment_runs"
          SET "reviewRequiredCount" = 9999
          WHERE "workspaceId" = ${workspaceId}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "script_alignment_reviews"
          SET "resultRunHash" = 'not-a-sha256'
          WHERE "workspaceId" = ${workspaceId}
        `,
      ),
    )
  } catch (error) {
    if (serverLogs) {
      error.message += `\nNext logs:\n${serverLogs.slice(-8_000)}`
    }
    throw error
  } finally {
    await stopServer(server)
    await client.$disconnect()
  }
})
