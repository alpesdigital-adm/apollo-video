import { DomainError } from './errors.ts'

/**
 * Reading ALL the face windows of a source, or none (W63a).
 *
 * A snapshot that sees only the first N of a source's windows would be a statement about the first N: windows beyond the cut-off
 * would contribute no coverage, and two windows that contradict each other would never meet. So the windows are read page by page,
 * by keyset, until the source has none left; and when there are more than the declared cap the source is REFUSED with a stated
 * reason - a partial list is never trusted. The count comes first: a source over the cap costs no window read at all.
 */
export const FACE_WINDOW_SOURCE_CAP = 1000
export const FACE_WINDOW_PAGE_SIZE = 100
export const FACE_WINDOW_LIMIT_EXCEEDED = 'FACE_WINDOW_LIMIT_EXCEEDED' as const

/** The sort key of a stored window: the keyset position the next page starts after. */
export type FaceWindowCursor = Readonly<{ windowStartSourceFrame: number; createdAt: string; id: string }>

export type FaceWindowPage<T> = Readonly<{ items: readonly T[]; next: FaceWindowCursor | null }>
export type FaceWindowCollection<T> =
  | Readonly<{ status: 'complete'; items: readonly T[]; pages: number }>
  | Readonly<{ status: 'over-cap'; observed: number; cap: number; reasonCode: typeof FACE_WINDOW_LIMIT_EXCEEDED }>

/**
 * True when `next` is a position the keyset can have moved to from `after`: the (start, creation time) part never goes backwards and
 * the key is not the same one. (The id part is ordered by the database's collation, which this function does not pretend to know.)
 */
export function faceWindowCursorAdvanced(after: FaceWindowCursor, next: FaceWindowCursor): boolean {
  if (next.windowStartSourceFrame !== after.windowStartSourceFrame) return next.windowStartSourceFrame > after.windowStartSourceFrame
  if (next.createdAt !== after.createdAt) return next.createdAt > after.createdAt
  return next.id !== after.id
}

export async function collectAllFaceWindows<T>(input: Readonly<{
  cap: number
  pageSize: number
  count: () => Promise<number>
  page: (after: FaceWindowCursor | null, limit: number) => Promise<FaceWindowPage<T>>
}>): Promise<FaceWindowCollection<T>> {
  if (!Number.isSafeInteger(input.cap) || input.cap < 1 || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
    throw new DomainError('INVALID_ARGUMENT', 'Face window paging needs a positive cap and page size')
  }
  const total = await input.count()
  if (!Number.isSafeInteger(total) || total < 0) throw new DomainError('PERSISTENCE_CONFLICT', 'Face window count is invalid')
  const overCap = (observed: number): FaceWindowCollection<T> =>
    Object.freeze({ status: 'over-cap' as const, observed, cap: input.cap, reasonCode: FACE_WINDOW_LIMIT_EXCEEDED })
  if (total > input.cap) return overCap(total)
  const items: T[] = []
  let after: FaceWindowCursor | null = null
  let pages = 0
  // total <= cap, so more pages than ceil(cap / pageSize) + 1 can only mean a cursor that does not advance.
  const maxPages = Math.ceil(input.cap / input.pageSize) + 2
  for (;;) {
    pages += 1
    if (pages > maxPages) throw new DomainError('PERSISTENCE_CONFLICT', 'Face window paging did not terminate')
    const page: FaceWindowPage<T> = await input.page(after, input.pageSize)
    if (page.items.length > input.pageSize) throw new DomainError('PERSISTENCE_CONFLICT', 'Face window page exceeded its limit')
    items.push(...page.items)
    // Windows written while paging may push the source past the cap: then none of what was read is trusted.
    if (items.length > input.cap) return overCap(items.length)
    if (page.next === null) return Object.freeze({ status: 'complete' as const, items: Object.freeze(items), pages })
    if (after !== null && !faceWindowCursorAdvanced(after, page.next)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Face window cursor did not advance')
    }
    after = page.next
  }
}
