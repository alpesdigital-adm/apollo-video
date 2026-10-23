/**
 * ADR-160 F8. The pure half of the Lotes compatibility step: what the batch says about its audience, offer, persona, action, language and
 * tone, and what it does not.
 *
 * "Nothing is fixed, everything comes from the request." The context of a take comes from the interpretation of the batch briefing (a topic
 * the interpreter found in it, with the words it stands on) or from what the owner types here. Whatever neither says is left OUT of the request
 * (so the graph records it as unspecified and the check that needs it as not evaluable) and the screen asks for it. There is no workspace
 * default, no default action, no 0.5.
 *
 * Nothing here touches the network or the DOM.
 */

import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

export type ContextField = 'audience' | 'offer' | 'persona' | 'action' | 'locale' | 'tone'

export const CONTEXT_FIELD_LABELS: Readonly<Record<ContextField, string>> = Object.freeze({
  audience: 'Público',
  offer: 'Oferta',
  persona: 'Quem fala (persona)',
  action: 'Ação que o vídeo pede',
  locale: 'Idioma',
  tone: 'Tom',
})

/** What the owner typed for the context of the whole batch. Empty = not stated. */
export interface OwnerCompatibilityContext {
  audience: string
  offer: string
  persona: string
  action: string
  locale: string
}

export const EMPTY_OWNER_CONTEXT: Readonly<OwnerCompatibilityContext> = Object.freeze({ audience: '', offer: '', persona: '', action: '', locale: '' })

/** The part of `GET /v1/batches/{id}/editorial-request` this step reads. */
export interface BatchRequestForContext {
  request: { briefing?: { text: string }; requestHash: string } | null
  interpretation: null | {
    interpretationHash: string
    coverage?: readonly { topic: 'audience' | 'offer' | 'tone'; excerpt: { text: string } }[]
  }
}

export type StatementSource = 'owner' | 'briefing' | 'script' | 'missing'
export interface ContextStatement {
  field: ContextField
  label: string
  source: StatementSource
  /** The words: what the owner typed, or the excerpt of the briefing. Absent when missing. */
  text?: string
  /** True when the Apollo has no way to turn the statement into a value: it is shown, never used. */
  informationalOnly?: boolean
}

const covered = (request: Readonly<BatchRequestForContext> | null, topic: 'audience' | 'offer' | 'tone'): string | undefined =>
  request?.interpretation?.coverage?.find((item) => item.topic === topic)?.excerpt.text.trim() || undefined

/** What is stated for each context field, from the owner first, then from the briefing, else missing. */
export function resolveContextStatements(request: Readonly<BatchRequestForContext> | null, owner: Readonly<OwnerCompatibilityContext>, scriptLocale?: string): readonly Readonly<ContextStatement>[] {
  const own = (value: string) => value.trim() || undefined
  const statement = (field: ContextField, ownerText: string | undefined, briefingText: string | undefined, informationalOnly = false, scriptText?: string): ContextStatement =>
    ownerText !== undefined ? { field, label: CONTEXT_FIELD_LABELS[field], source: 'owner', text: ownerText }
      : scriptText !== undefined ? { field, label: CONTEXT_FIELD_LABELS[field], source: 'script', text: scriptText }
      : briefingText !== undefined ? { field, label: CONTEXT_FIELD_LABELS[field], source: 'briefing', text: briefingText, ...(informationalOnly ? { informationalOnly } : {}) }
        : { field, label: CONTEXT_FIELD_LABELS[field], source: 'missing' }
  return Object.freeze([
    statement('audience', own(owner.audience), covered(request, 'audience')),
    statement('offer', own(owner.offer), covered(request, 'offer')),
    statement('persona', own(owner.persona), undefined),
    statement('action', own(owner.action), undefined),
    statement('locale', own(owner.locale), undefined, false, scriptLocale?.trim() || undefined),
    // The briefing may speak about tone, but a tone is not a number the Apollo may invent from it: it is shown, and the dimension stays out of the score.
    statement('tone', undefined, covered(request, 'tone'), true),
  ])
}

/** A stable identifier for a statement, so every take of the batch carries the same one. The words stay on the screen; the graph keeps the identifier. */
export function contextToken(prefix: string, text: string): string {
  const normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('und')
  return `${prefix}-${bytesToHex(sha256(new TextEncoder().encode(normalized))).slice(0, 24)}`
}

export interface TakeForContext { id: string; takeHash: string; sourceHash: string; assignment: { role: string } }

/**
 * The `contexts` of `create-compatibility-graph-request/2`. A field nobody stated is not in the object at all. `continuityProvides` is the role
 * the take was assigned in the script (it comes from the take itself); there are no narrative tags, no tone, no energy, no visual and no
 * experiment values, because nothing states them.
 */
export function buildCompatibilityContexts(takes: readonly Readonly<TakeForContext>[], statements: readonly Readonly<ContextStatement>[], request: Readonly<BatchRequestForContext> | null) {
  const stated = (field: ContextField) => statements.find((item) => item.field === field && item.source !== 'missing' && !item.informationalOnly)
  const audience = stated('audience')
  const offer = stated('offer')
  const persona = stated('persona')
  const action = stated('action')
  const locale = stated('locale')
  const fromBriefing = [audience, offer].some((item) => item?.source === 'briefing')
  return takes.map((take) => ({
    takeId: take.id,
    expectedTakeHash: take.takeHash,
    ...(offer?.text ? { offerId: contextToken('offer', offer.text) } : {}),
    ...(audience?.text ? { audienceTags: [contextToken('audience', audience.text)] } : {}),
    claims: [] as { key: string; value: string }[],
    ...(persona?.text ? { personaId: contextToken('persona', persona.text) } : {}),
    ...(locale?.text ? { locale: locale.text } : {}),
    ...(action?.text ? { desiredAction: contextToken('action', action.text) } : {}),
    continuityProvides: [`role-${take.assignment.role}`],
    continuityRequires: [] as string[],
    evidenceRefs: [...new Set([
      take.takeHash,
      take.sourceHash,
      ...(fromBriefing && request?.request ? [request.request.requestHash] : []),
      ...(fromBriefing && request?.interpretation ? [request.interpretation.interpretationHash] : []),
    ])],
  }))
}

export const CONTEXT_FIELD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  audienceTags: 'público', desiredAction: 'ação desejada', energy: 'energia', experiment: 'variação', locale: 'idioma',
  narrativeTags: 'temas da narrativa', offerId: 'oferta', personaId: 'persona', tone: 'tom', visual: 'visual',
})

export const CHECK_NAMES: Readonly<Record<string, string>> = Object.freeze({
  OFFER_MISMATCH: 'mesma oferta', AUDIENCE_CONFLICT: 'mesmo público', PERSONA_MISMATCH: 'mesma persona', LOCALE_MISMATCH: 'mesmo idioma',
  CTA_ACTION_MISMATCH: 'mesma ação no CTA', CLAIM_CONTRADICTION: 'afirmações sem contradição', REQUIRED_CONTINUITY_MISSING: 'continuidade exigida',
})

export interface GraphForContext {
  nodes: readonly { unspecified?: readonly string[] }[]
  edges: readonly { notEvaluable?: readonly { check: string; fields: readonly string[] }[]; softScores: readonly { dimension: string; score: number | null }[] }[]
  summary: { notEvaluableEdgeCount?: number }
}

/** What a computed graph could not evaluate, in plain words: the fields nobody stated, the checks left undone, the dimensions left out of the score. */
export function describeUnevaluated(graph: Readonly<GraphForContext>): { fields: string[]; checks: string[]; dimensions: string[]; edgeCount: number } {
  const fields = new Set<string>()
  for (const node of graph.nodes) for (const field of node.unspecified ?? []) fields.add(CONTEXT_FIELD_NAMES[field] ?? field)
  const checks = new Set<string>()
  const dimensions = new Set<string>()
  for (const edge of graph.edges) {
    for (const item of edge.notEvaluable ?? []) checks.add(CHECK_NAMES[item.check] ?? item.check)
    for (const score of edge.softScores) if (score.score === null) dimensions.add(score.dimension)
  }
  return {
    fields: [...fields].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    checks: [...checks].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    dimensions: [...dimensions].sort(),
    edgeCount: graph.summary.notEvaluableEdgeCount ?? 0,
  }
}

export type PickRole = 'hook' | 'body' | 'proof' | 'cta'
export type ProofChoice = '' | 'with-proof' | 'without-proof'
export type PathPicks = Readonly<Record<PickRole, string>>
export const EMPTY_PICKS: PathPicks = Object.freeze({ hook: '', body: '', proof: '', cta: '' })

/** The body of a variant recipe from what the owner picked; null while the pick is incomplete for the proof choice the owner made. */
export function pathFromPicks(picks: Readonly<PathPicks>, proof: ProofChoice) {
  if (proof === '' || !picks.hook || !picks.body || !picks.cta) return null
  if (proof === 'with-proof' && !picks.proof) return null
  const withProof = proof === 'with-proof'
  return {
    selection: {
      hookNodeId: picks.hook,
      bodyNodeId: picks.body,
      ...(withProof ? { proofNodeId: picks.proof } : {}),
      ctaNodeId: picks.cta,
    },
    orderedNodeIds: withProof ? [picks.hook, picks.body, picks.proof, picks.cta] : [picks.hook, picks.body, picks.cta],
    requireProof: withProof,
  }
}

export type EdgeVerdict = 'accepted' | 'borderline' | 'blocked' | 'absent'
/** The edge between two consecutive picks, as the graph computed it. */
export function edgeBetween(
  graph: Readonly<{ edges: readonly { fromNodeId: string; toNodeId: string; decision: 'accepted' | 'borderline' | 'blocked'; notEvaluable?: readonly unknown[] }[] }>,
  fromNodeId: string,
  toNodeId: string,
): { verdict: EdgeVerdict; notEvaluable: boolean } {
  const edge = graph.edges.find((item) => item.fromNodeId === fromNodeId && item.toNodeId === toNodeId)
  return edge ? { verdict: edge.decision, notEvaluable: (edge.notEvaluable?.length ?? 0) > 0 } : { verdict: 'absent', notEvaluable: false }
}
