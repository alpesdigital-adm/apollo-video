/**
 * Structural gates for the transformation control plane (F3.013 / FR-113).
 *
 * These live in their own module so they can be tested against violating and
 * non-violating sources. A gate nobody has ever seen fire is indistinguishable
 * from a gate that does not work — the first draft of these rules passed
 * cleanly because a stray control character had eaten a word boundary, and
 * nothing noticed.
 *
 * Every rule here encodes something that was actually wrong in the code before
 * this wave, and each one was calibrated against the real repository: an
 * earlier draft flagged ordinary result deduplication, a `typeof` guard and a
 * read-side `where` clause. A gate that cries wolf teaches people to ignore the
 * lint.
 */

export const PROVIDER_JOB_DOMAIN_FILE = 'domain/provider-job.ts'

const TYPEOF_RESULT = '(?:string|number|boolean|object|undefined|function|symbol|bigint)'

export const TRANSFORMATION_ARCHITECTURE_PATTERNS = Object.freeze({
  providerJobDefinition: /export\s+(?:type|interface)\s+ProviderJob\s*[{=]/,
  transformationDomainFile: /^domain\/(provider-job|transformation-|generative-transformation)/,
  /** Excludes `typeof x === 'string'`: no provider is named "string". */
  providerBrandComparison: new RegExp(
    `\\b(?:provider|providerId|providerName|adapterId|vendor)\\s*(?:===|!==)\\s*['"](?!${TYPEOF_RESULT}['"])`,
  ),
  inMemoryReplayGuard:
    /\b(?:const|let|var)\s+\w*(?:nonce|consumedevent|seenevent|callbackevent|webhookevent)\w*\s*(?::[^=]*)?=\s*new\s+(?:Set|Map|WeakSet|WeakMap)\b/i,
  inMemoryReplayParameter:
    /\b\w*(?:nonce|consumedevent|seenevent|callbackevent)\w*\s*:\s*(?:Set|Map|WeakSet|WeakMap)\s*</i,
  persistenceAccess: /from ['"][^'"]*(?:prisma-postgres\/client|generated\/prisma-v2|repository-factory)/,
  rawPersistenceAccess: /from ['"][^'"]*(?:prisma-postgres\/client|generated\/prisma-v2)/,
  providerTransportFile: /^infrastructure\/(?:transformation\/|[^/]*(?:provider|transport)[^/]*\.ts$)/,
  /** Writes only. `status: 'approved'` inside a `where` is a read guard. */
  approvedProviderJobWrite:
    /v2ProviderJob\.(?:create|update|updateMany|upsert)\b[\s\S]{0,600}?data:[\s\S]{0,400}?status:\s*'approved'/,
})

/**
 * Evaluate every V2 source against the transformation gates.
 *
 * @param {ReadonlyArray<{ rel: string, source: string }>} sources paths relative to `src/v2`
 * @returns {string[]} violations, empty when the boundary holds
 */
export function transformationArchitectureViolations(sources) {
  const patterns = TRANSFORMATION_ARCHITECTURE_PATTERNS
  const violations = []
  const providerJobDefinitions = []

  for (const { rel, source } of sources) {
    // 1. Exactly one ProviderJob. A second model of the same idea drifts, and
    //    the one that drifts is always the one nothing calls.
    if (patterns.providerJobDefinition.test(source)) providerJobDefinitions.push(rel)

    // 2. Replay protection that a restart erases is not replay protection.
    if (rel.startsWith('domain/') || rel.startsWith('application/')) {
      if (patterns.inMemoryReplayGuard.test(source) || patterns.inMemoryReplayParameter.test(source)) {
        violations.push(`${rel}: callback replay/nonce state must be durable, never an in-memory Set or Map`)
      }
    }

    // 3. The domain must not know which provider it is talking to. Capabilities
    //    are declared in the registry; `if (provider === 'x')` is that
    //    knowledge leaking back in.
    if (patterns.transformationDomainFile.test(rel) && patterns.providerBrandComparison.test(source)) {
      violations.push(`${rel}: transformation domain branches on a provider or adapter identity literal`)
    }

    // 4. A transport speaks to a provider. It does not read or write Apollo state.
    if (patterns.providerTransportFile.test(rel) && patterns.persistenceAccess.test(source)) {
      violations.push(`${rel}: provider transport reaches persistence directly instead of returning to an application service`)
    }

    // 5. Nothing outside the aggregate may declare an external result approved.
    //    Approval is reachable only through `transitionProviderJob`, which
    //    refuses it without a locally ingested artifact and a critic hash.
    if (rel !== PROVIDER_JOB_DOMAIN_FILE && patterns.approvedProviderJobWrite.test(source)) {
      violations.push(`${rel}: a provider job may only reach 'approved' through transitionProviderJob, after ingestion and critic`)
    }
  }

  if (providerJobDefinitions.length !== 1 || providerJobDefinitions[0] !== PROVIDER_JOB_DOMAIN_FILE) {
    violations.push(
      `ProviderJob must be defined exactly once in ${PROVIDER_JOB_DOMAIN_FILE}; found: ${providerJobDefinitions.join(', ') || 'none'}`,
    )
  }
  return violations
}

/**
 * The API and the MCP server call application services. They are transports
 * too, and a transport is never the source of state.
 *
 * @param {ReadonlyArray<{ rel: string, source: string }>} sources
 * @returns {string[]}
 */
export function boundaryStateOwnershipViolations(sources) {
  return sources
    .filter(({ source }) => TRANSFORMATION_ARCHITECTURE_PATTERNS.rawPersistenceAccess.test(source))
    .map(({ rel }) => `${rel}: API/MCP boundary owns no state and must not open a database client`)
}
