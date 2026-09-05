import type { ColorCriticPolicy, ColorCriticReport } from '../../domain/color-critic-report.ts'

/** Enough of a report to decide what a re-derived match plan invalidates. */
export interface ColorCriticReportRef {
  readonly reportId: string
  readonly projectVersionId: string
  readonly action: string
  readonly cause: string
  readonly matchPlanId: string | null
  readonly matchPlanHash: string | null
  readonly evaluatedAt: string
}

/**
 * Colour critic reports (F4.014 / FR-152).
 *
 * Content-addressed and **not** versioned. A second look at the same bytes with
 * the same thresholds is the same report, so there is no chain and no head to
 * fence: two identical evaluations collapse into one row and a re-run says
 * `replayed`. A report that differs is a different report with its own id,
 * never an edit of the one before it — a verdict that could be rewritten in
 * place is a verdict nobody can cite.
 *
 * The bounds a bounded correction was proposed under are policy, not part of
 * the report, so `persist` takes the policy that produced it and stores the
 * four limits beside each delta. A stored correction stays checkable against
 * the limits that actually bounded it, whatever the policy says next year.
 */
export interface ColorCriticReportRepository {
  persist(input: {
    report: Readonly<ColorCriticReport>
    policy?: Readonly<ColorCriticPolicy>
    createdAt: string
  }): Promise<Readonly<{ report: Readonly<ColorCriticReport>; replayed: boolean }>>

  /**
   * One report by its id.
   *
   * `projectId` narrows the query where the caller knows which project it is
   * asking about — every `/v1/projects/{projectId}/...` read does. It is
   * optional because the invalidation sweeps read by id alone, and required in
   * spirit at the boundary: `readColorCriticReportService` refuses a report
   * whose stored `projectId` is not the one in the path, so a verdict about
   * project A can never be returned under project B's URL.
   */
  read(input: {
    workspaceId: string
    reportId: string
    projectId?: string
  }): Promise<Readonly<ColorCriticReport> | null>

  readByHash(input: {
    workspaceId: string
    reportHash: string
  }): Promise<Readonly<ColorCriticReport> | null>

  /** Reports about one project version, newest evaluation first. */
  listForProjectVersion(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    limit?: number
  }): Promise<readonly Readonly<ColorCriticReport>[]>

  /**
   * Reports whose verdict rested on a match plan.
   *
   * A re-derived plan does not make these wrong; it makes them stale, and the
   * difference matters — deleting a rejection because the plan moved on would
   * erase the reason the plan moved on.
   */
  findDependentsOfMatchPlan(input: {
    workspaceId: string
    matchPlanId: string
  }): Promise<readonly Readonly<ColorCriticReportRef>[]>

  /**
   * Reports whose verdict was reached over one colour measurement.
   *
   * The same question as above, asked of the evidence rather than of the plan:
   * a camera re-measured after a re-ingest makes every verdict over the old
   * reading stale. It is answerable because the citation is a row with a
   * foreign key, not a name inside a JSON document — the measured numbers stay
   * in the report, but which measurement they came from is a join.
   */
  findDependentsOfMeasurement(input: {
    workspaceId: string
    measurementId: string
  }): Promise<readonly Readonly<ColorCriticReportRef>[]>
}
