import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'

import type { MediaArtifactPersistenceRepository } from '../../application/ports/media-artifact-repository.ts'
import type { MediaArtifactQueryRepository } from '../../application/ports/media-artifact-query-repository.ts'
import type { MediaSourceProber, VerifiedMediaStorage } from '../../application/ports/media-ingest.ts'
import type { ProviderResultArtifactRepository } from '../../application/ports/provider-result-artifact-repository.ts'
import type { ProviderResultIngestor } from '../../application/ports/provider-job-runtime.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import { createMediaArtifactManifestV2 } from '../../domain/media-artifact.ts'
import { PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION } from '../../application/ports/provider-result-artifact-repository.ts'
import type { ProviderJob } from '../../domain/provider-job.ts'

/**
 * Ingest a generative transformation result before anything may judge it.
 *
 * The bytes arrive inline from the adapter, so there is no provider-supplied
 * URL to follow and none of the SSRF surface `SafeProviderResultDownloader`
 * exists to guard. What still has to be proven, and is:
 *
 * - the bytes hash to what the adapter said they hash to;
 * - ffprobe can actually decode them, and they have a real duration and frame
 *   geometry — a truncated MP4 fails here, not in the critic and not in front
 *   of a viewer;
 * - the stored object keeps the same identity it had in memory;
 * - the source artifact the job was authorised to use is still available, and
 *   it is recorded as the manifest's source so lineage survives.
 *
 * The result is a **derivative**. It never replaces the source: the source
 * artifact keeps its own id, its own key and its own bytes, and this one
 * records it as an input.
 */

export interface TransformationProviderResult {
  providerJobId: string
  mediaBytes: Uint8Array
  mediaSha256: string
  mediaByteSize: number
  container: 'mp4'
  mediaType: 'video'
  observedCost?: Readonly<{ currency: string; costMinorUnits: number }>
}

function transformationResult(value: unknown): Readonly<TransformationProviderResult> {
  const result = value as Partial<TransformationProviderResult>
  assertDomain(
    typeof result?.providerJobId === 'string' &&
      result.mediaBytes instanceof Uint8Array &&
      typeof result.mediaSha256 === 'string' &&
      Number.isSafeInteger(result.mediaByteSize) &&
      result.container === 'mp4' &&
      result.mediaType === 'video',
    'PERSISTENCE_CONFLICT',
    'Transformation provider result has an unusable shape',
  )
  return result as Readonly<TransformationProviderResult>
}

export class VerifiedTransformationResultIngestor implements ProviderResultIngestor {
  private readonly dependencies: {
    workRoot: string
    storage: VerifiedMediaStorage
    artifacts: MediaArtifactPersistenceRepository
    artifactQuery: MediaArtifactQueryRepository
    resultArtifacts: ProviderResultArtifactRepository
    prober: MediaSourceProber
    clock?: () => Date
  }

  constructor(dependencies: VerifiedTransformationResultIngestor['dependencies']) {
    assertDomain(
      isAbsolute(normalize(resolve(dependencies.workRoot.trim()))),
      'PERSISTENCE_NOT_CONFIGURED',
      'Transformation result work root is invalid',
    )
    this.dependencies = dependencies
  }

  async ingest(input: { job: Readonly<ProviderJob>; providerResult: unknown; signal?: AbortSignal }) {
    const result = transformationResult(input.providerResult)
    if (input.job.providerJobId !== undefined) {
      assertDomain(
        result.providerJobId === input.job.providerJobId,
        'PERSISTENCE_CONFLICT',
        'Transformation result identity does not match the durable job',
      )
    }
    const mediaBytes = Buffer.from(result.mediaBytes)
    assertDomain(
      mediaBytes.byteLength === result.mediaByteSize &&
        createHash('sha256').update(mediaBytes).digest('hex') === result.mediaSha256,
      'PERSISTENCE_CONFLICT',
      'Transformation media bytes do not match their declared identity',
    )
    const namespace = createHash('sha256').update(input.job.id).digest('hex').slice(0, 32)
    const directory = join(normalize(resolve(this.dependencies.workRoot.trim())), namespace)
    await mkdir(directory, { recursive: true })
    try {
      const mediaPath = join(directory, `${randomUUID()}.${result.container}`)
      await writeFile(mediaPath, mediaBytes, { flag: 'wx' })

      // Decodability is a fact about the bytes, established here. A truncated
      // or corrupt result fails closed at ingestion instead of reaching the
      // critic as something to have an opinion about.
      let probe
      try {
        probe = await this.dependencies.prober.probe(mediaPath, { signal: input.signal })
      } catch {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'Transformation result media could not be decoded')
      }
      assertDomain(
        Number.isFinite(probe.duration) && probe.duration > 0 &&
          Number.isFinite(probe.width) && probe.width > 0 &&
          Number.isFinite(probe.height) && probe.height > 0 &&
          Number.isFinite(probe.fps) && probe.fps > 0,
        'RENDER_OUTPUT_INVALID',
        'Transformation result media has no usable video stream',
      )

      const stored = await this.dependencies.storage.promoteDerived({
        workspaceId: input.job.workspaceId,
        sourcePath: mediaPath,
        sha256: result.mediaSha256,
        extension: result.container,
        prefix: 'transformation-results',
      })
      assertDomain(
        stored.sha256 === result.mediaSha256 && stored.byteSize === result.mediaByteSize,
        'PERSISTENCE_CONFLICT',
        'Transformation result storage identity drifted',
      )

      const sources = await Promise.all(input.job.authorization.artifactDecisions.map(async (decision) => {
        const source = await this.dependencies.artifactQuery.findById(input.job.workspaceId, decision.artifactId)
        if (!source || source.status !== 'available') {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Authorized transformation input disappeared before result ingestion')
        }
        return source
      }))

      const identityHash = calculateCanonicalHash({
        schemaVersion: 'transformation-result-identity/v1',
        workspaceId: input.job.workspaceId,
        jobId: input.job.id,
        providerJobRef: result.providerJobId,
        sha256: stored.sha256,
      })
      const artifactId = `transformation-result-${identityHash.slice(0, 32)}`
      const manifestId = `transformation-manifest-${identityHash.slice(0, 32)}`
      const toolDigest = createHash('sha256').update(`${input.job.adapterId}/${input.job.adapterVersion}`).digest('hex')
      const now = (this.dependencies.clock ?? (() => new Date()))().toISOString()

      const manifest = createMediaArtifactManifestV2({
        artifactKey: stored.key,
        artifactSha256: stored.sha256,
        byteSize: stored.byteSize,
        mediaType: 'video',
        container: 'mp4',
        recipe: {
          id: 'generative-transformation-result',
          version: '1.0.0',
          parameters: {
            jobId: input.job.id,
            providerJobRef: result.providerJobId,
            adapterId: input.job.adapterId,
            adapterVersion: input.job.adapterVersion,
            transport: input.job.transport ?? 'api',
            inputHash: input.job.inputHash,
            authorizationHash: input.job.authorization.authorizationHash,
            // The brief this result exists to satisfy. Without it a stored
            // derivative could never be traced back to the editorial intent
            // that authorised paying for it.
            ...(input.job.transformation
              ? {
                  briefId: input.job.transformation.briefId,
                  briefHash: input.job.transformation.briefHash,
                  selectionId: input.job.transformation.selectionId,
                  selectionHash: input.job.transformation.selectionHash,
                }
              : {}),
          },
        },
        sources: sources.map((source) => ({
          artifactKey: source.artifactKey,
          sha256: source.sha256,
          role: 'transformation-source',
          execution: {
            tool: { id: input.job.adapterId, version: input.job.adapterVersion, digest: toolDigest },
            model: {
              provider: input.job.transformation?.providerId ?? input.job.adapterId,
              id: input.job.transformation?.capabilityId ?? input.job.operation,
              version: input.job.adapterVersion,
              config: { operation: input.job.operation, inputHash: input.job.inputHash },
            },
          },
        })),
        probe: { width: probe.width, height: probe.height, duration: probe.duration, fps: probe.fps },
      })

      await this.dependencies.artifacts.persistOrReplay({
        workspaceId: input.job.workspaceId,
        artifactId,
        manifestId,
        lineageIds: sources.map((source, index) => `lineage-${calculateCanonicalHash({ manifestId, artifactId: source.id, index })}`),
        manifest,
        createdAt: now,
      })

      await this.dependencies.resultArtifacts.persistOrReplay({
        records: [{
          id: `provider-result-artifact-${identityHash.slice(0, 24)}-video`,
          workspaceId: input.job.workspaceId,
          projectId: input.job.projectId,
          jobId: input.job.id,
          schemaVersion: PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION,
          providerJobRef: result.providerJobId,
          adapterId: input.job.adapterId,
          adapterVersion: input.job.adapterVersion,
          adapterConfigHash: input.job.inputHash,
          inputHash: input.job.inputHash,
          authorizationHash: input.job.authorization.authorizationHash,
          role: 'primary-video',
          artifactId,
          artifactSha256: stored.sha256,
          byteSize: stored.byteSize,
          mediaType: 'video',
          container: 'mp4',
          ...(result.observedCost
            ? { observedCostCurrency: result.observedCost.currency, observedCostMinorUnits: result.observedCost.costMinorUnits }
            : {}),
          completedAt: now,
          createdAt: now,
        }],
      })

      return Object.freeze({
        artifactId,
        artifactSha256: stored.sha256,
        mediaType: 'video' as const,
        byteSize: stored.byteSize,
      })
    } finally {
      // The work directory has an owner and dies with the call, whatever
      // happened inside it.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
