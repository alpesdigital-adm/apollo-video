import type { PublicSchemaDefinition } from './schema-registry.ts'

const createdAt = '2026-07-12T20:00:00.000Z'
const projectId = 'project-example-1'
const workspaceId = 'workspace-example-1'
const clientId = 'client-example-1'
const credentialId = 'credential-example-1'

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
    'apollo://schemas/project-list/v1': [
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
