import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAssetBrief,
  evaluateAssetCandidate,
  selectAsset,
} from '../../src/v2/domain/asset-selection.ts'
import { compileQualityPatches, createQualityReport, critiqueAsset, critiqueProxy, decideQualityIteration, validateQuality } from '../../src/v2/application/closed-quality-loop.ts'

const brief = { intention: 'explicar benefício', content: ['dashboard', 'resultado'], style: ['clean'], durationMs: { min: 1000, max: 5000 }, entry: 'cut', exit: 'cut', prohibited: ['dinheiro falso'] }
const candidate = (patch = {}) => ({
  id: 'library-1',
  source: 'library',
  content: ['dashboard', 'resultado'],
  style: ['clean'],
  durationMs: 2500,
  rights: 'approved',
  quality: .9,
  continuity: .85,
  novelty: .5,
  literalness: .2,
  ...patch,
})

test('T-FR-218 AssetBrief evaluates correct, literal, irrelevant and conflicting inserts', () => {
  assert.equal(evaluateAssetCandidate(brief, candidate()).verdict, 'accepted')
  assert.ok(evaluateAssetCandidate(brief, candidate({ id: 'literal', literalness: .95 })).reasons.includes('too-literal'))
  assert.ok(evaluateAssetCandidate(brief, candidate({ id: 'novel', novelty: .95 })).reasons.includes('excessive-novelty'))
  assert.ok(evaluateAssetCandidate(brief, candidate({ id: 'irrelevant', content: ['praia'] })).reasons.includes('irrelevant'))
  assert.ok(evaluateAssetCandidate(brief, candidate({ id: 'conflict', style: ['chaotic'] })).reasons.includes('visual-conflict'))
})

test('T-FR-218 searches library before stock/generation, audits rejects and supports no_insert', () => {
  const result = selectAsset(brief, [
    candidate({ id: 'stock', source: 'stock', quality: 1 }),
    candidate({ id: 'library-rejected', rights: 'denied' }),
    candidate(),
  ])
  assert.equal(result.selectedId, 'library-1'); assert.deepEqual(result.searchStoppedBefore, ['stock', 'generated'])
  assert.equal(result.evaluations.some((item) => item.candidateId === 'library-rejected'), true)
  assert.equal(result.evaluations.some((item) => item.candidateId === 'stock'), false)
  const none = selectAsset(brief, [candidate({ id: 'bad', rights: 'denied' })])
  assert.equal(none.decision, 'no_insert'); assert.equal(none.evaluations[0].verdict, 'rejected'); assert.match(none.auditId, /^asset_selection_/)
})

test('T-FR-218 validates AssetBrief and candidates strictly and produces deterministic audits', () => {
  const normalized = createAssetBrief({
    ...brief,
    intention: '  explicar   benefício ',
    content: ['DASHBOARD', 'RESULTADO'],
  })
  assert.equal(normalized.intention, 'explicar benefício')
  assert.deepEqual(normalized.content, ['dashboard', 'resultado'])
  assert.throws(() => createAssetBrief({ ...brief, content: [] }), /invalid number of terms/)
  assert.throws(() => selectAsset(brief, [candidate({ quality: 1.1 })]), /candidate is invalid/)
  assert.throws(() => selectAsset(brief, [candidate(), candidate()]), /identities must be unique/)
  const first = selectAsset(brief, [candidate({ id: 'library-b' }), candidate({ id: 'library-a' })])
  const second = selectAsset(brief, [candidate({ id: 'library-a' }), candidate({ id: 'library-b' })])
  assert.equal(first.selectedId, 'library-a')
  assert.equal(first.auditId, second.auditId)
})

test('T-FR-219 quality loop blocks hard technical/policy/integrity and critiques assets before insertion', () => {
  const issues = critiqueAsset({ relevance: .3, continuity: .9, quality: .9, rightsApproved: false, novelty: .4, rangeMs: [1000, 2500], assetId: 'asset-a1' })
  const validation = validateQuality({ technical: [], policy: issues.filter((item) => item.category === 'policy'), integrity: [{ code: 'CLAIM', severity: 'hard', category: 'integrity', correctable: false }], assets: issues, proxy: [] })
  assert.equal(validation.finalBlocked, true)
  assert.ok(validation.hardIssues.some((item) => item.code === 'ASSET_RIGHTS'))
  assert.equal(validation.hardByCategory.policy, 1)
  assert.equal(validation.hardByCategory.integrity, 1)
})

test('T-FR-219 proxy critic localizes issues and compiler requests only minimal rerender', () => {
  const issues = critiqueProxy({
    format: '9:16',
    spec: { width: 960, height: 540 },
    rubric: { hook: .4, clarity: .9 },
    ranges: [
      { startMs: 2000, endMs: 3500, density: .95 },
      { startMs: 7000, endMs: 7500, density: .96 },
    ],
  })
  const compiled = compileQualityPatches(issues)
  assert.deepEqual(compiled.minimalRerenderRangesMs, [[2000, 3500], [7000, 7500]])
  assert.deepEqual(compiled.minimalRerenderRangeMs, [2000, 7500])
  assert.equal(compiled.fullRerenderRequired, true)
  assert.ok(compiled.patches.some((item) => item.issueCode === 'PATTERN_DENSITY'))
  assert.ok(issues.some((item) => item.code === 'PROXY_FORMAT_MISMATCH' && item.severity === 'hard'))
})

test('T-FR-219 closes on every terminal reason and versions regression reports', () => {
  const base = { approved: false, scoreDelta: .2, remainingBudget: 1, issues: [], iteration: 1 }
  assert.equal(decideQualityIteration({ ...base, approved: true }).terminalReason, 'approval')
  assert.equal(decideQualityIteration({ ...base, iteration: 2, scoreDelta: 0 }).terminalReason, 'convergence')
  assert.equal(decideQualityIteration({ ...base, remainingBudget: 0 }).terminalReason, 'budget')
  assert.equal(decideQualityIteration({ ...base, issues: [{ code: 'POLICY_X', severity: 'hard', category: 'policy', correctable: false }] }).terminalReason, 'uncorrectable')
  assert.equal(decideQualityIteration({ ...base, iteration: 5 }).terminalReason, 'human_review')
  const report = createQualityReport({ versionId: 'version-2', datasetId: 'reference-v1', score: 80, baselineScore: 85, issues: [] })
  assert.equal(report.regressed, true); assert.match(report.id, /^quality-report-/)
})
