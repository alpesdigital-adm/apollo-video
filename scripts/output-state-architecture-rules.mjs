/**
 * Structural gates for the W66 output state. A ProjectVersion exists only together with its sealed State,
 * so there is exactly one writer of project_versions and one builder of a Version outside that writer.
 *
 * Sources are `{ rel, source }` with `rel` relative to src/v2 and forward slashes.
 *
 * `PENDING_ROWS` lists the writers still on the retired path while the cutover is in flight. The list may
 * only shrink: a file listed here that no longer violates fails the gate until it is removed, and an
 * unlisted violator fails immediately. It must be empty before anything is pushed.
 */

/** The only file allowed to write a ProjectVersion row. */
export const VERSION_WRITER = 'infrastructure/prisma/output-version-bundle-persistence.ts'
/** The only file allowed to define the retired builder, and the domain code that validates retired contract-one bundles. */
export const VERSION_BUILDER = 'domain/project-version.ts'
export const CONTRACT_ONE_HISTORY = Object.freeze([
  'domain/output-version-bundle.ts',
  'domain/project-fork-derivation.ts',
])

export const PENDING_ROWS = Object.freeze([
  'application/manual-edit.ts',
  'application/multicam-direction.ts',
  'application/review-patch-batch.ts',
  'application/review-patch.ts',
  'application/run-project-director.ts',
  'infrastructure/prisma/director-run-repository.ts',
  'infrastructure/prisma/manual-edit-repository.ts',
  'infrastructure/prisma/multicam-direction-command-repository.ts',
  'infrastructure/prisma/review-patch-batch-repository.ts',
  'infrastructure/prisma/review-patch-repository.ts',
])

const WRITES_VERSION_ROW = [
  /\.v2ProjectVersion\s*\.\s*(?:create|createMany|upsert)\s*\(/,
  /INSERT\s+INTO\s+"?project_versions"?/i,
  /insert\s*\(\s*\w+\s*,\s*['"]project_versions['"]/,
]
const BUILDS_RETIRED_VERSION = /\bcreateProjectVersion\b/

function violationKinds(rel, source) {
  const kinds = []
  if (rel !== VERSION_WRITER && WRITES_VERSION_ROW.some((pattern) => pattern.test(source))) kinds.push('writes a ProjectVersion row outside the shared writer')
  if (rel !== VERSION_BUILDER && !CONTRACT_ONE_HISTORY.includes(rel) && BUILDS_RETIRED_VERSION.test(source)) {
    kinds.push('uses the retired createProjectVersion builder instead of a sealed Version read or the output state transition')
  }
  return kinds
}

export function outputStateArchitectureViolations(sources, pending = PENDING_ROWS) {
  const violations = []
  const listed = new Set(pending)
  for (const { rel, source } of sources) {
    const kinds = violationKinds(rel, source)
    if (kinds.length > 0 && !listed.has(rel)) for (const kind of kinds) violations.push(`${rel}: ${kind}`)
    if (kinds.length === 0 && listed.has(rel)) violations.push(`${rel}: no longer violates the output state rules; remove it from PENDING_ROWS`)
  }
  const present = new Set(sources.map((item) => item.rel))
  for (const rel of listed) if (!present.has(rel)) violations.push(`${rel}: listed in PENDING_ROWS but absent`)
  return violations
}
