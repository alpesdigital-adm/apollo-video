import { createHash } from 'crypto'

export type QualityIssue = Readonly<{ code: string; severity: 'hard' | 'warning'; category: 'technical' | 'policy' | 'integrity' | 'asset' | 'editorial'; rangeMs?: readonly [number, number]; targetId?: string; correctable: boolean }>
export interface QualityInput { technical: readonly QualityIssue[]; policy: readonly QualityIssue[]; integrity: readonly QualityIssue[]; assets: readonly QualityIssue[]; proxy: readonly QualityIssue[] }

export function validateQuality(input: QualityInput) {
  const issues = Object.freeze([...input.technical, ...input.policy, ...input.integrity, ...input.assets, ...input.proxy])
  const hardIssues = Object.freeze(issues.filter((issue) => issue.severity === 'hard'))
  return Object.freeze({ valid: hardIssues.length === 0, finalBlocked: hardIssues.length > 0, issues, hardIssues })
}

export function critiqueAsset(input: { relevance: number; continuity: number; quality: number; rightsApproved: boolean; novelty: number; rangeMs: readonly [number, number]; assetId: string }): readonly QualityIssue[] {
  return Object.freeze([
    ...(input.relevance < 0.6 ? [{ code: 'ASSET_IRRELEVANT', severity: 'hard', category: 'asset', rangeMs: input.rangeMs, targetId: input.assetId, correctable: true } as const] : []),
    ...(input.continuity < 0.6 ? [{ code: 'ASSET_CONTINUITY', severity: 'warning', category: 'asset', rangeMs: input.rangeMs, targetId: input.assetId, correctable: true } as const] : []),
    ...(input.quality < 0.6 ? [{ code: 'ASSET_QUALITY', severity: 'hard', category: 'technical', rangeMs: input.rangeMs, targetId: input.assetId, correctable: true } as const] : []),
    ...(!input.rightsApproved ? [{ code: 'ASSET_RIGHTS', severity: 'hard', category: 'policy', rangeMs: input.rangeMs, targetId: input.assetId, correctable: false } as const] : []),
    ...(input.novelty > 0.8 ? [{ code: 'ASSET_EXCESS_NOVELTY', severity: 'warning', category: 'editorial', rangeMs: input.rangeMs, targetId: input.assetId, correctable: true } as const] : []),
  ])
}

export function critiqueProxy(input: { format: string; rubric: Readonly<Record<string, number>>; ranges: readonly { startMs: number; endMs: number; density: number }[] }): readonly QualityIssue[] {
  const rubricIssues = Object.entries(input.rubric).filter(([, score]) => score < 0.65).map(([name]) => ({ code: `RUBRIC_${name.toUpperCase()}`, severity: 'warning', category: 'editorial', correctable: true } as const))
  const rangeIssues = input.ranges.filter((range) => range.density > 0.9).map((range) => ({ code: 'PATTERN_DENSITY', severity: 'warning', category: 'editorial', rangeMs: [range.startMs, range.endMs] as const, correctable: true } as const))
  return Object.freeze([{ code: `FORMAT_${input.format.replace(':', '_')}`, severity: 'warning', category: 'technical', correctable: true } as const, ...rubricIssues, ...rangeIssues])
}

export function compileQualityPatches(issues: readonly QualityIssue[]) {
  const eligible = issues.filter((issue) => issue.correctable)
  const ranges = eligible.flatMap((issue) => issue.rangeMs ? [issue.rangeMs] : [])
  const rerender = ranges.length === 0 ? null : [Math.min(...ranges.map(([start]) => start)), Math.max(...ranges.map(([, end]) => end))] as const
  return Object.freeze({ patches: Object.freeze(eligible.map((issue) => Object.freeze({ type: issue.category === 'asset' ? 'replace_asset' : 'adjust', targetId: issue.targetId ?? 'variant', issueCode: issue.code, rangeMs: issue.rangeMs }))), minimalRerenderRangeMs: rerender, ineligible: Object.freeze(issues.filter((issue) => !issue.correctable)) })
}

export type QualityTerminalReason = 'approval' | 'convergence' | 'budget' | 'uncorrectable' | 'human_review'
export function decideQualityIteration(input: { approved: boolean; scoreDelta: number; remainingBudget: number; issues: readonly QualityIssue[]; iteration: number }) {
  let terminalReason: QualityTerminalReason | null = null
  if (input.approved) terminalReason = 'approval'
  else if (input.issues.some((issue) => !issue.correctable && issue.severity === 'hard')) terminalReason = 'uncorrectable'
  else if (input.remainingBudget <= 0) terminalReason = 'budget'
  else if (input.iteration >= 2 && Math.abs(input.scoreDelta) < 0.01) terminalReason = 'convergence'
  else if (input.iteration >= 5) terminalReason = 'human_review'
  return Object.freeze({ continue: terminalReason === null, terminalReason })
}

export function createQualityReport(input: { versionId: string; datasetId: string; score: number; baselineScore: number; issues: readonly QualityIssue[] }) {
  const regression = Number((input.score - input.baselineScore).toFixed(4))
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return Object.freeze({ schemaVersion: 'quality-report/v1', id: `qr_${fingerprint.slice(0, 16)}`, versionId: input.versionId, datasetId: input.datasetId, score: input.score, baselineScore: input.baselineScore, regression, regressed: regression < 0, issues: Object.freeze([...input.issues]), fingerprint })
}
