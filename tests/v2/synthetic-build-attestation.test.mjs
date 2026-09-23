import assert from 'node:assert/strict'
import test from 'node:test'

import { createSyntheticBuildAttestationService } from '../../src/v2/application/create-synthetic-build-attestation.ts'
import {
  calculateSyntheticBuildIdentityHash,
  calculateSyntheticBuildAttestationHash,
  SYNTHETIC_BUILD_CHECKS,
} from '../../src/v2/domain/synthetic-build-attestation.ts'

const hash = (character) => character.repeat(64)

function runner(overrides = {}) {
  return {
    async run() {
      return {
        identity: {
          commitSha: 'a'.repeat(40),
          treeHash: hash('b'),
          contractGraphHash: hash('c'),
          toolchainHash: hash('d'),
          renderBundleHash: hash('8'),
        },
        checks: SYNTHETIC_BUILD_CHECKS.map((check, index) => ({
          ...check,
          exitCode: 0,
          logHash: hash(String(index + 1)),
          startedAt: `2026-09-23T10:00:0${index}.000Z`,
          completedAt: `2026-09-23T10:00:0${index + 1}.000Z`,
        })),
        startedAt: '2026-09-23T10:00:00.000Z',
        completedAt: '2026-09-23T10:00:05.000Z',
        ...overrides,
      }
    },
  }
}

function repository(overrides = {}) {
  const records = []
  return {
    records,
    async findReplay() { return null },
    async readBinding() {
      const runtimeIdentity = {
        commitSha: 'a'.repeat(40),
        treeHash: hash('b'),
        contractGraphHash: hash('c'),
        toolchainHash: hash('d'),
        renderBundleHash: hash('8'),
      }
      return {
        workspaceId: 'workspace-attestation',
        projectId: 'project-attestation',
        projectVersionId: 'version-attestation',
        projectVersionHash: hash('e'),
        productionRunId: 'production-run-attestation',
        publicOperationId: 'operation-attestation',
        planSnapshotId: 'snapshot-attestation',
        planSnapshotHash: hash('f'),
        renderManifestId: 'manifest-attestation',
        renderManifestHash: hash('1'),
        runtimeCommitSha: 'a'.repeat(40),
        runtimeTreeHash: hash('b'),
        runtimeContractGraphHash: hash('c'),
        runtimeToolchainHash: hash('d'),
        runtimeRenderBundleHash: hash('8'),
        runtimeIdentityHash: calculateSyntheticBuildIdentityHash(runtimeIdentity),
      }
    },
    async create(input) {
      const record = { ...input, attestation: input.attestation }
      records.push(record)
      return { record, replayed: false }
    },
    async read() { return null },
    ...overrides,
  }
}

const request = {
  workspaceId: 'workspace-attestation',
  projectId: 'project-attestation',
  projectVersionId: 'version-attestation',
  productionRunId: 'production-run-attestation',
  publicOperationId: 'operation-attestation',
  renderManifestId: 'manifest-attestation',
  idempotencyKey: 'attestation-request-1',
}

test('T-F3-GATE build writer derives hashes and fixed checks from server binding', async () => {
  const store = repository()
  const result = await createSyntheticBuildAttestationService({
    repository: store,
    runner: runner(),
    createId: () => 'build-attestation-1',
  })(request)
  assert.equal(result.replayed, false)
  assert.equal(result.record.attestation.checks.length, 4)
  assert.deepEqual(
    result.record.attestation.checks.map(({ code, command }) => ({ code, command })),
    SYNTHETIC_BUILD_CHECKS,
  )
  const { attestationHash, ...content } = result.record.attestation
  assert.equal(attestationHash, calculateSyntheticBuildAttestationHash(content))
})

test('T-F3-GATE build writer rejects runtime identity drift before persistence', async () => {
  const store = repository()
  await assert.rejects(
    createSyntheticBuildAttestationService({
      repository: store,
      runner: runner({
        identity: {
          commitSha: '9'.repeat(40),
          treeHash: hash('b'),
          contractGraphHash: hash('c'),
          toolchainHash: hash('d'),
          renderBundleHash: hash('8'),
        },
      }),
      createId: () => 'build-attestation-drift',
    })(request),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(store.records.length, 0)
})

test('T-F3-GATE build writer rejects tree and toolchain drift independently', async () => {
  for (const field of ['treeHash', 'toolchainHash']) {
    const identity = {
      commitSha: 'a'.repeat(40),
      treeHash: hash('b'),
      contractGraphHash: hash('c'),
      toolchainHash: hash('d'),
      renderBundleHash: hash('8'),
      [field]: hash('9'),
    }
    const store = repository()
    await assert.rejects(
      createSyntheticBuildAttestationService({
        repository: store,
        runner: runner({ identity }),
        createId: () => `build-attestation-${field}`,
      })(request),
      (error) => error.code === 'VERSION_CONFLICT',
    )
    assert.equal(store.records.length, 0)
  }
})

test('T-F3-GATE build writer replays before executing checks and fences payload drift', async () => {
  const firstStore = repository()
  const service = createSyntheticBuildAttestationService({
    repository: firstStore,
    runner: runner(),
    createId: () => 'build-attestation-replay',
  })
  const first = await service(request)
  let ran = false
  const replayStore = repository({
    async findReplay() { return first.record },
    async readBinding() { assert.fail('binding must not be read on replay') },
  })
  const replay = await createSyntheticBuildAttestationService({
    repository: replayStore,
    runner: { async run() { ran = true; assert.fail('checks must not run on replay') } },
    createId: () => 'unused-attestation-id',
  })(request)
  assert.equal(replay.replayed, true)
  assert.equal(ran, false)
  await assert.rejects(
    createSyntheticBuildAttestationService({
      repository: replayStore,
      runner: runner(),
      createId: () => 'unused-attestation-id',
    })({ ...request, renderManifestId: 'another-manifest' }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})
