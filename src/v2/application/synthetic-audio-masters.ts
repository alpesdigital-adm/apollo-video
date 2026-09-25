import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createSyntheticAudioMaster, type SyntheticAudioSource, type SyntheticAudioWord } from '../domain/synthetic-audio-master.ts'
import type { SyntheticCriticReport } from '../domain/synthetic-critic-report.ts'
import { isCurrentSyntheticCriticApproval } from './synthetic-critic.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'
import type { ProviderJobRepository } from './ports/provider-job-repository.ts'
import type { SyntheticAudioMasterRepository } from './ports/synthetic-audio-master-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { MasterAlignmentReader } from './synthetic-speech-segments.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const KEY = /^[\x21-\x7E]{8,128}$/

export interface SyntheticAudioDurationReader {
  measure(input: Readonly<{
    operationId: string
    artifactKey: string
    artifactSha256: string
    byteSize: number
  }>): Promise<number>
}

function id(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

export function createSyntheticAudioMasterService(dependencies: {
  repository: SyntheticAudioMasterRepository
  projects: ProjectWorkspaceQueryRepository
  profiles: SyntheticProductionRepository
  providerJobs: ProviderJobRepository
  artifacts: MediaArtifactQueryRepository
  rights: AssetRightsRepository
  criticReports: Readonly<{
    readByHash(input: { workspaceId: string; reportHash: string }): Promise<Readonly<SyntheticCriticReport> | null>
  }>
  alignment?: MasterAlignmentReader
  audioDurations?: SyntheticAudioDurationReader
  clock: () => Date
  createId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    profileSnapshotId: string
    source: SyntheticAudioSource
    audioArtifactId: string
    alignmentEvidenceArtifactId: string
    durationMs: number
    locale: string
    words: readonly Readonly<SyntheticAudioWord>[]
    approvedAt: string
    approvalCriticHash: string
    use: string
    market: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const projectVersionId = id(request.projectVersionId, 'projectVersionId')
    assertDomain(KEY.test(request.idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Synthetic audio actor does not belong to workspace')
    const now = dependencies.clock()
    assertDomain(Number.isFinite(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-synthetic-audio-master-request/v1', workspaceId, projectId, projectVersionId,
      profileSnapshotId: request.profileSnapshotId, source: request.source, audioArtifactId: request.audioArtifactId,
      alignmentEvidenceArtifactId: request.alignmentEvidenceArtifactId, durationMs: request.durationMs,
      locale: request.locale, words: request.words, approvedAt: request.approvedAt,
      approvalCriticHash: request.approvalCriticHash, use: request.use, market: request.market,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.repository.findReplay({ workspaceId, projectId, actorClientId: audit.clientId, actorContextHash: audit.contextHash, idempotencyKey: request.idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with different synthetic audio')
      return Object.freeze({ value: replay, replayed: true })
    }
    const [project, profile, audio, alignmentEvidence] = await Promise.all([
      dependencies.projects.read({ workspaceId, projectId }),
      dependencies.profiles.readProfile({ workspaceId, snapshotId: id(request.profileSnapshotId, 'profileSnapshotId') }),
      dependencies.artifacts.findById(workspaceId, id(request.audioArtifactId, 'audioArtifactId')),
      dependencies.artifacts.findById(workspaceId, id(request.alignmentEvidenceArtifactId, 'alignmentEvidenceArtifactId')),
    ])
    assertDomain(project?.project.currentVersionId === projectVersionId && project.version?.id === projectVersionId, 'VERSION_CONFLICT', 'Synthetic audio must target the current project version')
    if (!profile) throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')
    assertDomain(
      request.profileSnapshotId === profile.profileSnapshotId || request.profileSnapshotId === profile.snapshot.id,
      'VERSION_CONFLICT',
      'Synthetic audio profile reference does not resolve to the persisted profile snapshot',
    )
    assertDomain(audio?.status === 'available' && audio.mediaType === 'audio', 'ASSET_NOT_USABLE', 'Synthetic audio artifact is unavailable')
    assertDomain(alignmentEvidence?.status === 'available' && alignmentEvidence.mediaType === 'data', 'ASSET_NOT_USABLE', 'Word alignment evidence artifact is unavailable')
    // Uploaded audio never involved a TTS effect; TTS and concatenated block
    // audio both require the full audio-first consent scope.
    const requiredOperations = request.source.kind === 'uploaded' ? ['audio-avatar'] as const : ['tts', 'audio-avatar'] as const
    const consent = profile.snapshot.consent
    assertDomain(profile.snapshot.status === 'active' && consent.granted && !consent.revokedAt && Date.parse(consent.expiresAt) > now.getTime() && consent.allowedUses.includes(request.use) && consent.allowedMarkets.includes(request.market) && consent.allowedLocales.includes(request.locale) && requiredOperations.every((operation) => consent.allowedOperations.includes(operation)), 'ASSET_RIGHTS_BLOCKED', 'Synthetic presenter consent does not authorize the audio-first workflow')
    let verifiedWords = request.words
    if (request.source.kind === 'tts') {
      assertDomain(Boolean(dependencies.alignment && dependencies.audioDurations), 'PRECONDITION_REQUIRED', 'TTS evidence readers are not configured')
      const persisted = await dependencies.providerJobs.read({ workspaceId, projectId, jobId: id(request.source.providerJobId, 'providerJobId') })
      const job = persisted?.job
      assertDomain(
        job?.status === 'approved' && job.operation === 'tts' &&
        job.authorization.profileSnapshotId === profile.profileSnapshotId &&
        job.authorization.profileSnapshotHash === profile.snapshot.snapshotHash,
        'PRECONDITION_REQUIRED',
        'TTS provider job is not approved for this profile',
      )
      assertDomain(job.resultArtifact?.artifactId === audio.id && job.resultArtifact.artifactSha256 === audio.sha256 && job.criticResultHash === request.approvalCriticHash, 'PERSISTENCE_CONFLICT', 'TTS result does not match approved audio evidence')
      const verdict = await dependencies.criticReports.readByHash({
        workspaceId,
        reportHash: request.approvalCriticHash,
      })
      assertDomain(
        Boolean(verdict) && isCurrentSyntheticCriticApproval(verdict!) &&
          verdict!.reportHash === request.approvalCriticHash && verdict!.projectId === projectId &&
          verdict!.artifactSha256 === audio.sha256 && verdict!.profileSnapshotId === profile.profileSnapshotId &&
          verdict!.scriptHash === job.input.scriptHash &&
          verdict!.alignmentArtifactId === alignmentEvidence.id,
        'PERSISTENCE_CONFLICT',
        'TTS audio master requires the approved specialized critic report for the exact result',
      )
      const [storedWords, measuredDurationMs] = await Promise.all([
        dependencies.alignment!.readWords({ workspaceId, artifactId: alignmentEvidence.id }),
        dependencies.audioDurations!.measure({
          operationId: `synthetic-audio-master-${requestFingerprint.slice(0, 24)}`,
          artifactKey: audio.artifactKey,
          artifactSha256: audio.sha256,
          byteSize: Number(audio.byteSize),
        }),
      ])
      assertDomain(
        storedWords.length === request.words.length && storedWords.every((word, index) => {
          const supplied = request.words[index]
          return supplied?.word.normalize('NFC').trim() === word.word &&
            supplied.startMs === word.startMs && supplied.endMs === word.endMs
        }),
        'PERSISTENCE_CONFLICT',
        'TTS word alignment does not match the approved persisted alignment artifact',
      )
      // Normalized provider alignment carries exact boundaries but no
      // confidence score. Keep that absence honest instead of persisting a
      // caller-supplied number as though the provider measured it.
      verifiedWords = Object.freeze(storedWords.map((word) => Object.freeze({ ...word, confidence: null })))
      assertDomain(
        request.durationMs === measuredDurationMs,
        'PERSISTENCE_CONFLICT',
        'TTS audio duration does not match the decoded approved audio bytes',
      )
      assertDomain(job.input.text === request.source.text && job.input.locale === request.locale, 'VERSION_CONFLICT', 'TTS source text or locale changed after provider approval')
      assertDomain(Boolean(job.completedAt) && Date.parse(job.completedAt!) <= Date.parse(request.approvedAt), 'VERSION_CONFLICT', 'TTS approval time precedes provider completion')
    }
    const artifactRows = [audio, alignmentEvidence]
    const rights = await dependencies.rights.findCurrentForArtifacts(workspaceId, artifactRows.map(({ id: artifactId }) => artifactId))
    const decisions = artifactRows.map((artifact) => evaluateAssetUse(rights.get(artifact.id) ?? null, { workspaceId, use: request.use, market: request.market, locale: request.locale, syntheticOperations: [...requiredOperations] }, now))
    assertDomain(decisions.every(({ outcome }) => outcome === 'allow'), 'ASSET_RIGHTS_BLOCKED', 'Synthetic audio or alignment evidence is not authorized')
    const master = createSyntheticAudioMaster({
      id: id(dependencies.createId(), 'createId()'), workspaceId, projectId, projectVersionId,
      profileSnapshotId: profile.profileSnapshotId, source: request.source,
      audio: { artifactId: audio.id, artifactSha256: audio.sha256, durationMs: request.durationMs, locale: request.locale },
      alignmentEvidence: { artifactId: alignmentEvidence.id, artifactSha256: alignmentEvidence.sha256 },
      words: verifiedWords, approvedAt: request.approvedAt, approvalCriticHash: request.approvalCriticHash,
      createdAt: now.toISOString(),
    })
    return dependencies.repository.create({ master, profileSnapshotHash: profile.snapshot.snapshotHash, requestFingerprint, idempotencyKey: request.idempotencyKey, authenticationAudit: audit })
  }
}

export function readSyntheticAudioMasterService(dependencies: { repository: SyntheticAudioMasterRepository }) {
  return async function execute(request: { workspaceId: string; projectId: string; audioMasterId: string; actor: Readonly<AuthenticatedExternalActor> }) {
    requireScope(request.actor, 'projects:read')
    const workspaceId = id(request.workspaceId, 'workspaceId')
    assertDomain(request.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Synthetic audio actor does not belong to workspace')
    const value = await dependencies.repository.read({ workspaceId, projectId: id(request.projectId, 'projectId'), audioMasterId: id(request.audioMasterId, 'audioMasterId') })
    if (!value) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic audio master was not found')
    return value
  }
}
