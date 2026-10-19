// Fakes for the one persisted output consumption verdict (slice S3), shared by the proxy-render and final-export unit tests.
//
// A consumer of an output never reads the project's format or the head: it reads the sealed State of an exact Version (the light
// reader `readStoredOutputStateV3`: one SELECT over `project_versions` + `project_output_states`) and applies the domain verdict.
// `fakeOutputWorld` builds the smallest State document that reader accepts (canonical JSON + canonical hash, so the reader's own
// seal checks pass) and answers that one SELECT; any other SQL is refused, which is how a test proves a consumer never asked for the
// audit rebuild. Real bundles are proven by the PG suites; these fakes only stand where a database would.
const { calculateOutputCanonicalHash, serializeOutputCanonicalJson } = await import('../../../src/v2/domain/output-canonical-policy.ts')
const { outputConsumptionSealHashV3, outputConsumptionSealV3, outputConsumptionVerdictV3 } = await import('../../../src/v2/domain/output-consumption.ts')

const hex = (char) => char.repeat(64)
const LIGHT_READER_SQL = 'FROM project_versions v LEFT JOIN project_output_states s'

/**
 * One sealed Version with its State.
 * `entries`: [{ variantId, aspectRatio, outputSpecRevisionId?, specHash?, materializationId?, materializationHash?, derived?, blockedReasons? }].
 * `derived: true` is an editorial-derived materialization (a cut copy); with `sourceDependencies` set the final export is blocked.
 * `blockedReasons` makes the entry a blocked one (a copy never cut carries `fork-target-materialization-required`).
 */
export function fakeOutputWorld({
  workspaceId, projectId, versionId, baseHash = hex('a'), stateId = `state-of-${versionId}`,
  entries = [{ variantId: 'variant-main', aspectRatio: '9:16' }], sourceDependencies = null,
} = {}) {
  if (!workspaceId || !projectId || !versionId) throw new Error('fakeOutputWorld needs workspaceId, projectId and versionId')
  const documentEntries = entries.map((entry, index) => {
    const variantId = entry.variantId ?? `variant-${index}`
    const common = {
      variantId, outputSpecRevisionId: entry.outputSpecRevisionId ?? `revision-${variantId}`, specHash: entry.specHash ?? hex('b'),
      spec: entry.aspectRatio === null ? { output: {} } : { output: { aspectRatio: entry.aspectRatio ?? '9:16' } },
    }
    if (entry.blockedReasons) return { ...common, consumption: { status: 'blocked', reasons: [...entry.blockedReasons] } }
    return { ...common, consumption: { status: 'materialized', materialization: {
      materializationHash: entry.materializationHash ?? hex('c'),
      document: { id: entry.materializationId ?? `materialization-${variantId}`,
        schemaVersion: entry.derived ? 'editorial-derived-materialization/v1' : 'output-materialization/v1' } } } }
  })
  const document = { schemaVersion: 'project-output-state/v3', id: stateId, resultVersionId: versionId, projectId, workspaceId,
    entries: documentEntries, sourceDependencies }
  const stateJson = serializeOutputCanonicalJson(document)
  const stateHash = calculateOutputCanonicalHash(document)
  const row = { outputContractVersion: 3, baseHash, outputStateId: stateId, outputStateHash: stateHash, stateJson, stateHash,
    schemaVersion: 'project-output-state/v3' }
  const sql = []
  const world = {
    version: Object.freeze({ id: versionId, baseHash }), document, stateHash, row, sql,
    /** Answers the light reader's one SELECT for this Version; refuses everything else (no audit rebuild from a consumer). */
    async queryRawUnsafe(text, ...params) {
      sql.push(text)
      if (!String(text).includes(LIGHT_READER_SQL)) throw new Error(`a consumer must read only the sealed Version + State rows, not: ${String(text).slice(0, 90)}`)
      return params[0] === versionId && params[1] === projectId && params[2] === workspaceId ? [row] : []
    },
    /** What `requirePersistedOutputConsumptionV3` would answer for this Version (throws like it when the verdict blocks). */
    consumption(purpose, variantId) {
      const verdict = outputConsumptionVerdictV3({ document, stateHash }, variantId, purpose)
      if (verdict.status === 'blocked') throw new Error(`the fake world is blocked for ${purpose}: ${verdict.reasons.join(',')}`)
      const seal = outputConsumptionSealV3(world.version, { document, stateHash }, verdict.entry, purpose)
      return Object.freeze({ seal, sealHash: outputConsumptionSealHashV3(seal) })
    },
  }
  return world
}

/** A consumption whose seal differs from `base` in the named fields (another State, variant revision or materialization). */
export function alteredConsumption(base, patch) {
  const seal = Object.freeze({ ...base.seal, ...patch })
  return Object.freeze({ seal, sealHash: outputConsumptionSealHashV3(seal) })
}

/** The same source read through another consumption (the seal reaches every input hash derived from the source). */
export function withConsumption(source, consumption) {
  return Object.freeze({ ...source, outputConsumption: consumption })
}
