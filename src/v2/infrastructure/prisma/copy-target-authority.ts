import type { PrismaClient, Prisma } from '../../../../generated/prisma-v2/index.js'
import { DomainError } from '../../domain/errors.ts'
import { COPY_REQUIRES_EDITORIAL_CUT_REASON, FORK_TARGET_MATERIALIZATION_REASON } from '../../domain/output-child-command.ts'

type Reader = Pick<PrismaClient | Prisma.TransactionClient, '$queryRawUnsafe'>

/**
 * A copy (a Creation fork that carries content) has no target authority until an editorial cut binds the fork derivation's
 * observations to it: the fork itself and every Version that only configured it keep every entry blocked. Nothing may render,
 * review or export such a Version; this is the one place the infrastructure answers that, with the reason an operator can act on.
 *
 * Reads only the sealed State of the Version (never the plan or the media), so it is cheap enough to sit in front of every
 * render-source read and review write. A historical or non-copy Version passes untouched.
 */
export async function requireCopyTargetAuthority(client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; projectVersionId: string | null | undefined }>): Promise<void> {
  if (!input.projectVersionId) return
  const rows = await client.$queryRawUnsafe<Array<{ schemaVersion: string; transition: string; stateJson: string }>>(
    'SELECT s."schemaVersion", s.transition, s."stateJson" FROM project_versions v JOIN project_output_states s ON s.id=v."outputStateId" AND s."resultVersionId"=v.id ' +
    'WHERE v.id=$1 AND v."projectId"=$2 AND v."workspaceId"=$3', input.projectVersionId, input.projectId, input.workspaceId)
  const row = rows[0]
  if (rows.length !== 1 || !row) return
  let pending = false
  if (row.schemaVersion === 'project-output-state/v2') pending = row.transition === 'fork-with-content'
  else if (row.schemaVersion === 'project-output-state/v3') {
    const entries = (JSON.parse(row.stateJson) as { entries?: Array<{ consumption?: { status?: string; reasons?: unknown } }> }).entries ?? []
    pending = entries.length > 0 && entries.every((entry) => entry.consumption?.status === 'blocked' &&
      Array.isArray(entry.consumption.reasons) && entry.consumption.reasons.length === 1 && entry.consumption.reasons[0] === FORK_TARGET_MATERIALIZATION_REASON)
  }
  if (pending) {
    throw new DomainError('PRECONDITION_REQUIRED', 'This copy needs an editorial cut before it can be rendered, reviewed or exported',
      { reason: COPY_REQUIRES_EDITORIAL_CUT_REASON, projectVersionId: input.projectVersionId })
  }
}
