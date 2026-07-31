import { calculateVersionHash, stableSerialize } from './version-hash.ts'
import type {
  SourceTranscriptReplacementPayload,
  SourceTranscriptReplacementRepository,
  SourceTranscriptReplacementResult,
} from './ports/source-transcript-replacement-repository.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import {
  createSourceTranscriptReplacementImpact,
  materializeSourceTranscriptReplacement,
} from '../domain/source-transcript-replacement.ts'

function identity(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

export function replaceSourceTranscriptService(dependencies: {
  repository: SourceTranscriptReplacementRepository
  clock: () => Date
  createId: (kind: 'edit-command' | 'project-version' | 'project-snapshot') => string
  createEventId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    baseHash: string
    replacementTranscriptId: string
    expectedTranscriptHash: string
    reason?: string
    actor: Readonly<CommandActor>
    idempotencyKey: string
  }): Promise<Readonly<SourceTranscriptReplacementResult>> {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const baseVersionId = identity(request.baseVersionId, 'baseVersionId')
    const replacementTranscriptId = identity(request.replacementTranscriptId, 'replacementTranscriptId')
    const expectedTranscriptHash = request.expectedTranscriptHash.trim()
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_ARGUMENT', 'baseHash must be a SHA-256 digest')
    assertDomain(/^[a-f0-9]{64}$/.test(expectedTranscriptHash), 'INVALID_ARGUMENT', 'expectedTranscriptHash must be a SHA-256 digest')
    assertDomain(idempotencyKey.length >= 8 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const requestFingerprint = calculateVersionHash({
      type: 'replace-source-transcript', workspaceId, projectId, baseVersionId,
      baseHash: request.baseHash, replacementTranscriptId, expectedTranscriptHash,
      reason: request.reason?.trim() || null, actor: request.actor,
    })
    const existing = await dependencies.repository.findIdempotentResult({ workspaceId, projectId, idempotencyKey })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different source transcript replacement')
      return Object.freeze({ ...existing.result, replayed: true })
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId, replacementTranscriptId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project or replacement transcript was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Source transcript replacement base version is stale', {
        currentVersionId: context.currentVersion.id,
        currentBaseHash: context.currentVersion.baseHash,
      })
    }
    assertDomain(
      context.replacementTranscript.transcriptHash === expectedTranscriptHash,
      'VERSION_CONFLICT',
      'Replacement transcript hash changed',
    )
    assertDomain(
      context.currentTranscript.sourceArtifactId === context.replacementTranscript.sourceArtifactId,
      'INVALID_ARGUMENT',
      'Replacement transcript must belong to the same source artifact',
    )
    const createdAt = dependencies.clock().toISOString()
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const snapshotId = dependencies.createId('project-snapshot')
    const editPlan = materializeSourceTranscriptReplacement({
      editPlan: context.editPlan,
      replacement: {
        id: context.replacementTranscript.id,
        sourceArtifactId: context.replacementTranscript.sourceArtifactId,
        transcript: context.replacementTranscript.transcript,
      },
      newVersionId: versionId,
      createdAt,
    })
    const durationFrames = Number(editPlan.durationFrames)
    const impact = createSourceTranscriptReplacementImpact({
      commandId,
      baseVersionId,
      resultVersionId: versionId,
      previousTranscriptId: context.currentTranscript.id,
      previousTranscriptHash: context.currentTranscript.transcriptHash,
      replacementTranscriptId: context.replacementTranscript.id,
      replacementTranscriptHash: context.replacementTranscript.transcriptHash,
      durationFrames,
      outputReferences: context.outputReferences,
    })
    const payload: Readonly<SourceTranscriptReplacementPayload> = Object.freeze({
      schemaVersion: 1,
      action: 'replace-source-transcript',
      previousTranscriptId: context.currentTranscript.id,
      previousTranscriptHash: context.currentTranscript.transcriptHash,
      replacementTranscriptId: context.replacementTranscript.id,
      replacementTranscriptHash: context.replacementTranscript.transcriptHash,
      impact,
      nextRequiredCapability: 'apollo.projects.commands.apply:run-director',
    })
    const command = createEditCommand<SourceTranscriptReplacementPayload>({
      id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      author: request.actor, type: 'replace-source-transcript', scope: { project: true }, payload,
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey, createdAt,
    })
    const editPlanJson = stableSerialize(editPlan)
    const editPlanHash = calculateVersionHash(editPlan)
    const snapshot = createProjectSnapshot({
      id: snapshotId, workspaceId, projectId, kind: 'edit-plan', contentSchemaVersion: 2,
      contentJson: editPlanJson, contentHash: editPlanHash, createdAt,
    })
    const version = createProjectVersion({
      id: versionId, workspaceId, projectId, sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: { ...context.currentVersion.snapshotRefs, editPlan: snapshotId },
      baseHash: calculateVersionHash({
        projectId, sequence: context.currentVersion.sequence + 1,
        parentVersionId: context.currentVersion.id, previousBaseHash: context.currentVersion.baseHash,
        commandId, editPlanHash, replacementTranscriptId, replacementTranscriptHash: expectedTranscriptHash,
      }),
      createdBy: request.actor.id, commandId, createdAt,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(), type: 'project.version.created', version: '1.0.0',
      workspaceId, occurredAt: createdAt, sequence: version.sequence,
      actor: request.actor.type === 'api-client'
        ? { clientId: request.actor.id, ...(request.actor.delegatedUserId ? { userId: request.actor.delegatedUserId } : {}) }
        : { userId: request.actor.id },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId, sequence: version.sequence, parentVersionId: version.parentVersionId,
        baseHash: version.baseHash, commandId, commandType: command.type,
        commandImpactHash: impact.impactHash,
        invalidatedArtifactCount: impact.affectedArtifacts.length,
        nextRequiredCapability: payload.nextRequiredCapability,
        snapshotRefs: version.snapshotRefs, createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      command, requestFingerprint, snapshot, version, event,
      sourceEvidence: {
        currentTranscriptId: context.currentTranscript.id,
        currentTranscriptHash: context.currentTranscript.transcriptHash,
        replacementTranscriptId: context.replacementTranscript.id,
        replacementTranscriptHash: context.replacementTranscript.transcriptHash,
        sourceArtifactId: context.currentTranscript.sourceArtifactId,
      },
    })
  }
}
