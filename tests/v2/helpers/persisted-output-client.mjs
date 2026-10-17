// A raw-query double that serves sealed output bundles the way the PostgreSQL rows would, so the
// repositories' readers (readPersistedOperationalOutputBundleV3 and everything built on it) run for real
// without a database. It answers only the reads the bundle reader performs; the database guards it would
// call (`w66_assert_*`) are not emulated, so anything it serves has been admitted only by the domain
// builders. A query it does not know fails loudly instead of returning an empty set.
import { createHash } from 'node:crypto'
import { stableSerialize } from '../../../src/v2/domain/canonical-hash.ts'
import { serializeOutputCanonicalJson } from '../../../src/v2/domain/output-canonical-policy.ts'

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

export function persistedOutputQueries(bundles) {
  const byVersion = new Map()
  const receipts = new Map()
  for (const bundle of bundles) {
    byVersion.set(bundle.version.id, bundle)
    if (bundle.schemaVersion !== 'operational-output-version-bundle/v3') continue
    for (const entry of bundle.state.document.entries) {
      if (entry.consumption.status !== 'materialized') continue
      for (const normalization of entry.consumption.materialization.document.normalizations) receipts.set(normalization.document.id, normalization)
    }
  }
  return async function queryRawUnsafe(sql, ...params) {
    if (sql.startsWith('SELECT "outputContractVersion"')) {
      const [versionId, projectId, workspaceId] = params, bundle = byVersion.get(versionId)
      if (!bundle || bundle.version.projectId !== projectId || bundle.version.workspaceId !== workspaceId) return []
      return [{ outputContractVersion: bundle.version.outputContractVersion, outputStateId: bundle.version.outputStateId,
        outputStateHash: bundle.version.outputStateHash, baseHash: bundle.version.baseHash, outputBaseHashJson: bundle.outputBaseHashJson,
        outputVersionJson: serializeOutputCanonicalJson(bundle.version) }]
    }
    if (/FROM w66_assert_(operational_state_v3|creation_anchor_v3|normalization_v3)\(/.test(sql)) return [{ verified: 1 }]
    if (sql.startsWith('SELECT "bundleJson"')) {
      const [versionId] = params, bundle = byVersion.get(versionId)
      if (!bundle || bundle.schemaVersion !== 'operational-output-version-bundle/v3') return []
      const origin = JSON.parse(stableSerialize(bundle.origin)), body = { ...bundle, origin }
      const bundleJson = serializeOutputCanonicalJson(body), originJson = serializeOutputCanonicalJson(origin)
      return [{ bundleJson, bundleHash: sha(bundleJson), originJson, originHash: sha(originJson) }]
    }
    if (sql.startsWith('SELECT c."commandJson",s."stateJson"')) {
      const [stateId, versionId] = params, bundle = byVersion.get(versionId)
      if (!bundle || bundle.schemaVersion !== 'project-creation-output-bundle/v2' || bundle.state.document.id !== stateId) return []
      return [{ commandJson: serializeOutputCanonicalJson(bundle.command), stateJson: serializeOutputCanonicalJson(bundle.state.document), stateHash: bundle.state.stateHash }]
    }
    if (sql.startsWith('SELECT "sourceArtifactId","derivativeArtifactId" FROM output_normalization_receipts')) {
      return params.slice(2).flatMap((id) => receipts.has(id)
        ? [{ sourceArtifactId: receipts.get(id).document.source.artifactId, derivativeArtifactId: receipts.get(id).document.derivative.artifactId }] : [])
    }
    if (sql.startsWith('SELECT id,"receiptJson","receiptHash" FROM output_normalization_receipts')) {
      return params.slice(2).flatMap((id) => receipts.has(id)
        ? [{ id, receiptJson: serializeOutputCanonicalJson(receipts.get(id).document), receiptHash: receipts.get(id).receiptHash }] : [])
    }
    throw new Error(`persisted output double does not answer: ${sql.slice(0, 90)}`)
  }
}
