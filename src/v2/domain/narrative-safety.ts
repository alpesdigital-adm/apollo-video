import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import type { StoryPlan } from './story-plan.ts'

export type NarrativeStatementKind = 'promise' | 'testimony' | 'comparison' | 'fact'
export type NarrativeDependencyKind = 'proof' | 'qualifying-context' | 'causal-premise' | 'comparison-baseline'
export interface NarrativeTokenEvidence { text: string; rangeMs: readonly [number, number] }
export interface NarrativeDependency { statementId: string; kind: NarrativeDependencyKind; requiredOrder: 'before' | 'after' | 'any' }
export interface NarrativeClaim { id: string; text: string; rangeMs: readonly [number, number] }
export interface NarrativeStatement {
  schemaVersion: 'narrative-statement/v1'
  id: string
  storyBlockId: string
  speakerId: string
  sourceArtifactId: string
  rangeMs: readonly [number, number]
  text: string
  kind: NarrativeStatementKind
  claims: readonly NarrativeClaim[]
  qualifiers: readonly NarrativeTokenEvidence[]
  negations: readonly NarrativeTokenEvidence[]
  causalMarkers: readonly NarrativeTokenEvidence[]
  deadlines: readonly NarrativeTokenEvidence[]
  dependencies: readonly NarrativeDependency[]
  statementHash: string
}
export interface NarrativeEditItem {
  statementId: string
  speakerId: string
  sourceArtifactId: string
  sourceRangeMs: readonly [number, number]
  preservedText: string
}
export interface NarrativeRestoreAction {
  kind: 'restore-statement' | 'restore-token' | 'restore-attribution' | 'restore-dependency' | 'restore-order'
  statementId: string
  sourceRangeMs: readonly [number, number]
  refs: readonly string[]
}
export interface NarrativeQualityIssue {
  schemaVersion: 'narrative-quality-issue/v1'
  code: 'UNKNOWN_STATEMENT' | 'STATEMENT_DUPLICATED' | 'SOURCE_RANGE_CHANGED' | 'SOURCE_TEXT_CHANGED' | 'ATTRIBUTION_CHANGED' | 'CLAIM_CHANGED' | 'QUALIFIER_REMOVED' | 'NEGATION_REMOVED' | 'CAUSALITY_CHANGED' | 'DEADLINE_REMOVED' | 'DEPENDENCY_REMOVED' | 'DEPENDENCY_REORDERED'
  severity: 'hard'
  category: 'integrity'
  statementId: string
  rangeMs: readonly [number, number]
  evidence: readonly Readonly<{ kind: 'source-text' | 'speaker' | 'source-range' | 'dependency' | 'critical-token'; ref: string; rangeMs?: readonly [number, number] }>[]
  restoreAction: Readonly<NarrativeRestoreAction>
}
export interface NarrativeSafetyContext { schemaVersion: 'narrative-safety-context/v1'; storyPlanId: string; statements: readonly NarrativeStatement[]; contextHash: string }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const STATEMENT_KINDS = new Set<NarrativeStatementKind>(['promise', 'testimony', 'comparison', 'fact'])
const DEPENDENCY_KINDS = new Set<NarrativeDependencyKind>(['proof', 'qualifying-context', 'causal-premise', 'comparison-baseline'])
const DEPENDENCY_ORDERS = new Set<NarrativeDependency['requiredOrder']>(['before', 'after', 'any'])
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new DomainError('INVALID_ARGUMENT', message) }
function range(value: readonly [number, number], field: string) { assert(Array.isArray(value) && value.length === 2 && value.every(Number.isSafeInteger) && value[0] >= 0 && value[1] > value[0], `${field} is invalid`); return Object.freeze([value[0], value[1]] as const) }
function normalize(value: string) { return value.normalize('NFC').toLocaleLowerCase('pt-BR').replace(/[^\p{L}\p{N}%]+/gu, ' ').trim().replace(/\s+/g, ' ') }
function contains(source: string, expected: string) { return normalize(source).includes(normalize(expected)) }
function retainedByRange(sourceRange: readonly [number, number], evidenceRange: readonly [number, number]) { return sourceRange[0] <= evidenceRange[0] && sourceRange[1] >= evidenceRange[1] }

function tokenEvidence(input: NarrativeTokenEvidence, statementRange: readonly [number, number], statementText: string, field: string): Readonly<NarrativeTokenEvidence> {
  assert(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 1_000, `${field}.text is invalid`)
  const evidenceRange = range(input.rangeMs, `${field}.rangeMs`)
  assert(evidenceRange[0] >= statementRange[0] && evidenceRange[1] <= statementRange[1] && contains(statementText, input.text), 'Statement evidence must be verbatim and inside its source range')
  return Object.freeze({ text: input.text.trim(), rangeMs: evidenceRange })
}

export function createNarrativeStatement(input: Omit<NarrativeStatement, 'schemaVersion' | 'statementHash'>): Readonly<NarrativeStatement> {
  for (const [field, value] of Object.entries({ id: input.id, storyBlockId: input.storyBlockId, speakerId: input.speakerId, sourceArtifactId: input.sourceArtifactId })) assert(ID.test(value), `${field} is invalid`)
  const statementRange = range(input.rangeMs, 'statement.rangeMs')
  assert(input.text.trim().length > 0 && input.text.length <= 4_000, 'statement.text is invalid')
  assert(STATEMENT_KINDS.has(input.kind), 'statement.kind is invalid')
  assert(input.claims.length <= 100 && input.qualifiers.length <= 100 && input.negations.length <= 100 && input.causalMarkers.length <= 100 && input.deadlines.length <= 100 && input.dependencies.length <= 100, 'Narrative statement evidence is too large')
  const claimIds = new Set<string>()
  const claims = input.claims.map((claim, index) => {
    assert(ID.test(claim.id) && !claimIds.has(claim.id), `claims[${index}].id is invalid or duplicated`)
    claimIds.add(claim.id)
    const evidence = tokenEvidence(claim, statementRange, input.text, `claims[${index}]`)
    return Object.freeze({ id: claim.id, text: evidence.text, rangeMs: evidence.rangeMs })
  })
  const qualifiers = input.qualifiers.map((value, index) => tokenEvidence(value, statementRange, input.text, `qualifiers[${index}]`))
  const negations = input.negations.map((value, index) => tokenEvidence(value, statementRange, input.text, `negations[${index}]`))
  const causalMarkers = input.causalMarkers.map((value, index) => tokenEvidence(value, statementRange, input.text, `causalMarkers[${index}]`))
  const deadlines = input.deadlines.map((value, index) => tokenEvidence(value, statementRange, input.text, `deadlines[${index}]`))
  assert(input.claims.length > 0 || input.kind === 'fact', 'Non-factual statement requires a structured claim')
  const dependencyKeys = new Set<string>()
  const dependencies = input.dependencies.map((dependency) => {
    assert(ID.test(dependency.statementId) && dependency.statementId !== input.id && DEPENDENCY_KINDS.has(dependency.kind) && DEPENDENCY_ORDERS.has(dependency.requiredOrder), 'Statement dependency is invalid')
    const key = `${dependency.kind}:${dependency.statementId}`
    assert(!dependencyKeys.has(key), 'Statement dependencies must be unique')
    dependencyKeys.add(key)
    return Object.freeze({ statementId: dependency.statementId, kind: dependency.kind, requiredOrder: dependency.requiredOrder })
  })
  const core = {
    id: input.id,
    storyBlockId: input.storyBlockId,
    speakerId: input.speakerId,
    sourceArtifactId: input.sourceArtifactId,
    rangeMs: statementRange,
    text: input.text.trim(),
    kind: input.kind,
    claims: Object.freeze(claims),
    qualifiers: Object.freeze(qualifiers),
    negations: Object.freeze(negations),
    causalMarkers: Object.freeze(causalMarkers),
    deadlines: Object.freeze(deadlines),
    dependencies: Object.freeze(dependencies),
    schemaVersion: 'narrative-statement/v1' as const,
  }
  return Object.freeze({ ...core, statementHash: calculateCanonicalHash(core) })
}

export function createNarrativeSafetyContext(input: { storyPlanId: string; storyPlan: Readonly<StoryPlan>; statements: readonly Omit<NarrativeStatement, 'schemaVersion' | 'statementHash'>[] }): Readonly<NarrativeSafetyContext> {
  assert(ID.test(input.storyPlanId), 'storyPlanId is invalid')
  assert(input.statements.length > 0 && input.statements.length <= 500, 'Narrative safety context must contain between 1 and 500 statements')
  const blockById = new Map(input.storyPlan.blocks.map((block) => [block.id, block]))
  const statements = input.statements.map(createNarrativeStatement)
  const byId = new Map<string, NarrativeStatement>()
  for (const statement of statements) {
    assert(!byId.has(statement.id), 'Narrative statement ids must be unique'); byId.set(statement.id, statement)
    const block = blockById.get(statement.storyBlockId); assert(block, `Statement ${statement.id} references a missing StoryBlock`)
    for (const claim of statement.claims) assert(block.content.claimIds.includes(claim.id), `Statement claim ${claim.id} is absent from its StoryBlock`)
    for (const dependency of statement.dependencies) if (dependency.kind === 'proof') assert(block.content.proofIds.length > 0, `Statement ${statement.id} has proof dependency without StoryBlock proof context`)
  }
  for (const statement of statements) for (const dependency of statement.dependencies) assert(byId.has(dependency.statementId), `Statement ${statement.id} references missing dependency ${dependency.statementId}`)
  const core = { schemaVersion: 'narrative-safety-context/v1' as const, storyPlanId: input.storyPlanId, statements: Object.freeze(statements) }
  return Object.freeze({ ...core, contextHash: calculateCanonicalHash(core) })
}

function issue(statement: NarrativeStatement, code: NarrativeQualityIssue['code'], evidence: NarrativeQualityIssue['evidence'], action: NarrativeRestoreAction['kind'], refs: readonly string[], localizedRange: readonly [number, number] = statement.rangeMs): NarrativeQualityIssue {
  const frozenEvidence = evidence.map((item) => Object.freeze({ ...item, ...(item.rangeMs ? { rangeMs: Object.freeze([...item.rangeMs] as [number, number]) } : {}) }))
  return Object.freeze({ schemaVersion: 'narrative-quality-issue/v1', code, severity: 'hard', category: 'integrity', statementId: statement.id, rangeMs: Object.freeze([...localizedRange] as [number, number]), evidence: Object.freeze(frozenEvidence), restoreAction: Object.freeze({ kind: action, statementId: statement.id, sourceRangeMs: Object.freeze([...localizedRange] as [number, number]), refs: Object.freeze([...refs]) }) })
}

export function validateNarrativeEdit(context: Readonly<NarrativeSafetyContext>, edit: readonly NarrativeEditItem[]): Readonly<{ schemaVersion: 'narrative-safety-decision/v1'; contextHash: string; safe: boolean; issues: readonly NarrativeQualityIssue[] }> {
  assert(context.schemaVersion === 'narrative-safety-context/v1' && ID.test(context.storyPlanId) && context.statements.length > 0 && context.statements.length <= 500, 'Narrative safety context is invalid')
  const expectedContextHash = calculateCanonicalHash({ schemaVersion: context.schemaVersion, storyPlanId: context.storyPlanId, statements: context.statements })
  for (const statement of context.statements) {
    const { statementHash, ...core } = statement
    if (calculateCanonicalHash(core) !== statementHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Narrative statement integrity validation failed')
  }
  if (expectedContextHash !== context.contextHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Narrative safety context integrity validation failed')
  assert(Array.isArray(edit) && edit.length > 0 && edit.length <= 500, 'Narrative edit must contain between 1 and 500 items')
  for (const [index, item] of edit.entries()) {
    assert(ID.test(item.statementId) && ID.test(item.speakerId) && ID.test(item.sourceArtifactId), `Narrative edit item ${index} identity is invalid`)
    range(item.sourceRangeMs, `edit[${index}].sourceRangeMs`)
    assert(typeof item.preservedText === 'string' && normalize(item.preservedText).length > 0 && item.preservedText.length <= 4_000, `edit[${index}].preservedText is invalid`)
  }
  const byId = new Map(context.statements.map((statement) => [statement.id, statement])); const selected = new Set(edit.map((item) => item.statementId)); const order = new Map(edit.map((item, index) => [item.statementId, index])); const issues: NarrativeQualityIssue[] = []
  const counts = new Map<string, number>(); for (const item of edit) counts.set(item.statementId, (counts.get(item.statementId) ?? 0) + 1)
  for (const item of edit) {
    const statement = byId.get(item.statementId)
    if (!statement) { const synthetic = createNarrativeStatement({ id: ID.test(item.statementId) ? item.statementId : 'unknown-statement', storyBlockId: 'unknown-block', speakerId: ID.test(item.speakerId) ? item.speakerId : 'unknown-speaker', sourceArtifactId: ID.test(item.sourceArtifactId) ? item.sourceArtifactId : 'unknown-artifact', rangeMs: range(item.sourceRangeMs, 'edit.sourceRangeMs'), text: item.preservedText || 'unknown', kind: 'fact', claims: [], qualifiers: [], negations: [], causalMarkers: [], deadlines: [], dependencies: [] }); issues.push(issue(synthetic, 'UNKNOWN_STATEMENT', [{ kind: 'source-text', ref: item.statementId }], 'restore-statement', [item.statementId])); continue }
    if ((counts.get(item.statementId) ?? 0) > 1) issues.push(issue(statement, 'STATEMENT_DUPLICATED', [{ kind: 'source-text', ref: statement.id }], 'restore-statement', [statement.id]))
    if (item.sourceArtifactId !== statement.sourceArtifactId || item.sourceRangeMs[0] < statement.rangeMs[0] || item.sourceRangeMs[1] > statement.rangeMs[1] || item.sourceRangeMs[0] >= item.sourceRangeMs[1]) issues.push(issue(statement, 'SOURCE_RANGE_CHANGED', [{ kind: 'source-range', ref: statement.sourceArtifactId, rangeMs: statement.rangeMs }], 'restore-statement', [statement.sourceArtifactId]))
    if (item.speakerId !== statement.speakerId) issues.push(issue(statement, 'ATTRIBUTION_CHANGED', [{ kind: 'speaker', ref: statement.speakerId }], 'restore-attribution', [statement.speakerId]))
    if (!contains(statement.text, item.preservedText)) issues.push(issue(statement, 'SOURCE_TEXT_CHANGED', [{ kind: 'source-text', ref: statement.text, rangeMs: statement.rangeMs }], 'restore-statement', [statement.text]))
    for (const claim of statement.claims) if (!contains(item.preservedText, claim.text) || !retainedByRange(item.sourceRangeMs, claim.rangeMs)) issues.push(issue(statement, 'CLAIM_CHANGED', [{ kind: 'source-text', ref: claim.id, rangeMs: claim.rangeMs }], 'restore-token', [claim.text], claim.rangeMs))
    for (const [group, code] of [[statement.qualifiers, 'QUALIFIER_REMOVED'], [statement.negations, 'NEGATION_REMOVED'], [statement.causalMarkers, 'CAUSALITY_CHANGED'], [statement.deadlines, 'DEADLINE_REMOVED']] as const) for (const token of group) if (!contains(item.preservedText, token.text) || !retainedByRange(item.sourceRangeMs, token.rangeMs)) issues.push(issue(statement, code, [{ kind: 'critical-token', ref: token.text, rangeMs: token.rangeMs }], 'restore-token', [token.text], token.rangeMs))
    for (const dependency of statement.dependencies) {
      if (!selected.has(dependency.statementId)) { issues.push(issue(statement, 'DEPENDENCY_REMOVED', [{ kind: 'dependency', ref: `${dependency.kind}:${dependency.statementId}` }], 'restore-dependency', [dependency.statementId])); continue }
      const dependencyIndex = order.get(dependency.statementId)!; const statementIndex = order.get(statement.id)!
      if ((dependency.requiredOrder === 'before' && dependencyIndex > statementIndex) || (dependency.requiredOrder === 'after' && dependencyIndex < statementIndex)) issues.push(issue(statement, 'DEPENDENCY_REORDERED', [{ kind: 'dependency', ref: `${dependency.requiredOrder}:${dependency.statementId}` }], 'restore-order', [dependency.statementId, statement.id]))
    }
  }
  const unique = new Map(issues.map((value) => [`${value.statementId}:${value.code}:${value.evidence.map((item) => item.ref).join(',')}`, value]))
  const localizedIssues = [...unique.values()].slice(0, 500)
  return Object.freeze({ schemaVersion: 'narrative-safety-decision/v1', contextHash: context.contextHash, safe: unique.size === 0, issues: Object.freeze(localizedIssues) })
}

const ev = (text: string, start: number, end: number): NarrativeTokenEvidence => ({ text, rangeMs: [start, end] })
export const NARRATIVE_POLICY_FIXTURES = Object.freeze({
  context: { id: 'statement-context', storyBlockId: 'block-context', speakerId: 'speaker-client', sourceArtifactId: 'artifact-master', rangeMs: [0, 2_000], text: 'No meu caso específico, seguindo o plano completo.', kind: 'fact', claims: [], qualifiers: [ev('caso específico', 300, 900)], negations: [], causalMarkers: [], deadlines: [], dependencies: [] },
  proof: { id: 'statement-proof', storyBlockId: 'block-proof', speakerId: 'speaker-expert', sourceArtifactId: 'artifact-master', rangeMs: [2_000, 4_000], text: 'Os dados observados sustentam essa afirmação.', kind: 'fact', claims: [], qualifiers: [], negations: [], causalMarkers: [], deadlines: [], dependencies: [] },
  promise: { id: 'statement-promise', storyBlockId: 'block-promise', speakerId: 'speaker-expert', sourceArtifactId: 'artifact-master', rangeMs: [4_000, 7_000], text: 'O método pode melhorar a clareza em até 30 dias.', kind: 'promise', claims: [{ id: 'claim-promise', text: 'melhorar a clareza', rangeMs: [4_700, 5_500] }], qualifiers: [ev('pode', 4_400, 4_700)], negations: [], causalMarkers: [], deadlines: [ev('em até 30 dias', 5_500, 6_500)], dependencies: [{ statementId: 'statement-proof', kind: 'proof', requiredOrder: 'before' }] },
  testimony: { id: 'statement-testimony', storyBlockId: 'block-testimony', speakerId: 'speaker-client', sourceArtifactId: 'artifact-master', rangeMs: [7_000, 10_000], text: 'Eu tive mais clareza seguindo o plano completo.', kind: 'testimony', claims: [{ id: 'claim-testimony', text: 'tive mais clareza', rangeMs: [7_300, 8_300] }], qualifiers: [], negations: [], causalMarkers: [ev('seguindo', 8_300, 8_800)], deadlines: [], dependencies: [{ statementId: 'statement-context', kind: 'qualifying-context', requiredOrder: 'before' }] },
  comparison: { id: 'statement-comparison', storyBlockId: 'block-comparison', speakerId: 'speaker-expert', sourceArtifactId: 'artifact-master', rangeMs: [10_000, 13_000], text: 'Não é mais rápido que o processo anterior por acaso.', kind: 'comparison', claims: [{ id: 'claim-comparison', text: 'mais rápido que o processo anterior', rangeMs: [10_500, 12_000] }], qualifiers: [], negations: [ev('Não', 10_000, 10_300)], causalMarkers: [ev('por acaso', 12_100, 12_700)], deadlines: [], dependencies: [{ statementId: 'statement-context', kind: 'comparison-baseline', requiredOrder: 'before' }] },
} satisfies Record<string, Omit<NarrativeStatement, 'schemaVersion' | 'statementHash'>>)
