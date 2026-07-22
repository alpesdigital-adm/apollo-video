import type { PublicSchemaDefinition } from './schema-registry.ts'
import { PUBLIC_EVENT_CATALOG } from '../domain/public-event.ts'

const createdAt = '2026-07-12T20:00:00.000Z'
const projectId = 'project-example-1'
const workspaceId = 'workspace-example-1'
const clientId = 'client-example-1'
const credentialId = 'credential-example-1'
const artifactId = 'artifact-example-1'
const rightsSnapshotId = 'rights-example-1'
const assetRightsRequestExample = {
  owner: 'Alpes Digital',
  license: 'owned-media',
  status: 'approved',
  allowedUses: ['paid-ad', 'organic-content'],
  prohibitedUses: [],
  allowedMarkets: ['BR'],
  allowedLocales: ['pt-BR'],
  allowedSyntheticOperations: [],
  expiresAt: '2027-07-12T20:00:00.000Z',
  consent: {
    status: 'not-required',
    allowedUses: [],
  },
  sourceNote: 'Direitos confirmados pelo administrador do workspace.',
}
const assetRightsSnapshotExample = {
  schemaVersion: 'asset-rights/v1',
  id: rightsSnapshotId,
  workspaceId,
  artifactId,
  sequence: 1,
  snapshotHash: '6'.repeat(64),
  ...assetRightsRequestExample,
  allowedWorkspaceIds: [workspaceId],
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
}
const renderInputRequestExample = {
  schemaVersion: 'render-input/v1',
  renderer: {
    id: 'remotion',
    version: '4.0.489',
    digest: '8'.repeat(64),
  },
  composition: {
    id: 'apollo-video',
    version: 'v1',
    propsSchemaRef: 'apollo://render-props/apollo-video/v1',
  },
  plan: {
    id: 'plan-example-1',
    versionId: 'plan-version-example-1',
    hash: '9'.repeat(64),
  },
  output: {
    id: 'preset-9x16',
    locale: 'pt-BR',
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
    durationInFrames: 900,
  },
  assets: [
    {
      id: 'asset-primary-video',
      artifactId,
      artifactKey: 'artifact:artifact-example-source-1',
      kind: 'video',
      role: 'primary',
      ordinal: 0,
      sha256: 'a'.repeat(64),
      byteSize: 2849012,
    },
  ],
  props: {
    primaryVideoAssetId: 'asset-primary-video',
    title: 'Abertura validada',
  },
}
const queuedRenderOperationExample = {
  schemaVersion: 'public-operation/v1',
  id: 'operation-render-example-1',
  type: 'artifact-render',
  status: 'queued',
  phase: 'queued',
  progress: { completed: 0, total: 1, unit: 'render' },
  cancelable: true,
  retryable: false,
  target: {
    type: 'media-artifact',
    id: artifactId,
    manifestId: 'manifest-example-1',
  },
  attempt: 0,
  maxAttempts: 3,
  createdAt,
  updatedAt: createdAt,
}
const webhookDeliveryExample = {
  schemaVersion: 'webhook-delivery/v1',
  id: '00000000-0000-4000-8000-000000000701',
  endpointId: '00000000-0000-4000-8000-000000000702',
  subscriptionId: '00000000-0000-4000-8000-000000000703',
  eventId: '00000000-0000-4000-8000-000000000704',
  status: 'succeeded',
  attemptCount: 1,
  maxAttempts: 8,
  nextAttemptAt: createdAt,
  createdAt,
  completedAt: '2026-07-12T20:00:01.000Z',
}
const webhookSecretMetadataExample = {
  version: 1,
  fingerprint: 'd'.repeat(64),
  status: 'active',
  createdAt,
}
const webhookEndpointExample = {
  schemaVersion: 'webhook-endpoint/v1',
  id: '00000000-0000-4000-8000-000000000702',
  status: 'active',
  revision: 'f'.repeat(64),
  destinationOrigin: 'https://hooks.example.com',
  urlFingerprint: 'c'.repeat(64),
  createdByClientId: clientId,
  createdAt,
  verifiedAt: createdAt,
  currentSigningSecret: webhookSecretMetadataExample,
}
const webhookPendingEndpointExample = {
  schemaVersion: webhookEndpointExample.schemaVersion,
  id: '00000000-0000-4000-8000-000000000710',
  status: 'pending-verification',
  revision: 'a'.repeat(64),
  destinationOrigin: 'https://hooks.example.com',
  urlFingerprint: 'b'.repeat(64),
  createdByClientId: clientId,
  createdAt,
  currentSigningSecret: webhookSecretMetadataExample,
}
const queuedMediaIngestOperationExample = {
  schemaVersion: 'public-operation/v1',
  id: 'operation-ingest-example-1',
  type: 'media-ingest',
  status: 'queued',
  phase: 'queued',
  progress: { completed: 0, total: 6, unit: 'ingest-stage' },
  cancelable: true,
  retryable: false,
  target: { type: 'media-artifact', id: 'artifact-example-master-1', manifestId: 'manifest-example-master-1' },
  attempt: 0,
  maxAttempts: 3,
  createdAt,
  updatedAt: createdAt,
}
const queuedProjectProxyRenderOperationExample = {
  ...queuedRenderOperationExample,
  id: 'operation-project-proxy-example-1',
  type: 'project-proxy-render',
  target: { type: 'media-artifact', id: 'artifact-editorial-proxy-example-1', manifestId: 'manifest-editorial-proxy-example-1' },
}
const queuedProjectFinalExportOperationExample = {
  ...queuedRenderOperationExample,
  id: 'operation-project-final-example-1',
  type: 'project-final-export',
  target: { type: 'media-artifact', id: 'artifact-final-example-1', manifestId: 'manifest-final-example-1' },
}
const reviewPatchProposalExample = {
  id: '90000000-0000-4000-8000-000000000214',
  workspaceId,
  projectId,
  annotationId: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
  baseVersionId: 'project-version-example-2',
  status: 'ready',
  interpretationVersion: 'review-patch-interpreter/1.0.0+review-patch-policy/1.0.0',
  choices: [],
  patch: {
    id: 'patch-example-214',
    baseVersionId: 'project-version-example-2',
    operations: [{ op: 'update-layout', targetId: 'subtitle:subtitle-cue-2', value: { anchor: 'bottom', faceProtection: true }, rangeMs: [10500, 10500] }],
    annotationIds: ['d8f7ec49-b87c-4ca8-80a7-7840de71c650'],
    estimatedCost: 0,
    invalidatedRanges: [[10500, 10500]],
  },
  impact: {
    operationCount: 1,
    cost: 0,
    invalidatedRanges: [[10500, 10500]],
    changedTargets: ['subtitle:subtitle-cue-2'],
    expectedScoreDelta: 3,
    invalidatedArtifacts: ['proxy', 'final'],
  },
  gates: [
    { gate: 'ambiguity', passed: true, message: 'Uma interpretação tipada foi resolvida.', targetIds: ['subtitle:subtitle-cue-2'] },
    { gate: 'protected-elements', passed: true, message: 'Nenhum alvo protegido será alterado.', targetIds: [] },
    { gate: 'policy', passed: true, message: 'A operação é permitida pela policy ativa.', targetIds: ['subtitle:subtitle-cue-2'] },
    { gate: 'budget', passed: true, message: 'O custo estimado cabe no budget restante.', targetIds: ['subtitle:subtitle-cue-2'] },
  ],
  createdAt,
  updatedAt: createdAt,
}
const webhookSigningSecretRotationExample = {
  schemaVersion: 'webhook-signing-secret-rotation/v1',
  id: '20000000-0000-4000-8000-000000000010',
  endpointId: webhookEndpointExample.id,
  candidateVersion: 2,
  fingerprint: 'c'.repeat(64),
  status: 'staged',
  overlapSeconds: 300,
  baseRevision: webhookEndpointExample.revision,
  createdAt,
  expiresAt: '2026-07-13T20:00:00.000Z',
}
const webhookSubscriptionExample = {
  schemaVersion: 'webhook-subscription/v1',
  id: '00000000-0000-4000-8000-000000000703',
  endpointId: webhookEndpointExample.id,
  status: 'active',
  revision: 'e'.repeat(64),
  eventTypes: ['project.created'],
  resourceIds: ['project-example-1'],
  createdByClientId: clientId,
  createdAt,
}
const webhookAttemptExample = {
  schemaVersion: 'webhook-delivery-attempt/v1',
  id: '00000000-0000-4000-8000-000000000705',
  attemptNumber: 1,
  status: 'succeeded',
  scheduledAt: createdAt,
  createdAt,
  startedAt: createdAt,
  completedAt: '2026-07-12T20:00:01.000Z',
  responseStatus: 204,
  responseBodyHash: 'e'.repeat(64),
}
const webhookReplayDeliverySummaryExample = {
  schemaVersion: webhookDeliveryExample.schemaVersion,
  id: webhookDeliveryExample.id,
  endpointId: webhookDeliveryExample.endpointId,
  subscriptionId: webhookDeliveryExample.subscriptionId,
  eventId: webhookDeliveryExample.eventId,
  status: 'retry-scheduled',
  attemptCount: webhookDeliveryExample.attemptCount,
  maxAttempts: webhookDeliveryExample.maxAttempts,
  nextAttemptAt: '2026-07-12T20:00:02.001Z',
  createdAt: webhookDeliveryExample.createdAt,
}
const webhookReplayDeliveryExample = {
  ...webhookReplayDeliverySummaryExample,
  attempts: [webhookAttemptExample],
}

export const PUBLIC_SCHEMA_EXAMPLES: Readonly<Record<string, readonly unknown[]>> =
  Object.freeze({
    'apollo://schemas/health-response/v1': [
      {
        data: { service: 'apollo-video', status: 'ok' },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/ui-session-create-request/v1': [
      { username: 'apollo-operator', password: 'example-password-not-a-secret', next: '/' },
    ],
    'apollo://schemas/ui-session-created/v1': [
      {
        data: {
          subject: 'apollo-operator',
          workspaceId,
          expiresAt: '2026-07-13T08:00:00.000Z',
          redirectTo: '/',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/ui-session-status/v1': [
      {
        data: {
          subject: 'apollo-operator',
          workspaceId,
          expiresAt: '2026-07-13T08:00:00.000Z',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/ui-session-ended/v1': [
      { data: { signedOut: true }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/capability-list/v1': [
      {
        data: {
          capabilities: [
            {
              id: 'apollo.health.read',
              version: '1.0.0',
              title: 'Read API health',
              description: 'Returns API liveness.',
              operationKind: 'query',
              authMode: 'none',
              requiredScopes: [],
              outputSchemaRef: 'apollo://schemas/health-response/v1',
              endpoint: { method: 'GET', path: '/v1/health' },
              toolName: 'apollo.health.read',
              supportsDryRun: false,
              costClass: 'free',
              confirmation: 'none',
              successStatuses: [200],
              idempotency: 'not-applicable',
              responseMediaType: 'application/json',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-event/v1': [
      {
        id: '123e4567-e89b-42d3-a456-426614174000',
        type: 'operation.status.changed',
        version: '1.0.0',
        workspaceId,
        occurredAt: createdAt,
        sequence: 7,
        actor: { clientId },
        resource: { type: 'operation', id: 'operation-render-example-1' },
        data: { previousStatus: 'queued', status: 'running' },
      },
    ],
    'apollo://schemas/event-catalog/v1': [
      {
        data: {
          envelopeSchemaRef: 'apollo://schemas/public-event/v1',
          events: PUBLIC_EVENT_CATALOG.map((descriptor) => ({ ...descriptor })),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-list/v1': [
      { data: { projects: [] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/project-list/v2': [
      { data: { projects: [] }, meta: { apiVersion: 'v1' } },
      {
        data: {
          projects: [
            {
              id: projectId,
              workspaceId,
              name: 'Anúncio de descoberta',
              status: 'draft',
              currentVersionId: 'project-version-example-1',
              createdAt,
            },
          ],
          nextCursor: Buffer.from('project-page-example').toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-detail/v1': [
      {
        data: {
          artifact: {
            id: artifactId,
            workspaceId,
            artifactKey: 'artifact:artifact-example-final-1',
            sha256: 'b'.repeat(64),
            byteSize: '2849012',
            mediaType: 'video',
            container: 'mp4',
            status: 'available',
            createdAt,
          },
          manifests: [
            {
              id: 'manifest-example-1',
              schemaVersion: 'media-artifact-manifest/v1',
              manifestHash: 'c'.repeat(64),
              recipe: {
                id: 'normalize-video',
                version: '1.0.0',
                parametersHash: 'd'.repeat(64),
              },
              probe: { width: 1080, height: 1920, duration: 32.5, fps: 30 },
              sources: [
                {
                  artifactId: 'artifact-source-example-1',
                  artifactKey: 'artifact:artifact-example-source-1',
                  sha256: 'a'.repeat(64),
                  role: 'primary',
                  ordinal: 0,
                },
              ],
              createdAt,
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-lineage-diagnostic/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-1',
          healthy: true,
          nodes: [
            {
              artifactId: 'artifact-source-example-1',
              artifactKey: 'artifact:artifact-example-source-1',
              sha256: 'a'.repeat(64),
              status: 'available',
              manifestCount: 1,
              selectedManifest: {
                id: 'manifest-source-example-1',
                manifestHash: 'e'.repeat(64),
                schemaVersion: 'media-artifact-manifest/v1',
                recipe: {
                  id: 'ingest-source',
                  version: '1.0.0',
                  parametersHash: 'f'.repeat(64),
                },
              },
            },
            {
              artifactId,
              artifactKey: 'artifact:artifact-example-final-1',
              sha256: 'b'.repeat(64),
              status: 'available',
              manifestCount: 1,
              selectedManifest: {
                id: 'manifest-example-1',
                manifestHash: 'c'.repeat(64),
                schemaVersion: 'media-artifact-manifest/v1',
                recipe: {
                  id: 'normalize-video',
                  version: '1.0.0',
                  parametersHash: 'd'.repeat(64),
                },
              },
            },
          ],
          edges: [
            {
              sourceArtifactId: 'artifact-source-example-1',
              targetArtifactId: artifactId,
              sha256: 'a'.repeat(64),
              role: 'primary',
              ordinal: 0,
            },
          ],
          issues: [],
          limits: { maxNodes: 256, maxDepth: 32, truncated: false },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-execution-provenance/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-2',
          schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: '1'.repeat(64),
          complete: true,
          edges: [
            {
              sourceArtifactId: 'artifact-source-example-1',
              role: 'primary',
              ordinal: 0,
              execution: {
                tool: {
                  id: 'heygen-adapter',
                  version: '2.1.0',
                  digest: '2'.repeat(64),
                },
                model: {
                  provider: 'heygen',
                  id: 'avatar-iv',
                  version: '2026.07',
                  configHash: '3'.repeat(64),
                },
              },
            },
          ],
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-replay-spec/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-3',
          schemaVersion: 'media-artifact-manifest/v3',
          manifestHash: '4'.repeat(64),
          recipe: {
            id: 'normalize-video',
            version: 'v3',
            parametersHash: '5'.repeat(64),
          },
          available: true,
          parameters: {
            ref: `recipe-parameters/sha256/${'5'.repeat(64)}`,
            canonicalByteSize: 42,
            protection: { algorithm: 'aes-256-gcm' },
          },
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-legacy',
          schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: '6'.repeat(64),
          recipe: {
            id: 'normalize-video',
            version: 'v2',
            parametersHash: '7'.repeat(64),
          },
          available: false,
          issues: [
            {
              code: 'REPLAY_PARAMETERS_MISSING',
              message: 'Manifest predates protected replay parameters',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-render-input/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-4',
          schemaVersion: 'media-artifact-manifest/v4',
          manifestHash: '8'.repeat(64),
          available: true,
          renderInput: {
            ref: `render-input/sha256/${'9'.repeat(64)}`,
            inputHash: '9'.repeat(64),
            canonicalByteSize: 2048,
            protection: { algorithm: 'aes-256-gcm' },
          },
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-legacy',
          schemaVersion: 'media-artifact-manifest/v3',
          manifestHash: 'a'.repeat(64),
          available: false,
          issues: [
            {
              code: 'RENDER_INPUT_MISSING',
              message: 'Manifest predates protected RenderInput',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-reconstruction-preflight/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-4',
          schemaVersion: 'media-artifact-manifest/v4',
          manifestHash: '8'.repeat(64),
          validationScope: 'protected-input-and-asset-identity',
          rightsValidationRequired: true,
          materializationRequired: true,
          payloadAuthenticated: true,
          eligible: true,
          inputHash: '9'.repeat(64),
          renderer: {
            id: 'remotion',
            version: '4.0.489',
            digest: '7'.repeat(64),
            supported: true,
          },
          composition: {
            id: 'apollo-video',
            version: 'v1',
            propsSchemaRef: 'apollo://render-props/apollo-video/v1',
            supported: true,
          },
          assets: { total: 1, available: 1 },
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-legacy',
          schemaVersion: 'media-artifact-manifest/v3',
          manifestHash: 'a'.repeat(64),
          validationScope: 'protected-input-and-asset-identity',
          rightsValidationRequired: true,
          materializationRequired: true,
          payloadAuthenticated: false,
          eligible: false,
          assets: { total: 0, available: 0 },
          issues: [
            {
              code: 'RENDER_INPUT_MISSING',
              message: 'Manifest predates protected RenderInput',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/set-asset-rights-request/v1': [
      assetRightsRequestExample,
    ],
    'apollo://schemas/asset-rights-current/v1': [
      {
        data: {
          artifactId,
          configured: true,
          rights: assetRightsSnapshotExample,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { artifactId, configured: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/asset-rights-set/v1': [
      {
        data: {
          artifactId,
          rights: assetRightsSnapshotExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/authorize-materialization-request/v1': [
      { use: 'paid-ad', market: 'BR', syntheticOperations: [] },
    ],
    'apollo://schemas/materialization-authorization/v1': [
      {
        data: {
          authorization: {
            schemaVersion: 'materialization-authorization/v1',
            id: 'materialization-auth-example-1',
            artifactId,
            manifestId: 'manifest-example-4',
            inputHash: '9'.repeat(64),
            use: 'paid-ad',
            market: 'BR',
            locale: 'pt-BR',
            syntheticOperations: [],
            status: 'authorized',
            issues: [],
            decisions: [
              {
                artifactId,
                assetOrdinal: 0,
                assetKind: 'video',
                outcome: 'allow',
                reasonCodes: [],
                rightsSnapshotId,
                rightsSnapshotHash: '6'.repeat(64),
                validUntil: '2026-07-12T20:05:00.000Z',
              },
            ],
            evaluatedAt: createdAt,
            validUntil: '2026-07-12T20:05:00.000Z',
            revalidationRequired: true,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/render-input-preflight-request/v1': [
      renderInputRequestExample,
    ],
    'apollo://schemas/render-input-preflight/v1': [
      {
        data: {
          schemaVersion: 'render-input/v1',
          validationScope: 'portable-envelope',
          materializationRequired: true,
          inputHash: 'b'.repeat(64),
          renderer: { ...renderInputRequestExample.renderer },
          composition: {
            ...renderInputRequestExample.composition,
            propsHash: 'c'.repeat(64),
          },
          plan: { ...renderInputRequestExample.plan },
          output: {
            id: 'preset-9x16',
            locale: 'pt-BR',
            aspectRatio: '9:16',
            width: 1080,
            height: 1920,
            fps: 30,
            durationInFrames: 900,
          },
          assetCount: 1,
          totalAssetBytes: '2849012',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/enqueue-artifact-render-request/v1': [
      { authorizationId: 'materialization-auth-example-1' },
    ],
    'apollo://schemas/artifact-render-operation-accepted/v1': [
      {
        data: { operation: queuedRenderOperationExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-operation-detail/v1': [
      {
        data: { operation: queuedRenderOperationExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-operation-detail/v2': [
      { data: { operation: queuedMediaIngestOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v3': [
      { data: { operation: queuedProjectProxyRenderOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v4': [
      { data: { operation: queuedProjectFinalExportOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v1': [
      {
        data: { operations: [] },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          operations: [queuedRenderOperationExample],
          nextCursor: Buffer.from(JSON.stringify({
            v: 1,
            createdAt: queuedRenderOperationExample.createdAt,
            id: queuedRenderOperationExample.id,
            filterHash: 'a'.repeat(64),
          })).toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-operation-list/v2': [
      { data: { operations: [queuedMediaIngestOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v3': [
      { data: { operations: [queuedProjectProxyRenderOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v4': [
      { data: { operations: [queuedProjectFinalExportOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/webhook-delivery-list/v1': [
      {
        data: { deliveries: [] },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          deliveries: [webhookDeliveryExample],
          nextCursor: Buffer.from(JSON.stringify({
            v: 1,
            createdAt,
            id: webhookDeliveryExample.id,
            filterHash: 'f'.repeat(64),
          })).toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-endpoint-list/v1': [
      { data: { endpoints: [] }, meta: { apiVersion: 'v1' } },
      { data: { endpoints: [webhookEndpointExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/create-webhook-endpoint-request/v1': [
      { url: 'https://hooks.example.com/apollo' },
    ],
    'apollo://schemas/webhook-endpoint-created/v1': [
      {
        data: { endpoint: webhookPendingEndpointExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { endpoint: webhookPendingEndpointExample, replayed: true },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-endpoint-detail/v1': [
      { data: { endpoint: { ...webhookEndpointExample, signingSecrets: [webhookSecretMetadataExample] } }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/set-webhook-endpoint-status-request/v1': [
      { status: 'suspended', baseRevision: webhookEndpointExample.revision },
      { status: 'revoked', baseRevision: webhookEndpointExample.revision },
    ],
    'apollo://schemas/webhook-endpoint-status-result/v1': [
      {
        data: {
          endpoint: { ...webhookEndpointExample, status: 'suspended' },
          effects: { pausedSubscriptions: 1, revokedSubscriptions: 0, revokedSigningSecrets: 0 },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          endpoint: webhookEndpointExample,
          effects: { pausedSubscriptions: 0, revokedSubscriptions: 0, revokedSigningSecrets: 0 },
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-endpoint-challenge-result/v1': [
      {
        data: {
          endpoint: webhookEndpointExample,
          effects: { activatedSubscriptions: 1 },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          endpoint: webhookEndpointExample,
          effects: { activatedSubscriptions: 0 },
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/provision-webhook-signing-secret-request/v1': [
      { baseRevision: webhookPendingEndpointExample.revision },
    ],
    'apollo://schemas/webhook-signing-secret-provisioned/v1': [
      {
        data: {
          endpoint: {
            ...webhookPendingEndpointExample,
            currentSigningSecret: { ...webhookSecretMetadataExample, version: 2 },
          },
          secretBase64url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          secretAvailable: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          endpoint: {
            ...webhookPendingEndpointExample,
            currentSigningSecret: { ...webhookSecretMetadataExample, version: 2 },
          },
          secretAvailable: false,
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/stage-webhook-signing-secret-rotation-request/v1': [
      { baseRevision: webhookEndpointExample.revision, overlapSeconds: 300 },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-staged/v1': [
      {
        data: {
          rotation: {
            id: '20000000-0000-4000-8000-000000000010',
            endpointId: webhookEndpointExample.id,
            candidateVersion: 2,
            fingerprint: 'c'.repeat(64),
            status: 'staged',
            overlapSeconds: 300,
            createdAt,
            expiresAt: '2026-07-13T20:00:00.000Z',
          },
          secretBase64url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          secretAvailable: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          rotation: {
            id: '20000000-0000-4000-8000-000000000010',
            endpointId: webhookEndpointExample.id,
            candidateVersion: 2,
            fingerprint: 'c'.repeat(64),
            status: 'staged',
            overlapSeconds: 300,
            createdAt,
            expiresAt: '2026-07-13T20:00:00.000Z',
          },
          secretAvailable: false,
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/activate-webhook-signing-secret-rotation-request/v1': [
      { baseRevision: webhookEndpointExample.revision },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-activated/v1': [
      {
        data: {
          endpoint: { id: webhookEndpointExample.id, status: 'active', revision: 'd'.repeat(64) },
          rotation: {
            id: '20000000-0000-4000-8000-000000000010', status: 'activated',
            candidateVersion: 2, fingerprint: 'c'.repeat(64), overlapSeconds: 300,
            activatedAt: '2026-07-12T20:05:00.000Z', overlapUntil: '2026-07-12T20:10:00.000Z',
          },
          signing: {
            activeVersion: 2, activeFingerprint: 'c'.repeat(64),
            previousVersion: 1, previousFingerprint: webhookSecretMetadataExample.fingerprint,
            previousUsableUntil: '2026-07-12T20:10:00.000Z',
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/cancel-webhook-signing-secret-rotation-request/v1': [
      { baseRevision: webhookEndpointExample.revision },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-cancelled/v1': [
      {
        data: {
          rotation: {
            id: '20000000-0000-4000-8000-000000000011',
            endpointId: webhookEndpointExample.id,
            status: 'cancelled', candidateVersion: 3,
            fingerprint: 'e'.repeat(64), cancelledAt: '2026-07-12T20:15:00.000Z',
          },
          envelopeDestroyed: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-list/v3': [
      { data: { projects: [] }, meta: { apiVersion: 'v1' } },
      {
        data: {
          projects: [{
            id: projectId, workspaceId, name: 'Anúncio de descoberta', status: 'draft',
            currentVersionId: 'project-version-example-1', objective: 'discovery', format: '9:16',
            locale: 'pt-BR', ownerId: 'client-example-1', createdAt,
          }],
          nextCursor: Buffer.from('project-search-page-example').toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/capability-list/v2': [
      {
        data: {
          capabilities: [
            {
              id: 'apollo.sessions.login',
              version: '1.0.0',
              title: 'Create human UI session',
              description: 'Authenticates a human operator and creates an HTTP-only UI session.',
              operationKind: 'command',
              authMode: 'none',
              authScheme: 'none',
              requiredScopes: [],
              inputSchemaRef: 'apollo://schemas/ui-session-create-request/v1',
              outputSchemaRef: 'apollo://schemas/ui-session-created/v1',
              endpoint: { method: 'POST', path: '/v1/session' },
              supportsDryRun: false,
              costClass: 'free',
              confirmation: 'none',
              successStatuses: [200],
              idempotency: 'natural',
              requestBodyRequired: true,
              responseMediaType: 'application/json',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/capability-list/v3': [
      {
        data: {
          capabilities: [{
            id: 'apollo.media.uploads.content.put', version: '1.0.0', title: 'Upload signed media bytes',
            description: 'Receives media bytes through a short-lived signed URL.', operationKind: 'command',
            authMode: 'required', authScheme: 'signed-token', requiredScopes: [],
            inputSchemaRef: 'apollo://schemas/binary-media-content/v1', outputSchemaRef: 'apollo://schemas/media-upload-content-received/v1',
            endpoint: { method: 'PUT', path: '/v1/media/uploads/{uploadId}/content' }, supportsDryRun: false,
            costClass: 'low', confirmation: 'none', successStatuses: [201], idempotency: 'natural',
            queryParameters: [], requestBodyRequired: true, requestMediaType: 'application/octet-stream', responseMediaType: 'application/json',
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/begin-media-upload-request/v1': [
      { kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64) },
    ],
    'apollo://schemas/binary-media-content/v1': ['binary-media-bytes'],
    'apollo://schemas/create-review-annotation-request/v1': [
      {
        projectVersionId: 'project-version-example-2',
        proxyArtifactId: 'artifact-review-proxy-1',
        proxyHash: 'e'.repeat(64),
        frame: 315,
        timeRangeMs: [10500, 10500],
        scope: 'region',
        region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
        targetIds: [],
        screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
        text: 'Reposicionar a legenda abaixo do rosto.',
      },
    ],
    'apollo://schemas/create-review-annotation-request/v2': [
      {
        projectVersionId: 'project-version-example-2',
        proxyArtifactId: 'artifact-review-proxy-1',
        proxyHash: 'e'.repeat(64),
        frame: 315,
        timeRangeMs: [10500, 10500],
        scope: 'region',
        region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
        targetIds: [],
        applicationScope: { kind: 'scene', global: false },
        screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
        text: 'Reposicionar a legenda abaixo do rosto.',
      },
    ],
    'apollo://schemas/project-review/v1': [
      {
        data: {
          session: {
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyUrl: '/v1/artifacts/artifact-review-proxy-1/content',
            proxyHash: 'e'.repeat(64),
            fps: 30,
            resolution: { width: 1080, height: 1920 },
            durationFrames: 2400,
            stale: false,
          },
          scenes: [{ id: 'scene:clip-example-1', label: 'Cena 1', startFrame: 0, endFrame: 900 }],
          annotations: [{
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-review/v2': [
      {
        data: {
          session: {
            currentProjectVersionId: 'project-version-example-2',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyUrl: '/v1/artifacts/artifact-review-proxy-1/content',
            proxyHash: 'e'.repeat(64),
            fps: 30,
            resolution: { width: 1080, height: 1920 },
            durationFrames: 2400,
            stale: false,
          },
          versions: [
            { id: 'project-version-example-2', sequence: 2, createdAt, current: true, previewAvailable: true },
            { id: 'project-version-example-1', sequence: 1, createdAt, current: false, previewAvailable: false },
          ],
          scopeContext: {
            formatId: '9:16',
            localeId: 'pt-BR',
            recipeIds: ['project-final-export'],
            options: [
              { kind: 'frame', affectedCount: 2400, enabled: true },
              { kind: 'region', affectedCount: 1, enabled: true },
              { kind: 'clip', affectedCount: 3, enabled: true },
              { kind: 'scene', affectedCount: 3, enabled: true },
              { kind: 'range', affectedCount: 1, enabled: true },
              { kind: 'project', affectedCount: 1, enabled: true },
              { kind: 'formats', affectedCount: 1, enabled: true },
              { kind: 'locales', affectedCount: 1, enabled: true },
              { kind: 'recipes', affectedCount: 1, enabled: true },
            ],
          },
          scenes: [{ id: 'scene:clip-example-1', label: 'Cena 1', startFrame: 0, endFrame: 900 }],
          annotations: [{
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            applicationScope: { kind: 'scene', targetIds: ['scene:clip-example-1'], formatIds: ['9:16'], localeIds: ['pt-BR'], recipeIds: ['project-final-export'], global: false },
            affectedCount: 1,
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-annotation-created/v1': [
      {
        data: {
          annotation: {
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-annotation-created/v2': [
      {
        data: {
          annotation: {
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            applicationScope: { kind: 'scene', targetIds: ['scene:clip-example-1'], formatIds: ['9:16'], localeIds: ['pt-BR'], recipeIds: ['project-final-export'], global: false },
            affectedCount: 1,
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-review-patch-proposal-request/v1': [
      { annotationId: reviewPatchProposalExample.annotationId },
    ],
    'apollo://schemas/review-patch-proposal-created/v1': [
      { data: { proposal: reviewPatchProposalExample, replayed: false }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/review-patch-proposal/v1': [
      { data: { proposal: reviewPatchProposalExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/apply-review-patch-request/v1': [
      { confirmed: true },
    ],
    'apollo://schemas/review-patch-applied/v1': [
      {
        data: {
          proposal: {
            ...reviewPatchProposalExample,
            status: 'applied',
            resultCommandId: 'edit-command-example-214',
            resultVersionId: 'project-version-example-3',
            renderOperationId: queuedProjectProxyRenderOperationExample.id,
            comparison: {
              beforeVersionId: 'project-version-example-2',
              afterVersionId: 'project-version-example-3',
              beforeEditPlanHash: 'a'.repeat(64),
              afterEditPlanHash: 'b'.repeat(64),
              changedTargets: ['subtitle:subtitle-cue-2'],
              invalidatedRanges: [[10500, 10500]],
            },
            render: { operationId: queuedProjectProxyRenderOperationExample.id, status: 'queued', phase: 'queued' },
          },
          command: { id: 'edit-command-example-214', type: 'apply-review-patch', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3', createdAt },
          version: {
            id: 'project-version-example-3', sequence: 3, parentVersionId: 'project-version-example-2', baseHash: 'c'.repeat(64),
            snapshotRefs: { brief: 'snapshot-brief-example-1', treatment: 'snapshot-treatment-example-1', story: 'snapshot-story-example-1', editPlan: 'snapshot-edit-plan-example-3', policies: 'snapshot-policies-example-1' },
            createdAt,
          },
          comparison: {
            beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3', beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
            changedTargets: ['subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500]],
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/render-element-hit-test/v1': [
      {
        data: {
          map: {
            schemaVersion: 'render-element-map/v1',
            mapHash: 'f'.repeat(64),
            proxyHash: 'e'.repeat(64),
            fps: 30,
            durationFrames: 2400,
            canvas: { width: 1080, height: 1920 },
            frame: 315,
          },
          selected: {
            elementId: 'subtitle:cue-example-1',
            type: 'subtitle',
            clipId: 'clip-example-1',
            sceneId: 'scene:clip-example-1',
            sourceId: artifactId,
            frame: 315,
            bounds: { x: 162, y: 1560, width: 756, height: 128 },
            zIndex: 20,
            opacity: 1,
            priority: 300,
          },
          chooserRequired: true,
          candidates: [
            {
              elementId: 'subtitle:cue-example-1', type: 'subtitle', clipId: 'clip-example-1',
              sceneId: 'scene:clip-example-1', sourceId: artifactId, frame: 315,
              bounds: { x: 162, y: 1560, width: 756, height: 128 }, zIndex: 20, opacity: 1, priority: 300,
            },
            {
              elementId: 'presenter:clip-example-1', type: 'presenter', clipId: 'clip-example-1',
              sceneId: 'scene:clip-example-1', sourceId: artifactId, frame: 315,
              bounds: { x: 0, y: 656, width: 1080, height: 608 }, zIndex: 10, opacity: 1, priority: 200,
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v1': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anúncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          media: [], transcripts: [], operationIds: [], operations: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v2': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anúncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-2', sequence: 2, baseHash: 'b'.repeat(64), createdAt },
          editPlan: {
            id: 'edit-plan-example-2', state: 'compiled', fps: 30, durationFrames: 2683,
            clipCount: 4, cutCount: 3, automaticZoom: false, subtitleFaceProtection: true,
          },
          commands: [{
            id: 'edit-command-example-1', type: 'remove-spoken-content',
            baseVersionId: 'project-version-example-1', resultVersionId: 'project-version-example-2',
            reason: 'Remover datas e duração obsoletas.', createdAt,
          }],
          media: [], transcripts: [], operationIds: [], operations: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v3': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-3', sequence: 3, baseHash: 'c'.repeat(64), createdAt },
          editPlan: { id: 'edit-plan-example-3', state: 'compiled', fps: 30, durationFrames: 2380, clipCount: 3, cutCount: 2, automaticZoom: false, subtitleFaceProtection: true },
          commands: [],
          media: [{
            id: 'project-media-editorial-example-1', role: 'editorial-proxy', originalFileName: 'video-editorial.mp4',
            artifactId: 'artifact-editorial-proxy-example-1', manifestId: 'manifest-editorial-proxy-example-1', mediaType: 'video', container: 'mp4',
            byteSize: '1234567', sha256: 'e'.repeat(64), status: 'available', probe: { width: 540, height: 960, duration: 79.3, fps: 30 }, createdAt,
          }],
          transcripts: [], operationIds: [queuedProjectProxyRenderOperationExample.id], operations: [queuedProjectProxyRenderOperationExample],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v4': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-4', sequence: 4, baseHash: 'd'.repeat(64), createdAt },
          editPlan: { id: 'edit-plan-example-4', state: 'compiled', fps: 30, durationFrames: 2380, clipCount: 3, cutCount: 2, automaticZoom: false, subtitleFaceProtection: true },
          commands: [{
            id: 'edit-command-director-example-1', type: 'run-director', baseVersionId: 'project-version-example-3',
            resultVersionId: 'project-version-example-4', reason: 'Planejar e revisar a composicao completa.', createdAt,
          }],
          directorRuns: [{
            id: 'director-run-example-1', status: 'planned', plannerVersion: 'apollo-director-policy/v1', criticVersion: 'apollo-director-critic/v1',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4',
            treatmentSnapshotId: 'project-snapshot-treatment-1', storySnapshotId: 'project-snapshot-story-1', qualitySnapshotId: 'project-snapshot-quality-1',
            qualityStatus: 'approved-with-warnings', qualityScore: 0.9, decisionCount: 6, assumptionCount: 2,
            subtitleCueCount: 28, transitionCount: 2, automaticZoom: false, createdAt,
          }],
          media: [{
            id: 'project-media-editorial-example-1', role: 'editorial-proxy', originalFileName: 'video-editorial.mp4',
            artifactId: 'artifact-editorial-proxy-example-1', manifestId: 'manifest-editorial-proxy-example-1', mediaType: 'video', container: 'mp4',
            byteSize: '1234567', sha256: 'e'.repeat(64), status: 'available', probe: { width: 540, height: 960, duration: 79.3, fps: 30 }, createdAt,
          }],
          transcripts: [], operationIds: [queuedProjectProxyRenderOperationExample.id], operations: [queuedProjectProxyRenderOperationExample],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v5': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'completed', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-4', sequence: 4, baseHash: 'd'.repeat(64), createdAt },
          editPlan: { id: 'edit-plan-example-4', state: 'compiled', fps: 30, durationFrames: 2380, clipCount: 3, cutCount: 2, automaticZoom: false, subtitleFaceProtection: true },
          commands: [{
            id: 'edit-command-director-example-1', type: 'run-director', baseVersionId: 'project-version-example-3',
            resultVersionId: 'project-version-example-4', reason: 'Planejar e revisar a composicao completa.', createdAt,
          }],
          directorRuns: [{
            id: 'director-run-example-1', status: 'succeeded', plannerVersion: 'apollo-director-policy/v1', criticVersion: 'apollo-director-critic/v1',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4',
            treatmentSnapshotId: 'project-snapshot-treatment-1', storySnapshotId: 'project-snapshot-story-1', qualitySnapshotId: 'project-snapshot-quality-1',
            qualityStatus: 'approved-with-warnings', qualityScore: 0.9, decisionCount: 6, assumptionCount: 2,
            subtitleCueCount: 28, transitionCount: 2, automaticZoom: false, createdAt,
          }],
          media: [{
            id: 'project-media-final-example-1', role: 'final-output', originalFileName: 'video-final-1080x1920.mp4',
            artifactId: 'artifact-final-example-1', manifestId: 'manifest-final-example-1', mediaType: 'video', container: 'mp4',
            byteSize: '6234567', sha256: 'f'.repeat(64), status: 'available', probe: { width: 1080, height: 1920, duration: 79.3, fps: 30 }, createdAt,
          }],
          transcripts: [], operationIds: [queuedProjectFinalExportOperationExample.id], operations: [queuedProjectFinalExportOperationExample],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/begin-media-upload-request/v2': [
      { projectId, fileName: 'gravacao-bruta.mp4', rightsConfirmed: true, kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64) },
    ],
    'apollo://schemas/media-upload-begun/v1': [
      {
        data: {
          upload: {
            id: '123e4567-e89b-42d3-a456-426614174001', kind: 'video', size: '104857600',
            mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'pending-session',
            expiresAt: '2026-07-16T22:30:00.000Z', createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-begun/v2': [
      {
        data: {
          upload: {
            id: '123e4567-e89b-42d3-a456-426614174001', projectId, fileName: 'gravacao-bruta.mp4', rightsConfirmed: true,
            kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'pending-session',
            expiresAt: '2026-07-16T22:30:00.000Z', createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-session/v1': [
      {
        data: {
          uploadId: '123e4567-e89b-42d3-a456-426614174001',
          session: {
            mode: 'single', expiresAt: '2026-07-16T22:25:00.000Z', maxParts: 1,
            requiredHeaders: { 'content-type': 'video/mp4', 'x-apollo-content-sha256': 'a'.repeat(64) },
            uploadUrl: 'https://uploads.example.com/v1/media/uploads/123e4567-e89b-42d3-a456-426614174001/content?token=opaque',
          },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-content-received/v1': [
      { data: { receipt: { byteSize: '104857600', checksum: 'a'.repeat(64), etag: '"uploadetag001"' } }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/record-media-upload-part-request/v1': [
      { byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64) },
    ],
    'apollo://schemas/media-upload-part-recorded/v1': [
      {
        data: { part: { uploadId: '123e4567-e89b-42d3-a456-426614174001', partNumber: 1, byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64), recordedAt: createdAt } },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-detail/v1': [
      {
        data: {
          upload: { id: '123e4567-e89b-42d3-a456-426614174001', kind: 'video', size: '134217728', mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'uploading', expiresAt: '2026-07-16T22:30:00.000Z', createdAt },
          parts: [{ uploadId: '123e4567-e89b-42d3-a456-426614174001', partNumber: 1, byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64), recordedAt: createdAt }],
          missingPartNumbers: [2],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-detail/v2': [
      {
        data: {
          upload: { id: '123e4567-e89b-42d3-a456-426614174001', projectId, fileName: 'gravacao-bruta.mp4', rightsConfirmed: true, kind: 'video', size: '134217728', mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'uploading', expiresAt: '2026-07-16T22:30:00.000Z', createdAt },
          parts: [{ uploadId: '123e4567-e89b-42d3-a456-426614174001', partNumber: 1, byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64), recordedAt: createdAt }],
          missingPartNumbers: [2],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-completed/v1': [
      { data: { uploadId: '123e4567-e89b-42d3-a456-426614174001', status: 'verified', verifiedAt: createdAt, replayed: false }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/media-upload-completed/v2': [
      { data: { uploadId: '123e4567-e89b-42d3-a456-426614174001', status: 'verified', verifiedAt: createdAt, operation: queuedMediaIngestOperationExample, replayed: false }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/media-upload-aborted/v1': [
      { data: { uploadId: '123e4567-e89b-42d3-a456-426614174001', status: 'aborted', aborted: true }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/issue-media-download-grant-request/v1': [
      { ttlSeconds: 300 },
    ],
    'apollo://schemas/media-download-grant-issued/v1': [
      {
        data: {
          grant: { id: '123e4567-e89b-42d3-a456-426614174301', artifactId: 'artifact-example-proxy-1', status: 'active', expiresAt: '2026-07-16T22:35:00.000Z', createdAt },
          downloadUrl: 'https://downloads.example.com/grants/123e4567-e89b-42d3-a456-426614174301/content?token=opaque',
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-download-grant-revoked/v1': [
      {
        data: { grant: { id: '123e4567-e89b-42d3-a456-426614174301', artifactId: 'artifact-example-proxy-1', status: 'revoked', expiresAt: '2026-07-16T22:35:00.000Z', revokedAt: '2026-07-16T22:32:00.000Z' }, replayed: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/preflight-result/v1': [
      {
        schemaVersion: 'preflight-result/v1', eligible: true, fingerprint: 'f'.repeat(64), evaluatedAt: createdAt,
        targets: [{ kind: 'project-version', id: 'project-version-example-2', version: '2' }], conflicts: [],
        invalidations: [{ kind: 'proxy', id: 'artifact-example-proxy-1', reason: 'Timeline trim changes proxy frames.' }],
        jobs: [{ kind: 'render-proxy', count: 1, estimatedDurationMs: 45000 }],
        cost: { currency: 'USD', estimatedMinorUnits: 12, maximumMinorUnits: 20 },
        quota: { unit: 'render-minute', required: 1, remaining: 120, allowed: true },
        warnings: [{ code: 'CAPTION_REFLOW', message: 'Caption line breaks may change.', target: 'track:captions' }],
      },
    ],
    'apollo://schemas/preflight-commit-token/v1': [
      { token: `${'e'.repeat(80)}.${'s'.repeat(43)}`, expiresAt: '2026-07-16T23:35:00.000Z' },
    ],
    'apollo://schemas/batch-item-page/v1': [
      { data: { batchId: 'batch-example-1', items: [
        { itemId: 'item-1', operationId: 'operation-example-1', status: 'succeeded', retryable: false, resultRef: 'artifact-example-1', updatedAt: createdAt },
        { itemId: 'item-2', operationId: 'operation-example-2', status: 'failed', retryable: true, error: { code: 'PROVIDER_TIMEOUT', message: 'Provider timed out.' }, updatedAt: createdAt },
      ] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/governance-usage-audit-page/v1': [
      { data: { entries: [{ id: 'operation-example-1', clientId: 'client-example-1', action: 'artifact-render', status: 'succeeded', target: { type: 'artifact', id: 'artifact-example-1' }, usage: { unit: 'operation', quantity: 1 }, createdAt, updatedAt: createdAt }] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-list/v1': [
      { data: { rotations: [] }, meta: { apiVersion: 'v1' } },
      { data: { rotations: [webhookSigningSecretRotationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-detail/v1': [
      { data: { rotation: webhookSigningSecretRotationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/run-webhook-signing-secret-hygiene-request/v1': [
      { limitPerKind: 100 },
    ],
    'apollo://schemas/webhook-signing-secret-hygiene-result/v1': [
      {
        data: {
          asOf: createdAt, expiredRotations: 1, destroyedRotationEnvelopes: 1,
          destroyedSigningSecretPayloads: 2, hasMore: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/agent-tool-list/v1': [
      {
        data: {
          tools: [{
            name: 'apollo.health.read',
            title: 'Read API health',
            description: 'Returns API liveness.',
            inputSchema: { type: 'object', additionalProperties: false, properties: {} },
            outputSchema: { type: 'object' },
            errorSchema: { type: 'object' },
            annotations: { readOnlyHint: true, idempotentHint: true },
            apollo: {
              capabilityId: 'apollo.health.read',
              capabilityVersion: '1.0.0',
              operationKind: 'query',
              requiredScopes: [],
              endpoint: { method: 'GET', path: '/v1/health' },
              costClass: 'free',
              confirmation: 'none',
              supportsDryRun: false,
            },
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/agent-tool-list/v2': [
      {
        data: {
          tools: [{
            name: 'apollo.health.read', title: 'Read API health', description: 'Returns API liveness.',
            inputSchema: { type: 'object', additionalProperties: false, properties: {} },
            outputSchema: { type: 'object' }, errorSchema: { type: 'object' },
            annotations: { readOnlyHint: true, idempotentHint: true },
            apollo: {
              capabilityId: 'apollo.health.read', capabilityVersion: '1.0.0', operationKind: 'query',
              requiredScopes: [], endpoint: { method: 'GET', path: '/v1/health' }, costClass: 'free',
              confirmation: 'none', supportsDryRun: false,
              dataBoundary: {
                structureClassification: 'trusted-contract', mediaContentClassification: 'untrusted-data',
                instructionPolicy: 'never-execute', inputPaths: [], outputPaths: [],
              },
            },
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-subscription-list/v1': [
      { data: { subscriptions: [] }, meta: { apiVersion: 'v1' } },
      { data: { subscriptions: [webhookSubscriptionExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/create-webhook-subscription-request/v1': [
      {
        endpointId: webhookEndpointExample.id,
        eventTypes: ['artifact.ready'],
        resourceIds: ['artifact-example-1'],
      },
    ],
    'apollo://schemas/webhook-subscription-created/v1': [
      {
        data: { subscription: webhookSubscriptionExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { subscription: webhookSubscriptionExample, replayed: true },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-subscription-detail/v1': [
      { data: { subscription: webhookSubscriptionExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/set-webhook-subscription-status-request/v1': [
      { status: 'paused', baseRevision: webhookSubscriptionExample.revision },
      { status: 'revoked', baseRevision: webhookSubscriptionExample.revision },
    ],
    'apollo://schemas/webhook-delivery-detail/v1': [
      {
        data: {
          delivery: { ...webhookDeliveryExample, attempts: [webhookAttemptExample] },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-delivery-replay-result/v1': [
      {
        data: { delivery: webhookReplayDeliveryExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { delivery: webhookReplayDeliveryExample, replayed: true },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-event-replay-result/v1': [
      {
        data: {
          eventId: webhookDeliveryExample.eventId,
          items: [{ status: 'scheduled', delivery: webhookReplayDeliverySummaryExample }],
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          eventId: webhookDeliveryExample.eventId,
          items: [{ status: 'scheduled', delivery: webhookReplayDeliverySummaryExample }],
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-project-request/v1': [
      { name: 'Anúncio de descoberta' },
    ],
    'apollo://schemas/create-project-request/v2': [
      {
        name: 'Anúncio de descoberta',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        briefing: 'Apresentar a ideia com ritmo natural e sem efeitos gratuitos.',
      },
    ],
    'apollo://schemas/project-created/v1': [
      {
        data: {
          project: {
            id: projectId,
            workspaceId,
            name: 'Anúncio de descoberta',
            status: 'draft',
            currentVersionId: 'project-version-example-1',
            createdAt,
          },
          version: {
            id: 'project-version-example-1',
            sequence: 1,
            baseHash: 'a'.repeat(64),
            snapshotRefs: {
              editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-created/v2': [
      {
        data: {
          project: {
            id: projectId,
            workspaceId,
            name: 'Anúncio de descoberta',
            status: 'draft',
            objective: 'discovery',
            format: '9:16',
            locale: 'pt-BR',
            ownerId: clientId,
            currentVersionId: 'project-version-example-1',
            createdAt,
          },
          version: {
            id: 'project-version-example-1',
            sequence: 1,
            baseHash: 'a'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1',
              editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/apply-project-edit-command-request/v1': [
      {
        type: 'remove-spoken-content', baseVersionId: 'project-version-example-1', baseHash: 'a'.repeat(64), sourceTranscriptId: 'transcript-example-1',
        rules: [
          { id: 'date-january-31', label: '31 de janeiro', alternatives: ['31 de janeiro', 'trinta e um de janeiro'] },
          { id: 'date-february-1', label: '1 de fevereiro', alternatives: ['1 de fevereiro', 'primeiro de fevereiro'] },
          { id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] },
        ],
      },
    ],
    'apollo://schemas/apply-project-edit-command-request/v2': [
      {
        type: 'remove-spoken-content',
        baseVersionId: 'project-version-example-1',
        baseHash: 'a'.repeat(64),
        sourceTranscriptId: 'transcript-example-1',
        rules: [
          { id: 'date-january-31', label: '31 de janeiro', alternatives: ['31 de janeiro', 'trinta e um de janeiro'] },
          { id: 'date-february-1', label: '1 de fevereiro', alternatives: ['1 de fevereiro', 'primeiro de fevereiro'] },
          { id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] },
        ],
        exclusionOverrides: [
          { sourceStartSeconds: 36.26, sourceEndSeconds: 58.12, ruleIds: ['date-january-31', 'date-february-1'], reason: 'Remover o bloco de agenda sem deixar uma frase quebrada.' },
          { sourceStartSeconds: 86.58, sourceEndSeconds: 87.76, ruleIds: ['duration-two-days'], reason: 'Remover apenas a duração, preservando o restante da promessa.' },
        ],
        reason: 'Remover informações de data e duração que não pertencem à nova composição.',
      },
    ],
    'apollo://schemas/apply-project-edit-command-request/v3': [
      {
        type: 'remove-spoken-content',
        baseVersionId: 'project-version-example-1',
        baseHash: 'a'.repeat(64),
        sourceTranscriptId: 'transcript-example-1',
        rules: [{ id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] }],
        reason: 'Remover a duracao obsoleta.',
      },
      {
        type: 'run-director',
        baseVersionId: 'project-version-example-3',
        baseHash: 'c'.repeat(64),
        reason: 'Planejar, criticar e materializar a composicao completa.',
      },
    ],
    'apollo://schemas/project-edit-command-applied/v1': [
      {
        data: {
          command: {
            id: 'edit-command-example-1', type: 'remove-spoken-content',
            baseVersionId: 'project-version-example-1', resultVersionId: 'project-version-example-2', createdAt,
          },
          version: {
            id: 'project-version-example-2', sequence: 2, parentVersionId: 'project-version-example-1',
            baseHash: 'b'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', editPlan: 'project-snapshot-edit-plan-2', policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          editorial: {
            sourceTranscriptId: 'transcript-example-1', sourceArtifactId: artifactId,
            exclusions: [{
              sourceStartSeconds: 39.02, sourceEndSeconds: 42.68,
              ruleIds: ['date-january-31', 'date-february-1'],
              labels: ['31 de janeiro', '1 de fevereiro'],
              matchedText: '31 de janeiro | 1 de fevereiro',
            }],
            retainedSourceRanges: [
              { sourceStartSeconds: 0, sourceEndSeconds: 39.02 },
              { sourceStartSeconds: 42.68, sourceEndSeconds: 102.166 },
            ],
            outputDurationFrames: 2955, fps: 30, automaticZoom: false,
            protectedOpeningFrames: 120, subtitleFaceProtection: true,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-edit-command-applied/v2': [
      {
        data: {
          command: {
            id: 'edit-command-director-example-1', type: 'run-director',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4', createdAt,
          },
          version: {
            id: 'project-version-example-4', sequence: 4, parentVersionId: 'project-version-example-3', baseHash: 'd'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', perception: 'project-snapshot-perception-1', treatment: 'project-snapshot-treatment-1',
              story: 'project-snapshot-story-1', editPlan: 'project-snapshot-edit-plan-4', quality: 'project-snapshot-quality-1', policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          directorRun: {
            id: 'director-run-example-1', status: 'planned', plannerVersion: 'apollo-director-policy/v1', criticVersion: 'apollo-director-critic/v1',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4',
            perception: { snapshotId: 'project-snapshot-perception-1', summary: { speechCoverage: 0.78, visualCoverage: 'partial', faceCoverage: 'absent' } },
            treatmentPlan: { snapshotId: 'project-snapshot-treatment-1', plan: { mode: 'talking-head', objective: 'discovery' } },
            storyPlan: { snapshotId: 'project-snapshot-story-1', plan: { objective: 'discovery', blockCount: 3 } },
            editPlan: { snapshotId: 'project-snapshot-edit-plan-4', id: 'edit-plan-example-4', durationFrames: 2380, fps: 30, subtitleCueCount: 28, transitionCount: 2, automaticZoom: false },
            qualityReport: { snapshotId: 'project-snapshot-quality-1', report: { status: 'approved-with-warnings', score: 0.9 } },
            decisions: [
              { id: 'decision-narrative-linear', category: 'narrative', choice: 'preserve-linear-narrative' },
              { id: 'decision-motion-none', category: 'movement', choice: 'no_effect' },
              { id: 'decision-layout-inset', category: 'layout', choice: 'landscape-inset-on-blurred-source' },
              { id: 'decision-subtitle-bottom', category: 'subtitle', choice: 'bottom-face-safe-clean' },
            ],
            assumptions: ['Face detector indisponivel; aplicar safe area conservadora.'],
            createdAt,
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-proxy-render-operation-accepted/v1': [
      {
        data: {
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-final-export-request/v1': [
      {
        projectVersionId: 'project-version-example-4', projectVersionHash: 'd'.repeat(64), format: '9:16',
        approval: { approved: true, note: 'Revisado e aprovado para entrega.' },
      },
    ],
    'apollo://schemas/project-final-export-operation-accepted/v1': [
      {
        data: {
          operation: queuedProjectFinalExportOperationExample,
          approval: { actorType: 'api-client', actorId: 'api-client-example-1', approvedAt: createdAt, note: 'Revisado e aprovado para entrega.' },
          outputSpec: { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/api-client-list/v1': [
      { data: { clients: [] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/create-api-client-request/v1': [
      {
        name: 'Automation Agent',
        environment: 'sandbox',
        scopes: ['projects:read'],
      },
    ],
    'apollo://schemas/api-client-created/v1': [
      {
        data: {
          client: {
            id: clientId,
            workspaceId,
            name: 'Automation Agent',
            status: 'active',
            environment: 'sandbox',
            scopes: ['projects:read'],
            createdAt,
          },
          credential: {
            id: credentialId,
            clientId,
            status: 'active',
            createdAt,
          },
          token: `apollo_v2.${clientId}.${credentialId}.example-secret-that-is-not-valid`,
          secretAvailable: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/rotate-api-credential-request/v1': [
      {},
      { overlapSeconds: 900 },
    ],
    'apollo://schemas/api-credential-created/v1': [
      {
        data: {
          client: {
            id: clientId,
            workspaceId,
            name: 'Automation Agent',
            status: 'active',
            environment: 'sandbox',
            scopes: ['projects:read'],
            createdAt,
          },
          credential: {
            id: 'credential-example-2',
            clientId,
            status: 'active',
            createdAt,
          },
          secretAvailable: false,
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/api-credential-revoked/v1': [
      {
        data: {
          credential: {
            id: credentialId,
            clientId,
            status: 'revoked',
            createdAt,
            revokedAt: '2026-07-12T20:10:00.000Z',
          },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/error-envelope/v1': [
      {
        error: {
          code: 'AUTH_INVALID',
          message: 'Invalid API credential',
          category: 'auth',
          retryable: false,
          requestId: 'request-example-1',
        },
      },
    ],
    'apollo://schemas/error-envelope/v2': [
      {
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Command targets changed since its base version',
          category: 'conflict',
          retryable: false,
          requestId: 'request-conflict-example-1',
          conflict: {
            currentVersionId: 'project-version-example-2',
            conflictingTargets: ['clip:clip-example-1'],
            diff: {
              commands: ['command-example-intervening-1'],
              storyChanges: [],
              timelineChanges: [
                {
                  commandId: 'command-example-intervening-1',
                  target: 'clip:clip-example-1',
                  summary: 'Clip trim changed from the command base.',
                },
              ],
              visualChanges: [],
              audioChanges: [],
              outputChanges: [],
              invalidatedArtifacts: ['artifact-example-proxy-1'],
              estimatedCostDelta: 0,
            },
          },
        },
      },
    ],
    'apollo://schemas/openapi-document/v1': [
      {
        openapi: '3.1.0',
        info: { title: 'Apollo Video Public API', version: '1.0.0' },
        paths: {},
        components: {},
      },
    ],
    'apollo://schemas/json-schema-document/v1': [
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'apollo://schemas/example/v1',
        title: 'Example schema',
        type: 'object',
      },
    ],
  })

export function publicSchemaExamples(definition: PublicSchemaDefinition): readonly unknown[] {
  return PUBLIC_SCHEMA_EXAMPLES[definition.ref] ?? []
}

export function publicSchemaDocument(definition: PublicSchemaDefinition) {
  return Object.freeze({
    ...definition.schema,
    examples: Object.freeze([...publicSchemaExamples(definition)]),
  })
}
