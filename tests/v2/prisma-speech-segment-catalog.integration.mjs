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
      server.close((error) =>
        error
          ? reject(error)
          : resolve(
              typeof address === 'object' && address
                ? address.port
                : 0,
            ))
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

test('T-FR-043/T-FR-044 catalogs speech and evidence segments through the public API and PostgreSQL', {
  skip:
    process.env.APOLLO_SPEECH_SEGMENT_E2E !== '1' &&
    'set APOLLO_SPEECH_SEGMENT_E2E=1 and use an isolated V2 database',
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

  const { assetRightsRevision } =
    await import('../../src/v2/domain/asset-rights.ts')
  const {
    createMediaArtifactManifestV2,
  } = await import('../../src/v2/domain/media-artifact.ts')
  const {
    createMediaTranscript,
  } = await import('../../src/v2/domain/media-transcript.ts')
  const {
    stableSerialize,
  } = await import('../../src/v2/domain/canonical-hash.ts')
  const {
    createApiClientService,
  } = await import('../../src/v2/application/create-api-client.ts')
  const {
    setAssetRightsService,
  } = await import('../../src/v2/application/set-asset-rights.ts')
  const {
    PrismaApiClientRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const {
    PrismaAssetRightsRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
  )
  const {
    nodeApiCredentialCrypto,
  } = await import('../../src/v2/infrastructure/security/api-credential.ts')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `speech-e2e-workspace-${suffix}`
  const projectId = `speech-e2e-project-${suffix}`
  const transcriptId = `speech-e2e-transcript-${suffix}`
  const artifactId = `speech-e2e-artifact-${suffix}`
  const manifestId = `speech-e2e-manifest-${suffix}`
  const createdAt = new Date('2026-07-27T12:30:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Speech segment catalog E2E',
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
      id: `speech-e2e-client-${suffix}`,
      workspaceId,
      name: 'Speech segment catalog E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Biblioteca semântica E2E',
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
    const artifactKey =
      `workspaces/${workspaceId}/masters/${artifactId}.mp4`
    const artifactSha256 = 'a'.repeat(64)
    const manifest = createMediaArtifactManifestV2({
      artifactKey,
      artifactSha256,
      byteSize: 10_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'controlled-speech-e2e',
        version: '1.0.0',
        parameters: { fixture: 'speech-segment-catalog' },
      },
      sources: [],
      probe: {
        width: 1080,
        height: 1920,
        duration: 5,
        fps: 30,
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey,
        sha256: artifactSha256,
        byteSize: BigInt(10_000),
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
        schemaVersion: manifest.schemaVersion,
        manifestHash: manifest.manifestHash,
        recipeId: manifest.recipe.id,
        recipeVersion: manifest.recipe.version,
        parametersHash: manifest.recipe.parametersHash,
        manifestJson: stableSerialize(manifest),
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
        originalFileName: 'speech-catalog-master.mp4',
        createdAt,
      },
    })
    const transcript = createMediaTranscript({
      language: 'pt-BR',
      text: [
        'Uma reflexão completa.',
        'Mas porque',
        'Eu estava explicando...',
        'Outra pessoa conclui a ideia!',
      ].join(' '),
      provider: 'controlled-e2e',
      model: 'aligned-human-evidence-v1',
      words: [
        { word: 'Uma', start: 0, end: 0.2 },
        { word: 'reflexão', start: 0.21, end: 0.5 },
        { word: 'completa.', start: 0.51, end: 0.9 },
        { word: 'Mas', start: 1, end: 1.2 },
        { word: 'porque', start: 1.21, end: 1.5 },
        { word: 'Eu', start: 2, end: 2.1 },
        { word: 'estava', start: 2.11, end: 2.3 },
        { word: 'explicando...', start: 2.31, end: 2.8 },
        { word: 'Outra', start: 3, end: 3.2 },
        { word: 'pessoa', start: 3.21, end: 3.5 },
        { word: 'conclui', start: 3.51, end: 3.8 },
        { word: 'a', start: 3.81, end: 3.9 },
        { word: 'ideia!', start: 3.91, end: 4.3 },
      ],
      segments: [
        {
          id: 10,
          start: 0,
          end: 0.9,
          text: 'Uma reflexão completa.',
          confidence: 0.98,
        },
        {
          id: 20,
          start: 1,
          end: 1.5,
          text: 'Mas porque',
          confidence: 0.84,
        },
        {
          id: 30,
          start: 2,
          end: 2.8,
          text: 'Eu estava explicando...',
          confidence: 0.91,
        },
        {
          id: 40,
          start: 3,
          end: 4.3,
          text: 'Outra pessoa conclui a ideia!',
          confidence: 0.96,
        },
      ],
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
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => createdAt,
      createId: () => `speech-e2e-rights-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: { status: 'approved', allowedUses: ['rendering'] },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })

    const artifactCountBefore =
      await client.v2MediaArtifact.count({ where: { workspaceId } })
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
    server.stdout.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    server.stderr.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`
    const body = {
      sourceTranscriptId: transcriptId,
      expectedTranscriptHash: transcript.transcriptHash,
      extractionPolicyVersion: 'speech-segment-extraction/v1',
      producer: {
        provider: 'apollo',
        model: 'speech-catalog',
        version: '1.0.0',
        confidence: 0.9,
      },
      annotations: [
        {
          sourceSegmentId: 10,
          speaker: { value: 'person-specialist', confidence: 0.99 },
          visual: {
            emotion: { value: 'Confiante', confidence: 0.91 },
            expression: { value: 'Sorriso leve', confidence: 0.88 },
            wardrobe: { value: 'Camisa azul', confidence: 0.95 },
            setting: { value: 'Estúdio claro', confidence: 0.93 },
            colors: [{ value: 'Azul', confidence: 0.9 }],
          },
          intentions: [
            { value: 'Hook de autoridade', confidence: 0.94 },
          ],
        },
        {
          sourceSegmentId: 40,
          speaker: { value: 'person-guest', confidence: 0.97 },
          intentions: [
            { value: 'Conclusão', confidence: 0.9 },
          ],
        },
      ],
    }
    const key = `speech-catalog-${suffix}`
    const catalogResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      },
    )
    const catalogPayload = await catalogResponse.json()
    assert.equal(catalogResponse.status, 201, JSON.stringify(catalogPayload))
    assert.equal(catalogPayload.data.replayed, false)
    assert.equal(catalogPayload.data.run.segmentCount, 4)
    assert.deepEqual(
      catalogPayload.data.run.segments.map(
        (segment) => segment.classification,
      ),
      ['complete-thought', 'incomplete', 'interrupted', 'complete-thought'],
    )
    assert.ok(
      catalogPayload.data.run.segments.every(
        (segment) =>
          segment.physicalMaterialized === false &&
          !('artifactKey' in segment) &&
          segment.rangeMs.length === 2,
      ),
    )

    const replayResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      },
    )
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(
      replayPayload.data.run.id,
      catalogPayload.data.run.id,
    )

    const mismatchResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          ...body,
          producer: { ...body.producer, confidence: 0.8 },
        }),
      },
    )
    assert.equal(mismatchResponse.status, 409)

    const staleTranscriptResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `speech-catalog-stale-${suffix}`,
        },
        body: JSON.stringify({
          ...body,
          expectedTranscriptHash: 'f'.repeat(64),
        }),
      },
    )
    const staleTranscriptPayload = await staleTranscriptResponse.json()
    assert.equal(
      staleTranscriptResponse.status,
      409,
      JSON.stringify(staleTranscriptPayload),
    )
    assert.equal(staleTranscriptPayload.error.code, 'VERSION_CONFLICT')

    const searchUrl = new URL(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
    )
    searchUrl.searchParams.set('q', 'reflexão completa')
    searchUrl.searchParams.set('intention', 'hook de autoridade')
    searchUrl.searchParams.set('speakerId', 'person-specialist')
    searchUrl.searchParams.set('emotion', 'confiante')
    searchUrl.searchParams.set('wardrobe', 'camisa azul')
    searchUrl.searchParams.set('setting', 'estúdio claro')
    searchUrl.searchParams.set('classification', 'complete-thought')
    searchUrl.searchParams.set('completeThoughtMin', '0.8')
    const searchResponse = await fetch(searchUrl, {
      headers: { authorization },
    })
    const searchPayload = await searchResponse.json()
    assert.equal(searchResponse.status, 200, JSON.stringify(searchPayload))
    assert.equal(searchPayload.data.results.length, 1)
    assert.equal(
      searchPayload.data.results[0].segment.sourceSegmentId,
      10,
    )
    assert.deepEqual(
      searchPayload.data.results[0].matchedBy,
      [
        'speech',
        'intention',
        'person',
        'emotion',
        'wardrobe',
        'setting',
        'classification',
        'complete-thought',
      ],
    )
    assert.equal(searchPayload.data.results[0].rightsStatus, 'approved')
    assert.equal(searchPayload.data.results[0].eligibleForReuse, true)

    const interruptedResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments?classification=interrupted`,
      { headers: { authorization } },
    )
    const interruptedPayload = await interruptedResponse.json()
    assert.equal(
      interruptedResponse.status,
      200,
      JSON.stringify(interruptedPayload),
    )
    assert.equal(interruptedPayload.data.results.length, 1)
    assert.equal(
      interruptedPayload.data.results[0].segment.exactText,
      'Eu estava explicando...',
    )

    const unauthenticated = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
    )
    assert.equal(unauthenticated.status, 401)

    const sourceSpeech = catalogPayload.data.run.segments[0]
    const evidenceBody = {
      sourceSpeechSegmentId: sourceSpeech.id,
      expectedSpeechSegmentHash: sourceSpeech.segmentHash,
      category: 'financial-result',
      claim: {
        value: 'Uma reflexão completa gera resultado',
        confidence: 0.98,
      },
      result: {
        value: 'Resultado observado no período medido',
        confidence: 0.95,
      },
      context: {
        value: 'Caso individual sem atribuição causal',
        confidence: 0.97,
      },
      qualifiers: [{
        value: 'No período medido e sem garantia de resultado',
        confidence: 0.99,
      }],
      subject: { value: 'Cliente E2E', confidence: 0.99 },
      attribution: {
        value: 'Depoimento autorizado do Cliente E2E',
        confidence: 0.99,
      },
      compatibleOfferIds: ['offer-e2e-approved'],
      compatibleAudienceTags: ['empreendedores'],
      compatibleObjections: ['preço'],
      credibilityScore: 0.91,
      specificityScore: 0.94,
      authenticityScore: 0.93,
      contextRangeMs: [0, 1000],
      frameRefs: ['frame-e2e-0', 'frame-e2e-27'],
      adjacentEvidenceIds: [],
      requiresContext: true,
      producer: {
        provider: 'apollo',
        model: 'evidence-catalog',
        version: '1.0.0',
        confidence: 0.96,
      },
    }
    const evidenceKey = `evidence-catalog-${suffix}`
    const evidenceResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/evidence-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': evidenceKey,
        },
        body: JSON.stringify(evidenceBody),
      },
    )
    const evidencePayload = await evidenceResponse.json()
    assert.equal(
      evidenceResponse.status,
      201,
      JSON.stringify(evidencePayload),
    )
    assert.equal(evidencePayload.data.replayed, false)
    assert.equal(
      evidencePayload.data.evidence.exactTranscript,
      sourceSpeech.exactText,
    )
    assert.equal(
      evidencePayload.data.evidence.sourceSpeechSegmentHash,
      sourceSpeech.segmentHash,
    )
    assert.equal(
      evidencePayload.data.evidence.integrityStatus,
      'context-required',
    )
    assert.equal(evidencePayload.data.evidence.consentStatus, 'approved')
    assert.equal(
      evidencePayload.data.evidence.physicalMaterialized,
      false,
    )
    assert.deepEqual(
      evidencePayload.data.evidence.contextRangeMs,
      [0, 1000],
    )
    assert.deepEqual(
      evidencePayload.data.evidence.handlesMs,
      { before: 0, after: 100 },
    )
    assert.equal('requestFingerprint' in evidencePayload.data.evidence, false)
    assert.equal('idempotencyKey' in evidencePayload.data.evidence, false)

    const evidenceReplay = await fetch(
      `${baseUrl}/v1/projects/${projectId}/evidence-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': evidenceKey,
        },
        body: JSON.stringify(evidenceBody),
      },
    )
    const evidenceReplayPayload = await evidenceReplay.json()
    assert.equal(evidenceReplay.status, 200)
    assert.equal(evidenceReplayPayload.data.replayed, true)
    assert.equal(
      evidenceReplayPayload.data.evidence.id,
      evidencePayload.data.evidence.id,
    )

    const evidenceMismatch = await fetch(
      `${baseUrl}/v1/projects/${projectId}/evidence-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': evidenceKey,
        },
        body: JSON.stringify({
          ...evidenceBody,
          credibilityScore: 0.5,
        }),
      },
    )
    assert.equal(evidenceMismatch.status, 409)

    const deniedEvidenceSearch = new URL(
      `${baseUrl}/v1/projects/${projectId}/evidence-segments`,
    )
    deniedEvidenceSearch.searchParams.set(
      'q',
      'reflexão completa gera resultado',
    )
    deniedEvidenceSearch.searchParams.set(
      'category',
      'financial-result',
    )
    deniedEvidenceSearch.searchParams.set('subject', 'cliente e2e')
    deniedEvidenceSearch.searchParams.set(
      'offerId',
      'offer-e2e-approved',
    )
    deniedEvidenceSearch.searchParams.set('objection', 'preço')
    deniedEvidenceSearch.searchParams.set(
      'intendedClaim',
      evidenceBody.claim.value,
    )
    deniedEvidenceSearch.searchParams.set('includedContext', 'false')
    const deniedEvidenceResponse = await fetch(deniedEvidenceSearch, {
      headers: { authorization },
    })
    const deniedEvidencePayload = await deniedEvidenceResponse.json()
    assert.equal(
      deniedEvidenceResponse.status,
      200,
      JSON.stringify(deniedEvidencePayload),
    )
    assert.equal(deniedEvidencePayload.data.results.length, 1)
    assert.equal(
      deniedEvidencePayload.data.results[0].reuseDecision.allowed,
      false,
    )
    assert.deepEqual(
      deniedEvidencePayload.data.results[0].reuseDecision.reasons,
      ['CONTEXT_REQUIRED'],
    )

    const allowedEvidenceSearch = new URL(deniedEvidenceSearch)
    allowedEvidenceSearch.searchParams.set('includedContext', 'true')
    const allowedEvidenceResponse = await fetch(allowedEvidenceSearch, {
      headers: { authorization },
    })
    const allowedEvidencePayload = await allowedEvidenceResponse.json()
    assert.equal(allowedEvidenceResponse.status, 200)
    assert.equal(
      allowedEvidencePayload.data.results[0].reuseDecision.allowed,
      true,
    )
    assert.deepEqual(
      allowedEvidencePayload.data.results[0].matchedBy,
      ['text', 'category', 'subject', 'offer', 'objection'],
    )
    assert.deepEqual(
      allowedEvidencePayload.data.results[0].reuseDecision
        .requiredQualifierValues,
      [evidenceBody.qualifiers[0].value],
    )

    const unauthenticatedEvidence = await fetch(
      `${baseUrl}/v1/projects/${projectId}/evidence-segments`,
    )
    assert.equal(unauthenticatedEvidence.status, 401)

    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBefore,
      'cataloging virtual segments must not create physical artifacts',
    )
    assert.equal(
      await client.v2SpeechSegmentCatalogRun.count({
        where: { workspaceId, projectId },
      }),
      1,
    )
    assert.equal(
      await client.v2SpeechSegment.count({
        where: {
          workspaceId,
          projectId,
          physicalMaterialized: false,
        },
      }),
      4,
    )
    assert.equal(
      await client.v2EvidenceSegment.count({
        where: {
          workspaceId,
          projectId,
          physicalMaterialized: false,
        },
      }),
      1,
    )
    await assert.rejects(
      client.v2SpeechSegment.update({
        where: { id: catalogPayload.data.run.segments[0].id },
        data: { physicalMaterialized: true },
      }),
      /speech_segments_virtual_check/,
    )
    await assert.rejects(
      client.v2EvidenceSegment.update({
        where: { id: evidencePayload.data.evidence.id },
        data: { physicalMaterialized: true },
      }),
      /evidence_segments_policy_check/,
    )

    const rotatedRights = await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => new Date(createdAt.getTime() + 1_000),
      createId: () => `speech-e2e-rights-rotated-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 1),
      draft: {
        status: 'approved',
        allowedUses: ['evidence-reuse', 'rendering'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: {
          status: 'approved',
          allowedUses: ['evidence-reuse', 'rendering'],
        },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })
    assert.equal(rotatedRights.replayed, false)
    assert.notEqual(
      rotatedRights.snapshot.id,
      evidencePayload.data.evidence.rightsSnapshotId,
    )
    const staleEvidenceResponse = await fetch(allowedEvidenceSearch, {
      headers: { authorization },
    })
    const staleEvidencePayload = await staleEvidenceResponse.json()
    assert.equal(staleEvidenceResponse.status, 200)
    assert.equal(
      staleEvidencePayload.data.results[0].reuseDecision.allowed,
      false,
    )
    assert.deepEqual(
      staleEvidencePayload.data.results[0].reuseDecision.reasons,
      ['RIGHTS_SNAPSHOT_STALE'],
    )

    const concurrentResponses = await Promise.all([
      ['a', 'Analítica'],
      ['b', 'Energética'],
    ].map(async ([label, emotion]) => {
      const response = await fetch(
        `${baseUrl}/v1/projects/${projectId}/speech-segments`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key':
              `speech-catalog-concurrent-${label}-${suffix}`,
          },
          body: JSON.stringify({
            ...body,
            annotations: [{
              sourceSegmentId: 10,
              speaker: {
                value: 'person-specialist',
                confidence: 0.99,
              },
              visual: {
                emotion: { value: emotion, confidence: 0.9 },
              },
              intentions: [
                { value: 'Hook de autoridade', confidence: 0.94 },
              ],
            }],
          }),
        },
      )
      return {
        status: response.status,
        payload: await response.json(),
      }
    }))
    assert.deepEqual(
      concurrentResponses.map((response) => response.status),
      [201, 201],
      JSON.stringify(concurrentResponses),
    )
    const persistedRuns =
      await client.v2SpeechSegmentCatalogRun.findMany({
        where: { workspaceId, projectId },
        orderBy: { createdAt: 'asc' },
      })
    assert.equal(persistedRuns.length, 3)
    assert.equal(
      persistedRuns.filter((run) => run.active).length,
      1,
      'serializable replacement must leave exactly one active run',
    )
    assert.equal(
      await client.v2SpeechSegment.count({
        where: {
          workspaceId,
          projectId,
          physicalMaterialized: false,
        },
      }),
      12,
      're-cataloging keeps immutable virtual history',
    )
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBefore,
      'concurrent re-cataloging must not create media artifacts',
    )
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.stack : String(error)}\n${serverLogs}`,
    )
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await once(server, 'exit').catch(() => undefined)
    }
    await client.$disconnect()
  }
})
