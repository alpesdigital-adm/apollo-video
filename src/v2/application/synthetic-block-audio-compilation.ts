import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { assetRightsRevision, createAssetRightsSnapshot, type AssetRightsSnapshot } from '../domain/asset-rights.ts'
import { createAssetRightsChangeIntent } from '../domain/asset-rights-change.ts'
import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import { calculateSyntheticBlockCacheKey } from '../domain/synthetic-block-generation.ts'
import type { SyntheticAudioWord } from '../domain/synthetic-audio-master.ts'
import {
  assertBlockGenerationConsent,
  syntheticBlockVoiceKeyFromProfile,
} from './synthetic-block-generations.ts'
import type { SyntheticScriptPlanMutation } from './synthetic-script-plans.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { ArtifactSourceMaterializer, VerifiedMediaStorage } from './ports/media-ingest.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { SyntheticBlockConcatenationRepository } from './ports/synthetic-block-concatenation-repository.ts'
import type { SyntheticBlockGenerationRepository } from './ports/synthetic-block-generation-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { SyntheticScriptPlanRepository, PersistedSyntheticScriptPlan } from './ports/synthetic-script-plan-repository.ts'
import type {
  AudioConcatenationBlockInput,
  AudioConcatenationResult,
} from '../infrastructure/media/audio-concatenation.ts'

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

interface TtsAlignmentEvidence {
  schemaVersion: string
  characters: readonly string[]
  startTimesSeconds: readonly number[]
  endTimesSeconds: readonly number[]
}

/**
 * Turns one block's per-character provider alignment into words shifted onto
 * the consolidated timeline. Words come exclusively from the provider's
 * characters — never invented — and must stay inside their block's window.
 */
export function wordsFromBlockAlignment(input: {
  alignment: Readonly<TtsAlignmentEvidence>
  offsetMs: number
  windowDurationMs: number
}): SyntheticAudioWord[] {
  const { characters, startTimesSeconds, endTimesSeconds } = input.alignment
  assertDomain(
    Array.isArray(characters) && characters.length > 0 &&
      startTimesSeconds.length === characters.length && endTimesSeconds.length === characters.length,
    'PERSISTENCE_CONFLICT',
    'Block alignment evidence is malformed',
  )
  const words: SyntheticAudioWord[] = []
  let current: { text: string; startSeconds: number; endSeconds: number } | null = null
  for (const [index, character] of characters.entries()) {
    if (/\s/.test(character)) {
      if (current) {
        words.push({ word: current.text, startMs: Math.round(current.startSeconds * 1_000), endMs: Math.round(current.endSeconds * 1_000), confidence: 1 })
        current = null
      }
      continue
    }
    if (!current) current = { text: character, startSeconds: startTimesSeconds[index]!, endSeconds: endTimesSeconds[index]! }
    else {
      current.text += character
      current.endSeconds = endTimesSeconds[index]!
    }
  }
  if (current) {
    words.push({ word: current.text, startMs: Math.round(current.startSeconds * 1_000), endMs: Math.round(current.endSeconds * 1_000), confidence: 1 })
  }
  let previousEnd = 0
  return words.map((word) => {
    const overflow = word.endMs - input.windowDurationMs
    assertDomain(overflow <= 60, 'PERSISTENCE_CONFLICT', 'Block alignment exceeds its audio window')
    const endMs = Math.min(word.endMs, input.windowDurationMs)
    const startMs = Math.max(Math.min(word.startMs, endMs - 1), previousEnd)
    assertDomain(startMs < endMs, 'PERSISTENCE_CONFLICT', 'Block alignment word timing collapsed')
    previousEnd = endMs
    return { word: word.word, startMs: input.offsetMs + startMs, endMs: input.offsetMs + endMs, confidence: 1 }
  })
}

export interface CompileBlockAudioSettings {
  gapMs: number
  outputFormat: 'mp3' | 'wav'
}

export function compileSyntheticBlockAudioService(dependencies: {
  plans: SyntheticScriptPlanRepository
  generations: SyntheticBlockGenerationRepository
  profiles: SyntheticProductionRepository
  artifacts: MediaArtifactQueryRepository
  artifactPersistence: MediaArtifactPersistenceRepository
  rights: AssetRightsRepository
  concatenations: SyntheticBlockConcatenationRepository
  sources: ArtifactSourceMaterializer
  storage: VerifiedMediaStorage
  mutatePlan: (request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    planId: string
    baseVersionId: string
    mutation: SyntheticScriptPlanMutation
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) => Promise<Readonly<{ plan: Readonly<PersistedSyntheticScriptPlan>; replayed: boolean }>>
  createAudioMaster: (request: Record<string, unknown>) => Promise<Readonly<{ value: Readonly<{ master: Readonly<{ id: string }> }>; replayed: boolean }>>
  concatenate: (input: {
    blocks: readonly Readonly<AudioConcatenationBlockInput>[]
    gapMs: number
    workDirectory: string
  }) => Promise<Readonly<AudioConcatenationResult>>
  workRoot: string
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    planId: string
    baseVersionId: string
    settings: Readonly<CompileBlockAudioSettings>
    use: string
    market: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === request.workspaceId, 'AUTH_INVALID', 'Audio compilation actor does not belong to workspace')
    const now = dependencies.clock()
    const settings = Object.freeze({ gapMs: request.settings.gapMs, outputFormat: request.settings.outputFormat })
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'compile-synthetic-block-audio-request/v1',
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      projectVersionId: request.projectVersionId,
      planId: request.planId,
      baseVersionId: request.baseVersionId,
      settings,
      use: request.use,
      market: request.market,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.concatenations.findReplay({
      workspaceId: request.workspaceId,
      planId: request.planId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: request.idempotencyKey,
    })
    if (replay) {
      assertDomain(replay.requestFingerprint === requestFingerprint, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different audio compilation')
      return Object.freeze({ concatenation: replay, audioMasterId: replay.audioMasterId, replayed: true })
    }

    // Crash recovery: if this exact compile already appended its command
    // version, resume from it instead of failing the base-version check.
    const versionReplay = await dependencies.plans.findCommandReplay({
      workspaceId: request.workspaceId,
      planId: request.planId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: `${request.idempotencyKey}.v`,
    })
    const current = versionReplay ?? await dependencies.plans.readPlan({ workspaceId: request.workspaceId, projectId: request.projectId, planId: request.planId })
    if (!current) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic script plan was not found')
    if (!versionReplay) {
      assertDomain(current.head.currentVersionId === request.baseVersionId, 'VERSION_CONFLICT', 'Audio compilation must target the current plan version')
    }
    const plan = current
    const profile = await dependencies.profiles.readProfile({ workspaceId: request.workspaceId, snapshotId: plan.version.profileSnapshotId })
    if (!profile) throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')
    assertBlockGenerationConsent(profile.snapshot, { use: request.use, market: request.market, locale: plan.version.locale, now })
    const voice = syntheticBlockVoiceKeyFromProfile(profile.snapshot, settings.outputFormat)

    // Every sequenced block must hold an approved generation for its CURRENT
    // cache key before any consolidated master may exist — checked before the
    // compile command appends a version, so an ineligible compile leaves no
    // trace in the plan history.
    const inputs: { blockId: string; generationId: string; audio: { artifactKey: string; sha256: string; byteSize: number }; alignmentArtifactId: string }[] = []
    const missing: string[] = []
    for (const block of plan.blocks) {
      const cacheKey = calculateSyntheticBlockCacheKey({ exactText: block.exactText, locale: plan.version.locale, voice })
      const effective = await dependencies.generations.findEffective({ workspaceId: request.workspaceId, blockId: block.id })
      if (!effective || effective.status !== 'approved' || effective.cacheKey !== cacheKey || !effective.audioArtifactId || !effective.alignmentArtifactId) {
        missing.push(block.id)
        continue
      }
      const audioRow = await dependencies.artifacts.findById(request.workspaceId, effective.audioArtifactId)
      assertDomain(audioRow?.status === 'available', 'ASSET_NOT_USABLE', 'Approved block audio artifact is unavailable')
      inputs.push({
        blockId: block.id,
        generationId: effective.id,
        audio: { artifactKey: audioRow!.artifactKey, sha256: audioRow!.sha256, byteSize: Number(audioRow!.byteSize) },
        alignmentArtifactId: effective.alignmentArtifactId,
      })
    }
    assertDomain(missing.length === 0, 'PRECONDITION_REQUIRED', `Blocks without an approved current generation: ${missing.join(', ')}`)

    // The compile is itself a plan command: it appends an immutable version
    // (same sequence) whose impact records the no-render semantics.
    const settingsHash = calculateCanonicalHash({ schemaVersion: 'synthetic-block-compile-settings/v1', settings, use: request.use, market: request.market })
    const commanded = await dependencies.mutatePlan({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      projectVersionId: request.projectVersionId,
      planId: request.planId,
      baseVersionId: request.baseVersionId,
      mutation: { kind: 'compile-audio', settingsHash },
      actor: request.actor,
      idempotencyKey: `${request.idempotencyKey}.v`,
    })
    const planVersionId = commanded.plan.version.id

    const operationId = `compile-${planVersionId}`
    const workDirectory = join(dependencies.workRoot, `concat-${sha256(operationId).slice(0, 24)}`)
    try {
      const materialized = await Promise.all(inputs.map(async (input) => ({
        blockId: input.blockId,
        generationId: input.generationId,
        sha256: input.audio.sha256,
        path: (await dependencies.sources.materialize({ operationId, artifactKey: input.audio.artifactKey, sha256: input.audio.sha256, byteSize: input.audio.byteSize })).path,
      })))
      const result = await dependencies.concatenate({ blocks: materialized, gapMs: settings.gapMs, workDirectory })

      // Consolidated words: provider characters per block, shifted by the
      // block's REAL offset in the concatenated audio.
      const words: SyntheticAudioWord[] = []
      for (const entry of result.entries) {
        const input = inputs.find(({ blockId }) => blockId === entry.blockId)!
        const alignmentRow = await dependencies.artifacts.findById(request.workspaceId, input.alignmentArtifactId)
        assertDomain(alignmentRow?.status === 'available', 'ASSET_NOT_USABLE', 'Approved block alignment artifact is unavailable')
        const alignmentFile = await dependencies.sources.materialize({ operationId, artifactKey: alignmentRow!.artifactKey, sha256: alignmentRow!.sha256, byteSize: Number(alignmentRow!.byteSize) })
        const payload = JSON.parse(await readFile(alignmentFile.path, 'utf8')) as TtsAlignmentEvidence
        words.push(...wordsFromBlockAlignment({ alignment: payload, offsetMs: entry.outputInMs, windowDurationMs: entry.outputOutMs - entry.outputInMs }))
      }
      assertDomain(words.length > 0 && words.at(-1)!.endMs <= result.durationMs, 'PERSISTENCE_CONFLICT', 'Consolidated alignment escaped the concatenated audio duration')

      const storedAudio = await dependencies.storage.promoteDerived({
        workspaceId: request.workspaceId, sourcePath: result.outputPath, sha256: result.finalAudioSha256,
        extension: result.container, prefix: 'synthetic-concat-results',
      })
      const evidencePayload = stableSerialize({
        schemaVersion: 'synthetic-block-concatenation-alignment/v1',
        planId: request.planId,
        planVersionId,
        concatHash: result.concatHash,
        finalAudioSha256: result.finalAudioSha256,
        entries: result.entries,
        words,
      })
      const evidenceBytes = Buffer.from(evidencePayload, 'utf8')
      const evidenceSha = sha256(evidenceBytes)
      const evidencePath = join(workDirectory, 'consolidated-alignment.json')
      await import('node:fs/promises').then(({ writeFile }) => writeFile(evidencePath, evidenceBytes))
      const storedEvidence = await dependencies.storage.promoteDerived({
        workspaceId: request.workspaceId, sourcePath: evidencePath, sha256: evidenceSha,
        extension: 'json', prefix: 'synthetic-concat-alignment',
      })

      const identityHash = calculateCanonicalHash({ schemaVersion: 'synthetic-block-concatenation-identity/v1', planVersionId, concatHash: result.concatHash })
      const audioArtifactId = `concat-audio-${identityHash.slice(0, 32)}`
      const alignmentArtifactId = `concat-alignment-${identityHash.slice(0, 32)}`
      const createdAt = now.toISOString()
      const recipe = {
        id: 'synthetic-block-concatenation', version: '1.0.0',
        parameters: { planId: request.planId, planVersionId, concatHash: result.concatHash, gapMs: settings.gapMs, outputFormat: settings.outputFormat },
      }
      await dependencies.artifactPersistence.persistOrReplay({
        workspaceId: request.workspaceId, artifactId: audioArtifactId, manifestId: `concat-audio-manifest-${identityHash.slice(0, 32)}`,
        lineageIds: [],
        manifest: createMediaArtifactManifestV2({
          artifactKey: storedAudio.key, artifactSha256: storedAudio.sha256, byteSize: storedAudio.byteSize,
          mediaType: 'audio', container: result.container, recipe,
          sources: [],
          probe: { duration: result.durationMs / 1_000 } as unknown as { width: number; height: number; duration: number; fps: number },
        }),
        createdAt,
      })
      await dependencies.artifactPersistence.persistOrReplay({
        workspaceId: request.workspaceId, artifactId: alignmentArtifactId, manifestId: `concat-alignment-manifest-${identityHash.slice(0, 32)}`,
        lineageIds: [`lineage-${calculateCanonicalHash({ manifestId: `concat-alignment-manifest-${identityHash.slice(0, 32)}`, artifactId: audioArtifactId, index: 0 })}`],
        manifest: createMediaArtifactManifestV2({
          artifactKey: storedEvidence.key, artifactSha256: storedEvidence.sha256, byteSize: storedEvidence.byteSize,
          mediaType: 'data', container: 'json', recipe,
          sources: [{ artifactKey: storedAudio.key, sha256: storedAudio.sha256, role: 'concatenated-audio', execution: { tool: { id: 'ffmpeg-concat', version: '1.0.0', digest: result.concatHash } } }],
        }),
        createdAt,
      })

      // Derived rights: the consolidated artifacts inherit exactly the scope
      // this compilation was authorized for, expiring with the consent.
      const currentRights = await dependencies.rights.findCurrentForArtifacts(request.workspaceId, [audioArtifactId, alignmentArtifactId])
      for (const artifactId of [audioArtifactId, alignmentArtifactId]) {
        if (currentRights.get(artifactId)) continue
        const snapshot: AssetRightsSnapshot = createAssetRightsSnapshot({
          id: `concat-rights-${sha256(`${identityHash}:${artifactId}`).slice(0, 40)}`,
          workspaceId: request.workspaceId, artifactId, sequence: 1,
          draft: {
            status: 'approved', allowedUses: [request.use], prohibitedUses: [],
            allowedMarkets: [request.market], allowedLocales: [plan.version.locale],
            allowedSyntheticOperations: ['tts', 'audio-avatar'],
            expiresAt: profile.snapshot.consent.expiresAt,
            consent: { status: 'not-required', allowedUses: [] },
          },
          createdBy: { type: 'api-client', id: audit.clientId }, createdAt,
        })
        await dependencies.rights.setCurrent(snapshot, assetRightsRevision(artifactId, 0), createAssetRightsChangeIntent({
          workspaceId: request.workspaceId, artifactId, snapshotHash: snapshot.snapshotHash,
          baseRevision: assetRightsRevision(artifactId, 0),
          actor: { kind: 'internal', actorType: 'api-client', actorId: audit.clientId }, changedAt: createdAt,
        }))
      }

      const concatenationId = `sbc-${identityHash.slice(0, 48)}`
      const master = await dependencies.createAudioMaster({
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        projectVersionId: request.projectVersionId,
        profileSnapshotId: profile.profileSnapshotId,
        source: { kind: 'concatenated', planId: request.planId, planVersionId, concatenationId },
        audioArtifactId,
        alignmentEvidenceArtifactId: alignmentArtifactId,
        durationMs: result.durationMs,
        locale: plan.version.locale,
        words,
        approvedAt: createdAt,
        approvalCriticHash: result.concatHash,
        use: request.use,
        market: request.market,
        actor: request.actor,
        idempotencyKey: `${request.idempotencyKey}.m`,
      })
      const persisted = await dependencies.concatenations.create({
        concatenation: {
          id: concatenationId,
          workspaceId: request.workspaceId,
          projectId: request.projectId,
          planId: request.planId,
          planVersionId,
          container: result.container,
          codec: result.codec,
          sampleRate: result.sampleRate,
          channels: result.channels,
          gapMs: settings.gapMs,
          durationMs: result.durationMs,
          settings,
          entries: result.entries,
          concatHash: result.concatHash,
          audioArtifactId,
          alignmentArtifactId,
          finalAudioSha256: result.finalAudioSha256,
          audioMasterId: master.value.master.id,
          createdAt,
        },
        requestFingerprint,
        idempotencyKey: request.idempotencyKey,
        authenticationAudit: audit,
      })
      return Object.freeze({
        concatenation: persisted.concatenation,
        audioMasterId: master.value.master.id,
        planVersionId,
        replayed: persisted.replayed,
      })
    } finally {
      await dependencies.sources.cleanup(operationId)
      await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
