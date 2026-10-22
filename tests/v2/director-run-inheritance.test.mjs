import assert from 'node:assert/strict'
import test from 'node:test'

const {
  DIRECTOR_INHERITANCE_BLOCK_REASONS,
  INHERITING_COMMAND_TYPES,
  MAX_DIRECTOR_INHERITANCE_DEPTH,
  createDirectorRunInheritance,
  describeDirectorInheritanceBlock,
  directorRunInheritanceEquals,
  directorRunInheritanceIdentity,
  parseDirectorRunInheritance,
  walkDirectorInheritance,
} = await import('../../src/v2/domain/director-run-inheritance.ts')

/**
 * W70 readiness. The rule that lets a Version made by an exception Command carry the quality of the DirectorRun of its ancestor, and ONLY
 * that: the walk is pure over a reader, so every refusal is proved here without a database; the PostgreSQL proof is
 * `director-run-inheritance.pg.integration.mjs`.
 */
const SUBTITLE = 'apply-subtitle-segment-override'
const REFRAME = 'apply-variant-reframe-override'

/** A project line: versions[0] is the root. `directed` lists the versions a succeeded DirectorRun produced. */
function world(versions, { directed = [] } = {}) {
  const byId = new Map(versions.map((version) => [version.versionId, Object.freeze({ plan: 'plan-1', ...version })]))
  const reads = []
  return {
    reads,
    reader: {
      async isDirectorResult(versionId) { return directed.includes(versionId) },
      async readVersion(versionId) {
        reads.push(versionId)
        const version = byId.get(versionId)
        if (!version) return null
        return Object.freeze({
          versionId: version.versionId, parentVersionId: version.parentVersionId ?? null,
          commandId: version.commandId ?? null, commandType: version.commandType ?? null,
          commandBaseVersionId: version.commandBaseVersionId ?? version.parentVersionId ?? null,
          planContentHash: version.plan,
        })
      },
    },
  }
}

const line = (types, { plan = () => 'plan-1' } = {}) => [
  { versionId: 'version-0', parentVersionId: null, commandId: 'command-director', commandType: 'run-director', plan: plan(0) },
  ...types.map((type, index) => ({
    versionId: `version-${index + 1}`, parentVersionId: `version-${index}`, commandId: `command-${index + 1}`, commandType: type, plan: plan(index + 1),
  })),
]

test('W70 a Version that is the Director result needs no inheritance', async () => {
  const { reader } = world(line([]), { directed: ['version-0'] })
  assert.deepEqual(await walkDirectorInheritance(reader, 'version-0'), { kind: 'direct', directorResultVersionId: 'version-0' })
})

test('W70 exception Commands let the quality of the Director run pass, naming every Version and Command it went through', async () => {
  const { reader } = world(line([SUBTITLE, REFRAME, SUBTITLE]), { directed: ['version-0'] })
  const walk = await walkDirectorInheritance(reader, 'version-3')
  assert.equal(walk.kind, 'inherited')
  assert.equal(walk.inheritance.directorResultVersionId, 'version-0')
  assert.deepEqual([...walk.inheritance.inheritedThroughVersionIds], ['version-3', 'version-2', 'version-1'], 'from the Version asked for back to the one before the Director result')
  assert.deepEqual([...walk.inheritance.inheritedThroughCommandIds], ['command-3', 'command-2', 'command-1'])
  assert.match(walk.inheritance.inheritanceHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(parseDirectorRunInheritance(JSON.parse(JSON.stringify(walk.inheritance))), walk.inheritance, 'a stored receipt reads back as the same document')
  const identity = directorRunInheritanceIdentity(walk.inheritance)
  assert.deepEqual([...identity.inheritedThroughVersionIds], ['version-3', 'version-2', 'version-1'])
  assert.equal(directorRunInheritanceIdentity(null), null, 'a Director-own Version has no inheritance identity: every earlier hash keeps its shape')
})

test('W70 the walk stops, with a precise reason, at the first Command that is not an allowed exception Command', async () => {
  const allowed = [SUBTITLE, REFRAME]
  assert.deepEqual([...INHERITING_COMMAND_TYPES].sort(), [...allowed].sort(), 'the allow list is exactly the two exception Commands')
  for (const type of ['apply-review-patch', 'apply-editorial-cut', 'set-project-subtitle-mode', 'set-project-policy-overrides', 'replace-source-transcript', 'set-project-lut-selection', 'compile-renderable-plan', 'compare-action', 'direct-multicam-session']) {
    // an allowed exception sits on top of the disallowed one: the walk reaches it and stops there, never past it
    const { reader } = world(line([type, SUBTITLE]), { directed: ['version-0'] })
    const walk = await walkDirectorInheritance(reader, 'version-2')
    assert.deepEqual(walk, { kind: 'blocked', reason: 'command-not-inheriting', versionId: 'version-1', commandId: 'command-1', commandType: type }, type)
    assert.match(describeDirectorInheritanceBlock(walk), new RegExp(type))
    // and the disallowed Command asked for directly
    const direct = await walkDirectorInheritance(world(line([type]), { directed: ['version-0'] }).reader, 'version-1')
    assert.equal(direct.kind, 'blocked'); assert.equal(direct.commandType, type)
  }
})

test('W70 a Director run behind a disallowed Command is NOT reached: the walk never reads past a Command it does not know', async () => {
  const { reader, reads } = world([
    ...line([]).slice(0, 1),
    { versionId: 'version-1', parentVersionId: 'version-0', commandId: 'command-1', commandType: 'apply-review-patch' },
    { versionId: 'version-2', parentVersionId: 'version-1', commandId: 'command-2', commandType: SUBTITLE },
  ], { directed: ['version-0'] })
  const walk = await walkDirectorInheritance(reader, 'version-2')
  assert.equal(walk.kind, 'blocked')
  assert.equal(reads.includes('version-0'), false, 'the Version with the run was never even read')
})

test('W70 a Version that is not the Director result but has no Command, a Command not based on its parent, a missing parent or a moved EditPlan is refused', async () => {
  const noCommand = [{ versionId: 'v-0', parentVersionId: null }, { versionId: 'v-1', parentVersionId: 'v-0' }]
  assert.deepEqual(await walkDirectorInheritance(world(noCommand, { directed: ['v-0'] }).reader, 'v-1'), { kind: 'blocked', reason: 'version-without-command', versionId: 'v-1' })

  const wrongBase = [{ versionId: 'v-0', parentVersionId: null }, { versionId: 'v-1', parentVersionId: 'v-0', commandId: 'c-1', commandType: SUBTITLE, commandBaseVersionId: 'v-other' }]
  assert.equal((await walkDirectorInheritance(world(wrongBase, { directed: ['v-0'] }).reader, 'v-1')).reason, 'command-base-mismatch')

  const orphan = [{ versionId: 'v-1', parentVersionId: 'v-missing', commandId: 'c-1', commandType: SUBTITLE }]
  assert.equal((await walkDirectorInheritance(world(orphan).reader, 'v-1')).reason, 'parent-missing')

  const moved = line([SUBTITLE], { plan: (index) => index === 0 ? 'plan-director' : 'plan-edited' })
  const walk = await walkDirectorInheritance(world(moved, { directed: ['version-0'] }).reader, 'version-1')
  assert.deepEqual(walk, { kind: 'blocked', reason: 'edit-plan-moved', versionId: 'version-1', commandId: 'command-1', commandType: SUBTITLE },
    'a Version labelled with an allowed Command whose EditPlan is not its parent\'s is not an exception Version')
  assert.equal(DIRECTOR_INHERITANCE_BLOCK_REASONS.every((reason) => describeDirectorInheritanceBlock({ kind: 'blocked', reason, versionId: 'v-1', commandType: SUBTITLE }).length > 10), true)
})

test('W70 no reachable Director run is "none", not a refusal; the chain is bounded', async () => {
  assert.deepEqual(await walkDirectorInheritance(world(line([SUBTITLE])).reader, 'version-1'), { kind: 'none' }, 'the root is reached and no run exists')
  assert.deepEqual(await walkDirectorInheritance(world(line([])).reader, 'version-unknown'), { kind: 'none' })
  // A stop is a refusal only when a Director quality is behind it: a manual edit, a review patch or a Director Command whose run did not
  // succeed, on a line nothing ever directed, is simply not directed (nothing approves it, as before inheritance existed).
  for (const type of ['apply-review-patch', 'run-director', 'set-project-lut-selection']) {
    assert.deepEqual(await walkDirectorInheritance(world(line([type, SUBTITLE])).reader, 'version-2'), { kind: 'none' }, `${type} on an undirected line`)
    assert.deepEqual(await walkDirectorInheritance(world(line([type])).reader, 'version-1'), { kind: 'none' }, `${type} asked for directly`)
  }
  assert.deepEqual(await walkDirectorInheritance(world([{ versionId: 'v-0', parentVersionId: null }, { versionId: 'v-1', parentVersionId: 'v-0' }]).reader, 'v-1'), { kind: 'none' },
    'a Version without a Command on an undirected line')
  // and a reader that knows the whole line answers the same question at once
  const directedAbove = []
  const fast = world(line(['apply-review-patch']), { directed: ['version-0'] })
  const reader = { ...fast.reader, async isDirectedAtOrAbove(versionId) { directedAbove.push(versionId); return versionId === 'version-0' } }
  assert.equal((await walkDirectorInheritance(reader, 'version-1')).kind, 'blocked')
  assert.deepEqual(directedAbove, ['version-0'], 'asked once, for the Version above the stop')

  const many = MAX_DIRECTOR_INHERITANCE_DEPTH
  const exactly = await walkDirectorInheritance(world(line(Array.from({ length: many }, () => SUBTITLE)), { directed: ['version-0'] }).reader, `version-${many}`)
  assert.equal(exactly.kind, 'inherited'); assert.equal(exactly.inheritance.inheritedThroughVersionIds.length, many)
  const tooMany = await walkDirectorInheritance(world(line(Array.from({ length: many + 1 }, () => SUBTITLE)), { directed: ['version-0'] }).reader, `version-${many + 1}`)
  assert.equal(tooMany.kind, 'blocked'); assert.equal(tooMany.reason, 'chain-too-long')
})

test('W70 the receipt cannot be edited: any change to the Versions, the Commands, the Director Version or the hash makes it unreadable', async () => {
  const { reader } = world(line([SUBTITLE, REFRAME]), { directed: ['version-0'] })
  const { inheritance } = await walkDirectorInheritance(reader, 'version-2')
  const plain = JSON.parse(JSON.stringify(inheritance))
  assert.deepEqual(parseDirectorRunInheritance(plain), inheritance)
  const tampered = [
    { ...plain, inheritedThroughCommandIds: ['command-2', 'command-1-forged'] },
    { ...plain, inheritedThroughCommandIds: [...plain.inheritedThroughCommandIds].reverse() },
    { ...plain, inheritedThroughVersionIds: ['version-2'], inheritedThroughCommandIds: ['command-2'] },
    { ...plain, directorResultVersionId: 'version-1' },
    { ...plain, directorResultVersionId: 'version-elsewhere' },
    { ...plain, inheritanceHash: '0'.repeat(64) },
    { ...plain, inheritedThroughVersionIds: ['version-2', 'version-2'] },
    { ...plain, inheritedThroughVersionIds: [], inheritedThroughCommandIds: [] },
    { ...plain, schemaVersion: 'director-run-inheritance/v0' },
    { ...plain, extra: true },
    null, 'text', [],
  ]
  for (const candidate of tampered) {
    assert.throws(() => parseDirectorRunInheritance(candidate), (error) => error.code === 'PERSISTENCE_CONFLICT', JSON.stringify(candidate)?.slice(0, 80))
  }
  assert.throws(() => createDirectorRunInheritance({ directorResultVersionId: 'version-0', links: [] }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  assert.equal(directorRunInheritanceEquals(inheritance, parseDirectorRunInheritance(plain)), true)
  assert.equal(directorRunInheritanceEquals(inheritance, null), false)
  assert.equal(directorRunInheritanceEquals(null, undefined), true, 'two Director-own Versions agree')
  const other = createDirectorRunInheritance({ directorResultVersionId: 'version-0', links: [{ versionId: 'version-2', commandId: 'command-2' }, { versionId: 'version-1', commandId: 'command-other' }] })
  assert.equal(directorRunInheritanceEquals(inheritance, other), false, 'the same Versions through another Command are another inheritance')
})
