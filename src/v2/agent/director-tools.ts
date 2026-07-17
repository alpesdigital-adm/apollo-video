import { DomainError } from '../domain/errors.ts'

export type DirectorToolName = 'search-media' | 'create-story-plan' | 'propose-asset' | 'evaluate-candidate' | 'propose-patch'
export interface DirectorToolCall { id: string; name: DirectorToolName; arguments: Readonly<Record<string, unknown>>; scope: { workspaceId: string; projectId: string }; baseVersion: number; estimatedCost: number }
export interface DirectorToolContext { workspaceId: string; projectId: string; baseVersion: number; budgetRemaining: number; eligibleAssetIds: readonly string[] }
export interface DirectorApplicationServices {
  searchMedia(argumentsValue: Readonly<Record<string, unknown>>): Promise<unknown>
  createStoryPlan(argumentsValue: Readonly<Record<string, unknown>>): Promise<unknown>
  proposeAsset(argumentsValue: Readonly<Record<string, unknown>>): Promise<unknown>
  evaluateCandidate(argumentsValue: Readonly<Record<string, unknown>>): Promise<unknown>
  proposePatch(argumentsValue: Readonly<Record<string, unknown>>): Promise<unknown>
}

export const DIRECTOR_TOOL_DESCRIPTORS = Object.freeze([
  { name: 'search-media', description: 'Search eligible workspace media without mutating it.', required: ['query'] },
  { name: 'create-story-plan', description: 'Create a versioned narrative plan proposal.', required: ['blocks'] },
  { name: 'propose-asset', description: 'Propose one rights-eligible asset for a plan node.', required: ['assetId', 'planNodeId'] },
  { name: 'evaluate-candidate', description: 'Evaluate one montage candidate against the active rubric.', required: ['candidateId'] },
  { name: 'propose-patch', description: 'Propose typed patch operations; never mutates persistence directly.', required: ['operations'] },
] as const)

export async function executeDirectorTool(call: DirectorToolCall, context: DirectorToolContext, services: DirectorApplicationServices) {
  const descriptor = DIRECTOR_TOOL_DESCRIPTORS.find((item) => item.name === call.name)
  if (!descriptor) throw new DomainError('INVALID_ARGUMENT', 'Unknown Director tool')
  if (call.scope.workspaceId !== context.workspaceId || call.scope.projectId !== context.projectId) throw new DomainError('INVALID_SCOPE', 'Director tool scope mismatch')
  if (call.baseVersion !== context.baseVersion) throw new DomainError('VERSION_CONFLICT', 'Director tool base version is stale')
  if (!Number.isFinite(call.estimatedCost) || call.estimatedCost < 0 || call.estimatedCost > context.budgetRemaining) throw new DomainError('INVALID_ARGUMENT', 'Director tool exceeds remaining budget')
  for (const field of descriptor.required) if (!(field in call.arguments)) throw new DomainError('INVALID_ARGUMENT', `Director tool is missing ${field}`)
  if (call.name === 'propose-asset' && !context.eligibleAssetIds.includes(String(call.arguments.assetId))) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Proposed asset is not rights-eligible')
  const handlers: Record<DirectorToolName, (value: Readonly<Record<string, unknown>>) => Promise<unknown>> = { 'search-media': services.searchMedia, 'create-story-plan': services.createStoryPlan, 'propose-asset': services.proposeAsset, 'evaluate-candidate': services.evaluateCandidate, 'propose-patch': services.proposePatch }
  const result = await handlers[call.name](call.arguments)
  return Object.freeze({ callId: call.id, tool: call.name, status: 'accepted' as const, chargedCost: call.estimatedCost, result })
}

export async function runDirectorToolCalls(calls: readonly DirectorToolCall[], context: DirectorToolContext, services: DirectorApplicationServices) {
  const results = []; let remaining = context.budgetRemaining
  for (const call of calls) { const result = await executeDirectorTool(call, { ...context, budgetRemaining: remaining }, services); remaining -= result.chargedCost; results.push(result) }
  return Object.freeze({ results: Object.freeze(results), budgetRemaining: remaining })
}
