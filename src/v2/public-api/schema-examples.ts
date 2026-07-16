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
    'apollo://schemas/begin-media-upload-request/v1': [
      { kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64) },
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
    'apollo://schemas/media-upload-completed/v1': [
      { data: { uploadId: '123e4567-e89b-42d3-a456-426614174001', status: 'verified', verifiedAt: createdAt, replayed: false }, meta: { apiVersion: 'v1' } },
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
