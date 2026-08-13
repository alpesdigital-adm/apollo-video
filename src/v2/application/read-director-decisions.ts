import { requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { DirectorDecisionLogRepository } from './ports/director-decision-log-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { traceDecisionToFrames } from '../domain/director-decision.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function id(value: string, field: string): string { const normalized = value.trim(); if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return normalized }
function authorize(actor: Readonly<AuthenticatedExternalActor>, workspaceId: string) { requireScope(actor, 'projects:read'); if (actor.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Decision log actor does not belong to workspace') }

export function listDirectorDecisionsService(dependencies: { repository: DirectorDecisionLogRepository }) {
  return async (input: { workspaceId: string; projectId: string; directorRunId: string; actor: Readonly<AuthenticatedExternalActor> }) => {
    authorize(input.actor, input.workspaceId)
    const log = await dependencies.repository.loadLog({ workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId'), directorRunId: id(input.directorRunId, 'directorRunId') })
    if (!log) throw new DomainError('PROJECT_NOT_FOUND', 'Director decision log was not found')
    return Object.freeze({ schemaVersion: 'director-decision-list/v1' as const, runId: log.runId, commandId: log.commandId, resultVersionId: log.resultVersionId, logHash: log.logHash, decisions: Object.freeze(log.entries.map((entry) => Object.freeze({ id: entry.id, planNodeIds: entry.planNodeIds, decision: entry.decision, summary: entry.summary, confidence: entry.confidence, score: entry.score, cost: entry.cost, actor: entry.actor, createdAt: entry.createdAt, decisionHash: entry.decisionHash }))) })
  }
}

export function readDirectorDecisionService(dependencies: { repository: DirectorDecisionLogRepository }) {
  return async (input: { workspaceId: string; projectId: string; directorRunId: string; decisionId: string; actor: Readonly<AuthenticatedExternalActor> }) => {
    authorize(input.actor, input.workspaceId)
    const query = { workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId'), directorRunId: id(input.directorRunId, 'directorRunId') }
    const log = await dependencies.repository.loadLog(query)
    if (!log) throw new DomainError('PROJECT_NOT_FOUND', 'Director decision log was not found')
    const decisionId = id(input.decisionId, 'decisionId')
    const decision = log.entries.find((entry) => entry.id === decisionId)
    if (!decision) throw new DomainError('PROJECT_NOT_FOUND', 'Director decision was not found')
    const context = await dependencies.repository.loadLineage({ ...query, decisionId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Director decision lineage context was not found')
    const lineage = context.status === 'ready'
      ? Object.freeze({ status: 'ready' as const, trace: traceDecisionToFrames({ decision, artifactId: context.artifactId, projectVersionId: context.projectVersionId, fps: context.fps, planNodeSourceIds: context.planNodeSourceIds, frameMap: context.frameMap }) })
      : Object.freeze({ status: 'unavailable' as const, reason: context.reason })
    return Object.freeze({ schemaVersion: 'director-decision-detail/v1' as const, logHash: log.logHash, decision, lineage })
  }
}
