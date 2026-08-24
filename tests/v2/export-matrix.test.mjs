import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createExportMatrixDefinition,
  createExportMatrixPreflight,
  deriveExportMatrixRuntimeStatus,
} from '../../src/v2/domain/export-matrix.ts'

const formats = ['9:16', '16:9', '4:5', '1:1', '21:9']

function definition() {
  return createExportMatrixDefinition({
    workspaceId: 'workspace-export-matrix',
    cells: formats.map((format, index) => ({
      recipeId: `recipe-${String(index + 1).padStart(2, '0')}`,
      projectId: `project-${format.replace(':', 'x')}`,
      projectVersionId: `version-${format.replace(':', 'x')}`,
      projectVersionHash: String(index + 1).repeat(64),
      format,
      locale: 'pt-BR',
    })),
  })
}

test('T-FR-235 creates five addressable cells with deterministic portable file and manifest names', () => {
  const first = definition()
  const second = createExportMatrixDefinition({
    workspaceId: first.workspaceId,
    cells: [...first.cells].reverse(),
  })

  assert.equal(first.definitionHash, second.definitionHash)
  assert.equal(first.cells.length, 5)
  assert.equal(new Set(first.cells.map((cell) => cell.address)).size, 5)
  assert.equal(new Set(first.cells.map((cell) => cell.id)).size, 5)
  assert.equal(new Set(first.cells.map((cell) => cell.outputFileName)).size, 5)
  assert.equal(new Set(first.cells.map((cell) => cell.manifestFileName)).size, 5)
  for (const cell of first.cells) {
    assert.match(cell.outputFileName, /^[a-z0-9._-]+(?:--[a-z0-9._-]+)+\.mp4$/)
    assert.match(cell.manifestFileName, /^[a-z0-9._-]+(?:--[a-z0-9._-]+)+\.manifest\.json$/)
    assert.match(cell.cellHash, /^[a-f0-9]{64}$/)
  }
})

test('T-FR-235 rejects duplicate recipe, format and locale addresses even across projects', () => {
  const cell = definition().cells[0]
  assert.throws(() => createExportMatrixDefinition({
    workspaceId: 'workspace-export-matrix',
    cells: [cell, { ...cell, projectId: 'another-project' }],
  }), /addresses must be unique/)
})

test('T-FR-235 preflight covers readiness, rights, cost and storage with server evidence', () => {
  const matrix = definition()
  const evidence = matrix.cells.map((cell, index) => ({
    cellId: cell.id,
    ready: index !== 1,
    rightsAllowed: index !== 2,
    durationFrames: 300,
    fps: 30,
    width: index === 0 ? 1080 : 1920,
    height: index === 0 ? 1920 : 1080,
    sourceFingerprint: String(index + 1).repeat(64),
  }))
  const result = createExportMatrixPreflight({
    definition: matrix,
    evidence,
    requestedMaximumCostMinorUnits: 1,
    requestedMaximumStorageBytes: 1,
    operatorMaximumCostMinorUnits: 1_000_000,
    operatorAvailableStorageBytes: 1_000_000_000,
    createdAt: '2026-08-24T18:00:00.000Z',
    expiresAt: '2026-08-24T18:10:00.000Z',
  })

  assert.equal(result.quantity, 5)
  assert.equal(result.allowed, false)
  assert.deepEqual(new Set(result.blockers.map((blocker) => blocker.code)), new Set([
    'CELL_NOT_READY', 'CELL_RIGHTS_BLOCKED', 'COST_LIMIT_EXCEEDED', 'STORAGE_LIMIT_EXCEEDED',
  ]))
  assert.match(result.snapshotHash, /^[a-f0-9]{64}$/)
  assert.match(result.costFingerprint, /^[a-f0-9]{64}$/)
  assert.match(result.preflightHash, /^[a-f0-9]{64}$/)
})

test('T-FR-235 derives partial failure without invalidating successful cells', () => {
  assert.equal(deriveExportMatrixRuntimeStatus(['ready', 'ready']), 'ready')
  assert.equal(deriveExportMatrixRuntimeStatus(['ready', 'failed', 'queued']), 'partially-failed')
  assert.equal(deriveExportMatrixRuntimeStatus(['running', 'queued']), 'running')
  assert.equal(deriveExportMatrixRuntimeStatus(['failed', 'failed']), 'failed')
})
