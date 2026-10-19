import type { Prisma } from '../../../../generated/prisma-v2/index.js'
import type { AdoptableObservationV3 } from '../../domain/output-child-command.ts'
import { readOutputNormalizationsV3 } from './output-version-materializer.ts'

type Reader = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | 'v2MediaArtifact'>

/**
 * The persisted, observed ingest receipts of the project's OTHER recordings, offered to a child Command that may
 * consume several recordings (a multicam cut, a selected insert, music, a replaced asset).
 *
 * State3 keeps one ingest's observation in the head State, but every ingest persisted its own receipt. This reads
 * the receipts of this workspace and project for exactly the requested source artifacts (the ones the new plan
 * consumes and the parent State does not observe, so the read costs nothing for a Command that adds none), verifies each
 * one against its persisted facts (`w66_assert_normalization_v3`: the producer operation, artifact facts, probes and
 * seal) and attaches the rights evidence of its source: the artifact's current snapshot, its hash and its audited
 * revision, or null when the source has none. Offering grants nothing. The transition adopts only what the new plan
 * consumes; the commit re-reads every adopted receipt and its rights under lock; the database guard checks them again.
 *
 * It is a read outside the write transaction: an invalid persisted receipt fails the read loudly (fail-closed)
 * instead of being silently left out.
 */
export async function readAdoptableObservationsV3(client: Reader, input: Readonly<{
  workspaceId: string
  projectId: string
  sourceArtifactIds: readonly string[]
}>): Promise<readonly Readonly<AdoptableObservationV3>[]> {
  const wanted = [...new Set(input.sourceArtifactIds)]
  if (wanted.length === 0 || wanted.length > 1024) return Object.freeze([])
  const rows = await client.$queryRawUnsafe<Array<{ id: string; sourceArtifactId: string }>>(
    'SELECT id,"sourceArtifactId" FROM output_normalization_receipts WHERE "workspaceId"=$1 AND "projectId"=$2 AND "sourceArtifactId" IN ('
      + wanted.map((_, index) => '$' + (index + 3)).join(',') + ') ORDER BY id COLLATE "C"',
    input.workspaceId, input.projectId, ...wanted)
  const candidates = rows
  if (candidates.length === 0) return Object.freeze([])
  const normalizations = await readOutputNormalizationsV3(client, {
    workspaceId: input.workspaceId, projectId: input.projectId, ids: candidates.map((row) => row.id), lock: false })
  const artifacts = await client.v2MediaArtifact.findMany({
    where: { workspaceId: input.workspaceId, id: { in: [...new Set(candidates.map((row) => row.sourceArtifactId))] } },
    include: { currentRightsSnapshot: true } })
  return Object.freeze(normalizations.map((normalization) => {
    const artifact = artifacts.find((item) => item.id === normalization.document.source.artifactId)
    const snapshot = artifact?.currentRightsSnapshot ?? null
    return Object.freeze({
      normalization,
      rights: artifact && snapshot
        ? Object.freeze({ snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash, revision: artifact.rightsRevision })
        : null,
    })
  }))
}
