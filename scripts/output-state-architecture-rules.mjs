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
/** The only file allowed to define or name the retired builder. */
export const VERSION_BUILDER = 'domain/project-version.ts'
/**
 * Retired contract one is still validated, never produced: domain code recomputes the Version a legacy bundle claims
 * through `rebuildRetiredContractOneVersion`. That name is allowed in the domain layer only, so no application or
 * infrastructure file (and therefore no writer) can reach it. There is deliberately no per-file allow-list.
 */
export const RETIRED_VERSION_REBUILD_LAYER = 'domain/'

export const PENDING_ROWS = Object.freeze([])

const WRITES_VERSION_ROW = [
  /\.v2ProjectVersion\s*\.\s*(?:create|createMany|upsert)\s*\(/,
  /INSERT\s+INTO\s+"?project_versions"?/i,
  /insert\s*\(\s*\w+\s*,\s*['"]project_versions['"]/,
]
/**
 * A renderable plan snapshot is born with the Version whose sealed State binds it (the database dispatch guard refuses a bare
 * INSERT), so the row is written by the same shared persistence file as the Version, in the same transaction. No other file
 * may insert, upsert or raw-insert one: a second writer would be a path that only the database refusal stands behind.
 */
const WRITES_RENDERABLE_SNAPSHOT_ROW = [
  /\.v2RenderablePlanSnapshot\s*\.\s*(?:create|createMany|upsert|createManyAndReturn)\s*\(/,
  /INSERT\s+INTO\s+"?renderable_plan_snapshots"?/i,
  /insert\s*\(\s*\w+\s*,\s*['"]renderable_plan_snapshots['"]/,
]
const BUILDS_RETIRED_VERSION = /\bcreateProjectVersion\b/
const REBUILDS_RETIRED_VERSION = /\brebuildRetiredContractOneVersion\b/

function violationKinds(rel, source) {
  const kinds = []
  if (rel !== VERSION_WRITER && WRITES_VERSION_ROW.some((pattern) => pattern.test(source))) kinds.push('writes a ProjectVersion row outside the shared writer')
  if (rel !== VERSION_WRITER && WRITES_RENDERABLE_SNAPSHOT_ROW.some((pattern) => pattern.test(source))) kinds.push('writes a renderable plan snapshot row outside the shared writer')
  if (rel !== VERSION_BUILDER && BUILDS_RETIRED_VERSION.test(source)) {
    kinds.push('uses the retired createProjectVersion builder instead of a sealed Version read or the output state transition')
  }
  if (rel !== VERSION_BUILDER && !rel.startsWith(RETIRED_VERSION_REBUILD_LAYER) && REBUILDS_RETIRED_VERSION.test(source)) {
    kinds.push('rebuilds a retired contract-one Version outside the domain layer')
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
