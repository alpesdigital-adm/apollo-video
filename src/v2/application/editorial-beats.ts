import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { adjustEditorialBeat, deriveEditorialBeats, type BeatSignal } from '../domain/editorial-beat.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { EditorialBeatAdjustment, EditorialBeatRepository, EditorialBeatSet } from './ports/editorial-beat-repository.ts'

const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

export function deriveEditorialBeatSetService(dependencies: { repository: EditorialBeatRepository; createId: (kind: 'beat-set') => string; clock?: () => Date }) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (input: { workspaceId: string; projectId: string; projectVersionId: string; transcriptId: string; expectedTranscriptHash: string; signals: readonly BeatSignal[]; pauseBoundaryMs?: number; maxDurationMs?: number; actor: ApiAccessAuditContext; idempotencyKey: string }) => {
    assertDomain(IDEMPOTENCY.test(input.idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    assertDomain(input.actor.workspaceId === input.workspaceId, 'AUTH_INVALID', 'Editorial beat actor workspace is invalid')
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'editorial-beat-set-request/v1', projectId: input.projectId, projectVersionId: input.projectVersionId, transcriptId: input.transcriptId, expectedTranscriptHash: input.expectedTranscriptHash, signals: input.signals, pauseBoundaryMs: input.pauseBoundaryMs ?? 450, maxDurationMs: input.maxDurationMs ?? 8_000 })
    const existing = await dependencies.repository.findSetByIdempotency({ workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey, actorClientId: input.actor.clientId, actorContextHash: input.actor.contextHash })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Editorial beat idempotency key was reused with different input')
      return Object.freeze({ set: existing, replayed: true })
    }
    const source = await dependencies.repository.readSource(input)
    if (!source) throw new DomainError('PROJECT_NOT_FOUND', 'Editorial beat source project, version or transcript was not found')
    if (source.transcript.transcriptHash !== input.expectedTranscriptHash) throw new DomainError('INVALID_PROJECT_VERSION', 'Editorial beat transcript changed')
    const derived = deriveEditorialBeats({ transcriptHash: source.transcript.transcriptHash, words: source.transcript.words, signals: input.signals, pauseBoundaryMs: input.pauseBoundaryMs, maxDurationMs: input.maxDurationMs })
    const createdAt = clock().toISOString()
    const body = {
      schemaVersion: 'editorial-beat-set/v1' as const, id: dependencies.createId('beat-set'), workspaceId: input.workspaceId,
      projectId: input.projectId, projectVersionId: input.projectVersionId, transcriptId: input.transcriptId,
      transcriptHash: source.transcript.transcriptHash, derivationVersion: derived.derivationVersion,
      pauseBoundaryMs: input.pauseBoundaryMs ?? 450, maxDurationMs: input.maxDurationMs ?? 8_000,
      words: derived.words, wordsHash: derived.wordsHash, signals: derived.signals, signalsHash: derived.signalsHash,
      beats: derived.beats, beatsHash: derived.beatsHash, idempotencyKey: input.idempotencyKey, requestFingerprint,
      actor: input.actor, createdAt,
    }
    const set: EditorialBeatSet = Object.freeze({ ...body, recordHash: calculateCanonicalHash(body) })
    return dependencies.repository.persistSet(set)
  }
}

export function readEditorialBeatSetService(dependencies: { repository: EditorialBeatRepository }) {
  return async (input: { workspaceId: string; projectId: string; beatSetId: string }) => {
    const set = await dependencies.repository.findSet(input)
    if (!set) throw new DomainError('PROJECT_NOT_FOUND', 'Editorial beat set was not found')
    return set
  }
}

export function adjustEditorialBeatService(dependencies: { repository: EditorialBeatRepository; createId: (kind: 'beat-adjustment') => string; clock?: () => Date }) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (input: { workspaceId: string; projectId: string; beatSetId: string; beatId: string; directorRunId: string; startWordId: string; endWordId: string; reason: string; actor: ApiAccessAuditContext; idempotencyKey: string }) => {
    assertDomain(IDEMPOTENCY.test(input.idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'editorial-beat-adjustment-request/v1', projectId: input.projectId, beatSetId: input.beatSetId, beatId: input.beatId, directorRunId: input.directorRunId, startWordId: input.startWordId, endWordId: input.endWordId, reason: input.reason.trim() })
    const existing = await dependencies.repository.findAdjustmentByIdempotency({ workspaceId: input.workspaceId, beatSetId: input.beatSetId, idempotencyKey: input.idempotencyKey, actorClientId: input.actor.clientId, actorContextHash: input.actor.contextHash })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Editorial beat adjustment idempotency key was reused')
      return Object.freeze({ adjustment: existing, replayed: true })
    }
    const set = await dependencies.repository.findSet(input)
    if (!set) throw new DomainError('PROJECT_NOT_FOUND', 'Editorial beat set was not found')
    const beat = set.beats.find((item) => item.id === input.beatId)
    if (!beat) throw new DomainError('INVALID_ARGUMENT', 'Editorial beat was not found in this set')
    if (!await dependencies.repository.assertDirectorRun({ workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: set.projectVersionId, directorRunId: input.directorRunId })) throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', 'DirectorRun is not valid for this editorial beat adjustment')
    const adjusted = adjustEditorialBeat({ beat, allWords: set.words, startWordId: input.startWordId, endWordId: input.endWordId, directorRunId: input.directorRunId, reason: input.reason })
    assertDomain(adjusted.wordAlignmentHash === set.wordsHash, 'PERSISTENCE_CONFLICT', 'Editorial beat word alignment evidence changed')
    const createdAt = clock().toISOString()
    const body = { schemaVersion: 'editorial-beat-adjustment-record/v1' as const, id: dependencies.createId('beat-adjustment'), workspaceId: input.workspaceId, projectId: input.projectId, beatSetId: input.beatSetId, sourceBeatId: beat.id, directorRunId: input.directorRunId, reason: input.reason.trim(), startWordId: input.startWordId, endWordId: input.endWordId, ...adjusted, idempotencyKey: input.idempotencyKey, requestFingerprint, actor: input.actor, createdAt }
    const adjustment: EditorialBeatAdjustment = Object.freeze({ ...body, recordHash: calculateCanonicalHash(body) })
    return dependencies.repository.persistAdjustment(adjustment)
  }
}
