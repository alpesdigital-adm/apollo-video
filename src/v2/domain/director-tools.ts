import { validateStoryPlan, type StoryPlan } from './story-plan.ts'
import { DomainError, assertDomain } from './errors.ts'

export interface DirectorMontageCandidate {
  id: string
  hookId: string
  blockOrder: readonly string[]
  assetIds: readonly string[]
  patternBreakIds: readonly string[]
  confidence: number
  hardGateIssues: readonly string[]
  rubricSignals: Readonly<Record<string, number>>
}

export const DIRECTOR_TOOL_NAMES = [
  'search-media',
  'create-story-plan',
  'propose-asset',
  'evaluate-candidate',
  'propose-patch',
] as const

export type DirectorToolName = (typeof DIRECTOR_TOOL_NAMES)[number]

export interface DirectorSearchMediaArguments {
  query: string
  limit?: number
}

export interface DirectorCreateStoryPlanArguments {
  plan: StoryPlan
  assetIds: readonly string[]
}

export interface DirectorProposeAssetArguments {
  assetId: string
  planNodeId: string
  purpose: string
}

export interface DirectorEvaluateCandidateArguments {
  candidates: readonly DirectorMontageCandidate[]
  rubric: Readonly<{ id: string; weights: Readonly<Record<string, number>> }>
  minimumConfidence: number
}

export interface DirectorPatchOperation {
  operation: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
}

export interface DirectorProposePatchArguments {
  operations: readonly DirectorPatchOperation[]
  assetIds: readonly string[]
  rationale: string
}

export interface DirectorToolArguments {
  'search-media': DirectorSearchMediaArguments
  'create-story-plan': DirectorCreateStoryPlanArguments
  'propose-asset': DirectorProposeAssetArguments
  'evaluate-candidate': DirectorEvaluateCandidateArguments
  'propose-patch': DirectorProposePatchArguments
}

export interface DirectorToolRightsEvidence {
  assetId: string
  snapshotHash: string
}

export type DirectorToolCall<Name extends DirectorToolName = DirectorToolName> = Name extends DirectorToolName ? {
  id: string
  name: Name
  arguments: Readonly<DirectorToolArguments[Name]>
  scope: Readonly<{ workspaceId: string; projectId: string }>
  baseVersionId: string
  estimatedCost: number
  rights: readonly Readonly<DirectorToolRightsEvidence>[]
} : never

export interface DirectorToolContext {
  workspaceId: string
  projectId: string
  baseVersionId: string
  budgetRemaining: number
  eligibleAssetRights: ReadonlyMap<string, string>
}

const idSchema = Object.freeze({ type: 'string', minLength: 3, maxLength: 128 })
const hashSchema = Object.freeze({ type: 'string', pattern: '^[a-f0-9]{64}$' })
const stringSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 500 })

export const DIRECTOR_TOOL_DESCRIPTORS = Object.freeze([
  Object.freeze({
    name: 'search-media' as const,
    costUnits: 0.5,
    description: 'Search rights-eligible project media without mutating persistence.',
    inputSchema: Object.freeze({
      type: 'object', additionalProperties: false, required: ['query'],
      properties: Object.freeze({ query: stringSchema, limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 50 }) }),
    }),
  }),
  Object.freeze({
    name: 'create-story-plan' as const,
    costUnits: 1,
    description: 'Create a validated StoryPlan proposal for the exact base version.',
    inputSchema: Object.freeze({
      type: 'object', additionalProperties: false, required: ['plan', 'assetIds'],
      properties: Object.freeze({ plan: Object.freeze({ type: 'object' }), assetIds: Object.freeze({ type: 'array', uniqueItems: true, maxItems: 100, items: idSchema }) }),
    }),
  }),
  Object.freeze({
    name: 'propose-asset' as const,
    costUnits: 0.25,
    description: 'Propose one rights-eligible asset for a plan node without attaching it.',
    inputSchema: Object.freeze({
      type: 'object', additionalProperties: false, required: ['assetId', 'planNodeId', 'purpose'],
      properties: Object.freeze({ assetId: idSchema, planNodeId: idSchema, purpose: stringSchema }),
    }),
  }),
  Object.freeze({
    name: 'evaluate-candidate' as const,
    costUnits: 0.75,
    description: 'Evaluate bounded montage candidates against an explicit rubric.',
    inputSchema: Object.freeze({
      type: 'object', additionalProperties: false, required: ['candidates', 'rubric', 'minimumConfidence'],
      properties: Object.freeze({
        candidates: Object.freeze({ type: 'array', minItems: 1, maxItems: 20, items: Object.freeze({ type: 'object' }) }),
        rubric: Object.freeze({ type: 'object' }),
        minimumConfidence: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
      }),
    }),
  }),
  Object.freeze({
    name: 'propose-patch' as const,
    costUnits: 1,
    description: 'Propose bounded typed patch operations without applying them.',
    inputSchema: Object.freeze({
      type: 'object', additionalProperties: false, required: ['operations', 'assetIds', 'rationale'],
      properties: Object.freeze({
        operations: Object.freeze({ type: 'array', minItems: 1, maxItems: 100, items: Object.freeze({ type: 'object' }) }),
        assetIds: Object.freeze({ type: 'array', uniqueItems: true, maxItems: 100, items: idSchema }),
        rationale: stringSchema,
      }),
    }),
  }),
] as const)

export function createDirectorToolCatalog() {
  return Object.freeze({
    schemaVersion: 'director-tool-catalog/v1' as const,
    tools: DIRECTOR_TOOL_DESCRIPTORS,
    execution: Object.freeze({
      method: 'POST' as const,
      path: '/v1/director-tools',
      maxCalls: 20,
      validation: Object.freeze(['arguments', 'scope', 'rights', 'budget', 'base-version'] as const),
      semantics: 'preflight-entire-batch-before-first-handler' as const,
    }),
  })
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function record(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  const result = value as Record<string, unknown>
  assertDomain(Object.keys(result).every((key) => allowed.includes(key)), 'INVALID_ARGUMENT', `${field} contains unsupported properties`)
  return result
}

function openRecord(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function identity(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value.trim()), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

function boundedText(value: unknown, field: string, maximum = 500): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const normalized = value.trim()
  assertDomain(normalized.length >= 1 && normalized.length <= maximum, 'INVALID_ARGUMENT', `${field} must contain 1 to ${maximum} characters`)
  return normalized
}

function identities(value: unknown, field: string, maximum = 100): readonly string[] {
  assertDomain(Array.isArray(value) && value.length <= maximum, 'INVALID_ARGUMENT', `${field} must contain at most ${maximum} ids`)
  const result = value.map((item, index) => identity(item, `${field}[${index}]`))
  assertDomain(new Set(result).size === result.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  return Object.freeze(result)
}

function finiteUnit(value: unknown, field: string): number {
  assertDomain(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'INVALID_ARGUMENT', `${field} must be between 0 and 1`)
  return value
}

function stringArray(value: unknown, field: string, maximum = 100): readonly string[] {
  assertDomain(Array.isArray(value) && value.length <= maximum, 'INVALID_ARGUMENT', `${field} must be an array with at most ${maximum} values`)
  return Object.freeze(value.map((item, index) => boundedText(item, `${field}[${index}]`, 256)))
}

function parseStoryPlan(value: unknown): StoryPlan {
  const input = record(value, ['schemaVersion', 'objective', 'desiredActionRef', 'targetDurationMs', 'acts', 'blocks'], 'arguments.plan')
  assertDomain(input.schemaVersion === 1 || input.schemaVersion === 2, 'INVALID_ARGUMENT', 'arguments.plan.schemaVersion is invalid')
  const target = record(input.targetDurationMs, ['min', 'max'], 'arguments.plan.targetDurationMs')
  assertDomain(typeof target.min === 'number' && Number.isFinite(target.min) && target.min >= 0 && typeof target.max === 'number' && Number.isFinite(target.max) && target.max >= target.min, 'INVALID_ARGUMENT', 'arguments.plan.targetDurationMs is invalid')
  assertDomain(Array.isArray(input.acts) && input.acts.length >= 1 && input.acts.length <= 20, 'INVALID_ARGUMENT', 'arguments.plan.acts must contain 1 to 20 acts')
  const acts = input.acts.map((value, index) => {
    const act = record(value, ['id', 'role', 'blockIds'], `arguments.plan.acts[${index}]`)
    assertDomain(['opening', 'development', 'resolution'].includes(String(act.role)), 'INVALID_ARGUMENT', `arguments.plan.acts[${index}].role is invalid`)
    return Object.freeze({
      id: identity(act.id, `arguments.plan.acts[${index}].id`),
      role: act.role as 'opening' | 'development' | 'resolution',
      blockIds: identities(act.blockIds, `arguments.plan.acts[${index}].blockIds`),
    })
  })
  assertDomain(Array.isArray(input.blocks) && input.blocks.length >= 1 && input.blocks.length <= 100, 'INVALID_ARGUMENT', 'arguments.plan.blocks must contain 1 to 100 blocks')
  const blocks = input.blocks.map((value, index) => {
    const field = `arguments.plan.blocks[${index}]`
    const block = record(value, ['id', 'actId', 'role', 'intent', 'dependencies', 'sourceCandidateIds', 'durationTargetMs', 'content', 'presentation', 'sourceRangeId'], field)
    assertDomain(['hook', 'context', 'argument', 'proof', 'cta'].includes(String(block.role)), 'INVALID_ARGUMENT', `${field}.role is invalid`)
    assertDomain(['source-video', 'voiceover', 'cold-open-reference'].includes(String(block.presentation)), 'INVALID_ARGUMENT', `${field}.presentation is invalid`)
    const duration = record(block.durationTargetMs, ['min', 'ideal', 'max'], `${field}.durationTargetMs`)
    assertDomain([duration.min, duration.ideal, duration.max].every((item) => typeof item === 'number' && Number.isFinite(item)), 'INVALID_ARGUMENT', `${field}.durationTargetMs is invalid`)
    const content = record(block.content, ['claimIds', 'qualifierIds', 'proofIds', 'ctaId'], `${field}.content`)
    return Object.freeze({
      id: identity(block.id, `${field}.id`),
      actId: identity(block.actId, `${field}.actId`),
      role: block.role as 'hook' | 'context' | 'argument' | 'proof' | 'cta',
      intent: boundedText(block.intent, `${field}.intent`, 500),
      dependencies: identities(block.dependencies, `${field}.dependencies`),
      sourceCandidateIds: identities(block.sourceCandidateIds, `${field}.sourceCandidateIds`),
      durationTargetMs: Object.freeze({ min: duration.min as number, ideal: duration.ideal as number, max: duration.max as number }),
      content: Object.freeze({
        claimIds: identities(content.claimIds, `${field}.content.claimIds`),
        qualifierIds: identities(content.qualifierIds, `${field}.content.qualifierIds`),
        proofIds: identities(content.proofIds, `${field}.content.proofIds`),
        ...(content.ctaId === undefined ? {} : { ctaId: identity(content.ctaId, `${field}.content.ctaId`) }),
      }),
      presentation: block.presentation as 'source-video' | 'voiceover' | 'cold-open-reference',
      ...(block.sourceRangeId === undefined ? {} : { sourceRangeId: identity(block.sourceRangeId, `${field}.sourceRangeId`) }),
    })
  })
  const plan = Object.freeze({
    schemaVersion: input.schemaVersion,
    objective: boundedText(input.objective, 'arguments.plan.objective', 160),
    ...(input.desiredActionRef === undefined ? {} : { desiredActionRef: structuredClone(input.desiredActionRef) as StoryPlan['desiredActionRef'] }),
    targetDurationMs: Object.freeze({ min: target.min as number, max: target.max as number }),
    acts: Object.freeze(acts),
    blocks: Object.freeze(blocks),
  }) as StoryPlan
  validateStoryPlan(plan)
  return plan
}

function parseCandidate(value: unknown, index: number): DirectorMontageCandidate {
  const field = `arguments.candidates[${index}]`
  const input = record(value, ['id', 'hookId', 'blockOrder', 'assetIds', 'patternBreakIds', 'confidence', 'hardGateIssues', 'rubricSignals'], field)
  const rubricSignals = openRecord(input.rubricSignals, `${field}.rubricSignals`)
  const normalizedSignals = Object.fromEntries(Object.entries(rubricSignals).map(([key, signal]) => {
    assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(key) && typeof signal === 'number' && Number.isFinite(signal), 'INVALID_ARGUMENT', `${field}.rubricSignals is invalid`)
    return [key, signal]
  }))
  return Object.freeze({
    id: identity(input.id, `${field}.id`),
    hookId: identity(input.hookId, `${field}.hookId`),
    blockOrder: stringArray(input.blockOrder, `${field}.blockOrder`),
    assetIds: identities(input.assetIds, `${field}.assetIds`),
    patternBreakIds: identities(input.patternBreakIds, `${field}.patternBreakIds`),
    confidence: finiteUnit(input.confidence, `${field}.confidence`),
    hardGateIssues: stringArray(input.hardGateIssues, `${field}.hardGateIssues`),
    rubricSignals: Object.freeze(normalizedSignals),
  })
}

function parseArguments(name: DirectorToolName, value: unknown): DirectorToolArguments[DirectorToolName] {
  if (name === 'search-media') {
    const input = record(value, ['query', 'limit'], 'arguments')
    assertDomain(input.limit === undefined || (Number.isSafeInteger(input.limit) && Number(input.limit) >= 1 && Number(input.limit) <= 50), 'INVALID_ARGUMENT', 'arguments.limit must be between 1 and 50')
    return Object.freeze({ query: boundedText(input.query, 'arguments.query'), ...(input.limit === undefined ? {} : { limit: Number(input.limit) }) })
  }
  if (name === 'create-story-plan') {
    const input = record(value, ['plan', 'assetIds'], 'arguments')
    const plan = parseStoryPlan(input.plan)
    return Object.freeze({ plan, assetIds: identities(input.assetIds, 'arguments.assetIds') })
  }
  if (name === 'propose-asset') {
    const input = record(value, ['assetId', 'planNodeId', 'purpose'], 'arguments')
    return Object.freeze({ assetId: identity(input.assetId, 'arguments.assetId'), planNodeId: identity(input.planNodeId, 'arguments.planNodeId'), purpose: boundedText(input.purpose, 'arguments.purpose') })
  }
  if (name === 'evaluate-candidate') {
    const input = record(value, ['candidates', 'rubric', 'minimumConfidence'], 'arguments')
    assertDomain(Array.isArray(input.candidates) && input.candidates.length >= 1 && input.candidates.length <= 20, 'INVALID_ARGUMENT', 'arguments.candidates must contain 1 to 20 candidates')
    const rubric = record(input.rubric, ['id', 'weights'], 'arguments.rubric')
    const weights = openRecord(rubric.weights, 'arguments.rubric.weights')
    const normalizedWeights = Object.fromEntries(Object.entries(weights).map(([key, weight]) => {
      assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(key) && typeof weight === 'number' && Number.isFinite(weight) && weight >= 0, 'INVALID_ARGUMENT', 'arguments.rubric.weights is invalid')
      return [key, weight]
    }))
    assertDomain(Object.keys(normalizedWeights).length >= 1, 'INVALID_ARGUMENT', 'arguments.rubric.weights cannot be empty')
    const candidates = input.candidates.map(parseCandidate)
    assertDomain(new Set(candidates.map((candidate) => candidate.id)).size === candidates.length, 'INVALID_ARGUMENT', 'arguments.candidates contains duplicate ids')
    return Object.freeze({
      candidates: Object.freeze(candidates),
      rubric: Object.freeze({ id: identity(rubric.id, 'arguments.rubric.id'), weights: Object.freeze(normalizedWeights) }),
      minimumConfidence: finiteUnit(input.minimumConfidence, 'arguments.minimumConfidence'),
    })
  }
  const input = record(value, ['operations', 'assetIds', 'rationale'], 'arguments')
  assertDomain(Array.isArray(input.operations) && input.operations.length >= 1 && input.operations.length <= 100, 'INVALID_ARGUMENT', 'arguments.operations must contain 1 to 100 operations')
  const operations = input.operations.map((operation, index) => {
    const item = record(operation, ['operation', 'path', 'value'], `arguments.operations[${index}]`)
    assertDomain(['add', 'replace', 'remove'].includes(String(item.operation)), 'INVALID_ARGUMENT', `arguments.operations[${index}].operation is invalid`)
    const path = boundedText(item.path, `arguments.operations[${index}].path`, 500)
    assertDomain(path.startsWith('/') && !path.includes('..'), 'INVALID_ARGUMENT', `arguments.operations[${index}].path is invalid`)
    assertDomain(item.operation !== 'remove' || item.value === undefined, 'INVALID_ARGUMENT', 'remove operations cannot contain value')
    assertDomain(item.operation === 'remove' || item.value !== undefined, 'INVALID_ARGUMENT', 'add and replace operations require value')
    return Object.freeze({ operation: item.operation as DirectorPatchOperation['operation'], path, ...(item.value === undefined ? {} : { value: structuredClone(item.value) }) })
  })
  const assetIds = identities(input.assetIds, 'arguments.assetIds')
  for (const [index, operation] of operations.entries()) {
    if (/\/(?:asset|assetId|artifactId)$/i.test(operation.path)) {
      assertDomain(typeof operation.value === 'string' && assetIds.includes(operation.value), 'ASSET_RIGHTS_BLOCKED', `arguments.operations[${index}] references an asset absent from assetIds`)
    }
  }
  return Object.freeze({ operations: Object.freeze(operations), assetIds, rationale: boundedText(input.rationale, 'arguments.rationale', 1000) })
}

function referencedAssetIds(call: DirectorToolCall): readonly string[] {
  if (call.name === 'create-story-plan' || call.name === 'propose-patch') return call.arguments.assetIds
  if (call.name === 'propose-asset') return Object.freeze([call.arguments.assetId])
  if (call.name === 'evaluate-candidate') return Object.freeze([...new Set(call.arguments.candidates.flatMap((candidate) => candidate.assetIds))].sort())
  return Object.freeze([])
}

export function parseDirectorToolCall(value: unknown): Readonly<DirectorToolCall> {
  const input = record(value, ['id', 'name', 'arguments', 'scope', 'baseVersionId', 'estimatedCost', 'rights'], 'Director tool call')
  assertDomain(typeof input.name === 'string' && DIRECTOR_TOOL_NAMES.includes(input.name as DirectorToolName), 'INVALID_ARGUMENT', 'Unknown Director tool')
  const name = input.name as DirectorToolName
  const scope = record(input.scope, ['workspaceId', 'projectId'], 'Director tool scope')
  assertDomain(typeof input.estimatedCost === 'number' && Number.isFinite(input.estimatedCost) && input.estimatedCost >= 0, 'INVALID_ARGUMENT', 'Director tool estimatedCost must be finite and non-negative')
  assertDomain(Array.isArray(input.rights) && input.rights.length <= 100, 'INVALID_ARGUMENT', 'Director tool rights evidence must be an array with at most 100 entries')
  const rights = input.rights.map((evidence, index) => {
    const item = record(evidence, ['assetId', 'snapshotHash'], `Director tool rights[${index}]`)
    const snapshotHash = boundedText(item.snapshotHash, `Director tool rights[${index}].snapshotHash`, 64)
    assertDomain(HASH.test(snapshotHash), 'INVALID_ARGUMENT', `Director tool rights[${index}].snapshotHash is invalid`)
    return Object.freeze({ assetId: identity(item.assetId, `Director tool rights[${index}].assetId`), snapshotHash })
  })
  assertDomain(new Set(rights.map((item) => item.assetId)).size === rights.length, 'INVALID_ARGUMENT', 'Director tool rights evidence contains duplicate assets')
  const call = Object.freeze({
    id: identity(input.id, 'Director tool call id'),
    name,
    arguments: parseArguments(name, input.arguments),
    scope: Object.freeze({ workspaceId: identity(scope.workspaceId, 'Director tool workspaceId'), projectId: identity(scope.projectId, 'Director tool projectId') }),
    baseVersionId: identity(input.baseVersionId, 'Director tool baseVersionId'),
    estimatedCost: input.estimatedCost,
    rights: Object.freeze(rights),
  }) as Readonly<DirectorToolCall>
  const referenced = [...referencedAssetIds(call)].sort()
  const evidenced = rights.map((item) => item.assetId).sort()
  assertDomain(JSON.stringify(referenced) === JSON.stringify(evidenced), 'ASSET_RIGHTS_BLOCKED', 'Director tool rights evidence must exactly cover referenced assets')
  return call
}

export function parseDirectorToolCalls(value: unknown): readonly Readonly<DirectorToolCall>[] {
  assertDomain(Array.isArray(value) && value.length >= 1 && value.length <= 20, 'INVALID_ARGUMENT', 'Director tool execution must contain 1 to 20 calls')
  const calls = value.map(parseDirectorToolCall)
  assertDomain(new Set(calls.map((call) => call.id)).size === calls.length, 'INVALID_ARGUMENT', 'Director tool call ids must be unique')
  return Object.freeze(calls)
}

export function preflightDirectorToolCalls(callsValue: unknown, context: DirectorToolContext) {
  const calls = parseDirectorToolCalls(callsValue)
  let remaining = context.budgetRemaining
  for (const call of calls) {
    const descriptor = DIRECTOR_TOOL_DESCRIPTORS.find((item) => item.name === call.name)
    assertDomain(call.estimatedCost === descriptor?.costUnits, 'INVALID_ARGUMENT', 'Director tool estimatedCost does not match the fixed catalog cost')
    if (call.scope.workspaceId !== context.workspaceId || call.scope.projectId !== context.projectId) throw new DomainError('INVALID_SCOPE', 'Director tool scope mismatch')
    if (call.baseVersionId !== context.baseVersionId) throw new DomainError('VERSION_CONFLICT', 'Director tool base version is stale')
    for (const evidence of call.rights) {
      if (context.eligibleAssetRights.get(evidence.assetId) !== evidence.snapshotHash) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Director tool asset rights are stale or ineligible', { assetId: evidence.assetId })
    }
    if (call.estimatedCost > remaining) throw new DomainError('GOVERNANCE_LIMIT_EXCEEDED', 'Director tool execution exceeds remaining budget')
    remaining -= call.estimatedCost
  }
  return Object.freeze({ calls, budgetRemaining: remaining })
}
