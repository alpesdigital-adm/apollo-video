import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isAbsolute, join, normalize, resolve } from 'node:path'

import type { MediaArtifactPersistenceRepository } from '../application/ports/media-artifact-repository.ts'
import type { MediaArtifactQueryRepository } from '../application/ports/media-artifact-query-repository.ts'
import type { MediaSourceProber, VerifiedMediaStorage } from '../application/ports/media-ingest.ts'
import type { ProviderResultCritic, ProviderResultIngestor } from '../application/ports/provider-job-runtime.ts'
import {
  PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION,
  type ProviderResultArtifactRepository,
} from '../application/ports/provider-result-artifact-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import type { ProviderJob } from '../domain/provider-job.ts'
import { validateWebhookResolution } from '../domain/webhook-network.ts'

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const TOOL_DIGEST = createHash('sha256').update('heygen-v3-provider-result/1.0.0').digest('hex')

export interface ProviderResultDownloader {
  download(input: { operationId: string; url: string; signal?: AbortSignal }): Promise<Readonly<{ path: string; sha256: string; byteSize: number }>>
  cleanup(operationId: string): Promise<void>
}

export class SafeProviderResultDownloader implements ProviderResultDownloader {
  private readonly workRoot: string
  private readonly allowedHosts: ReadonlySet<string>
  private readonly maxBytes: number
  private readonly timeoutMs: number

  constructor(input: { workRoot: string; allowedHosts: readonly string[]; maxBytes?: number; timeoutMs?: number }) {
    const workRoot = normalize(resolve(input.workRoot.trim()))
    assertDomain(input.workRoot.trim().length > 0 && isAbsolute(workRoot), 'PERSISTENCE_NOT_CONFIGURED', 'Provider result work root is invalid')
    const allowedHosts = input.allowedHosts.map((host) => host.trim().toLowerCase())
    assertDomain(allowedHosts.length > 0 && allowedHosts.every((host) => /^[a-z0-9.-]+$/.test(host) && !host.startsWith('.') && !host.endsWith('.')), 'PERSISTENCE_NOT_CONFIGURED', 'Provider result host allowlist is invalid')
    this.maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    assertDomain(Number.isSafeInteger(this.maxBytes) && this.maxBytes > 0 && this.maxBytes <= DEFAULT_MAX_BYTES, 'PERSISTENCE_NOT_CONFIGURED', 'Provider result byte limit is invalid')
    assertDomain(Number.isSafeInteger(this.timeoutMs) && this.timeoutMs >= 1_000 && this.timeoutMs <= 10 * 60_000, 'PERSISTENCE_NOT_CONFIGURED', 'Provider result timeout is invalid')
    this.workRoot = workRoot
    this.allowedHosts = new Set(allowedHosts)
  }

  async download(input: { operationId: string; url: string; signal?: AbortSignal }) {
    let url: URL
    try { url = new URL(input.url) } catch { throw new DomainError('RENDER_OUTPUT_INVALID', 'Provider result URL is invalid') }
    assertDomain(url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.hash && this.allowedHosts.has(url.hostname.toLowerCase()), 'RENDER_OUTPUT_INVALID', 'Provider result URL is not allowed')
    const records = await lookup(url.hostname, { all: true, verbatim: true })
    const addresses = validateWebhookResolution(records.map((record) => {
      assertDomain(record.family === 4 || record.family === 6, 'RENDER_OUTPUT_INVALID', 'Provider result DNS family is invalid')
      return { address: record.address, family: record.family }
    }))
    const namespace = createHash('sha256').update(input.operationId).digest('hex').slice(0, 32)
    const directory = join(this.workRoot, namespace)
    const target = join(directory, `${randomUUID()}.mp4`)
    await mkdir(directory, { recursive: true })
    try {
      return await this.downloadPinned(url, addresses[0]!, target, input.signal)
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      if (error instanceof DomainError) throw error
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Provider result download failed')
    }
  }

  async cleanup(operationId: string): Promise<void> {
    const namespace = createHash('sha256').update(operationId).digest('hex').slice(0, 32)
    await rm(join(this.workRoot, namespace), { recursive: true, force: true })
  }

  private downloadPinned(url: URL, address: Readonly<{ address: string; family: 4 | 6 }>, target: string, signal?: AbortSignal): Promise<Readonly<{ path: string; sha256: string; byteSize: number }>> {
    return new Promise((resolvePromise, reject) => {
      let settled = false
      const abort = () => request.destroy(new Error('provider-result-aborted'))
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      const request = httpsRequest({
        protocol: 'https:', hostname: url.hostname, port: 443, method: 'GET', path: `${url.pathname}${url.search}`,
        servername: url.hostname, minVersion: 'TLSv1.2', rejectUnauthorized: true, agent: false,
        headers: { accept: 'video/mp4', 'user-agent': 'Apollo-Video-Provider-Result/1.0' },
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      }, (response) => {
        if (response.statusCode !== 200 || !/^video\/mp4(?:\s*;|$)/i.test(String(response.headers['content-type'] ?? ''))) {
          response.resume()
          fail(new DomainError('RENDER_OUTPUT_INVALID', 'Provider result response is not an MP4'))
          return
        }
        const declared = Number(response.headers['content-length'])
        if (Number.isFinite(declared) && (declared <= 0 || declared > this.maxBytes)) {
          response.resume()
          fail(new DomainError('RENDER_OUTPUT_INVALID', 'Provider result declared size is invalid'))
          return
        }
        const output = createWriteStream(target, { flags: 'wx' })
        const digest = createHash('sha256')
        let byteSize = 0
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          byteSize += bytes.length
          if (byteSize > this.maxBytes) {
            response.destroy(new Error('provider-result-too-large'))
            output.destroy()
            return
          }
          digest.update(bytes)
        })
        response.on('error', fail)
        output.on('error', fail)
        output.on('finish', async () => {
          if (settled) return
          try {
            const metadata = await stat(target)
            assertDomain(byteSize > 0 && metadata.isFile() && metadata.size === byteSize, 'RENDER_OUTPUT_INVALID', 'Provider result bytes are incomplete')
            settled = true
            clearTimeout(deadline)
            signal?.removeEventListener('abort', abort)
            resolvePromise(Object.freeze({ path: target, sha256: digest.digest('hex'), byteSize }))
          } catch (error) { fail(error) }
        })
        response.pipe(output)
      })
      const deadline = setTimeout(() => request.destroy(new Error('provider-result-deadline')), this.timeoutMs)
      deadline.unref()
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error('provider-result-timeout')))
      request.on('error', fail)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      request.end()
    })
  }
}

function providerResult(value: unknown): Readonly<{ providerJobId: string; downloadUrl: string; mediaType: 'video' }> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'RENDER_OUTPUT_INVALID', 'Provider result is invalid')
  const record = value as Record<string, unknown>
  assertDomain(Object.keys(record).toSorted().join(',') === 'downloadUrl,mediaType,providerJobId' && typeof record.providerJobId === 'string' && typeof record.downloadUrl === 'string' && record.mediaType === 'video', 'RENDER_OUTPUT_INVALID', 'Provider result is invalid')
  return record as { providerJobId: string; downloadUrl: string; mediaType: 'video' }
}

export class VerifiedProviderResultIngestor implements ProviderResultIngestor {
  private readonly dependencies: {
    downloader: ProviderResultDownloader
    storage: VerifiedMediaStorage
    artifacts: MediaArtifactPersistenceRepository
    artifactQuery: MediaArtifactQueryRepository
    prober: MediaSourceProber
    clock?: () => Date
  }

  constructor(dependencies: VerifiedProviderResultIngestor['dependencies']) {
    this.dependencies = dependencies
  }

  async ingest(input: { job: Readonly<ProviderJob>; providerResult: unknown; signal?: AbortSignal }) {
    const result = providerResult(input.providerResult)
    assertDomain(result.providerJobId === input.job.providerJobId, 'PERSISTENCE_CONFLICT', 'Provider result identity does not match the durable job')
    try {
      const downloaded = await this.dependencies.downloader.download({ operationId: input.job.id, url: result.downloadUrl, signal: input.signal })
      const probe = await this.dependencies.prober.probe(downloaded.path, { signal: input.signal })
      const stored = await this.dependencies.storage.promoteDerived({ workspaceId: input.job.workspaceId, sourcePath: downloaded.path, sha256: downloaded.sha256, extension: 'mp4', prefix: 'synthetic-provider-results' })
      assertDomain(stored.sha256 === downloaded.sha256 && stored.byteSize === downloaded.byteSize, 'PERSISTENCE_CONFLICT', 'Provider result storage identity drifted')
      const sources = await Promise.all(input.job.authorization.artifactDecisions.map(async (decision) => {
        const source = await this.dependencies.artifactQuery.findById(input.job.workspaceId, decision.artifactId)
        if (!source || source.status !== 'available') throw new DomainError('PERSISTENCE_CONFLICT', 'Authorized provider input disappeared before result ingestion')
        return source
      }))
      const identityHash = calculateCanonicalHash({ schemaVersion: 'provider-result-identity/v1', workspaceId: input.job.workspaceId, jobId: input.job.id, providerJobId: result.providerJobId, sha256: stored.sha256 })
      const artifactId = `provider-result-${identityHash.slice(0, 32)}`
      const manifestId = `provider-manifest-${identityHash.slice(0, 32)}`
      const manifest = createMediaArtifactManifestV2({
        artifactKey: stored.key, artifactSha256: stored.sha256, byteSize: stored.byteSize, mediaType: 'video', container: 'mp4',
        recipe: { id: 'synthetic-provider-result', version: '1.0.0', parameters: { jobId: input.job.id, providerJobId: result.providerJobId, adapterId: input.job.adapterId, adapterVersion: input.job.adapterVersion, inputHash: input.job.inputHash, authorizationHash: input.job.authorization.authorizationHash } },
        sources: sources.map((source) => ({ artifactKey: source.artifactKey, sha256: source.sha256, role: 'provider-authorized-input', execution: { tool: { id: 'heygen', version: 'v3', digest: TOOL_DIGEST }, model: { provider: 'heygen', id: `job-${identityHash.slice(0, 32)}`, version: input.job.adapterVersion, config: { operation: input.job.operation, profileSnapshotHash: input.job.authorization.profileSnapshotHash } } } })),
        probe: { width: probe.width, height: probe.height, duration: probe.duration, fps: probe.fps },
      })
      await this.dependencies.artifacts.persistOrReplay({
        workspaceId: input.job.workspaceId, artifactId, manifestId,
        lineageIds: sources.map((source, index) => `lineage-${calculateCanonicalHash({ manifestId, artifactId: source.id, index })}`),
        manifest, createdAt: (this.dependencies.clock ?? (() => new Date()))().toISOString(),
      })
      return Object.freeze({ artifactId, artifactSha256: stored.sha256, mediaType: 'video' as const, byteSize: stored.byteSize })
    } finally {
      await this.dependencies.downloader.cleanup(input.job.id)
    }
  }
}

const TTS_TOOL_DIGEST = createHash('sha256').update('elevenlabs-tts-provider-result/1.0.0').digest('hex')
const HASH = /^[a-f0-9]{64}$/

function ttsProviderResult(value: unknown): Readonly<{
  requestId: string
  modelId: string
  adapterConfigHash: string
  scriptHash: string
  audioBytes: Uint8Array
  audioSha256: string
  audioByteSize: number
  audioContainer: 'mp3' | 'wav'
  mediaType: 'audio'
  alignment: Readonly<{ characters: readonly string[]; startTimesSeconds: readonly number[]; endTimesSeconds: readonly number[] }>
}> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'RENDER_OUTPUT_INVALID', 'TTS provider result is invalid')
  const record = value as Record<string, unknown>
  assertDomain(
    typeof record.requestId === 'string' && typeof record.modelId === 'string' &&
    typeof record.adapterConfigHash === 'string' && HASH.test(record.adapterConfigHash) &&
    typeof record.scriptHash === 'string' && HASH.test(record.scriptHash) &&
    record.audioBytes instanceof Uint8Array && record.audioBytes.byteLength > 0 &&
    typeof record.audioSha256 === 'string' && HASH.test(record.audioSha256) &&
    Number.isSafeInteger(record.audioByteSize) && Number(record.audioByteSize) > 0 &&
    (record.audioContainer === 'mp3' || record.audioContainer === 'wav') &&
    record.mediaType === 'audio' &&
    typeof record.alignment === 'object' && record.alignment !== null,
    'RENDER_OUTPUT_INVALID',
    'TTS provider result is invalid',
  )
  return record as ReturnType<typeof ttsProviderResult>
}

/**
 * Ingests the multi-artifact result of a synchronous TTS submission: the
 * audio bytes are re-hashed, probed with real ffprobe and promoted into
 * controlled storage; the character alignment is serialized as a
 * content-addressed evidence artifact. Both artifacts carry full provenance
 * (adapter id/version/configHash, model, providerJobRef, scriptHash) and are
 * recorded in the provider_result_artifacts ledger inside one transaction.
 */
export interface AudioDurationProber {
  probeDurationSeconds(path: string, options?: { signal?: AbortSignal }): Promise<number>
}

export class VerifiedTtsResultIngestor implements ProviderResultIngestor {
  private readonly dependencies: {
    workRoot: string
    storage: VerifiedMediaStorage
    artifacts: MediaArtifactPersistenceRepository
    artifactQuery: MediaArtifactQueryRepository
    resultArtifacts: ProviderResultArtifactRepository
    audioProber: AudioDurationProber
    clock?: () => Date
  }

  constructor(dependencies: VerifiedTtsResultIngestor['dependencies']) {
    assertDomain(isAbsolute(normalize(resolve(dependencies.workRoot.trim()))), 'PERSISTENCE_NOT_CONFIGURED', 'TTS result work root is invalid')
    this.dependencies = dependencies
  }

  async ingest(input: { job: Readonly<ProviderJob>; providerResult: unknown; signal?: AbortSignal }) {
    const result = ttsProviderResult(input.providerResult)
    assertDomain(result.requestId === input.job.providerJobId, 'PERSISTENCE_CONFLICT', 'TTS result identity does not match the durable job')
    const jobScriptHash = typeof input.job.input.scriptHash === 'string' ? input.job.input.scriptHash : undefined
    if (jobScriptHash !== undefined) {
      assertDomain(result.scriptHash === jobScriptHash, 'PERSISTENCE_CONFLICT', 'TTS result script hash does not match the approved job input')
    }
    const audioBytes = Buffer.from(result.audioBytes)
    assertDomain(
      audioBytes.byteLength === result.audioByteSize &&
      createHash('sha256').update(audioBytes).digest('hex') === result.audioSha256,
      'PERSISTENCE_CONFLICT',
      'TTS audio bytes do not match their declared identity',
    )
    const namespace = createHash('sha256').update(input.job.id).digest('hex').slice(0, 32)
    const directory = join(normalize(resolve(this.dependencies.workRoot.trim())), namespace)
    await mkdir(directory, { recursive: true })
    try {
      const audioPath = join(directory, `${randomUUID()}.${result.audioContainer}`)
      await writeFile(audioPath, audioBytes, { flag: 'wx' })
      const probedDurationSeconds = await this.dependencies.audioProber.probeDurationSeconds(audioPath, { signal: input.signal })
      assertDomain(Number.isFinite(probedDurationSeconds) && probedDurationSeconds > 0, 'RENDER_OUTPUT_INVALID', 'TTS audio has no measurable duration')
      // Bind the paid audio to its alignment: the last aligned character must
      // end inside the probed audio, within a small tolerance.
      const alignmentEndSeconds = result.alignment.endTimesSeconds.at(-1) ?? 0
      assertDomain(
        alignmentEndSeconds > 0 && Math.abs(probedDurationSeconds - alignmentEndSeconds) <= Math.max(1, probedDurationSeconds * 0.25),
        'PERSISTENCE_CONFLICT',
        'TTS alignment does not cover the probed audio duration',
      )
      const alignmentPayload = stableSerialize({
        schemaVersion: 'tts-alignment-evidence/v1',
        providerJobRef: result.requestId,
        scriptHash: result.scriptHash,
        audioSha256: result.audioSha256,
        characters: result.alignment.characters,
        startTimesSeconds: result.alignment.startTimesSeconds,
        endTimesSeconds: result.alignment.endTimesSeconds,
      })
      const alignmentBytes = Buffer.from(alignmentPayload, 'utf8')
      const alignmentSha256 = createHash('sha256').update(alignmentBytes).digest('hex')
      const alignmentPath = join(directory, `${randomUUID()}.json`)
      await writeFile(alignmentPath, alignmentBytes, { flag: 'wx' })
      const storedAudio = await this.dependencies.storage.promoteDerived({ workspaceId: input.job.workspaceId, sourcePath: audioPath, sha256: result.audioSha256, extension: result.audioContainer, prefix: 'synthetic-tts-results' })
      assertDomain(storedAudio.sha256 === result.audioSha256 && storedAudio.byteSize === result.audioByteSize, 'PERSISTENCE_CONFLICT', 'TTS audio storage identity drifted')
      const storedAlignment = await this.dependencies.storage.promoteDerived({ workspaceId: input.job.workspaceId, sourcePath: alignmentPath, sha256: alignmentSha256, extension: 'json', prefix: 'synthetic-tts-alignment' })
      assertDomain(storedAlignment.sha256 === alignmentSha256 && storedAlignment.byteSize === alignmentBytes.byteLength, 'PERSISTENCE_CONFLICT', 'TTS alignment storage identity drifted')
      const identityHash = calculateCanonicalHash({ schemaVersion: 'tts-result-identity/v1', workspaceId: input.job.workspaceId, jobId: input.job.id, providerJobRef: result.requestId, audioSha256: result.audioSha256, alignmentSha256 })
      const execution = {
        tool: { id: 'elevenlabs', version: 'v1', digest: TTS_TOOL_DIGEST },
        model: { provider: 'elevenlabs', id: result.modelId, version: input.job.adapterVersion, config: { operation: input.job.operation, adapterConfigHash: result.adapterConfigHash, scriptHash: result.scriptHash, profileSnapshotHash: input.job.authorization.profileSnapshotHash } },
      }
      const now = (this.dependencies.clock ?? (() => new Date()))().toISOString()
      const audioArtifactId = `tts-audio-${identityHash.slice(0, 32)}`
      const alignmentArtifactId = `tts-alignment-${identityHash.slice(0, 32)}`
      const audioManifest = createMediaArtifactManifestV2({
        artifactKey: storedAudio.key, artifactSha256: storedAudio.sha256, byteSize: storedAudio.byteSize, mediaType: 'audio', container: result.audioContainer,
        recipe: { id: 'synthetic-tts-result', version: '1.0.0', parameters: { jobId: input.job.id, providerJobRef: result.requestId, adapterId: input.job.adapterId, adapterVersion: input.job.adapterVersion, adapterConfigHash: result.adapterConfigHash, scriptHash: result.scriptHash, inputHash: input.job.inputHash, authorizationHash: input.job.authorization.authorizationHash, probedDurationSeconds } },
        sources: [],
      })
      const alignmentManifest = createMediaArtifactManifestV2({
        artifactKey: storedAlignment.key, artifactSha256: storedAlignment.sha256, byteSize: storedAlignment.byteSize, mediaType: 'data', container: 'json',
        recipe: { id: 'synthetic-tts-alignment', version: '1.0.0', parameters: { jobId: input.job.id, providerJobRef: result.requestId, adapterId: input.job.adapterId, adapterVersion: input.job.adapterVersion, adapterConfigHash: result.adapterConfigHash, scriptHash: result.scriptHash, audioSha256: result.audioSha256 } },
        sources: [{ artifactKey: storedAudio.key, sha256: storedAudio.sha256, role: 'tts-primary-audio', execution }],
      })
      await this.dependencies.artifacts.persistOrReplay({
        workspaceId: input.job.workspaceId, artifactId: audioArtifactId, manifestId: `tts-audio-manifest-${identityHash.slice(0, 32)}`,
        lineageIds: [], manifest: audioManifest, createdAt: now,
      })
      await this.dependencies.artifacts.persistOrReplay({
        workspaceId: input.job.workspaceId, artifactId: alignmentArtifactId, manifestId: `tts-alignment-manifest-${identityHash.slice(0, 32)}`,
        lineageIds: [`lineage-${calculateCanonicalHash({ manifestId: `tts-alignment-manifest-${identityHash.slice(0, 32)}`, artifactId: audioArtifactId, index: 0 })}`],
        manifest: alignmentManifest, createdAt: now,
      })
      const base = {
        workspaceId: input.job.workspaceId,
        projectId: input.job.projectId,
        jobId: input.job.id,
        schemaVersion: PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION,
        providerJobRef: result.requestId,
        adapterId: input.job.adapterId,
        adapterVersion: input.job.adapterVersion,
        modelRef: result.modelId,
        adapterConfigHash: result.adapterConfigHash,
        inputHash: input.job.inputHash,
        authorizationHash: input.job.authorization.authorizationHash,
        scriptHash: result.scriptHash,
        completedAt: now,
        createdAt: now,
      }
      await this.dependencies.resultArtifacts.persistOrReplay({
        records: [
          { ...base, id: `provider-result-artifact-${identityHash.slice(0, 24)}-audio`, role: 'primary-audio', artifactId: audioArtifactId, artifactSha256: storedAudio.sha256, byteSize: storedAudio.byteSize, mediaType: 'audio', container: result.audioContainer },
          { ...base, id: `provider-result-artifact-${identityHash.slice(0, 24)}-alignment`, role: 'alignment-evidence', artifactId: alignmentArtifactId, artifactSha256: storedAlignment.sha256, byteSize: storedAlignment.byteSize, mediaType: 'data', container: 'json' },
        ],
      })
      return Object.freeze({ artifactId: audioArtifactId, artifactSha256: storedAudio.sha256, mediaType: 'audio' as const, byteSize: storedAudio.byteSize })
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export class PersistedProviderResultCritic implements ProviderResultCritic {
  private readonly artifacts: MediaArtifactQueryRepository

  constructor(artifacts: MediaArtifactQueryRepository) {
    this.artifacts = artifacts
  }

  async evaluate(input: { job: Readonly<ProviderJob>; artifact: Readonly<{ artifactId: string; artifactSha256: string; mediaType: 'audio' | 'video' | 'image' | 'data'; byteSize: number }> }) {
    const persisted = await this.artifacts.findById(input.job.workspaceId, input.artifact.artifactId)
    const probe = persisted?.manifests.find((manifest) => manifest.probe)?.probe
    assertDomain(Boolean(persisted && probe) && persisted!.sha256 === input.artifact.artifactSha256 && Number(persisted!.byteSize) === input.artifact.byteSize && persisted!.mediaType === 'video', 'PERSISTENCE_CONFLICT', 'Provider critic cannot verify the persisted result')
    const expectedDurationMs = Number(input.job.input.durationMs)
    const actualDurationMs = Math.round(probe!.duration * 1_000)
    const expectedRatio = input.job.input.aspectRatio ?? '9:16'
    const actualRatio = probe!.width / probe!.height
    const ratioMatches = expectedRatio === '16:9' ? actualRatio > 1.7 && actualRatio < 1.82 : actualRatio > 0.53 && actualRatio < 0.59
    const durationMatches = Number.isSafeInteger(expectedDurationMs) && Math.abs(actualDurationMs - expectedDurationMs) <= Math.max(2_000, Math.round(expectedDurationMs * 0.05))
    const result = Object.freeze({ schemaVersion: 'provider-result-critic/v1', jobId: input.job.id, artifactId: input.artifact.artifactId, artifactSha256: input.artifact.artifactSha256, expectedDurationMs, actualDurationMs, expectedRatio, width: probe!.width, height: probe!.height, ratioMatches, durationMatches, approved: ratioMatches && durationMatches })
    return Object.freeze({ approved: result.approved, resultHash: calculateCanonicalHash(result) })
  }
}

/**
 * Approves a TTS audio result only after re-reading the persisted artifact
 * row and the provider_result_artifacts ledger: identity (sha256/byteSize/
 * mediaType) must match what the worker ingested, both roles (primary-audio
 * and alignment-evidence) must exist for this job, and the ledger's script
 * hash must equal the approved job input. Duration plausibility against the
 * alignment was already enforced at ingestion time with a real ffprobe.
 */
export class PersistedTtsResultCritic implements ProviderResultCritic {
  private readonly artifacts: MediaArtifactQueryRepository
  private readonly resultArtifacts: ProviderResultArtifactRepository

  constructor(artifacts: MediaArtifactQueryRepository, resultArtifacts: ProviderResultArtifactRepository) {
    this.artifacts = artifacts
    this.resultArtifacts = resultArtifacts
  }

  async evaluate(input: { job: Readonly<ProviderJob>; artifact: Readonly<{ artifactId: string; artifactSha256: string; mediaType: 'audio' | 'video' | 'image' | 'data'; byteSize: number }> }) {
    const persisted = await this.artifacts.findById(input.job.workspaceId, input.artifact.artifactId)
    assertDomain(Boolean(persisted) && persisted!.sha256 === input.artifact.artifactSha256 && Number(persisted!.byteSize) === input.artifact.byteSize && persisted!.mediaType === 'audio', 'PERSISTENCE_CONFLICT', 'TTS critic cannot verify the persisted audio result')
    const ledger = await this.resultArtifacts.listByJob({ workspaceId: input.job.workspaceId, projectId: input.job.projectId, jobId: input.job.id })
    const audioEntry = ledger.find((entry) => entry.role === 'primary-audio')
    const alignmentEntry = ledger.find((entry) => entry.role === 'alignment-evidence')
    assertDomain(
      audioEntry?.artifactId === input.artifact.artifactId && audioEntry.artifactSha256 === input.artifact.artifactSha256 && alignmentEntry !== undefined,
      'PERSISTENCE_CONFLICT',
      'TTS critic requires both audio and alignment ledger entries for the job',
    )
    const jobScriptHash = typeof input.job.input.scriptHash === 'string' ? input.job.input.scriptHash : undefined
    const scriptMatches = jobScriptHash === undefined || audioEntry!.scriptHash === jobScriptHash
    const result = Object.freeze({
      schemaVersion: 'tts-result-critic/v1', jobId: input.job.id, artifactId: input.artifact.artifactId,
      artifactSha256: input.artifact.artifactSha256, alignmentArtifactId: alignmentEntry!.artifactId,
      alignmentSha256: alignmentEntry!.artifactSha256, providerJobRef: audioEntry!.providerJobRef,
      scriptMatches, approved: scriptMatches,
    })
    return Object.freeze({ approved: result.approved, resultHash: calculateCanonicalHash(result) })
  }
}
