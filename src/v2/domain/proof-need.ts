import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import {
  type EvidenceCategory,
} from './evidence-segment.ts'
import { assertDomain } from './errors.ts'
import {
  type StoryAct,
  type StoryBlock,
} from './story-plan.ts'
import {
  type VariantRecipeRun,
} from './variant-recipe.ts'

export const PROOF_NEED_RUN_SCHEMA_VERSION =
  'proof-need-run/v1' as const
export const PROOF_NEED_POLICY_VERSION =
  'proof-need-policy/v1' as const
export const PROOF_DIRECTED_STORY_PLAN_SCHEMA_VERSION =
  'proof-directed-story-plan/v1' as const

export const PROOF_NEED_TYPES = [
  'testimonial',
  'data',
  'demonstration',
  'none',
] as const

export const PROOF_CLAIM_KINDS = [
  'outcome',
  'quantified',
  'mechanism',
  'low-risk',
] as const

export type ProofNeedType = typeof PROOF_NEED_TYPES[number]
export type ProofClaimKind = typeof PROOF_CLAIM_KINDS[number]
export type ProofNeedFunction =
  | 'build-trust'
  | 'substantiate-quantified-claim'
  | 'demonstrate-mechanism'
  | 'no-proof-needed'
export type ProofNeedResolution =
  | 'selected-evidence'
  | 'proof-unavailable'
  | 'no-proof-needed'

export interface ProofNeedDeclarationInput {
  storyBlockId: string
  claimId: string
  claimText: string
  claimKind: ProofClaimKind
  offerId?: string
  objection?: string
}

export interface ProofEvidenceCandidate {
  id: string
  evidenceHash: string
  category: EvidenceCategory
  sourceArtifactId: string
  sourceRangeMs: readonly [number, number]
  contextRangeMs: readonly [number, number]
  credibilityScore: number
  specificityScore: number
  authenticityScore: number
  reuseAllowed: boolean
  reuseReasons: readonly string[]
}

export interface ProofNeedMoment {
  placement:
    | 'existing-proof-block'
    | 'after-claim-before-next-block'
    | 'not-applicable'
  afterStoryBlockId: string
  beforeStoryBlockId?: string
  proofStoryBlockId?: string
  timelineFrame: number
  timelineMs: number
}

export interface ProofNeedSearchAudit {
  strategy: 'evidence-first'
  attempted: boolean
  categories: readonly EvidenceCategory[]
  candidateEvidenceIds: readonly string[]
  rejectedEvidence: readonly Readonly<{
    evidenceId: string
    reasons: readonly string[]
  }>[]
}

export interface ProofNeedSelectedEvidence {
  id: string
  evidenceHash: string
  category: EvidenceCategory
  sourceArtifactId: string
  sourceRangeMs: readonly [number, number]
  contextRangeMs: readonly [number, number]
  score: number
}

export interface ProofNeedItem {
  id: string
  sequence: number
  storyBlockId: string
  claimId: string
  claimText: string
  claimKind: ProofClaimKind
  type: ProofNeedType
  function: ProofNeedFunction
  required: boolean
  moment: Readonly<ProofNeedMoment>
  search: Readonly<ProofNeedSearchAudit>
  resolution: ProofNeedResolution
  selectedEvidence?: Readonly<ProofNeedSelectedEvidence>
  proofUnavailable: boolean
  genericCardGenerated: false
  itemHash: string
}

export interface ProofDirectedStoryPlan {
  schemaVersion: typeof PROOF_DIRECTED_STORY_PLAN_SCHEMA_VERSION
  id: string
  baseStoryPlanId: string
  baseStoryPlanHash: string
  objective: string
  acts: readonly Readonly<StoryAct>[]
  blocks: readonly Readonly<StoryBlock>[]
  proofNeeds: readonly Readonly<{
    id: string
    storyBlockId: string
    claimId: string
    type: ProofNeedType
    function: ProofNeedFunction
    required: boolean
    moment: Readonly<ProofNeedMoment>
    resolution: ProofNeedResolution
    selectedEvidenceId?: string
    proofUnavailable: boolean
  }>[]
  storyPlanHash: string
}

export interface ProofNeedRun {
  schemaVersion: typeof PROOF_NEED_RUN_SCHEMA_VERSION
  policyVersion: typeof PROOF_NEED_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  targetRecipeId: string
  targetRecipeHash: string
  baseStoryPlanId: string
  baseStoryPlanHash: string
  objective: string
  storyPlan: Readonly<ProofDirectedStoryPlan>
  items: readonly Readonly<ProofNeedItem>[]
  summary: Readonly<{
    needCount: number
    requiredCount: number
    evidenceSearchCount: number
    selectedEvidenceCount: number
    proofUnavailableCount: number
    noProofNeededCount: number
    genericCardCount: 0
  }>
  createdByClientId: string
  createdAt: string
  runHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function text(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  assertDomain(
    typeof value === 'string' &&
      value.trim().length >= minimum &&
      value.trim().length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must contain ${minimum} to ${maximum} characters`,
  )
  return value.trim()
}

function optionalText(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  return text(value, field, 2, 500)
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function integer(value: unknown, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) && Number(value) >= 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-negative safe integer`,
  )
  return Number(value)
}

function range(
  value: unknown,
  field: string,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      Number.isSafeInteger(value[1]) &&
      value[0] >= 0 &&
      value[1] > value[0],
    'INVALID_ARGUMENT',
    `${field} must be a positive integer range`,
  )
  return Object.freeze([value[0], value[1]])
}

function score(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between zero and one`,
  )
  return Number(value.toFixed(6))
}

export function proofNeedPolicyForClaimKind(
  claimKind: ProofClaimKind,
): Readonly<{
  type: ProofNeedType
  function: ProofNeedFunction
  required: boolean
  categories: readonly EvidenceCategory[]
}> {
  if (claimKind === 'low-risk') {
    return Object.freeze({
      type: 'none',
      function: 'no-proof-needed',
      required: false,
      categories: Object.freeze([] as EvidenceCategory[]),
    })
  }
  if (claimKind === 'outcome') {
    return Object.freeze({
      type: 'testimonial',
      function: 'build-trust',
      required: true,
      categories: Object.freeze(
        ['testimonial', 'case-study'] as EvidenceCategory[],
      ),
    })
  }
  if (claimKind === 'quantified') {
    return Object.freeze({
      type: 'data',
      function: 'substantiate-quantified-claim',
      required: true,
      categories: Object.freeze(
        [
          'financial-result',
          'before-after',
          'authority',
          'case-study',
        ] as EvidenceCategory[],
      ),
    })
  }
  return Object.freeze({
    type: 'demonstration',
    function: 'demonstrate-mechanism',
    required: true,
    categories: Object.freeze(
      ['demonstration'] as EvidenceCategory[],
    ),
  })
}

function moment(
  recipe: Readonly<VariantRecipeRun>,
  claimBlock: Readonly<StoryBlock>,
  required: boolean,
): Readonly<ProofNeedMoment> {
  const blocks = recipe.storyPlan.blocks
  const claimIndex = blocks.findIndex((block) =>
    block.id === claimBlock.id)
  assertDomain(
    claimIndex >= 0,
    'PRECONDITION_REQUIRED',
    'Proof claim block is absent from the target StoryPlan',
  )
  const proofBlock = blocks
    .slice(claimIndex + 1)
    .find((block) => block.role === 'proof')
  const immediateNext = blocks[claimIndex + 1]
  const claimClip = recipe.editPlan.videoTracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.storyBlockId === claimBlock.id)
  assertDomain(
    Boolean(claimClip),
    'PRECONDITION_REQUIRED',
    'Proof claim block has no exact EditPlan clip',
  )
  const proofClip = proofBlock
    ? recipe.editPlan.videoTracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.storyBlockId === proofBlock.id)
    : undefined
  const timelineFrame = required && proofClip
    ? proofClip.timelineRangeFrames[0]
    : claimClip!.timelineRangeFrames[1]
  return Object.freeze({
    placement: !required
      ? 'not-applicable' as const
      : proofBlock
        ? 'existing-proof-block' as const
        : 'after-claim-before-next-block' as const,
    afterStoryBlockId: claimBlock.id,
    ...(immediateNext
      ? { beforeStoryBlockId: immediateNext.id }
      : {}),
    ...(proofBlock
      ? { proofStoryBlockId: proofBlock.id }
      : {}),
    timelineFrame,
    timelineMs: Math.round(
      timelineFrame * 1_000 / recipe.editPlan.fps,
    ),
  })
}

function candidate(
  value: Readonly<ProofEvidenceCandidate>,
  index: number,
): Readonly<ProofEvidenceCandidate> {
  assertDomain(
    [
      'testimonial',
      'financial-result',
      'before-after',
      'hearsay',
      'authority',
      'case-study',
      'demonstration',
    ].includes(value.category),
    'INVALID_ARGUMENT',
    `evidenceCandidates[${index}].category is invalid`,
  )
  assertDomain(
    typeof value.reuseAllowed === 'boolean' &&
      Array.isArray(value.reuseReasons) &&
      value.reuseReasons.every((reason) =>
        typeof reason === 'string' && reason.length > 0),
    'INVALID_ARGUMENT',
    `evidenceCandidates[${index}] reuse decision is invalid`,
  )
  return Object.freeze({
    id: identity(value.id, `evidenceCandidates[${index}].id`),
    evidenceHash: hash(
      value.evidenceHash,
      `evidenceCandidates[${index}].evidenceHash`,
    ),
    category: value.category,
    sourceArtifactId: identity(
      value.sourceArtifactId,
      `evidenceCandidates[${index}].sourceArtifactId`,
    ),
    sourceRangeMs: range(
      value.sourceRangeMs,
      `evidenceCandidates[${index}].sourceRangeMs`,
    ),
    contextRangeMs: range(
      value.contextRangeMs,
      `evidenceCandidates[${index}].contextRangeMs`,
    ),
    credibilityScore: score(
      value.credibilityScore,
      `evidenceCandidates[${index}].credibilityScore`,
    ),
    specificityScore: score(
      value.specificityScore,
      `evidenceCandidates[${index}].specificityScore`,
    ),
    authenticityScore: score(
      value.authenticityScore,
      `evidenceCandidates[${index}].authenticityScore`,
    ),
    reuseAllowed: value.reuseAllowed,
    reuseReasons: Object.freeze([...value.reuseReasons]),
  })
}

function selectedEvidence(
  candidates: readonly Readonly<ProofEvidenceCandidate>[],
  categories: readonly EvidenceCategory[],
): Readonly<ProofNeedSelectedEvidence> | undefined {
  const selected = candidates
    .filter((entry) =>
      categories.includes(entry.category) && entry.reuseAllowed)
    .map((entry) => Object.freeze({
      entry,
      score: Number((
        entry.credibilityScore * .4 +
        entry.specificityScore * .35 +
        entry.authenticityScore * .25
      ).toFixed(6)),
    }))
    .toSorted((left, right) =>
      right.score - left.score ||
      left.entry.id.localeCompare(right.entry.id))[0]
  if (!selected) return undefined
  return Object.freeze({
    id: selected.entry.id,
    evidenceHash: selected.entry.evidenceHash,
    category: selected.entry.category,
    sourceArtifactId: selected.entry.sourceArtifactId,
    sourceRangeMs: selected.entry.sourceRangeMs,
    contextRangeMs: selected.entry.contextRangeMs,
    score: selected.score,
  })
}

function itemBody(value: ProofNeedItem) {
  return {
    id: value.id,
    sequence: value.sequence,
    storyBlockId: value.storyBlockId,
    claimId: value.claimId,
    claimText: value.claimText,
    claimKind: value.claimKind,
    type: value.type,
    function: value.function,
    required: value.required,
    moment: value.moment,
    search: value.search,
    resolution: value.resolution,
    ...(value.selectedEvidence
      ? { selectedEvidence: value.selectedEvidence }
      : {}),
    proofUnavailable: value.proofUnavailable,
    genericCardGenerated: value.genericCardGenerated,
  }
}

function proofNeedItem(input: {
  runId: string
  sequence: number
  declaration: Readonly<ProofNeedDeclarationInput>
  recipe: Readonly<VariantRecipeRun>
  evidenceCandidates: readonly Readonly<ProofEvidenceCandidate>[]
}): Readonly<ProofNeedItem> {
  assertDomain(
    PROOF_CLAIM_KINDS.includes(input.declaration.claimKind),
    'INVALID_ARGUMENT',
    `declarations[${input.sequence - 1}].claimKind is invalid`,
  )
  const storyBlockId = identity(
    input.declaration.storyBlockId,
    `declarations[${input.sequence - 1}].storyBlockId`,
  )
  const claimId = identity(
    input.declaration.claimId,
    `declarations[${input.sequence - 1}].claimId`,
  )
  const claimBlock = input.recipe.storyPlan.blocks.find((block) =>
    block.id === storyBlockId)
  assertDomain(
    Boolean(claimBlock) &&
      claimBlock!.content.claimIds.includes(claimId),
    'PRECONDITION_REQUIRED',
    'Proof declaration must reference a claim in the exact target StoryPlan block',
  )
  const policy = proofNeedPolicyForClaimKind(
    input.declaration.claimKind,
  )
  const candidates = Object.freeze(
    input.evidenceCandidates.map(candidate),
  )
  assertDomain(
    new Set(candidates.map((entry) => entry.id)).size ===
      candidates.length,
    'INVALID_ARGUMENT',
    'Evidence candidates must not contain duplicate identities',
  )
  const selected = policy.required
    ? selectedEvidence(candidates, policy.categories)
    : undefined
  const resolution: ProofNeedResolution = !policy.required
    ? 'no-proof-needed'
    : selected
      ? 'selected-evidence'
      : 'proof-unavailable'
  const body = {
    id: `proof-need-${calculateCanonicalHash({
      runId: input.runId,
      sequence: input.sequence,
      storyBlockId,
      claimId,
    }).slice(0, 48)}`,
    sequence: input.sequence,
    storyBlockId,
    claimId,
    claimText: text(
      input.declaration.claimText,
      `declarations[${input.sequence - 1}].claimText`,
      2,
      2_000,
    ),
    claimKind: input.declaration.claimKind,
    type: policy.type,
    function: policy.function,
    required: policy.required,
    moment: moment(input.recipe, claimBlock!, policy.required),
    search: Object.freeze({
      strategy: 'evidence-first' as const,
      attempted: policy.required,
      categories: policy.categories,
      candidateEvidenceIds: Object.freeze(
        candidates.map((entry) => entry.id).toSorted(),
      ),
      rejectedEvidence: Object.freeze(candidates
        .filter((entry) =>
          !policy.categories.includes(entry.category) ||
          !entry.reuseAllowed)
        .map((entry) => Object.freeze({
          evidenceId: entry.id,
          reasons: Object.freeze(
            policy.categories.includes(entry.category)
              ? [...entry.reuseReasons]
              : ['PROOF_TYPE_INCOMPATIBLE'],
          ),
        }))
        .toSorted((left, right) =>
          left.evidenceId.localeCompare(right.evidenceId))),
    }),
    resolution,
    ...(selected ? { selectedEvidence: selected } : {}),
    proofUnavailable: resolution === 'proof-unavailable',
    genericCardGenerated: false as const,
  }
  return Object.freeze({
    ...body,
    itemHash: calculateCanonicalHash(body),
  })
}

function storyBody(value: ProofDirectedStoryPlan) {
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    baseStoryPlanId: value.baseStoryPlanId,
    baseStoryPlanHash: value.baseStoryPlanHash,
    objective: value.objective,
    acts: value.acts,
    blocks: value.blocks,
    proofNeeds: value.proofNeeds,
  }
}

function proofDirectedStoryPlan(
  runId: string,
  recipe: Readonly<VariantRecipeRun>,
  items: readonly Readonly<ProofNeedItem>[],
): Readonly<ProofDirectedStoryPlan> {
  const body = {
    schemaVersion: PROOF_DIRECTED_STORY_PLAN_SCHEMA_VERSION,
    id: `proof-story-${calculateCanonicalHash({
      runId,
      baseStoryPlanId: recipe.storyPlan.id,
    }).slice(0, 48)}`,
    baseStoryPlanId: recipe.storyPlan.id,
    baseStoryPlanHash: recipe.storyPlan.storyHash,
    objective: recipe.objective,
    acts: recipe.storyPlan.acts,
    blocks: recipe.storyPlan.blocks,
    proofNeeds: Object.freeze(items.map((item) =>
      Object.freeze({
        id: item.id,
        storyBlockId: item.storyBlockId,
        claimId: item.claimId,
        type: item.type,
        function: item.function,
        required: item.required,
        moment: item.moment,
        resolution: item.resolution,
        ...(item.selectedEvidence
          ? { selectedEvidenceId: item.selectedEvidence.id }
          : {}),
        proofUnavailable: item.proofUnavailable,
      }))),
  }
  return Object.freeze({
    ...body,
    storyPlanHash: calculateCanonicalHash(body),
  })
}

function runBody(value: ProofNeedRun) {
  return {
    schemaVersion: value.schemaVersion,
    policyVersion: value.policyVersion,
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    batchId: value.batchId,
    targetRecipeId: value.targetRecipeId,
    targetRecipeHash: value.targetRecipeHash,
    baseStoryPlanId: value.baseStoryPlanId,
    baseStoryPlanHash: value.baseStoryPlanHash,
    objective: value.objective,
    storyPlan: value.storyPlan,
    items: value.items,
    summary: value.summary,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  }
}

export function createProofNeedRun(input: {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  targetRecipe: Readonly<VariantRecipeRun>
  declarations: readonly Readonly<ProofNeedDeclarationInput>[]
  evidenceCandidates:
    readonly (readonly Readonly<ProofEvidenceCandidate>[])[]
  createdByClientId: string
  createdAt: string
}): Readonly<ProofNeedRun> {
  const id = identity(input.id, 'id')
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const batchId = identity(input.batchId, 'batchId')
  assertDomain(
    input.targetRecipe.workspaceId === workspaceId &&
      input.targetRecipe.projectId === projectId &&
      input.targetRecipe.batchId === batchId &&
      input.targetRecipe.status !== 'excluded',
    'PRECONDITION_REQUIRED',
    'Proof needs require a usable VariantRecipe in the same project and batch',
  )
  assertDomain(
    Array.isArray(input.declarations) &&
      input.declarations.length >= 1 &&
      input.declarations.length <= 16 &&
      input.evidenceCandidates.length === input.declarations.length,
    'INVALID_ARGUMENT',
    'Proof declarations and candidate sets must contain one to sixteen matching entries',
  )
  const keys = input.declarations.map((entry) =>
    `${entry.storyBlockId}\u0000${entry.claimId}`)
  assertDomain(
    new Set(keys).size === keys.length,
    'INVALID_ARGUMENT',
    'Proof declarations must not repeat a StoryPlan claim',
  )
  const items = Object.freeze(input.declarations.map(
    (declaration, index) => proofNeedItem({
      runId: id,
      sequence: index + 1,
      declaration,
      recipe: input.targetRecipe,
      evidenceCandidates: input.evidenceCandidates[index]!,
    }),
  ))
  const storyPlan = proofDirectedStoryPlan(
    id,
    input.targetRecipe,
    items,
  )
  const summary = Object.freeze({
    needCount: items.length,
    requiredCount: items.filter((item) => item.required).length,
    evidenceSearchCount: items.filter((item) =>
      item.search.attempted).length,
    selectedEvidenceCount: items.filter((item) =>
      item.resolution === 'selected-evidence').length,
    proofUnavailableCount: items.filter((item) =>
      item.resolution === 'proof-unavailable').length,
    noProofNeededCount: items.filter((item) =>
      item.resolution === 'no-proof-needed').length,
    genericCardCount: 0 as const,
  })
  const body = {
    schemaVersion: PROOF_NEED_RUN_SCHEMA_VERSION,
    policyVersion: PROOF_NEED_POLICY_VERSION,
    id,
    workspaceId,
    projectId,
    batchId,
    targetRecipeId: input.targetRecipe.id,
    targetRecipeHash: input.targetRecipe.runHash,
    baseStoryPlanId: input.targetRecipe.storyPlan.id,
    baseStoryPlanHash: input.targetRecipe.storyPlan.storyHash,
    objective: input.targetRecipe.objective,
    storyPlan,
    items,
    summary,
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  }
  return Object.freeze({
    ...body,
    runHash: calculateCanonicalHash(body),
  })
}

function assertHydratedItem(
  value: Readonly<ProofNeedItem>,
  index: number,
) {
  identity(value.id, `items[${index}].id`)
  assertDomain(
    value.sequence === index + 1 &&
      PROOF_CLAIM_KINDS.includes(value.claimKind) &&
      PROOF_NEED_TYPES.includes(value.type) &&
      ['build-trust', 'substantiate-quantified-claim',
        'demonstrate-mechanism', 'no-proof-needed']
        .includes(value.function) &&
      ['selected-evidence', 'proof-unavailable', 'no-proof-needed']
        .includes(value.resolution) &&
      value.genericCardGenerated === false &&
      value.proofUnavailable ===
        (value.resolution === 'proof-unavailable') &&
      value.search.strategy === 'evidence-first' &&
      value.search.attempted === value.required,
    'PERSISTENCE_CONFLICT',
    'Persisted ProofNeed item projections are inconsistent',
  )
  if (value.resolution === 'selected-evidence') {
    assertDomain(
      Boolean(value.selectedEvidence),
      'PERSISTENCE_CONFLICT',
      'Selected proof evidence is missing',
    )
  } else {
    assertDomain(
      value.selectedEvidence === undefined,
      'PERSISTENCE_CONFLICT',
      'Non-selected proof need cannot carry evidence',
    )
  }
  assertDomain(
    value.itemHash === calculateCanonicalHash(itemBody(value)),
    'PERSISTENCE_CONFLICT',
    'Persisted ProofNeed item hash is invalid',
  )
}

export function hydrateProofNeedRun(
  value: Readonly<ProofNeedRun>,
): Readonly<ProofNeedRun> {
  assertDomain(
    value.schemaVersion === PROOF_NEED_RUN_SCHEMA_VERSION &&
      value.policyVersion === PROOF_NEED_POLICY_VERSION &&
      Array.isArray(value.items) &&
      value.items.length >= 1 &&
      value.items.length <= 16,
    'PERSISTENCE_CONFLICT',
    'Persisted ProofNeed run version or items are invalid',
  )
  value.items.forEach(assertHydratedItem)
  assertDomain(
    value.storyPlan.schemaVersion ===
      PROOF_DIRECTED_STORY_PLAN_SCHEMA_VERSION &&
      value.storyPlan.baseStoryPlanId === value.baseStoryPlanId &&
      value.storyPlan.baseStoryPlanHash === value.baseStoryPlanHash &&
      value.storyPlan.proofNeeds.length === value.items.length &&
      value.storyPlan.storyPlanHash ===
        calculateCanonicalHash(storyBody(value.storyPlan)),
    'PERSISTENCE_CONFLICT',
    'Persisted proof-directed StoryPlan is inconsistent',
  )
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index]!
    const need = value.storyPlan.proofNeeds[index]!
    assertDomain(
      need.id === item.id &&
        need.type === item.type &&
        need.function === item.function &&
        need.resolution === item.resolution &&
        need.proofUnavailable === item.proofUnavailable &&
        need.selectedEvidenceId === item.selectedEvidence?.id,
      'PERSISTENCE_CONFLICT',
      'StoryPlan proof declaration diverges from its ProofNeed item',
    )
  }
  const expectedSummary = {
    needCount: value.items.length,
    requiredCount: value.items.filter((item) => item.required).length,
    evidenceSearchCount: value.items.filter((item) =>
      item.search.attempted).length,
    selectedEvidenceCount: value.items.filter((item) =>
      item.resolution === 'selected-evidence').length,
    proofUnavailableCount: value.items.filter((item) =>
      item.resolution === 'proof-unavailable').length,
    noProofNeededCount: value.items.filter((item) =>
      item.resolution === 'no-proof-needed').length,
    genericCardCount: 0,
  }
  assertDomain(
    stableSerialize(value.summary) ===
      stableSerialize(expectedSummary) &&
      value.runHash === calculateCanonicalHash(runBody(value)),
    'PERSISTENCE_CONFLICT',
    'Persisted ProofNeed summary or run hash is invalid',
  )
  integer(value.summary.needCount, 'summary.needCount')
  hash(value.targetRecipeHash, 'targetRecipeHash')
  hash(value.baseStoryPlanHash, 'baseStoryPlanHash')
  instant(value.createdAt, 'createdAt')
  return Object.freeze(value)
}
