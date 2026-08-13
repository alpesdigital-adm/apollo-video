import type { DirectorDecisionLog } from '../../domain/director-decision.ts'

export type DirectorDecisionLineageUnavailableReason =
  | 'FINAL_ARTIFACT_NOT_READY'
  | 'RENDER_ELEMENT_MAP_NOT_READY'
  | 'PLAN_NODE_NOT_RENDERED'

export interface DirectorDecisionLineageContext {
  status: 'ready'
  artifactId: string
  projectVersionId: string
  fps: number
  planNodeSourceIds: readonly string[]
  frameMap: readonly Readonly<{ clipId: string; frame: number }>[]
}

export interface DirectorDecisionLogRepository {
  loadLog(input: { workspaceId: string; projectId: string; directorRunId: string }): Promise<Readonly<DirectorDecisionLog> | null>
  loadLineage(input: { workspaceId: string; projectId: string; directorRunId: string; decisionId: string }): Promise<Readonly<DirectorDecisionLineageContext | { status: 'unavailable'; reason: DirectorDecisionLineageUnavailableReason }> | null>
}
