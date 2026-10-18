import type { Prisma } from '../../../../generated/prisma-v2/index.js'

/** Any sealed bundle of the project (a creation root, an operational head or the child about to replace it): it only needs its State's entries. */
type BundleWithState = Readonly<{ state: Readonly<{ document: Readonly<{ entries: readonly Readonly<{ spec: unknown }>[] }> }> }>

/**
 * The format the single-output flows (LUT selection, ColorPlan, policy overrides, Director and the multicam cut) call the
 * project's format: the aspect ratio their proxy and final outputs are keyed by.
 *
 * A project created under 6.0.0 has no format of its own (`projects.format` is null by the creation guard); what it has is its
 * explicit output variants. A project with exactly one output keeps the contract these flows always had: that output's aspect
 * ratio is its format. A project with several outputs has no single format: the answer is `null`, and each caller refuses with
 * its own "context is incomplete" instead of guessing which output it meant. An output whose spec carries no aspect ratio at all
 * is also `null`; a copy's fork revision answers with the geometry it was copied with.
 */
export function projectOutputFormat(project: Readonly<{ format: string | null }>, bundle: BundleWithState): string | null {
  if (project.format) return project.format
  const entries = bundle.state.document.entries
  if (entries.length !== 1) return null
  return specAspectRatio(entries[0]!.spec)
}

/**
 * The aspect ratio a sealed output spec carries: its own, or (a copy's literal fork revision, which keeps the geometry it was
 * copied with as `effectiveSpec`) the effective one. A spec with neither has no format of its own.
 */
function specAspectRatio(spec: unknown): string | null {
  const document = spec as { output?: { aspectRatio?: unknown }; effectiveSpec?: { output?: { aspectRatio?: unknown } } }
  const ratio = document.output?.aspectRatio ?? document.effectiveSpec?.output?.aspectRatio
  return typeof ratio === 'string' && ratio.length > 0 ? ratio : null
}

/**
 * The same answer as `projectOutputFormat`, for a caller that has no bundle in hand: the stored format when the project has
 * one, else the aspect ratio of the only output the State of `versionId` carries, read from the sealed spec revision. The State
 * is append-only and database-guarded, so this read is as authoritative as the column it replaces; callers that need the
 * bundle's full re-derivation read the bundle instead.
 */
export async function resolveProjectOutputFormat(
  client: Pick<Prisma.TransactionClient, 'v2ProjectOutputState'>,
  project: Readonly<{ id: string; workspaceId: string; format: string | null }>,
  versionId: string | null | undefined,
): Promise<string | null> {
  if (project.format) return project.format
  if (!versionId) return null
  const state = await client.v2ProjectOutputState.findFirst({
    where: { workspaceId: project.workspaceId, projectId: project.id, resultVersionId: versionId },
    select: { entries: { select: { revision: { select: { specJson: true } } } } },
  })
  if (!state || state.entries.length !== 1) return null
  return specAspectRatio(JSON.parse(state.entries[0]!.revision.specJson))
}
