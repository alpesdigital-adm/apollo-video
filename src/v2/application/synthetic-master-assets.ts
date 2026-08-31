import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import { evaluateAssetUse, type AssetRightsSnapshot } from '../domain/asset-rights.ts'
import {
  createSyntheticMasterAsset,
  SYNTHETIC_MASTER_ARTIFACT_ROLES,
  SYNTHETIC_MASTER_REQUIRED_ARTIFACT_ROLES,
  type SyntheticMasterArtifactRole,
  type SyntheticMasterAsset,
} from '../domain/synthetic-master-asset.ts'
import { assertSyntheticPresenterPolicy } from '../domain/synthetic-presenter-policy-engine.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { materializeActorAuditContext, requireScope } from './authenticate-api-client.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProviderResultArtifactRepository } from './ports/provider-result-artifact-repository.ts'
import type { SyntheticMasterAssetRepository } from './ports/synthetic-master-asset-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'

/**
 * The provider job facts a promotion is allowed to trust. Everything here is
 * read back from durable state; nothing is taken from the caller.
 */
export interface PromotableProviderJob {
  id: string
  workspaceId: string
  projectId: string
  originProjectVersionId: string
  operation: string
  adapterId: string
  adapterVersion: string
  providerJobId: string | null
  status: string
  criticResultHash: string | null
  authorizationHash: string
  submittedAt: string | null
  completedAt: string | null
}

export interface PromotableProviderJobReader {
  read(input: { workspaceId: string; jobId: string }): Promise<Readonly<PromotableProviderJob> | null>
}

export interface AssetRightsReader {
  currentSnapshot(input: { workspaceId: string; artifactId: string }): Promise<AssetRightsSnapshot | null>
}

/**
 * Verifies that the bytes an artifact claims are the bytes storage actually
 * holds. The port fails closed on a size or checksum mismatch, so a manifest
 * that drifted from its blob can never be promoted.
 */
export interface MasterArtifactByteVerifier {
  verify(input: { artifactKey: string; expectedSha256: string; expectedByteSize: bigint }): Promise<void>
}

export interface MasterDurations {
  audioDurationMs: number
  videoDurationMs: number
}

export interface MasterDurationProber {
  measure(input: {
    audio: Readonly<{ artifactId: string; artifactKey: string }>
    video: Readonly<{ artifactId: string; artifactKey: string }>
  }): Promise<Readonly<MasterDurations>>
}

const ROLE_BY_PROVIDER_ROLE: Readonly<Record<string, SyntheticMasterArtifactRole>> = Object.freeze({
  'provider-original': 'provider-original',
  'normalized-video': 'normalized-video',
  'primary-video': 'provider-original',
  'primary-audio': 'final-audio',
  'final-audio': 'final-audio',
  'alignment-evidence': 'alignment',
  alignment: 'alignment',
})

export interface PromoteSyntheticMasterRequest {
  workspaceId: string
  projectId: string
  providerJobId: string
  profileSnapshotId: string
  scriptText: string
  locale: string
  use: string
  market: string
  /** Approved block generations whose bytes composed this performance. */
  lineage: readonly string[]
  cost: Readonly<{ currency: string; minorUnits: number }>
  actor: AuthenticatedExternalActor
  idempotencyKey: string
}

/**
 * Promotes an approved provider result into an immutable synthetic master.
 *
 * Nothing is published until every gate passes: the job must be terminal and
 * approved with a critic result, its artifacts must exist, their checksums and
 * byte sizes must match what storage actually holds, the presenter snapshot
 * must still be intact, consent and rights must still allow the use, and the
 * measured audio and video durations must agree. Any of them failing raises
 * before a master row exists, so a tampered blob, a revoked consent, a rejected
 * critic or an incoherent duration can never become a reusable master.
 */
export function promoteSyntheticMasterAssetService(dependencies: {
  masters: SyntheticMasterAssetRepository
  jobs: PromotableProviderJobReader
  resultArtifacts: ProviderResultArtifactRepository
  artifacts: MediaArtifactQueryRepository
  profiles: SyntheticProductionRepository
  rights: AssetRightsReader
  bytes: MasterArtifactByteVerifier
  durations: MasterDurationProber
  clock: () => Date
  createId: () => string
}) {
  return async function promote(request: PromoteSyntheticMasterRequest): Promise<
    Readonly<{ master: Readonly<SyntheticMasterAsset>; replayed: boolean }>
  > {
    requireScope(request.actor, 'projects:write')
    assertDomain(
      request.actor.workspaceId === request.workspaceId,
      'INVALID_WORKSPACE',
      'Actor cannot promote a master in another workspace',
    )
    const audit = materializeActorAuditContext(request.actor)
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length >= 8, 'INVALID_ARGUMENT', 'Idempotency key is required')

    const replay = await dependencies.masters.findReplay({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey,
    })
    if (replay) return Object.freeze({ master: replay.master, replayed: true })

    // 1. The job must be terminal, approved and ours.
    const job = await dependencies.jobs.read({ workspaceId: request.workspaceId, jobId: request.providerJobId })
    assertDomain(Boolean(job), 'ASSET_NOT_FOUND', 'Provider job was not found in this workspace')
    assertDomain(
      job!.workspaceId === request.workspaceId && job!.projectId === request.projectId,
      'INVALID_WORKSPACE',
      'Provider job belongs to another workspace or project',
    )
    assertDomain(job!.status === 'approved', 'PRECONDITION_REQUIRED', 'Only an approved provider job can be promoted')
    assertDomain(
      typeof job!.criticResultHash === 'string' && job!.criticResultHash.length === 64,
      'PRECONDITION_REQUIRED',
      'Provider job carries no critic result to promote',
    )
    assertDomain(Boolean(job!.completedAt), 'PRECONDITION_REQUIRED', 'Provider job is not terminal yet')
    assertDomain(
      typeof job!.providerJobId === 'string' && job!.providerJobId.length > 0,
      'PRECONDITION_REQUIRED',
      'Provider job has no provider reference',
    )

    // A job already promoted returns its master instead of sealing a second one.
    const sealed = await dependencies.masters.findByProviderJob({
      workspaceId: request.workspaceId,
      providerJobId: request.providerJobId,
    })
    if (sealed) return Object.freeze({ master: sealed.master, replayed: true })

    // 2. Every ingested role must exist as a provider result artifact.
    const results = await dependencies.resultArtifacts.listByJob({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      jobId: request.providerJobId,
    })
    const byRole = new Map<SyntheticMasterArtifactRole, (typeof results)[number]>()
    for (const result of results) {
      const role = ROLE_BY_PROVIDER_ROLE[result.role]
      if (!role || byRole.has(role)) continue
      byRole.set(role, result)
    }
    for (const role of SYNTHETIC_MASTER_REQUIRED_ARTIFACT_ROLES) {
      assertDomain(byRole.has(role), 'PRECONDITION_REQUIRED', `Provider job has no ${role} artifact to promote`)
    }
    const promotedRoles = SYNTHETIC_MASTER_ARTIFACT_ROLES.filter((role) => byRole.has(role))

    // 3. Each artifact must exist in the catalog, be available, and its bytes
    //    must be the bytes storage holds.
    const catalogued = new Map<SyntheticMasterArtifactRole, Awaited<ReturnType<MediaArtifactQueryRepository['findById']>>>()
    for (const role of promotedRoles) {
      const result = byRole.get(role)!
      const artifact = await dependencies.artifacts.findById(request.workspaceId, result.artifactId)
      assertDomain(Boolean(artifact), 'ASSET_NOT_FOUND', `Master ${role} artifact is missing from the catalog`)
      assertDomain(
        artifact!.workspaceId === request.workspaceId,
        'INVALID_WORKSPACE',
        `Master ${role} artifact belongs to another workspace`,
      )
      assertDomain(
        artifact!.status === 'available',
        'PRECONDITION_REQUIRED',
        `Master ${role} artifact is not available`,
      )
      assertDomain(
        artifact!.sha256 === result.artifactSha256 && artifact!.byteSize === BigInt(result.byteSize),
        'PERSISTENCE_CONFLICT',
        `Master ${role} artifact drifted from the provider result ledger`,
      )
      await dependencies.bytes.verify({
        artifactKey: artifact!.artifactKey,
        expectedSha256: artifact!.sha256,
        expectedByteSize: artifact!.byteSize,
      })
      catalogued.set(role, artifact)
    }

    // 4. The presenter snapshot must still be intact and still allow this use.
    const profile = await dependencies.profiles.readProfile({
      workspaceId: request.workspaceId,
      snapshotId: request.profileSnapshotId,
    })
    assertDomain(Boolean(profile), 'ASSET_NOT_FOUND', 'Presenter snapshot was not found in this workspace')
    const head = await dependencies.profiles.readProfileHead({
      workspaceId: request.workspaceId,
      profileId: profile!.snapshot.id,
    })
    const now = dependencies.clock()
    assertSyntheticPresenterPolicy({
      snapshot: profile!.snapshot,
      snapshotWorkspaceId: request.workspaceId,
      ...(head ? { head: { currentVersion: head.head.currentVersion, current: head.current.snapshot } } : {}),
      context: {
        operation: 'audio-avatar',
        use: request.use,
        market: request.market,
        locale: request.locale,
        workspaceId: request.workspaceId,
        now,
      },
    })

    // 5. Asset rights must allow the use of every promoted artifact.
    for (const role of promotedRoles) {
      const artifact = catalogued.get(role)!
      const snapshot = await dependencies.rights.currentSnapshot({
        workspaceId: request.workspaceId,
        artifactId: artifact.id,
      })
      const decision = evaluateAssetUse(
        snapshot,
        { workspaceId: request.workspaceId, use: request.use, market: request.market, locale: request.locale },
        now,
      )
      assertDomain(
        decision.outcome === 'allow',
        'ASSET_RIGHTS_BLOCKED',
        `Master ${role} artifact is not cleared for ${request.use} in ${request.market}: ${decision.reasonCodes.join(', ')}`,
      )
    }

    // 6. Audio and video must describe the same performance.
    const audio = catalogued.get('final-audio')!
    // The normalized track when a normalization stage produced one; otherwise
    // the provider's own video, which is what the master actually holds.
    const video = catalogued.get('normalized-video') ?? catalogued.get('provider-original')!
    const measured = await dependencies.durations.measure({
      audio: { artifactId: audio.id, artifactKey: audio.artifactKey },
      video: { artifactId: video.id, artifactKey: video.artifactKey },
    })

    const master = createSyntheticMasterAsset({
      id: dependencies.createId(),
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      projectVersionId: job!.originProjectVersionId,
      profileId: profile!.snapshot.id,
      profileSnapshotId: profile!.profileSnapshotId,
      profileVersion: profile!.snapshot.version,
      consentSnapshotHash: profile!.snapshot.consent.snapshotHash,
      authorizationHash: job!.authorizationHash,
      rightsSnapshotId: null,
      artifacts: promotedRoles.map((role) => {
        const artifact = catalogued.get(role)!
        return {
          role,
          artifactId: artifact.id,
          sha256: artifact.sha256,
          byteSize: Number(artifact.byteSize),
          mediaType: artifact.mediaType,
          container: artifact.container,
        }
      }),
      scriptText: request.scriptText,
      alignmentHash: byRole.get('alignment')!.artifactSha256,
      locale: request.locale,
      durationMs: measured.audioDurationMs,
      audioDurationMs: measured.audioDurationMs,
      videoDurationMs: measured.videoDurationMs,
      provenance: {
        adapterId: job!.adapterId,
        adapterVersion: job!.adapterVersion,
        capability: job!.operation,
        modelRef: byRole.get('provider-original')!.modelRef ?? null,
        adapterConfigHash: byRole.get('provider-original')!.adapterConfigHash,
        providerJobId: job!.id,
        providerJobRef: job!.providerJobId!,
      },
      cost: {
        currency: request.cost.currency,
        minorUnits: request.cost.minorUnits,
        latencyMs: Math.max(
          0,
          Date.parse(job!.completedAt!) - Date.parse(job!.submittedAt ?? job!.completedAt!),
        ),
      },
      critic: {
        // Until F3.009 persists its own report, the approving evidence is the
        // provider job's critic result hash, which the repository re-checks
        // inside the sealing transaction.
        reportId: `${job!.id}:critic`,
        reportHash: job!.criticResultHash!,
        decision: 'approved',
      },
      lineage: request.lineage,
      createdAt: now.toISOString(),
    })

    const persisted = await dependencies.masters.create({
      master,
      profileSnapshotHash: profile!.snapshot.snapshotHash,
      criticResultHash: job!.criticResultHash!,
      requestFingerprint: calculateCanonicalHash({
        schemaVersion: 'synthetic-master-promotion-request/v1',
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        providerJobId: request.providerJobId,
        profileSnapshotId: request.profileSnapshotId,
        scriptHash: master.scriptHash,
        locale: request.locale,
        use: request.use,
        market: request.market,
        lineage: [...request.lineage],
        cost: { currency: request.cost.currency, minorUnits: request.cost.minorUnits },
      }),
      idempotencyKey,
      authenticationAudit: audit,
    })
    return Object.freeze({ master: persisted.value.master, replayed: persisted.replayed })
  }
}
