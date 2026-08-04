import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'

import type { ArtifactContentStorage } from '../../application/ports/artifact-content-storage.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'

export class LocalArtifactContentStorage implements ArtifactContentStorage {
  private readonly root: string
  private readonly verified = new Map<string, Readonly<{
    byteSize: number
    modifiedAtMs: number
    sha256: string
  }>>()

  constructor(root: string) {
    this.root = normalize(resolve(root.trim()))
    if (!root.trim() || !isAbsolute(this.root)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Local artifact storage root must be absolute')
  }

  async open(input: Parameters<ArtifactContentStorage['open']>[0]) {
    if (!input.artifactKey || input.artifactKey.includes('\\')) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored artifact key is invalid')
    const path = normalize(join(this.root, ...input.artifactKey.split('/')))
    const rel = relative(this.root, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored artifact key escaped its storage root')
    const metadata = await stat(path).catch(() => null)
    if (!metadata?.isFile() || BigInt(metadata.size) !== input.expectedByteSize) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact bytes were not found')
    if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored media artifact checksum is invalid')
    }
    const cached = this.verified.get(path)
    if (
      !cached || cached.byteSize !== metadata.size ||
      cached.modifiedAtMs !== metadata.mtimeMs || cached.sha256 !== input.expectedSha256
    ) {
      if (await calculateFileSha256(path) !== input.expectedSha256) {
        this.verified.delete(path)
        throw new DomainError('PERSISTENCE_CONFLICT', 'Local media artifact failed immutable identity verification')
      }
      this.verified.set(path, Object.freeze({
        byteSize: metadata.size,
        modifiedAtMs: metadata.mtimeMs,
        sha256: input.expectedSha256,
      }))
    }
    const start = input.range?.start ?? 0
    const end = input.range?.end ?? metadata.size - 1
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end >= metadata.size
    ) throw new DomainError('MEDIA_RANGE_NOT_SATISFIABLE', 'Requested local media byte range cannot be satisfied')
    const stream = createReadStream(path, { start, end })
    return Object.freeze({
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      byteSize: end - start + 1,
      start,
      end,
    })
  }
}

export function createLocalArtifactContentStorageFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!root) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Local artifact storage is not configured')
  return new LocalArtifactContentStorage(root)
}
