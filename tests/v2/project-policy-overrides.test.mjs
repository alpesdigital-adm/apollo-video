import assert from 'node:assert/strict'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  readProjectPolicyOverridesService,
  setProjectPolicyOverridesService,
} from '../../src/v2/application/project-policy-overrides.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createProjectPolicyOverrideInvalidations } from '../../src/v2/domain/project-policy-overrides-impact.ts'
import { createProjectSnapshot } from '../../src/v2/domain/project-snapshot.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import {
  parseSetProjectPolicyOverridesBody,
  presentCurrentProjectPolicyOverrides,
  presentProjectPolicyOverridesResult,
} from '../../src/v2/public-api/project-policy-overrides-contract.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const workspaceId = 'workspace-project-policy'
const projectId = 'project-policy-test'
const createdAt = '2026-08-07T12:00:00.000Z'
const workspaceLogo = Object.freeze({
  assetId: 'asset-workspace-logo-1', checksum: 'a'.repeat(64), rightsId: 'rights-workspace-logo-1',
})

function actor(credentialId = 'credential-project-policy') {
  const auditContext = createExternalAuditContext({
    clientId: 'client-project-policy', credentialId, workspaceId, environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:read', 'projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

function baseVersion() {
  return createProjectVersion({
    id: 'project-version-policy-base-1', workspaceId, projectId, sequence: 1,
    snapshotRefs: { brief: 'brief-snapshot-policy-1', editPlan: 'edit-plan-snapshot-policy-1', policies: 'policies-snapshot-policy-1' },
    baseHash: 'b'.repeat(64), createdBy: 'client-project-policy', createdAt,
  })
}

function legacyPolicySnapshot() {
  const content = Object.freeze({
    schemaVersion: 1,
    workspaceId,
    state: 'configured',
    brandKitMode: 'inherit',
    guardrails: ['Nunca cobrir rosto ou olhos com legenda.'],
    createdAt,
  })
  return createProjectSnapshot({
    id: 'policies-snapshot-policy-1', workspaceId, projectId, kind: 'policies',
    contentSchemaVersion: 1, contentJson: stableSerialize(content),
    contentHash: 'c'.repeat(64), createdAt,
  })
}

function memoryRepository(options = {}) {
  const base = baseVersion()
  const policySnapshot = legacyPolicySnapshot()
  const workspaceDefaults = options.workspaceDefaults ?? {
    logo: workspaceLogo,
    instagramHandle: '@apollo.workspace',
    youtubeHandle: '@apollo-video',
    guardrails: ['Nunca cobrir rosto ou olhos com legenda.'],
  }
  const currentPolicyContent = Object.freeze({
    schemaVersion: 2,
    workspaceDefaults,
    overrides: {},
    resolved: {},
  })
  const replays = new Map()
  let current = null
  const repository = {
    commits: [],
    async findIdempotent({ idempotencyKey }) { return replays.get(idempotencyKey) ?? null },
    async readContext() {
      return Object.freeze({
        currentVersion: base,
        currentPolicySnapshot: Object.freeze({
          id: policySnapshot.id,
          contentSchemaVersion: 2,
          contentHash: policySnapshot.contentHash,
          content: currentPolicyContent,
        }),
        currentDurationFrames: options.durationFrames ?? 180,
        proxyVariantId: '9:16',
        outputReferences: options.outputReferences ?? [{
          artifactId: 'artifact-project-policy-proxy-1', kind: 'proxy', sourceVersionId: base.id, variantId: '9:16',
        }],
      })
    },
    async readCurrent() { return current },
    async commitOrReplay(bundle) {
      const invalidations = createProjectPolicyOverrideInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
      const result = Object.freeze({
        command: bundle.command,
        version: bundle.version,
        policySnapshot: bundle.policySnapshot,
        workspaceDefaults: bundle.workspaceDefaults,
        overrides: bundle.overrides,
        resolved: bundle.resolved,
        impact: bundle.command.payload.impact,
        invalidations,
        replayed: false,
      })
      repository.commits.push(bundle)
      current = Object.freeze({
        version: bundle.version,
        policySnapshot: Object.freeze({
          id: bundle.policySnapshot.id,
          contentSchemaVersion: bundle.policySnapshot.contentSchemaVersion,
          contentHash: bundle.policySnapshot.contentHash,
        }),
        workspaceDefaults: bundle.workspaceDefaults,
        overrides: bundle.overrides,
        resolved: bundle.resolved,
      })
      replays.set(bundle.command.idempotencyKey, Object.freeze({ requestFingerprint: bundle.requestFingerprint, result }))
      return result
    },
  }
  return repository
}

function service(repository) {
  const ids = { command: 0, version: 0, snapshot: 0 }
  return setProjectPolicyOverridesService({
    repository,
    createId: (kind) => `project-policy-${kind}-${++ids[kind]}`,
    createEventId: () => '00000000-0000-4000-8000-000000000210',
    clock: () => new Date('2026-08-07T12:01:00.000Z'),
  })
}

function request(overrides, additions = {}) {
  const base = baseVersion()
  return {
    workspaceId, projectId, baseVersionId: base.id, baseHash: base.baseHash,
    overrides, reason: 'Configurar somente este projeto.', actor: actor(),
    idempotencyKey: 'project-policy-overrides-request-1',
    ...additions,
  }
}

test('F1.010 disabling logo and handles creates one immutable Policy Snapshot without changing workspace defaults', async () => {
  const repository = memoryRepository()
  const apply = service(repository)
  const result = await apply(request({
    logo: { mode: 'none' },
    instagramHandle: { mode: 'none' },
    professionalName: { mode: 'custom', value: 'Apollo Video' },
  }))

  assert.equal(result.command.type, 'set-project-policy-overrides')
  assert.equal(result.version.sequence, 2)
  assert.equal(result.version.parentVersionId, baseVersion().id)
  assert.equal(result.version.snapshotRefs.policies, result.policySnapshot.id)
  assert.notEqual(result.version.snapshotRefs.policies, baseVersion().snapshotRefs.policies)
  assert.equal(result.policySnapshot.contentSchemaVersion, 2)
  assert.deepEqual(result.resolved.logo, { value: null, origin: 'project-none' })
  assert.deepEqual(result.resolved.instagramHandle, { value: null, origin: 'project-none' })
  assert.deepEqual(result.resolved.youtubeHandle, { value: '@apollo-video', origin: 'workspace' })
  assert.deepEqual(result.resolved.professionalName, { value: 'Apollo Video', origin: 'project-custom' })
  assert.deepEqual(result.workspaceDefaults.logo, workspaceLogo)
  assert.equal(result.impact.renderBlockedUntilDirectorRun, true)
  assert.deepEqual(result.impact.requiredRecomputations, ['treatment', 'story', 'edit-plan', 'proxy', 'final'])
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 180 }])
  assert.equal(result.invalidations.length, 1)
  assert.equal(repository.commits[0].event.data.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
  assert.equal(repository.commits[0].authenticationAudit.credentialId, 'credential-project-policy')
  const persisted = JSON.parse(result.policySnapshot.contentJson)
  assert.deepEqual(persisted.workspaceDefaults.logo, workspaceLogo)
  assert.equal(persisted.overrides.logo.mode, 'none')
  assert.equal(persisted.resolved.logo.origin, 'project-none')

  const replay = await apply(request({
    logo: { mode: 'none' }, instagramHandle: { mode: 'none' }, professionalName: { mode: 'custom', value: 'Apollo Video' },
  }))
  assert.equal(replay.replayed, true)
  assert.equal(repository.commits.length, 1)
  await assert.rejects(apply(request({ logo: { mode: 'inherit' } })), /different project overrides/)
})

test('F1.010 changing mode without changing the resolved value persists policy but creates zero render invalidations', async () => {
  const repository = memoryRepository({ workspaceDefaults: {}, outputReferences: [] })
  const result = await service(repository)(request({ logo: { mode: 'none' } }, { idempotencyKey: 'project-policy-render-free-1' }))
  assert.equal(result.impact.renderSemanticsChanged, false)
  assert.deepEqual(result.impact.dependencyTypes, ['policy'])
  assert.deepEqual(result.impact.affectedRanges, [])
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.invalidations, [])
})

test('F1.010 service rejects stale bases, unchanged overrides, raw actors and cross-workspace actors before commit', async () => {
  const repository = memoryRepository()
  const apply = service(repository)
  await assert.rejects(apply(request({}, { baseHash: 'd'.repeat(64) })), /stale/)
  await assert.rejects(apply(request({})), /unchanged/)
  await assert.rejects(apply(request({ logo: { mode: 'none' } }, { actor: { type: 'api-client', id: 'client-project-policy' } })), /audit context/)
  await assert.rejects(apply(request({ logo: { mode: 'none' } }, {
    workspaceId: 'workspace-other-policy', actor: actor(),
  })), /does not match the workspace/)
  assert.equal(repository.commits.length, 0)
})

test('F1.010 read service and presenters expose resolved values and origins without persistence internals', async () => {
  const repository = memoryRepository()
  const result = await service(repository)(request({ logo: { mode: 'none' } }))
  const current = await readProjectPolicyOverridesService({ repository })({ workspaceId, projectId })
  const presentedCurrent = presentCurrentProjectPolicyOverrides(current)
  const presentedApplied = presentProjectPolicyOverridesResult(result)
  assert.equal(presentedCurrent.resolved.logo.origin, 'project-none')
  assert.equal(presentedCurrent.version.visibleState.label, 'current')
  assert.equal('contentJson' in presentedCurrent.policySnapshot, false)
  assert.equal('payload' in presentedApplied.command, false)
  assert.equal(presentedApplied.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
})

test('F1.010 public contract, capabilities and examples are exact', () => {
  const body = parseSetProjectPolicyOverridesBody({
    baseVersionId: baseVersion().id,
    baseHash: baseVersion().baseHash,
    overrides: { logo: { mode: 'none' } },
  })
  assert.equal(body.overrides.logo.mode, 'none')
  assert.equal(body.overrides.youtubeHandle.mode, 'inherit')
  assert.throws(() => parseSetProjectPolicyOverridesBody({
    baseVersionId: baseVersion().id, baseHash: baseVersion().baseHash,
    overrides: {}, hidden: true,
  }), /unknown fields/)
  assert.throws(() => parseSetProjectPolicyOverridesBody({
    baseVersionId: baseVersion().id, baseHash: baseVersion().baseHash,
    overrides: { watermark: { mode: 'none' } },
  }), /Unsupported override/)

  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
  assert.equal(capabilities.get('apollo.projects.policy-overrides.read').endpoint.method, 'GET')
  assert.equal(capabilities.get('apollo.projects.policy-overrides.set').endpoint.method, 'POST')
  assert.equal(capabilities.get('apollo.projects.policy-overrides.set').idempotency, 'required')
  for (const ref of [
    'apollo://schemas/project-policy-overrides-impact/v1',
    'apollo://schemas/project-policy-overrides-set-request/v1',
    'apollo://schemas/project-policy-overrides-response/v1',
    'apollo://schemas/project-policy-overrides-applied/v1',
  ]) {
    const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    const validate = ajv.compile(getPublicSchema(ref).schema)
    for (const example of publicSchemaExamples(ref)) {
      assert.equal(validate(example), true, `${ref}: ${JSON.stringify(validate.errors)}`)
    }
  }
})
