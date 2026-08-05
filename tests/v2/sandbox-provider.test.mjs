import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createExternalAuditContext,
  materializeActorAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import {
  listSandboxProviderExecutionsService,
} from '../../src/v2/application/list-sandbox-provider-executions.ts'
import {
  createSandboxProviderReceipt,
} from '../../src/v2/domain/sandbox-provider-execution.ts'
import { SimulatedSandboxProvider } from '../../src/v2/infrastructure/sandbox/simulated-provider.ts'
import {
  EnvironmentProviderRuntimeRouter,
} from '../../src/v2/infrastructure/provider-runtime-router.ts'
import {
  PrismaSandboxProviderExecutionRepository,
} from '../../src/v2/infrastructure/prisma/sandbox-provider-execution-repository.ts'

test('sandbox fake is isolated, deterministic and reports simulated cost without external calls', () => {
  const provider = new SimulatedSandboxProvider()
  const input = {
    environment: 'sandbox', workspaceId: 'workspace-1', clientId: 'client-1',
    operation: 'semantic-embedding', units: 12,
    inputHash: 'a'.repeat(64), outputHash: 'b'.repeat(64),
  }
  const first = provider.execute(input); const replay = provider.execute(input)
  assert.deepEqual(first, replay)
  assert.deepEqual(first.cost, { currency: 'USD', minorUnits: 24 })
  assert.equal(first.externalCalls, 0)
  assert.equal(first.receiptHash.length, 64)
  assert.throws(
    () => createSandboxProviderReceipt({
      ...input, minorUnits: 24, receiptHash: 'c'.repeat(64),
    }),
    /receipt hash/,
  )
  assert.throws(() => provider.execute({ ...input, environment: 'production' }), /sandbox-only/)
})

function actor(overrides = {}) {
  const base = {
    clientId: 'client-admin', credentialId: 'credential-admin',
    workspaceId: 'workspace-1', environment: 'sandbox',
    scopes: new Set(['clients:admin']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active',
    ...overrides,
  }
  return {
    ...base,
    auditContext: createExternalAuditContext({
      clientId: base.clientId, credentialId: base.credentialId,
      workspaceId: base.workspaceId, environment: base.environment,
    }),
  }
}

test('sandbox execution audit is workspace-bound, redacted and cursor paginated', async () => {
  const receipts = [1, 2, 3].map((units) => ({
    receipt: createSandboxProviderReceipt({
      environment: 'sandbox', workspaceId: 'workspace-1', clientId: 'client-1',
      operation: 'semantic-embedding', units,
      inputHash: String(units).repeat(64), outputHash: String(units + 3).repeat(64),
      minorUnits: units * 2,
    }),
    createdAt: `2026-08-05T03:00:0${units}.000Z`,
  })).toReversed()
  const repository = {
    async list({ limit, after }) {
      const start = after
        ? receipts.findIndex((entry) => entry.receipt.receiptHash === after.receiptHash) + 1
        : 0
      return receipts.slice(start, start + limit)
    },
  }
  const list = listSandboxProviderExecutionsService({ repository })
  const first = await list({ actor: actor(), workspaceId: 'workspace-1', limit: 2 })
  assert.equal(first.entries.length, 2)
  assert.equal(first.entries[0].externalCalls, 0)
  assert.equal(first.entries[0].input, undefined)
  assert.ok(first.nextCursor)
  const second = await list({
    actor: actor(), workspaceId: 'workspace-1', limit: 2,
    after: first.nextCursor,
  })
  assert.equal(second.entries.length, 1)
  await assert.rejects(
    list({ actor: actor(), workspaceId: 'workspace-other' }),
    /Workspace was not found/,
  )
  await assert.rejects(
    list({ actor: actor({ scopes: new Set(['projects:read']) }), workspaceId: 'workspace-1' }),
    /lacks the required scope/,
  )
})

test('Prisma sandbox execution repository converges replay and rejects tampered rows', async () => {
  let stored
  const client = {
    v2SandboxProviderExecution: {
      async upsert({ create }) {
        stored ??= { ...create, createdAt: new Date('2026-08-05T03:00:00.000Z') }
        return stored
      },
      async findMany() { return stored ? [stored] : [] },
    },
  }
  const repository = new PrismaSandboxProviderExecutionRepository(client)
  const receipt = new SimulatedSandboxProvider().execute({
    environment: 'sandbox', workspaceId: 'workspace-1', clientId: 'client-1',
    operation: 'semantic-embedding', units: 8,
    inputHash: 'a'.repeat(64), outputHash: 'b'.repeat(64),
  })
  const first = await repository.record(receipt)
  const replay = await repository.record(receipt)
  assert.deepEqual(first, replay)
  assert.equal((await repository.list({ workspaceId: 'workspace-1', limit: 20 })).length, 1)
  stored = { ...stored, externalCalls: 1 }
  await assert.rejects(
    repository.list({ workspaceId: 'workspace-1', limit: 20 }),
    /Stored sandbox provider receipt is invalid/,
  )
})

test('authenticated sandbox routes transcription and diarization without external providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-sandbox-provider-'))
  const audioPath = join(directory, 'controlled-audio.flac')
  const receipts = []
  const repository = {
    async record(receipt) {
      receipts.push(receipt)
      return { receipt, createdAt: '2026-08-05T04:00:00.000Z' }
    },
  }
  try {
    await writeFile(audioPath, Buffer.from('controlled sandbox audio bytes'))
    const router = new EnvironmentProviderRuntimeRouter({
      GROQ_API_KEY: 'must-never-be-used-in-sandbox',
      OPENAI_API_KEY: 'must-never-be-used-in-sandbox',
      TRANSCRIBE_PROVIDER: 'unsupported-production-provider',
    }, repository)
    const audit = materializeActorAuditContext(actor())
    const transcription = router.resolveTranscription(audit)
    const transcript = await transcription.create().transcribe({
      audioPath, language: 'pt-BR',
    })
    assert.equal(transcript.provider, 'apollo-sandbox-fake')
    assert.equal(transcription.identity.version, 'sandbox-transcription/v1')
    const diarization = router.resolveDiarization(audit)
    const diarized = await diarization.create().diarize({
      audioPath, language: 'pt-BR', expectedDurationMs: 3_000,
      signal: new AbortController().signal,
    })
    assert.equal(diarized.provider.id, 'apollo-sandbox-fake')
    assert.equal(diarization.identity.version, 'sandbox-diarization/v1')
    assert.deepEqual(receipts.map((receipt) => receipt.operation), [
      'transcription', 'speaker-diarization',
    ])
    assert.ok(receipts.every((receipt) =>
      receipt.schemaVersion === 'sandbox-provider-receipt/v2' &&
      receipt.externalCalls === 0 && receipt.cost.minorUnits > 0))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('production provider routing never falls back to a sandbox fake', () => {
  const repository = { async record() { throw new Error('unreachable') } }
  const productionAudit = materializeActorAuditContext(actor({ environment: 'production' }))
  const unconfigured = new EnvironmentProviderRuntimeRouter({}, repository)
  assert.throws(
    () => unconfigured.resolveTranscription(productionAudit),
    /pricing is not configured/,
  )
  const configured = new EnvironmentProviderRuntimeRouter({
    GROQ_API_KEY: 'g'.repeat(24),
    GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR: '100',
    OPENAI_API_KEY: 'o'.repeat(24),
    OPENAI_DIARIZATION_COST_MINOR_UNITS_PER_HOUR: '200',
  }, repository)
  const transcription = configured.resolveTranscription(productionAudit)
  const diarization = configured.resolveDiarization(productionAudit)
  assert.equal(transcription.identity.provider, 'groq')
  assert.equal(diarization.identity.provider, 'openai')
  assert.notEqual(transcription.create().constructor.name, 'SandboxMediaTranscriber')
  assert.notEqual(diarization.create().constructor.name, 'SandboxSpeakerDiarizationProvider')
})
