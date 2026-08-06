import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { STRATEGIC_OBJECTIVES, bindDirectorObjective, changeDirectorRunObjective, createDirectorRunObjective, resolveStrategicObjective } from '../../src/v2/domain/strategic-objective.ts'

test('all eight strategic objectives resolve to their own rubric and usable UI guidance', () => {
  assert.equal(STRATEGIC_OBJECTIVES.length, 8)
  for (const fixture of STRATEGIC_OBJECTIVES) {
    const objective = resolveStrategicObjective(fixture.id)
    assert.equal(objective.rubricId, fixture.rubricId)
    assert.ok(objective.description.length > 20)
    assert.ok(objective.exampleOutcome.length > 20)
  }
})

test('runtime objective binding preserves a rubric revision and supersedes only approved changes', () => {
  const initial = bindDirectorObjective({ objective: 'discovery' })
  assert.deepEqual(initial, {
    objective: 'discovery',
    rubricRef: 'awareness-discovery/v1',
    objectiveVersion: 1,
  })
  const same = bindDirectorObjective({
    objective: 'discovery',
    previous: {
      runId: 'director-run-1',
      ...initial,
      approved: true,
    },
  })
  assert.deepEqual(same, initial)
  const changed = bindDirectorObjective({
    objective: 'sale',
    previous: {
      runId: 'director-run-1',
      ...initial,
      approved: true,
    },
  })
  assert.deepEqual(changed, {
    objective: 'sale',
    rubricRef: 'conversion-sale/v1',
    objectiveVersion: 2,
    supersedesRunId: 'director-run-1',
  })
  assert.throws(() => bindDirectorObjective({
    objective: 'sale',
    previous: {
      runId: 'director-run-1',
      ...initial,
      approved: false,
    },
  }), /unapproved Director objective/)
  assert.throws(() => bindDirectorObjective({
    objective: 'sale',
    previous: {
      runId: 'director-run-1',
      ...initial,
      rubricRef: 'conversion-sale/v1',
      approved: true,
    },
  }), /binding is invalid/)
})

test('approved objective change creates a new DirectorRun while draft change stays in version', () => {
  const draft = createDirectorRunObjective({ runId: 'run-1', projectId: 'project-1', objective: 'discovery' })
  const changedDraft = changeDirectorRunObjective(draft, { objective: 'warming', nextRunId: 'unused' })
  assert.equal(changedDraft.runId, 'run-1')
  assert.equal(changedDraft.rubricRef, 'awareness-warming/v1')
  const approved = Object.freeze({ ...changedDraft, state: 'approved' })
  const rerun = changeDirectorRunObjective(approved, { objective: 'sale', nextRunId: 'run-2' })
  assert.equal(rerun.version, 2)
  assert.equal(rerun.supersedesRunId, 'run-1')
  assert.equal(rerun.rubricRef, 'conversion-sale/v1')
})

test('objective binding migration constrains only columns owned by each table', async () => {
  const sql = await readFile(new URL(
    '../../prisma/v2/migrations/20260806200000_director_objective_binding/migration.sql',
    import.meta.url,
  ), 'utf8')
  const directorConstraint = sql.match(
    /ADD CONSTRAINT "director_runs_objective_binding_check" CHECK \(([\s\S]*?)\n  \);/,
  )?.[1]
  const operationConstraint = sql.match(
    /ADD CONSTRAINT "project_director_operations_objective_binding_check" CHECK \(([\s\S]*?)\n  \);/,
  )?.[1]
  assert.ok(directorConstraint)
  assert.doesNotMatch(directorConstraint, /"baseObjective"/)
  assert.match(directorConstraint, /"objective" IN/)
  assert.ok(operationConstraint)
  assert.match(operationConstraint, /"baseObjective" IN/)
  assert.match(operationConstraint, /"objective" IN/)
  assert.match(sql, /CREATE INDEX "director_runs_objective_revision_idx"/)
  assert.match(sql, /CONSTRAINT "project_director_ops_supersedes_run_fkey"/)
})
