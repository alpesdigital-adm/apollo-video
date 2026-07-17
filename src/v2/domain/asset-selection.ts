import { createHash } from 'crypto'
import { DomainError } from './errors.ts'

export interface AssetBrief {
  intention: string
  content: readonly string[]
  style: readonly string[]
  durationMs: { min: number; max: number }
  entry: string
  exit: string
  prohibited: readonly string[]
}

export type AssetSource = 'library' | 'stock' | 'generated'
export interface AssetCandidate {
  id: string
  source: AssetSource
  content: readonly string[]
  style: readonly string[]
  durationMs: number
  rights: 'approved' | 'unknown' | 'denied'
  quality: number
  continuity: number
  novelty: number
}

export interface AssetEvaluation {
  candidateId: string
  source: AssetSource
  score: number
  verdict: 'accepted' | 'rejected'
  reasons: readonly string[]
  dimensions: Readonly<Record<'relevance' | 'continuity' | 'quality' | 'rights' | 'novelty', number>>
}

function overlap(wanted: readonly string[], actual: readonly string[]): number {
  if (wanted.length === 0) return 1
  const normalized = new Set(actual.map((item) => item.toLowerCase()))
  return wanted.filter((item) => normalized.has(item.toLowerCase())).length / wanted.length
}

export function evaluateAssetCandidate(brief: AssetBrief, candidate: AssetCandidate): AssetEvaluation {
  if (brief.durationMs.min <= 0 || brief.durationMs.max < brief.durationMs.min) {
    throw new DomainError('INVALID_ARGUMENT', 'AssetBrief duration range is invalid')
  }
  const relevance = overlap(brief.content, candidate.content)
  const styleFit = overlap(brief.style, candidate.style)
  const prohibited = brief.prohibited.some((term) => candidate.content.some((item) => item.toLowerCase().includes(term.toLowerCase())))
  const durationFit = candidate.durationMs >= brief.durationMs.min && candidate.durationMs <= brief.durationMs.max
  const rights = candidate.rights === 'approved' ? 1 : 0
  const novelty = candidate.novelty <= 0.75 ? 1 - Math.max(0, candidate.novelty - 0.45) : 0
  const dimensions = Object.freeze({ relevance, continuity: candidate.continuity, quality: candidate.quality, rights, novelty })
  const score = relevance * 0.32 + styleFit * 0.13 + candidate.continuity * 0.2 + candidate.quality * 0.15 + rights * 0.15 + novelty * 0.05
  const reasons = [
    ...(relevance < 0.5 ? ['irrelevant'] : []),
    ...(styleFit < 0.3 ? ['visual-conflict'] : []),
    ...(candidate.novelty > 0.75 ? ['too-literal-or-novel'] : []),
    ...(!durationFit ? ['duration-mismatch'] : []),
    ...(candidate.rights !== 'approved' ? ['rights-unavailable'] : []),
    ...(prohibited ? ['prohibited-element'] : []),
  ]
  return Object.freeze({ candidateId: candidate.id, source: candidate.source, score: Number(score.toFixed(4)), verdict: reasons.length === 0 && score >= 0.68 ? 'accepted' : 'rejected', reasons: Object.freeze(reasons), dimensions })
}

export function selectAsset(brief: AssetBrief, candidates: readonly AssetCandidate[]) {
  const sourceOrder: readonly AssetSource[] = ['library', 'stock', 'generated']
  const evaluations: AssetEvaluation[] = []
  for (const source of sourceOrder) {
    const sourceEvaluations = candidates.filter((candidate) => candidate.source === source).map((candidate) => evaluateAssetCandidate(brief, candidate)).sort((a, b) => b.score - a.score)
    evaluations.push(...sourceEvaluations)
    const accepted = sourceEvaluations.find((item) => item.verdict === 'accepted')
    if (accepted) return Object.freeze({ decision: 'use_asset' as const, selectedId: accepted.candidateId, source, evaluations: Object.freeze(evaluations), searchStoppedBefore: Object.freeze(sourceOrder.slice(sourceOrder.indexOf(source) + 1)), auditId: auditSelection(brief, evaluations) })
  }
  return Object.freeze({ decision: 'no_insert' as const, selectedId: null, source: null, evaluations: Object.freeze(evaluations), searchStoppedBefore: Object.freeze([] as AssetSource[]), auditId: auditSelection(brief, evaluations) })
}

function auditSelection(brief: AssetBrief, evaluations: readonly AssetEvaluation[]) {
  return `asset_selection_${createHash('sha256').update(JSON.stringify({ brief, evaluations })).digest('hex').slice(0, 16)}`
}
