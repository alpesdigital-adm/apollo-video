import assert from 'node:assert/strict'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import {
  readProjectPolicyOverridesService,
  setProjectPolicyOverridesService,
} from '../../src/v2/application/project-policy-overrides.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { createProjectPolicyOverrideInvalidations } from '../../src/v2/domain/project-policy-overrides-impact.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import {
  parseSetProjectPolicyOverridesBody,
  presentCurrentProjectPolicyOverrides,
  presentProjectPolicyOverridesResult,
} from '../../src/v2/public-api/project-policy-overrides-contract.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { ingestedWorld, worldActor } from './helpers/output-world.mjs'

const workspaceLogo = Object.freeze({
  assetId: 'asset-workspace-logo-1', checksum: 'a'.repeat(64), rightsId: 'rights-workspace-logo-1',
})

// The parent of every Command below is a real sealed Version3/State3 from the shared output world.
let ingestedPromise
const ingested = () => (ingestedPromise ??= ingestedWorld())

function memoryRepository(parent, options = {}) {
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
        parent,
        currentPolicySnapshot: Object.freeze({
          id: parent.version.snapshotRefs.policies,
          contentSchemaVersion: 2,
          contentHash: 'c'.repeat(64),
          content: currentPolicyContent,
        }),
        currentDurationFrames: options.durationFrames ?? JSON.parse(operationalBundlePlanV3(parent).contentJson).durationFrames,
        proxyVariantId: '9:16',
        outputReferences: options.outputReferences ?? [{
          artifactId: 'artifact-project-policy-proxy-1', kind: 'proxy', sourceVersionId: parent.version.id, variantId: '9:16',
        }],
      })
    },
    async readCurrent() { return current },
    async commitOrReplay(input) {
      const { command, requestFingerprint } = input.bundle.origin
      const policySnapshot = input.bundle.snapshots.find((snapshot) => snapshot.id === input.bundle.version.snapshotRefs.policies)
      const invalidations = createProjectPolicyOverrideInvalidations({ impact: command.payload.impact, createdAt: command.createdAt })
      const result = Object.freeze({
        command,
        version: input.bundle.version,
        policySnapshot,
        workspaceDefaults: input.workspaceDefaults,
        overrides: input.overrides,
        resolved: input.resolved,
        impact: command.payload.impact,
        invalidations,
        replayed: false,
      })
      repository.commits.push(input)
      current = Object.freeze({
        version: input.bundle.version,
        policySnapshot: Object.freeze({
          id: policySnapshot.id,
          contentSchemaVersion: policySnapshot.contentSchemaVersion,
          contentHash: policySnapshot.contentHash,
        }),
        workspaceDefaults: input.workspaceDefaults,
        overrides: input.overrides,
        resolved: input.resolved,
      })
      replays.set(command.idempotencyKey, Object.freeze({ requestFingerprint, result }))
      return result
    },
  }
  return repository
}

function service(repository) {
  const ids = { command: 0, version: 0, snapshot: 0, 'edit-plan-snapshot': 0, state: 0, materialization: 0 }
  return setProjectPolicyOverridesService({
    repository,
    createId: (kind) => `project-policy-${kind}-${++ids[kind]}`,
    createEventId: () => '00000000-0000-4000-8000-000000000210',
    clock: () => new Date('2026-10-16T12:01:00.000Z'),
  })
}

function request(parent, actor, overrides, additions = {}) {
  return {
    workspaceId: parent.version.workspaceId, projectId: parent.version.projectId,
    baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
    overrides, reason: 'Configurar somente este projeto.', actor,
    idempotencyKey: 'project-policy-overrides-request-1',
    ...additions,
  }
}

test('F1.010 disabling logo and handles creates one immutable Policy Snapshot without changing workspace defaults', async () => {
  const { parent, actor } = await ingested(), repository = memoryRepository(parent), apply = service(repository)
  const overrides = {
    logo: { mode: 'none' },
    instagramHandle: { mode: 'none' },
    professionalName: { mode: 'custom', value: 'Apollo Video' },
  }
  const result = await apply(request(parent, actor, overrides))
  const bundle = repository.commits[0].bundle, frames = JSON.parse(operationalBundlePlanV3(parent).contentJson).durationFrames

  assert.equal(result.command.type, 'set-project-policy-overrides')
  assert.equal(result.version.outputContractVersion, 3)
  assert.equal(result.version.sequence, parent.version.sequence + 1)
  assert.equal(result.version.parentVersionId, parent.version.id)
  assert.equal(result.version.snapshotRefs.policies, result.policySnapshot.id)
  assert.notEqual(result.version.snapshotRefs.policies, parent.version.snapshotRefs.policies)
  // the Policy Snapshot is the one non-output snapshot the Command replaces; everything else is inherited
  assert.deepEqual(bundle.origin.replaces, ['policies'])
  assert.equal(result.version.snapshotRefs.brief, parent.version.snapshotRefs.brief)
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.deepEqual(bundle.state.document.entries.map((entry) => entry.variantId), parent.state.document.entries.map((entry) => entry.variantId))
  assert.equal(JSON.parse(bundle.editPlanSnapshot.contentJson).durationFrames, frames)
  assert.equal(result.policySnapshot.contentSchemaVersion, 2)
  assert.deepEqual(result.resolved.logo, { value: null, origin: 'project-none' })
  assert.deepEqual(result.resolved.instagramHandle, { value: null, origin: 'project-none' })
  assert.deepEqual(result.resolved.youtubeHandle, { value: '@apollo-video', origin: 'workspace' })
  assert.deepEqual(result.resolved.professionalName, { value: 'Apollo Video', origin: 'project-custom' })
  assert.deepEqual(result.workspaceDefaults.logo, workspaceLogo)
  assert.equal(result.impact.renderBlockedUntilDirectorRun, true)
  assert.deepEqual(result.impact.requiredRecomputations, ['treatment', 'story', 'edit-plan', 'proxy', 'final'])
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: frames }])
  assert.equal(result.invalidations.length, 1)
  assert.equal(repository.commits[0].event.data.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
  assert.equal(bundle.origin.audit.credentialId, 'credential-output-http')
  const persisted = JSON.parse(result.policySnapshot.contentJson)
  assert.deepEqual(persisted.workspaceDefaults.logo, workspaceLogo)
  assert.equal(persisted.overrides.logo.mode, 'none')
  assert.equal(persisted.resolved.logo.origin, 'project-none')

  const replay = await apply(request(parent, actor, overrides))
  assert.equal(replay.replayed, true)
  assert.equal(repository.commits.length, 1)
  await assert.rejects(apply(request(parent, actor, { logo: { mode: 'inherit' } })), /different project overrides/)
})

test('F1.010 changing mode without changing the resolved value persists policy but creates zero render invalidations', async () => {
  const { parent, actor } = await ingested(), repository = memoryRepository(parent, { workspaceDefaults: {}, outputReferences: [] })
  const result = await service(repository)(request(parent, actor, { logo: { mode: 'none' } }, { idempotencyKey: 'project-policy-render-free-1' }))
  assert.equal(result.impact.renderSemanticsChanged, false)
  assert.deepEqual(result.impact.dependencyTypes, ['policy'])
  assert.deepEqual(result.impact.affectedRanges, [])
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.invalidations, [])
})

test('F1.010 service rejects stale bases, unchanged overrides, raw actors and cross-workspace actors before commit', async () => {
  const { parent, actor } = await ingested(), repository = memoryRepository(parent), apply = service(repository)
  await assert.rejects(apply(request(parent, actor, {}, { baseHash: 'd'.repeat(64) })), /stale/)
  await assert.rejects(apply(request(parent, actor, {})), /unchanged/)
  await assert.rejects(apply(request(parent, { type: 'api-client', id: 'client-output-http' }, { logo: { mode: 'none' } })), /audit context/)
  await assert.rejects(apply(request(parent, worldActor({ workspaceId: 'workspace-other-policy' }), { logo: { mode: 'none' } })),
    /does not match the workspace/)
  assert.equal(repository.commits.length, 0)
})

test('F1.010 read service and presenters expose resolved values and origins without persistence internals', async () => {
  const { parent, actor } = await ingested(), repository = memoryRepository(parent)
  const result = await service(repository)(request(parent, actor, { logo: { mode: 'none' } }))
  const current = await readProjectPolicyOverridesService({ repository })({ workspaceId: parent.version.workspaceId, projectId: parent.version.projectId })
  const presentedCurrent = presentCurrentProjectPolicyOverrides(current)
  const presentedApplied = presentProjectPolicyOverridesResult(result)
  assert.equal(presentedCurrent.resolved.logo.origin, 'project-none')
  assert.equal(presentedCurrent.version.visibleState.label, 'current')
  assert.equal('contentJson' in presentedCurrent.policySnapshot, false)
  assert.equal('payload' in presentedApplied.command, false)
  assert.equal(presentedApplied.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
})

test('F1.010 public contract, capabilities and examples are exact', () => {
  const base = { id: 'project-version-policy-base-1', baseHash: 'b'.repeat(64) }
  const body = parseSetProjectPolicyOverridesBody({
    baseVersionId: base.id,
    baseHash: base.baseHash,
    overrides: { logo: { mode: 'none' } },
  })
  assert.equal(body.overrides.logo.mode, 'none')
  assert.equal(body.overrides.youtubeHandle.mode, 'inherit')
  assert.throws(() => parseSetProjectPolicyOverridesBody({
    baseVersionId: base.id, baseHash: base.baseHash,
    overrides: {}, hidden: true,
  }), /unknown fields/)
  assert.throws(() => parseSetProjectPolicyOverridesBody({
    baseVersionId: base.id, baseHash: base.baseHash,
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
