import {
  DIRECTOR_TOOL_DESCRIPTORS,
  type DirectorToolContext,
} from '../domain/director-tools.ts'
import {
  runDirectorToolCalls,
  type DirectorApplicationServices,
} from '../application/execute-director-tools.ts'

export interface DirectorToolModel {
  generateToolCalls(input: Readonly<{
    tools: typeof DIRECTOR_TOOL_DESCRIPTORS
    scope: Readonly<{ workspaceId: string; projectId: string }>
    baseVersionId: string
    budgetRemaining: number
  }>): Promise<unknown>
}

export async function runDirectorToolModel(input: {
  model: DirectorToolModel
  context: DirectorToolContext
  services: DirectorApplicationServices
}) {
  const calls = await input.model.generateToolCalls(Object.freeze({
    tools: DIRECTOR_TOOL_DESCRIPTORS,
    scope: Object.freeze({
      workspaceId: input.context.workspaceId,
      projectId: input.context.projectId,
    }),
    baseVersionId: input.context.baseVersionId,
    budgetRemaining: input.context.budgetRemaining,
  }))
  return runDirectorToolCalls(calls, input.context, input.services)
}

export {
  DIRECTOR_TOOL_DESCRIPTORS,
  DIRECTOR_TOOL_NAMES,
} from '../domain/director-tools.ts'
