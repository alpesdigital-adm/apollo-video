import assert from 'node:assert/strict'
import test from 'node:test'

import {
  capSyntheticPhaseGateHistory,
  classifySyntheticPhaseGateSnapshot,
  insertSyntheticPhaseGateFirst,
  NO_SYNTHETIC_PHASE_GATE_SELECTION,
  reconcileSyntheticPhaseGateSelection,
  SYNTHETIC_PHASE_GATE_HISTORY_LIMIT,
} from '../../src/v2/ui/synthetic-phase-gate-history.ts'

const gate = (id, overrides = {}) => ({
  id,
  projectVersionId: 'version-2',
  projectVersionHash: 'hash-2',
  createdAt: '2026-09-25T12:00:00.000Z',
  ...overrides,
})

// Deliberately not chronological: the server order is the only order, so a
// local sort by `createdAt` would be visible as a reordering here.
const serverOrdered = (count) => Array.from({ length: count }, (_, index) =>
  gate(`gate-${String(index).padStart(2, '0')}`, {
    createdAt: new Date(Date.UTC(2026, 8, 1 + ((index * 7) % 28))).toISOString(),
  }))

const ids = (gates) => gates.map(({ id }) => id)

test('W25 the history keeps the server order and never shows more than twenty gates', () => {
  assert.equal(SYNTHETIC_PHASE_GATE_HISTORY_LIMIT, 20)
  const response = serverOrdered(25)
  const frozen = Object.freeze([...response])
  const visible = capSyntheticPhaseGateHistory(frozen)
  assert.equal(visible.length, 20)
  assert.deepEqual(ids(visible), ids(response).slice(0, 20))
  assert.equal(visible[0], response[0], 'the first option is the first gate of the response')
  assert.deepEqual(ids(frozen), ids(response), 'the input is not reordered or mutated')

  const short = serverOrdered(3)
  assert.deepEqual(ids(capSyntheticPhaseGateHistory(short)), ids(short))
  assert.notEqual(capSyntheticPhaseGateHistory(short), short, 'the cap returns its own array')
  assert.deepEqual(capSyntheticPhaseGateHistory([]), [])
})

test('W25 an evaluated gate is inserted first, or replaced in place when it is a replay', () => {
  const current = Object.freeze(serverOrdered(4))
  const fresh = gate('gate-new')
  assert.deepEqual(ids(insertSyntheticPhaseGateFirst(current, fresh)), ['gate-new', ...ids(current)])

  const replay = gate('gate-02', { recordHash: 'replayed' })
  const replaced = insertSyntheticPhaseGateFirst(current, replay)
  assert.deepEqual(ids(replaced), ids(current), 'an idempotent replay does not reorder the list')
  assert.equal(replaced[2], replay, 'the replayed entry is the one returned by the server')
  assert.equal(replaced.filter(({ id }) => id === 'gate-02').length, 1, 'no duplicate id')
  assert.equal(current[2].recordHash, undefined, 'the list on screen is not mutated')

  const full = serverOrdered(20)
  const inserted = insertSyntheticPhaseGateFirst(full, fresh)
  assert.equal(inserted.length, 20, 'the insert keeps the visual limit')
  assert.deepEqual(ids(inserted), ['gate-new', ...ids(full).slice(0, 19)])

  assert.deepEqual(ids(insertSyntheticPhaseGateFirst([], fresh)), ['gate-new'])
})

test('W25 without a pin the selection is the first gate of the list that landed', () => {
  const list = serverOrdered(3)
  assert.deepEqual(
    reconcileSyntheticPhaseGateSelection(list, NO_SYNTHETIC_PHASE_GATE_SELECTION),
    { selectedGateId: 'gate-00', selectionPinned: null },
  )
  // An unpinned selection is only the previous "first": a newer list moves it.
  assert.deepEqual(
    reconcileSyntheticPhaseGateSelection(list, { selectedGateId: 'gate-02', selectionPinned: null }),
    { selectedGateId: 'gate-00', selectionPinned: null },
  )
  assert.deepEqual(
    reconcileSyntheticPhaseGateSelection([], { selectedGateId: 'gate-02', selectionPinned: 'user' }),
    { selectedGateId: null, selectionPinned: null },
  )
})

test('W25 a pinned selection survives every later list that still contains it', () => {
  const later = [gate('gate-newer'), ...serverOrdered(3)]
  for (const selectionPinned of ['user', 'mutation']) {
    const pinned = Object.freeze({ selectedGateId: 'gate-01', selectionPinned })
    assert.deepEqual(
      reconcileSyntheticPhaseGateSelection(later, pinned),
      { selectedGateId: 'gate-01', selectionPinned },
      `a ${selectionPinned} pin is kept although a newer gate is now first`,
    )
  }
})

test('W25 a pinned gate absent from the list falls back to the first gate and unpins', () => {
  const list = serverOrdered(3)
  for (const selectionPinned of ['user', 'mutation']) {
    assert.deepEqual(
      reconcileSyntheticPhaseGateSelection(list, { selectedGateId: 'gate-gone', selectionPinned }),
      { selectedGateId: 'gate-00', selectionPinned: null },
    )
  }
})

test('W25 evaluate, then the canonical reload: the evaluated gate stays selected', () => {
  const onScreen = serverOrdered(20)
  const evaluated = gate('gate-evaluated')
  const optimistic = insertSyntheticPhaseGateFirst(onScreen, evaluated)
  const pinned = { selectedGateId: evaluated.id, selectionPinned: 'mutation' }

  // A concurrent evaluation by another client is newer than ours: the server
  // puts it first, and ours is still listed.
  const canonical = capSyntheticPhaseGateHistory([gate('gate-other-client'), evaluated, ...onScreen])
  assert.equal(canonical.length, 20)
  assert.deepEqual(reconcileSyntheticPhaseGateSelection(canonical, pinned), pinned)

  // The operator picks an older gate afterwards; the next list keeps it.
  const userPinned = { selectedGateId: optimistic[5].id, selectionPinned: 'user' }
  assert.deepEqual(reconcileSyntheticPhaseGateSelection(canonical, userPinned), userPinned)
})

test('W25 the selected gate is exactly one of divergent, historical or latest', () => {
  const editor = { projectVersionId: 'version-2', projectVersionHash: 'hash-2' }
  const latest = gate('gate-latest')
  const older = gate('gate-older')
  const otherVersion = gate('gate-other-version', { projectVersionId: 'version-1' })
  const otherHash = gate('gate-other-hash', { projectVersionHash: 'hash-1' })
  const gates = [latest, older, otherVersion, otherHash]

  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: latest, gates }), 'latest')
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: older, gates }), 'historical')
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: otherVersion, gates }), 'divergent')
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: otherHash, gates }), 'divergent')

  // Divergence wins regardless of the position in the list.
  const divergentFirst = [otherVersion, latest]
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: otherVersion, gates: divergentFirst }), 'divergent')
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: otherHash, gates: [otherHash] }), 'divergent')
  // Same version and hash behind a newer gate of another version is historical:
  // a more recent evaluation exists in the list.
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: latest, gates: divergentFirst }), 'historical')

  // Recency is the received order only: neither `createdAt` nor the id (a
  // random `spg-<uuid>`, whose `id desc` tiebreak is arbitrary) is consulted.
  const first = gate('spg-0000', { createdAt: '2026-01-01T00:00:00.000Z' })
  const second = gate('spg-ffff', { createdAt: '2026-12-31T00:00:00.000Z' })
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: first, gates: [first, second] }), 'latest')
  assert.equal(classifySyntheticPhaseGateSnapshot({ ...editor, gate: second, gates: [first, second] }), 'historical')
  assert.deepEqual(
    reconcileSyntheticPhaseGateSelection([first, second], NO_SYNTHETIC_PHASE_GATE_SELECTION),
    { selectedGateId: 'spg-0000', selectionPinned: null },
  )
})
