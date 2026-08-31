import { assertDomain } from '../domain/errors.ts'
import type {
  SyntheticCriticDecision,
  SyntheticCriticReport,
} from '../domain/synthetic-critic-report.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { requireScope } from './authenticate-api-client.ts'
import type { SyntheticCriticReportRepository } from './ports/synthetic-critic-report-repository.ts'

/**
 * Read-side services over the critic's durable verdicts (F3.009).
 *
 * A report is the evidence behind a promotion that happened and behind a reuse
 * that did not: it is exposed read-only and workspace-bound, and a report of
 * another workspace is never returned, not even by id. Nothing here can record,
 * amend or re-decide a verdict — the critic writes, the API only reads.
 */

export const SYNTHETIC_CRITIC_REPORT_LIST_DEFAULT_LIMIT = 20
export const SYNTHETIC_CRITIC_REPORT_LIST_MAX_LIMIT = 100

/**
 * How many of the newest reports in scope a narrowing filter is applied over.
 * `decision` cannot be combined with the block-scoped port, so it is applied in
 * memory over a bounded window instead of over an unbounded scan: a caller
 * asking for 20 rejections gets the rejections among the newest 100, never a
 * page assembled by walking the whole table.
 */
export const SYNTHETIC_CRITIC_REPORT_FILTER_SCAN_WINDOW = SYNTHETIC_CRITIC_REPORT_LIST_MAX_LIMIT

function assertReadableWorkspace(actor: AuthenticatedExternalActor, workspaceId: string): void {
  requireScope(actor, 'projects:read')
  assertDomain(
    actor.workspaceId === workspaceId,
    'INVALID_WORKSPACE',
    'Actor cannot read synthetic critic reports in another workspace',
  )
}

function assertBoundedLimit(limit: number): number {
  assertDomain(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= SYNTHETIC_CRITIC_REPORT_LIST_MAX_LIMIT,
    'INVALID_ARGUMENT',
    `limit must be an integer between 1 and ${SYNTHETIC_CRITIC_REPORT_LIST_MAX_LIMIT}`,
  )
  return limit
}

export interface ListSyntheticCriticReportsRequest {
  workspaceId: string
  projectId: string
  actor: AuthenticatedExternalActor
  decision?: SyntheticCriticDecision
  blockId?: string
  limit?: number
}

/**
 * The verdicts of one project, newest first.
 *
 * Narrowing by `blockId` reads by block and then keeps only the reports of the
 * requested project: a project-scoped path must never widen into its
 * neighbours, and a block id is not proof of which project asked.
 */
export function listSyntheticCriticReportsService(dependencies: {
  reports: SyntheticCriticReportRepository
}) {
  return async function list(
    request: ListSyntheticCriticReportsRequest,
  ): Promise<readonly Readonly<SyntheticCriticReport>[]> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    const limit = assertBoundedLimit(request.limit ?? SYNTHETIC_CRITIC_REPORT_LIST_DEFAULT_LIMIT)
    const narrows = Boolean(request.decision) || Boolean(request.blockId)
    const window = narrows ? SYNTHETIC_CRITIC_REPORT_FILTER_SCAN_WINDOW : limit
    const page = request.blockId
      ? await dependencies.reports.readByBlock({
        workspaceId: request.workspaceId,
        blockId: request.blockId,
        limit: window,
      })
      : await dependencies.reports.listByProject({
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        ...(request.decision ? { decision: request.decision } : {}),
        limit: window,
      })
    const matched = page.filter((report) =>
      report.projectId === request.projectId &&
      (request.decision === undefined || report.decision === request.decision))
    return Object.freeze(matched.slice(0, limit))
  }
}

export interface ReadSyntheticCriticReportRequest {
  workspaceId: string
  projectId: string
  reportId: string
  actor: AuthenticatedExternalActor
}

/**
 * One verdict by id, inside one project.
 *
 * A report that exists in the workspace but belongs to another project reads as
 * absent rather than as a cross-project peek: the path says which project is
 * being asked about, and the answer has to respect it.
 */
export function readSyntheticCriticReportService(dependencies: {
  reports: SyntheticCriticReportRepository
}) {
  return async function read(
    request: ReadSyntheticCriticReportRequest,
  ): Promise<Readonly<SyntheticCriticReport>> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    const report = await dependencies.reports.read({
      workspaceId: request.workspaceId,
      reportId: request.reportId,
    })
    assertDomain(
      Boolean(report) && report!.projectId === request.projectId,
      'ASSET_NOT_FOUND',
      'Synthetic critic report was not found in this project',
    )
    return report!
  }
}

export interface ReadSyntheticCriticBlockEvidenceRequest {
  workspaceId: string
  projectId: string
  blockId: string
  actor: AuthenticatedExternalActor
}

/**
 * The verdict currently in force for one block, with its measurements and the
 * issues it localized.
 *
 * Newest first, and only the newest is returned: an older approval that a later
 * rejection superseded is history, not the answer to "what does the critic say
 * about this block". A block that was never judged is absent — silence is
 * reported as absence, never as approval.
 */
export function readSyntheticCriticBlockEvidenceService(dependencies: {
  reports: SyntheticCriticReportRepository
}) {
  return async function readBlockEvidence(
    request: ReadSyntheticCriticBlockEvidenceRequest,
  ): Promise<Readonly<SyntheticCriticReport>> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    const reports = await dependencies.reports.readByBlock({
      workspaceId: request.workspaceId,
      blockId: request.blockId,
      limit: 1,
    })
    const report = reports[0]
    assertDomain(
      Boolean(report) && report!.projectId === request.projectId,
      'ASSET_NOT_FOUND',
      'No synthetic critic report judges this block in this project',
    )
    return report!
  }
}
