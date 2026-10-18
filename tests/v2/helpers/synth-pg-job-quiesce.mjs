// Leaves no claimable provider job behind.
//
// `PrismaProviderJobRepository.claimNext` is global: it takes the oldest non-terminal job of ANY workspace whose lease is
// null or expired at the caller's `now`. A PostgreSQL suite used to clean its rows up on the way out, which also removed its
// unfinished jobs. Sealed rows are append-only, so suites no longer delete anything, and a job a suite leaves planned,
// retrieving or evaluating would be claimed by the NEXT suite that runs a worker in the same database (and fail there with an
// authority error, or take the lease the next suite's own job needs).
//
// A suite therefore ends by moving its own outstanding jobs to `canceled` through the domain transition and the real
// repository: the same writer a cancellation uses, so the job's hash chain stays intact and nothing is deleted.
import { randomUUID } from 'node:crypto'

const { transitionProviderJob, TERMINAL_PROVIDER_JOB_STATUSES } = await import('../../../src/v2/domain/provider-job.ts')

/**
 * Cancels every non-terminal provider job of `workspaceId`. The lease is taken directly on the (mutable) job row: the job's
 * previous holder is a worker that no longer exists, and a lease is infrastructure metadata, not part of the job's hash.
 *
 * @returns the ids it canceled.
 */
export async function cancelOutstandingProviderJobs(client, { workspaceId, repository }) {
  const outstanding = await client.v2ProviderJob.findMany({
    where: { workspaceId, status: { notIn: [...TERMINAL_PROVIDER_JOB_STATUSES] } },
    select: { id: true, projectId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const canceled = []
  for (const { id, projectId } of outstanding) {
    const persisted = await repository.read({ workspaceId, projectId, jobId: id })
    if (!persisted) continue
    const occurredAt = new Date(Math.max(Date.parse(persisted.job.updatedAt) + 1_000, Date.now()))
    const lease = { owner: 'suite-quiesce', token: `suite-quiesce-${randomUUID()}`, expiresAt: new Date(occurredAt.getTime() + 60_000) }
    await client.v2ProviderJob.update({
      where: { id },
      data: { leaseOwner: lease.owner, leaseToken: lease.token, leaseExpiresAt: lease.expiresAt },
    })
    await repository.advance({
      current: { ...persisted, lease: { owner: lease.owner, token: lease.token, expiresAt: lease.expiresAt.toISOString() } },
      next: transitionProviderJob(persisted.job, { status: 'canceled', occurredAt: occurredAt.toISOString() }),
      transitionId: `suite-quiesce-${randomUUID()}`,
      occurredAt,
    })
    canceled.push(id)
  }
  return canceled
}
