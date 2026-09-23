import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'
import { createHash } from 'node:crypto'

import type { MediaArtifactQueryRepository } from '../../application/ports/media-artifact-query-repository.ts'
import type { AssetRightsRepository } from '../../application/ports/asset-rights-repository.ts'
import type { ProviderResultArtifactRepository } from '../../application/ports/provider-result-artifact-repository.ts'
import type { SyntheticBlockGenerationRepository } from '../../application/ports/synthetic-block-generation-repository.ts'
import type { SyntheticProductionRepository } from '../../application/ports/synthetic-production-repository.ts'
import type { SyntheticScriptPlanRepository } from '../../application/ports/synthetic-script-plan-repository.ts'
import type { SyntheticAudioMasterRepository } from '../../application/ports/synthetic-audio-master-repository.ts'
import type { MasterAlignmentReader } from '../../application/synthetic-speech-segments.ts'
import type { ArtifactSourceMaterializer } from '../../application/ports/media-ingest.ts'
import type { TransformationAudioPreservationEvaluator } from '../../application/ports/transformation-critic-evaluator.ts'
import type { SyntheticCriticRuntimeContextResolver } from '../../application/synthetic-provider-critic.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { createAvatarOutputSpeechEvidence } from '../../domain/avatar-output-speech-evidence.ts'
import { createSyntheticAvatarAudioRange } from '../../domain/synthetic-audio-master.ts'
import { parseControlledOutputSpeechSidecar } from '../provider-result-ingestion.ts'
import { readFile } from 'node:fs/promises'

type AvatarBinding = Readonly<{
  blockId: string
  scriptText: string
  scriptHash: string
  profileSnapshotId: string
  expectedDurationMs: number
  alignmentArtifactId: string | null
  use: string
  market: string
  locale: string
}>

type TtsBinding = Readonly<Pick<AvatarBinding, 'blockId' | 'scriptText' | 'scriptHash' | 'profileSnapshotId' | 'use' | 'market' | 'locale'> & { planId: string }>

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function avatarBinding(value: unknown): AvatarBinding {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'PRECONDITION_REQUIRED', 'Audio-avatar job has no durable synthetic critic binding')
  const record = value as Record<string, unknown>
  assertDomain(
    Object.keys(record).toSorted().join(',') === 'alignmentArtifactId,blockId,expectedDurationMs,locale,market,profileSnapshotId,scriptHash,scriptText,use' &&
      typeof record.blockId === 'string' && typeof record.scriptText === 'string' &&
      typeof record.scriptHash === 'string' && /^[a-f0-9]{64}$/.test(record.scriptHash) &&
      sha256(record.scriptText) === record.scriptHash &&
      typeof record.profileSnapshotId === 'string' &&
      Number.isSafeInteger(record.expectedDurationMs) && Number(record.expectedDurationMs) > 0 &&
      (record.alignmentArtifactId === null || typeof record.alignmentArtifactId === 'string') &&
      typeof record.use === 'string' && typeof record.market === 'string' && typeof record.locale === 'string',
    'PERSISTENCE_CONFLICT',
    'Audio-avatar synthetic critic binding is invalid',
  )
  return Object.freeze(record as AvatarBinding)
}

function ttsBinding(value: unknown): TtsBinding {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'PRECONDITION_REQUIRED', 'TTS job has no durable synthetic critic binding')
  const record = value as Record<string, unknown>
  assertDomain(
    Object.keys(record).toSorted().join(',') === 'blockId,locale,market,planId,profileSnapshotId,scriptHash,scriptText,use' &&
      typeof record.planId === 'string' &&
      typeof record.blockId === 'string' && typeof record.scriptText === 'string' &&
      typeof record.scriptHash === 'string' && /^[a-f0-9]{64}$/.test(record.scriptHash) &&
      sha256(record.scriptText) === record.scriptHash && typeof record.profileSnapshotId === 'string' &&
      typeof record.use === 'string' && typeof record.market === 'string' && typeof record.locale === 'string',
    'PERSISTENCE_CONFLICT',
    'TTS synthetic critic binding is invalid',
  )
  return Object.freeze(record as TtsBinding)
}

/** Reads every grading input back from V2 persistence. Caller payload never
 * supplies a verdict, evaluator result, identity match or approval flag. */
export class PrismaSyntheticCriticRuntimeContextResolver implements SyntheticCriticRuntimeContextResolver {
  private readonly dependencies: {
    client: PrismaClient
    artifacts: MediaArtifactQueryRepository
    resultArtifacts: ProviderResultArtifactRepository
    generations: SyntheticBlockGenerationRepository
    plans: SyntheticScriptPlanRepository
    profiles: SyntheticProductionRepository
    rights: AssetRightsRepository
    alignment: MasterAlignmentReader
    audioMasters: SyntheticAudioMasterRepository
    sources: ArtifactSourceMaterializer
    audioComparison: TransformationAudioPreservationEvaluator
    clock: () => Date
  }

  constructor(dependencies: PrismaSyntheticCriticRuntimeContextResolver['dependencies']) {
    this.dependencies = dependencies
  }

  async resolve(input: Parameters<SyntheticCriticRuntimeContextResolver['resolve']>[0]) {
    const { job, artifact } = input
    const target = await this.dependencies.artifacts.findById(job.workspaceId, artifact.artifactId)
    assertDomain(
      target?.status === 'available' && target.sha256 === artifact.artifactSha256 &&
        Number(target.byteSize) === artifact.byteSize,
      'PERSISTENCE_CONFLICT',
      'Synthetic critic target artifact diverged from the ingested provider result',
    )
    const profile = await this.dependencies.profiles.readProfile({
      workspaceId: job.workspaceId,
      snapshotId: job.authorization.profileSnapshotId,
    })
    assertDomain(
      Boolean(profile) && profile!.profileSnapshotId === job.authorization.profileSnapshotId &&
        profile!.snapshot.snapshotHash === job.authorization.profileSnapshotHash,
      'PERSISTENCE_CONFLICT',
      'Synthetic critic presenter profile diverged from the authorized snapshot',
    )
    const now = this.dependencies.clock()
    const [head, currentRights] = await Promise.all([
      this.dependencies.profiles.readProfileHead({ workspaceId: job.workspaceId, profileId: profile!.snapshot.id }),
      this.dependencies.rights.findCurrentForArtifacts(
        job.workspaceId,
        job.authorization.artifactDecisions.map(({ artifactId }) => artifactId),
      ),
    ])
    const current = head?.current.snapshot
    assertDomain(job.operation === 'tts' || job.operation === 'audio-avatar', 'PRECONDITION_REQUIRED', 'Specialized synthetic critic supports only TTS and audio-avatar jobs')
    const bindingScope = job.operation === 'tts' ? ttsBinding(job.input.criticBinding) : avatarBinding(job.input.criticBinding)
    const profileStillAuthorized = Boolean(current) && current!.status === 'active' &&
      current!.consent.granted && !current!.consent.revokedAt &&
      Date.parse(current!.consent.expiresAt) > now.getTime() &&
      current!.consent.allowedOperations.includes(job.operation) &&
      current!.consent.allowedUses.includes(bindingScope.use) &&
      current!.consent.allowedMarkets.includes(bindingScope.market) &&
      current!.consent.allowedLocales.includes(bindingScope.locale)
    const artifactsStillAuthorized = job.authorization.artifactDecisions.every((decision) => {
      const rights = currentRights.get(decision.artifactId)
      return rights?.id === decision.rightsSnapshotId && rights.snapshotHash === decision.rightsSnapshotHash &&
        rights.status === 'approved' && (!rights.expiresAt || Date.parse(rights.expiresAt) > now.getTime())
    })
    const rightsValid = profileStillAuthorized && artifactsStillAuthorized && Date.parse(job.authorization.expiresAt) > now.getTime()

    if (job.operation === 'tts') {
      const binding = ttsBinding(job.input.criticBinding)
      const [generation, plan] = await Promise.all([
        this.dependencies.generations.findByProviderJob({
          workspaceId: job.workspaceId, projectId: job.projectId, providerJobId: job.id,
        }),
        this.dependencies.plans.readPlan({
          workspaceId: job.workspaceId, projectId: job.projectId, planId: binding.planId,
        }),
      ])
      const block = plan?.blocks.find(({ id }) => id === binding.blockId)
      assertDomain(
        Boolean(plan && block) && plan!.version.profileSnapshotId === binding.profileSnapshotId &&
          plan!.version.blockSequence.includes(binding.blockId) && binding.scriptText === block!.exactText &&
          binding.scriptHash === sha256(block!.exactText) &&
          binding.profileSnapshotId === job.authorization.profileSnapshotId &&
          job.input.text === block!.exactText && job.input.scriptHash === binding.scriptHash &&
          (!generation || (
            generation.planId === binding.planId && generation.blockId === binding.blockId &&
            generation.scriptHash === binding.scriptHash && generation.profileSnapshotId === binding.profileSnapshotId
          )),
        'PERSISTENCE_CONFLICT',
        'TTS script plan context diverged from the authorized job',
      )
      const ledger = await this.dependencies.resultArtifacts.listByJob({ workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id })
      const audio = ledger.find((entry) => entry.role === 'primary-audio')
      const alignment = ledger.find((entry) => entry.role === 'alignment-evidence')
      assertDomain(
        audio?.artifactId === artifact.artifactId && audio.artifactSha256 === artifact.artifactSha256 &&
          audio.byteSize === artifact.byteSize && audio.mediaType === 'audio' &&
          audio.providerJobRef === job.providerJobId && audio.adapterId === job.adapterId &&
          audio.adapterVersion === job.adapterVersion && audio.inputHash === job.inputHash &&
          audio.authorizationHash === job.authorization.authorizationHash && audio.scriptHash === binding.scriptHash &&
          alignment?.mediaType === 'data' && alignment.providerJobRef === job.providerJobId &&
          alignment.adapterId === job.adapterId && alignment.adapterVersion === job.adapterVersion &&
          alignment.inputHash === job.inputHash && alignment.authorizationHash === job.authorization.authorizationHash &&
          alignment.scriptHash === binding.scriptHash,
        'PERSISTENCE_CONFLICT',
        'TTS critic requires audio and alignment evidence for the exact approved script',
      )
      const words = await this.dependencies.alignment.readWords({ workspaceId: job.workspaceId, artifactId: alignment!.artifactId })
      const alignmentEndMs = words.at(-1)?.endMs
      assertDomain(Number.isSafeInteger(alignmentEndMs) && alignmentEndMs! > 0, 'PERSISTENCE_CONFLICT', 'TTS alignment has no valid terminal timestamp')
      return Object.freeze({
        subject: Object.freeze({
          providerJobId: job.id,
          workspaceId: job.workspaceId, projectId: job.projectId, blockId: binding.blockId,
          capability: 'tts', adapterId: job.adapterId, adapterVersion: job.adapterVersion,
          modelRef: audio!.modelRef ?? null,
          video: null,
          audio: Object.freeze({ artifactId: target!.id, artifactKey: target!.artifactKey, sha256: target!.sha256, byteSize: Number(target!.byteSize) }),
          alignmentArtifactId: alignment!.artifactId,
          scriptText: block!.exactText,
          expected: Object.freeze({
            durationMs: alignmentEndMs!, durationMode: 'alignment' as const,
            // The durable ledger declares a container, not an audio codec.
            // ffprobe owns codec measurement; no codec is guessed from mp3/wav.
            fps: null, videoCodec: null, audioCodec: null, audioSampleRateHz: null,
            identityRef: profile!.snapshot.avatar.identityRef, declaredIdentityRef: null,
            rights: Object.freeze({ withinGrantedScope: rightsValid, reason: rightsValid ? null : 'presenter consent or provider authorization expired before criticism' }),
            previousBlock: null,
          }),
        }),
        profileSnapshotId: binding.profileSnapshotId,
        scriptHash: binding.scriptHash,
      })
    }

    const binding = avatarBinding(job.input.criticBinding)
    const audioMasterId = String(job.input.audioMasterId ?? '')
    const persistedMaster = await this.dependencies.audioMasters.read({ workspaceId: job.workspaceId, projectId: job.projectId, audioMasterId })
    const master = persistedMaster?.master
    const storedRange = job.input.audioRange as Record<string, unknown> | undefined
    const startWordIndex = master && storedRange ? master.words.findIndex((word) => word.startMs === storedRange.startMs) : -1
    const endWordPosition = master && storedRange ? master.words.findIndex((word) => word.endMs === storedRange.endMs) : -1
    const canonicalRange = master && startWordIndex >= 0 && endWordPosition >= startWordIndex
      ? createSyntheticAvatarAudioRange({ master, startWordIndex, endWordIndex: endWordPosition + 1 })
      : null
    assertDomain(
      Boolean(master && canonicalRange) &&
        master!.masterHash === job.input.audioMasterHash &&
        master!.projectVersionId === job.originProjectVersionId &&
        master!.profileSnapshotId === job.authorization.profileSnapshotId &&
        canonicalRange!.rangeHash === storedRange?.rangeHash &&
        canonicalRange!.text === binding.scriptText &&
        binding.scriptHash === sha256(binding.scriptText) &&
        binding.profileSnapshotId === job.authorization.profileSnapshotId &&
        binding.expectedDurationMs === canonicalRange!.durationMs &&
        binding.alignmentArtifactId === master!.alignmentEvidence.artifactId,
      'PERSISTENCE_CONFLICT',
      'Audio-avatar critic binding diverged from the canonical audio master range',
    )
    const audioArtifactId = String(job.input.audioArtifactId ?? '')
    const audio = await this.dependencies.artifacts.findById(job.workspaceId, audioArtifactId)
    assertDomain(audio?.status === 'available' && audio.mediaType === 'audio' && audio.id === master!.audio.artifactId && audio.sha256 === master!.audio.artifactSha256, 'PERSISTENCE_CONFLICT', 'Audio-avatar driving audio diverged from its canonical master')
    const audioRange = storedRange
    assertDomain(audioRange && Number.isSafeInteger(audioRange.startMs) && Number.isSafeInteger(audioRange.endMs) && Number(audioRange.endMs) > Number(audioRange.startMs) && typeof audioRange.rangeHash === 'string' && /^[a-f0-9]{64}$/.test(audioRange.rangeHash), 'PERSISTENCE_CONFLICT', 'Audio-avatar canonical audio range is invalid')
    const ledger = await this.dependencies.resultArtifacts.listByJob({ workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id })
    const sidecars = ledger.filter((entry) => entry.role === 'output-speech-evidence')
    assertDomain(sidecars.length === 1, 'PRECONDITION_REQUIRED', 'Audio-avatar output speech evidence is unavailable')
    assertDomain(
      sidecars[0]!.providerJobRef === job.providerJobId && sidecars[0]!.adapterId === job.adapterId &&
        sidecars[0]!.adapterVersion === job.adapterVersion && sidecars[0]!.inputHash === job.inputHash &&
        sidecars[0]!.authorizationHash === job.authorization.authorizationHash && sidecars[0]!.scriptHash === binding.scriptHash,
      'PERSISTENCE_CONFLICT',
      'Audio-avatar output speech evidence ledger diverged from its provider job',
    )
    const sidecarArtifact = await this.dependencies.artifacts.findById(job.workspaceId, sidecars[0]!.artifactId)
    assertDomain(sidecarArtifact?.status === 'available' && sidecarArtifact.mediaType === 'data' && sidecarArtifact.sha256 === sidecars[0]!.artifactSha256, 'PERSISTENCE_CONFLICT', 'Audio-avatar output speech sidecar diverged from its ledger record')
    const operationPrefix = `avatar-output-evidence-${calculateCanonicalHash({ jobId: job.id, artifactId: artifact.artifactId }).slice(0, 24)}`
    let outputSpeechEvidence
    let operationFailed = false
    try {
      const materialized = await Promise.allSettled([
        this.dependencies.sources.materialize({ operationId: `${operationPrefix}-audio`, artifactKey: audio!.artifactKey, sha256: audio!.sha256, byteSize: Number(audio!.byteSize), signal: input.signal }),
        this.dependencies.sources.materialize({ operationId: `${operationPrefix}-video`, artifactKey: target!.artifactKey, sha256: target!.sha256, byteSize: Number(target!.byteSize), signal: input.signal }),
        this.dependencies.sources.materialize({ operationId: `${operationPrefix}-sidecar`, artifactKey: sidecarArtifact!.artifactKey, sha256: sidecarArtifact!.sha256, byteSize: Number(sidecarArtifact!.byteSize), signal: input.signal }),
      ])
      const failed = materialized.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
      if (failed) throw failed.reason
      const [sourceResult, videoResult, sidecarResult] = materialized
      assertDomain(sourceResult?.status === 'fulfilled' && videoResult?.status === 'fulfilled' && sidecarResult?.status === 'fulfilled', 'PERSISTENCE_CONFLICT', 'Avatar evidence materialization did not complete')
      const sourceMaterialized = sourceResult.value
      const videoMaterialized = videoResult.value
      const sidecarMaterialized = sidecarResult.value
      let sidecar: ReturnType<typeof parseControlledOutputSpeechSidecar>
      try {
        sidecar = parseControlledOutputSpeechSidecar(JSON.parse(await readFile(sidecarMaterialized.path, 'utf8')))
      } catch {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Persisted avatar output speech sidecar is invalid')
      }
      const comparison = await this.dependencies.audioComparison.compare({
        sourcePath: sourceMaterialized.path,
        resultPath: videoMaterialized.path,
        sourceStartMs: Number(audioRange.startMs),
        sourceDurationMs: Number(audioRange.endMs) - Number(audioRange.startMs),
        signal: input.signal,
      })
      outputSpeechEvidence = createAvatarOutputSpeechEvidence({
        ...comparison,
        jobId: job.id,
        videoArtifactId: target!.id,
        videoArtifactSha256: target!.sha256,
        sourceAudioArtifactId: audio!.id,
        sourceAudioRangeHash: String(audioRange.rangeHash),
        speechEvidence: {
          kind: 'controlled', evaluatorId: sidecar.evaluatorId, evaluatorVersion: sidecar.evaluatorVersion,
          outputTranscriptHash: sidecar.outputTranscriptHash, observedIdentityRef: sidecar.observedIdentityRef,
        },
      })
    } catch (error) {
      operationFailed = true
      throw error
    } finally {
      const cleanup = await Promise.allSettled([
        this.dependencies.sources.cleanup(`${operationPrefix}-audio`),
        this.dependencies.sources.cleanup(`${operationPrefix}-video`),
        this.dependencies.sources.cleanup(`${operationPrefix}-sidecar`),
      ])
      if (!operationFailed) {
        const failedCleanup = cleanup.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
        if (failedCleanup) throw failedCleanup.reason
      }
    }
    return Object.freeze({
      subject: Object.freeze({
        providerJobId: job.id,
        workspaceId: job.workspaceId, projectId: job.projectId, blockId: binding.blockId,
        capability: 'audio-avatar', adapterId: job.adapterId, adapterVersion: job.adapterVersion, modelRef: null,
        video: Object.freeze({ artifactId: target!.id, artifactKey: target!.artifactKey, sha256: target!.sha256, byteSize: Number(target!.byteSize) }),
        // The authorized artifact is the full master while this job submitted a
        // materialized range. Do not label the master as the judged audio. The
        // video probe measures the embedded range actually returned; a future
        // range-alignment artifact is still required for pronunciation.
        audio: null,
        alignmentArtifactId: binding.alignmentArtifactId,
        outputSpeechEvidence,
        outputSpeechEvidenceArtifactId: sidecarArtifact!.id,
        scriptHash: binding.scriptHash,
        scriptText: binding.scriptText,
        expected: Object.freeze({
          durationMs: binding.expectedDurationMs, durationMode: 'fixed' as const,
          fps: null, videoCodec: null, audioCodec: null, audioSampleRateHz: null,
          identityRef: profile!.snapshot.avatar.identityRef, declaredIdentityRef: null,
          rights: Object.freeze({ withinGrantedScope: rightsValid, reason: rightsValid ? null : 'presenter consent or provider authorization expired before criticism' }),
          previousBlock: null,
        }),
      }),
      profileSnapshotId: binding.profileSnapshotId,
      scriptHash: binding.scriptHash,
    })
  }
}
