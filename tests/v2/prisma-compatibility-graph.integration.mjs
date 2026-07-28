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

function fixtureSuffix() {
  const configured =
    process.env.APOLLO_COMPATIBILITY_GRAPH_E2E_SUFFIX?.trim()
  if (!configured) return randomUUID().slice(0, 8)
  assert.match(
    configured,
    /^[a-z0-9]{8}$/,
    'APOLLO_COMPATIBILITY_GRAPH_E2E_SUFFIX must contain exactly 8 lowercase letters or digits',
  )
  return configured
}

function dimensions(score) {
  return [
    'completeness',
    'performance',
    'audio',
    'video',
    'integrity',
  ].map((dimension) => ({
    dimension,
    score,
    evaluatorVersion: 'compatibility-e2e/v1',
    evidenceRefs: [`compatibility-evidence-${dimension}`],
    reasonCodes: [],
  }))
}

test('T-FR-083 persists and exposes accepted, blocked and borderline compatibility through PostgreSQL and /v1', {
  skip:
    process.env.APOLLO_COMPATIBILITY_GRAPH_E2E !== '1' &&
    'set APOLLO_COMPATIBILITY_GRAPH_E2E=1 and use an isolated V2 database',
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

  const { calculateCanonicalHash, stableSerialize } =
    await import('../../src/v2/domain/canonical-hash.ts')
  const { createMediaTranscript } =
    await import('../../src/v2/domain/media-transcript.ts')
  const {
    createScriptAlignmentRun,
    importScriptDocument,
  } = await import('../../src/v2/domain/script-alignment.ts')
  const {
    createProductionBatch,
    deriveBatchStatus,
  } = await import('../../src/v2/domain/production-batch.ts')
  const { createApiClientService } =
    await import('../../src/v2/application/create-api-client.ts')
  const { PrismaApiClientRepository } =
    await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
  const { nodeApiCredentialCrypto } =
    await import(
      '../../src/v2/infrastructure/security/api-credential.ts'
    )

  const client = new PrismaClient()
  const suffix = fixtureSuffix()
  const workspaceId = `compat-e2e-workspace-${suffix}`
  const projectId = `compat-e2e-project-${suffix}`
  const batchId = `compat-e2e-batch-${suffix}`
  const alignmentId = `compat-e2e-alignment-${suffix}`
  const artifactId = `compat-e2e-artifact-${suffix}`
  const createdAt = new Date('2026-07-28T01:10:00.000Z')
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
        name: 'Compatibility graph E2E',
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
      id: `compat-e2e-client-${suffix}`,
      workspaceId,
      name: 'Compatibility graph E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Golden compatibility graph',
        status: 'draft',
        objective: 'lead-generation',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    const batch = createProductionBatch({
      id: batchId,
      workspaceId,
      projectId,
      name: 'Golden compatibility graph',
      objective: 'lead-generation',
      sourceGroups: [{
        id: 'source-group-compatibility',
        name: 'Roteiro completo',
        sourceArtifactIds: [artifactId],
      }],
      recipes: [{
        id: 'recipe-compatibility',
        name: 'Compatibilidade',
        sourceGroupIds: ['source-group-compatibility'],
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
      itemDefinitions: [{
        id: `compat-e2e-item-${suffix}`,
        key: 'compatibility/vertical',
        sourceGroupId: 'source-group-compatibility',
        recipeId: 'recipe-compatibility',
        variantId: 'variant-vertical',
      }],
      createdBy: {
        type: 'api-client',
        id: issued.client.id,
      },
      createdAt: createdAt.toISOString(),
    })
    await client.v2ProductionBatch.create({
      data: {
        id: batch.id,
        workspaceId: batch.workspaceId,
        projectId: batch.projectId,
        schemaVersion: batch.schemaVersion,
        policyVersion: batch.policyVersion,
        name: batch.name,
        objective: batch.objective,
        aggregateStatus: deriveBatchStatus(batch),
        revision: batch.revision,
        sourceGroupsJson: stableSerialize(batch.sourceGroups),
        recipesJson: stableSerialize(batch.recipes),
        variantsJson: stableSerialize(batch.variants),
        budgetJson: stableSerialize(batch.budget),
        maxCostMinorUnits: batch.budget.maxCostMinorUnits,
        reservedCostMinorUnits: batch.budget.reservedCostMinorUnits,
        itemCount: batch.items.length,
        definitionHash: batch.definitionHash,
        requestFingerprint: calculateCanonicalHash({
          batchId: batch.id,
        }),
        idempotencyKey: `compat-e2e-batch-${suffix}`,
        createdByClientId: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    await client.v2ProductionBatchItem.createMany({
      data: batch.items.map((item, sequence) => ({
        id: item.id,
        workspaceId,
        batchId,
        sequence,
        key: item.key,
        sourceGroupId: item.sourceGroupId,
        recipeId: item.recipeId,
        variantId: item.variantId,
        state: item.state,
        revision: item.revision,
        retryCount: item.retryCount,
        errorCode: item.error?.code,
        errorMessage: item.error?.message,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
        itemHash: item.itemHash,
      })),
    })
    await client.v2ProductionBatchStep.createMany({
      data: batch.items.flatMap((item) =>
        item.steps.map((step) => ({
          workspaceId,
          batchId,
          itemId: item.id,
          step: step.step,
          sequence: step.sequence,
          state: step.state,
          attempt: step.attempt,
          costMinorUnits: step.costMinorUnits,
          cacheHit: step.cacheHit,
          errorCode: step.error?.code,
          errorMessage: step.error?.message,
          stepHash: step.stepHash,
          updatedAt: new Date(item.updatedAt),
        }))),
    })

    const lines = {
      hook: 'Pare agora e descubra o erro que bloqueia suas vendas',
      body: 'O método organiza sua mensagem para atrair clientes certos',
      proof: 'Mais de cem profissionais aplicaram o método com clareza',
      cta: 'Clique no botão e fale com nossa equipe no WhatsApp',
    }
    const spoken = Object.values(lines).join(' ')
    const words = spoken.split(/\s+/).map((word, index) => ({
      word,
      start: index * .25,
      end: index * .25 + .2,
    }))
    const transcript = createMediaTranscript({
      language: 'pt-BR',
      text: spoken,
      words,
      segments: [{
        id: 1,
        start: 0,
        end: words.at(-1).end,
        text: spoken,
        confidence: .98,
      }],
      provider: 'fixture',
      model: 'compatibility-e2e',
    })
    const manifestId = `compat-e2e-manifest-${suffix}`
    const manifestJson = stableSerialize({
      schemaVersion: 'media-artifact-manifest/v2',
      artifactId,
      mediaType: 'video',
      container: 'mp4',
      probe: {
        width: 1080,
        height: 1920,
        duration: words.at(-1).end,
        fps: 30,
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey: `fixtures/${artifactId}.mp4`,
        sha256: calculateCanonicalHash({ artifactId }),
        byteSize: 1n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: manifestId,
        workspaceId,
        artifactId,
        schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: calculateCanonicalHash({ manifestJson }),
        recipeId: 'fixture.source',
        recipeVersion: '1',
        parametersHash: calculateCanonicalHash({
          parameters: 'fixture',
        }),
        manifestJson,
        createdAt,
      },
    })
    await client.v2MediaTranscript.create({
      data: {
        id: `compat-e2e-transcript-${suffix}`,
        workspaceId,
        projectId,
        sourceArtifactId: artifactId,
        sourceManifestId: manifestId,
        schemaVersion: transcript.schemaVersion,
        language: transcript.language,
        provider: transcript.provider,
        model: transcript.model,
        transcriptHash: transcript.transcriptHash,
        transcriptJson: stableSerialize(transcript),
        createdAt,
      },
    })
    const alignment = createScriptAlignmentRun({
      id: alignmentId,
      workspaceId,
      projectId,
      batchId,
      document: importScriptDocument({
        title: 'Golden compatibility graph',
        locale: 'pt-BR',
        rawText: [
          `HOOK 1: ${lines.hook}.`,
          `BODY 1: ${lines.body}.`,
          `PROOF 1: ${lines.proof}.`,
          `CTA 1: ${lines.cta}.`,
        ].join('\n'),
      }),
      sources: [{
        transcriptId: `compat-e2e-transcript-${suffix}`,
        sourceArtifactId: artifactId,
        transcriptHash: transcript.transcriptHash,
        language: transcript.language,
        transcript,
      }],
      createdByClientId: issued.client.id,
      createdAt: createdAt.toISOString(),
    })
    await client.v2ScriptAlignmentRun.create({
      data: {
        id: alignment.id,
        workspaceId,
        projectId,
        batchId,
        schemaVersion: alignment.schemaVersion,
        algorithmVersion: alignment.algorithmVersion,
        status: alignment.status,
        revision: alignment.revision,
        documentHash: alignment.document.documentHash,
        documentJson: stableSerialize(alignment.document),
        sourceRefsJson: stableSerialize(alignment.sourceRefs),
        resultJson: stableSerialize(alignment),
        blockCount: alignment.summary.blockCount,
        reviewRequiredCount: alignment.summary.reviewRequiredCount,
        extraTakeCount: alignment.summary.extraTakeCount,
        runHash: alignment.runHash,
        requestFingerprint: calculateCanonicalHash({
          alignmentId: alignment.id,
        }),
        idempotencyKey: `compat-e2e-alignment-${suffix}`,
        createdByClientId: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
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

    const headers = {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
    }
    const libraryEndpoint =
      `${baseUrl}/v1/batches/${batchId}/take-libraries`
    const candidates = [
      ...new Map(alignment.alignments.flatMap((entry) => [
        ...(entry.selectedCandidate ? [entry.selectedCandidate] : []),
        ...entry.alternatives,
      ]).map((candidate) => [candidate.id, candidate])).values(),
    ]
    const libraryResponse = await fetch(libraryEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `compat-e2e-library-${suffix}`,
      },
      body: JSON.stringify({
        alignmentId,
        expectedAlignmentRunHash: alignment.runHash,
        evaluations: candidates.map((candidate) => ({
          sourceKind: 'alignment-candidate',
          sourceId: candidate.id,
          expectedSourceHash: candidate.candidateHash,
          dimensions: dimensions(.94),
        })),
      }),
    })
    const libraryPayload = await libraryResponse.json()
    assert.equal(
      libraryResponse.status,
      201,
      JSON.stringify(libraryPayload),
    )
    const library = libraryPayload.data.library
    const eligible = library.takes.filter((take) =>
      ['primary', 'alternate'].includes(take.status) &&
      ['hook', 'body', 'proof', 'cta'].includes(take.assignment.role))
    assert.deepEqual(
      [...new Set(eligible.map((take) => take.assignment.role))].sort(),
      ['body', 'cta', 'hook', 'proof'],
    )
    const contexts = eligible.map((take) => {
      const base = {
        takeId: take.id,
        expectedTakeHash: take.takeHash,
        offerId: 'offer-apollo',
        audienceTags: ['especialistas'],
        claims: [{ key: 'resultado', value: 'clareza' }],
        personaId: 'persona-especialista',
        locale: 'pt-BR',
        desiredAction: 'whatsapp',
        continuityProvides: [
          `role-${take.assignment.role}`,
          ...(take.assignment.role === 'body'
            ? ['mecanismo-explicado']
            : []),
        ],
        continuityRequires: [],
        narrativeTags: ['clareza', 'vendas'],
        tone: .55,
        energy: .62,
        visual: .5,
        experiment: .4,
        evidenceRefs: [take.takeHash, take.sourceHash],
      }
      if (take.assignment.role === 'proof') {
        return {
          ...base,
          narrativeTags: ['depoimento', 'resultado'],
          tone: .75,
        }
      }
      if (take.assignment.role === 'cta') {
        return {
          ...base,
          offerId: 'offer-outro',
          audienceTags: ['enterprise'],
          claims: [{ key: 'resultado', value: 'velocidade' }],
          personaId: 'persona-enterprise',
          locale: 'en-US',
          desiredAction: 'download',
          continuityRequires: ['disclaimer-obrigatorio'],
        }
      }
      return base
    })

    const endpoint =
      `${baseUrl}/v1/batches/${batchId}/compatibility-graphs`
    assert.equal((await fetch(endpoint)).status, 401)
    const createBody = {
      takeLibraryId: library.id,
      expectedTakeLibraryRunHash: library.runHash,
      contexts,
      acceptThreshold: 90,
      reviewThreshold: 40,
    }
    const createKey = `compatibility-create-${suffix}`
    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify(createBody),
    })
    const createPayload = await createResponse.json()
    assert.equal(
      createResponse.status,
      201,
      JSON.stringify(createPayload),
    )
    assert.equal(createPayload.data.replayed, false)
    const graph = createPayload.data.graph
    assert.equal(graph.takeLibraryId, library.id)
    assert.ok(graph.summary.acceptedCount > 0)
    assert.ok(graph.summary.borderlineCount > 0)
    assert.ok(graph.summary.blockedCount > 0)
    assert.ok(graph.edges.every((edge) =>
      edge.reasonCodes.length > 0 &&
      edge.evidence.evidenceHash &&
      edge.softScores.length === 6))
    assert.deepEqual(
      graph.edges.find((edge) =>
        edge.relation === 'body-cta').hardFailures
        .map((failure) => failure.code)
        .sort(),
      [
        'AUDIENCE_CONFLICT',
        'CLAIM_CONTRADICTION',
        'CTA_ACTION_MISMATCH',
        'LOCALE_MISMATCH',
        'OFFER_MISMATCH',
        'PERSONA_MISMATCH',
        'REQUIRED_CONTINUITY_MISSING',
      ],
    )

    const replayResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify(createBody),
    })
    assert.equal(replayResponse.status, 200)
    assert.equal((await replayResponse.json()).data.replayed, true)
    const recalculationResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `compatibility-recalculate-${suffix}`,
      },
      body: JSON.stringify(createBody),
    })
    const recalculationPayload = await recalculationResponse.json()
    assert.equal(
      recalculationResponse.status,
      201,
      JSON.stringify(recalculationPayload),
    )
    assert.equal(recalculationPayload.data.replayed, false)
    const recalculatedGraph = recalculationPayload.data.graph
    assert.notEqual(recalculatedGraph.id, graph.id)
    assert.deepEqual(recalculatedGraph.summary, graph.summary)
    assert.equal(
      graph.nodes.some((node) =>
        recalculatedGraph.nodes.some((candidate) =>
          candidate.id === node.id)),
      false,
    )
    assert.equal(
      graph.edges.some((edge) =>
        recalculatedGraph.edges.some((candidate) =>
          candidate.id === edge.id)),
      false,
    )
    const mismatchResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify({
        ...createBody,
        acceptThreshold: 91,
      }),
    })
    assert.equal(mismatchResponse.status, 409)
    const staleResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `compatibility-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...createBody,
        expectedTakeLibraryRunHash: '0'.repeat(64),
      }),
    })
    assert.equal(staleResponse.status, 409)

    const readResponse = await fetch(`${endpoint}/${graph.id}`, {
      headers,
    })
    assert.equal(readResponse.status, 200)
    assert.equal((await readResponse.json()).data.graph.runHash, graph.runHash)
    const listResponse = await fetch(`${endpoint}?limit=1`, { headers })
    assert.equal(listResponse.status, 200)
    assert.equal(
      (await listResponse.json()).data.graphs[0].id,
      recalculatedGraph.id,
    )

    const capabilitiesResponse = await fetch(
      `${baseUrl}/v1/capabilities`,
      { headers },
    )
    const capabilitiesPayload = await capabilitiesResponse.json()
    const capabilityIds = capabilitiesPayload.data.capabilities
      .map((capability) => capability.id)
      .filter((id) => id.includes('compatibility-graphs'))
    assert.deepEqual(capabilityIds.sort(), [
      'apollo.batches.compatibility-graphs.create',
      'apollo.batches.compatibility-graphs.list',
      'apollo.batches.compatibility-graphs.read',
    ])

    assert.equal(
      await client.v2CompatibilityGraphRun.count({
        where: { workspaceId },
      }),
      2,
    )
    assert.equal(
      await client.v2CompatibilityGraphNode.count({
        where: { workspaceId },
      }),
      graph.summary.nodeCount + recalculatedGraph.summary.nodeCount,
    )
    assert.equal(
      await client.v2CompatibilityGraphEdge.count({
        where: { workspaceId },
      }),
      graph.summary.edgeCount + recalculatedGraph.summary.edgeCount,
    )
    const storedEdges = await client.v2CompatibilityGraphEdge.findMany({
      where: { workspaceId },
    })
    assert.ok(storedEdges.every((edge) =>
      JSON.parse(edge.reasonCodesJson).length > 0 &&
      JSON.parse(edge.evidenceJson).evidenceHash))
    await assert.rejects(
      client.v2CompatibilityGraphEdge.update({
        where: { id: graph.edges[0].id },
        data: { fromNodeId: recalculatedGraph.nodes[0].id },
      }),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "compatibility_graph_edges"
          SET "decision" = 'accepted', "eligible" = false
          WHERE "workspaceId" = ${workspaceId}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "compatibility_graph_runs"
          SET "runHash" = 'not-a-sha256'
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
