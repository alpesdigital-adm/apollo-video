import assert from 'node:assert/strict'
import test from 'node:test'
import { STRATEGIC_OBJECTIVES, changeDirectorRunObjective, createDirectorRunObjective, resolveStrategicObjective } from '../../src/v2/domain/strategic-objective.ts'

test('all eight strategic objectives resolve to their own rubric and usable UI guidance', () => {
  assert.equal(STRATEGIC_OBJECTIVES.length, 8)
  for (const fixture of STRATEGIC_OBJECTIVES) {
    const objective = resolveStrategicObjective(fixture.id)
    assert.equal(objective.rubricId, fixture.rubricId)
    assert.ok(objective.description.length > 20)
    assert.ok(objective.exampleOutcome.length > 20)
  }
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
