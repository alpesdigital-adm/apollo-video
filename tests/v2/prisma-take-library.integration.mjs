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
      if ((await globalThis.fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for Next server')
}

/**
 * Legitimate client behaviour against the real governance limiter: `/v1`
 * denies authenticated bursts with 429 `GOVERNANCE_LIMIT_EXCEEDED` once
 * `evaluateGovernanceAnomalies` sees more than `requestMinimum` requests in
 * its 60 s signal window. The harness asserts that contract and waits it out
 * instead of relaxing the limiter. Denied admissions are persisted and keep
 * counting inside the window, so the backoff is real waiting.
 */
const RATE_LIMIT_BACKOFF_MS = Object.freeze([
  3_000, 8_000, 15_000, 30_000, 45_000, 60_000,
])

async function apiFetch(input, init) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await globalThis.fetch(input, init)
    if (response.status !== 429) return response
    const payload = await response.clone().json().catch(() => null)
    assert.equal(
      payload?.error?.code,
      'GOVERNANCE_LIMIT_EXCEEDED',
      `unexpected 429 payload: ${JSON.stringify(payload)}`,
    )
    assert.equal(payload?.error?.category, 'quota')
    assert.equal(payload?.error?.retryable, true)
    if (attempt >= RATE_LIMIT_BACKOFF_MS.length) {
      throw new Error(
        `governance limiter did not clear after ${attempt} retries: ${JSON.stringify(payload)}`,
      )
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(60_000, Math.ceil(retryAfter) * 1_000)
      : RATE_LIMIT_BACKOFF_MS[attempt]
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
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

function measuredDimensions(score, integrity = score) {
  return [
    'completeness',
    'performance',
    'audio',
    'video',
    'integrity',
  ].map((dimension) => ({
    dimension,
    score: dimension === 'integrity' ? integrity : score,
    evaluatorVersion: 'take-library-e2e/v1',
    evidenceRefs: [`e2e-evidence-${dimension}-${String(score).replace('.', '-')}`],
    reasonCodes: [],
  }))
}

function fixtureSuffix() {
  const configured = process.env.APOLLO_TAKE_LIBRARY_E2E_SUFFIX?.trim()
  if (!configured) return randomUUID().slice(0, 8)
  assert.match(
    configured,
    /^[a-z0-9]{8}$/,
    'APOLLO_TAKE_LIBRARY_E2E_SUFFIX must contain exactly 8 lowercase letters or digits',
  )
  return configured
}

test('T-FR-082 persists, exposes, selects and protects source-preserving takes through PostgreSQL and /v1', {
  skip:
    process.env.APOLLO_TAKE_LIBRARY_E2E !== '1' &&
    'set APOLLO_TAKE_LIBRARY_E2E=1 and use an isolated V2 database',
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
  const { productionBatchItemOperationId } =
    await import('../../src/v2/domain/batch-item-result.ts')
  const { createApiClientService } =
    await import('../../src/v2/application/create-api-client.ts')
  const { createApiAccessAuditContext } =
    await import('../../src/v2/domain/api-access-control.ts')
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
  const workspaceId = `take-e2e-workspace-${suffix}`
  const projectId = `take-e2e-project-${suffix}`
  const batchId = `take-e2e-batch-${suffix}`
  const alignmentId = `take-e2e-alignment-${suffix}`
  const transcriptId = `take-e2e-transcript-${suffix}`
  const artifactId = `take-e2e-artifact-${suffix}`
  const manifestId = `take-e2e-manifest-${suffix}`
  const createdAt = new Date('2026-07-27T23:30:00.000Z')
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
        name: 'Take library E2E',
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
      id: `take-e2e-client-${suffix}`,
      workspaceId,
      name: 'Take library E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const expectedAuthenticationAudit = createApiAccessAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
      authenticationKind: 'bearer',
    })
    const storedAuthenticationAudit = {
      actorCredentialId: expectedAuthenticationAudit.credentialId,
      actorEnvironment: expectedAuthenticationAudit.environment,
      actorAuthenticationKind: expectedAuthenticationAudit.authenticationKind,
      actorContextHash: expectedAuthenticationAudit.contextHash,
    }
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Anúncio com retakes',
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
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey:
          `workspaces/${workspaceId}/take-library/retakes.mp4`,
        sha256: '1'.repeat(64),
        byteSize: 24000n,
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
        schemaVersion: 'media-artifact-manifest/v1',
        manifestHash: '3'.repeat(64),
        recipeId: 'source-upload',
        recipeVersion: '1',
        parametersHash: '4'.repeat(64),
        manifestJson: stableSerialize({
          probe: {
            width: 1080,
            height: 1920,
            duration: 5,
            fps: 30,
          },
        }),
        createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId,
        role: 'source-master',
        originalFileName: 'retakes-hook.mp4',
        createdAt,
      },
    })
    const productionBatch = createProductionBatch({
      id: batchId,
      workspaceId,
      projectId,
      name: 'Retakes de hook',
      objective: 'content-distribution',
      sourceGroups: [{
        id: 'source-group-retakes',
        name: 'Retakes',
        sourceArtifactIds: [artifactId],
      }],
      recipes: [{
        id: 'recipe-hook',
        name: 'Hook',
        sourceGroupIds: ['source-group-retakes'],
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
        id: `take-e2e-item-${suffix}`,
        key: 'hook/vertical',
        sourceGroupId: 'source-group-retakes',
        recipeId: 'recipe-hook',
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
        id: productionBatch.id,
        workspaceId: productionBatch.workspaceId,
        projectId: productionBatch.projectId,
        schemaVersion: productionBatch.schemaVersion,
        policyVersion: productionBatch.policyVersion,
        name: productionBatch.name,
        objective: productionBatch.objective,
        aggregateStatus: deriveBatchStatus(productionBatch),
        revision: productionBatch.revision,
        sourceGroupsJson: stableSerialize(productionBatch.sourceGroups),
        recipesJson: stableSerialize(productionBatch.recipes),
        variantsJson: stableSerialize(productionBatch.variants),
        budgetJson: stableSerialize(productionBatch.budget),
        maxCostMinorUnits: productionBatch.budget.maxCostMinorUnits,
        reservedCostMinorUnits:
          productionBatch.budget.reservedCostMinorUnits,
        itemCount: productionBatch.items.length,
        definitionHash: productionBatch.definitionHash,
        requestFingerprint: '2'.repeat(64),
        idempotencyKey: `take-e2e-batch-${suffix}`,
        createdByClientId: productionBatch.createdBy.id,
        ...storedAuthenticationAudit,
        createdAt,
        updatedAt: createdAt,
      },
    })
    await client.v2ProductionBatchItem.createMany({
      data: productionBatch.items.map((item, sequence) => ({
        id: item.id,
        operationId: productionBatchItemOperationId({
          workspaceId,
          batchId,
          itemId: item.id,
        }),
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
        createdAt,
        updatedAt: createdAt,
        itemHash: item.itemHash,
      })),
    })
    await client.v2ProductionBatchStep.createMany({
      data: productionBatch.items.flatMap((item) =>
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
          stepHash: step.stepHash,
          updatedAt: createdAt,
        }))),
    })

    const recordedText =
      'Preparando Pare agora e preste atencao intervalo ' +
      'Pare agora e preste atencao intervalo ' +
      'Pare agora e preste atencao encerrando'
    const words = recordedText
      .split(/\s+/)
      .filter(Boolean)
      .map((word, index) => ({
        word,
        start: index * 0.25,
        end: index * 0.25 + 0.2,
      }))
    const transcript = createMediaTranscript({
      language: 'pt-BR',
      text: recordedText,
      words,
      segments: [{
        id: 1,
        start: 0,
        end: words.at(-1)?.end ?? 0,
        text: recordedText,
        confidence: 0.97,
      }],
      provider: 'fixture',
      model: 'take-library-e2e',
    })
    await client.v2MediaTranscript.create({
      data: {
        id: transcriptId,
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
        title: 'Roteiro com retakes',
        locale: 'pt-BR',
        rawText: 'HOOK 1: Pare agora e preste atencao.',
      }),
      sources: [{
        transcriptId,
        sourceArtifactId: artifactId,
        transcriptHash: transcript.transcriptHash,
        language: transcript.language,
        roleHint: 'hook',
        transcript,
      }],
      createdByClientId: issued.client.id,
      createdAt: createdAt.toISOString(),
    })
    assert.ok(alignment.alignments[0].alternatives.length >= 1)
    assert.ok(alignment.extraTakes.length >= 2)
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
        idempotencyKey: `take-e2e-alignment-${suffix}`,
        createdByClientId: issued.client.id,
        ...storedAuthenticationAudit,
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

    const authorization = `Bearer ${issued.token}`
    const headers = {
      authorization,
      'content-type': 'application/json',
    }
    const endpoint =
      `${baseUrl}/v1/batches/${batchId}/take-libraries`
    const unauthenticated = await apiFetch(endpoint)
    assert.equal(unauthenticated.status, 401)

    const candidates = [
      ...new Map(
        alignment.alignments.flatMap((entry) => [
          ...(entry.selectedCandidate ? [entry.selectedCandidate] : []),
          ...entry.alternatives,
        ]).map((candidate) => [candidate.id, candidate]),
      ).values(),
    ].sort((left, right) =>
      left.sourceRangeMs[0] - right.sourceRangeMs[0])
    const evaluations = [
      ...candidates.map((candidate, index) => ({
        sourceKind: 'alignment-candidate',
        sourceId: candidate.id,
        expectedSourceHash: candidate.candidateHash,
        dimensions: measuredDimensions(
          index === 0 ? 0.96 : Math.max(0.7, 0.84 - index * 0.06),
        ),
      })),
      {
        sourceKind: 'extra-take',
        sourceId: alignment.extraTakes[0].id,
        expectedSourceHash: alignment.extraTakes[0].extraHash,
        dimensions: measuredDimensions(0.8, 0.2),
        inferredIntention: {
          role: 'other',
          label: 'material de intervalo',
          confidence: 0.95,
          evidenceRefs: ['director-intention-e2e'],
        },
      },
      {
        sourceKind: 'extra-take',
        sourceId: alignment.extraTakes[1].id,
        expectedSourceHash: alignment.extraTakes[1].extraHash,
        dimensions: [],
        inferredIntention: {
          role: 'other',
          label: 'material de intervalo',
          confidence: 0.95,
          evidenceRefs: ['director-intention-e2e'],
        },
      },
    ]
    const createBody = {
      alignmentId,
      expectedAlignmentRunHash: alignment.runHash,
      evaluations,
    }
    const createKey = `take-library-create-${suffix}`
    const createResponse = await apiFetch(endpoint, {
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
    let library = createPayload.data.library
    assert.equal(library.alignmentId, alignmentId)
    assert.equal(library.alignmentRunHash, alignment.runHash)
    assert.equal(library.revision, 1)
    assert.ok(library.takes.some((take) => take.status === 'primary'))
    assert.ok(library.takes.some((take) => take.status === 'alternate'))
    assert.ok(library.takes.some((take) => take.status === 'rejected'))
    assert.ok(library.takes.some((take) =>
      take.status === 'needs-review'))
    assert.ok(library.takes.every((take) =>
      take.evaluations.length === 5))
    assert.equal(
      new Set(library.takes.map((take) =>
        take.retakeBoundaryId)).size,
      library.takes.length,
    )
    assert.ok(library.takes.every((take) =>
      take.retakeBoundaryId.startsWith('retake-boundary-')))
    assert.equal(
      library.takes.filter((take) =>
        take.sourceKind === 'extra-take').length,
      alignment.extraTakes.length,
    )
    const immutableSources = library.takes.map((take) => ({
      id: take.id,
      sourceId: take.sourceId,
      sourceHash: take.sourceHash,
      sourceRangeMs: take.sourceRangeMs,
    }))

    const replayResponse = await apiFetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify(createBody),
    })
    assert.equal(replayResponse.status, 200)
    assert.equal((await replayResponse.json()).data.replayed, true)

    const mismatchResponse = await apiFetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify({
        ...createBody,
        evaluations: [],
      }),
    })
    assert.equal(mismatchResponse.status, 409)
    const staleAlignmentResponse = await apiFetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `take-library-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...createBody,
        expectedAlignmentRunHash: 'f'.repeat(64),
      }),
    })
    assert.equal(staleAlignmentResponse.status, 409)

    const listResponse = await apiFetch(`${endpoint}?limit=20`, {
      headers: { authorization },
    })
    const listPayload = await listResponse.json()
    assert.equal(listResponse.status, 200)
    assert.equal(listPayload.data.libraries.length, 1)
    assert.equal(listPayload.data.libraries[0].id, library.id)
    const readResponse = await apiFetch(
      `${endpoint}/${library.id}`,
      { headers: { authorization } },
    )
    assert.equal(readResponse.status, 200)
    assert.equal(
      (await readResponse.json()).data.library.runHash,
      library.runHash,
    )

    const group = library.groups.find((candidate) => {
      const statuses = library.takes
        .filter((take) => take.groupId === candidate.id)
        .map((take) => take.status)
      return statuses.includes('primary') &&
        statuses.includes('alternate')
    })
    assert.ok(group)
    const initialPrimary = library.takes.find((take) =>
      take.groupId === group.id && take.status === 'primary')
    const alternate = library.takes.find((take) =>
      take.groupId === group.id && take.status === 'alternate')
    assert.ok(initialPrimary)
    assert.ok(alternate)
    const selectionBody = {
      expectedRevision: library.revision,
      groupId: group.id,
      takeId: alternate.id,
      protect: true,
      note: 'Melhor performance confirmada no review E2E.',
    }
    const selectionEndpoint =
      `${endpoint}/${library.id}/selections`
    const selectionKey = `take-selection-${suffix}`
    const selectionResponse = await apiFetch(selectionEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': selectionKey,
      },
      body: JSON.stringify(selectionBody),
    })
    const selectionPayload = await selectionResponse.json()
    assert.equal(
      selectionResponse.status,
      201,
      JSON.stringify(selectionPayload),
    )
    library = selectionPayload.data.library
    assert.equal(library.revision, 2)
    assert.equal(library.selections.length, 1)
    assert.equal(
      library.groups.find((candidate) =>
        candidate.id === group.id).protectedTakeId,
      alternate.id,
    )
    assert.equal(
      library.takes.find((take) =>
        take.id === alternate.id).selectionSource,
      'manual',
    )
    assert.deepEqual(
      library.takes.map((take) => ({
        id: take.id,
        sourceId: take.sourceId,
        sourceHash: take.sourceHash,
        sourceRangeMs: take.sourceRangeMs,
      })),
      immutableSources,
    )

    const selectionReplay = await apiFetch(selectionEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': selectionKey,
      },
      body: JSON.stringify(selectionBody),
    })
    assert.equal(selectionReplay.status, 200)
    assert.equal((await selectionReplay.json()).data.replayed, true)

    const staleSelection = await apiFetch(selectionEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `take-selection-stale-${suffix}`,
      },
      body: JSON.stringify(selectionBody),
    })
    assert.equal(staleSelection.status, 409)
    const unacknowledgedReplacement = await apiFetch(selectionEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `take-selection-protected-${suffix}`,
      },
      body: JSON.stringify({
        expectedRevision: library.revision,
        groupId: group.id,
        takeId: initialPrimary.id,
        protect: true,
      }),
    })
    assert.equal(unacknowledgedReplacement.status, 428)

    const replacementResponse = await apiFetch(selectionEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `take-selection-replace-${suffix}`,
      },
      body: JSON.stringify({
        expectedRevision: library.revision,
        groupId: group.id,
        takeId: initialPrimary.id,
        protect: true,
        replacedProtectedTakeId: alternate.id,
        note: 'Substituição protegida explicitamente confirmada.',
      }),
    })
    const replacementPayload = await replacementResponse.json()
    assert.equal(
      replacementResponse.status,
      201,
      JSON.stringify(replacementPayload),
    )
    library = replacementPayload.data.library
    assert.equal(library.revision, 3)
    assert.equal(library.selections.length, 2)
    assert.equal(
      library.groups.find((candidate) =>
        candidate.id === group.id).protectedTakeId,
      initialPrimary.id,
    )

    assert.equal(
      await client.v2TakeLibraryRun.count({
        where: { workspaceId },
      }),
      1,
    )
    assert.equal(
      await client.v2TakeLibrarySelection.count({
        where: { workspaceId },
      }),
      2,
    )
    for (const row of [
      ...(await client.v2TakeLibraryRun.findMany({ where: { workspaceId } })),
      ...(await client.v2TakeLibrarySelection.findMany({ where: { workspaceId } })),
    ]) {
      assert.equal(row.actorCredentialId, expectedAuthenticationAudit.credentialId)
      assert.equal(row.actorContextHash, expectedAuthenticationAudit.contextHash)
      assert.equal(row.actorAuthenticationKind, 'bearer')
    }
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "take_library_runs"
          SET "runHash" = 'not-a-sha256'
          WHERE "workspaceId" = ${workspaceId}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "take_library_selections"
          SET "resultRevision" = "expectedRevision" + 2
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
