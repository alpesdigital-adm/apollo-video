import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

/**
 * W70 readiness. A ProjectVersion made by an EXCEPTION Command (a per-segment subtitle exception, a per-variant manual reframe) changes
 * nothing the Director decided: the EditPlan is the parent's under the new Version's identity (the bundle builder refuses any other
 * difference), and only the caption text/style/position or one output's crop moves. Such a Version has no DirectorRun of its own, but the
 * quality the Director certified for its ancestor still describes it. Without a rule for that, a final export of the Version is
 * unreachable and, worse, a fresh proxy render of it would read an EMPTY list of Director issues, dropping warnings a person would
 * otherwise have to acknowledge.
 *
 * The rule is a walk back through `parentVersionId`, and nothing else:
 *   - it continues only while the Version was made by an ALLOWED Command (`INHERITING_COMMAND_TYPES`), whose recorded base is the
 *     parent it walks to, and whose EditPlan content is the parent's (compared without the identity fields);
 *   - the first Version that is the result of a succeeded DirectorRun ends it, and that run's quality snapshot is the one used;
 *   - anything else (another Command type, a Version with no Command, a moved EditPlan, a missing parent, too long a chain) STOPS it, with
 *     a precise reason. The walk never reaches past a Command it does not know.
 * A DirectorRun row is never copied: the inheritance is a receipt that names the Versions and Commands it went through.
 */
export const DIRECTOR_RUN_INHERITANCE_SCHEMA = 'director-run-inheritance/v1'

/** Commands whose impact touches only the captions or the crop of ONE output; every one is full-timeline or partial-range, never plan-changing. */
export const INHERITING_COMMAND_TYPES: readonly string[] = Object.freeze(['apply-subtitle-segment-override', 'apply-variant-reframe-override'])

export const MAX_DIRECTOR_INHERITANCE_DEPTH = 64

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

export interface DirectorRunInheritance {
  readonly schemaVersion: typeof DIRECTOR_RUN_INHERITANCE_SCHEMA
  /** The Version the Director's run produced: the one whose quality snapshot is used. */
  readonly directorResultVersionId: string
  /** The Versions the quality passed through, from the one asked for back to (and excluding) the Director's Version. */
  readonly inheritedThroughVersionIds: readonly string[]
  /** The Command that made each of those Versions, in the same order. */
  readonly inheritedThroughCommandIds: readonly string[]
  /** Content address of the three fields above. */
  readonly inheritanceHash: string
}

export interface DirectorInheritanceVersionFacts {
  readonly versionId: string
  readonly parentVersionId: string | null
  readonly commandId: string | null
  readonly commandType: string | null
  /** The Version the Command records as its base. */
  readonly commandBaseVersionId: string | null
  /** The content address of the EditPlan without its identity fields (`id`, `projectVersionId`, `createdAt`). */
  readonly planContentHash: string
}

export interface DirectorInheritanceReader {
  /** Whether a succeeded DirectorRun produced this Version. */
  isDirectorResult(versionId: string): Promise<boolean>
  readVersion(versionId: string): Promise<Readonly<DirectorInheritanceVersionFacts> | null>
}

export const DIRECTOR_INHERITANCE_BLOCK_REASONS = Object.freeze([
  'command-not-inheriting', 'version-without-command', 'command-base-mismatch', 'parent-missing', 'edit-plan-moved', 'chain-too-long',
] as const)
export type DirectorInheritanceBlockReason = (typeof DIRECTOR_INHERITANCE_BLOCK_REASONS)[number]

export type DirectorInheritanceWalk =
  | Readonly<{ kind: 'direct'; directorResultVersionId: string }>
  | Readonly<{ kind: 'inherited'; inheritance: Readonly<DirectorRunInheritance> }>
  /** No Director run is reachable and nothing was refused: the Version, or an ancestor, is simply not directed. */
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'blocked'; reason: DirectorInheritanceBlockReason; versionId: string; commandId?: string; commandType?: string }>

function sealInheritance(input: Readonly<{
  directorResultVersionId: string; inheritedThroughVersionIds: readonly string[]; inheritedThroughCommandIds: readonly string[]
}>): Readonly<DirectorRunInheritance> {
  const body = {
    directorResultVersionId: input.directorResultVersionId,
    inheritedThroughVersionIds: Object.freeze([...input.inheritedThroughVersionIds]),
    inheritedThroughCommandIds: Object.freeze([...input.inheritedThroughCommandIds]),
  }
  return Object.freeze({
    schemaVersion: DIRECTOR_RUN_INHERITANCE_SCHEMA,
    ...body,
    inheritanceHash: calculateCanonicalHash({ kind: DIRECTOR_RUN_INHERITANCE_SCHEMA, ...body }),
  })
}

export function createDirectorRunInheritance(input: Readonly<{
  directorResultVersionId: string; links: readonly Readonly<{ versionId: string; commandId: string }>[]
}>): Readonly<DirectorRunInheritance> {
  if (input.links.length < 1 || input.links.length > MAX_DIRECTOR_INHERITANCE_DEPTH) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'A Director run inheritance names between 1 and 64 Versions')
  }
  return parseDirectorRunInheritance(sealInheritance({
    directorResultVersionId: input.directorResultVersionId,
    inheritedThroughVersionIds: input.links.map((link) => link.versionId),
    inheritedThroughCommandIds: input.links.map((link) => link.commandId),
  }))
}

/** Strict re-derivation: a document whose hash, shape or lists do not agree is not an inheritance. */
export function parseDirectorRunInheritance(value: unknown): Readonly<DirectorRunInheritance> {
  const invalid = () => new DomainError('PERSISTENCE_CONFLICT', 'Stored Director run inheritance is invalid')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  const allowed = new Set(['schemaVersion', 'directorResultVersionId', 'inheritedThroughVersionIds', 'inheritedThroughCommandIds', 'inheritanceHash'])
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.schemaVersion !== DIRECTOR_RUN_INHERITANCE_SCHEMA) throw invalid()
  const { directorResultVersionId, inheritedThroughVersionIds, inheritedThroughCommandIds, inheritanceHash } = record
  const idList = (candidate: unknown): candidate is string[] => Array.isArray(candidate) &&
    candidate.length >= 1 && candidate.length <= MAX_DIRECTOR_INHERITANCE_DEPTH &&
    candidate.every((item) => typeof item === 'string' && ID_PATTERN.test(item)) && new Set(candidate).size === candidate.length
  if (
    typeof directorResultVersionId !== 'string' || !ID_PATTERN.test(directorResultVersionId) ||
    !idList(inheritedThroughVersionIds) || !idList(inheritedThroughCommandIds) ||
    inheritedThroughVersionIds.length !== inheritedThroughCommandIds.length ||
    inheritedThroughVersionIds.includes(directorResultVersionId) ||
    typeof inheritanceHash !== 'string' || !HASH_PATTERN.test(inheritanceHash)
  ) throw invalid()
  const sealed = sealInheritance({ directorResultVersionId, inheritedThroughVersionIds, inheritedThroughCommandIds })
  if (sealed.inheritanceHash !== inheritanceHash) throw invalid()
  return sealed
}

export function directorRunInheritanceEquals(
  left: Readonly<DirectorRunInheritance> | null | undefined,
  right: Readonly<DirectorRunInheritance> | null | undefined,
): boolean {
  if (!left || !right) return !left && !right
  return left.inheritanceHash === right.inheritanceHash && left.directorResultVersionId === right.directorResultVersionId
}

/**
 * What a render input hash and a receipt carry for an inheritance: the Director's Version and every Version and Command the quality went
 * through. `null` for a Version that is the Director's own, which keeps the identity of every export made before inheritance existed.
 */
export function directorRunInheritanceIdentity(inheritance: Readonly<DirectorRunInheritance> | null | undefined) {
  return inheritance
    ? Object.freeze({
        directorResultVersionId: inheritance.directorResultVersionId,
        inheritedThroughVersionIds: inheritance.inheritedThroughVersionIds,
        inheritedThroughCommandIds: inheritance.inheritedThroughCommandIds,
        inheritanceHash: inheritance.inheritanceHash,
      })
    : null
}

/** The published sentence for a refusal; stable text a client and an operator can act on. */
export function describeDirectorInheritanceBlock(block: Extract<DirectorInheritanceWalk, { kind: 'blocked' }>): string {
  switch (block.reason) {
    case 'command-not-inheriting':
      return `The Director's quality does not carry through a ${block.commandType ?? 'Command'} Version (${block.versionId}); direct the project again`
    case 'version-without-command':
      return `Version ${block.versionId} has no Command, so it does not inherit the Director's quality`
    case 'command-base-mismatch':
      return `The Command of Version ${block.versionId} is not based on its parent, so it does not inherit the Director's quality`
    case 'parent-missing':
      return `The parent of Version ${block.versionId} is missing, so the Director's quality cannot be inherited`
    case 'edit-plan-moved':
      return `The EditPlan of Version ${block.versionId} differs from its parent's, so it does not inherit the Director's quality`
    case 'chain-too-long':
      return `More than ${MAX_DIRECTOR_INHERITANCE_DEPTH} exception Versions follow the last Director run; direct the project again`
  }
}

/**
 * The walk. Pure over a reader, so the rule is tested without a database and the PostgreSQL reader only supplies facts.
 */
export async function walkDirectorInheritance(reader: DirectorInheritanceReader, versionId: string): Promise<Readonly<DirectorInheritanceWalk>> {
  const links: { versionId: string; commandId: string }[] = []
  let cursor = versionId
  const seen = new Set<string>()
  for (;;) {
    if (seen.has(cursor)) return Object.freeze({ kind: 'blocked' as const, reason: 'parent-missing' as const, versionId: cursor })
    seen.add(cursor)
    if (await reader.isDirectorResult(cursor)) {
      return links.length === 0
        ? Object.freeze({ kind: 'direct' as const, directorResultVersionId: cursor })
        : Object.freeze({ kind: 'inherited' as const, inheritance: createDirectorRunInheritance({ directorResultVersionId: cursor, links }) })
    }
    const facts = await reader.readVersion(cursor)
    if (!facts || facts.parentVersionId === null) return Object.freeze({ kind: 'none' as const })
    if (facts.commandId === null || facts.commandType === null) {
      return Object.freeze({ kind: 'blocked' as const, reason: 'version-without-command' as const, versionId: cursor })
    }
    if (!INHERITING_COMMAND_TYPES.includes(facts.commandType)) {
      return Object.freeze({ kind: 'blocked' as const, reason: 'command-not-inheriting' as const, versionId: cursor, commandId: facts.commandId, commandType: facts.commandType })
    }
    if (facts.commandBaseVersionId !== facts.parentVersionId) {
      return Object.freeze({ kind: 'blocked' as const, reason: 'command-base-mismatch' as const, versionId: cursor, commandId: facts.commandId, commandType: facts.commandType })
    }
    const parent = await reader.readVersion(facts.parentVersionId)
    if (!parent) return Object.freeze({ kind: 'blocked' as const, reason: 'parent-missing' as const, versionId: cursor, commandId: facts.commandId, commandType: facts.commandType })
    if (parent.planContentHash !== facts.planContentHash) {
      return Object.freeze({ kind: 'blocked' as const, reason: 'edit-plan-moved' as const, versionId: cursor, commandId: facts.commandId, commandType: facts.commandType })
    }
    if (links.length >= MAX_DIRECTOR_INHERITANCE_DEPTH) {
      return Object.freeze({ kind: 'blocked' as const, reason: 'chain-too-long' as const, versionId: cursor, commandId: facts.commandId, commandType: facts.commandType })
    }
    links.push({ versionId: cursor, commandId: facts.commandId })
    cursor = parent.versionId
  }
}
