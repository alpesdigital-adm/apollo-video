import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * FR-175 — the sidecar row against the real PostgreSQL schema.
 *
 * The host that develops this slice has no PostgreSQL, so the test skips when
 * the database is unreachable instead of failing for the wrong reason. The CI
 * compose (`npm run infra:postgres:up`) provides one, and there the test runs
 * for real: it proves the migration, the foreign keys, the lineage uniqueness
 * and the idempotency uniqueness that the in-memory pipeline proof cannot.
 */
const WORKSPACE = 'subtitle-sidecar-integration-workspace'
const PROJECT = 'subtitle-sidecar-integration-project'
const VERSION = 'subtitle-sidecar-integration-version'
const OUTPUT_ARTIFACT = 'subtitle-sidecar-integration-output'
const SIDECAR_ARTIFACT = 'subtitle-sidecar-integration-file'
const sha = (character) => character.repeat(64)
const createdAt = new Date('2026-08-14T09:00:00.000Z')

async function reachableClient() {
  if (!process.env.DATABASE_URL) return null
  const client = new PrismaClient()
  try {
    await client.$queryRaw`SELECT 1`
    return client
  } catch {
    await client.$disconnect().catch(() => undefined)
    return null
  }
}

async function cleanup(client) {
  await client.v2ProjectSubtitleSidecar.deleteMany({ where: { workspaceId: WORKSPACE } })
  await client.v2ProjectVersion.deleteMany({ where: { workspaceId: WORKSPACE } })
  await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId: WORKSPACE } })
  await client.v2Project.deleteMany({ where: { workspaceId: WORKSPACE } })
  await client.v2MediaArtifact.deleteMany({ where: { workspaceId: WORKSPACE } })
  await client.v2Workspace.deleteMany({ where: { id: WORKSPACE } })
}

async function seed(client) {
  await client.v2Workspace.create({
    data: {
      id: WORKSPACE, name: 'Subtitle sidecar integration', status: 'active',
      createdAt, updatedAt: createdAt,
    },
  })
  await client.v2Project.create({
    data: {
      id: PROJECT, workspaceId: WORKSPACE, name: 'Sidecar E2E', status: 'reviewing-proxy',
      objective: 'discovery', format: '9:16', locale: 'pt-BR',
      createdByType: 'api-client', createdById: 'client-sidecar',
      createdAt, updatedAt: createdAt,
    },
  })
  const snapshots = [
    { id: `${VERSION}-brief`, kind: 'brief' },
    { id: `${VERSION}-policies`, kind: 'policies' },
    { id: `${VERSION}-edit-plan`, kind: 'edit-plan' },
  ]
  for (const snapshot of snapshots) {
    await client.v2ProjectSnapshot.create({
      data: {
        id: snapshot.id, workspaceId: WORKSPACE, projectId: PROJECT, kind: snapshot.kind,
        schemaVersion: 1, contentJson: '{}', contentHash: sha('c'), createdAt,
      },
    })
  }
  await client.v2ProjectVersion.create({
    data: {
      id: VERSION, workspaceId: WORKSPACE, projectId: PROJECT, sequence: 1,
      briefSnapshotId: snapshots[0].id, editPlanSnapshotId: snapshots[2].id,
      policiesSnapshotId: snapshots[1].id, baseHash: sha('d'),
      createdBy: 'client-sidecar', createdAt,
    },
  })
  for (const [id, key, checksum, mediaType, container] of [
    [OUTPUT_ARTIFACT, 'proxies/output.mp4', sha('e'), 'video', 'mp4'],
    [SIDECAR_ARTIFACT, 'subtitles/sidecar.srt', sha('a'), 'data', 'srt'],
  ]) {
    await client.v2MediaArtifact.create({
      data: {
        id, workspaceId: WORKSPACE, artifactKey: key, sha256: checksum, byteSize: 106n,
        mediaType, container, status: 'available', createdAt,
      },
    })
  }
}

function record(overrides = {}) {
  return {
    id: 'subtitle-sidecar-integration-1',
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    projectVersionId: VERSION,
    variantId: '9:16',
    outputKind: 'proxy',
    outputArtifactId: OUTPUT_ARTIFACT,
    outputManifestId: 'manifest-output-1',
    outputSha256: sha('e'),
    format: 'srt',
    locale: 'pt-BR',
    artifactId: SIDECAR_ARTIFACT,
    manifestId: 'manifest-sidecar-1',
    artifactKey: 'subtitles/sidecar.srt',
    sha256: sha('a'),
    byteSize: 106,
    encoding: 'utf-8-bom',
    cueCount: 2,
    lineageHash: sha('b'),
    renderElementMapHash: sha('f'),
    renderInputHash: sha('9'),
    editPlanSnapshotId: `${VERSION}-edit-plan`,
    createdAt: createdAt.toISOString(),
    ...overrides,
  }
}

test('T-FR-175 subtitle sidecars persist with real lineage, replay and idempotency', {
  timeout: 5 * 60_000,
}, async (t) => {
  const client = await reachableClient()
  if (!client) {
    t.skip('PostgreSQL is not reachable; run npm run infra:postgres:up to execute this proof')
    return
  }
  const { PrismaSubtitleSidecarRepository } = await import(
    '../../src/v2/infrastructure/prisma/subtitle-sidecar-repository.ts'
  )
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  try {
    await cleanup(client)
    await seed(client)
    const repository = new PrismaSubtitleSidecarRepository(client)

    const first = await repository.persistOrReplay({
      record: record(), idempotencyKey: 'idem-1', requestFingerprint: sha('1'),
    })
    assert.equal(first.replayed, false)
    assert.equal(first.record.sha256, sha('a'))
    assert.equal(first.record.encoding, 'utf-8-bom')

    // Same lineage, different key: one row, replayed.
    const sameLineage = await repository.persistOrReplay({
      record: record(), idempotencyKey: 'idem-2', requestFingerprint: sha('2'),
    })
    assert.equal(sameLineage.replayed, true)
    assert.equal(sameLineage.record.id, first.record.id)

    // Same key, same fingerprint: replay.
    const replay = await repository.persistOrReplay({
      record: record(), idempotencyKey: 'idem-1', requestFingerprint: sha('1'),
    })
    assert.equal(replay.replayed, true)

    const idempotent = await repository.findIdempotent({
      workspaceId: WORKSPACE, projectId: PROJECT, idempotencyKey: 'idem-1',
    })
    assert.equal(idempotent.requestFingerprint, sha('1'))
    assert.equal(idempotent.record.id, first.record.id)

    // A different derivation is a different row, never an overwrite.
    const vtt = await repository.persistOrReplay({
      record: record({
        id: 'subtitle-sidecar-integration-2', format: 'vtt', lineageHash: sha('7'),
      }),
      idempotencyKey: 'idem-3', requestFingerprint: sha('3'),
    })
    assert.equal(vtt.replayed, false)

    const listed = await repository.list({
      workspaceId: WORKSPACE, projectId: PROJECT, limit: 50,
    })
    assert.equal(listed.length, 2)
    const onlySrt = await repository.list({
      workspaceId: WORKSPACE, projectId: PROJECT, format: 'srt', limit: 50,
    })
    assert.equal(onlySrt.length, 1)
    assert.equal(onlySrt[0].format, 'srt')

    // Another workspace never sees the rows.
    const foreign = await repository.list({
      workspaceId: 'another-workspace', projectId: PROJECT, limit: 50,
    })
    assert.equal(foreign.length, 0)

    // The row is bound to real artifacts: an unknown artifact cannot be stored.
    await assert.rejects(() => repository.persistOrReplay({
      record: record({
        id: 'subtitle-sidecar-integration-3',
        lineageHash: sha('8'),
        artifactId: 'artifact-that-does-not-exist',
      }),
      idempotencyKey: 'idem-4',
      requestFingerprint: sha('4'),
    }))

    assert.equal(
      await client.v2ProjectSubtitleSidecar.count({ where: { workspaceId: WORKSPACE } }),
      2,
    )
    assert.equal(typeof DomainError, 'function')
  } finally {
    await cleanup(client).catch(() => undefined)
    await client.$disconnect()
  }
})
