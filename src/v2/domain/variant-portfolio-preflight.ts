import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import {
  hydrateCompatibilityGraph,
  type CompatibilityEdge,
  type CompatibilityGraphRun,
  type CompatibilityNode,
  type CompatibilityRole,
} from './compatibility-graph.ts'
import { assertDomain } from './errors.ts'
import {
  resolveVariantRecipeProofPolicy,
  scoreVariantRecipeCandidate,
  type VariantRecipeSelectionInput,
} from './variant-recipe.ts'

export const VARIANT_PORTFOLIO_PREFLIGHT_SCHEMA_VERSION =
  'variant-portfolio-preflight/v1' as const
export const VARIANT_PORTFOLIO_POLICY_SCHEMA_VERSION =
  'variant-portfolio-policy/v1' as const
export const VARIANT_PORTFOLIO_SELECTION_VERSION =
  'variant-portfolio-selection/v1' as const
export const VARIANT_PORTFOLIO_ESTIMATE_VERSION =
  'variant-portfolio-estimate/v1' as const

export type VariantPortfolioPreflightStatus =
  | 'ready'
  | 'confirmation-required'
  | 'no-eligible-recipes'

export interface VariantPortfolioPolicy {
  schemaVersion: typeof VARIANT_PORTFOLIO_POLICY_SCHEMA_VERSION
  workspaceId: string
  revision: number
  defaultRecipeLimit: number
  maxRecipeLimit: number
  maxOutputCount: number
  minCompatibilityEdgeScore: number
  minRecipeScore: number
  minHookCoverage: number
  minBodyCoverage: number
  minCtaCoverage: number
  maxRecipesPerSemanticCluster: number
  maxCandidateScanCount: number
  estimatedCostPerOutputMinorUnits: number
  estimatedDurationSecondsPerOutput: number
  estimatedStorageBytesPerOutput: number
  maxConcurrentJobs: number
  confirmationTtlSeconds: number
  updatedByClientId: string
  updatedAt: string
  policyHash: string
}

export interface ExistingVariantRecipeReference {
  recipeId: string
  orderedNodeIds: readonly string[]
  runHash: string
}

export interface VariantPortfolioCandidate {
  rank: number
  selection: Readonly<VariantRecipeSelectionInput>
  orderedNodeIds: readonly string[]
  compatibilityEdgeIds: readonly string[]
  minimumEdgeScore: number
  averageEdgeScore: number
  totalScore: number
  semanticClusterHash: string
  noveltyScore: number
  reusableRecipeId?: string
  reusableRecipeRunHash?: string
  candidateHash: string
}

export interface VariantPortfolioCoverage {
  required: Readonly<{
    hooks: number
    bodies: number
    ctas: number
  }>
  achieved: Readonly<{
    hooks: number
    bodies: number
    ctas: number
  }>
  complete: boolean
  reasonCodes: readonly string[]
  coverageHash: string
}

export interface VariantPortfolioEstimates {
  version: typeof VARIANT_PORTFOLIO_ESTIMATE_VERSION
  currency: 'USD'
  outputVariantCount: number
  reusedRecipeCount: number
  reusedOutputCount: number
  plannedJobCount: number
  jobsCreated: 0
  estimatedCostMinorUnits: number
  estimatedDurationSeconds: number
  estimatedStorageBytes: number
  expectedReuseRate: number
  estimateHash: string
}

export interface VariantPortfolioPreflightRun {
  schemaVersion: typeof VARIANT_PORTFOLIO_PREFLIGHT_SCHEMA_VERSION
  selectionVersion: typeof VARIANT_PORTFOLIO_SELECTION_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  compatibilityGraphId: string
  compatibilityGraphRunHash: string
  takeLibraryId: string
  objective: string
  policy: Readonly<VariantPortfolioPolicy>
  status: VariantPortfolioPreflightStatus
  requestedRecipeCount: number
  effectiveRecipeLimit: number
  batchVariantCount: number
  budgetRemainingMinorUnits: number
  theoreticalCandidateCount: string
  eligibleCandidateCount: string
  scannedCandidateCount: number
  scanTruncated: boolean
  selectedRecipeCount: number
  productMaterialized: false
  confirmation: Readonly<{
    required: boolean
    satisfied: boolean
    threshold: number
    expiresAt?: string
    confirmationHash: string
  }>
  coverage: Readonly<VariantPortfolioCoverage>
  selected: readonly Readonly<VariantPortfolioCandidate>[]
  exclusions: Readonly<{
    hardFilterCount: string
    belowQualityCount: number
    duplicateCount: number
    semanticClusterCount: number
    budgetCount: number
    capacityCount: number
    reasonCodes: readonly string[]
    exclusionsHash: string
  }>
  estimates: Readonly<VariantPortfolioEstimates>
  warningCodes: readonly string[]
  createdByClientId: string
  createdAt: string
  runHash: string
}

export interface CreateVariantPortfolioPreflightInput {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  objective: string
  compatibilityGraph: Readonly<CompatibilityGraphRun>
  policy: Readonly<VariantPortfolioPolicy>
  requestedRecipeCount: number
  batchVariantCount: number
  budgetRemainingMinorUnits: number
  requireProof?: boolean
  confirmationSatisfied?: boolean
  confirmationExpiresAt?: string
  existingRecipes?: readonly Readonly<ExistingVariantRecipeReference>[]
  createdByClientId: string
  createdAt: string
}

export interface CreateVariantPortfolioPolicyInput {
  workspaceId: string
  revision?: number
  defaultRecipeLimit?: number
  maxRecipeLimit?: number
  maxOutputCount?: number
  minCompatibilityEdgeScore?: number
  minRecipeScore?: number
  minHookCoverage?: number
  minBodyCoverage?: number
  minCtaCoverage?: number
  maxRecipesPerSemanticCluster?: number
  maxCandidateScanCount?: number
  estimatedCostPerOutputMinorUnits?: number
  estimatedDurationSecondsPerOutput?: number
  estimatedStorageBytesPerOutput?: number
  maxConcurrentJobs?: number
  confirmationTtlSeconds?: number
  updatedByClientId: string
  updatedAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const COUNT = /^(0|[1-9][0-9]*)$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function score(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 100`,
  )
  return Number(value.toFixed(3))
}

function policyBody(value: Omit<VariantPortfolioPolicy, 'policyHash'>) {
  return value
}

export function createVariantPortfolioPolicy(
  input: Readonly<CreateVariantPortfolioPolicyInput>,
): Readonly<VariantPortfolioPolicy> {
  const body = Object.freeze({
    schemaVersion: VARIANT_PORTFOLIO_POLICY_SCHEMA_VERSION,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    revision: integer(input.revision ?? 1, 'revision', 1, 1_000_000),
    defaultRecipeLimit: integer(
      input.defaultRecipeLimit ?? 12,
      'defaultRecipeLimit',
      1,
      1_000,
    ),
    maxRecipeLimit: integer(
      input.maxRecipeLimit ?? 50,
      'maxRecipeLimit',
      1,
      1_000,
    ),
    maxOutputCount: integer(
      input.maxOutputCount ?? 250,
      'maxOutputCount',
      1,
      50_000,
    ),
    minCompatibilityEdgeScore: score(
      input.minCompatibilityEdgeScore ?? 70,
      'minCompatibilityEdgeScore',
    ),
    minRecipeScore: score(
      input.minRecipeScore ?? 70,
      'minRecipeScore',
    ),
    minHookCoverage: integer(
      input.minHookCoverage ?? 2,
      'minHookCoverage',
      1,
      100,
    ),
    minBodyCoverage: integer(
      input.minBodyCoverage ?? 2,
      'minBodyCoverage',
      1,
      100,
    ),
    minCtaCoverage: integer(
      input.minCtaCoverage ?? 2,
      'minCtaCoverage',
      1,
      100,
    ),
    maxRecipesPerSemanticCluster: integer(
      input.maxRecipesPerSemanticCluster ?? 2,
      'maxRecipesPerSemanticCluster',
      1,
      100,
    ),
    maxCandidateScanCount: integer(
      input.maxCandidateScanCount ?? 10_000,
      'maxCandidateScanCount',
      100,
      1_000_000,
    ),
    estimatedCostPerOutputMinorUnits: integer(
      input.estimatedCostPerOutputMinorUnits ?? 25,
      'estimatedCostPerOutputMinorUnits',
      1,
      1_000_000,
    ),
    estimatedDurationSecondsPerOutput: integer(
      input.estimatedDurationSecondsPerOutput ?? 45,
      'estimatedDurationSecondsPerOutput',
      1,
      86_400,
    ),
    estimatedStorageBytesPerOutput: integer(
      input.estimatedStorageBytesPerOutput ?? 50_000_000,
      'estimatedStorageBytesPerOutput',
      1,
      Math.floor(Number.MAX_SAFE_INTEGER / 50_000),
    ),
    maxConcurrentJobs: integer(
      input.maxConcurrentJobs ?? 4,
      'maxConcurrentJobs',
      1,
      1_000,
    ),
    confirmationTtlSeconds: integer(
      input.confirmationTtlSeconds ?? 900,
      'confirmationTtlSeconds',
      60,
      86_400,
    ),
    updatedByClientId: identity(
      input.updatedByClientId,
      'updatedByClientId',
    ),
    updatedAt: instant(input.updatedAt, 'updatedAt'),
  })
  assertDomain(
    body.defaultRecipeLimit <= body.maxRecipeLimit,
    'INVALID_ARGUMENT',
    'defaultRecipeLimit cannot exceed maxRecipeLimit',
  )
  return Object.freeze({
    ...body,
    policyHash: calculateCanonicalHash(policyBody(body)),
  })
}

export function hydrateVariantPortfolioPolicy(
  value: Readonly<VariantPortfolioPolicy>,
): Readonly<VariantPortfolioPolicy> {
  const hydrated = createVariantPortfolioPolicy(value)
  assertDomain(
    value.schemaVersion === VARIANT_PORTFOLIO_POLICY_SCHEMA_VERSION &&
      value.policyHash === hydrated.policyHash &&
      stableSerialize(value) === stableSerialize(hydrated),
    'PERSISTENCE_CONFLICT',
    'Stored variant portfolio policy is inconsistent',
  )
  return hydrated
}

function edgeMap(
  graph: Readonly<CompatibilityGraphRun>,
  nodes: ReadonlyMap<string, Readonly<CompatibilityNode>>,
  minimumScore: number,
) {
  const accepted = graph.edges
    .filter((edge) =>
      edge.eligible &&
      edge.decision === 'accepted' &&
      edge.softScore >= minimumScore &&
      Boolean(nodes.get(edge.fromNodeId)?.scriptBlockId) &&
      Boolean(nodes.get(edge.toNodeId)?.scriptBlockId))
    .toSorted((left, right) =>
      right.softScore - left.softScore ||
      left.id.localeCompare(right.id))
  const byFrom = new Map<string, CompatibilityEdge[]>()
  for (const edge of accepted) {
    const list = byFrom.get(edge.fromNodeId) ?? []
    list.push(edge)
    byFrom.set(edge.fromNodeId, list)
  }
  return Object.freeze({ accepted, byFrom })
}

function semanticCluster(
  nodes: readonly Readonly<CompatibilityNode>[],
): string {
  return calculateCanonicalHash({
    version: 'variant-semantic-cluster/v1',
    offerIds: [...new Set(nodes.map((node) => node.offerId))].toSorted(),
    audienceTags: [...new Set(
      nodes.flatMap((node) => node.audienceTags),
    )].toSorted(),
    personaIds: [...new Set(
      nodes.map((node) => node.personaId),
    )].toSorted(),
    locales: [...new Set(nodes.map((node) => node.locale))].toSorted(),
    desiredActions: [...new Set(
      nodes.flatMap((node) =>
        node.desiredAction ? [node.desiredAction] : []),
    )].toSorted(),
    narrativeTags: [...new Set(
      nodes.flatMap((node) => node.narrativeTags),
    )].toSorted(),
  })
}

type CandidateSeed = Omit<
  VariantPortfolioCandidate,
  'rank' | 'noveltyScore'
>

function candidateSeed(
  objective: string,
  nodes: readonly Readonly<CompatibilityNode>[],
  edges: readonly Readonly<CompatibilityEdge>[],
  reusable: ReadonlyMap<string, Readonly<ExistingVariantRecipeReference>>,
): Readonly<CandidateSeed> {
  const orderedNodeIds = Object.freeze(nodes.map((node) => node.id))
  const selection = Object.freeze({
    hookNodeId: nodes[0].id,
    bodyNodeId: nodes[1].id,
    ...(nodes.length === 4 ? { proofNodeId: nodes[2].id } : {}),
    ctaNodeId: nodes[nodes.length - 1].id,
  })
  const scores = scoreVariantRecipeCandidate(objective, nodes, edges)
  const reused = reusable.get(orderedNodeIds.join('\u0000'))
  const body = {
    selection,
    orderedNodeIds,
    compatibilityEdgeIds: Object.freeze(edges.map((edge) => edge.id)),
    minimumEdgeScore: scores.minimumEdgeScore,
    averageEdgeScore: scores.averageEdgeScore,
    totalScore: scores.totalScore,
    semanticClusterHash: semanticCluster(nodes),
    ...(reused
      ? {
          reusableRecipeId: reused.recipeId,
          reusableRecipeRunHash: reused.runHash,
        }
      : {}),
  }
  return Object.freeze({
    ...body,
    candidateHash: calculateCanonicalHash(body),
  })
}

function pushBoundedCandidate(
  pool: CandidateSeed[],
  seen: Set<string>,
  candidate: Readonly<CandidateSeed>,
  maximum: number,
): boolean {
  if (seen.has(candidate.candidateHash)) return false
  seen.add(candidate.candidateHash)
  pool.push(candidate)
  pool.sort((left, right) =>
    right.totalScore - left.totalScore ||
    right.minimumEdgeScore - left.minimumEdgeScore ||
    left.candidateHash.localeCompare(right.candidateHash))
  if (pool.length > maximum) {
    const removed = pool.pop()
    if (removed) seen.delete(removed.candidateHash)
  }
  return true
}

function countPaths(
  proofRequired: boolean,
  hookBodyEdges: readonly Readonly<CompatibilityEdge>[],
  bodyProof: ReadonlyMap<string, readonly Readonly<CompatibilityEdge>[]>,
  bodyCta: ReadonlyMap<string, readonly Readonly<CompatibilityEdge>[]>,
  proofCta: ReadonlyMap<string, readonly Readonly<CompatibilityEdge>[]>,
): bigint {
  let count = BigInt(0)
  for (const hookBody of hookBodyEdges) {
    if (!proofRequired) {
      count += BigInt((bodyCta.get(hookBody.toNodeId) ?? []).length)
    }
    for (
      const bodyProofEdge of
      bodyProof.get(hookBody.toNodeId) ?? []
    ) {
      count += BigInt(
        (proofCta.get(bodyProofEdge.toNodeId) ?? []).length,
      )
    }
  }
  return count
}

function coverageSnapshot(
  selected: readonly Readonly<VariantPortfolioCandidate>[],
  required: Readonly<{ hooks: number; bodies: number; ctas: number }>,
): Readonly<VariantPortfolioCoverage> {
  const achieved = Object.freeze({
    hooks: new Set(selected.map((item) => item.selection.hookNodeId)).size,
    bodies: new Set(selected.map((item) => item.selection.bodyNodeId)).size,
    ctas: new Set(selected.map((item) => item.selection.ctaNodeId)).size,
  })
  const reasonCodes: string[] = []
  if (achieved.hooks < required.hooks) {
    reasonCodes.push('HOOK_COVERAGE_UNAVAILABLE_AT_QUALITY_THRESHOLD')
  }
  if (achieved.bodies < required.bodies) {
    reasonCodes.push('BODY_COVERAGE_UNAVAILABLE_AT_QUALITY_THRESHOLD')
  }
  if (achieved.ctas < required.ctas) {
    reasonCodes.push('CTA_COVERAGE_UNAVAILABLE_AT_QUALITY_THRESHOLD')
  }
  const body = {
    required,
    achieved,
    complete: reasonCodes.length === 0,
    reasonCodes: Object.freeze(reasonCodes),
  }
  return Object.freeze({
    ...body,
    coverageHash: calculateCanonicalHash(body),
  })
}

function selectDiversePortfolio(
  candidates: readonly Readonly<CandidateSeed>[],
  limit: number,
  policy: Readonly<VariantPortfolioPolicy>,
  required: Readonly<{ hooks: number; bodies: number; ctas: number }>,
  budgetMinorUnits: number,
  unitRecipeCost: number,
) {
  const remaining = [...candidates]
  const selected: VariantPortfolioCandidate[] = []
  const usedNodes = new Set<string>()
  const clusterCounts = new Map<string, number>()
  let semanticClusterCount = 0
  let budgetCount = 0
  let reservedCostMinorUnits = 0
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = -1
    let bestValue = Number.NEGATIVE_INFINITY
    let bestNovelty = 0
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]
      const clusterCount =
        clusterCounts.get(candidate.semanticClusterHash) ?? 0
      if (clusterCount >= policy.maxRecipesPerSemanticCluster) continue
      if (
        !candidate.reusableRecipeId &&
        reservedCostMinorUnits + unitRecipeCost > budgetMinorUnits
      ) {
        continue
      }
      const hookCoverage = new Set(
        selected.map((item) => item.selection.hookNodeId),
      )
      const bodyCoverage = new Set(
        selected.map((item) => item.selection.bodyNodeId),
      )
      const ctaCoverage = new Set(
        selected.map((item) => item.selection.ctaNodeId),
      )
      const coverageGain =
        (!hookCoverage.has(candidate.selection.hookNodeId) &&
        hookCoverage.size < required.hooks ? 1 : 0) +
        (!bodyCoverage.has(candidate.selection.bodyNodeId) &&
        bodyCoverage.size < required.bodies ? 1 : 0) +
        (!ctaCoverage.has(candidate.selection.ctaNodeId) &&
        ctaCoverage.size < required.ctas ? 1 : 0)
      const novelNodeCount = candidate.orderedNodeIds.filter(
        (nodeId) => !usedNodes.has(nodeId),
      ).length
      const novelty = Number((
        novelNodeCount / candidate.orderedNodeIds.length
      ).toFixed(3))
      const value =
        candidate.totalScore +
        coverageGain * 20 +
        novelty * 8 -
        clusterCount * 4
      if (
        value > bestValue ||
        (value === bestValue &&
          candidate.candidateHash <
          (remaining[bestIndex]?.candidateHash ?? '\uffff'))
      ) {
        bestIndex = index
        bestValue = value
        bestNovelty = novelty
      }
    }
    if (bestIndex === -1) {
      for (const candidate of remaining) {
        const clusterCount =
          clusterCounts.get(candidate.semanticClusterHash) ?? 0
        if (clusterCount >= policy.maxRecipesPerSemanticCluster) {
          semanticClusterCount += 1
        } else if (
          !candidate.reusableRecipeId &&
          reservedCostMinorUnits + unitRecipeCost >
            budgetMinorUnits
        ) {
          budgetCount += 1
        }
      }
      break
    }
    const [candidate] = remaining.splice(bestIndex, 1)
    const ranked = Object.freeze({
      ...candidate,
      rank: selected.length + 1,
      noveltyScore: bestNovelty,
    })
    selected.push(ranked)
    ranked.orderedNodeIds.forEach((nodeId) => usedNodes.add(nodeId))
    clusterCounts.set(
      ranked.semanticClusterHash,
      (clusterCounts.get(ranked.semanticClusterHash) ?? 0) + 1,
    )
    if (!ranked.reusableRecipeId) {
      reservedCostMinorUnits += unitRecipeCost
    }
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    semanticClusterCount,
    budgetCount,
    reservedCostMinorUnits,
  })
}

function runBody(
  value: Omit<VariantPortfolioPreflightRun, 'runHash'>,
) {
  return value
}

export function createVariantPortfolioPreflight(
  input: Readonly<CreateVariantPortfolioPreflightInput>,
): Readonly<VariantPortfolioPreflightRun> {
  const graph = hydrateCompatibilityGraph(input.compatibilityGraph)
  const policy = hydrateVariantPortfolioPolicy(input.policy)
  const id = identity(input.id, 'id')
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const batchId = identity(input.batchId, 'batchId')
  assertDomain(
    graph.workspaceId === workspaceId &&
      graph.projectId === projectId &&
      graph.batchId === batchId,
    'PRECONDITION_REQUIRED',
    'Compatibility graph does not belong to the requested batch',
  )
  assertDomain(
    policy.workspaceId === workspaceId,
    'PRECONDITION_REQUIRED',
    'Variant portfolio policy does not belong to the workspace',
  )
  const requestedRecipeCount = integer(
    input.requestedRecipeCount,
    'requestedRecipeCount',
    1,
    policy.maxRecipeLimit,
  )
  const batchVariantCount = integer(
    input.batchVariantCount,
    'batchVariantCount',
    1,
    50,
  )
  const budgetRemainingMinorUnits = integer(
    input.budgetRemainingMinorUnits,
    'budgetRemainingMinorUnits',
    0,
    Number.MAX_SAFE_INTEGER,
  )
  const proofPolicy = resolveVariantRecipeProofPolicy(
    input.objective,
    input.requireProof === true,
  )
  const proofRequired =
    proofPolicy.effectiveRequirement === 'required'
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const byRole = new Map<CompatibilityRole, CompatibilityNode[]>([
    ['hook', []],
    ['body', []],
    ['proof', []],
    ['cta', []],
  ])
  graph.nodes.forEach((node) => byRole.get(node.role)?.push(node))
  const hooks = byRole.get('hook') ?? []
  const bodies = byRole.get('body') ?? []
  const proofs = byRole.get('proof') ?? []
  const ctas = byRole.get('cta') ?? []
  const theoretical =
    BigInt(hooks.length) *
    BigInt(bodies.length) *
    BigInt(ctas.length) *
    (proofRequired
      ? BigInt(proofs.length)
      : BigInt(proofs.length + 1))
  const accepted = edgeMap(
    graph,
    nodes,
    policy.minCompatibilityEdgeScore,
  )
  const hookBody = accepted.accepted.filter(
    (edge) => edge.relation === 'hook-body',
  )
  const byRelationFrom = (
    relation: CompatibilityEdge['relation'],
  ) => new Map(
    [...accepted.byFrom.entries()].map(([nodeId, edges]) => [
      nodeId,
      Object.freeze(edges.filter((edge) => edge.relation === relation)),
    ]),
  )
  const bodyProof = byRelationFrom('body-proof')
  const bodyCta = byRelationFrom('body-cta')
  const proofCta = byRelationFrom('proof-cta')
  const eligible = countPaths(
    proofRequired,
    hookBody,
    bodyProof,
    bodyCta,
    proofCta,
  )
  const reusable = new Map(
    (input.existingRecipes ?? []).map((recipe) => [
      recipe.orderedNodeIds.join('\u0000'),
      recipe,
    ]),
  )
  const candidatePool: CandidateSeed[] = []
  const seen = new Set<string>()
  const maximumPoolSize = Math.min(
    policy.maxCandidateScanCount,
    Math.max(policy.maxRecipeLimit * 20, 200),
  )
  let scannedCandidateCount = 0
  let belowQualityCount = 0
  let duplicateCount = 0
  const scan = (
    pathNodes: readonly Readonly<CompatibilityNode>[],
    pathEdges: readonly Readonly<CompatibilityEdge>[],
  ) => {
    if (scannedCandidateCount >= policy.maxCandidateScanCount) return
    scannedCandidateCount += 1
    const candidate = candidateSeed(
      input.objective,
      pathNodes,
      pathEdges,
      reusable,
    )
    if (candidate.totalScore < policy.minRecipeScore) {
      belowQualityCount += 1
      return
    }
    if (!pushBoundedCandidate(
      candidatePool,
      seen,
      candidate,
      maximumPoolSize,
    )) {
      duplicateCount += 1
    }
  }
  outer:
  for (const hookBodyEdge of hookBody) {
    const hook = nodes.get(hookBodyEdge.fromNodeId)
    const body = nodes.get(hookBodyEdge.toNodeId)
    if (!hook || !body) continue
    if (!proofRequired) {
      for (const bodyCtaEdge of bodyCta.get(body.id) ?? []) {
        const cta = nodes.get(bodyCtaEdge.toNodeId)
        if (cta) scan(
          [hook, body, cta],
          [hookBodyEdge, bodyCtaEdge],
        )
        if (scannedCandidateCount >= policy.maxCandidateScanCount) {
          break outer
        }
      }
    }
    for (const bodyProofEdge of bodyProof.get(body.id) ?? []) {
      const proof = nodes.get(bodyProofEdge.toNodeId)
      if (!proof) continue
      for (const proofCtaEdge of proofCta.get(proof.id) ?? []) {
        const cta = nodes.get(proofCtaEdge.toNodeId)
        if (cta) scan(
          [hook, body, proof, cta],
          [hookBodyEdge, bodyProofEdge, proofCtaEdge],
        )
        if (scannedCandidateCount >= policy.maxCandidateScanCount) {
          break outer
        }
      }
    }
  }
  const confirmationRequired =
    requestedRecipeCount > policy.defaultRecipeLimit &&
    input.confirmationSatisfied !== true
  const confirmationSatisfied =
    requestedRecipeCount > policy.defaultRecipeLimit &&
    input.confirmationSatisfied === true
  const confirmationExpiresAt = confirmationRequired
    ? instant(input.confirmationExpiresAt, 'confirmationExpiresAt')
    : undefined
  const requestedLimit = confirmationRequired
    ? policy.defaultRecipeLimit
    : requestedRecipeCount
  const outputCapacity = Math.floor(
    policy.maxOutputCount / batchVariantCount,
  )
  const unitRecipeCost =
    policy.estimatedCostPerOutputMinorUnits * batchVariantCount
  const effectiveRecipeLimit = Math.max(0, Math.min(
    requestedLimit,
    policy.maxRecipeLimit,
    outputCapacity,
  ))
  const required = Object.freeze({
    hooks: Math.min(
      policy.minHookCoverage,
      hooks.length,
      effectiveRecipeLimit,
    ),
    bodies: Math.min(
      policy.minBodyCoverage,
      bodies.length,
      effectiveRecipeLimit,
    ),
    ctas: Math.min(
      policy.minCtaCoverage,
      ctas.length,
      effectiveRecipeLimit,
    ),
  })
  const portfolio = selectDiversePortfolio(
    candidatePool,
    effectiveRecipeLimit,
    policy,
    required,
    budgetRemainingMinorUnits,
    unitRecipeCost,
  )
  const coverage = coverageSnapshot(portfolio.selected, required)
  const selectedRecipeCount = portfolio.selected.length
  const outputVariantCount = selectedRecipeCount * batchVariantCount
  const reusedRecipeCount = portfolio.selected.filter(
    (candidate) => Boolean(candidate.reusableRecipeId),
  ).length
  const reusedOutputCount = reusedRecipeCount * batchVariantCount
  const plannedJobCount = outputVariantCount - reusedOutputCount
  const estimateBody = {
    version: VARIANT_PORTFOLIO_ESTIMATE_VERSION,
    currency: 'USD' as const,
    outputVariantCount,
    reusedRecipeCount,
    reusedOutputCount,
    plannedJobCount,
    jobsCreated: 0 as const,
    estimatedCostMinorUnits:
      plannedJobCount * policy.estimatedCostPerOutputMinorUnits,
    estimatedDurationSeconds: Math.ceil(
      plannedJobCount /
      policy.maxConcurrentJobs,
    ) * policy.estimatedDurationSecondsPerOutput,
    estimatedStorageBytes:
      plannedJobCount * policy.estimatedStorageBytesPerOutput,
    expectedReuseRate: outputVariantCount === 0
      ? 0
      : Number((reusedOutputCount / outputVariantCount).toFixed(6)),
  }
  const estimates = Object.freeze({
    ...estimateBody,
    estimateHash: calculateCanonicalHash(estimateBody),
  })
  const hardFilterCount = theoretical > eligible
    ? (theoretical - eligible).toString()
    : '0'
  const capacityCount = Math.max(
    0,
    candidatePool.length -
      selectedRecipeCount -
      portfolio.semanticClusterCount -
      portfolio.budgetCount,
  )
  const exclusionReasons = [
    ...(hardFilterCount !== '0'
      ? ['HARD_COMPATIBILITY_FILTER']
      : []),
    ...(belowQualityCount > 0
      ? ['BELOW_RECIPE_QUALITY_THRESHOLD']
      : []),
    ...(duplicateCount > 0 ? ['DUPLICATE_PATH'] : []),
    ...(portfolio.semanticClusterCount > 0
      ? ['SEMANTIC_CLUSTER_LIMIT']
      : []),
    ...(portfolio.budgetCount > 0
      ? ['BUDGET_LIMIT_APPLIED']
      : []),
    ...(capacityCount > 0 ? ['PORTFOLIO_CAPACITY_LIMIT'] : []),
  ].toSorted()
  const exclusionBody = {
    hardFilterCount,
    belowQualityCount,
    duplicateCount,
    semanticClusterCount: portfolio.semanticClusterCount,
    budgetCount: portfolio.budgetCount,
    capacityCount,
    reasonCodes: Object.freeze(exclusionReasons),
  }
  const exclusions = Object.freeze({
    ...exclusionBody,
    exclusionsHash: calculateCanonicalHash(exclusionBody),
  })
  const confirmationBody = {
    required: confirmationRequired,
    satisfied: confirmationSatisfied,
    threshold: policy.defaultRecipeLimit,
    ...(confirmationExpiresAt ? { expiresAt: confirmationExpiresAt } : {}),
  }
  const confirmation = Object.freeze({
    ...confirmationBody,
    confirmationHash: calculateCanonicalHash(confirmationBody),
  })
  const scanTruncated =
    eligible > BigInt(scannedCandidateCount)
  const warningCodes = [
    ...(confirmationRequired ? ['EXPANSION_CONFIRMATION_REQUIRED'] : []),
    ...(scanTruncated ? ['CANDIDATE_SCAN_TRUNCATED'] : []),
    ...(!coverage.complete ? ['MINIMUM_COVERAGE_NOT_REACHED'] : []),
    ...(portfolio.budgetCount > 0 ? ['BUDGET_LIMIT_APPLIED'] : []),
    ...(outputCapacity < requestedLimit
      ? ['OUTPUT_LIMIT_APPLIED']
      : []),
    ...(candidatePool.length < effectiveRecipeLimit
      ? ['QUALITY_LIMITED_PORTFOLIO']
      : []),
  ].toSorted()
  const status: VariantPortfolioPreflightStatus =
    eligible === BigInt(0) || selectedRecipeCount === 0
      ? 'no-eligible-recipes'
      : confirmationRequired
        ? 'confirmation-required'
        : 'ready'
  const body = Object.freeze({
    schemaVersion: VARIANT_PORTFOLIO_PREFLIGHT_SCHEMA_VERSION,
    selectionVersion: VARIANT_PORTFOLIO_SELECTION_VERSION,
    id,
    workspaceId,
    projectId,
    batchId,
    compatibilityGraphId: graph.id,
    compatibilityGraphRunHash: graph.runHash,
    takeLibraryId: graph.takeLibraryId,
    objective: identity(input.objective, 'objective'),
    policy,
    status,
    requestedRecipeCount,
    effectiveRecipeLimit,
    batchVariantCount,
    budgetRemainingMinorUnits,
    theoreticalCandidateCount: theoretical.toString(),
    eligibleCandidateCount: eligible.toString(),
    scannedCandidateCount,
    scanTruncated,
    selectedRecipeCount,
    productMaterialized: false as const,
    confirmation,
    coverage,
    selected: portfolio.selected,
    exclusions,
    estimates,
    warningCodes: Object.freeze(warningCodes),
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
  return Object.freeze({
    ...body,
    runHash: calculateCanonicalHash(runBody(body)),
  })
}

export function hydrateVariantPortfolioPreflight(
  value: Readonly<VariantPortfolioPreflightRun>,
): Readonly<VariantPortfolioPreflightRun> {
  const { runHash, ...body } = value
  assertDomain(
    value.schemaVersion === VARIANT_PORTFOLIO_PREFLIGHT_SCHEMA_VERSION &&
      value.selectionVersion === VARIANT_PORTFOLIO_SELECTION_VERSION &&
      value.productMaterialized === false &&
      value.estimates.jobsCreated === 0 &&
      COUNT.test(value.theoreticalCandidateCount) &&
      COUNT.test(value.eligibleCandidateCount) &&
      HASH.test(value.runHash) &&
      value.selected.length === value.selectedRecipeCount &&
      calculateCanonicalHash(runBody(body)) === runHash,
    'PERSISTENCE_CONFLICT',
    'Stored variant portfolio preflight is inconsistent',
  )
  hydrateVariantPortfolioPolicy(value.policy)
  return Object.freeze(value)
}
