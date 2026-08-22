import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import {
  createProofIntegrityRunService,
  listProofIntegrityRunsService,
  readProofIntegrityRunService,
} from '../../src/v2/application/proof-integrity.ts'
import {
  PROOF_INTEGRITY_POLICY_VERSION,
} from '../../src/v2/domain/proof-integrity.ts'
import {
  FOUNDATION_CAPABILITIES,
} from '../../src/v2/public-api/capability-registry.ts'
import {
  parseCreateProofIntegrityBody,
  presentProofIntegrityRun,
  presentProofIntegrityRunPage,
} from '../../src/v2/public-api/proof-integrity-contract.ts'
import {
  PUBLIC_ERROR_CATALOG,
} from '../../src/v2/public-api/public-error-catalog.ts'

const workspaceId = 'workspace-proof-integrity-api'
const projectId = 'project-proof-integrity-api'
const proofNeedRunId = 'proof-need-run-proof-integrity-api'
const proofNeedItemId = 'proof-need-item-proof-integrity-api'
const runHash = 'a'.repeat(64)

const collectionRoute = await readFile(
  new URL(
    '../../src/app/v1/projects/[projectId]/proof-integrity-runs/route.ts',
    import.meta.url,
  ),
  'utf8',
)
const itemRoute = await readFile(
  new URL(
    '../../src/app/v1/projects/[projectId]/proof-integrity-runs/[runId]/route.ts',
    import.meta.url,
  ),
  'utf8',
)

function actor(overrides = {}) {
  const scopes = overrides.scopes ?? ['projects:read', 'projects:write']
  const actorWorkspaceId = overrides.workspaceId ?? workspaceId
  return Object.freeze({
    clientId: 'client-proof-integrity-api',
    credentialId: 'credential-proof-integrity-api',
    workspaceId: actorWorkspaceId,
    environment: 'production',
    scopes: new Set(scopes),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext: createExternalAuditContext({
      clientId: 'client-proof-integrity-api',
      credentialId: 'credential-proof-integrity-api',
      workspaceId: actorWorkspaceId,
      environment: 'production',
    }),
  })
}

function body(overrides = {}) {
  return {
    proofNeedRunId,
    expectedProofNeedRunHash: runHash,
    policyVersion: PROOF_INTEGRITY_POLICY_VERSION,
    uses: [{
      proofNeedItemId,
      includedContextRangeMs: [0, 3_000],
      includedAdjacentEvidenceIds: [],
    }],
    ...overrides,
  }
}

function createService(dependencies = {}) {
  return createProofIntegrityRunService({
    repository: {
      findReplay: async () => null,
      create: async () => {
        throw new Error('create must not run in a rejected request')
      },
      read: async () => null,
      list: async () => ({ runs: [] }),
      ...dependencies.repository,
    },
    proofNeeds: {
      read: async () => null,
      ...dependencies.proofNeeds,
    },
    variantRecipes: {
      read: async () => {
        throw new Error('variantRecipes must not run in a rejected request')
      },
    },
    compatibilityGraphs: {
      read: async () => {
        throw new Error(
          'compatibilityGraphs must not run in a rejected request',
        )
      },
    },
    evidenceSegments: {
      readCurrent: async () => {
        throw new Error(
          'evidenceSegments must not run in a rejected request',
        )
      },
    },
    clock: () => new Date('2026-07-29T14:00:00.000Z'),
    createRunId: () => 'proof-integrity-run-proof-integrity-api',
  })
}

async function rejection(execute) {
  try {
    await execute()
  } catch (error) {
    return error
  }
  throw new assert.AssertionError({
    message: 'the request should have been rejected',
  })
}

test('T-FR-131 public parser accepts only the declared create contract', () => {
  const parsed = parseCreateProofIntegrityBody(body())
  assert.deepEqual(parsed.uses[0].includedContextRangeMs, [0, 3_000])
  assert.equal(parsed.policyVersion, PROOF_INTEGRITY_POLICY_VERSION)
  assert.throws(
    () => parseCreateProofIntegrityBody({ ...body(), outcome: 'approved' }),
    /body contains unknown fields/,
  )
  assert.throws(
    () => parseCreateProofIntegrityBody({
      ...body(),
      expectedProofNeedRunHash: 'A'.repeat(64),
    }),
    /must be a lowercase SHA-256/,
  )
  assert.throws(
    () => parseCreateProofIntegrityBody({ ...body(), uses: {} }),
    /uses must contain at most sixteen entries/,
  )
  assert.throws(
    () => parseCreateProofIntegrityBody({
      ...body(),
      uses: Array.from({ length: 17 }, () => ({
        proofNeedItemId,
        includedAdjacentEvidenceIds: [],
      })),
    }),
    /uses must contain at most sixteen entries/,
  )
  assert.throws(
    () => parseCreateProofIntegrityBody(body({
      uses: [{
        proofNeedItemId,
        includedAdjacentEvidenceIds: [],
        approved: true,
      }],
    })),
    /uses\[0\] contains unknown fields/,
  )
  assert.throws(
    () => parseCreateProofIntegrityBody(body({
      uses: [{
        proofNeedItemId,
        includedContextRangeMs: [0, 1.5],
        includedAdjacentEvidenceIds: [],
      }],
    })),
    /includedContextRangeMs must contain two integers/,
  )
  assert.throws(
    () => parseCreateProofIntegrityBody(body({
      uses: [{
        proofNeedItemId: 'x',
        includedAdjacentEvidenceIds: [],
      }],
    })),
    /proofNeedItemId must contain 3 to 128 characters/,
  )
  assert.throws(
    () => parseCreateProofIntegrityBody([]),
    /body must be an object/,
  )
})

test('T-FR-131 create service rejects unauthorized and malformed requests before persisting', async () => {
  const request = {
    workspaceId,
    projectId,
    ...body(),
    actor: actor(),
    idempotencyKey: 'proof-integrity-api-key-1',
  }
  assert.equal(
    (await rejection(() => createService()({
      ...request,
      actor: actor({ scopes: ['projects:read'] }),
    }))).code,
    'AUTH_SCOPE_REQUIRED',
  )
  assert.equal(
    (await rejection(() => createService()({
      ...request,
      actor: actor({ workspaceId: 'workspace-proof-integrity-other' }),
    }))).code,
    'AUTH_INVALID',
  )
  assert.equal(
    (await rejection(() => createService()({
      ...request,
      idempotencyKey: '  ',
    }))).code,
    'INVALID_ARGUMENT',
  )
  assert.equal(
    (await rejection(() => createService()({
      ...request,
      policyVersion: 'proof-integrity-policy/v2',
    }))).code,
    'INVALID_ARGUMENT',
  )
  assert.equal(
    (await rejection(() => createService()({
      ...request,
      expectedProofNeedRunHash: 'not-a-sha256',
    }))).code,
    'INVALID_ARGUMENT',
  )
  assert.equal(
    (await rejection(() => createService()({
      ...request,
      uses: [
        { proofNeedItemId, includedAdjacentEvidenceIds: [] },
        { proofNeedItemId, includedAdjacentEvidenceIds: [] },
      ],
    }))).code,
    'INVALID_ARGUMENT',
  )
  assert.equal(
    (await rejection(() => createService()({
      ...request,
      uses: [{
        proofNeedItemId,
        includedAdjacentEvidenceIds: ['evidence-a', 'evidence-a'],
      }],
    }))).code,
    'INVALID_ARGUMENT',
  )
})

test('T-FR-131 create service fails closed when the ProofNeed run is absent or changed', async () => {
  const request = {
    workspaceId,
    projectId,
    ...body(),
    actor: actor(),
    idempotencyKey: 'proof-integrity-api-key-2',
  }
  assert.equal(
    (await rejection(() => createService()(request))).code,
    'PROOF_NEED_RUN_NOT_FOUND',
  )
  const changed = await rejection(() => createService({
    proofNeeds: {
      read: async () => ({
        id: proofNeedRunId,
        workspaceId,
        projectId,
        runHash: 'b'.repeat(64),
        items: [],
      }),
    },
  })(request))
  assert.equal(changed.code, 'VERSION_CONFLICT')
  assert.equal(
    changed.details.currentProofNeedRunHash,
    'b'.repeat(64),
  )
})

test('T-FR-131 create service rejects a reused key before touching the ProofNeed run', async () => {
  const lookups = []
  const service = createService({
    repository: {
      findReplay: async (input) => {
        lookups.push(input)
        return {
          id: 'proof-integrity-run-proof-integrity-api',
          requestFingerprint: 'c'.repeat(64),
          idempotencyKey: 'proof-integrity-api-key-3',
        }
      },
    },
    proofNeeds: {
      read: async () => {
        throw new assert.AssertionError({
          message:
            'a conflicting idempotency key must fail before rereading state',
        })
      },
    },
  })
  const conflict = await rejection(() => service({
    workspaceId,
    projectId,
    ...body(),
    actor: actor(),
    idempotencyKey: 'proof-integrity-api-key-3',
  }))
  assert.equal(conflict.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  assert.equal(lookups.length, 1)
  assert.equal(lookups[0].idempotencyKey, 'proof-integrity-api-key-3')
  assert.equal(lookups[0].workspaceId, workspaceId)
  assert.equal(lookups[0].projectId, projectId)
  assert.equal(lookups[0].actorClientId, 'client-proof-integrity-api')
  assert.match(lookups[0].actorContextHash, /^[a-f0-9]{64}$/)
})

test('T-FR-131 read and list services validate identity and query bounds', async () => {
  assert.equal(
    (await rejection(() => readProofIntegrityRunService({
      repository: { read: async () => null },
    })({
      workspaceId,
      projectId,
      runId: 'proof-integrity-run-missing',
    }))).code,
    'PROOF_INTEGRITY_RUN_NOT_FOUND',
  )
  const list = listProofIntegrityRunsService({
    repository: { list: async (query) => ({ runs: [], query }) },
  })
  for (const invalid of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { outcome: 'partially-approved' },
    { readyForAssembly: 'true' },
    { cursor: 'x' },
  ]) {
    assert.equal(
      (await rejection(() => list({
        workspaceId,
        projectId,
        ...invalid,
      }))).code,
      'INVALID_ARGUMENT',
      JSON.stringify(invalid),
    )
  }
  const page = await list({
    workspaceId,
    projectId,
    outcome: 'blocked',
    readyForAssembly: false,
  })
  assert.equal(page.query.limit, 20)
  assert.equal(page.query.outcome, 'blocked')
  assert.equal(page.query.readyForAssembly, false)
})

test('T-FR-131 public presentation hides idempotency internals', () => {
  const run = {
    id: 'proof-integrity-run-proof-integrity-api',
    workspaceId,
    projectId,
    summary: { fabricationSuggestionCount: 0 },
    requestFingerprint: 'd'.repeat(64),
    idempotencyKey: 'proof-integrity-api-key-4',
  }
  const presented = presentProofIntegrityRun(run)
  assert.equal('requestFingerprint' in presented, false)
  assert.equal('idempotencyKey' in presented, false)
  const page = presentProofIntegrityRunPage({
    runs: [run],
    nextCursor: 'cursor-proof-integrity-api',
  })
  assert.equal('idempotencyKey' in page.runs[0], false)
  assert.equal(page.nextCursor, 'cursor-proof-integrity-api')
  assert.equal(
    'nextCursor' in presentProofIntegrityRunPage({ runs: [] }),
    false,
  )
})

test('T-FR-131 routes authenticate, scope and translate errors without bypasses', () => {
  for (const route of [collectionRoute, itemRoute]) {
    assert.match(route, /export const dynamic = 'force-dynamic'/)
    assert.match(route, /authenticateExternalRequest\(request\)/)
    assert.match(route, /respondPublicError\(error, requestId\)/)
    assert.match(route, /publicApiHeaders\(requestId\)/)
    assert.doesNotMatch(route, /process\.env/)
  }
  assert.match(collectionRoute, /requireScope\(actor, 'projects:read'\)/)
  assert.match(collectionRoute, /requireScope\(actor, 'projects:write'\)/)
  assert.match(itemRoute, /requireScope\(actor, 'projects:read'\)/)
  assert.match(
    collectionRoute,
    /request\.headers\.get\('idempotency-key'\)/,
  )
  assert.match(
    collectionRoute,
    /status: result\.replayed \? 200 : 201/,
  )
  assert.match(collectionRoute, /parseCreateProofIntegrityBody\(rawBody\)/)
  assert.match(collectionRoute, /Request body must be valid JSON/)
  assert.match(
    collectionRoute,
    /readyForAssembly must be true or false/,
  )
})

test('T-FR-131 publishes create, read and list capabilities with public error statuses', () => {
  const capabilities = FOUNDATION_CAPABILITIES.filter(({ id }) =>
    id.startsWith('apollo.projects.proof-integrity-runs.'))
  assert.deepEqual(
    capabilities.map(({ id }) => id).sort(),
    [
      'apollo.projects.proof-integrity-runs.create',
      'apollo.projects.proof-integrity-runs.list',
      'apollo.projects.proof-integrity-runs.read',
    ],
  )
  const create = capabilities.find(({ id }) => id.endsWith('.create'))
  assert.equal(create.endpoint.method, 'POST')
  assert.equal(create.idempotency, 'required')
  assert.deepEqual(create.requiredScopes, ['projects:write'])
  assert.deepEqual(create.successStatuses, [201, 200])
  for (const capability of capabilities) {
    assert.equal(capability.authMode, 'required')
    assert.equal(capability.supportsDryRun, false)
    assert.match(
      capability.endpoint.path,
      /^\/v1\/projects\/\{projectId\}\/proof-integrity-runs/,
    )
  }
  assert.equal(PUBLIC_ERROR_CATALOG.AUTH_INVALID.status, 401)
  assert.equal(PUBLIC_ERROR_CATALOG.AUTH_SCOPE_REQUIRED.status, 403)
  assert.equal(
    PUBLIC_ERROR_CATALOG.PROOF_INTEGRITY_RUN_NOT_FOUND.status,
    404,
  )
  assert.equal(PUBLIC_ERROR_CATALOG.PROOF_NEED_RUN_NOT_FOUND.status, 404)
  assert.equal(PUBLIC_ERROR_CATALOG.VERSION_CONFLICT.status, 409)
  assert.equal(
    PUBLIC_ERROR_CATALOG.IDEMPOTENCY_PAYLOAD_MISMATCH.status,
    409,
  )
  assert.equal(PUBLIC_ERROR_CATALOG.INVALID_ARGUMENT.status, 422)
})
