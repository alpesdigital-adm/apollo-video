import {
  createDirectorToolCatalog,
  parseDirectorToolCalls,
  preflightDirectorToolCalls,
  type DirectorToolArguments,
  type DirectorToolCall,
  type DirectorToolContext,
  type DirectorToolName,
} from '../domain/director-tools.ts'
import { evaluateAssetUse, type AssetRightsSnapshot } from '../domain/asset-rights.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import { validateStoryPlan } from '../domain/story-plan.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'
import { selectMontageCandidate } from './select-montage-candidate.ts'

export const DIRECTOR_TOOL_SERVER_BUDGET = 5

export function discoverDirectorToolsService() {
  return createDirectorToolCatalog()
}

export interface DirectorToolInvocation<Name extends DirectorToolName = DirectorToolName> {
  callId: string
  scope: Readonly<{ workspaceId: string; projectId: string }>
  baseVersionId: string
  arguments: Readonly<DirectorToolArguments[Name]>
}

export interface DirectorApplicationServices {
  searchMedia(input: DirectorToolInvocation<'search-media'>): Promise<unknown>
  createStoryPlan(input: DirectorToolInvocation<'create-story-plan'>): Promise<unknown>
  proposeAsset(input: DirectorToolInvocation<'propose-asset'>): Promise<unknown>
  evaluateCandidate(input: DirectorToolInvocation<'evaluate-candidate'>): Promise<unknown>
  proposePatch(input: DirectorToolInvocation<'propose-patch'>): Promise<unknown>
}

function invocation(call: Readonly<DirectorToolCall>): DirectorToolInvocation {
  return Object.freeze({ callId: call.id, scope: call.scope, baseVersionId: call.baseVersionId, arguments: call.arguments })
}

export async function runDirectorToolCalls(callsValue: unknown, context: DirectorToolContext, services: DirectorApplicationServices) {
  const preflight = preflightDirectorToolCalls(callsValue, context)
  const results = []
  for (const call of preflight.calls) {
    const handlers: Record<DirectorToolName, (input: DirectorToolInvocation) => Promise<unknown>> = {
      'search-media': services.searchMedia as (input: DirectorToolInvocation) => Promise<unknown>,
      'create-story-plan': services.createStoryPlan as (input: DirectorToolInvocation) => Promise<unknown>,
      'propose-asset': services.proposeAsset as (input: DirectorToolInvocation) => Promise<unknown>,
      'evaluate-candidate': services.evaluateCandidate as (input: DirectorToolInvocation) => Promise<unknown>,
      'propose-patch': services.proposePatch as (input: DirectorToolInvocation) => Promise<unknown>,
    }
    const result = await handlers[call.name](invocation(call))
    assertDomain(result !== undefined, 'INVALID_ARGUMENT', 'Director application service returned no result', { tool: call.name })
    results.push(Object.freeze({ callId: call.id, tool: call.name, status: 'accepted' as const, chargedCost: call.estimatedCost, result }))
  }
  return Object.freeze({ results: Object.freeze(results), budgetRemaining: preflight.budgetRemaining })
}

export interface DirectorToolExecutionRequest {
  projectId: string
  calls: unknown
}

export interface DirectorToolContextResolver {
  resolve(input: Readonly<{
    workspaceId: string
    projectId: string
    requestedAssetIds: readonly string[]
  }>): Promise<Readonly<DirectorToolContext>>
}

export function createDirectorToolContextResolver(dependencies: {
  directorRuns: Pick<DirectorRunRepository, 'readContext'>
  rights: Pick<AssetRightsRepository, 'findCurrentForArtifacts'>
  clock: () => Date
  budgetLimit?: number
}): DirectorToolContextResolver {
  const budgetLimit = dependencies.budgetLimit ?? DIRECTOR_TOOL_SERVER_BUDGET
  assertDomain(Number.isFinite(budgetLimit) && budgetLimit >= 0, 'INVALID_ARGUMENT', 'Director tool server budget must be finite and non-negative')
  const resolver: DirectorToolContextResolver = {
    async resolve(input) {
      const context = await dependencies.directorRuns.readContext({ workspaceId: input.workspaceId, projectId: input.projectId })
      if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Director tool project was not found')
      const requested = Object.freeze([...new Set(input.requestedAssetIds)].sort())
      const snapshots: ReadonlyMap<string, AssetRightsSnapshot | null> = requested.length === 0
        ? new Map<string, AssetRightsSnapshot | null>()
        : await dependencies.rights.findCurrentForArtifacts(input.workspaceId, requested)
      const eligible = new Map<string, string>()
      for (const assetId of requested) {
        const decision = evaluateAssetUse(snapshots.get(assetId) ?? null, {
          workspaceId: input.workspaceId,
          use: 'editorial-reuse',
          locale: context.project.locale,
        }, dependencies.clock())
        if (decision.outcome === 'allow' && decision.rightsSnapshotHash) eligible.set(assetId, decision.rightsSnapshotHash)
      }
      return Object.freeze({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        baseVersionId: context.currentVersion.id,
        budgetRemaining: budgetLimit,
        eligibleAssetRights: eligible,
      })
    },
  }
  return Object.freeze(resolver)
}

export function executeDirectorToolsService(dependencies: {
  contexts: DirectorToolContextResolver
  services: DirectorApplicationServices
}) {
  return async function execute(input: Readonly<{
    workspaceId: string
    projectId: string
    calls: unknown
  }>) {
    const parsed = parseDirectorToolCalls(input.calls)
    const requestedAssetIds = Object.freeze([
      ...new Set(parsed.flatMap((call) => call.rights.map((right) => right.assetId))),
    ].sort())
    const context = await dependencies.contexts.resolve({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      requestedAssetIds,
    })
    return runDirectorToolCalls(parsed, context, dependencies.services)
  }
}

export function createLocalDirectorProposalServices(dependencies: {
  searchMedia(input: Readonly<{ workspaceId: string; projectId: string; query: string; limit: number }>): Promise<unknown>
}): DirectorApplicationServices {
  const services: DirectorApplicationServices = {
    async searchMedia(input) {
      const result = await dependencies.searchMedia({
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        query: input.arguments.query,
        limit: input.arguments.limit ?? 20,
      })
      return Object.freeze({ kind: 'search-results', value: result })
    },
    async createStoryPlan(input) {
      const validation = validateStoryPlan(input.arguments.plan)
      return Object.freeze({
        kind: 'story-plan-proposal',
        proposalHash: calculateCanonicalHash({
          schemaVersion: 'director-story-plan-proposal/v1',
          baseVersionId: input.baseVersionId,
          plan: input.arguments.plan,
          assetIds: input.arguments.assetIds,
        }),
        plan: validation.plan,
        estimatedDurationMs: validation.estimatedDurationMs,
      })
    },
    async proposeAsset(input) {
      return Object.freeze({
        kind: 'asset-proposal',
        proposalHash: calculateCanonicalHash({
          schemaVersion: 'director-asset-proposal/v1',
          baseVersionId: input.baseVersionId,
          ...input.arguments,
        }),
        ...input.arguments,
      })
    },
    async evaluateCandidate(input) {
      return Object.freeze({
        kind: 'candidate-evaluation',
        evaluation: selectMontageCandidate({
          seeds: input.arguments.candidates,
          rubric: input.arguments.rubric,
          minimumConfidence: input.arguments.minimumConfidence,
        }),
      })
    },
    async proposePatch(input) {
      return Object.freeze({
        kind: 'patch-proposal',
        proposalHash: calculateCanonicalHash({
          schemaVersion: 'director-patch-proposal/v1',
          baseVersionId: input.baseVersionId,
          operations: input.arguments.operations,
          assetIds: input.arguments.assetIds,
          rationale: input.arguments.rationale,
        }),
        operations: input.arguments.operations,
        assetIds: input.arguments.assetIds,
        rationale: input.arguments.rationale,
      })
    },
  }
  return Object.freeze(services)
}
