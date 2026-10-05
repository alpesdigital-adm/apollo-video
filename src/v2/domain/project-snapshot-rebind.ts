import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { ProjectSnapshotKind } from './project-snapshot.ts'

/**
 * Snapshot rows belong to exactly one project and name the version that owns
 * them. A duplicated version is a new version of a new project, so the fields
 * that bind a snapshot to its owner must name the copy, not the source.
 *
 * Only the owner-binding fields at the top level of the content are rebound:
 *
 * - `projectVersionId` and `projectId` (EditPlan and policy snapshots);
 * - the EditPlan `id`, when it follows the `edit-plan-<projectVersionId>`
 *   convention every version-producing Command applies.
 *
 * Every other field is content and is copied byte for byte. A snapshot with no
 * owner-binding field (the brief, an unconfigured policy snapshot) is returned
 * exactly as stored, hash included. When a field is rebound the canonical hash
 * is recomputed with the same rule every producer of snapshots uses, so the
 * copy's hash differs from the source's only where the content really differs.
 */
export interface SnapshotRebindInput {
  kind: ProjectSnapshotKind
  contentJson: string
  contentHash: string
  source: Readonly<{ projectId: string; versionId: string }>
  copy: Readonly<{ projectId: string; versionId: string }>
}

export interface SnapshotRebindResult {
  contentJson: string
  contentHash: string
  rebound: boolean
}

export function rebindSnapshotContentForDuplicate(
  input: Readonly<SnapshotRebindInput>,
): Readonly<SnapshotRebindResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.contentJson)
  } catch {
    assertDomain(false, 'PERSISTENCE_CONFLICT', 'Source snapshot content is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return Object.freeze({
      contentJson: input.contentJson, contentHash: input.contentHash, rebound: false,
    })
  }
  const content = parsed as Record<string, unknown>
  const next: Record<string, unknown> = { ...content }
  let rebound = false
  if (typeof content.projectVersionId === 'string') {
    next.projectVersionId = input.copy.versionId
    rebound ||= content.projectVersionId !== input.copy.versionId
    if (
      input.kind === 'edit-plan' &&
      content.id === `edit-plan-${content.projectVersionId}`
    ) {
      next.id = `edit-plan-${input.copy.versionId}`
    }
  }
  if (typeof content.projectId === 'string') {
    next.projectId = input.copy.projectId
    rebound ||= content.projectId !== input.copy.projectId
  }
  if (!rebound) {
    return Object.freeze({
      contentJson: input.contentJson, contentHash: input.contentHash, rebound: false,
    })
  }
  return Object.freeze({
    contentJson: stableSerialize(next),
    contentHash: calculateCanonicalHash(next),
    rebound: true,
  })
}
