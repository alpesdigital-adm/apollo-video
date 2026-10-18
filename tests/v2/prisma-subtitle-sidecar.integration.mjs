import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
 *
 * The project is the sealed world the product builds (creation Command, then one explicit
 * output variant: see helpers/pg-output-world.mjs). Sealed rows are append-only, so every
 * identity is unique to this run and nothing is cleaned up.
 */
const sha = (character) => character.repeat(64)
const createdAt = new Date('2026-08-14T09:00:00.000Z')

// The generated V2 client reads V2_DATABASE_URL, so that is the variable that says a database is configured.
async function reachableClient() {
  if (!process.env.V2_DATABASE_URL) return null
  const client = new PrismaClient()
  try {
    await client.$queryRaw`SELECT 1`
    return client
  } catch {
    await client.$disconnect().catch(() => undefined)
    return null
  }
}

function identities() {
  const run = randomUUID().replaceAll('-', '').slice(0, 12)
  return Object.freeze({
    run,
    workspace: `subtitle-sidecar-int-${run}-workspace`,
    project: `subtitle-sidecar-int-${run}-project`,
    client: `subtitle-sidecar-int-${run}-client`,
    outputArtifact: `subtitle-sidecar-int-${run}-output`,
    sidecarArtifact: `subtitle-sidecar-int-${run}-file`,
  })
}

async function seed(client, ids) {
  const { seedReviewProject } = await import('./helpers/review-edit-world.mjs')
  const { testActor } = await import('./helpers/pg-output-world.mjs')
  const actor = testActor({ workspaceId: ids.workspace, clientId: ids.client, credentialId: `${ids.client}-credential`,
    environment: 'production' })
  const world = await seedReviewProject(client, { workspaceId: ids.workspace, actor, prefix: `subtitle-sidecar-${ids.run}`,
    ids: { project: ids.project }, name: 'Sidecar E2E', aspectRatio: '9:16', status: 'reviewing-proxy', at: () => createdAt })
  for (const [id, key, checksum, mediaType, container] of [
    [ids.outputArtifact, 'proxies/output.mp4', sha('e'), 'video', 'mp4'],
    [ids.sidecarArtifact, 'subtitles/sidecar.srt', sha('a'), 'data', 'srt'],
  ]) {
    await client.v2MediaArtifact.create({
      data: {
        id, workspaceId: ids.workspace, artifactKey: `${ids.run}/${key}`, sha256: checksum, byteSize: 106n,
        mediaType, container, status: 'available', createdAt,
      },
    })
  }
  return world
}

function record(ids, world, overrides = {}) {
  return {
    id: `subtitle-sidecar-integration-${ids.run}-1`,
    workspaceId: ids.workspace,
    projectId: ids.project,
    projectVersionId: world.head.version.id,
    variantId: '9:16',
    outputKind: 'proxy',
    outputArtifactId: ids.outputArtifact,
    outputManifestId: 'manifest-output-1',
    outputSha256: sha('e'),
    format: 'srt',
    locale: 'pt-BR',
    artifactId: ids.sidecarArtifact,
    manifestId: 'manifest-sidecar-1',
    artifactKey: `${ids.run}/subtitles/sidecar.srt`,
    sha256: sha('a'),
    byteSize: 106,
    encoding: 'utf-8-bom',
    cueCount: 2,
    lineageHash: sha('b'),
    renderElementMapHash: sha('f'),
    renderInputHash: sha('9'),
    editPlanSnapshotId: world.head.editPlanSnapshot.id,
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
  const ids = identities()
  try {
    const world = await seed(client, ids)
    const repository = new PrismaSubtitleSidecarRepository(client)
    const base = (overrides) => record(ids, world, overrides)

    const first = await repository.persistOrReplay({
      record: base(), idempotencyKey: `${ids.run}-idem-1`, requestFingerprint: sha('1'),
    })
    assert.equal(first.replayed, false)
    assert.equal(first.record.sha256, sha('a'))
    assert.equal(first.record.encoding, 'utf-8-bom')

    // Same lineage, different key: one row, replayed.
    const sameLineage = await repository.persistOrReplay({
      record: base(), idempotencyKey: `${ids.run}-idem-2`, requestFingerprint: sha('2'),
    })
    assert.equal(sameLineage.replayed, true)
    assert.equal(sameLineage.record.id, first.record.id)

    // Same key, same fingerprint: replay.
    const replay = await repository.persistOrReplay({
      record: base(), idempotencyKey: `${ids.run}-idem-1`, requestFingerprint: sha('1'),
    })
    assert.equal(replay.replayed, true)

    const idempotent = await repository.findIdempotent({
      workspaceId: ids.workspace, projectId: ids.project, idempotencyKey: `${ids.run}-idem-1`,
    })
    assert.equal(idempotent.requestFingerprint, sha('1'))
    assert.equal(idempotent.record.id, first.record.id)

    // A different derivation is a different row, never an overwrite.
    const vtt = await repository.persistOrReplay({
      record: base({
        id: `subtitle-sidecar-integration-${ids.run}-2`, format: 'vtt', lineageHash: sha('7'),
      }),
      idempotencyKey: `${ids.run}-idem-3`, requestFingerprint: sha('3'),
    })
    assert.equal(vtt.replayed, false)

    const listed = await repository.list({
      workspaceId: ids.workspace, projectId: ids.project, limit: 50,
    })
    assert.equal(listed.length, 2)
    const onlySrt = await repository.list({
      workspaceId: ids.workspace, projectId: ids.project, format: 'srt', limit: 50,
    })
    assert.equal(onlySrt.length, 1)
    assert.equal(onlySrt[0].format, 'srt')

    // Another workspace never sees the rows.
    const foreign = await repository.list({
      workspaceId: 'another-workspace', projectId: ids.project, limit: 50,
    })
    assert.equal(foreign.length, 0)

    // The row is bound to real artifacts: an unknown artifact cannot be stored.
    await assert.rejects(() => repository.persistOrReplay({
      record: base({
        id: `subtitle-sidecar-integration-${ids.run}-3`,
        lineageHash: sha('8'),
        artifactId: 'artifact-that-does-not-exist',
      }),
      idempotencyKey: `${ids.run}-idem-4`,
      requestFingerprint: sha('4'),
    }))

    assert.equal(
      await client.v2ProjectSubtitleSidecar.count({ where: { workspaceId: ids.workspace } }),
      2,
    )
    assert.equal(typeof DomainError, 'function')
  } finally {
    await client.$disconnect()
  }
})
