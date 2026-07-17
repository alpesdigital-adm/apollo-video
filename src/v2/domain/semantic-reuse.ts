import { createHash } from 'node:crypto'
import { DomainError } from './errors.ts'

export interface WordAlignment { word: string; startMs: number; endMs: number; confidence: number }
export interface SemanticProvenance { sourceArtifactId: string; model: string; version: string; confidence: number }
export interface SpeechSegment {
  id: string; artifactId: string; exactText: string; normalizedText: string; speakerId: string
  rangeMs: readonly [number, number]; words: readonly WordAlignment[]; completeThoughtScore: number
  visual: { emotion?: string; expression?: string; wardrobe?: string; setting?: string; colors?: readonly string[] }
  intention: readonly string[]; provenance: SemanticProvenance; physicalMaterialized: false
}

const normalizeText = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
export function createSpeechSegment(input: Omit<SpeechSegment, 'normalizedText' | 'physicalMaterialized'>): Readonly<SpeechSegment> {
  if (!input.exactText.trim() || input.rangeMs[0] < 0 || input.rangeMs[1] <= input.rangeMs[0] || input.completeThoughtScore < 0 || input.completeThoughtScore > 1) throw new DomainError('INVALID_ARGUMENT', 'Speech segment is invalid')
  if (input.words.some((word) => word.startMs < input.rangeMs[0] || word.endMs > input.rangeMs[1] || word.endMs < word.startMs || word.confidence < 0 || word.confidence > 1)) throw new DomainError('INVALID_ARGUMENT', 'Word alignment is outside speech segment')
  return Object.freeze({ ...input, normalizedText: normalizeText(input.exactText), words: Object.freeze([...input.words]), intention: Object.freeze([...input.intention]), visual: Object.freeze({ ...input.visual, colors: input.visual.colors ? Object.freeze([...input.visual.colors]) : undefined }), provenance: Object.freeze({ ...input.provenance }), rangeMs: Object.freeze([...input.rangeMs]) as readonly [number, number], physicalMaterialized: false })
}

export function extractSpeechSegments(input: { artifactId: string; speakerId: string; words: readonly WordAlignment[]; sentenceBreaksMs: readonly number[]; provenance: SemanticProvenance }): readonly SpeechSegment[] {
  const boundaries = [input.words[0]?.startMs ?? 0, ...input.sentenceBreaksMs, input.words.at(-1)?.endMs ?? 0].filter((value, index, all) => index === 0 || value > all[index - 1])
  return Object.freeze(boundaries.slice(0, -1).flatMap((startMs, index) => {
    const endMs = boundaries[index + 1]; const words = input.words.filter((word) => word.startMs >= startMs && word.endMs <= endMs)
    if (!words.length) return []
    const exactText = words.map((word) => word.word).join(' ')
    const complete = /[.!?]$/.test(exactText) ? .95 : words.length >= 5 ? .7 : .35
    return [createSpeechSegment({ id: `speech_${createHash('sha256').update(`${input.artifactId}:${startMs}:${endMs}`).digest('hex').slice(0, 12)}`, artifactId: input.artifactId, exactText, speakerId: input.speakerId, rangeMs: [startMs, endMs], words, completeThoughtScore: complete, visual: {}, intention: [], provenance: input.provenance })]
  }))
}

export type EvidenceIntegrity = 'valid' | 'context-required' | 'blocked'
export interface EvidenceSegment {
  id: string; artifactId: string; claim: string; qualifier?: string; subject: string; attribution: string
  consent: 'approved' | 'unknown' | 'denied'; contextWindowMs: readonly [number, number]; transcript: string
  frameRefs: readonly string[]; adjacentEvidenceIds: readonly string[]; category: 'testimonial' | 'financial-result' | 'before-after' | 'hearsay'
  integrity: EvidenceIntegrity; requiresContext: boolean
}
export function createEvidenceSegment(input: EvidenceSegment): Readonly<EvidenceSegment> {
  if (!input.claim.trim() || !input.subject.trim() || !input.attribution.trim() || input.contextWindowMs[1] <= input.contextWindowMs[0]) throw new DomainError('INVALID_ARGUMENT', 'Evidence segment is invalid')
  const policyBlocked = input.consent !== 'approved' || input.category === 'hearsay'
  const requiresContext = input.requiresContext || input.category === 'financial-result' || input.category === 'before-after' || Boolean(input.qualifier)
  const integrity: EvidenceIntegrity = policyBlocked ? 'blocked' : requiresContext ? 'context-required' : 'valid'
  return Object.freeze({ ...input, integrity, requiresContext, frameRefs: Object.freeze([...input.frameRefs]), adjacentEvidenceIds: Object.freeze([...input.adjacentEvidenceIds]), contextWindowMs: Object.freeze([...input.contextWindowMs]) as readonly [number, number] })
}
export function authorizeEvidenceUse(evidence: EvidenceSegment, input: { includedContext: boolean; intendedClaim: string }) {
  const reasons = [...(evidence.integrity === 'blocked' ? ['integrity-blocked'] : []), ...(evidence.requiresContext && !input.includedContext ? ['context-required'] : []), ...(normalizeText(input.intendedClaim) !== normalizeText(evidence.claim) ? ['claim-drift'] : [])]
  return Object.freeze({ allowed: reasons.length === 0, reasons: Object.freeze(reasons), requiredRangeMs: evidence.contextWindowMs, requiredAdjacentEvidenceIds: evidence.adjacentEvidenceIds })
}

export interface LongFormMoment { id: string; artifactId: string; chapterId: string; topic: string; summary: string; speakers: readonly string[]; rangesMs: readonly (readonly [number, number])[]; evidenceSpanIds: readonly string[]; salience: number }
export interface LongFormIndex { artifactId: string; durationMs: number; chapters: readonly { id: string; title: string; rangeMs: readonly [number, number]; momentIds: readonly string[] }[]; moments: readonly LongFormMoment[] }
export function createLongFormIndex(input: LongFormIndex): Readonly<LongFormIndex> {
  if (input.durationMs <= 0 || input.moments.some((moment) => moment.salience < 0 || moment.salience > 1 || moment.rangesMs.length === 0 || moment.rangesMs.some(([start, end]) => start < 0 || end <= start || end > input.durationMs))) throw new DomainError('INVALID_ARGUMENT', 'Long-form index is invalid')
  return Object.freeze({ ...input, chapters: Object.freeze(input.chapters.map((chapter) => Object.freeze({ ...chapter, rangeMs: Object.freeze([...chapter.rangeMs]) as readonly [number, number], momentIds: Object.freeze([...chapter.momentIds]) }))), moments: Object.freeze(input.moments.map((moment) => Object.freeze({ ...moment, speakers: Object.freeze([...moment.speakers]), rangesMs: Object.freeze(moment.rangesMs.map((range) => Object.freeze([...range]) as readonly [number, number])), evidenceSpanIds: Object.freeze([...moment.evidenceSpanIds]) }))) })
}
export function searchLongForm(index: LongFormIndex, query: string, contextMs = 15_000) {
  const terms = normalizeText(query).split(' ').filter(Boolean)
  return Object.freeze(index.moments.map((moment) => ({ moment, score: terms.filter((term) => normalizeText(`${moment.topic} ${moment.summary}`).includes(term)).length / Math.max(1, terms.length) * .7 + moment.salience * .3 })).filter((item) => item.score > .25).sort((a, b) => b.score - a.score).map((item) => { const firstRange = item.moment.rangesMs[0] as readonly [number, number]; const lastRange = item.moment.rangesMs.at(-1) as readonly [number, number]; return Object.freeze({ ...item, preview: Object.freeze({ startMs: Math.max(0, firstRange[0] - contextMs), endMs: Math.min(index.durationMs, lastRange[1] + contextMs) }) }) }))
}

export interface ValidatedSegment { id: string; segmentId: string; validationSource: string; scope: 'hook' | 'copy' | 'take' | 'timing' | 'opening' | 'whole-video'; validatedAt: string; expiresAt?: string; performance: { metric: string; value: number; sampleSize: number; comparison?: string }; protectedEnvelope: readonly ('copy' | 'take' | 'timing' | 'opening')[] }
export function validateSegmentUse(segment: ValidatedSegment, input: { requestedChanges: readonly ('copy' | 'take' | 'timing' | 'opening')[]; claim: 'association' | 'causality'; now: string }) {
  const expired = Boolean(segment.expiresAt && Date.parse(segment.expiresAt) <= Date.parse(input.now))
  const protectedChanges = input.requestedChanges.filter((change) => segment.protectedEnvelope.includes(change))
  const reasons = [...(expired ? ['validation-expired'] : []), ...(protectedChanges.length ? protectedChanges.map((item) => `protected:${item}`) : []), ...(input.claim === 'causality' ? ['causality-not-supported'] : [])]
  return Object.freeze({ compatible: reasons.length === 0, reasons: Object.freeze(reasons), scope: segment.scope, wholeVideoValidated: segment.scope === 'whole-video' })
}

export interface SearchableAsset { id: string; kind: string; personIds: readonly string[]; durationMs: number; locale: string; rights: 'approved' | 'blocked'; transcript: string; ocr: string; intentions: readonly string[]; description: string; metadata: Readonly<Record<string, string>>; vector: readonly number[] }
export interface HybridSearchQuery { text?: string; intention?: string; vector?: readonly number[]; filters?: { kind?: string; personId?: string; minDurationMs?: number; maxDurationMs?: number; locale?: string; rights?: 'approved' | 'blocked'; metadata?: Readonly<Record<string, string>> } }
export const HYBRID_RERANK_VERSION = Object.freeze({ id: 'hybrid-rerank/v1', weights: Object.freeze({ structured: .25, fullText: .3, vector: .3, rights: .15 }) })
const cosine = (a: readonly number[], b: readonly number[]) => { if (!a.length || a.length !== b.length) return 0; const dot = a.reduce((sum, value, i) => sum + value * b[i], 0); const den = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0)) * Math.sqrt(b.reduce((sum, value) => sum + value * value, 0)); return den ? Math.max(0, dot / den) : 0 }
export function hybridSearch(assets: readonly SearchableAsset[], query: HybridSearchQuery) {
  const terms = normalizeText(`${query.text ?? ''} ${query.intention ?? ''}`).split(' ').filter(Boolean)
  const results = assets.map((asset) => {
    const f = query.filters ?? {}; const structuredMatches = [!f.kind || asset.kind === f.kind, !f.personId || asset.personIds.includes(f.personId), f.minDurationMs === undefined || asset.durationMs >= f.minDurationMs, f.maxDurationMs === undefined || asset.durationMs <= f.maxDurationMs, !f.locale || asset.locale === f.locale, !f.rights || asset.rights === f.rights, ...Object.entries(f.metadata ?? {}).map(([key, value]) => asset.metadata[key] === value)]
    const structured = structuredMatches.filter(Boolean).length / structuredMatches.length
    const corpus = normalizeText(`${asset.transcript} ${asset.ocr} ${asset.description} ${asset.intentions.join(' ')}`)
    const fullText = terms.length ? terms.filter((term) => corpus.includes(term)).length / terms.length : 0
    const vector = query.vector ? cosine(query.vector, asset.vector) : 0
    const blockedReasons = [...(asset.rights !== 'approved' ? ['rights-blocked'] : []), ...(structured < 1 ? ['structured-filter-mismatch'] : [])]
    const score = structured * .25 + fullText * .3 + vector * .3 + (asset.rights === 'approved' ? .15 : 0)
    return Object.freeze({ asset, score: Number(score.toFixed(4)), matchedBy: Object.freeze([...(fullText ? ['full-text'] : []), ...(vector ? ['vector'] : []), ...(structured === 1 ? ['structured'] : [])]), blockedReasons: Object.freeze(blockedReasons), eligible: blockedReasons.length === 0, rerankVersion: HYBRID_RERANK_VERSION.id })
  })
  return Object.freeze(results.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score))
}
export function retrievalMetrics(input: { rankedIds: readonly string[]; relevantIds: readonly string[]; k: number }) {
  const top = input.rankedIds.slice(0, input.k); const hits = top.filter((id) => input.relevantIds.includes(id)); const dcg = top.reduce((sum, id, index) => sum + (input.relevantIds.includes(id) ? 1 / Math.log2(index + 2) : 0), 0); const ideal = Array.from({ length: Math.min(input.k, input.relevantIds.length) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0)
  return Object.freeze({ precision: hits.length / Math.max(1, top.length), recall: hits.length / Math.max(1, input.relevantIds.length), ndcg: ideal ? dcg / ideal : 0 })
}
