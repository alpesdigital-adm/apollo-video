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
  const deadline = Date.now() + 60_000
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

function assertSafeE2eDatabaseUrl(value) {
  assert.ok(
    value,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const url = new URL(value)
  const databaseName = url.pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )
  assert.match(
    url.searchParams.get('application_name') ?? '',
    /^apollo-video-e2e-[a-z0-9-]{8,64}$/,
    'E2E application_name must identify one supervised Apollo run',
  )
  for (const [parameter, maximum] of [
    ['connection_limit', 5],
    ['pool_timeout', 10],
    ['connect_timeout', 10],
  ]) {
    const raw = url.searchParams.get(parameter) ?? ''
    assert.match(
      raw,
      /^[1-9][0-9]*$/,
      `${parameter} must be a positive integer`,
    )
    assert.ok(
      Number(raw) <= maximum,
      `${parameter} must not exceed ${maximum}`,
    )
  }
  return url
}

test('T-OPS-REMOTE-E2E rejects unbounded or anonymous database clients', () => {
  const safe =
    'postgresql://test:test@127.0.0.1:5432/apollo_video_v2_e2e' +
    '?application_name=apollo-video-e2e-safe1234' +
    '&connection_limit=5&pool_timeout=10&connect_timeout=10'
  assert.doesNotThrow(() => assertSafeE2eDatabaseUrl(safe))
  for (const unsafe of [
    safe.replace('apollo-video-e2e-safe1234', 'anonymous'),
    safe.replace('connection_limit=5', 'connection_limit=6'),
    safe.replace('pool_timeout=10', 'pool_timeout=11'),
    safe.replace('connect_timeout=10', 'connect_timeout=11'),
    safe.replace('apollo_video_v2_e2e', 'apollo_video_v2'),
  ]) {
    assert.throws(() => assertSafeE2eDatabaseUrl(unsafe))
  }
})

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

test('T-FR-083/T-FR-084/T-FR-085/T-FR-124/T-FR-130/T-FR-131/T-FR-132 persists compatibility, exact validated-hook reuse, ProofNeeds, ProofIntegrity, ProofMode and bounded portfolio preflights through PostgreSQL and /v1', {
  skip:
    process.env.APOLLO_COMPATIBILITY_GRAPH_E2E !== '1' &&
    'set APOLLO_COMPATIBILITY_GRAPH_E2E=1 and use an isolated V2 database',
  timeout: 240_000,
}, async () => {
  assertSafeE2eDatabaseUrl(process.env.V2_DATABASE_URL)

  const { calculateCanonicalHash, stableSerialize } =
    await import('../../src/v2/domain/canonical-hash.ts')
  const { createMediaTranscript } =
    await import('../../src/v2/domain/media-transcript.ts')
  const { createMediaArtifactManifestV2 } =
    await import('../../src/v2/domain/media-artifact.ts')
  const {
    assetRightsRevision,
  } = await import('../../src/v2/domain/asset-rights.ts')
  const { setAssetRightsService } =
    await import('../../src/v2/application/set-asset-rights.ts')
  const { PrismaAssetRightsRepository } =
    await import(
      '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
    )
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
  const { createExternalAuditContext, materializeActorAuditContext } =
    await import('../../src/v2/application/authenticate-api-client.ts')
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
  const validatedArtifactId =
    `compat-e2e-validated-artifact-${suffix}`
  const validatedManifestId =
    `compat-e2e-validated-manifest-${suffix}`
  const validatedTranscriptId =
    `compat-e2e-validated-transcript-${suffix}`
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
      scopes: [
        'projects:read',
        'projects:write',
        'projects:approve',
      ],
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
      scopes: new Set([
        'projects:read',
        'projects:write',
        'projects:approve',
      ]),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext,
    })
    const expectedAuthenticationAudit =
      materializeActorAuditContext(authenticatedActor)
    const storedAuthenticationAudit = {
      actorCredentialId: expectedAuthenticationAudit.credentialId,
      actorEnvironment: expectedAuthenticationAudit.environment,
      actorAuthenticationKind:
        expectedAuthenticationAudit.authenticationKind,
      actorContextHash: expectedAuthenticationAudit.contextHash,
    }
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
        ...storedAuthenticationAudit,
        createdAt,
        updatedAt: createdAt,
      },
    })
    await client.v2ProductionBatchItem.createMany({
      data: batch.items.map((item, sequence) => ({
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
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => createdAt,
      createId: () => `compat-e2e-source-rights-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: {
          status: 'approved',
          allowedUses: ['rendering', 'editorial-reuse'],
        },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })
    const validatedArtifactSha256 = '9'.repeat(64)
    const validatedArtifactKey =
      `fixtures/${validatedArtifactId}.mp4`
    const validatedManifest = createMediaArtifactManifestV2({
      artifactKey: validatedArtifactKey,
      artifactSha256: validatedArtifactSha256,
      byteSize: 1_000_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'validated-hook-fixture',
        version: '1.0.0',
        parameters: { source: 'published-reel' },
      },
      sources: [],
      probe: {
        width: 1080,
        height: 1920,
        duration: 12,
        fps: 30,
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: validatedArtifactId,
        workspaceId,
        artifactKey: validatedArtifactKey,
        sha256: validatedArtifactSha256,
        byteSize: 1_000_000n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: validatedManifestId,
        workspaceId,
        artifactId: validatedArtifactId,
        schemaVersion: validatedManifest.schemaVersion,
        manifestHash: validatedManifest.manifestHash,
        recipeId: validatedManifest.recipe.id,
        recipeVersion: validatedManifest.recipe.version,
        parametersHash:
          validatedManifest.recipe.parametersHash,
        manifestJson: stableSerialize(validatedManifest),
        createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId: validatedArtifactId,
        role: 'source-master',
        originalFileName: 'published-validated-hook.mp4',
        createdAt,
      },
    })
    const validatedTranscript = createMediaTranscript({
      language: 'pt-BR',
      text: 'Pare de desperdiçar verba antes de validar seu criativo.',
      provider: 'controlled-e2e',
      model: 'validation-envelope-e2e',
      words: [
        { word: 'Pare', start: 1, end: 1.4 },
        { word: 'de', start: 1.41, end: 1.6 },
        { word: 'desperdiçar', start: 1.61, end: 2.3 },
        { word: 'verba', start: 2.31, end: 2.7 },
        { word: 'antes', start: 2.71, end: 3.1 },
        { word: 'de', start: 3.11, end: 3.3 },
        { word: 'validar', start: 3.31, end: 3.8 },
        { word: 'seu', start: 3.81, end: 4.1 },
        { word: 'criativo.', start: 4.11, end: 4.8 },
      ],
      segments: [{
        id: 90,
        start: 1,
        end: 4.8,
        text:
          'Pare de desperdiçar verba antes de validar seu criativo.',
        confidence: 0.99,
      }],
    })
    await client.v2MediaTranscript.create({
      data: {
        id: validatedTranscriptId,
        workspaceId,
        projectId,
        sourceArtifactId: validatedArtifactId,
        sourceManifestId: validatedManifestId,
        schemaVersion: validatedTranscript.schemaVersion,
        language: validatedTranscript.language,
        provider: validatedTranscript.provider,
        model: validatedTranscript.model,
        transcriptHash: validatedTranscript.transcriptHash,
        transcriptJson: stableSerialize(validatedTranscript),
        createdAt,
      },
    })
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => createdAt,
      createId: () => `compat-e2e-validated-rights-${suffix}`,
    })({
      workspaceId,
      artifactId: validatedArtifactId,
      baseRevision: assetRightsRevision(validatedArtifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: {
          status: 'not-required',
          allowedUses: [],
        },
      },
      actor: { type: 'api-client', id: issued.client.id },
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
        ...storedAuthenticationAudit,
        createdAt,
        updatedAt: createdAt,
      },
    })

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const serverMode =
      process.env.APOLLO_E2E_SERVER_MODE === 'dev'
        ? 'dev'
        : 'start'
    server = spawn(
      process.execPath,
      [
        'node_modules/next/dist/bin/next',
        serverMode,
        ...(serverMode === 'dev' ? ['--webpack'] : []),
        '-p',
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: serverMode === 'dev'
            ? 'development'
            : 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production',
          APOLLO_PREFLIGHT_COMMIT_TOKEN_SECRET:
            'compatibility-e2e-preflight-secret-at-least-32-bytes',
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

    const recipeContexts = contexts.map((context) => ({
      ...context,
      offerId: 'offer-apollo',
      audienceTags: ['especialistas'],
      claims: [
        { key: 'resultado', value: lines.proof },
        {
          key: 'integrity.person',
          value: 'Profissionais participantes',
        },
        { key: 'integrity.period', value: '2026' },
      ],
      personaId: 'persona-especialista',
      locale: 'pt-BR',
      desiredAction: 'whatsapp',
      continuityProvides: [`role-${
        eligible.find((take) => take.id === context.takeId)
          .assignment.role
      }`],
      continuityRequires: [],
      narrativeTags: ['clareza', 'vendas'],
      tone: .55,
      energy: .62,
      visual: .5,
      experiment: .4,
    }))
    const recipeGraphResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `compatibility-recipe-${suffix}`,
      },
      body: JSON.stringify({
        ...createBody,
        contexts: recipeContexts,
        acceptThreshold: 70,
        reviewThreshold: 60,
      }),
    })
    const recipeGraphPayload = await recipeGraphResponse.json()
    assert.equal(
      recipeGraphResponse.status,
      201,
      JSON.stringify(recipeGraphPayload),
    )
    const recipeGraph = recipeGraphPayload.data.graph
    assert.equal(recipeGraph.summary.blockedCount, 0)
    assert.equal(
      recipeGraph.summary.acceptedCount,
      recipeGraph.summary.edgeCount,
    )
    const hookNode = recipeGraph.nodes.find((node) =>
      node.role === 'hook')
    const bodyNode = recipeGraph.nodes.find((node) =>
      node.role === 'body')
    const proofNode = recipeGraph.nodes.find((node) =>
      node.role === 'proof')
    const ctaNode = recipeGraph.nodes.find((node) =>
      node.role === 'cta')
    assert.ok(hookNode && bodyNode && proofNode && ctaNode)
    assert.ok(recipeGraph.edges.some((edge) =>
      edge.fromNodeId === hookNode.id &&
      edge.toNodeId === bodyNode.id &&
      edge.relation === 'hook-body' &&
      edge.decision === 'accepted'))
    assert.ok(recipeGraph.edges.some((edge) =>
      edge.fromNodeId === bodyNode.id &&
      edge.toNodeId === proofNode.id &&
      edge.relation === 'body-proof' &&
      edge.decision === 'accepted'))
    assert.ok(recipeGraph.edges.some((edge) =>
      edge.fromNodeId === proofNode.id &&
      edge.toNodeId === ctaNode.id &&
      edge.relation === 'proof-cta' &&
      edge.decision === 'accepted'))

    const recipeEndpoint =
      `${baseUrl}/v1/batches/${batchId}/variant-recipes`
    assert.equal((await fetch(recipeEndpoint)).status, 401)
    const fullRecipeBody = {
      compatibilityGraphId: recipeGraph.id,
      expectedCompatibilityGraphRunHash: recipeGraph.runHash,
      selection: {
        hookNodeId: hookNode.id,
        bodyNodeId: bodyNode.id,
        proofNodeId: proofNode.id,
        ctaNodeId: ctaNode.id,
      },
      orderedNodeIds: [
        hookNode.id,
        bodyNode.id,
        proofNode.id,
        ctaNode.id,
      ],
      assumptions: [{
        code: 'FULL_RECIPE_E2E',
        statement: 'Full accepted path selected by the E2E.',
        evidenceRefs: [recipeGraph.runHash],
      }],
      requireProof: true,
      coldOpen: {
        nodeId: proofNode.id,
        sourceRangeMs: [
          proofNode.sourceRangeMs[0],
          Math.min(
            proofNode.sourceRangeMs[1],
            proofNode.sourceRangeMs[0] + 500,
          ),
        ],
        returnAtRole: 'hook',
      },
    }
    const fullRecipeKey = `variant-recipe-full-${suffix}`
    const fullRecipeResponse = await fetch(recipeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': fullRecipeKey,
      },
      body: JSON.stringify(fullRecipeBody),
    })
    const fullRecipePayload = await fullRecipeResponse.json()
    assert.equal(
      fullRecipeResponse.status,
      201,
      JSON.stringify(fullRecipePayload),
    )
    assert.equal(fullRecipePayload.data.replayed, false)
    const fullRecipe = fullRecipePayload.data.recipe
    assert.deepEqual(fullRecipe.orderedNodeIds, [
      hookNode.id,
      bodyNode.id,
      proofNode.id,
      ctaNode.id,
    ])
    assert.equal(fullRecipe.summary.includesProof, true)
    assert.equal(fullRecipe.summary.hasColdOpen, true)
    assert.equal(fullRecipe.lineage.length, 5)
    assert.equal(fullRecipe.lineage[0].usage, 'cold-open')
    assert.equal(fullRecipe.editPlan.duplicatesMasters, false)
    assert.equal(fullRecipe.editPlan.materializesSources, false)
    assert.ok(fullRecipe.lineage.every((entry) =>
      entry.takeId &&
      entry.scriptBlockId &&
      entry.sourceSegmentId &&
      entry.lineageHash))
    assert.ok(
      fullRecipe.scores.weightedEdgeScore <=
        fullRecipe.scores.averageEdgeScore,
      'weakest-link edge score must not exceed the optimistic average',
    )
    assert.notEqual(
      fullRecipe.scores.totalScore,
      fullRecipe.scores.averageEdgeScore,
    )

    const speechResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key':
            `validation-envelope-speech-${suffix}`,
        },
        body: JSON.stringify({
          sourceTranscriptId: validatedTranscriptId,
          expectedTranscriptHash:
            validatedTranscript.transcriptHash,
          extractionPolicyVersion:
            'speech-segment-extraction/v1',
          producer: {
            provider: 'apollo',
            model: 'validation-envelope-e2e',
            version: '1.0.0',
            confidence: 0.99,
          },
          annotations: [{
            sourceSegmentId: 90,
            speaker: {
              value: 'person-specialist',
              confidence: 0.99,
            },
            intentions: [{
              value: 'Hook',
              confidence: 0.99,
            }],
          }],
        }),
      },
    )
    const speechPayload = await speechResponse.json()
    assert.equal(
      speechResponse.status,
      201,
      JSON.stringify(speechPayload),
    )
    const validatedSpeechSegment =
      speechPayload.data.run.segments[0]
    assert.ok(validatedSpeechSegment)

    const validatedResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/validated-segments`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key':
            `validation-envelope-segment-${suffix}`,
        },
        body: JSON.stringify({
          sourceArtifactId: validatedArtifactId,
          expectedArtifactSha256: validatedArtifactSha256,
          sourceManifestId: validatedManifestId,
          expectedManifestHash: validatedManifest.manifestHash,
          sourceSpeechSegmentId: validatedSpeechSegment.id,
          expectedSpeechSegmentHash:
            validatedSpeechSegment.segmentHash,
          policyVersion: 'validated-segment/v1',
          scope: {
            unit: 'hook',
            evidenceScope: 'opening-edit',
          },
          source: {
            platform: 'instagram',
            publicationRef: 'validated-reel-e2e',
            observedAt: '2026-07-10T12:00:00.000Z',
          },
          performance: {
            metric: 'three-second-hold-rate',
            value: 0.81,
            unit: 'ratio',
            sampleSize: 25_000,
            period: {
              start: '2026-07-01T12:00:00.000Z',
              end: '2026-07-10T12:00:00.000Z',
            },
          },
          validatedAt: '2026-07-20T12:00:00.000Z',
        }),
      },
    )
    const validatedPayload = await validatedResponse.json()
    assert.equal(
      validatedResponse.status,
      201,
      JSON.stringify(validatedPayload),
    )
    const validatedSegment = validatedPayload.data.segment
    const mediaCountBeforeEnvelope =
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      })
    const validationEndpoint =
      `${baseUrl}/v1/projects/${projectId}` +
      '/validation-envelope-reuses'
    const preservedBody = {
      batchId,
      validatedSegmentId: validatedSegment.id,
      expectedValidatedSegmentHash:
        validatedSegment.validatedSegmentHash,
      targetRecipeId: fullRecipe.id,
      expectedTargetRecipeHash: fullRecipe.runHash,
      policyVersion: 'validation-envelope-policy/v1',
      requestedChanges: [{
        aspect: 'framing',
        required: false,
        rationale:
          'Ajuste opcional que deve ser bloqueado automaticamente.',
      }],
    }
    const preservedKey =
      `validation-envelope-preserved-${suffix}`
    const preservedResponse = await fetch(validationEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': preservedKey,
      },
      body: JSON.stringify(preservedBody),
    })
    const preservedPayload = await preservedResponse.json()
    assert.equal(
      preservedResponse.status,
      201,
      JSON.stringify(preservedPayload),
    )
    const preserved = preservedPayload.data.reuse
    assert.equal(
      preserved.currentDecision.validation,
      'preserved',
    )
    assert.deepEqual(
      preserved.currentDecision.blockedChanges,
      ['framing'],
    )
    assert.equal(
      preserved.plan.composition
        .targetRecipeHookExcluded,
      true,
    )
    assert.equal(
      preserved.plan.composition
        .validatedSourceOutsideEnvelopeIncluded,
      false,
    )
    assert.equal(
      preserved.plan.composition.excessMaterialIncluded,
      false,
    )
    assert.deepEqual(
      preserved.plan.composition.clips[0].sourceRangeMs,
      validatedSegment.protectedEnvelope.sourceRangeMs,
    )
    assert.deepEqual(
      preserved.plan.composition.orderedRoles,
      ['hook', 'body', 'proof', 'cta'],
    )
    assert.ok(
      preserved.plan.composition
        .excludedTargetRecipeSegmentIds
        .includes(
          fullRecipe.sourceSegments.find((segment) =>
            segment.usage === 'primary' &&
            segment.role === 'hook').id,
        ),
    )
    assert.ok(
      preserved.plan.composition
        .excludedTargetRecipeSegmentIds
        .includes(
          fullRecipe.sourceSegments.find((segment) =>
            segment.usage === 'cold-open').id,
        ),
    )
    const preservedReplay = await fetch(validationEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': preservedKey,
      },
      body: JSON.stringify(preservedBody),
    })
    assert.equal(preservedReplay.status, 200)
    assert.equal((await preservedReplay.json()).data.replayed, true)

    const approvalResponse = await fetch(validationEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key':
          `validation-envelope-approval-${suffix}`,
      },
      body: JSON.stringify({
        ...preservedBody,
        requestedChanges: [{
          aspect: 'opening',
          required: true,
          rationale:
            'A composição exige uma prova antes do hook validado.',
        }],
      }),
    })
    const approvalPayload = await approvalResponse.json()
    assert.equal(
      approvalResponse.status,
      201,
      JSON.stringify(approvalPayload),
    )
    const pending = approvalPayload.data.reuse
    assert.equal(pending.plan.approvalRequired, true)
    assert.equal(
      pending.currentDecision.validation,
      'pending-approval',
    )
    const approvalKey =
      `validation-envelope-decide-${suffix}`
    const decidedResponse = await fetch(
      `${validationEndpoint}/${pending.plan.id}/approval`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': approvalKey,
        },
        body: JSON.stringify({
          expectedPlanHash: pending.plan.planHash,
          action: 'approve',
          note:
            'Aprovo conscientemente a perda da validação histórica.',
        }),
      },
    )
    const decidedPayload = await decidedResponse.json()
    assert.equal(
      decidedResponse.status,
      201,
      JSON.stringify(decidedPayload),
    )
    assert.equal(
      decidedPayload.data.reuse.currentDecision.validation,
      'lost',
    )
    assert.deepEqual(
      decidedPayload.data.reuse.currentDecision.lostAspects,
      ['opening'],
    )
    const decisionReplay = await fetch(
      `${validationEndpoint}/${pending.plan.id}/approval`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': approvalKey,
        },
        body: JSON.stringify({
          expectedPlanHash: pending.plan.planHash,
          action: 'approve',
          note:
            'Aprovo conscientemente a perda da validação histórica.',
        }),
      },
    )
    assert.equal(decisionReplay.status, 200)
    assert.equal((await decisionReplay.json()).data.replayed, true)
    const reuseRead = await fetch(
      `${validationEndpoint}/${pending.plan.id}`,
      { headers },
    )
    assert.equal(reuseRead.status, 200)
    assert.equal(
      (await reuseRead.json()).data.reuse.decisions.length,
      2,
    )
    const reuseList = await fetch(
      `${validationEndpoint}?batchId=${batchId}&limit=10`,
      { headers },
    )
    assert.equal(reuseList.status, 200)
    assert.equal((await reuseList.json()).data.reuses.length, 2)
    assert.equal(
      await client.v2ValidationEnvelopeReuse.count({
        where: { workspaceId, projectId },
      }),
      2,
    )
    assert.equal(
      await client.v2ValidationEnvelopeDecision.count({
        where: { workspaceId, projectId },
      }),
      3,
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      }),
      mediaCountBeforeEnvelope,
      'validation-envelope composition must reference exact ranges without materializing media',
    )

    const proofMediaCountBefore =
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      })
    const proofSpeechResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `proof-need-speech-${suffix}`,
        },
        body: JSON.stringify({
          sourceTranscriptId:
            `compat-e2e-transcript-${suffix}`,
          expectedTranscriptHash: transcript.transcriptHash,
          extractionPolicyVersion:
            'speech-segment-extraction/v1',
          producer: {
            provider: 'apollo',
            model: 'proof-need-e2e',
            version: '1.0.0',
            confidence: 0.99,
          },
          annotations: [{
            sourceSegmentId: 1,
            speaker: {
              value: 'person-specialist',
              confidence: 0.99,
            },
            intentions: [{
              value: 'Proof source',
              confidence: 0.99,
            }],
          }],
        }),
      },
    )
    const proofSpeechPayload = await proofSpeechResponse.json()
    assert.equal(
      proofSpeechResponse.status,
      201,
      JSON.stringify(proofSpeechPayload),
    )
    const proofSpeech = proofSpeechPayload.data.run.segments[0]
    assert.ok(proofSpeech)

    const evidenceResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/evidence-segments`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key':
            `proof-need-evidence-${suffix}`,
        },
        body: JSON.stringify({
          sourceSpeechSegmentId: proofSpeech.id,
          expectedSpeechSegmentHash: proofSpeech.segmentHash,
          category: 'testimonial',
          claim: {
            value: lines.proof,
            confidence: 0.99,
          },
          context: {
            value:
              'Depoimento completo autorizado no roteiro de origem.',
            confidence: 0.99,
          },
          qualifiers: [{
            value: 'period:2026',
            confidence: 0.99,
          }],
          subject: {
            value: 'Profissionais participantes',
            confidence: 0.99,
          },
          attribution: {
            value: 'Especialista autorizado',
            confidence: 0.99,
          },
          compatibleOfferIds: ['offer-apollo'],
          compatibleAudienceTags: ['especialistas'],
          compatibleObjections: [],
          credibilityScore: 0.96,
          specificityScore: 0.94,
          authenticityScore: 0.98,
          contextRangeMs: [
            0,
            Math.ceil(words.at(-1).end * 1_000),
          ],
          frameRefs: ['proof-need-frame-e2e'],
          adjacentEvidenceIds: [],
          requiresContext: false,
          producer: {
            provider: 'apollo',
            model: 'proof-need-e2e',
            version: '1.0.0',
            confidence: 0.99,
          },
        }),
      },
    )
    const evidencePayload = await evidenceResponse.json()
    assert.equal(
      evidenceResponse.status,
      201,
      JSON.stringify(evidencePayload),
    )
    const proofEvidence = evidencePayload.data.evidence
    assert.equal(
      proofEvidence.integrityStatus,
      'context-required',
    )
    assert.equal(proofEvidence.physicalMaterialized, false)

    const argumentBlock = fullRecipe.storyPlan.blocks.find(
      (block) => block.role === 'argument',
    )
    assert.ok(argumentBlock)
    const argumentClaimId = argumentBlock.content.claimIds.find(
      (claimId) => claimId === 'resultado',
    )
    assert.ok(argumentClaimId)
    const proofEndpoint =
      `${baseUrl}/v1/projects/${projectId}/proof-needs`
    const selectedProofBody = {
      batchId,
      targetRecipeId: fullRecipe.id,
      expectedTargetRecipeHash: fullRecipe.runHash,
      policyVersion: 'proof-need-policy/v1',
      declarations: [{
        storyBlockId: argumentBlock.id,
        claimId: argumentClaimId,
        claimText: lines.proof,
        claimKind: 'outcome',
        offerId: 'offer-apollo',
      }],
    }
    const selectedProofKey = `proof-need-selected-${suffix}`
    const selectedProofResponse = await fetch(proofEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': selectedProofKey,
      },
      body: JSON.stringify(selectedProofBody),
    })
    const selectedProofPayload = await selectedProofResponse.json()
    assert.equal(
      selectedProofResponse.status,
      201,
      JSON.stringify(selectedProofPayload),
    )
    assert.equal(selectedProofPayload.data.replayed, false)
    const selectedProofRun = selectedProofPayload.data.run
    const selectedProof = selectedProofRun.items[0]
    assert.equal(selectedProof.type, 'testimonial')
    assert.equal(selectedProof.function, 'build-trust')
    assert.equal(
      selectedProof.moment.placement,
      'existing-proof-block',
    )
    assert.ok(selectedProof.moment.proofStoryBlockId)
    assert.equal(selectedProof.search.strategy, 'evidence-first')
    assert.equal(selectedProof.search.attempted, true)
    assert.ok(
      selectedProof.search.candidateEvidenceIds.includes(
        proofEvidence.id,
      ),
    )
    assert.equal(
      selectedProof.selectedEvidence.id,
      proofEvidence.id,
    )
    assert.equal(
      selectedProof.selectedEvidence.evidenceHash,
      proofEvidence.evidenceHash,
    )
    assert.equal(selectedProof.resolution, 'selected-evidence')
    assert.equal(selectedProof.genericCardGenerated, false)
    assert.equal(selectedProofRun.summary.genericCardCount, 0)
    assert.equal(
      selectedProofRun.storyPlan.proofNeeds[0]
        .selectedEvidenceId,
      proofEvidence.id,
    )

    const selectedProofReplay = await fetch(proofEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': selectedProofKey,
      },
      body: JSON.stringify(selectedProofBody),
    })
    assert.equal(selectedProofReplay.status, 200)
    assert.equal(
      (await selectedProofReplay.json()).data.replayed,
      true,
    )
    const selectedProofMismatch = await fetch(proofEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': selectedProofKey,
      },
      body: JSON.stringify({
        ...selectedProofBody,
        declarations: [{
          ...selectedProofBody.declarations[0],
          claimKind: 'low-risk',
        }],
      }),
    })
    assert.equal(selectedProofMismatch.status, 409)

    const unavailableProofResponse = await fetch(proofEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key':
          `proof-need-unavailable-${suffix}`,
      },
      body: JSON.stringify({
        ...selectedProofBody,
        declarations: [{
          storyBlockId: argumentBlock.id,
          claimId: argumentClaimId,
          claimText: lines.body,
          claimKind: 'mechanism',
        }],
      }),
    })
    const unavailableProofPayload =
      await unavailableProofResponse.json()
    assert.equal(
      unavailableProofResponse.status,
      201,
      JSON.stringify(unavailableProofPayload),
    )
    const unavailableProof =
      unavailableProofPayload.data.run.items[0]
    assert.equal(unavailableProof.type, 'demonstration')
    assert.equal(
      unavailableProof.resolution,
      'proof-unavailable',
    )
    assert.equal(unavailableProof.proofUnavailable, true)
    assert.equal('selectedEvidence' in unavailableProof, false)
    assert.equal(unavailableProof.genericCardGenerated, false)

    const noProofResponse = await fetch(proofEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `proof-need-none-${suffix}`,
      },
      body: JSON.stringify({
        ...selectedProofBody,
        declarations: [{
          storyBlockId: argumentBlock.id,
          claimId: argumentClaimId,
          claimText: lines.body,
          claimKind: 'low-risk',
        }],
      }),
    })
    const noProofPayload = await noProofResponse.json()
    assert.equal(
      noProofResponse.status,
      201,
      JSON.stringify(noProofPayload),
    )
    const noProof = noProofPayload.data.run.items[0]
    assert.equal(noProof.type, 'none')
    assert.equal(noProof.search.attempted, false)
    assert.equal(noProof.resolution, 'no-proof-needed')
    assert.equal(noProof.genericCardGenerated, false)

    const proofRead = await fetch(
      `${proofEndpoint}/${selectedProofRun.id}`,
      { headers },
    )
    assert.equal(proofRead.status, 200)
    assert.equal(
      (await proofRead.json()).data.run.runHash,
      selectedProofRun.runHash,
    )
    const proofList = await fetch(
      `${proofEndpoint}?resolution=proof-unavailable&limit=10`,
      { headers },
    )
    assert.equal(proofList.status, 200)
    assert.equal((await proofList.json()).data.runs.length, 1)
    assert.equal(
      await client.v2ProofNeedRun.count({
        where: { workspaceId, projectId },
      }),
      3,
    )
    assert.equal(
      await client.v2ProofNeedItem.count({
        where: { workspaceId, projectId },
      }),
      3,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_need_items" SET "genericCardGenerated" = TRUE WHERE "id" = $1',
        selectedProof.id,
      ),
      /constraint|check/i,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_need_items" SET "resolution" = $1 WHERE "id" = $2',
        'proof-unavailable',
        selectedProof.id,
      ),
      /constraint|check/i,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_need_runs" SET "genericCardCount" = 1 WHERE "id" = $1',
        selectedProofRun.id,
      ),
      /constraint|check/i,
    )
    const proofIntegrityEndpoint =
      `${baseUrl}/v1/projects/${projectId}/proof-integrity-runs`
    assert.equal(
      (await fetch(proofIntegrityEndpoint)).status,
      401,
    )
    const selectedIntegrityBody = {
      proofNeedRunId: selectedProofRun.id,
      expectedProofNeedRunHash: selectedProofRun.runHash,
      policyVersion: 'proof-integrity-policy/v1',
      uses: [{
        proofNeedItemId: selectedProof.id,
        includedContextRangeMs:
          selectedProof.selectedEvidence.contextRangeMs,
        includedAdjacentEvidenceIds: [],
      }],
    }
    const selectedIntegrityKey =
      `proof-integrity-selected-${suffix}`
    const selectedIntegrityResponse = await fetch(
      proofIntegrityEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': selectedIntegrityKey,
        },
        body: JSON.stringify(selectedIntegrityBody),
      },
    )
    const selectedIntegrityPayload =
      await selectedIntegrityResponse.json()
    assert.equal(
      selectedIntegrityResponse.status,
      201,
      JSON.stringify(selectedIntegrityPayload),
    )
    const selectedIntegrityRun =
      selectedIntegrityPayload.data.run
    const approvedIntegrity =
      selectedIntegrityRun.evaluations[0]
    assert.equal(selectedIntegrityPayload.data.replayed, false)
    assert.equal(approvedIntegrity.outcome, 'approved')
    assert.equal(approvedIntegrity.allowedForAssembly, true)
    assert.equal(approvedIntegrity.comparisons.length, 8)
    assert.ok(approvedIntegrity.comparisons.every(
      (comparison) => comparison.outcome === 'match',
    ))
    assert.equal(
      approvedIntegrity.recipeContext.claimText,
      lines.proof,
    )
    assert.equal(
      approvedIntegrity.recipeContext.productId,
      'offer-apollo',
    )
    assert.equal(
      approvedIntegrity.recipeContext.person,
      'Profissionais participantes',
    )
    assert.equal(
      approvedIntegrity.recipeContext.period,
      '2026',
    )
    assert.deepEqual(
      approvedIntegrity.presentation.visual,
      approvedIntegrity.presentation.verbal,
    )
    assert.deepEqual(
      approvedIntegrity.presentation.visual.qualifiers,
      ['period:2026'],
    )
    assert.equal(
      approvedIntegrity.presentation.visual.attribution,
      'Especialista autorizado',
    )
    assert.equal(approvedIntegrity.fabricationSuggested, false)
    assert.equal(
      selectedIntegrityRun.summary.readyForAssembly,
      true,
    )
    assert.equal(
      selectedIntegrityRun.summary.fabricationSuggestionCount,
      0,
    )

    const selectedIntegrityReplay = await fetch(
      proofIntegrityEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': selectedIntegrityKey,
        },
        body: JSON.stringify(selectedIntegrityBody),
      },
    )
    assert.equal(selectedIntegrityReplay.status, 200)
    assert.equal(
      (await selectedIntegrityReplay.json()).data.replayed,
      true,
    )
    const selectedIntegrityMismatch = await fetch(
      proofIntegrityEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': selectedIntegrityKey,
        },
        body: JSON.stringify({
          ...selectedIntegrityBody,
          uses: [],
        }),
      },
    )
    assert.equal(selectedIntegrityMismatch.status, 409)

    const proofModeEndpoint =
      `${baseUrl}/v1/projects/${projectId}/proof-mode-runs`
    assert.equal((await fetch(proofModeEndpoint)).status, 401)
    const proofModeBody = {
      proofIntegrityRunId: selectedIntegrityRun.id,
      expectedProofIntegrityRunHash: selectedIntegrityRun.runHash,
      policyVersion: 'proof-mode-policy/v1',
      formats: ['9:16', '16:9'],
      rhythm: 'measured',
      overrides: [],
    }
    const proofModeKey = `proof-mode-selected-${suffix}`
    const proofModeResponse = await fetch(proofModeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': proofModeKey,
      },
      body: JSON.stringify(proofModeBody),
    })
    const proofModePayload = await proofModeResponse.json()
    assert.equal(
      proofModeResponse.status,
      201,
      JSON.stringify(proofModePayload),
    )
    const proofModeRun = proofModePayload.data.run
    assert.equal(proofModePayload.data.replayed, false)
    assert.equal(proofModeRun.summary.planCount, 2)
    assert.equal(proofModeRun.summary.automaticCount, 2)
    assert.equal(proofModeRun.summary.manualOverrideCount, 0)
    assert.equal(
      proofModeRun.summary.allIntegrityBindingsPreserved,
      true,
    )
    assert.ok(proofModeRun.plans.every((plan) =>
      plan.mode === 'split-screen' &&
      plan.sourceMediaType === 'video' &&
      plan.contextRequired &&
      plan.identificationRequired &&
      plan.presentation.presentationHash ===
        approvedIntegrity.presentation.presentationHash &&
      JSON.stringify(plan.presentation.visual) ===
        JSON.stringify(plan.presentation.verbal) &&
      plan.rendererContract.materializesNewMedia === false))
    assert.deepEqual(
      proofModeRun.plans.map((plan) => plan.format).sort(),
      ['16:9', '9:16'],
    )

    const proofModeReplay = await fetch(proofModeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': proofModeKey,
      },
      body: JSON.stringify(proofModeBody),
    })
    assert.equal(proofModeReplay.status, 200)
    assert.equal((await proofModeReplay.json()).data.replayed, true)
    const proofModeMismatch = await fetch(proofModeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': proofModeKey,
      },
      body: JSON.stringify({
        ...proofModeBody,
        rhythm: 'fast',
      }),
    })
    assert.equal(proofModeMismatch.status, 409)

    const manualProofModeResponse = await fetch(
      proofModeEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `proof-mode-manual-${suffix}`,
        },
        body: JSON.stringify({
          ...proofModeBody,
          overrides: [{
            proofNeedItemId: approvedIntegrity.proofNeedItemId,
            format: '9:16',
            mode: 'cutaway',
            expectedEvaluationHash:
              approvedIntegrity.evaluationHash,
          }],
        }),
      },
    )
    const manualProofModePayload =
      await manualProofModeResponse.json()
    assert.equal(
      manualProofModeResponse.status,
      201,
      JSON.stringify(manualProofModePayload),
    )
    assert.equal(
      manualProofModePayload.data.run.summary.manualOverrideCount,
      1,
    )
    assert.equal(
      manualProofModePayload.data.run.plans.find((plan) =>
        plan.format === '9:16').mode,
      'cutaway',
    )
    assert.equal(
      manualProofModePayload.data.run.plans.find((plan) =>
        plan.format === '9:16').selection,
      'manual-override',
    )
    const proofModeRead = await fetch(
      `${proofModeEndpoint}/${proofModeRun.id}`,
      { headers },
    )
    assert.equal(proofModeRead.status, 200)
    assert.equal(
      (await proofModeRead.json()).data.run.runHash,
      proofModeRun.runHash,
    )
    const proofModeList = await fetch(
      `${proofModeEndpoint}?mode=cutaway&format=9%3A16&manualOverride=true&limit=10`,
      { headers },
    )
    assert.equal(proofModeList.status, 200)
    assert.equal((await proofModeList.json()).data.runs.length, 1)

    const divergentHash = (value) =>
      `${value.slice(0, 63)}${value.endsWith('0') ? '1' : '0'}`
    const proofModeRunsBeforeRejections =
      await client.v2ProofModeRun.count({
        where: { workspaceId, projectId },
      })
    const staleOverrideResponse = await fetch(proofModeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `proof-mode-stale-override-${suffix}`,
      },
      body: JSON.stringify({
        ...proofModeBody,
        overrides: [{
          proofNeedItemId: approvedIntegrity.proofNeedItemId,
          format: '9:16',
          mode: 'cutaway',
          expectedEvaluationHash: divergentHash(
            approvedIntegrity.evaluationHash,
          ),
        }],
      }),
    })
    const staleOverridePayload = await staleOverrideResponse.json()
    assert.equal(
      staleOverrideResponse.status,
      409,
      JSON.stringify(staleOverridePayload),
    )
    const staleIntegrityResponse = await fetch(proofModeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `proof-mode-stale-integrity-${suffix}`,
      },
      body: JSON.stringify({
        ...proofModeBody,
        expectedProofIntegrityRunHash: divergentHash(
          selectedIntegrityRun.runHash,
        ),
      }),
    })
    const staleIntegrityPayload = await staleIntegrityResponse.json()
    assert.equal(
      staleIntegrityResponse.status,
      409,
      JSON.stringify(staleIntegrityPayload),
    )
    assert.equal(
      await client.v2ProofModeRun.count({
        where: { workspaceId, projectId },
      }),
      proofModeRunsBeforeRejections,
      'a stale ProofMode request must not persist a run',
    )

    const storedPlan = await client.v2ProofModePlan.findFirst({
      where: { workspaceId, projectId, runId: proofModeRun.id },
      orderBy: { sequence: 'asc' },
    })
    assert.ok(storedPlan, 'the ProofMode run must persist its plans')
    const tamperedPlan = JSON.parse(storedPlan.planJson)
    assert.notEqual(
      tamperedPlan.presentation.visual.attribution,
      'Crédito removido',
    )
    tamperedPlan.presentation.visual.attribution = 'Crédito removido'
    await client.v2ProofModePlan.updateMany({
      where: { id: storedPlan.id, workspaceId, projectId },
      data: { planJson: JSON.stringify(tamperedPlan) },
    })
    const tamperedRead = await fetch(
      `${proofModeEndpoint}/${proofModeRun.id}`,
      { headers },
    )
    const tamperedPayload = await tamperedRead.json()
    assert.equal(
      tamperedRead.status,
      409,
      `a tampered ProofMode plan must fail closed: ${JSON.stringify(tamperedPayload)}`,
    )
    const tamperedList = await fetch(
      `${proofModeEndpoint}?limit=10`,
      { headers },
    )
    assert.equal(
      tamperedList.status,
      409,
      'listing must not serve a tampered ProofMode run either',
    )
    await client.v2ProofModePlan.updateMany({
      where: { id: storedPlan.id, workspaceId, projectId },
      data: { planJson: storedPlan.planJson },
    })
    const restoredRead = await fetch(
      `${proofModeEndpoint}/${proofModeRun.id}`,
      { headers },
    )
    const restoredPayload = await restoredRead.json()
    assert.equal(
      restoredRead.status,
      200,
      `restoring the stored plan must restore the read: ${JSON.stringify(restoredPayload)}`,
    )
    assert.equal(
      restoredPayload.data.run.runHash,
      proofModeRun.runHash,
    )
    assert.equal(
      restoredPayload.data.run.plans.find((plan) =>
        plan.id === storedPlan.id).presentation.visual.attribution,
      JSON.parse(storedPlan.planJson).presentation.visual.attribution,
    )

    const contextRange =
      selectedProof.selectedEvidence.contextRangeMs
    const blockedContextResponse = await fetch(
      proofIntegrityEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key':
            `proof-integrity-context-${suffix}`,
        },
        body: JSON.stringify({
          ...selectedIntegrityBody,
          uses: [{
            proofNeedItemId: selectedProof.id,
            includedContextRangeMs: [
              contextRange[0] + 100,
              contextRange[1] - 100,
            ],
            includedAdjacentEvidenceIds: [],
          }],
        }),
      },
    )
    const blockedContextPayload =
      await blockedContextResponse.json()
    assert.equal(
      blockedContextResponse.status,
      201,
      JSON.stringify(blockedContextPayload),
    )
    const blockedContext =
      blockedContextPayload.data.run.evaluations[0]
    assert.equal(blockedContext.outcome, 'blocked')
    assert.equal(blockedContext.allowedForAssembly, false)
    assert.ok(blockedContext.issue.reasonCodes.includes(
      'CONTEXT_RANGE_INCOMPLETE',
    ))
    assert.ok(blockedContext.issue.actions.includes(
      'restore-required-evidence-context',
    ))
    assert.equal(blockedContext.issue.fabricationSuggested, false)
    assert.equal(
      blockedContextPayload.data.run.summary.readyForAssembly,
      false,
    )

    const unavailableIntegrityResponse = await fetch(
      proofIntegrityEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key':
            `proof-integrity-unavailable-${suffix}`,
        },
        body: JSON.stringify({
          proofNeedRunId: unavailableProofPayload.data.run.id,
          expectedProofNeedRunHash:
            unavailableProofPayload.data.run.runHash,
          policyVersion: 'proof-integrity-policy/v1',
          uses: [],
        }),
      },
    )
    const unavailableIntegrityPayload =
      await unavailableIntegrityResponse.json()
    assert.equal(
      unavailableIntegrityResponse.status,
      201,
      JSON.stringify(unavailableIntegrityPayload),
    )
    assert.equal(
      unavailableIntegrityPayload.data.run.evaluations[0].outcome,
      'blocked',
    )
    assert.deepEqual(
      unavailableIntegrityPayload.data.run.evaluations[0]
        .issue.reasonCodes,
      ['PROOF_UNAVAILABLE'],
    )

    const noProofIntegrityResponse = await fetch(
      proofIntegrityEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key':
            `proof-integrity-none-${suffix}`,
        },
        body: JSON.stringify({
          proofNeedRunId: noProofPayload.data.run.id,
          expectedProofNeedRunHash:
            noProofPayload.data.run.runHash,
          policyVersion: 'proof-integrity-policy/v1',
          uses: [],
        }),
      },
    )
    const noProofIntegrityPayload =
      await noProofIntegrityResponse.json()
    assert.equal(
      noProofIntegrityResponse.status,
      201,
      JSON.stringify(noProofIntegrityPayload),
    )
    assert.equal(
      noProofIntegrityPayload.data.run.evaluations[0].outcome,
      'not-applicable',
    )
    assert.equal(
      noProofIntegrityPayload.data.run.summary.readyForAssembly,
      true,
    )

    const integrityRead = await fetch(
      `${proofIntegrityEndpoint}/${selectedIntegrityRun.id}`,
      { headers },
    )
    assert.equal(integrityRead.status, 200)
    assert.equal(
      (await integrityRead.json()).data.run.runHash,
      selectedIntegrityRun.runHash,
    )
    const integrityList = await fetch(
      `${proofIntegrityEndpoint}?outcome=blocked&readyForAssembly=false&limit=10`,
      { headers },
    )
    assert.equal(integrityList.status, 200)
    assert.equal((await integrityList.json()).data.runs.length, 2)
    assert.equal(
      await client.v2ProofIntegrityRun.count({
        where: { workspaceId, projectId },
      }),
      4,
    )
    assert.equal(
      await client.v2ProofIntegrityEvaluation.count({
        where: { workspaceId, projectId },
      }),
      4,
    )
    assert.equal(
      await client.v2ProofModeRun.count({
        where: { workspaceId, projectId },
      }),
      2,
    )
    assert.equal(
      await client.v2ProofModePlan.count({
        where: { workspaceId, projectId },
      }),
      4,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_integrity_evaluations" SET "fabricationSuggested" = TRUE WHERE "id" = $1',
        approvedIntegrity.id,
      ),
      /constraint|check/i,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_integrity_evaluations" SET "reasonCount" = 1 WHERE "id" = $1',
        approvedIntegrity.id,
      ),
      /constraint|check/i,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_integrity_runs" SET "fabricationSuggestionCount" = 1 WHERE "id" = $1',
        selectedIntegrityRun.id,
      ),
      /constraint|check/i,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_mode_plans" SET "identificationRequired" = FALSE WHERE "runId" = $1',
        proofModeRun.id,
      ),
      /constraint|check/i,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_mode_plans" SET "mode" = $1 WHERE "runId" = $2',
        'proof-card',
        proofModeRun.id,
      ),
      /constraint|check/i,
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      }),
      proofMediaCountBefore,
      'ProofNeed, ProofIntegrity and ProofMode planning must remain virtual and never materialize media',
    )

    const fullReplayResponse = await fetch(recipeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': fullRecipeKey,
      },
      body: JSON.stringify(fullRecipeBody),
    })
    assert.equal(fullReplayResponse.status, 200)
    assert.equal((await fullReplayResponse.json()).data.replayed, true)
    const fullMismatchResponse = await fetch(recipeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': fullRecipeKey,
      },
      body: JSON.stringify({
        ...fullRecipeBody,
        requireProof: false,
      }),
    })
    assert.equal(fullMismatchResponse.status, 409)
    const staleRecipeResponse = await fetch(recipeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `variant-recipe-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...fullRecipeBody,
        expectedCompatibilityGraphRunHash: '0'.repeat(64),
      }),
    })
    assert.equal(staleRecipeResponse.status, 409)

    const shortRecipeResponse = await fetch(recipeEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `variant-recipe-short-${suffix}`,
      },
      body: JSON.stringify({
        compatibilityGraphId: recipeGraph.id,
        expectedCompatibilityGraphRunHash: recipeGraph.runHash,
        selection: {
          hookNodeId: hookNode.id,
          bodyNodeId: bodyNode.id,
          ctaNodeId: ctaNode.id,
        },
        orderedNodeIds: [
          hookNode.id,
          bodyNode.id,
          ctaNode.id,
        ],
        requireProof: false,
      }),
    })
    const shortRecipePayload = await shortRecipeResponse.json()
    assert.equal(
      shortRecipeResponse.status,
      201,
      JSON.stringify(shortRecipePayload),
    )
    const shortRecipe = shortRecipePayload.data.recipe
    assert.equal(shortRecipe.summary.includesProof, false)
    assert.equal(shortRecipe.summary.hasColdOpen, false)
    assert.equal(shortRecipe.lineage.length, 3)
    assert.ok(shortRecipe.assumptions.some((assumption) =>
      assumption.code === 'PROOF_OMITTED_BY_POLICY'))

    const recipeReadResponse = await fetch(
      `${recipeEndpoint}/${fullRecipe.id}`,
      { headers },
    )
    assert.equal(recipeReadResponse.status, 200)
    assert.equal(
      (await recipeReadResponse.json()).data.recipe.runHash,
      fullRecipe.runHash,
    )
    const recipeListResponse = await fetch(
      `${recipeEndpoint}?compatibilityGraphId=${recipeGraph.id}&limit=1`,
      { headers },
    )
    assert.equal(recipeListResponse.status, 200)
    assert.equal(
      (await recipeListResponse.json()).data.recipes[0].id,
      shortRecipe.id,
    )

    const portfolioEndpoint =
      `${baseUrl}/v1/batches/${batchId}/variant-portfolio-preflights`
    assert.equal((await fetch(portfolioEndpoint)).status, 401)
    const portfolioBody = {
      compatibilityGraphId: recipeGraph.id,
      expectedCompatibilityGraphRunHash: recipeGraph.runHash,
      requestedRecipeCount: 20,
      requireProof: false,
    }
    const portfolioKey = `variant-portfolio-${suffix}`
    const portfolioResponse = await fetch(portfolioEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': portfolioKey,
      },
      body: JSON.stringify(portfolioBody),
    })
    const portfolioPayload = await portfolioResponse.json()
    assert.equal(
      portfolioResponse.status,
      201,
      JSON.stringify(portfolioPayload),
    )
    const portfolio = portfolioPayload.data.preflight
    assert.equal(portfolioPayload.data.replayed, false)
    assert.ok(portfolioPayload.data.confirmationToken)
    assert.equal(portfolio.theoreticalCandidateCount, '2')
    assert.equal(portfolio.eligibleCandidateCount, '2')
    assert.equal(portfolio.selectedRecipeCount, 2)
    assert.equal(portfolio.confirmation.required, true)
    assert.equal(portfolio.confirmation.satisfied, false)
    assert.equal(portfolio.productMaterialized, false)
    assert.equal(portfolio.estimates.jobsCreated, 0)
    assert.equal(portfolio.estimates.reusedRecipeCount, 2)
    assert.equal(portfolio.estimates.plannedJobCount, 0)
    assert.equal(portfolio.estimates.estimatedCostMinorUnits, 0)
    assert.equal(portfolio.coverage.complete, true)

    const portfolioReplayResponse = await fetch(portfolioEndpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': portfolioKey,
      },
      body: JSON.stringify(portfolioBody),
    })
    const portfolioReplayPayload =
      await portfolioReplayResponse.json()
    assert.equal(portfolioReplayResponse.status, 200)
    assert.equal(portfolioReplayPayload.data.replayed, true)
    assert.equal(
      portfolioReplayPayload.data.confirmationToken,
      portfolioPayload.data.confirmationToken,
    )

    const portfolioMismatchResponse = await fetch(
      portfolioEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': portfolioKey,
        },
        body: JSON.stringify({
          ...portfolioBody,
          requestedRecipeCount: 19,
        }),
      },
    )
    assert.equal(portfolioMismatchResponse.status, 409)

    const confirmedPortfolioResponse = await fetch(
      portfolioEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `variant-portfolio-confirm-${suffix}`,
        },
        body: JSON.stringify({
          ...portfolioBody,
          confirmationToken:
            portfolioPayload.data.confirmationToken,
        }),
      },
    )
    const confirmedPortfolioPayload =
      await confirmedPortfolioResponse.json()
    assert.equal(
      confirmedPortfolioResponse.status,
      201,
      JSON.stringify(confirmedPortfolioPayload),
    )
    const confirmedPortfolio =
      confirmedPortfolioPayload.data.preflight
    assert.equal(confirmedPortfolio.confirmation.required, false)
    assert.equal(confirmedPortfolio.confirmation.satisfied, true)
    assert.equal(confirmedPortfolio.effectiveRecipeLimit, 20)
    assert.equal(confirmedPortfolio.productMaterialized, false)
    assert.equal(confirmedPortfolio.estimates.jobsCreated, 0)

    const stalePortfolioTokenResponse = await fetch(
      portfolioEndpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `variant-portfolio-stale-${suffix}`,
        },
        body: JSON.stringify({
          ...portfolioBody,
          requireProof: true,
          confirmationToken:
            portfolioPayload.data.confirmationToken,
        }),
      },
    )
    assert.equal(stalePortfolioTokenResponse.status, 409)

    const portfolioReadResponse = await fetch(
      `${portfolioEndpoint}/${confirmedPortfolio.id}`,
      { headers },
    )
    assert.equal(portfolioReadResponse.status, 200)
    assert.equal(
      (await portfolioReadResponse.json()).data.preflight.runHash,
      confirmedPortfolio.runHash,
    )
    const portfolioListResponse = await fetch(
      `${portfolioEndpoint}?compatibilityGraphId=${recipeGraph.id}&limit=1`,
      { headers },
    )
    assert.equal(portfolioListResponse.status, 200)
    assert.equal(
      (await portfolioListResponse.json()).data.preflights[0].id,
      confirmedPortfolio.id,
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
      recipeGraph.id,
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
    const recipeCapabilityIds =
      capabilitiesPayload.data.capabilities
        .map((capability) => capability.id)
        .filter((id) => id.includes('variant-recipes'))
    assert.deepEqual(recipeCapabilityIds.sort(), [
      'apollo.batches.variant-recipes.create',
      'apollo.batches.variant-recipes.list',
      'apollo.batches.variant-recipes.read',
    ])
    const portfolioCapabilityIds =
      capabilitiesPayload.data.capabilities
        .map((capability) => capability.id)
        .filter((id) =>
          id.includes('variant-portfolio-preflights'))
    assert.deepEqual(portfolioCapabilityIds.sort(), [
      'apollo.batches.variant-portfolio-preflights.create',
      'apollo.batches.variant-portfolio-preflights.list',
      'apollo.batches.variant-portfolio-preflights.read',
    ])
    const validationEnvelopeCapabilityIds =
      capabilitiesPayload.data.capabilities
        .map((capability) => capability.id)
        .filter((id) =>
          id.includes('validation-envelope-reuses'))
    assert.deepEqual(validationEnvelopeCapabilityIds.sort(), [
      'apollo.projects.validation-envelope-reuses.approve',
      'apollo.projects.validation-envelope-reuses.create',
      'apollo.projects.validation-envelope-reuses.list',
      'apollo.projects.validation-envelope-reuses.read',
    ])
    const proofNeedCapabilityIds =
      capabilitiesPayload.data.capabilities
        .map((capability) => capability.id)
        .filter((id) => id.includes('proof-needs'))
    assert.deepEqual(proofNeedCapabilityIds.sort(), [
      'apollo.projects.proof-needs.create',
      'apollo.projects.proof-needs.list',
      'apollo.projects.proof-needs.read',
    ])
    const proofIntegrityCapabilityIds =
      capabilitiesPayload.data.capabilities
        .map((capability) => capability.id)
        .filter((id) => id.includes('proof-integrity-runs'))
    assert.deepEqual(proofIntegrityCapabilityIds.sort(), [
      'apollo.projects.proof-integrity-runs.create',
      'apollo.projects.proof-integrity-runs.list',
      'apollo.projects.proof-integrity-runs.read',
    ])
    const proofModeCapabilityIds =
      capabilitiesPayload.data.capabilities
        .map((capability) => capability.id)
        .filter((id) => id.includes('proof-mode-runs'))
    assert.deepEqual(proofModeCapabilityIds.sort(), [
      'apollo.projects.proof-mode-runs.create',
      'apollo.projects.proof-mode-runs.list',
      'apollo.projects.proof-mode-runs.read',
    ])

    assert.equal(
      await client.v2CompatibilityGraphRun.count({
        where: { workspaceId },
      }),
      3,
    )
    assert.equal(
      await client.v2CompatibilityGraphNode.count({
        where: { workspaceId },
      }),
      graph.summary.nodeCount +
        recalculatedGraph.summary.nodeCount +
        recipeGraph.summary.nodeCount,
    )
    assert.equal(
      await client.v2CompatibilityGraphEdge.count({
        where: { workspaceId },
      }),
      graph.summary.edgeCount +
        recalculatedGraph.summary.edgeCount +
        recipeGraph.summary.edgeCount,
    )
    assert.equal(
      await client.v2VariantRecipeRun.count({
        where: { workspaceId },
      }),
      2,
    )
    assert.equal(
      await client.v2VariantRecipeLineage.count({
        where: { workspaceId },
      }),
      8,
    )
    assert.equal(
      await client.v2VariantPortfolioPolicy.count({
        where: { workspaceId },
      }),
      1,
    )
    assert.equal(
      await client.v2VariantPortfolioPreflightRun.count({
        where: { workspaceId },
      }),
      2,
    )
    for (const rows of [
      await client.v2CompatibilityGraphRun.findMany({
        where: { workspaceId },
      }),
      await client.v2VariantRecipeRun.findMany({
        where: { workspaceId },
      }),
      await client.v2VariantPortfolioPreflightRun.findMany({
        where: { workspaceId },
      }),
    ]) {
      assert.ok(rows.length > 0)
      for (const row of rows) {
        assert.equal(
          row.actorCredentialId,
          expectedAuthenticationAudit.credentialId,
        )
        assert.equal(
          row.actorContextHash,
          expectedAuthenticationAudit.contextHash,
        )
        assert.equal(row.actorAuthenticationKind, 'bearer')
        assert.equal(row.actorEnvironment, 'production')
      }
    }
    const storedFullRecipe = await client.v2VariantRecipeRun
      .findUniqueOrThrow({
        where: { id: fullRecipe.id },
        include: {
          lineage: { orderBy: { sequence: 'asc' } },
        },
      })
    assert.equal(storedFullRecipe.lineage.length, 5)
    assert.deepEqual(
      storedFullRecipe.lineage.map((entry) => entry.scriptBlockId),
      fullRecipe.lineage.map((entry) => entry.scriptBlockId),
    )
    assert.equal(
      JSON.parse(storedFullRecipe.resultJson)
        .editPlan.duplicatesMasters,
      false,
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
      client.v2VariantRecipeLineage.update({
        where: { id: storedFullRecipe.lineage[0].id },
        data: { nodeId: graph.nodes[0].id },
      }),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "variant_recipe_runs"
          SET "selectedTakeCount" = 3
          WHERE "id" = ${fullRecipe.id}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "variant_portfolio_preflight_runs"
          SET "productMaterialized" = true
          WHERE "workspaceId" = ${workspaceId}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "validation_envelope_reuses"
          SET "excessMaterialIncluded" = true
          WHERE "id" = ${preserved.plan.id}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "validation_envelope_decisions"
          SET "validation" = 'lost'
          WHERE "reusePlanId" = ${pending.plan.id}
            AND "sequence" = 1
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "validation_envelope_decisions"
          SET "sequence" = 3
          WHERE "reusePlanId" = ${pending.plan.id}
            AND "sequence" = 2
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "variant_portfolio_preflight_runs"
          SET "jobsCreated" = 1
          WHERE "workspaceId" = ${workspaceId}
        `,
      ),
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
