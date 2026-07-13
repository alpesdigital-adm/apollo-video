import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  OUTPUT_ASPECT_RATIOS,
  OUTPUT_PRESETS,
  createOutputSpec,
} from '../../src/v2/domain/output-spec.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import {
  assertMediaArtifactManifest,
  createMediaArtifactManifest,
} from '../../src/v2/domain/media-artifact.ts'
import {
  assertCommandMatchesVersion,
  createEditCommand,
  validateEditScope,
} from '../../src/v2/domain/edit-command.ts'
import {
  calculateVersionHash,
  stableSerialize,
} from '../../src/v2/application/version-hash.ts'

function expectDomainError(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code)
}

test('all required output presets satisfy the v2 contract', () => {
  for (const ratio of OUTPUT_ASPECT_RATIOS) {
    const spec = createOutputSpec({
      ...OUTPUT_PRESETS[ratio],
      safeArea: { ...OUTPUT_PRESETS[ratio].safeArea },
    })

    assert.equal(spec.aspectRatio, ratio)
    assert.equal(spec.schemaVersion, 1)
    assert.ok(Object.isFrozen(spec))
    assert.ok(Object.isFrozen(spec.safeArea))
  }
})
test('output dimensions must match the declared ratio', () => {
  expectDomainError(
    () =>
      createOutputSpec({
        ...OUTPUT_PRESETS['9:16'],
        width: 1920,
        height: 1080,
      }),
    'INVALID_OUTPUT_SPEC',
  )
})

test('safe areas are normalized and cannot overlap the canvas', () => {
  expectDomainError(
    () =>
      createOutputSpec({
        ...OUTPUT_PRESETS['1:1'],
        safeArea: { top: 0.5, right: 0.05, bottom: 0.05, left: 0.05 },
      }),
    'INVALID_OUTPUT_SPEC',
  )
})

test('project versions are immutable and require a parent after sequence one', () => {
  const first = createProjectVersion({
    id: 'version-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sequence: 1,
    snapshotRefs: { editPlan: 'edit-plan-1', policies: 'policy-1' },
    baseHash: 'hash-1',
    createdBy: 'user-1',
    createdAt: '2026-07-12T12:00:00.000Z',
  })

  assert.equal(first.schemaVersion, 1)
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.snapshotRefs))

  expectDomainError(
    () =>
      createProjectVersion({
        ...first,
        id: 'version-2',
        sequence: 2,
        baseHash: 'hash-2',
      }),
    'INVALID_PROJECT_VERSION',
  )
})

test('command scopes reject empty and contradictory targets', () => {
  expectDomainError(() => validateEditScope({}), 'INVALID_SCOPE')
  expectDomainError(
    () => validateEditScope({ applyToAllFormats: true, outputSpecIds: ['output-1'] }),
    'INVALID_SCOPE',
  )
  expectDomainError(
    () => validateEditScope({ project: true, clipIds: ['clip-1'] }),
    'INVALID_SCOPE',
  )
})

test('commands accept the exact base and reject stale versions', () => {
  const current = createProjectVersion({
    id: 'version-2',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sequence: 2,
    parentVersionId: 'version-1',
    snapshotRefs: { editPlan: 'edit-plan-2', policies: 'policy-1' },
    baseHash: 'hash-current',
    createdBy: 'user-1',
    createdAt: '2026-07-12T12:01:00.000Z',
  })
  const command = createEditCommand({
    id: 'command-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    baseVersionId: current.id,
    baseHash: current.baseHash,
    author: { type: 'api-client', id: 'client-1' },
    type: 'SetOutputSpec',
    scope: { outputSpecIds: ['output-1'] },
    payload: { fps: 30 },
    idempotencyKey: 'request-1',
    createdAt: '2026-07-12T12:02:00.000Z',
  })

  assert.doesNotThrow(() => assertCommandMatchesVersion(command, current))
  expectDomainError(
    () =>
      assertCommandMatchesVersion(
        { ...command, baseVersionId: 'version-1', baseHash: 'hash-old' },
        current,
      ),
    'VERSION_CONFLICT',
  )
})

test('version hashing is deterministic for object key order', () => {
  const left = { z: 1, nested: { b: true, a: 'value' }, list: [2, 1] }
  const right = { list: [2, 1], nested: { a: 'value', b: true }, z: 1 }

  assert.equal(stableSerialize(left), stableSerialize(right))
  assert.equal(calculateVersionHash(left), calculateVersionHash(right))
  assert.notEqual(calculateVersionHash(left), calculateVersionHash({ ...right, z: 2 }))
})

test('media artifact manifest is deterministic and excludes raw recipe parameters', () => {
  const base = {
    artifactKey: 'workspaces/ws-1/artifacts/normalized.mp4',
    artifactSha256: 'a'.repeat(64),
    byteSize: 1234,
    mediaType: 'video',
    container: 'mp4',
    sources: [
      {
        artifactKey: 'workspaces/ws-1/masters/source.mp4',
        sha256: 'b'.repeat(64),
        role: 'primary',
      },
    ],
    probe: { width: 1080, height: 1920, duration: 30, fps: 30 },
  }
  const left = createMediaArtifactManifest({
    ...base,
    recipe: {
      id: 'normalize-video',
      version: 'v1',
      parameters: { crf: 23, scale: { height: 1920, width: 1080 }, privatePrompt: 'secret' },
    },
  })
  const right = createMediaArtifactManifest({
    ...base,
    recipe: {
      id: 'normalize-video',
      version: 'v1',
      parameters: { privatePrompt: 'secret', scale: { width: 1080, height: 1920 }, crf: 23 },
    },
  })

  assert.deepEqual(left, right)
  assert.doesNotThrow(() => assertMediaArtifactManifest(left))
  assert.equal(left.schemaVersion, 'media-artifact-manifest/v1')
  assert.equal(left.manifestHash.length, 64)
  assert.equal(JSON.stringify(left).includes('secret'), false)
  assert.notEqual(
    left.manifestHash,
    createMediaArtifactManifest({
      ...base,
      recipe: { id: 'normalize-video', version: 'v1', parameters: { crf: 24 } },
    }).manifestHash,
  )
  expectDomainError(
    () =>
      assertMediaArtifactManifest({
        ...left,
        artifact: { ...left.artifact, byteSize: left.artifact.byteSize + 1 },
      }),
    'INVALID_MEDIA_ARTIFACT',
  )
})

test('media artifact manifest rejects absolute and traversal keys', () => {
  const input = {
    artifactSha256: 'a'.repeat(64),
    byteSize: 1,
    mediaType: 'video',
    container: 'mp4',
    recipe: { id: 'normalize-video', version: 'v1', parameters: {} },
  }

  for (const artifactKey of ['/tmp/output.mp4', 'C:\\output.mp4', '../output.mp4']) {
    expectDomainError(
      () => createMediaArtifactManifest({ ...input, artifactKey }),
      'INVALID_MEDIA_ARTIFACT',
    )
  }

  expectDomainError(
    () =>
      createMediaArtifactManifest({
        ...input,
        artifactKey: 'workspaces/ws/artifacts/output.mp4',
        sources: [
          {
            artifactKey: 'workspaces/ws/artifacts/output.mp4',
            sha256: 'b'.repeat(64),
            role: 'primary',
          },
        ],
      }),
    'INVALID_MEDIA_ARTIFACT',
  )
})
