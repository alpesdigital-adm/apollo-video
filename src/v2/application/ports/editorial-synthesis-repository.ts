import type { EditorialSynthesis } from '../../domain/editorial-synthesis.ts'

/**
 * Persistence for multi-range editorial synthesis (F4.001 / FR-135).
 *
 * A synthesis is content-addressed: its hash covers the ranges, the joins and
 * the justifications for every splice. Writing the same synthesis twice is a
 * replay, not a conflict — the second write is the same bytes. Writing a
 * *different* synthesis under the same id is a conflict, because the stored
 * justifications are the audit trail for the cuts and overwriting them would
 * quietly re-license assertions somebody already reviewed.
 */
export interface EditorialSynthesisRepository {
  persist(input: {
    synthesis: Readonly<EditorialSynthesis>
    createdAt: string
  }): Promise<Readonly<{ synthesis: Readonly<EditorialSynthesis>; replayed: boolean }>>

  read(input: {
    workspaceId: string
    synthesisId: string
  }): Promise<Readonly<EditorialSynthesis> | null>

  list(input: {
    workspaceId: string
    projectId: string
    limit?: number
  }): Promise<readonly Readonly<EditorialSynthesis>[]>

  /**
   * Every synthesis that reused a given long-form moment.
   *
   * The question a librarian asks before retiring a source: what did we already
   * ship out of it? Answering from the range rows rather than from the JSON is
   * why the ranges are real rows.
   */
  listByMoment(input: {
    workspaceId: string
    momentId: string
    limit?: number
  }): Promise<readonly Readonly<{ synthesisId: string; rangeId: string; startMs: number; endMs: number }>[]>
}
