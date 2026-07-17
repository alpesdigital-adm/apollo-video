import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAssetCandidate, selectAsset } from '../../src/v2/domain/asset-selection.ts'
import { compileQualityPatches, createQualityReport, critiqueAsset, critiqueProxy, decideQualityIteration, validateQuality } from '../../src/v2/application/closed-quality-loop.ts'

const brief = { intention: 'explicar benefício', content: ['dashboard', 'resultado'], style: ['clean'], durationMs: { min: 1000, max: 5000 }, entry: 'cut', exit: 'cut', prohibited: ['dinheiro falso'] }
const candidate = (patch = {}) => ({ id: 'library-1', source: 'library', content: ['dashboard', 'resultado'], style: ['clean'], durationMs: 2500, rights: 'approved', quality: .9, continuity: .85, novelty: .5, ...patch })

test('T-FR-218 AssetBrief evaluates correct, literal, irrelevant and conflicting inserts', () => {
  assert.equal(evaluateAssetCandidate(brief, candidate()).verdict, 'accepted')
  assert.ok(evaluateAssetCandidate(brief, candidate({ id: 'literal', novelty: .95 })).reasons.includes('too-literal-or-novel'))
  assert.ok(evaluateAssetCandidate(brief, candidate({ id: 'irrelevant', content: ['praia'] })).reasons.includes('irrelevant'))
  assert.ok(evaluateAssetCandidate(brief, candidate({ id: 'conflict', style: ['chaotic'] })).reasons.includes('visual-conflict'))
})

test('T-FR-218 searches library before stock/generation, audits rejects and supports no_insert', () => {
  const result = selectAsset(brief, [candidate({ id: 'stock', source: 'stock' }), candidate()])
  assert.equal(result.selectedId, 'library-1'); assert.deepEqual(result.searchStoppedBefore, ['stock', 'generated'])
  const none = selectAsset(brief, [candidate({ id: 'bad', rights: 'denied' })])
  assert.equal(none.decision, 'no_insert'); assert.equal(none.evaluations[0].verdict, 'rejected'); assert.match(none.auditId, /^asset_selection_/)
})

test('T-FR-219 quality loop blocks hard technical/policy/integrity and critiques assets before insertion', () => {
  const issues = critiqueAsset({ relevance: .3, continuity: .9, quality: .9, rightsApproved: false, novelty: .4, rangeMs: [1000, 2500], assetId: 'a1' })
  const validation = validateQuality({ technical: [], policy: issues.filter((item) => item.category === 'policy'), integrity: [{ code: 'CLAIM', severity: 'hard', category: 'integrity', correctable: false }], assets: issues, proxy: [] })
  assert.equal(validation.finalBlocked, true); assert.ok(validation.hardIssues.some((item) => item.code === 'ASSET_RIGHTS'))
})

test('T-FR-219 proxy critic localizes issues and compiler requests only minimal rerender', () => {
  const issues = critiqueProxy({ format: '9:16', rubric: { hook: .4, clarity: .9 }, ranges: [{ startMs: 2000, endMs: 3500, density: .95 }] })
  const compiled = compileQualityPatches(issues)
  assert.deepEqual(compiled.minimalRerenderRangeMs, [2000, 3500]); assert.ok(compiled.patches.some((item) => item.issueCode === 'PATTERN_DENSITY'))
})

test('T-FR-219 closes on every terminal reason and versions regression reports', () => {
  const base = { approved: false, scoreDelta: .2, remainingBudget: 1, issues: [], iteration: 1 }
  assert.equal(decideQualityIteration({ ...base, approved: true }).terminalReason, 'approval')
  assert.equal(decideQualityIteration({ ...base, iteration: 2, scoreDelta: 0 }).terminalReason, 'convergence')
  assert.equal(decideQualityIteration({ ...base, remainingBudget: 0 }).terminalReason, 'budget')
  assert.equal(decideQualityIteration({ ...base, issues: [{ code: 'X', severity: 'hard', category: 'policy', correctable: false }] }).terminalReason, 'uncorrectable')
  assert.equal(decideQualityIteration({ ...base, iteration: 5 }).terminalReason, 'human_review')
  const report = createQualityReport({ versionId: 'v2', datasetId: 'reference-v1', score: .8, baselineScore: .85, issues: [] })
  assert.equal(report.regressed, true); assert.match(report.id, /^qr_/)
})
