import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import {
  COMPATIBILITY_ROLES,
  hydrateCompatibilityGraph,
  type CompatibilityEdge,
  type CompatibilityGraphRun,
  type CompatibilityNode,
  type CompatibilityRole,
} from './compatibility-graph.ts'
import { assertDomain } from './errors.ts'
import {
  validateStoryPlan,
  type StoryAct,
  type StoryBlock,
  type StoryPlan,
} from './story-plan.ts'

export const VARIANT_RECIPE_SCHEMA_VERSION =
  'variant-recipe/v1' as const
export const VARIANT_RECIPE_POLICY_VERSION =
  'variant-recipe-policy/v1' as const
export const VARIANT_RECIPE_SCORE_VERSION =
  'variant-recipe-score/v1' as const
export const VARIANT_RECIPE_COMPILER_VERSION =
  'variant-recipe-compiler/v1' as const
export const VARIANT_EDIT_PLAN_SCHEMA_VERSION =
  'variant-edit-plan/v1' as const

export type VariantRecipeStatus =
  'candidate' | 'selected' | 'excluded'
export type VariantRecipeLineageUsage = 'primary' | 'cold-open'

export interface VariantRecipeSelectionInput {
  hookNodeId: string
  bodyNodeId: string
  proofNodeId?: string
  ctaNodeId: string
}

export interface VariantRecipeAssumptionInput {
  code: string
  statement: string
  evidenceRefs: readonly string[]
}

export interface VariantRecipeColdOpenInput {
  nodeId: string
  sourceRangeMs: readonly [number, number]
  returnAtRole: 'hook'
}

export interface VariantRecipeColdOpen {
  nodeId: string
  sourceSegmentId: string
  sourceRangeMs: readonly [number, number]
  returnAtRole: 'hook'
  coldOpenHash: string
}

export interface VariantRecipeAssumption {
  code: string
  statement: string
  evidenceRefs: readonly string[]
  assumptionHash: string
}

export interface VariantRecipeSourceSegment {
  id: string
  usage: VariantRecipeLineageUsage
  role: CompatibilityRole
  nodeId: string
  takeId: string
  takeHash: string
  scriptBlockId: string
  sourceArtifactId: string
  sourceHash: string
  sourceRangeMs: readonly [number, number]
  durationMs: number
  segmentHash: string
}

export interface VariantRecipeLineageEntry {
  id: string
  sequence: number
  usage: VariantRecipeLineageUsage
  role: CompatibilityRole
  nodeId: string
  takeId: string
  takeHash: string
  scriptBlockId: string
  groupId: string
  sourceSegmentId: string
  sourceArtifactId: string
  sourceHash: string
  sourceRangeMs: readonly [number, number]
  lineageHash: string
}

export interface VariantRecipeProofPolicy {
  version: typeof VARIANT_RECIPE_POLICY_VERSION
  objective: string
  baseRequirement: 'required' | 'optional'
  effectiveRequirement: 'required' | 'optional'
  stricterRequestApplied: boolean
  reasonCode: string
  policyHash: string
}

export interface VariantRecipeScoreDimension {
  dimension:
    | 'minimum-edge'
    | 'weighted-edge'
    | 'objective-fit'
    | 'lineage-completeness'
  score: number
  weight: number
  evidenceRefs: readonly string[]
  reasonCode: string
  scoreHash: string
}

export interface VariantRecipeScores {
  version: typeof VARIANT_RECIPE_SCORE_VERSION
  minimumEdgeScore: number
  averageEdgeScore: number
  weightedEdgeScore: number
  objectiveScore: number
  lineageCompletenessScore: number
  totalScore: number
  dimensions: readonly Readonly<VariantRecipeScoreDimension>[]
  scoresHash: string
}

export interface CompiledVariantStoryPlan extends StoryPlan {
  id: string
  compilerVersion: typeof VARIANT_RECIPE_COMPILER_VERSION
  storyHash: string
}

export interface CompiledVariantClip {
  id: string
  storyBlockId: string
  lineageId: string
  sourceSegmentId: string
  sourceArtifactId: string
  sourceHash: string
  sourceRangeMs: readonly [number, number]
  timelineRangeFrames: readonly [number, number]
  referenceMode: 'immutable-source'
  clipHash: string
}

export interface CompiledVariantEditPlan {
  id: string
  schemaVersion: typeof VARIANT_EDIT_PLAN_SCHEMA_VERSION
  compilerVersion: typeof VARIANT_RECIPE_COMPILER_VERSION
  storyPlanId: string
  fps: 30
  durationFrames: number
  outputBinding: 'deferred-to-output-matrix'
  trackIds: readonly string[]
  videoTracks: readonly Readonly<{
    id: string
    kind: 'base-video'
    clips: readonly Readonly<CompiledVariantClip>[]
  }>[]
  masterReferences: readonly Readonly<{
    sourceArtifactId: string
    sourceHashes: readonly string[]
    referenceMode: 'immutable-source'
  }>[]
  materializesSources: false
  duplicatesMasters: false
  editPlanHash: string
}

export interface VariantRecipeSummary {
  selectedTakeCount: number
  sourceSegmentCount: number
  lineageCount: number
  compatibilityEdgeCount: number
  estimatedDurationMs: number
  estimatedDurationFrames: number
  includesProof: boolean
  hasColdOpen: boolean
  masterReferenceCount: number
}

export interface VariantRecipeRun {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  compatibilityGraphId: string
  compatibilityGraphRunHash: string
  takeLibraryId: string
  schemaVersion: typeof VARIANT_RECIPE_SCHEMA_VERSION
  policyVersion: typeof VARIANT_RECIPE_POLICY_VERSION
  scoreVersion: typeof VARIANT_RECIPE_SCORE_VERSION
  compilerVersion: typeof VARIANT_RECIPE_COMPILER_VERSION
  objective: string
  status: VariantRecipeStatus
  selection: Readonly<{
    hookNodeId: string
    bodyNodeId: string
    proofNodeId?: string
    ctaNodeId: string
  }>
  orderedNodeIds: readonly string[]
  compatibilityEdgeIds: readonly string[]
  coldOpen?: Readonly<VariantRecipeColdOpen>
  sourceSegments: readonly Readonly<VariantRecipeSourceSegment>[]
  assumptions: readonly Readonly<VariantRecipeAssumption>[]
  proofPolicy: Readonly<VariantRecipeProofPolicy>
  scores: Readonly<VariantRecipeScores>
  storyPlan: Readonly<CompiledVariantStoryPlan>
  editPlan: Readonly<CompiledVariantEditPlan>
  lineage: readonly Readonly<VariantRecipeLineageEntry>[]
  summary: Readonly<VariantRecipeSummary>
  createdByClientId: string
  createdAt: string
  runHash: string
}

export interface CreateVariantRecipeInput {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  objective: string
  compatibilityGraph: Readonly<CompatibilityGraphRun>
  selection: Readonly<VariantRecipeSelectionInput>
  orderedNodeIds: readonly string[]
  assumptions?: readonly Readonly<VariantRecipeAssumptionInput>[]
  requireProof?: boolean
  coldOpen?: Readonly<VariantRecipeColdOpenInput>
  createdByClientId: string
  createdAt: string
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const REASON = /^[A-Z][A-Z0-9_]{2,79}$/
const OPTIONAL_PROOF_OBJECTIVES = new Set([
  'awareness',
  'content-discovery',
  'content-distribution',
  'download',
  'education',
  'lead-capture',
  'lead-generation',
  'schedule',
  'warming',
  'whatsapp',
])

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function text(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = 1_000,
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

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && Number.isFinite(Date.parse(value)),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return new Date(value).toISOString()
}

function boundedScore(value: number): number {
  return Number(Math.max(0, Math.min(100, value)).toFixed(3))
}

function orderedUnique(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  assertDomain(
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must contain ${minimum} to ${maximum} entries`,
  )
  const normalized = value.map((entry, index) =>
    identity(entry, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicates`,
  )
  return Object.freeze(normalized)
}

function assumption(
  value: Readonly<VariantRecipeAssumptionInput>,
  index: number,
): Readonly<VariantRecipeAssumption> {
  const code = text(value?.code, `assumptions[${index}].code`, 3, 80)
  assertDomain(
    REASON.test(code),
    'INVALID_ARGUMENT',
    `assumptions[${index}].code is invalid`,
  )
  const body = {
    code,
    statement: text(
      value.statement,
      `assumptions[${index}].statement`,
      3,
      1_000,
    ),
    evidenceRefs: Object.freeze(orderedUnique(
      value.evidenceRefs,
      `assumptions[${index}].evidenceRefs`,
      1,
      100,
    ).toSorted()),
  }
  return Object.freeze({
    ...body,
    assumptionHash: calculateCanonicalHash(body),
  })
}

export function resolveVariantRecipeProofPolicy(
  objectiveValue: string,
  requireProof = false,
): Readonly<VariantRecipeProofPolicy> {
  const objective = identity(objectiveValue, 'objective')
  const baseRequirement = OPTIONAL_PROOF_OBJECTIVES.has(
    objective.toLowerCase(),
  )
    ? 'optional'
    : 'required'
  const effectiveRequirement =
    baseRequirement === 'required' || requireProof
      ? 'required'
      : 'optional'
  const body = {
    version: VARIANT_RECIPE_POLICY_VERSION,
    objective,
    baseRequirement,
    effectiveRequirement,
    stricterRequestApplied:
      baseRequirement === 'optional' && requireProof,
    reasonCode: effectiveRequirement === 'required'
      ? baseRequirement === 'required'
        ? 'PROOF_REQUIRED_BY_OBJECTIVE'
        : 'PROOF_REQUIRED_BY_STRICTER_REQUEST'
      : 'PROOF_OPTIONAL_BY_OBJECTIVE',
  } as const
  return Object.freeze({
    ...body,
    policyHash: calculateCanonicalHash(body),
  })
}

function nodeForRole(
  nodes: ReadonlyMap<string, Readonly<CompatibilityNode>>,
  nodeId: unknown,
  expectedRole: CompatibilityRole,
): Readonly<CompatibilityNode> {
  const id = identity(nodeId, `${expectedRole}NodeId`)
  const node = nodes.get(id)
  assertDomain(
    node?.role === expectedRole,
    'PRECONDITION_REQUIRED',
    `Selected ${expectedRole} node was not found in the compatibility graph`,
  )
  assertDomain(
    Boolean(node.scriptBlockId),
    'PRECONDITION_REQUIRED',
    `Selected ${expectedRole} node has no ScriptBlock lineage`,
  )
  return node
}

function acceptedEdge(
  graph: Readonly<CompatibilityGraphRun>,
  from: Readonly<CompatibilityNode>,
  to: Readonly<CompatibilityNode>,
): Readonly<CompatibilityEdge> {
  const edge = graph.edges.find((candidate) =>
    candidate.fromNodeId === from.id &&
    candidate.toNodeId === to.id)
  assertDomain(
    edge?.decision === 'accepted' && edge.eligible,
    'PRECONDITION_REQUIRED',
    `Compatibility edge ${from.role}-${to.role} is not accepted`,
  )
  return edge
}

function segmentBody(value: VariantRecipeSourceSegment) {
  return {
    id: value.id,
    usage: value.usage,
    role: value.role,
    nodeId: value.nodeId,
    takeId: value.takeId,
    takeHash: value.takeHash,
    scriptBlockId: value.scriptBlockId,
    sourceArtifactId: value.sourceArtifactId,
    sourceHash: value.sourceHash,
    sourceRangeMs: value.sourceRangeMs,
    durationMs: value.durationMs,
  }
}

function sourceSegment(
  recipeId: string,
  node: Readonly<CompatibilityNode>,
  usage: VariantRecipeLineageUsage,
  sourceRangeMs = node.sourceRangeMs,
): Readonly<VariantRecipeSourceSegment> {
  const start = sourceRangeMs[0]
  const end = sourceRangeMs[1]
  assertDomain(
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= node.sourceRangeMs[0] &&
    end <= node.sourceRangeMs[1] &&
    start < end,
    'INVALID_ARGUMENT',
    `${usage} source range is outside selected take`,
  )
  const body = {
    id: `recipe-segment-${calculateCanonicalHash({
      recipeId,
      nodeId: node.id,
      usage,
      sourceRangeMs: [start, end],
    }).slice(0, 48)}`,
    usage,
    role: node.role,
    nodeId: node.id,
    takeId: node.takeId,
    takeHash: node.takeHash,
    scriptBlockId: node.scriptBlockId!,
    sourceArtifactId: node.sourceArtifactId,
    sourceHash: node.sourceHash,
    sourceRangeMs: Object.freeze([start, end]) as readonly [number, number],
    durationMs: end - start,
  } as VariantRecipeSourceSegment
  return Object.freeze({
    ...body,
    segmentHash: calculateCanonicalHash(segmentBody(body)),
  })
}

function lineageBody(value: VariantRecipeLineageEntry) {
  return {
    id: value.id,
    sequence: value.sequence,
    usage: value.usage,
    role: value.role,
    nodeId: value.nodeId,
    takeId: value.takeId,
    takeHash: value.takeHash,
    scriptBlockId: value.scriptBlockId,
    groupId: value.groupId,
    sourceSegmentId: value.sourceSegmentId,
    sourceArtifactId: value.sourceArtifactId,
    sourceHash: value.sourceHash,
    sourceRangeMs: value.sourceRangeMs,
  }
}

function lineageEntry(
  recipeId: string,
  sequence: number,
  node: Readonly<CompatibilityNode>,
  segment: Readonly<VariantRecipeSourceSegment>,
): Readonly<VariantRecipeLineageEntry> {
  const body = {
    id: `recipe-lineage-${calculateCanonicalHash({
      recipeId,
      sequence,
      nodeId: node.id,
      segmentId: segment.id,
    }).slice(0, 48)}`,
    sequence,
    usage: segment.usage,
    role: node.role,
    nodeId: node.id,
    takeId: node.takeId,
    takeHash: node.takeHash,
    scriptBlockId: node.scriptBlockId!,
    groupId: node.groupId,
    sourceSegmentId: segment.id,
    sourceArtifactId: node.sourceArtifactId,
    sourceHash: node.sourceHash,
    sourceRangeMs: segment.sourceRangeMs,
  } as VariantRecipeLineageEntry
  return Object.freeze({
    ...body,
    lineageHash: calculateCanonicalHash(lineageBody(body)),
  })
}

function objectiveScore(
  objective: string,
  nodes: readonly Readonly<CompatibilityNode>[],
): number {
  const normalized = objective.toLowerCase()
  const exactTags = nodes.filter((node) =>
    node.narrativeTags.some((tag) =>
      tag.toLowerCase() === normalized)).length
  const tagFit = nodes.length === 0 ? 0 : exactTags / nodes.length
  const cta = nodes.find((node) => node.role === 'cta')
  const actionFit = cta?.desiredAction ? 1 : 0.5
  return boundedScore(65 + tagFit * 25 + actionFit * 10)
}

function scoreDimension(
  dimension: VariantRecipeScoreDimension['dimension'],
  score: number,
  weight: number,
  evidenceRefs: readonly string[],
  reasonCode: string,
): Readonly<VariantRecipeScoreDimension> {
  const body = {
    dimension,
    score: boundedScore(score),
    weight,
    evidenceRefs: Object.freeze([...new Set(evidenceRefs)].toSorted()),
    reasonCode,
  }
  return Object.freeze({
    ...body,
    scoreHash: calculateCanonicalHash(body),
  })
}

function recipeScores(
  objective: string,
  nodes: readonly Readonly<CompatibilityNode>[],
  edges: readonly Readonly<CompatibilityEdge>[],
  lineage?: readonly Readonly<VariantRecipeLineageEntry>[],
): Readonly<VariantRecipeScores> {
  const minimumEdgeScore = boundedScore(
    Math.min(...edges.map((edge) => edge.softScore)),
  )
  const averageEdgeScore = boundedScore(
    edges.reduce((sum, edge) => sum + edge.softScore, 0) /
    edges.length,
  )
  const weightedEdgeScore = boundedScore(
    minimumEdgeScore * 0.7 + averageEdgeScore * 0.3,
  )
  const objectiveFit = objectiveScore(objective, nodes)
  const lineageCompletenessScore = nodes.every((node) =>
    lineage
      ? lineage.some((entry) =>
          entry.usage === 'primary' &&
          entry.nodeId === node.id &&
          entry.takeId === node.takeId &&
          entry.scriptBlockId === node.scriptBlockId)
      : Boolean(node.scriptBlockId))
    ? 100
    : 0
  const dimensions = Object.freeze([
    scoreDimension(
      'minimum-edge',
      minimumEdgeScore,
      0.55,
      edges.map((edge) => edge.edgeHash),
      'WEAKEST_EDGE_PENALTY',
    ),
    scoreDimension(
      'weighted-edge',
      weightedEdgeScore,
      0.2,
      edges.map((edge) => edge.edgeHash),
      'ACCEPTED_PATH_CONTINUITY',
    ),
    scoreDimension(
      'objective-fit',
      objectiveFit,
      0.2,
      nodes.flatMap((node) => [node.contextHash, ...node.evidenceRefs]),
      'OBJECTIVE_CONTEXT_FIT',
    ),
    scoreDimension(
      'lineage-completeness',
      lineageCompletenessScore,
      0.05,
      lineage
        ? lineage.map((entry) => entry.lineageHash)
        : nodes.map((node) => node.nodeHash),
      'LINEAGE_COMPLETE',
    ),
  ])
  const totalScore = boundedScore(dimensions.reduce((sum, dimension) =>
    sum + dimension.score * dimension.weight, 0))
  const body = {
    version: VARIANT_RECIPE_SCORE_VERSION,
    minimumEdgeScore,
    averageEdgeScore,
    weightedEdgeScore,
    objectiveScore: objectiveFit,
    lineageCompletenessScore,
    totalScore,
    dimensions,
  }
  return Object.freeze({
    ...body,
    scoresHash: calculateCanonicalHash(body),
  })
}

export function scoreVariantRecipeCandidate(
  objective: string,
  nodes: readonly Readonly<CompatibilityNode>[],
  edges: readonly Readonly<CompatibilityEdge>[],
): Readonly<VariantRecipeScores> {
  assertDomain(
    nodes.length >= 3 &&
      nodes.length <= 4 &&
      edges.length === nodes.length - 1 &&
      nodes.every((node) => Boolean(node.scriptBlockId)),
    'PRECONDITION_REQUIRED',
    'Variant candidate requires three or four lineaged nodes and a connected path',
  )
  return recipeScores(objective, nodes, edges)
}

function storyBody(value: CompiledVariantStoryPlan) {
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    compilerVersion: value.compilerVersion,
    objective: value.objective,
    targetDurationMs: value.targetDurationMs,
    acts: value.acts,
    blocks: value.blocks,
  }
}

function compileStoryPlan(
  recipeId: string,
  objective: string,
  primary: readonly Readonly<{
    node: CompatibilityNode
    segment: VariantRecipeSourceSegment
  }>[],
  coldOpen?: Readonly<{
    node: CompatibilityNode
    segment: VariantRecipeSourceSegment
  }>,
): Readonly<CompiledVariantStoryPlan> {
  const blocks: StoryBlock[] = []
  if (coldOpen) {
    blocks.push({
      id: `recipe-story-block-cold-${calculateCanonicalHash({
        recipeId,
        segmentId: coldOpen.segment.id,
      }).slice(0, 32)}`,
      actId: 'opening',
      role: 'hook',
      intent: 'cold-open-reference',
      dependencies: [],
      sourceCandidateIds: [coldOpen.node.takeId],
      durationTargetMs: {
        min: coldOpen.segment.durationMs,
        ideal: coldOpen.segment.durationMs,
        max: coldOpen.segment.durationMs,
      },
      content: {
        claimIds: coldOpen.node.claims.map((claim) => claim.key),
        qualifierIds: [],
        proofIds: coldOpen.node.role === 'proof'
          ? [coldOpen.node.takeId]
          : [],
      },
      presentation: 'cold-open-reference',
      sourceRangeId: coldOpen.segment.id,
    })
  }
  for (const { node, segment } of primary) {
    const previous = blocks.at(-1)
    blocks.push({
      id: `recipe-story-block-${calculateCanonicalHash({
        recipeId,
        nodeId: node.id,
      }).slice(0, 40)}`,
      actId: node.role === 'hook'
        ? 'opening'
        : node.role === 'cta'
          ? 'resolution'
          : 'development',
      role: node.role === 'body' ? 'argument' : node.role,
      intent: `use-${node.role}-take`,
      dependencies: previous ? [previous.id] : [],
      sourceCandidateIds: [node.takeId],
      durationTargetMs: {
        min: segment.durationMs,
        ideal: segment.durationMs,
        max: segment.durationMs,
      },
      content: {
        claimIds: node.claims.map((claim) => claim.key),
        qualifierIds: [],
        proofIds: node.role === 'proof' ? [node.takeId] : [],
        ...(node.role === 'cta' ? { ctaId: node.takeId } : {}),
      },
      presentation: 'source-video',
      sourceRangeId: segment.id,
    })
  }
  const acts = ([
    {
      id: 'opening',
      role: 'opening',
      blockIds: blocks.filter((block) =>
        block.actId === 'opening').map((block) => block.id),
    },
    {
      id: 'development',
      role: 'development',
      blockIds: blocks.filter((block) =>
        block.actId === 'development').map((block) => block.id),
    },
    {
      id: 'resolution',
      role: 'resolution',
      blockIds: blocks.filter((block) =>
        block.actId === 'resolution').map((block) => block.id),
    },
  ] as StoryAct[]).filter((act) => act.blockIds.length > 0)
  const estimatedDurationMs = blocks.reduce((sum, block) =>
    sum + block.durationTargetMs.ideal, 0)
  const body = {
    id: `recipe-story-plan-${calculateCanonicalHash({
      recipeId,
      blockIds: blocks.map((block) => block.id),
    }).slice(0, 40)}`,
    schemaVersion: 1 as const,
    compilerVersion: VARIANT_RECIPE_COMPILER_VERSION,
    objective,
    targetDurationMs: {
      min: estimatedDurationMs,
      max: estimatedDurationMs,
    },
    acts: Object.freeze(acts.map((act) =>
      Object.freeze({
        ...act,
        blockIds: Object.freeze([...act.blockIds]),
      }))),
    blocks: Object.freeze(blocks.map((block) =>
      Object.freeze({
        ...block,
        dependencies: Object.freeze([...block.dependencies]),
        sourceCandidateIds: Object.freeze([...block.sourceCandidateIds]),
        durationTargetMs: Object.freeze({
          ...block.durationTargetMs,
        }),
        content: Object.freeze({
          ...block.content,
          claimIds: Object.freeze([...block.content.claimIds]),
          qualifierIds: Object.freeze([
            ...block.content.qualifierIds,
          ]),
          proofIds: Object.freeze([...block.content.proofIds]),
        }),
      }))),
  } as CompiledVariantStoryPlan
  validateStoryPlan(body)
  return Object.freeze({
    ...body,
    storyHash: calculateCanonicalHash(storyBody(body)),
  })
}

function clipBody(value: CompiledVariantClip) {
  return {
    id: value.id,
    storyBlockId: value.storyBlockId,
    lineageId: value.lineageId,
    sourceSegmentId: value.sourceSegmentId,
    sourceArtifactId: value.sourceArtifactId,
    sourceHash: value.sourceHash,
    sourceRangeMs: value.sourceRangeMs,
    timelineRangeFrames: value.timelineRangeFrames,
    referenceMode: value.referenceMode,
  }
}

function editPlanBody(value: CompiledVariantEditPlan) {
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    compilerVersion: value.compilerVersion,
    storyPlanId: value.storyPlanId,
    fps: value.fps,
    durationFrames: value.durationFrames,
    outputBinding: value.outputBinding,
    trackIds: value.trackIds,
    videoTracks: value.videoTracks,
    masterReferences: value.masterReferences,
    materializesSources: value.materializesSources,
    duplicatesMasters: value.duplicatesMasters,
  }
}

function compileEditPlan(
  recipeId: string,
  storyPlan: Readonly<CompiledVariantStoryPlan>,
  lineage: readonly Readonly<VariantRecipeLineageEntry>[],
): Readonly<CompiledVariantEditPlan> {
  let timelineFrame = 0
  const clips = lineage.map((entry) => {
    const durationFrames = Math.max(
      1,
      Math.round(
        (entry.sourceRangeMs[1] - entry.sourceRangeMs[0]) /
        1_000 * 30,
      ),
    )
    const storyBlock = storyPlan.blocks.find((block) =>
      block.sourceRangeId === entry.sourceSegmentId)
    assertDomain(
      Boolean(storyBlock),
      'INVALID_ARGUMENT',
      `Lineage ${entry.id} has no compiled StoryBlock`,
    )
    const body = {
      id: `recipe-clip-${calculateCanonicalHash({
        recipeId,
        lineageId: entry.id,
      }).slice(0, 48)}`,
      storyBlockId: storyBlock!.id,
      lineageId: entry.id,
      sourceSegmentId: entry.sourceSegmentId,
      sourceArtifactId: entry.sourceArtifactId,
      sourceHash: entry.sourceHash,
      sourceRangeMs: entry.sourceRangeMs,
      timelineRangeFrames: Object.freeze([
        timelineFrame,
        timelineFrame + durationFrames,
      ]) as readonly [number, number],
      referenceMode: 'immutable-source' as const,
    } as CompiledVariantClip
    timelineFrame += durationFrames
    return Object.freeze({
      ...body,
      clipHash: calculateCanonicalHash(clipBody(body)),
    })
  })
  const masterReferences = Object.freeze([
    ...new Set(lineage.map((entry) =>
      entry.sourceArtifactId)),
  ].toSorted().map((sourceArtifactId) =>
    Object.freeze({
      sourceArtifactId,
      sourceHashes: Object.freeze([
        ...new Set(lineage
          .filter((entry) =>
            entry.sourceArtifactId === sourceArtifactId)
          .map((entry) => entry.sourceHash)),
      ].toSorted()),
      referenceMode: 'immutable-source' as const,
    })))
  const trackId = `recipe-video-track-${calculateCanonicalHash({
    recipeId,
  }).slice(0, 40)}`
  const body = {
    id: `recipe-edit-plan-${calculateCanonicalHash({
      recipeId,
      storyPlanId: storyPlan.id,
    }).slice(0, 40)}`,
    schemaVersion: VARIANT_EDIT_PLAN_SCHEMA_VERSION,
    compilerVersion: VARIANT_RECIPE_COMPILER_VERSION,
    storyPlanId: storyPlan.id,
    fps: 30 as const,
    durationFrames: timelineFrame,
    outputBinding: 'deferred-to-output-matrix' as const,
    trackIds: Object.freeze([trackId]),
    videoTracks: Object.freeze([
      Object.freeze({
        id: trackId,
        kind: 'base-video' as const,
        clips: Object.freeze(clips),
      }),
    ]),
    masterReferences,
    materializesSources: false as const,
    duplicatesMasters: false as const,
  } as CompiledVariantEditPlan
  return Object.freeze({
    ...body,
    editPlanHash: calculateCanonicalHash(editPlanBody(body)),
  })
}

function summary(
  selectionCount: number,
  segments: readonly VariantRecipeSourceSegment[],
  lineage: readonly VariantRecipeLineageEntry[],
  edgeCount: number,
  editPlan: Readonly<CompiledVariantEditPlan>,
  includesProof: boolean,
  hasColdOpen: boolean,
): Readonly<VariantRecipeSummary> {
  return Object.freeze({
    selectedTakeCount: selectionCount,
    sourceSegmentCount: segments.length,
    lineageCount: lineage.length,
    compatibilityEdgeCount: edgeCount,
    estimatedDurationMs: Math.round(
      editPlan.durationFrames / editPlan.fps * 1_000,
    ),
    estimatedDurationFrames: editPlan.durationFrames,
    includesProof,
    hasColdOpen,
    masterReferenceCount: editPlan.masterReferences.length,
  })
}

function runBody(value: VariantRecipeRun) {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    batchId: value.batchId,
    compatibilityGraphId: value.compatibilityGraphId,
    compatibilityGraphRunHash: value.compatibilityGraphRunHash,
    takeLibraryId: value.takeLibraryId,
    schemaVersion: value.schemaVersion,
    policyVersion: value.policyVersion,
    scoreVersion: value.scoreVersion,
    compilerVersion: value.compilerVersion,
    objective: value.objective,
    status: value.status,
    selection: value.selection,
    orderedNodeIds: value.orderedNodeIds,
    compatibilityEdgeIds: value.compatibilityEdgeIds,
    coldOpen: value.coldOpen,
    sourceSegments: value.sourceSegments,
    assumptions: value.assumptions,
    proofPolicy: value.proofPolicy,
    scores: value.scores,
    storyPlan: value.storyPlan,
    editPlan: value.editPlan,
    lineage: value.lineage,
    summary: value.summary,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  }
}

export function createVariantRecipe(
  input: Readonly<CreateVariantRecipeInput>,
): Readonly<VariantRecipeRun> {
  const recipeId = identity(input.id, 'variantRecipeId')
  const graph = hydrateCompatibilityGraph(input.compatibilityGraph)
  assertDomain(
    graph.workspaceId === input.workspaceId &&
    graph.projectId === input.projectId &&
    graph.batchId === input.batchId,
    'INVALID_ARGUMENT',
    'Compatibility graph does not belong to recipe context',
  )
  const objective = identity(input.objective, 'objective')
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const hook = nodeForRole(nodes, input.selection?.hookNodeId, 'hook')
  const body = nodeForRole(nodes, input.selection?.bodyNodeId, 'body')
  const proof = input.selection?.proofNodeId
    ? nodeForRole(nodes, input.selection.proofNodeId, 'proof')
    : undefined
  const cta = nodeForRole(nodes, input.selection?.ctaNodeId, 'cta')
  const selectedNodes = Object.freeze([
    hook,
    body,
    ...(proof ? [proof] : []),
    cta,
  ])
  const expectedOrder = selectedNodes.map((node) => node.id)
  const orderedNodeIds = orderedUnique(
    input.orderedNodeIds,
    'orderedNodeIds',
    selectedNodes.length,
    selectedNodes.length,
  )
  assertDomain(
    stableSerialize(orderedNodeIds) === stableSerialize(expectedOrder),
    'PRECONDITION_REQUIRED',
    'Recipe order must preserve hook, body, optional proof and CTA; use coldOpen for an opening reference',
  )
  const policy = resolveVariantRecipeProofPolicy(
    objective,
    input.requireProof === true,
  )
  assertDomain(
    proof || policy.effectiveRequirement === 'optional',
    'PRECONDITION_REQUIRED',
    'Recipe requires proof for the current objective and policy',
  )
  const acceptedEdges = Object.freeze([
    acceptedEdge(graph, hook, body),
    ...(proof
      ? [
          acceptedEdge(graph, body, proof),
          acceptedEdge(graph, proof, cta),
        ]
      : [acceptedEdge(graph, body, cta)]),
  ])
  const primarySegments = selectedNodes.map((node) =>
    sourceSegment(recipeId, node, 'primary'))
  let coldOpenNode: Readonly<CompatibilityNode> | undefined
  let coldOpenSegment: Readonly<VariantRecipeSourceSegment> | undefined
  if (input.coldOpen) {
    const coldNodeId = identity(
      input.coldOpen.nodeId,
      'coldOpen.nodeId',
    )
    coldOpenNode = nodes.get(coldNodeId)
    assertDomain(
      Boolean(coldOpenNode) &&
      selectedNodes.some((node) => node.id === coldNodeId),
      'PRECONDITION_REQUIRED',
      'Cold open must reference a selected recipe node',
    )
    assertDomain(
      input.coldOpen.returnAtRole === 'hook',
      'INVALID_ARGUMENT',
      'coldOpen.returnAtRole must be hook in variant-recipe/v1',
    )
    coldOpenSegment = sourceSegment(
      recipeId,
      coldOpenNode!,
      'cold-open',
      input.coldOpen.sourceRangeMs,
    )
    assertDomain(
      coldOpenSegment.durationMs <= 10_000,
      'INVALID_ARGUMENT',
      'Cold open may contain at most 10 seconds',
    )
  }
  const sourceSegments = Object.freeze([
    ...(coldOpenSegment ? [coldOpenSegment] : []),
    ...primarySegments,
  ])
  const coldOpen = coldOpenNode && coldOpenSegment
    ? Object.freeze({
        nodeId: coldOpenNode.id,
        sourceSegmentId: coldOpenSegment.id,
        sourceRangeMs: coldOpenSegment.sourceRangeMs,
        returnAtRole: 'hook' as const,
        coldOpenHash: calculateCanonicalHash({
          nodeId: coldOpenNode.id,
          sourceSegmentId: coldOpenSegment.id,
          sourceRangeMs: coldOpenSegment.sourceRangeMs,
          returnAtRole: 'hook',
        }),
      })
    : undefined
  const lineage: VariantRecipeLineageEntry[] = []
  if (coldOpenNode && coldOpenSegment) {
    lineage.push(lineageEntry(
      recipeId,
      lineage.length,
      coldOpenNode,
      coldOpenSegment,
    ))
  }
  selectedNodes.forEach((node, index) => {
    lineage.push(lineageEntry(
      recipeId,
      lineage.length,
      node,
      primarySegments[index]!,
    ))
  })
  const frozenLineage = Object.freeze(lineage)
  const assumptions = Object.freeze([
    ...(input.assumptions ?? []).map(assumption),
    ...(!proof
      ? [
          assumption({
            code: 'PROOF_OMITTED_BY_POLICY',
            statement:
              `Objective ${objective} permits a short recipe without proof under ${VARIANT_RECIPE_POLICY_VERSION}.`,
            evidenceRefs: [policy.policyHash, graph.runHash],
          }, (input.assumptions ?? []).length),
        ]
      : []),
  ])
  assertDomain(
    assumptions.length <= 25 &&
    new Set(assumptions.map((value) => value.code)).size ===
      assumptions.length,
    'INVALID_ARGUMENT',
    'Recipe assumptions must be unique and contain at most 25 entries',
  )
  const storyPlan = compileStoryPlan(
    recipeId,
    objective,
    selectedNodes.map((node, index) => ({
      node,
      segment: primarySegments[index]!,
    })),
    coldOpenNode && coldOpenSegment
      ? {
          node: coldOpenNode,
          segment: coldOpenSegment,
        }
      : undefined,
  )
  const editPlan = compileEditPlan(
    recipeId,
    storyPlan,
    frozenLineage,
  )
  const scores = recipeScores(
    objective,
    selectedNodes,
    acceptedEdges,
    frozenLineage,
  )
  const recipeSummary = summary(
    selectedNodes.length,
    sourceSegments,
    frozenLineage,
    acceptedEdges.length,
    editPlan,
    Boolean(proof),
    Boolean(coldOpenSegment),
  )
  const selection = Object.freeze({
    hookNodeId: hook.id,
    bodyNodeId: body.id,
    ...(proof ? { proofNodeId: proof.id } : {}),
    ctaNodeId: cta.id,
  })
  const bodyValue = {
    id: recipeId,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    batchId: identity(input.batchId, 'batchId'),
    compatibilityGraphId: graph.id,
    compatibilityGraphRunHash: graph.runHash,
    takeLibraryId: graph.takeLibraryId,
    schemaVersion: VARIANT_RECIPE_SCHEMA_VERSION,
    policyVersion: VARIANT_RECIPE_POLICY_VERSION,
    scoreVersion: VARIANT_RECIPE_SCORE_VERSION,
    compilerVersion: VARIANT_RECIPE_COMPILER_VERSION,
    objective,
    status: 'candidate' as const,
    selection,
    orderedNodeIds,
    compatibilityEdgeIds: Object.freeze(
      acceptedEdges.map((edge) => edge.id),
    ),
    ...(coldOpen ? { coldOpen } : {}),
    sourceSegments,
    assumptions,
    proofPolicy: policy,
    scores,
    storyPlan,
    editPlan,
    lineage: frozenLineage,
    summary: recipeSummary,
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  } as VariantRecipeRun
  return Object.freeze({
    ...bodyValue,
    runHash: calculateCanonicalHash(runBody(bodyValue)),
  })
}

export function hydrateVariantRecipe(
  value: Readonly<VariantRecipeRun>,
): Readonly<VariantRecipeRun> {
  assertDomain(
    value?.schemaVersion === VARIANT_RECIPE_SCHEMA_VERSION &&
    value.policyVersion === VARIANT_RECIPE_POLICY_VERSION &&
    value.scoreVersion === VARIANT_RECIPE_SCORE_VERSION &&
    value.compilerVersion === VARIANT_RECIPE_COMPILER_VERSION &&
    value.status === 'candidate' &&
    HASH.test(value.compatibilityGraphRunHash ?? '') &&
    HASH.test(value.runHash ?? '') &&
    Array.isArray(value.sourceSegments) &&
    value.sourceSegments.length >= 3 &&
    Array.isArray(value.lineage) &&
    value.lineage.length === value.sourceSegments.length &&
    value.editPlan.duplicatesMasters === false &&
    value.editPlan.materializesSources === false &&
    value.summary.hasColdOpen === Boolean(value.coldOpen),
    'INVALID_ARGUMENT',
    'Variant recipe has an invalid envelope',
  )
  const segmentIds = new Set<string>()
  for (const segment of value.sourceSegments) {
    assertDomain(
      !segmentIds.has(segment.id) &&
      COMPATIBILITY_ROLES.includes(segment.role) &&
      HASH.test(segment.takeHash) &&
      HASH.test(segment.sourceHash) &&
      segment.sourceRangeMs[0] < segment.sourceRangeMs[1] &&
      segment.durationMs ===
        segment.sourceRangeMs[1] - segment.sourceRangeMs[0] &&
      segment.segmentHash ===
        calculateCanonicalHash(segmentBody(segment)),
      'INVALID_ARGUMENT',
      `Variant recipe segment ${segment.id} failed integrity validation`,
    )
    segmentIds.add(segment.id)
  }
  if (value.coldOpen) {
    const coldOpenSegment = value.sourceSegments.find((segment) =>
      segment.id === value.coldOpen!.sourceSegmentId)
    assertDomain(
      value.coldOpen.returnAtRole === 'hook' &&
      Boolean(coldOpenSegment) &&
      coldOpenSegment!.usage === 'cold-open' &&
      coldOpenSegment!.nodeId === value.coldOpen.nodeId &&
      stableSerialize(coldOpenSegment!.sourceRangeMs) ===
        stableSerialize(value.coldOpen.sourceRangeMs) &&
      value.coldOpen.coldOpenHash === calculateCanonicalHash({
        nodeId: value.coldOpen.nodeId,
        sourceSegmentId: value.coldOpen.sourceSegmentId,
        sourceRangeMs: value.coldOpen.sourceRangeMs,
        returnAtRole: value.coldOpen.returnAtRole,
      }),
      'INVALID_ARGUMENT',
      'Variant recipe cold open failed integrity validation',
    )
  }
  const lineageIds = new Set<string>()
  for (const entry of value.lineage) {
    assertDomain(
      !lineageIds.has(entry.id) &&
      entry.sequence >= 0 &&
      entry.sequence < value.lineage.length &&
      segmentIds.has(entry.sourceSegmentId) &&
      HASH.test(entry.takeHash) &&
      HASH.test(entry.sourceHash) &&
      entry.lineageHash ===
        calculateCanonicalHash(lineageBody(entry)),
      'INVALID_ARGUMENT',
      `Variant recipe lineage ${entry.id} failed integrity validation`,
    )
    lineageIds.add(entry.id)
  }
  assertDomain(
    value.assumptions.every((item) =>
      item.assumptionHash === calculateCanonicalHash({
        code: item.code,
        statement: item.statement,
        evidenceRefs: item.evidenceRefs,
      })) &&
    value.proofPolicy.policyHash === calculateCanonicalHash({
      version: value.proofPolicy.version,
      objective: value.proofPolicy.objective,
      baseRequirement: value.proofPolicy.baseRequirement,
      effectiveRequirement: value.proofPolicy.effectiveRequirement,
      stricterRequestApplied:
        value.proofPolicy.stricterRequestApplied,
      reasonCode: value.proofPolicy.reasonCode,
    }) &&
    value.scores.dimensions.every((dimension) =>
      dimension.scoreHash === calculateCanonicalHash({
        dimension: dimension.dimension,
        score: dimension.score,
        weight: dimension.weight,
        evidenceRefs: dimension.evidenceRefs,
        reasonCode: dimension.reasonCode,
      })) &&
    value.scores.scoresHash === calculateCanonicalHash({
      version: value.scores.version,
      minimumEdgeScore: value.scores.minimumEdgeScore,
      averageEdgeScore: value.scores.averageEdgeScore,
      weightedEdgeScore: value.scores.weightedEdgeScore,
      objectiveScore: value.scores.objectiveScore,
      lineageCompletenessScore:
        value.scores.lineageCompletenessScore,
      totalScore: value.scores.totalScore,
      dimensions: value.scores.dimensions,
    }) &&
    value.storyPlan.storyHash ===
      calculateCanonicalHash(storyBody(value.storyPlan)) &&
    value.editPlan.videoTracks.every((track) =>
      track.clips.every((clip) =>
        clip.clipHash === calculateCanonicalHash(clipBody(clip)))) &&
    value.editPlan.editPlanHash ===
      calculateCanonicalHash(editPlanBody(value.editPlan)) &&
    value.runHash === calculateCanonicalHash(runBody(value)),
    'INVALID_ARGUMENT',
    'Variant recipe aggregate failed integrity validation',
  )
  validateStoryPlan(value.storyPlan)
  const clips = value.editPlan.videoTracks.flatMap((track) =>
    track.clips)
  assertDomain(
    clips.length === value.lineage.length &&
    clips.every((clip, index) =>
      clip.lineageId === value.lineage[index]!.id &&
      clip.sourceSegmentId === value.lineage[index]!.sourceSegmentId &&
      clip.timelineRangeFrames[0] ===
        (index === 0
          ? 0
          : clips[index - 1]!.timelineRangeFrames[1])) &&
    clips.at(-1)?.timelineRangeFrames[1] ===
      value.editPlan.durationFrames &&
    value.summary.lineageCount === value.lineage.length &&
    value.summary.sourceSegmentCount === value.sourceSegments.length &&
    value.summary.estimatedDurationFrames ===
      value.editPlan.durationFrames &&
    value.summary.masterReferenceCount ===
      value.editPlan.masterReferences.length,
    'INVALID_ARGUMENT',
    'Variant recipe compiled projections are inconsistent',
  )
  return Object.freeze(value)
}
