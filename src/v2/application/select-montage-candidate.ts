export interface MontageCandidateSeed { id: string; hookId: string; blockOrder: readonly string[]; assetIds: readonly string[]; patternBreakIds: readonly string[]; confidence: number; hardGateIssues: readonly string[]; rubricSignals: Readonly<Record<string, number>> }
export interface EvaluatedMontageCandidate extends MontageCandidateSeed { status: 'eligible' | 'rejected'; score: number | null; estimatedCost: number | null; rejectionReasons: readonly string[] }
export interface MontageSelection { status: 'selected' | 'review' | 'blocked'; winnerId: string | null; reason: string; diversity: { uniqueHooks: number; uniqueOrders: number; uniqueAssetSets: number; uniquePatternSets: number }; candidates: readonly EvaluatedMontageCandidate[] }

export function selectMontageCandidate(input: { seeds: readonly MontageCandidateSeed[]; rubric: { id: string; weights: Readonly<Record<string, number>> }; minimumConfidence: number; score?: (seed: MontageCandidateSeed) => number; estimateCost?: (seed: MontageCandidateSeed) => number }): Readonly<MontageSelection> {
  const score = input.score ?? ((seed) => Object.entries(input.rubric.weights).reduce((total, [criterion, weight]) => total + (seed.rubricSignals[criterion] ?? 0) * weight, 0))
  const estimateCost = input.estimateCost ?? ((seed) => seed.assetIds.length + seed.patternBreakIds.length * .25)
  const candidates = input.seeds.map((seed): EvaluatedMontageCandidate => seed.hardGateIssues.length ? { ...seed, status: 'rejected', score: null, estimatedCost: null, rejectionReasons: Object.freeze([...seed.hardGateIssues]) } : { ...seed, status: 'eligible', score: Number(score(seed).toFixed(6)), estimatedCost: Number(estimateCost(seed).toFixed(4)), rejectionReasons: Object.freeze([]) })
  const eligible = candidates.filter((candidate) => candidate.status === 'eligible').toSorted((a, b) => (b.score! - a.score!) || a.estimatedCost! - b.estimatedCost! || a.id.localeCompare(b.id))
  const diversity = { uniqueHooks: new Set(input.seeds.map((seed) => seed.hookId)).size, uniqueOrders: new Set(input.seeds.map((seed) => seed.blockOrder.join('|'))).size, uniqueAssetSets: new Set(input.seeds.map((seed) => [...seed.assetIds].toSorted().join('|'))).size, uniquePatternSets: new Set(input.seeds.map((seed) => [...seed.patternBreakIds].toSorted().join('|'))).size }
  if (!eligible.length) return Object.freeze({ status: 'blocked', winnerId: null, reason: 'NO_ELIGIBLE_CANDIDATE', diversity: Object.freeze(diversity), candidates: Object.freeze(candidates) })
  const winner = eligible[0]; const tied = eligible.length > 1 && eligible[1].score === winner.score
  const status = tied || winner.confidence < input.minimumConfidence ? 'review' : 'selected'
  return Object.freeze({ status, winnerId: winner.id, reason: tied ? 'SCORE_TIE' : winner.confidence < input.minimumConfidence ? 'LOW_CONFIDENCE' : 'HIGHEST_RUBRIC_SCORE', diversity: Object.freeze(diversity), candidates: Object.freeze(candidates) })
}
