import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

/**
 * The commit of an operational State runs its integrity assertion twice (the deferred flush and the explicit verification) inside a transaction
 * whose statements are held to 10 s. An assertion that grows with the size of what the project carries (a long master is a multi-megabyte State)
 * turns into a production failure long before it fails a test on an idle machine, so the journeys measure it on the State they just committed.
 *
 * Measures `w66_assert_operational_state_v3` for the State of `versionId` `runs` times, each a statement of its own (the verdict is only reused
 * inside one statement), and fails when even the fastest run takes more than `budgetMs`. The minimum is the robust statistic here: a busy
 * machine inflates a run, it cannot make one faster than the assertion costs.
 */
export async function measureStateAssertion(client, versionId, { runs = 3, budgetMs = 8_000 } = {}) {
  assert.ok(runs >= 3, 'a measurement needs at least three runs')
  const [row] = await client.$queryRawUnsafe('SELECT "outputStateId" AS id, length(s."stateJson")::int AS bytes FROM project_versions v JOIN project_output_states s ON s.id = v."outputStateId" WHERE v.id = $1', versionId)
  assert.ok(row?.id, `version ${versionId} has no output State`)
  const timings = []
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now()
    await client.$queryRawUnsafe('SELECT w66_assert_operational_state_v3($1)::text AS verdict', row.id)
    timings.push(performance.now() - started)
  }
  const sorted = timings.toSorted((a, b) => a - b)
  const round = (value) => Math.round(value)
  const result = { stateId: row.id, stateBytes: row.bytes, runs, minMs: round(sorted[0]), medianMs: round(sorted[Math.floor(sorted.length / 2)]), maxMs: round(sorted.at(-1)), budgetMs }
  assert.ok(result.minMs < budgetMs, `the State assertion costs ${result.minMs} ms at best, over the ${budgetMs} ms the 10 s commit budget leaves it: ${JSON.stringify(result)}`)
  return result
}
