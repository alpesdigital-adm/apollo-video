import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { NextRequest } from 'next/server'
import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('T-FR-133/T-FR-134 resumes a two-hour master and extracts one API-first two-minute window', {
  skip:
    process.env.APOLLO_LONG_FORM_WORKFLOW_E2E !== '1' &&
    'set APOLLO_LONG_FORM_WORKFLOW_E2E=1 with an isolated local V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL)
  process.env.APOLLO_API_ENVIRONMENT = 'production'
  const databaseUrl = new URL(process.env.V2_DATABASE_URL)
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(
      databaseUrl.hostname,
    ),
    'this E2E is restricted to disposable local PostgreSQL',
  )
  const applicationName =
    databaseUrl.searchParams.get('application_name')
  assert.match(
    applicationName ?? '',
    /^apollo-video-e2e-[a-z0-9-]+$/,
  )
  const boundedConnectionParameter = (
    name,
    maximum,
  ) => {
    const value = Number(databaseUrl.searchParams.get(name))
    assert.ok(
      Number.isInteger(value) && value >= 1 && value <= maximum,
      `${name} must be between 1 and ${maximum}`,
    )
  }
  boundedConnectionParameter('connection_limit', 5)
  boundedConnectionParameter('pool_timeout', 10)
  boundedConnectionParameter('connect_timeout', 10)
  const databaseName = databaseUrl.pathname.slice(1)
  assert.match(databaseName, /(?:^|_)e2e(?:_|$)/)

  const [
    { createMediaArtifactManifestV2 },
    { createMediaTranscript },
    { stableSerialize },
    { assetRightsRevision },
    { createApiClientService },
    { setAssetRightsService },
    { createLongFormTranscriptStageProcessor },
    { createSpeakerDiarizationStageProcessor },
    { produceContiguousEvidenceService },
    { produceContiguousEvaluationsService },
    {
      createLongFormDerivedStageProcessor,
      createLongFormIndexStageRouter,
    },
    { runNextLongFormIndexOperationService },
    { PrismaApiClientRepository },
    { PrismaAssetRightsRepository },
    { PrismaLongFormIndexWorkflowRepository },
    { PrismaSpeakerDiarizationRepository },
    { PrismaHierarchicalProcessingRepository },
    { PrismaLongFormIndexRepository },
    { PrismaContiguousEvidenceRepository },
    { PrismaContiguousEvaluationRepository },
    { PrismaPublicOperationRepository },
    { RightsIntegrityContiguousEvidenceAnalyzer },
    {
      TranscriptBoundaryContiguousEvidenceAnalyzer,
      TranscriptDensityContiguousEvidenceAnalyzer,
    },
    { AudioContiguousEvidenceAnalyzer },
    { VisualContiguousEvidenceAnalyzer },
    { DeterministicContiguousEvaluationProvider },
    { disconnectV2PostgresClient },
    { nodeApiCredentialCrypto },
    route,
    readRoute,
    extractionRoute,
    readExtractionRoute,
  ] = await Promise.all([
    import('../../src/v2/domain/media-artifact.ts'),
    import('../../src/v2/domain/media-transcript.ts'),
    import('../../src/v2/domain/canonical-hash.ts'),
    import('../../src/v2/domain/asset-rights.ts'),
    import('../../src/v2/application/create-api-client.ts'),
    import('../../src/v2/application/set-asset-rights.ts'),
    import('../../src/v2/application/long-form-transcript-stage-processor.ts'),
    import('../../src/v2/application/speaker-diarization-stage-processor.ts'),
    import('../../src/v2/application/contiguous-evidence.ts'),
    import('../../src/v2/application/contiguous-evaluation.ts'),
    import('../../src/v2/application/long-form-derived-stage-processor.ts'),
    import('../../src/v2/application/run-long-form-index-worker.ts'),
    import('../../src/v2/infrastructure/prisma/api-client-repository.ts'),
    import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts'),
    import('../../src/v2/infrastructure/prisma/long-form-index-workflow-repository.ts'),
    import('../../src/v2/infrastructure/prisma/speaker-diarization-repository.ts'),
    import('../../src/v2/infrastructure/prisma/hierarchical-processing-repository.ts'),
    import('../../src/v2/infrastructure/prisma/long-form-index-repository.ts'),
    import('../../src/v2/infrastructure/prisma/contiguous-evidence-repository.ts'),
    import('../../src/v2/infrastructure/prisma/contiguous-evaluation-repository.ts'),
    import('../../src/v2/infrastructure/prisma/public-operation-repository.ts'),
    import('../../src/v2/infrastructure/analysis/rights-integrity-contiguous-evidence-analyzer.ts'),
    import('../../src/v2/infrastructure/analysis/transcript-contiguous-evidence-analyzers.ts'),
    import('../../src/v2/infrastructure/analysis/audio-contiguous-evidence-analyzer.ts'),
    import('../../src/v2/infrastructure/analysis/visual-contiguous-evidence-analyzer.ts'),
    import('../../src/v2/infrastructure/analysis/deterministic-contiguous-evaluation-provider.ts'),
    import('../../src/v2/infrastructure/prisma-postgres/client.ts'),
    import('../../src/v2/infrastructure/security/api-credential.ts'),
    import('../../src/app/v1/projects/[projectId]/long-form-index-workflows/route.ts'),
    import('../../src/app/v1/projects/[projectId]/long-form-index-workflows/[workflowId]/route.ts'),
    import('../../src/app/v1/projects/[projectId]/contiguous-extractions/route.ts'),
    import('../../src/app/v1/projects/[projectId]/contiguous-extractions/[extractionId]/route.ts'),
  ])

  let prisma = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `long-form-workflow-e2e-${suffix}`
  const projectId = `long-form-project-e2e-${suffix}`
  const artifactId = `long-form-artifact-e2e-${suffix}`
  const manifestId = `long-form-manifest-e2e-${suffix}`
  const createdAt = new Date()
  const artifactSha256 = 'a'.repeat(64)
  let transcriptCalls = 0
  let diarizationCalls = 0

  try {
    await prisma.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Long-form workflow E2E',
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(prisma),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `long-form-client-e2e-${suffix}`,
      workspaceId,
      name: 'Long-form workflow E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await prisma.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Live controlada de duas horas',
        status: 'draft',
        objective: 'discovery',
        format: '16:9',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    const artifactKey =
      `workspaces/${workspaceId}/masters/${artifactId}.mp4`
    const manifest = createMediaArtifactManifestV2({
      artifactKey,
      artifactSha256,
      byteSize: 2_000_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'controlled-long-form-workflow-e2e',
        version: '1.0.0',
        parameters: { duration: 'two-hours' },
      },
      sources: [],
      probe: {
        width: 1920,
        height: 1080,
        duration: 7_200,
        fps: 30,
      },
    })
    await prisma.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey,
        sha256: artifactSha256,
        byteSize: BigInt(2_000_000),
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    await prisma.v2MediaArtifactManifest.create({
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
    await prisma.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId,
        role: 'source-master',
        originalFileName: 'live-controlada.mp4',
        createdAt,
      },
    })
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(prisma),
      clock: () => createdAt,
      createId: () => `long-form-rights-e2e-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['transcription', 'editorial-reuse'],
        prohibitedUses: ['synthetic-generation'],
        allowedLocales: ['pt-BR'],
        consent: { status: 'not-required', allowedUses: [] },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })

    const stages = ['probe', 'transcript', 'diarization', 'chunks', 'moments']
    const versions = Object.fromEntries(stages.map((stage) => {
      const values = {
        probe: ['ffprobe', 'probe', '8.0.0'],
        transcript: ['groq', 'whisper-large-v3', 'groq-audio-transcriptions/v1'],
        diarization: ['openai', 'gpt-4o-transcribe-diarize', 'diarized-json/v1'],
        chunks: ['apollo', 'overlapping-time-chunks', '1.0.0'],
        moments: ['apollo', 'hierarchical-moments', '1.0.0'],
      }[stage]
      return [stage, {
        provider: values[0],
        model: values[1],
        version: values[2],
      }]
    }))
    const stageBudgets = Object.fromEntries(stages.map((stage) => [
      stage,
      {
        estimatedCostMinorUnits:
          stage === 'transcript' ? 2 :
          stage === 'diarization' ? 2 :
          stage === 'chunks' ? 144 : 0,
        maximumCostMinorUnits: stage === 'chunks' ? 200 : 20,
        maximumElapsedMs: 60_000,
      },
    ]))
    const request = new NextRequest(
      `http://localhost/v1/projects/${projectId}/long-form-index-workflows`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issued.token}`,
          'content-type': 'application/json',
          'idempotency-key': `long-form-workflow-e2e-${suffix}`,
        },
        body: JSON.stringify({
          sourceArtifactId: artifactId,
          expectedArtifactSha256: artifactSha256,
          sourceManifestId: manifestId,
          expectedManifestHash: manifest.manifestHash,
          policyVersion: 'long-form-index-workflow-policy/v1',
          versions,
          stageBudgets,
          budget: {
            currency: 'USD',
            maximumCostMinorUnits: 300,
            maximumElapsedMs: 300_000,
            maximumConcurrency: 2,
          },
        }),
      },
    )
    const response = await route.POST(request, {
      params: Promise.resolve({ projectId }),
    })
    const created = await response.json()
    assert.equal(
      response.status,
      202,
      JSON.stringify(created),
    )
    assert.equal(
      created.data.workflow.sourceTranscriptId,
      undefined,
    )
    const workflowId = created.data.workflow.id
    const operationId = created.data.operation.id
    const [storedWorkflowAudit, storedOperationAudit] = await Promise.all([
      prisma.v2LongFormIndexWorkflow.findUniqueOrThrow({
        where: { id: workflowId },
        select: { actorCredentialId: true, actorContextHash: true },
      }),
      prisma.v2PublicOperation.findUniqueOrThrow({
        where: { id: operationId },
        select: { actorCredentialId: true, actorContextHash: true },
      }),
    ])
    assert.equal(storedWorkflowAudit.actorCredentialId, issued.credential.id)
    assert.equal(storedOperationAudit.actorCredentialId, issued.credential.id)
    assert.match(storedWorkflowAudit.actorContextHash, /^[a-f0-9]{64}$/)
    assert.equal(storedOperationAudit.actorContextHash, storedWorkflowAudit.actorContextHash)
    const queuedOperationEvents = await prisma.v2PublicEventOutbox.findMany({
      where: { workspaceId, resourceId: operationId },
    })
    assert.equal(queuedOperationEvents.length, 1)
    assert.equal(
      queuedOperationEvents[0].type,
      'operation.status.changed',
    )
    const publicOperations = new PrismaPublicOperationRepository(prisma)
    const projectOperations = await publicOperations.list({
      workspaceId,
      projectId,
      limit: 10,
    })
    assert.deepEqual(
      projectOperations.map(({ operation }) => ({
        id: operation.id,
        projectId: operation.projectId,
      })),
      [{ id: created.data.operation.id, projectId }],
    )
    assert.deepEqual(await publicOperations.list({
      workspaceId,
      projectId: `other-project-${suffix}`,
      limit: 10,
    }), [])

    const transcriptSegments = Array.from({ length: 24 }, (_, index) => {
      const start = index * 300 + 60
      return {
        id: index,
        start,
        end: start + 120,
        text: `Bloco editorial ${index + 1} com contexto e evidência preservados.`,
      }
    })
    const transcript = createMediaTranscript({
      language: 'pt-BR',
      text: transcriptSegments.map((segment) => segment.text).join(' '),
      words: [],
      segments: transcriptSegments,
      provider: 'groq',
      model: 'whisper-large-v3',
    })
    const audio = {
      async prepare(input) {
        return {
          audioPath: 'C:/controlled/long-form-e2e.ogg',
          sha256: 'b'.repeat(64),
          byteSize: 1_000_000,
          durationMs: input.expectedDurationMs,
          preparation: {
            toolId: 'controlled-audio',
            toolVersion: '1.0.0',
            configurationHash: 'c'.repeat(64),
          },
        }
      },
      async cleanup() {},
    }
    const stageOutputTypes = {
      probe: 'media-artifact-manifest',
      transcript: 'media-transcript',
      diarization: 'speaker-diarization-run',
      chunks: 'hierarchical-processing-run',
      moments: 'long-form-index-run',
    }
    const stageConcurrencies = {
      probe: 1,
      transcript: 1,
      diarization: 1,
      chunks: 2,
      moments: 2,
    }
    const stageFingerprints = (workflow) =>
      Object.fromEntries(workflow.stages.map((stage) => [
        stage.stage,
        {
          inputHash: stage.inputHash,
          idempotencyKey: stage.idempotencyKey,
          outputHash: stage.outputHash,
          outputReferenceId: stage.outputReference?.id,
          stageHash: stage.stageHash,
        },
      ]))
    const assertPublishedStages = (workflow, label) => {
      for (const stage of workflow.stages) {
        assert.match(
          stage.inputHash,
          /^[a-f0-9]{64}$/,
          `${label}/${stage.stage} input hash`,
        )
        assert.match(
          stage.stageHash,
          /^[a-f0-9]{64}$/,
          `${label}/${stage.stage} stage hash`,
        )
        assert.equal(
          stage.idempotencyKey,
          `${workflow.id}:${stage.stage}:${stage.inputHash.slice(0, 32)}`,
          `${label}/${stage.stage} idempotency key`,
        )
        assert.equal(
          stage.concurrency,
          stageConcurrencies[stage.stage],
          `${label}/${stage.stage} concurrency`,
        )
        assert.ok(
          stage.concurrency <= workflow.budget.maximumConcurrency,
          `${label}/${stage.stage} concurrency exceeds the budget`,
        )
        assert.ok(
          stage.budget.estimatedCostMinorUnits <=
            stage.budget.maximumCostMinorUnits,
          `${label}/${stage.stage} stage budget`,
        )
        if (stage.status === 'succeeded') {
          assert.match(
            stage.outputHash ?? '',
            /^[a-f0-9]{64}$/,
            `${label}/${stage.stage} output hash`,
          )
          assert.equal(
            stage.outputReference?.type,
            stageOutputTypes[stage.stage],
            `${label}/${stage.stage} output tier`,
          )
          assert.ok(
            (stage.outputReference?.id ?? '').length > 0,
            `${label}/${stage.stage} output reference`,
          )
          assert.ok(
            stage.resultCount >= 1,
            `${label}/${stage.stage} result count`,
          )
        } else {
          assert.equal(
            stage.outputHash,
            undefined,
            `${label}/${stage.stage} published an output before succeeding`,
          )
          assert.equal(
            stage.outputReference,
            undefined,
            `${label}/${stage.stage} published a reference before succeeding`,
          )
          assert.equal(
            stage.searchable,
            false,
            `${label}/${stage.stage} is searchable before succeeding`,
          )
        }
      }
      assert.equal(
        new Set(workflow.stages.map((stage) => stage.idempotencyKey)).size,
        workflow.stages.length,
        `${label} reused an idempotency key across tiers`,
      )
    }
    const createRuntime = (
      client,
      interruptChunks = false,
      inspectFirstStage,
    ) => {
      const workflows =
        new PrismaLongFormIndexWorkflowRepository(client)
      const speaker =
        new PrismaSpeakerDiarizationRepository(client)
      const transcriptProcessor =
        createLongFormTranscriptStageProcessor({
        repository: workflows,
        providers: {
          resolveTranscription() {
            return {
              identity: {
                provider: 'groq', model: 'whisper-large-v3',
                version: 'groq-audio-transcriptions/v1',
              },
              pricingMinorUnitsPerHour: 1,
              create() {
                return { async transcribe() {
                  transcriptCalls += 1
                  return transcript
                } }
              },
            }
          },
        },
        audio,
        createTranscriptId: (hash) => `transcript-${hash}`,
      })
      const diarizationProcessor =
        createSpeakerDiarizationStageProcessor({
        repository: speaker,
        providers: {
          resolveDiarization() {
            return {
              identity: {
                provider: 'openai', model: 'gpt-4o-transcribe-diarize',
                version: 'diarized-json/v1',
              },
              pricingMinorUnitsPerHour: 1,
              create() {
                return { async diarize() {
                  diarizationCalls += 1
                  return {
                    provider: {
                      id: 'openai',
                      model: 'gpt-4o-transcribe-diarize',
                      version: 'diarized-json/v1',
                    },
                    segments: transcriptSegments.map((segment, index) => ({
                      providerSegmentId: `segment-${index}`,
                      providerLabel: index % 2 === 0 ? 'A' : 'B',
                      startMs: segment.start * 1_000,
                      endMs: segment.end * 1_000,
                      text: segment.text,
                    })),
                    usageSeconds: 7_200,
                  }
                } }
              },
            }
          },
        },
        audio,
        createRunId: () => `diarization-run-${suffix}`,
      })
      const derived = createLongFormDerivedStageProcessor({
        hierarchical:
          new PrismaHierarchicalProcessingRepository(client),
        longForm: new PrismaLongFormIndexRepository(client),
        diarization: speaker,
        contiguousEvidenceProducers: [
          {
            kind: 'transcript-boundary',
            analyzer:
              new TranscriptBoundaryContiguousEvidenceAnalyzer(),
          },
          {
            kind: 'transcript-density',
            analyzer:
              new TranscriptDensityContiguousEvidenceAnalyzer(),
          },
          {
            kind: 'rights-integrity',
            analyzer:
              new RightsIntegrityContiguousEvidenceAnalyzer(),
          },
          {
            kind: 'audio-analysis',
            analyzer: new AudioContiguousEvidenceAnalyzer({
              async measure(input) {
                return input.windows.map((window) => ({
                  momentId: window.momentId,
                  rangeMs: window.rangeMs,
                  durationMs:
                    window.rangeMs[1] - window.rangeMs[0],
                  integratedLufs: -18,
                  truePeakDbfs: -2,
                  meanVolumeDb: -21,
                  maximumVolumeDb: -2,
                  silenceDurationMs: 0,
                  silenceRatio: 0,
                  audibleSignal: true,
                  clippingRisk: false,
                }))
              },
            }),
          },
          {
            kind: 'visual-analysis',
            analyzer: new VisualContiguousEvidenceAnalyzer({
              async measure(input) {
                return input.windows.map((window) => ({
                  momentId: window.momentId,
                  rangeMs: window.rangeMs,
                  durationMs:
                    window.rangeMs[1] - window.rangeMs[0],
                  sampledFrameCount: 30,
                  averageLuma: 0.5,
                  averageSaturation: 0.25,
                  averageTemporalDifference: 0.05,
                  temporalOutlierRatio: 0,
                  repeatedPixelRatio: 0,
                  broadcastRangeViolationRatio: 0,
                  blackDurationMs: 0,
                  blackRatio: 0,
                  freezeDurationMs: 0,
                  freezeRatio: 0,
                  sceneChangeCount: 1,
                }))
              },
            }),
          },
        ].map(({ kind, analyzer }) => ({
          kind,
          produce: produceContiguousEvidenceService({
            repository:
              new PrismaContiguousEvidenceRepository(client),
            analyzer,
            createRunId: () =>
              `${kind}-run-${randomUUID()}`,
            createEvidenceId: () =>
              `${kind}-evidence-${randomUUID()}`,
          }),
        })),
        contiguousEvaluation: {
          produce: produceContiguousEvaluationsService({
            repository:
              new PrismaContiguousEvaluationRepository(client),
            provider:
              new DeterministicContiguousEvaluationProvider(),
            createRunId: () =>
              `evaluation-run-${randomUUID()}`,
            createEvaluationId: () =>
              `evaluation-${randomUUID()}`,
          }),
        },
        createId: (kind, sourceId) =>
          `${kind}-${sourceId ?? suffix}-${randomUUID().slice(0, 8)}`,
      })
      const stageRouter = createLongFormIndexStageRouter({
        transcript: transcriptProcessor,
        diarization: diarizationProcessor,
        chunks: derived,
        moments: derived,
      })
      let interrupted = false
      let inspected = false
      const worker = runNextLongFormIndexOperationService({
        operations: new PrismaPublicOperationRepository(client),
        workflows,
        processor: {
          async process(input) {
            if (inspectFirstStage && !inspected) {
              inspected = true
              await inspectFirstStage(input)
            }
            if (
              interruptChunks &&
              !interrupted &&
              input.checkpoint.stage === 'chunks'
            ) {
              interrupted = true
              throw new Error('controlled worker restart')
            }
            return stageRouter.process(input)
          }
        },
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 1,
      })
      return { workflows, worker }
    }

    const interruptedRuntime = createRuntime(prisma, true)
    const interrupted = await interruptedRuntime.worker(
      `worker-before-restart-${suffix}`,
    )
    assert.equal(interrupted?.status, 'retrying')
    const partialResponse = await readRoute.GET(
      new NextRequest(
        `http://localhost/v1/projects/${projectId}/long-form-index-workflows/${workflowId}`,
        {
          headers: {
            authorization: `Bearer ${issued.token}`,
            'x-request-id': `long-form-partial-${suffix}`,
          },
        },
      ),
      {
        params: Promise.resolve({ projectId, workflowId }),
      },
    )
    const partial = await partialResponse.json()
    assert.equal(partialResponse.status, 200, JSON.stringify(partial))
    assert.equal(partial.data.operation.status, 'retrying')
    assert.deepEqual(partial.data.operation.estimatedCost, {
      currency: 'USD',
      estimatedMinorUnits: 148,
      maximumMinorUnits: 300,
    })
    assert.equal(partial.data.operation.actualCost, undefined)
    assert.equal(partial.data.workflow.summary.searchableStageCount, 1)
    assert.deepEqual(
      partial.data.workflow.stages.map((stage) => ({
        stage: stage.stage,
        status: stage.status,
        searchable: stage.searchable,
      })),
      [
        { stage: 'probe', status: 'succeeded', searchable: false },
        { stage: 'transcript', status: 'succeeded', searchable: true },
        { stage: 'diarization', status: 'succeeded', searchable: false },
        { stage: 'chunks', status: 'failed', searchable: false },
        { stage: 'moments', status: 'pending', searchable: false },
      ],
    )
    assertPublishedStages(partial.data.workflow, 'partial')
    assert.deepEqual(
      partial.data.workflow.stages
        .filter((stage) => stage.status === 'succeeded')
        .map((stage) => ({
          stage: stage.stage,
          searchable: stage.searchable,
          outputType: stage.outputReference.type,
        })),
      [
        {
          stage: 'probe',
          searchable: false,
          outputType: 'media-artifact-manifest',
        },
        {
          stage: 'transcript',
          searchable: true,
          outputType: 'media-transcript',
        },
        {
          stage: 'diarization',
          searchable: false,
          outputType: 'speaker-diarization-run',
        },
      ],
    )
    const partialFingerprints = stageFingerprints(partial.data.workflow)
    assert.equal(
      partialFingerprints.probe.outputReferenceId,
      manifestId,
    )
    assert.equal(
      await prisma.v2MediaTranscript.count({ where: { workspaceId } }),
      1,
    )
    const publishedTranscript =
      await prisma.v2MediaTranscript.findFirstOrThrow({
        where: { workspaceId },
        select: { id: true },
      })
    assert.equal(
      partialFingerprints.transcript.outputReferenceId,
      publishedTranscript.id,
    )
    const publishedDiarizationRun =
      await prisma.v2SpeakerDiarizationRun.findFirstOrThrow({
        where: { workspaceId, projectId, workflowId },
        select: { id: true },
      })
    assert.equal(
      partialFingerprints.diarization.outputReferenceId,
      publishedDiarizationRun.id,
    )
    const replayedCreation = await route.POST(
      new NextRequest(
        `http://localhost/v1/projects/${projectId}/long-form-index-workflows`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${issued.token}`,
            'content-type': 'application/json',
            'idempotency-key': `long-form-workflow-e2e-${suffix}`,
          },
          body: JSON.stringify({
            sourceArtifactId: artifactId,
            expectedArtifactSha256: artifactSha256,
            sourceManifestId: manifestId,
            expectedManifestHash: manifest.manifestHash,
            policyVersion: 'long-form-index-workflow-policy/v1',
            versions,
            stageBudgets,
            budget: {
              currency: 'USD',
              maximumCostMinorUnits: 300,
              maximumElapsedMs: 300_000,
              maximumConcurrency: 2,
            },
          }),
        },
      ),
      { params: Promise.resolve({ projectId }) },
    )
    const replayedCreated = await replayedCreation.json()
    assert.equal(
      replayedCreation.status,
      200,
      JSON.stringify(replayedCreated),
    )
    assert.equal(replayedCreated.data.replayed, true)
    assert.equal(replayedCreated.data.workflow.id, workflowId)
    assert.equal(replayedCreated.data.operation.id, operationId)
    assert.equal(
      await prisma.v2LongFormIndexWorkflow.count({
        where: { workspaceId, projectId },
      }),
      1,
    )
    assert.equal(
      await prisma.v2PublicOperation.count({
        where: { workspaceId, type: 'long-form-index' },
      }),
      1,
    )
    assert.equal(
      await prisma.v2SpeakerDiarizationRun.count({
        where: { workspaceId },
      }),
      1,
    )
    const storedDiarizationAudit =
      await prisma.v2SpeakerDiarizationRun.findFirstOrThrow({
        where: { workspaceId, projectId, workflowId },
        select: {
          actorCredentialId: true,
          actorContextHash: true,
          executionKind: true,
          originOperationId: true,
          originWorkflowId: true,
          originStage: true,
          originStageInputHash: true,
          originStageIdempotencyKey: true,
        },
      })
    const interruptedStored =
      await interruptedRuntime.workflows.read({
        workspaceId,
        projectId,
        workflowId,
      })
    assert.ok(interruptedStored)
    const diarizationCheckpoint = interruptedStored.workflow.stages.find(
      (stage) => stage.stage === 'diarization',
    )
    assert.ok(diarizationCheckpoint)
    assert.equal(
      storedDiarizationAudit.actorCredentialId,
      issued.credential.id,
    )
    assert.equal(
      storedDiarizationAudit.actorContextHash,
      storedWorkflowAudit.actorContextHash,
    )
    assert.equal(storedDiarizationAudit.executionKind, 'long-form-stage')
    assert.equal(storedDiarizationAudit.originOperationId, operationId)
    assert.equal(storedDiarizationAudit.originWorkflowId, workflowId)
    assert.equal(storedDiarizationAudit.originStage, 'diarization')
    assert.equal(
      storedDiarizationAudit.originStageInputHash,
      diarizationCheckpoint.inputHash,
    )
    assert.equal(
      storedDiarizationAudit.originStageIdempotencyKey,
      diarizationCheckpoint.idempotencyKey,
    )
    assert.equal(
      await prisma.v2HierarchicalProcessingRun.count({
        where: { workspaceId },
      }),
      0,
    )

    await prisma.$disconnect()
    prisma = new PrismaClient()
    const fencing = {
      rivalClaims: 0,
      rejectedRivalWrites: 0,
      rejectedStaleAttemptWrites: 0,
    }
    const rivalOwner = `worker-rival-${suffix}`
    const inspectFencing = async (input) => {
      const rivalOperations = new PrismaPublicOperationRepository(prisma)
      const rivalAt = new Date()
      const rivalClaim = await rivalOperations.claimNext({
        leaseOwner: rivalOwner,
        now: rivalAt.toISOString(),
        leaseUntil: new Date(
          rivalAt.getTime() + 30_000,
        ).toISOString(),
        workspaceId,
        type: 'long-form-index',
      })
      assert.equal(
        rivalClaim,
        null,
        'a second simultaneous claim must be rejected while the lease holds',
      )
      fencing.rivalClaims += 1
      const rivalWorkflows =
        new PrismaLongFormIndexWorkflowRepository(prisma)
      const rivalWrite = await rivalWorkflows.replaceWithLease({
        workspaceId,
        projectId,
        workflowId,
        operationId: input.lease.operationId,
        expectedRunHash: input.workflow.runHash,
        nextWorkflow: input.workflow,
        leaseOwner: rivalOwner,
        operationAttempt: input.lease.attempt,
        now: new Date().toISOString(),
      })
      assert.equal(
        rivalWrite,
        null,
        'a stage write from a non-owner must be fenced out',
      )
      fencing.rejectedRivalWrites += 1
      const staleAttemptWrite = await rivalWorkflows.replaceWithLease({
        workspaceId,
        projectId,
        workflowId,
        operationId: input.lease.operationId,
        expectedRunHash: input.workflow.runHash,
        nextWorkflow: input.workflow,
        leaseOwner: input.lease.owner,
        operationAttempt: input.lease.attempt + 1,
        now: new Date().toISOString(),
      })
      assert.equal(
        staleAttemptWrite,
        null,
        'a stage write with a stale attempt must be fenced out',
      )
      fencing.rejectedStaleAttemptWrites += 1
    }
    const restartedRuntime = createRuntime(prisma, false, inspectFencing)
    const outcome = await restartedRuntime.worker(
      `worker-after-restart-${suffix}`,
    )
    assert.equal(outcome?.status, 'succeeded')
    assert.deepEqual(fencing, {
      rivalClaims: 1,
      rejectedRivalWrites: 1,
      rejectedStaleAttemptWrites: 1,
    })
    assert.equal(
      await prisma.v2PublicOperation.count({
        where: { workspaceId, leaseOwner: rivalOwner },
      }),
      0,
    )
    assert.equal(
      await restartedRuntime.worker(
        `worker-after-restart-${suffix}`,
      ),
      null,
    )

    const stored = await restartedRuntime.workflows.read({
      workspaceId,
      projectId,
      workflowId,
    })
    assert.ok(stored)
    assert.equal(stored.workflow.status, 'succeeded')
    assert.equal(stored.operation.status, 'succeeded')
    assert.equal(stored.operation.phase, 'completed')
    assert.deepEqual(stored.operation.actualCost, {
      currency: 'USD',
      minorUnits: stored.workflow.summary.costMinorUnits,
    })
    const operationEvents = await prisma.v2PublicEventOutbox.findMany({
      where: { workspaceId, resourceId: operationId },
      orderBy: [{ occurredAt: 'asc' }, { type: 'asc' }],
    })
    assert.deepEqual(operationEvents.map((event) => event.type), [
      'operation.status.changed',
      'operation.status.changed',
      'operation.status.changed',
      'operation.status.changed',
      'operation.status.changed',
      'operation.succeeded',
    ])
    assert.equal(stored.workflow.sourceTranscriptId, undefined)
    assert.equal(stored.workflow.durationMs, 7_200_000)
    assert.equal(stored.workflow.summary.completedStageCount, 5)
    assert.equal(stored.workflow.summary.searchableStageCount, 3)
    assert.equal(stored.workflow.summary.duplicateSegments, false)
    assert.ok(
      stored.workflow.summary.costMinorUnits <=
        stored.workflow.budget.maximumCostMinorUnits,
    )
    assert.ok(
      stored.workflow.summary.elapsedMs <=
        stored.workflow.budget.maximumElapsedMs,
    )
    assert.deepEqual(
      stored.workflow.stages.map((stage) => ({
        stage: stage.stage,
        status: stage.status,
        searchable: stage.searchable,
      })),
      [
        { stage: 'probe', status: 'succeeded', searchable: false },
        { stage: 'transcript', status: 'succeeded', searchable: true },
        { stage: 'diarization', status: 'succeeded', searchable: false },
        { stage: 'chunks', status: 'succeeded', searchable: true },
        { stage: 'moments', status: 'succeeded', searchable: true },
      ],
    )
    assert.equal(transcriptCalls, 1)
    assert.equal(diarizationCalls, 1)
    assertPublishedStages(stored.workflow, 'succeeded')
    const succeededFingerprints = stageFingerprints(stored.workflow)
    for (const stage of ['probe', 'transcript', 'diarization']) {
      assert.deepEqual(
        succeededFingerprints[stage],
        partialFingerprints[stage],
        `${stage} was recomputed instead of resumed`,
      )
    }
    const finalResponse = await readRoute.GET(
      new NextRequest(
        `http://localhost/v1/projects/${projectId}/long-form-index-workflows/${workflowId}`,
        {
          headers: {
            authorization: `Bearer ${issued.token}`,
            'x-request-id': `long-form-final-${suffix}`,
          },
        },
      ),
      { params: Promise.resolve({ projectId, workflowId }) },
    )
    const final = await finalResponse.json()
    assert.equal(finalResponse.status, 200, JSON.stringify(final))
    assertPublishedStages(final.data.workflow, 'published')
    assert.deepEqual(
      final.data.workflow.stages.map((stage) => ({
        stage: stage.stage,
        status: stage.status,
        searchable: stage.searchable,
        outputType: stage.outputReference?.type,
      })),
      [
        {
          stage: 'probe',
          status: 'succeeded',
          searchable: false,
          outputType: 'media-artifact-manifest',
        },
        {
          stage: 'transcript',
          status: 'succeeded',
          searchable: true,
          outputType: 'media-transcript',
        },
        {
          stage: 'diarization',
          status: 'succeeded',
          searchable: false,
          outputType: 'speaker-diarization-run',
        },
        {
          stage: 'chunks',
          status: 'succeeded',
          searchable: true,
          outputType: 'hierarchical-processing-run',
        },
        {
          stage: 'moments',
          status: 'succeeded',
          searchable: true,
          outputType: 'long-form-index-run',
        },
      ],
    )
    assert.deepEqual(
      stageFingerprints(final.data.workflow),
      succeededFingerprints,
    )
    assert.equal(
      await prisma.v2MediaTranscript.count({ where: { workspaceId } }),
      1,
    )
    assert.equal(
      await prisma.v2HierarchicalProcessingRun.count({
        where: { workspaceId },
      }),
      1,
    )
    assert.equal(
      await prisma.v2LongFormIndexRun.count({ where: { workspaceId } }),
      1,
    )
    const [publishedChunkRun, publishedIndexRun] = await Promise.all([
      prisma.v2HierarchicalProcessingRun.findFirstOrThrow({
        where: { workspaceId },
        select: { id: true },
      }),
      prisma.v2LongFormIndexRun.findFirstOrThrow({
        where: { workspaceId },
        select: { id: true },
      }),
    ])
    assert.equal(
      succeededFingerprints.chunks.outputReferenceId,
      publishedChunkRun.id,
    )
    assert.equal(
      succeededFingerprints.moments.outputReferenceId,
      publishedIndexRun.id,
    )
    assert.equal(
      await prisma.v2HierarchicalProcessingChunk.count({
        where: { workspaceId },
      }),
      24,
    )
    const momentCount = await prisma.v2LongFormMoment.count({
      where: { workspaceId },
    })
    assert.ok(momentCount > 0)
    assert.equal(
      await prisma.v2ContiguousEvaluationEvidence.count({
        where: { workspaceId },
      }),
      momentCount * 5,
    )
    assert.equal(
      await prisma.v2ContiguousMomentEvaluation.count({
        where: { workspaceId, active: true },
      }),
      momentCount,
    )
    const momentsCheckpoint = stored.workflow.stages.find(
      (stage) => stage.stage === 'moments',
    )
    assert.ok(momentsCheckpoint)
    const [storedEvidenceAudits, storedEvaluationAudits] =
      await Promise.all([
        prisma.v2ContiguousEvidenceRun.findMany({
          where: { workspaceId, projectId },
          select: {
            actorCredentialId: true,
            actorContextHash: true,
            executionKind: true,
            originOperationId: true,
            originWorkflowId: true,
            originStage: true,
            originStageInputHash: true,
            originStageIdempotencyKey: true,
          },
        }),
        prisma.v2ContiguousEvaluationRun.findMany({
          where: { workspaceId, projectId },
          select: {
            actorCredentialId: true,
            actorContextHash: true,
            executionKind: true,
            originOperationId: true,
            originWorkflowId: true,
            originStage: true,
            originStageInputHash: true,
            originStageIdempotencyKey: true,
          },
        }),
      ])
    assert.equal(storedEvidenceAudits.length, 5)
    assert.equal(storedEvaluationAudits.length, 1)
    for (const audit of [
      ...storedEvidenceAudits,
      ...storedEvaluationAudits,
    ]) {
      assert.equal(audit.actorCredentialId, issued.credential.id)
      assert.equal(
        audit.actorContextHash,
        storedWorkflowAudit.actorContextHash,
      )
      assert.equal(audit.executionKind, 'long-form-stage')
      assert.equal(audit.originOperationId, operationId)
      assert.equal(audit.originWorkflowId, workflowId)
      assert.equal(audit.originStage, 'moments')
      assert.equal(audit.originStageInputHash, momentsCheckpoint.inputHash)
      assert.equal(
        audit.originStageIdempotencyKey,
        momentsCheckpoint.idempotencyKey,
      )
    }
    const evaluated =
      await prisma.v2ContiguousMomentEvaluation.findFirst({
        where: {
          workspaceId,
          projectId,
          active: true,
        },
        include: { moment: true },
        orderBy: { id: 'asc' },
      })
    assert.ok(evaluated)
    assert.ok(
      JSON.parse(evaluated.objectiveTagsJson)
        .includes('discovery'),
    )
    assert.equal(
      evaluated.semanticEndMs - evaluated.semanticStartMs,
      120_000,
    )

    const extractionIdempotencyKey =
      `contiguous-extraction-e2e-${suffix}`
    const extractionBody = {
      objective: 'discovery',
      topic: evaluated.moment.topicNormalized,
      targetDurationMs: 120_000,
      toleranceMs: 0,
      fps: 30,
    }
    const createExtractionRequest = () => new NextRequest(
      `http://localhost/v1/projects/${projectId}/contiguous-extractions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issued.token}`,
          'content-type': 'application/json',
          'idempotency-key': extractionIdempotencyKey,
        },
        body: JSON.stringify(extractionBody),
      },
    )
    const extractionResponse = await extractionRoute.POST(
      createExtractionRequest(),
      { params: Promise.resolve({ projectId }) },
    )
    const extraction = await extractionResponse.json()
    assert.equal(
      extractionResponse.status,
      201,
      JSON.stringify(extraction),
    )
    const selected = extraction.data.extraction.candidates.find(
      (candidate) =>
        candidate.candidateHash ===
          extraction.data.extraction.selectedCandidateHash,
    )
    assert.ok(selected)
    assert.equal(
      selected.sourceRangeMs[1] - selected.sourceRangeMs[0],
      120_000,
    )
    assert.equal(
      extraction.data.extraction.storyPlan.mode,
      'contiguous',
    )
    assert.equal(
      extraction.data.extraction.editPlan.synthesizedRanges,
      false,
    )
    assert.equal(
      extraction.data.extraction.editPlan.videoTracks.length,
      1,
    )

    const replayResponse = await extractionRoute.POST(
      createExtractionRequest(),
      { params: Promise.resolve({ projectId }) },
    )
    const replay = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replay))
    assert.equal(replay.data.replayed, true)
    assert.equal(
      replay.data.extraction.id,
      extraction.data.extraction.id,
    )

    const extractionReadResponse = await readExtractionRoute.GET(
      new NextRequest(
        `http://localhost/v1/projects/${projectId}/contiguous-extractions/${extraction.data.extraction.id}`,
        {
          headers: {
            authorization: `Bearer ${issued.token}`,
            'x-request-id': `contiguous-extraction-read-${suffix}`,
          },
        },
      ),
      {
        params: Promise.resolve({
          projectId,
          extractionId: extraction.data.extraction.id,
        }),
      },
    )
    const extractionRead = await extractionReadResponse.json()
    assert.equal(
      extractionReadResponse.status,
      200,
      JSON.stringify(extractionRead),
    )
    assert.equal(
      extractionRead.data.extraction.resultHash,
      extraction.data.extraction.resultHash,
    )
    assert.equal(
      await prisma.v2ContiguousExtraction.count({
        where: { workspaceId, projectId },
      }),
      1,
    )
  } finally {
    const cleanup = await Promise.allSettled([
      prisma.$disconnect(),
      disconnectV2PostgresClient(),
    ])
    const cleanupFailure = cleanup.find(
      (result) => result.status === 'rejected',
    )
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
      const rows = await postflight.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE application_name = $1',
        applicationName,
      )
      orphanCount = Number(rows[0]?.count ?? -1)
    } finally {
      await postflight.$disconnect()
    }
    if (cleanupFailure?.status === 'rejected') {
      throw cleanupFailure.reason
    }
    assert.equal(orphanCount, 0)
  }
})
