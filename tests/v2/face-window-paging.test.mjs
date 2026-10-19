import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAllFaceWindows, collectFaceWindowsOfSources, FACE_WINDOW_LIMIT_EXCEEDED, FACE_WINDOW_PAGE_SIZE, FACE_WINDOW_SNAPSHOT_CAP, faceWindowCursorAdvanced,
} from '../../src/v2/domain/face-window-paging.ts'

/**
 * W63a. A source's face windows are read ALL or not at all: the old reader listed at most 200 and dropped the rest without saying so.
 * These tests drive the paging with an in-memory store that implements the same keyset (window start, creation time, id).
 */
const key = (index, over = {}) => ({ windowStartSourceFrame: Math.floor(index / 3) * 5, createdAt: new Date(Date.UTC(2026, 9, 19, 0, 0, 0, index % 3)).toISOString(),
  id: `window-${String(index).padStart(5, '0')}`, ...over })
const before = (left, right) => left.windowStartSourceFrame - right.windowStartSourceFrame ||
  (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

function store(count, { keyOf = key } = {}) {
  const rows = Array.from({ length: count }, (_unused, index) => ({ ...keyOf(index), index })).toSorted(before)
  const calls = { count: 0, pages: [] }
  return {
    rows, calls,
    count: async () => { calls.count += 1; return rows.length },
    page: async (after, limit) => {
      calls.pages.push(after)
      const rest = after === null ? rows : rows.filter((row) => before(row, after) > 0)
      const items = rest.slice(0, limit)
      const last = items.at(-1)
      return { items, next: items.length === limit && last ? { windowStartSourceFrame: last.windowStartSourceFrame, createdAt: last.createdAt, id: last.id } : null }
    },
  }
}

test('W63a the declared limits are the ones the reader uses', () => {
  assert.equal(FACE_WINDOW_SNAPSHOT_CAP, 1000)
  assert.equal(FACE_WINDOW_PAGE_SIZE, 100)
  assert.equal(FACE_WINDOW_LIMIT_EXCEEDED, 'FACE_WINDOW_LIMIT_EXCEEDED')
})

test('W63a more than 200 windows are read completely, in order, with no window skipped or repeated across pages', async () => {
  const source = store(250)
  const result = await collectAllFaceWindows({ cap: 1000, pageSize: 100, count: source.count, page: source.page })
  assert.equal(result.status, 'complete')
  assert.equal(result.items.length, 250, 'the old reader stopped at 200')
  assert.deepEqual(result.items.map((row) => row.id), source.rows.map((row) => row.id))
  assert.equal(new Set(result.items.map((row) => row.id)).size, 250)
  assert.equal(result.pages, 3)
  assert.equal(source.calls.pages[0], null)
  assert.equal(source.calls.count, 1)
  // a page boundary that falls inside a run of windows sharing start AND creation time loses nothing
  const ties = store(120, { keyOf: (index) => ({ windowStartSourceFrame: 40, createdAt: '2026-10-19T00:00:00.000Z', id: `tie-${String(index).padStart(4, '0')}` }) })
  const tied = await collectAllFaceWindows({ cap: 1000, pageSize: 50, count: ties.count, page: ties.page })
  assert.equal(tied.status, 'complete')
  assert.deepEqual(tied.items.map((row) => row.id), ties.rows.map((row) => row.id))
  // an exact multiple of the page size ends with an empty page, not a missing one
  const exact = store(200)
  const full = await collectAllFaceWindows({ cap: 1000, pageSize: 100, count: exact.count, page: exact.page })
  assert.equal(full.status, 'complete')
  assert.equal(full.items.length, 200)
  assert.equal((await collectAllFaceWindows({ cap: 10, pageSize: 5, count: async () => 0, page: async () => ({ items: [], next: null }) })).items.length, 0)
})

test('W63a over the cap is a stated refusal that reads no window, never a silent truncation', async () => {
  const cap = 300
  const exact = store(cap)
  const atCap = await collectAllFaceWindows({ cap, pageSize: 100, count: exact.count, page: exact.page })
  assert.equal(atCap.status, 'complete', 'exactly the cap is read')
  assert.equal(atCap.items.length, cap)

  const over = store(cap + 1)
  const refused = await collectAllFaceWindows({ cap, pageSize: 100, count: over.count, page: over.page })
  assert.equal(refused.status, 'over-cap')
  assert.equal(refused.reasonCode, 'FACE_WINDOW_LIMIT_EXCEEDED')
  assert.equal(refused.observed, cap + 1)
  assert.equal(refused.cap, cap)
  assert.equal(Object.hasOwn(refused, 'items'), false, 'a refused source hands back none of its windows')
  assert.equal(over.calls.pages.length, 0, 'the count is checked first: a source over the cap costs no window read')

  // windows written while the pages are being read can push a source past the cap: nothing already read is trusted
  const growing = store(cap + 40)
  const racy = await collectAllFaceWindows({ cap, pageSize: 100, count: async () => cap, page: growing.page })
  assert.equal(racy.status, 'over-cap')
  assert.equal(Object.hasOwn(racy, 'items'), false)
  assert.ok(racy.observed > cap)
})

test('W63a paging fails closed on a cursor that does not move, a page larger than asked and impossible limits', async () => {
  const stuck = { windowStartSourceFrame: 5, createdAt: '2026-10-19T00:00:00.000Z', id: 'window-stuck' }
  const rows = [{ id: 'a' }, { id: 'b' }]
  await assert.rejects(collectAllFaceWindows({ cap: 100, pageSize: 2, count: async () => 4, page: async () => ({ items: rows, next: stuck }) }),
    { code: 'PERSISTENCE_CONFLICT' })
  await assert.rejects(collectAllFaceWindows({ cap: 100, pageSize: 2, count: async () => 4, page: async () => ({ items: [...rows, { id: 'c' }], next: null }) }),
    { code: 'PERSISTENCE_CONFLICT' })
  for (const bad of [{ cap: -1, pageSize: 10 }, { cap: 10, pageSize: 0 }, { cap: 1.5, pageSize: 10 }]) {
    await assert.rejects(collectAllFaceWindows({ ...bad, count: async () => 0, page: async () => ({ items: [], next: null }) }), { code: 'INVALID_ARGUMENT' })
  }
  await assert.rejects(collectAllFaceWindows({ cap: 10, pageSize: 5, count: async () => -1, page: async () => ({ items: [], next: null }) }), { code: 'PERSISTENCE_CONFLICT' })
  const a = key(1)
  assert.equal(faceWindowCursorAdvanced(a, key(4)), true)
  assert.equal(faceWindowCursorAdvanced(a, a), false)
  assert.equal(faceWindowCursorAdvanced(key(4), key(1)), false)
  assert.equal(faceWindowCursorAdvanced(a, { ...a, createdAt: '2027-01-01T00:00:00.000Z' }), true)
  assert.equal(faceWindowCursorAdvanced(a, { ...a, id: 'other-id' }), true)
})

test('W63a the cap is one budget for the whole snapshot: sources are taken in id order and each gets what is left', async () => {
  let stores
  const run = (cap, ids = ['source-a', 'source-b', 'source-c', 'source-d']) => {
    stores = { 'source-a': store(300), 'source-b': store(500), 'source-c': store(150), 'source-d': store(0) }
    return collectFaceWindowsOfSources({ sourceArtifactIds: ids, cap, pageSize: 100,
      count: (id) => stores[id].count(), page: (id, after, limit) => stores[id].page(after, limit) })
  }
  const summary = (reads) => reads.map((read) => [read.sourceArtifactId, read.status, read.status === 'complete' ? read.items.length : read.observed])
  // 300 + 500 fit in 1000; source-c (150) no longer fits in the 200 that are left and is refused as a whole; source-d has nothing and fits
  assert.deepEqual(summary(await run(1000)), [['source-a', 'complete', 300], ['source-b', 'complete', 500], ['source-c', 'complete', 150], ['source-d', 'complete', 0]])
  assert.deepEqual(summary(await run(900)), [['source-a', 'complete', 300], ['source-b', 'complete', 500], ['source-c', 'over-cap', 150], ['source-d', 'complete', 0]])
  // a refused source spends nothing, so a later one that fits is still read; the order of the ids passed in does not matter
  assert.deepEqual(summary(await run(700)), [['source-a', 'complete', 300], ['source-b', 'over-cap', 500], ['source-c', 'complete', 150], ['source-d', 'complete', 0]])
  assert.deepEqual(summary(await run(700, ['source-d', 'source-c', 'source-b', 'source-a', 'source-a'])), summary(await run(700)))
  // an exhausted budget still reads a source that has no windows, and refuses one that has even one
  assert.deepEqual(summary(await run(450)), [['source-a', 'complete', 300], ['source-b', 'over-cap', 500], ['source-c', 'complete', 150], ['source-d', 'complete', 0]])
  const exhausted = await run(300)
  assert.deepEqual(summary(exhausted), [['source-a', 'complete', 300], ['source-b', 'over-cap', 500], ['source-c', 'over-cap', 150], ['source-d', 'complete', 0]])
  assert.ok(exhausted.every((read) => read.status === 'over-cap' ? read.reasonCode === 'FACE_WINDOW_LIMIT_EXCEEDED' && !Object.hasOwn(read, 'items') : true))
  // a refused source costs no window read (the stores are those of the last run, with 300 windows of budget)
  assert.equal(stores['source-b'].calls.pages.length, 0)
  assert.equal(stores['source-c'].calls.pages.length, 0)
  assert.ok(stores['source-a'].calls.pages.length > 0)
  assert.equal((await collectAllFaceWindows({ cap: 0, pageSize: 10, count: store(0).count, page: store(0).page })).status, 'complete')
  assert.equal((await collectAllFaceWindows({ cap: 0, pageSize: 10, count: store(1).count, page: store(1).page })).status, 'over-cap')
})
