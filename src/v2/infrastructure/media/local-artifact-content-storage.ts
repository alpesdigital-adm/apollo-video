import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'

import type { ArtifactContentStorage } from '../../application/ports/artifact-content-storage.ts'
import { DomainError } from '../../domain/errors.ts'

export class LocalArtifactContentStorage implements ArtifactContentStorage {
  private readonly root: string

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
    const start = input.range?.start ?? 0
    const end = input.range?.end ?? metadata.size - 1
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
