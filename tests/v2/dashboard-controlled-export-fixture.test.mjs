import assert from 'node:assert/strict'
import test from 'node:test'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { dashboardColorProbePersistenceData } from './helpers/dashboard-controlled-export-fixture.mjs'

function roundTrip(row) {
  const detection = row.state === 'ready'
    ? { state: row.state, metadata: JSON.parse(row.metadataJson), pixelFormat: row.pixelFormat, hdrMode: row.hdrMode }
    : { state: row.state, ...(row.pixelFormat === null ? {} : { pixelFormat: row.pixelFormat }), reasons: JSON.parse(row.reasonsJson) }
  return createMediaColorProbe({ id: row.id, workspaceId: row.workspaceId, artifactId: row.artifactId, manifestId: row.manifestId,
    detection, producer: { provider: row.producerProvider, version: row.producerVersion, binaryDigest: row.producerBinaryDigest },
    createdAt: row.createdAt.toISOString() })
}
for (const detection of [
  { state: 'ready', metadata: { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 },
    pixelFormat: 'yuv420p', hdrMode: 'sdr' },
  { state: 'unavailable', reasons: ['missing-color-transfer'] },
]) test(`W35 controlled fixture persists ${detection.state} color detection without losing its domain seal`, () => {
  const probe = createMediaColorProbe({ id: 'controlled-color-probe', workspaceId: 'controlled-workspace', artifactId: 'controlled-master',
    manifestId: 'controlled-manifest', detection, producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: 'a'.repeat(64) },
    createdAt: '2026-10-11T12:00:00.000Z' })
  assert.equal(probe.state, undefined, 'Detection fields are not top-level domain properties')
  const row = dashboardColorProbePersistenceData(probe, stableSerialize)
  for (const [key, value] of Object.entries(row)) assert.notEqual(value, undefined, `${key} must be SQL-ready`)
  assert.deepEqual(roundTrip(row), probe)
  assert.equal(roundTrip(row).probeHash, row.probeHash)
  if (detection.state === 'ready') {
    assert.equal(row.reasonsJson, '[]')
    const corrupted = roundTrip({ ...row, metadataJson: stableSerialize({ ...detection.metadata, range: 'full' }) })
    assert.notEqual(corrupted.probeHash, row.probeHash, 'The seal detects stored metadata changes')
  } else {
    assert.equal(row.metadataJson, 'null')
    assert.equal(row.pixelFormat, null)
    assert.equal(row.hdrMode, null)
  }
})
