import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const GATE = 'APOLLO_PROOF_INTEGRITY_E2E'

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
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
}

function fixtureSuffix() {
  const configured = process.env.APOLLO_PROOF_INTEGRITY_E2E_SUFFIX?.trim()
  if (!configured) return randomUUID().slice(0, 8)
  assert.match(
    configured,
    /^[a-z0-9]{8}$/,
    'APOLLO_PROOF_INTEGRITY_E2E_SUFFIX must contain exactly 8 lowercase letters or digits',
  )
  return configured
}

function assertSafeE2eDatabaseUrl(value) {
  assert.ok(
    value,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const url = new URL(value)
  assert.match(
    url.pathname.slice(1),
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

async function assertNoOrphanBackends(databaseUrl, applicationName) {
  const postflightUrl = new URL(databaseUrl)
  postflightUrl.searchParams.set(
    'application_name',
    `${applicationName}-postflight`,
  )
  postflightUrl.searchParams.set('connection_limit', '1')
  const postflight = new PrismaClient({
    datasourceUrl: postflightUrl.toString(),
  })
  let orphanCount = -1
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const rows = await postflight.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE application_name = $1',
        applicationName,
      )
      orphanCount = Number(rows[0]?.count ?? -1)
      if (orphanCount === 0) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    await postflight.$disconnect()
  }
  assert.equal(
    orphanCount,
    0,
    `postflight found ${orphanCount} backends still bound to ${applicationName}`,
  )
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
    evaluatorVersion: 'proof-integrity-e2e/v1',
    evidenceRefs: [`proof-integrity-evidence-${dimension}`],
    reasonCodes: [],
  }))
}

test('T-OPS-REMOTE-E2E proof integrity E2E refuses unbounded or anonymous database clients', () => {
  const safe =
    'postgresql://test:test@127.0.0.1:5432/apollo_video_v2_e2e' +
    '?application_name=apollo-video-e2e-proof123' +
    '&connection_limit=5&pool_timeout=10&connect_timeout=10'
  assert.doesNotThrow(() => assertSafeE2eDatabaseUrl(safe))
  for (const unsafe of [
    safe.replace('apollo-video-e2e-proof123', 'anonymous'),
    safe.replace('connection_limit=5', 'connection_limit=6'),
    safe.replace('pool_timeout=10', 'pool_timeout=11'),
    safe.replace('connect_timeout=10', 'connect_timeout=11'),
    safe.replace('apollo_video_v2_e2e', 'apollo_video_v2'),
  ]) {
    assert.throws(() => assertSafeE2eDatabaseUrl(unsafe))
  }
})

test('T-FR-131 evaluates the eight integrity dimensions against the exact VariantRecipe and EvidenceSegment through /v1 and PostgreSQL', {
  skip:
    process.env[GATE] !== '1' &&
    `set ${GATE}=1 and use an isolated V2 database`,
  timeout: 600_000,
}, async () => {
  const databaseUrl = process.env.V2_DATABASE_URL
  const applicationName = assertSafeE2eDatabaseUrl(databaseUrl)
    .searchParams.get('application_name')

  const { calculateCanonicalHash, stableSerialize } =
    await import('../../src/v2/domain/canonical-hash.ts')
  const { createMediaTranscript } =
    await import('../../src/v2/domain/media-transcript.ts')
  const { assetRightsRevision } =
    await import('../../src/v2/domain/asset-rights.ts')
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
  const { PROOF_INTEGRITY_DIMENSIONS } =
    await import('../../src/v2/domain/proof-integrity.ts')

  const client = new PrismaClient()
  const suffix = fixtureSuffix()
  const workspaceId = `proof-integrity-e2e-workspace-${suffix}`
  const projectId = `proof-integrity-e2e-project-${suffix}`
  const batchId = `proof-integrity-e2e-batch-${suffix}`
  const alignmentId = `proof-integrity-e2e-alignment-${suffix}`
  const artifactId = `proof-integrity-e2e-artifact-${suffix}`
  const manifestId = `proof-integrity-e2e-manifest-${suffix}`
  const transcriptId = `proof-integrity-e2e-transcript-${suffix}`
  const createdAt = new Date('2026-07-29T14:00:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Proof integrity E2E',
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
      id: `proof-integrity-e2e-client-${suffix}`,
      workspaceId,
      name: 'Proof integrity E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write', 'projects:approve'],
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
        name: 'Integrity gate de prova',
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
      name: 'Integrity gate de prova',
      objective: 'lead-generation',
      sourceGroups: [{
        id: 'source-group-proof-integrity',
        name: 'Roteiro completo',
        sourceArtifactIds: [artifactId],
      }],
      recipes: [{
        id: 'recipe-proof-integrity',
        name: 'Integridade',
        sourceGroupIds: ['source-group-proof-integrity'],
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
        id: `proof-integrity-e2e-item-${suffix}`,
        key: 'proof-integrity/vertical',
        sourceGroupId: 'source-group-proof-integrity',
        recipeId: 'recipe-proof-integrity',
        variantId: 'variant-vertical',
      }],
      createdBy: { type: 'api-client', id: issued.client.id },
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
        requestFingerprint: calculateCanonicalHash({ batchId: batch.id }),
        idempotencyKey: `proof-integrity-e2e-batch-${suffix}`,
        createdByClientId: issued.client.id,
        ...storedAuthenticationAudit,
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
      model: 'proof-integrity-e2e',
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
        manifestHash: calculateCanonicalHash({ manifestId }),
        recipeId: 'fixture.source',
        recipeVersion: '1',
        parametersHash: calculateCanonicalHash({ parameters: 'fixture' }),
        manifestJson: stableSerialize({
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
        }),
        createdAt,
      },
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
    const setAssetRights = (revision, id, draft) =>
      setAssetRightsService({
        repository: new PrismaAssetRightsRepository(client),
        clock: () => createdAt,
        createId: () => id,
      })({
        workspaceId,
        artifactId,
        baseRevision: assetRightsRevision(artifactId, revision),
        draft,
        actor: authenticatedActor,
      })
    await setAssetRights(
      0,
      `proof-integrity-e2e-rights-1-${suffix}`,
      {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: {
          status: 'approved',
          allowedUses: ['rendering', 'editorial-reuse'],
        },
      },
    )
    const alignment = createScriptAlignmentRun({
      id: alignmentId,
      workspaceId,
      projectId,
      batchId,
      document: importScriptDocument({
        title: 'Integrity gate de prova',
        locale: 'pt-BR',
        rawText: [
          `HOOK 1: ${lines.hook}.`,
          `BODY 1: ${lines.body}.`,
          `PROOF 1: ${lines.proof}.`,
          `CTA 1: ${lines.cta}.`,
        ].join('\n'),
      }),
      sources: [{
        transcriptId,
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
        idempotencyKey: `proof-integrity-e2e-alignment-${suffix}`,
        createdByClientId: issued.client.id,
        ...storedAuthenticationAudit,
        createdAt,
        updatedAt: createdAt,
      },
    })

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const serverMode =
      process.env.APOLLO_E2E_SERVER_MODE === 'dev' ? 'dev' : 'start'
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
          NODE_ENV: serverMode === 'dev' ? 'development' : 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production',
          APOLLO_PREFLIGHT_COMMIT_TOKEN_SECRET:
            'proof-integrity-e2e-preflight-secret-at-least-32-bytes',
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
    const post = async (endpoint, key, payload) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': key },
        body: JSON.stringify(payload),
      })
      return { response, payload: await response.json() }
    }

    const candidates = [
      ...new Map(alignment.alignments.flatMap((entry) => [
        ...(entry.selectedCandidate ? [entry.selectedCandidate] : []),
        ...entry.alternatives,
      ]).map((candidate) => [candidate.id, candidate])).values(),
    ]
    const library = await post(
      `${baseUrl}/v1/batches/${batchId}/take-libraries`,
      `proof-integrity-e2e-library-${suffix}`,
      {
        alignmentId,
        expectedAlignmentRunHash: alignment.runHash,
        evaluations: candidates.map((candidate) => ({
          sourceKind: 'alignment-candidate',
          sourceId: candidate.id,
          expectedSourceHash: candidate.candidateHash,
          dimensions: dimensions(.94),
        })),
      },
    )
    assert.equal(
      library.response.status,
      201,
      JSON.stringify(library.payload),
    )
    const takeLibrary = library.payload.data.library
    const eligible = takeLibrary.takes.filter((take) =>
      ['primary', 'alternate'].includes(take.status) &&
      ['hook', 'body', 'proof', 'cta'].includes(take.assignment.role))
    assert.deepEqual(
      [...new Set(eligible.map((take) => take.assignment.role))].sort(),
      ['body', 'cta', 'hook', 'proof'],
    )

    const graphEndpoint =
      `${baseUrl}/v1/batches/${batchId}/compatibility-graphs`
    const contextsFor = (overrides) => eligible.map((take) => ({
      takeId: take.id,
      expectedTakeHash: take.takeHash,
      offerId: overrides.offerId,
      audienceTags: overrides.audienceTags,
      claims: overrides.claims,
      personaId: overrides.personaId,
      locale: 'pt-BR',
      desiredAction: 'whatsapp',
      continuityProvides: [`role-${take.assignment.role}`],
      continuityRequires: [],
      narrativeTags: ['clareza', 'vendas'],
      tone: .55,
      energy: .62,
      visual: .5,
      experiment: .4,
      evidenceRefs: [take.takeHash, take.sourceHash],
    }))
    const exactClaims = [
      { key: 'resultado', value: lines.proof },
      { key: 'integrity.person', value: 'Profissionais participantes' },
      { key: 'integrity.period', value: '2026' },
    ]
    const graphBodyFor = (contexts) => ({
      takeLibraryId: takeLibrary.id,
      expectedTakeLibraryRunHash: takeLibrary.runHash,
      contexts,
      acceptThreshold: 70,
      reviewThreshold: 60,
    })
    const exactGraph = await post(
      graphEndpoint,
      `proof-integrity-e2e-graph-${suffix}`,
      graphBodyFor(contextsFor({
        offerId: 'offer-apollo',
        audienceTags: ['especialistas'],
        claims: exactClaims,
        personaId: 'persona-especialista',
      })),
    )
    assert.equal(
      exactGraph.response.status,
      201,
      JSON.stringify(exactGraph.payload),
    )
    const graph = exactGraph.payload.data.graph
    assert.equal(graph.summary.blockedCount, 0)

    const recipeEndpoint =
      `${baseUrl}/v1/batches/${batchId}/variant-recipes`
    const recipeBodyFor = (selectedGraph) => {
      const node = (role) =>
        selectedGraph.nodes.find((entry) => entry.role === role)
      const hookNode = node('hook')
      const bodyNode = node('body')
      const proofNode = node('proof')
      const ctaNode = node('cta')
      assert.ok(hookNode && bodyNode && proofNode && ctaNode)
      return {
        compatibilityGraphId: selectedGraph.id,
        expectedCompatibilityGraphRunHash: selectedGraph.runHash,
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
          code: 'PROOF_INTEGRITY_E2E',
          statement: 'Accepted path selected by the integrity gate E2E.',
          evidenceRefs: [selectedGraph.runHash],
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
    }
    const exactRecipe = await post(
      recipeEndpoint,
      `proof-integrity-e2e-recipe-${suffix}`,
      recipeBodyFor(graph),
    )
    assert.equal(
      exactRecipe.response.status,
      201,
      JSON.stringify(exactRecipe.payload),
    )
    const recipe = exactRecipe.payload.data.recipe

    const speech = await post(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      `proof-integrity-e2e-speech-${suffix}`,
      {
        sourceTranscriptId: transcriptId,
        expectedTranscriptHash: transcript.transcriptHash,
        extractionPolicyVersion: 'speech-segment-extraction/v1',
        producer: {
          provider: 'apollo',
          model: 'proof-integrity-e2e',
          version: '1.0.0',
          confidence: 0.99,
        },
        annotations: [{
          sourceSegmentId: 1,
          speaker: { value: 'person-specialist', confidence: 0.99 },
          intentions: [{ value: 'Proof source', confidence: 0.99 }],
        }],
      },
    )
    assert.equal(
      speech.response.status,
      201,
      JSON.stringify(speech.payload),
    )
    const speechSegment = speech.payload.data.run.segments[0]

    const evidenceCreated = await post(
      `${baseUrl}/v1/projects/${projectId}/evidence-segments`,
      `proof-integrity-e2e-evidence-${suffix}`,
      {
        sourceSpeechSegmentId: speechSegment.id,
        expectedSpeechSegmentHash: speechSegment.segmentHash,
        category: 'testimonial',
        claim: { value: lines.proof, confidence: 0.99 },
        context: {
          value: 'Depoimento completo autorizado no roteiro de origem.',
          confidence: 0.99,
        },
        qualifiers: [{ value: 'period:2026', confidence: 0.99 }],
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
        contextRangeMs: [0, Math.ceil(words.at(-1).end * 1_000)],
        frameRefs: ['proof-integrity-e2e-frame'],
        adjacentEvidenceIds: [],
        requiresContext: false,
        producer: {
          provider: 'apollo',
          model: 'proof-integrity-e2e',
          version: '1.0.0',
          confidence: 0.99,
        },
      },
    )
    assert.equal(
      evidenceCreated.response.status,
      201,
      JSON.stringify(evidenceCreated.payload),
    )
    const evidence = evidenceCreated.payload.data.evidence
    assert.equal(evidence.physicalMaterialized, false)

    const proofNeedEndpoint =
      `${baseUrl}/v1/projects/${projectId}/proof-needs`
    const argumentBlock = recipe.storyPlan.blocks.find((block) =>
      block.role === 'argument')
    assert.ok(argumentBlock)
    const claimId = argumentBlock.content.claimIds.find((entry) =>
      entry === 'resultado')
    assert.ok(claimId)
    const proofNeed = await post(
      proofNeedEndpoint,
      `proof-integrity-e2e-need-${suffix}`,
      {
        batchId,
        targetRecipeId: recipe.id,
        expectedTargetRecipeHash: recipe.runHash,
        policyVersion: 'proof-need-policy/v1',
        declarations: [{
          storyBlockId: argumentBlock.id,
          claimId,
          claimText: lines.proof,
          claimKind: 'outcome',
          offerId: 'offer-apollo',
        }],
      },
    )
    assert.equal(
      proofNeed.response.status,
      201,
      JSON.stringify(proofNeed.payload),
    )
    const proofNeedRun = proofNeed.payload.data.run
    const proofNeedItem = proofNeedRun.items[0]
    assert.equal(proofNeedItem.resolution, 'selected-evidence')
    assert.equal(proofNeedItem.selectedEvidence.id, evidence.id)

    const integrityEndpoint =
      `${baseUrl}/v1/projects/${projectId}/proof-integrity-runs`
    const artifactCountBeforeGate = await client.v2MediaArtifact.count({
      where: { workspaceId },
    })
    const manifestCountBeforeGate =
      await client.v2MediaArtifactManifest.count({ where: { workspaceId } })
    const contextRange = proofNeedItem.selectedEvidence.contextRangeMs

    assert.equal((await fetch(integrityEndpoint)).status, 401)
    assert.equal(
      (await fetch(integrityEndpoint, {
        headers: { authorization: 'Bearer proof-integrity-e2e-invalid' },
      })).status,
      401,
    )

    const approvedBody = {
      proofNeedRunId: proofNeedRun.id,
      expectedProofNeedRunHash: proofNeedRun.runHash,
      policyVersion: 'proof-integrity-policy/v1',
      uses: [{
        proofNeedItemId: proofNeedItem.id,
        includedContextRangeMs: contextRange,
        includedAdjacentEvidenceIds: [],
      }],
    }
    const approvedKey = `proof-integrity-e2e-approved-${suffix}`
    const approvedRun = await post(
      integrityEndpoint,
      approvedKey,
      approvedBody,
    )
    assert.equal(
      approvedRun.response.status,
      201,
      JSON.stringify(approvedRun.payload),
    )
    assert.equal(approvedRun.payload.data.replayed, false)
    const run = approvedRun.payload.data.run
    const approved = run.evaluations[0]
    assert.equal(approved.outcome, 'approved')
    assert.equal(approved.allowedForAssembly, true)
    assert.equal(approved.issue, undefined)
    assert.equal(approved.fabricationSuggested, false)
    assert.equal(run.targetRecipeId, recipe.id)
    assert.equal(run.targetRecipeHash, recipe.runHash)
    assert.equal(run.proofNeedRunHash, proofNeedRun.runHash)
    assert.equal(approved.selectedEvidenceId, evidence.id)
    assert.equal(approved.selectedEvidenceHash, evidence.evidenceHash)

    assert.equal(approved.comparisons.length, 8)
    assert.deepEqual(
      approved.comparisons.map((entry) => entry.dimension).toSorted(),
      [...PROOF_INTEGRITY_DIMENSIONS].toSorted(),
      'every declared integrity dimension must be compared',
    )
    const comparison = (dimension) =>
      approved.comparisons.find((entry) => entry.dimension === dimension)
    for (const [dimension, expected, actual] of [
      ['claim', [lines.proof], [lines.proof]],
      ['product', ['offer-apollo'], ['offer-apollo']],
      [
        'person',
        ['Profissionais participantes'],
        ['Profissionais participantes'],
      ],
      ['period', ['2026'], ['2026']],
      ['audience', ['especialistas'], ['especialistas']],
      ['rights', ['approved'], ['approved']],
      ['consent', ['approved'], ['approved']],
      [
        'context',
        [`${contextRange[0]}-${contextRange[1]}`],
        [`${contextRange[0]}-${contextRange[1]}`],
      ],
    ]) {
      const result = comparison(dimension)
      assert.equal(result.outcome, 'match', dimension)
      assert.equal(result.reasonCode, undefined, dimension)
      assert.deepEqual(result.expected, expected, dimension)
      assert.deepEqual(result.actual, actual, dimension)
    }
    assert.equal(
      approved.recipeContext.nodeHash,
      graph.nodes.find((node) =>
        node.id === approved.recipeContext.nodeId).nodeHash,
    )
    assert.equal(
      stableSerialize(approved.presentation.visual),
      stableSerialize(approved.presentation.verbal),
    )
    assert.deepEqual(
      approved.presentation.visual.qualifiers,
      ['period:2026'],
    )
    assert.equal(
      approved.presentation.visual.attribution,
      'Especialista autorizado',
    )
    assert.equal(approved.presentation.visual.mandatory, true)
    assert.equal(approved.presentation.verbal.mandatory, true)
    assert.equal(approved.presentation.evidenceHash, evidence.evidenceHash)
    assert.deepEqual(
      approved.presentation.requiredContextRangeMs,
      contextRange,
    )
    assert.equal(run.summary.readyForAssembly, true)
    assert.equal(run.summary.approvedCount, 1)
    assert.equal(run.summary.fabricationSuggestionCount, 0)

    const replay = await post(integrityEndpoint, approvedKey, approvedBody)
    assert.equal(
      replay.response.status,
      200,
      JSON.stringify(replay.payload),
    )
    assert.equal(replay.payload.data.replayed, true)
    assert.equal(replay.payload.data.run.id, run.id)
    assert.equal(replay.payload.data.run.runHash, run.runHash)

    const reusedKey = await post(integrityEndpoint, approvedKey, {
      ...approvedBody,
      uses: [{
        proofNeedItemId: proofNeedItem.id,
        includedContextRangeMs: contextRange,
        includedAdjacentEvidenceIds: ['proof-integrity-e2e-other'],
      }],
    })
    assert.equal(reusedKey.response.status, 409)
    assert.equal(
      reusedKey.payload.error.code,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )

    const tamperedHash = `${proofNeedRun.runHash.slice(0, 63)}${
      proofNeedRun.runHash.endsWith('0') ? '1' : '0'
    }`
    const tamperedRequest = await post(
      integrityEndpoint,
      `proof-integrity-e2e-tampered-need-${suffix}`,
      { ...approvedBody, expectedProofNeedRunHash: tamperedHash },
    )
    assert.equal(tamperedRequest.response.status, 409)
    assert.equal(tamperedRequest.payload.error.code, 'VERSION_CONFLICT')
    const malformedHash = await post(
      integrityEndpoint,
      `proof-integrity-e2e-malformed-${suffix}`,
      { ...approvedBody, expectedProofNeedRunHash: 'not-a-sha256' },
    )
    assert.equal(malformedHash.response.status, 422)

    const contextBlocked = await post(
      integrityEndpoint,
      `proof-integrity-e2e-context-${suffix}`,
      {
        ...approvedBody,
        uses: [{
          proofNeedItemId: proofNeedItem.id,
          includedContextRangeMs: [
            contextRange[0] + 100,
            contextRange[1] - 100,
          ],
          includedAdjacentEvidenceIds: [],
        }],
      },
    )
    assert.equal(
      contextBlocked.response.status,
      201,
      JSON.stringify(contextBlocked.payload),
    )
    const blockedContext = contextBlocked.payload.data.run.evaluations[0]
    assert.equal(blockedContext.outcome, 'blocked')
    assert.equal(blockedContext.allowedForAssembly, false)
    assert.equal(
      blockedContext.comparisons.find((entry) =>
        entry.dimension === 'context').reasonCode,
      'CONTEXT_RANGE_INCOMPLETE',
    )
    assert.deepEqual(
      blockedContext.issue.reasonCodes,
      ['CONTEXT_RANGE_INCOMPLETE'],
    )
    assert.deepEqual(
      blockedContext.issue.actions,
      ['restore-required-evidence-context'],
    )
    assert.equal(blockedContext.issue.severity, 'hard')
    assert.equal(blockedContext.issue.fabricationSuggested, false)
    assert.doesNotMatch(
      `${blockedContext.issue.message} ${blockedContext.issue.actions.join(' ')}`,
      /fabric|gerar prova|inventar|estimar/i,
    )
    assert.equal(
      contextBlocked.payload.data.run.summary.readyForAssembly,
      false,
    )
    assert.equal(
      contextBlocked.payload.data.run.summary.fabricationSuggestionCount,
      0,
    )

    const driftedGraph = await post(
      graphEndpoint,
      `proof-integrity-e2e-drift-graph-${suffix}`,
      graphBodyFor(contextsFor({
        offerId: 'offer-outro',
        audienceTags: ['enterprise'],
        claims: [
          { key: 'resultado', value: 'A receita dobrou em uma semana' },
          { key: 'integrity.person', value: 'Cliente não catalogado' },
          { key: 'integrity.period', value: '2019' },
        ],
        personaId: 'persona-enterprise',
      })),
    )
    assert.equal(
      driftedGraph.response.status,
      201,
      JSON.stringify(driftedGraph.payload),
    )
    assert.equal(driftedGraph.payload.data.graph.summary.blockedCount, 0)
    const driftedRecipe = await post(
      recipeEndpoint,
      `proof-integrity-e2e-drift-recipe-${suffix}`,
      recipeBodyFor(driftedGraph.payload.data.graph),
    )
    assert.equal(
      driftedRecipe.response.status,
      201,
      JSON.stringify(driftedRecipe.payload),
    )
    const drifted = driftedRecipe.payload.data.recipe
    const driftedBlock = drifted.storyPlan.blocks.find((block) =>
      block.role === 'argument')
    const driftedNeed = await post(
      proofNeedEndpoint,
      `proof-integrity-e2e-drift-need-${suffix}`,
      {
        batchId,
        targetRecipeId: drifted.id,
        expectedTargetRecipeHash: drifted.runHash,
        policyVersion: 'proof-need-policy/v1',
        declarations: [{
          storyBlockId: driftedBlock.id,
          claimId: driftedBlock.content.claimIds.find((entry) =>
            entry === 'resultado'),
          claimText: lines.proof,
          claimKind: 'outcome',
        }],
      },
    )
    assert.equal(
      driftedNeed.response.status,
      201,
      JSON.stringify(driftedNeed.payload),
    )
    const driftedNeedRun = driftedNeed.payload.data.run
    const driftedItem = driftedNeedRun.items[0]
    assert.equal(driftedItem.resolution, 'selected-evidence')
    assert.equal(driftedItem.selectedEvidence.id, evidence.id)
    const driftedIntegrity = await post(
      integrityEndpoint,
      `proof-integrity-e2e-drift-${suffix}`,
      {
        proofNeedRunId: driftedNeedRun.id,
        expectedProofNeedRunHash: driftedNeedRun.runHash,
        policyVersion: 'proof-integrity-policy/v1',
        uses: [{
          proofNeedItemId: driftedItem.id,
          includedContextRangeMs: contextRange,
          includedAdjacentEvidenceIds: [],
        }],
      },
    )
    assert.equal(
      driftedIntegrity.response.status,
      201,
      JSON.stringify(driftedIntegrity.payload),
    )
    const driftedEvaluation =
      driftedIntegrity.payload.data.run.evaluations[0]
    assert.equal(driftedEvaluation.outcome, 'blocked')
    assert.equal(driftedEvaluation.allowedForAssembly, false)
    for (const [dimension, reasonCode] of [
      ['claim', 'CLAIM_MISMATCH'],
      ['product', 'PRODUCT_MISMATCH'],
      ['person', 'PERSON_MISMATCH'],
      ['period', 'PERIOD_MISMATCH'],
      ['audience', 'AUDIENCE_MISMATCH'],
    ]) {
      const result = driftedEvaluation.comparisons.find((entry) =>
        entry.dimension === dimension)
      assert.equal(result.outcome, 'mismatch', dimension)
      assert.equal(result.reasonCode, reasonCode, dimension)
      assert.ok(
        driftedEvaluation.issue.reasonCodes.includes(reasonCode),
        reasonCode,
      )
    }
    assert.ok(driftedEvaluation.issue.actions.includes(
      'select-compatible-existing-evidence',
    ))
    assert.equal(driftedEvaluation.issue.fabricationSuggested, false)
    assert.equal(driftedEvaluation.fabricationSuggested, false)

    await setAssetRights(
      1,
      `proof-integrity-e2e-rights-2-${suffix}`,
      {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: {
          status: 'approved',
          allowedUses: ['rendering', 'editorial-reuse'],
        },
      },
    )
    const staleRights = await post(
      integrityEndpoint,
      `proof-integrity-e2e-stale-rights-${suffix}`,
      approvedBody,
    )
    assert.equal(
      staleRights.response.status,
      201,
      JSON.stringify(staleRights.payload),
    )
    const staleEvaluation = staleRights.payload.data.run.evaluations[0]
    assert.equal(staleEvaluation.outcome, 'blocked')
    assert.equal(staleEvaluation.allowedForAssembly, false)
    const staleComparison = staleEvaluation.comparisons.find((entry) =>
      entry.dimension === 'rights')
    assert.equal(staleComparison.outcome, 'mismatch')
    assert.equal(staleComparison.reasonCode, 'RIGHTS_SNAPSHOT_STALE')
    assert.ok(staleEvaluation.issue.reasonCodes.includes(
      'RIGHTS_SNAPSHOT_STALE',
    ))
    assert.ok(staleEvaluation.issue.actions.includes(
      'renew-rights-or-consent',
    ))
    assert.equal(staleEvaluation.issue.fabricationSuggested, false)
    assert.equal(
      staleEvaluation.comparisons.find((entry) =>
        entry.dimension === 'consent').outcome,
      'match',
      'a superseded rights snapshot must not be reported as missing consent',
    )
    assert.equal(
      staleRights.payload.data.run.summary.readyForAssembly,
      false,
    )

    const read = await fetch(`${integrityEndpoint}/${run.id}`, { headers })
    assert.equal(read.status, 200)
    const readPayload = await read.json()
    assert.equal(readPayload.data.run.runHash, run.runHash)
    assert.equal(
      readPayload.data.run.evaluations[0].presentation.presentationHash,
      approved.presentation.presentationHash,
    )
    assert.equal('idempotencyKey' in readPayload.data.run, false)
    assert.equal('requestFingerprint' in readPayload.data.run, false)
    const list = await fetch(
      `${integrityEndpoint}?outcome=blocked&readyForAssembly=false&limit=10`,
      { headers },
    )
    assert.equal(list.status, 200)
    assert.equal((await list.json()).data.runs.length, 3)
    const missing = await fetch(
      `${integrityEndpoint}/proof-integrity-run-absent-${suffix}`,
      { headers },
    )
    assert.equal(missing.status, 404)

    const storedRun = await client.v2ProofIntegrityRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    const originalRunJson = storedRun.runJson
    await client.$executeRawUnsafe(
      'UPDATE "proof_integrity_runs" SET "runJson" = $1 WHERE "id" = $2',
      originalRunJson.replace(
        'Especialista autorizado',
        'Especialista renomado',
      ),
      run.id,
    )
    const tamperedRead = await fetch(`${integrityEndpoint}/${run.id}`, {
      headers,
    })
    assert.equal(
      tamperedRead.status,
      409,
      'a tampered persisted run must fail closed through the API',
    )
    assert.equal(
      (await tamperedRead.json()).error.code,
      'PERSISTENCE_CONFLICT',
    )
    await client.$executeRawUnsafe(
      'UPDATE "proof_integrity_runs" SET "runJson" = $1 WHERE "id" = $2',
      originalRunJson,
      run.id,
    )
    const restoredRead = await fetch(`${integrityEndpoint}/${run.id}`, {
      headers,
    })
    assert.equal(restoredRead.status, 200)
    assert.equal(
      (await restoredRead.json()).data.run.runHash,
      run.runHash,
    )

    const storedEvaluation =
      await client.v2ProofIntegrityEvaluation.findFirstOrThrow({
        where: { runId: run.id },
      })
    const originalEvaluationJson = storedEvaluation.evaluationJson
    await client.$executeRawUnsafe(
      'UPDATE "proof_integrity_evaluations" SET "evaluationJson" = $1 WHERE "id" = $2',
      originalEvaluationJson.replace('period:2026', 'period:2027'),
      storedEvaluation.id,
    )
    const tamperedEvaluationRead = await fetch(
      `${integrityEndpoint}/${run.id}`,
      { headers },
    )
    assert.equal(tamperedEvaluationRead.status, 409)
    await client.$executeRawUnsafe(
      'UPDATE "proof_integrity_evaluations" SET "evaluationJson" = $1 WHERE "id" = $2',
      originalEvaluationJson,
      storedEvaluation.id,
    )
    assert.equal(
      (await fetch(`${integrityEndpoint}/${run.id}`, { headers })).status,
      200,
    )

    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_integrity_evaluations" SET "fabricationSuggested" = TRUE WHERE "id" = $1',
        storedEvaluation.id,
      ),
      /constraint|check/i,
    )
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "proof_integrity_runs" SET "fabricationSuggestionCount" = 1 WHERE "id" = $1',
        run.id,
      ),
      /constraint|check/i,
    )

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
      await client.v2ProofIntegrityEvaluation.count({
        where: { workspaceId, projectId, fabricationSuggested: true },
      }),
      0,
    )
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBeforeGate,
      'the integrity gate must not create media artifacts',
    )
    assert.equal(
      await client.v2MediaArtifactManifest.count({ where: { workspaceId } }),
      manifestCountBeforeGate,
      'the integrity gate must not materialize media manifests',
    )
    assert.equal(
      await client.v2ProofModeRun.count({ where: { workspaceId } }),
      0,
      'the integrity gate must not start proof modes or renders',
    )
    for (const row of await client.v2ProofIntegrityRun.findMany({
      where: { workspaceId },
    })) {
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
      assert.equal(row.fabricationSuggestionCount, 0)
    }
  } catch (error) {
    if (serverLogs) {
      error.message += `\nNext logs:\n${serverLogs.slice(-8_000)}`
    }
    throw error
  } finally {
    await stopServer(server)
    await client.$disconnect()
    await assertNoOrphanBackends(databaseUrl, applicationName)
  }
})
