import type { Prisma } from '../../../../generated/prisma-v2/index.js'
import type { CommandImpactOutputReference } from '../../domain/command-impact.ts'
import { DomainError } from '../../domain/errors.ts'
import type { OutputConsumptionState } from '../../domain/output-consumption.ts'
import { renderOutputReferences } from '../../domain/output-variant-references.ts'
import { readStoredOutputStateV3 } from './output-state-consumption.ts'

/** The two tables a render leaves a row in (a proxy render and a final export, each carrying the output it was made for) and the sealed State rows. */
export type VersionRenderReader = Pick<Prisma.TransactionClient, 'v2ProjectProxyRenderOperation' | 'v2ProjectFinalExportOperation' | '$queryRawUnsafe'>

/**
 * Every render of ONE Version (a succeeded proxy render or final export), each attributed to the stable State variant it was made
 * for, sorted the way a Command impact lists them.
 *
 * A plan-editing Command (a manual edit, a review patch, an editorial cut, a restore) makes the renders of every output of the
 * project stale, so the Command's impact lists all of them and each stale row names its own output. The attribution is
 * `renderOutputReferences`': the `outputVariantId` the render was enqueued with, or, for a row written before that column existed,
 * the only output the answer is exact for. A row that cannot be attributed exactly is a PERSISTENCE_CONFLICT, never a guess,
 * because attributing a render to the wrong output would stale the wrong output.
 *
 * The renders belong to `versionId`, so they are attributed in the State that Version seals. A caller that already holds a State
 * carrying exactly those outputs (the child of a plan-editing Command carries its parent's, spec for spec) passes it as `state`
 * and saves the read; otherwise the sealed State of the Version is read.
 */
export async function readVersionRenderReferences(client: VersionRenderReader, input: Readonly<{
  workspaceId: string
  projectId: string
  versionId: string
  state?: OutputConsumptionState
}>): Promise<readonly Readonly<CommandImpactOutputReference>[]> {
  const state = input.state ?? (await readStoredOutputStateV3(client, input))?.state
  if (!state) throw new DomainError('PERSISTENCE_CONFLICT', 'The Version whose renders are listed has no sealed output State')
  const where = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: input.versionId,
    operation: { status: 'succeeded', phase: 'completed' },
  }
  const [proxies, finals] = await Promise.all([
    client.v2ProjectProxyRenderOperation.findMany({ where, select: { outputArtifactId: true, outputVariantId: true } }),
    client.v2ProjectFinalExportOperation.findMany({ where, select: { outputArtifactId: true, outputVariantId: true, outputAspectRatio: true } }),
  ])
  return renderOutputReferences({ state, sourceVersionId: input.versionId, proxies, finals })
}
