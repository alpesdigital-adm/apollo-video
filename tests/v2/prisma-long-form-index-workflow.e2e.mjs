import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { NextRequest } from 'next/server'
import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('T-FR-133 resumes a generated-transcript two-hour master after worker restart without duplication', {
  skip:
    process.env.APOLLO_LONG_FORM_WORKFLOW_E2E !== '1' &&
    'set APOLLO_LONG_FORM_WORKFLOW_E2E=1 with an isolated local V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL)
  process.env.APOLLO_API_ENVIRONMENT = 'production'
  const databaseName =
    new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
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
    { PrismaPublicOperationRepository },
    { RightsIntegrityContiguousEvidenceAnalyzer },
    {
      TranscriptBoundaryContiguousEvidenceAnalyzer,
      TranscriptDensityContiguousEvidenceAnalyzer,
    },
    { AudioContiguousEvidenceAnalyzer },
    { VisualContiguousEvidenceAnalyzer },
    { nodeApiCredentialCrypto },
    route,
    readRoute,
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
    import('../../src/v2/application/long-form-derived-stage-processor.ts'),
    import('../../src/v2/application/run-long-form-index-worker.ts'),
    import('../../src/v2/infrastructure/prisma/api-client-repository.ts'),
    import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts'),
    import('../../src/v2/infrastructure/prisma/long-form-index-workflow-repository.ts'),
    import('../../src/v2/infrastructure/prisma/speaker-diarization-repository.ts'),
    import('../../src/v2/infrastructure/prisma/hierarchical-processing-repository.ts'),
    import('../../src/v2/infrastructure/prisma/long-form-index-repository.ts'),
    import('../../src/v2/infrastructure/prisma/contiguous-evidence-repository.ts'),
    import('../../src/v2/infrastructure/prisma/public-operation-repository.ts'),
    import('../../src/v2/infrastructure/analysis/rights-integrity-contiguous-evidence-analyzer.ts'),
    import('../../src/v2/infrastructure/analysis/transcript-contiguous-evidence-analyzers.ts'),
    import('../../src/v2/infrastructure/analysis/audio-contiguous-evidence-analyzer.ts'),
    import('../../src/v2/infrastructure/analysis/visual-contiguous-evidence-analyzer.ts'),
    import('../../src/v2/infrastructure/security/api-credential.ts'),
    import('../../src/app/v1/projects/[projectId]/long-form-index-workflows/route.ts'),
    import('../../src/app/v1/projects/[projectId]/long-form-index-workflows/[workflowId]/route.ts'),
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

    const transcriptSegments = Array.from({ length: 24 }, (_, index) => ({
      id: index,
      start: index * 300,
      end: (index + 1) * 300,
      text: `Bloco editorial ${index + 1} com contexto e evidência preservados.`,
    }))
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
    const createRuntime = (client, interruptChunks = false) => {
      const workflows =
        new PrismaLongFormIndexWorkflowRepository(client)
      const speaker =
        new PrismaSpeakerDiarizationRepository(client)
      const transcriptProcessor =
        createLongFormTranscriptStageProcessor({
        repository: workflows,
        transcriber: {
          async transcribe() {
            transcriptCalls += 1
            return transcript
          },
        },
        audio,
        createTranscriptId: (hash) => `transcript-${hash}`,
        providerVersion: 'groq-audio-transcriptions/v1',
        pricingMinorUnitsPerHour: 1,
      })
      const diarizationProcessor =
        createSpeakerDiarizationStageProcessor({
        repository: speaker,
        provider: {
          async diarize() {
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
          },
        },
        audio,
        createRunId: () => `diarization-run-${suffix}`,
        pricingMinorUnitsPerHour: 1,
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
      const worker = runNextLongFormIndexOperationService({
        operations: new PrismaPublicOperationRepository(client),
        workflows,
        processor: {
          async process(input) {
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
    assert.equal(
      await prisma.v2MediaTranscript.count({ where: { workspaceId } }),
      1,
    )
    assert.equal(
      await prisma.v2SpeakerDiarizationRun.count({
        where: { workspaceId },
      }),
      1,
    )
    assert.equal(
      await prisma.v2HierarchicalProcessingRun.count({
        where: { workspaceId },
      }),
      0,
    )

    await prisma.$disconnect()
    prisma = new PrismaClient()
    const restartedRuntime = createRuntime(prisma)
    const outcome = await restartedRuntime.worker(
      `worker-after-restart-${suffix}`,
    )
    assert.equal(outcome?.status, 'succeeded')
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
    assert.equal(
      await prisma.v2HierarchicalProcessingChunk.count({
        where: { workspaceId },
      }),
      24,
    )
    assert.ok(
      await prisma.v2LongFormMoment.count({
        where: { workspaceId },
      }) > 0,
    )
  } finally {
    await prisma.$disconnect()
  }
})
