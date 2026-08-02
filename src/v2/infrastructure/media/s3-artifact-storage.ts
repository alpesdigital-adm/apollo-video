import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

import type { ArtifactSourceMaterializer, VerifiedMediaStorage } from '../../application/ports/media-ingest.ts'
import { DomainError } from '../../domain/errors.ts'
import type { MediaUpload, MediaUploadPart } from '../../domain/media-transfer.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import {
  contentAddressedArtifactKey,
  LocalMediaUploadStorage,
} from './local-media-upload-storage.ts'

type ArtifactS3Client = Pick<S3Client, 'send'>

interface S3ArtifactStorageOptions {
  bucket: string
  client: ArtifactS3Client
}

function assertKey(key: string): void {
  if (key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Artifact key is invalid')
  }
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('PERSISTENCE_CONFLICT', 'Artifact work path escaped its root')
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? ''
  if (!normalized) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', `${name} is not configured`)
  return normalized
}

function extensionFor(upload: Readonly<MediaUpload>): string {
  const extension = new Map([
    ['video/mp4', 'mp4'], ['video/quicktime', 'mov'], ['video/webm', 'webm'],
    ['audio/mpeg', 'mp3'], ['audio/mp4', 'm4a'], ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'], ['audio/flac', 'flac'], ['image/jpeg', 'jpg'],
    ['image/png', 'png'], ['image/webp', 'webp'],
  ]).get(upload.mimeType)
  if (!extension) throw new DomainError('INVALID_ARGUMENT', 'Uploaded media MIME is not supported by S3 storage')
  return extension
}

async function verifyHead(input: {
  client: ArtifactS3Client
  bucket: string
  key: string
  versionId: string
  sha256: string
  byteSize: number
}): Promise<void> {
  const head = await input.client.send(new HeadObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    VersionId: input.versionId,
    ChecksumMode: 'ENABLED',
  }))
  const checksum = Buffer.from(input.sha256, 'hex').toString('base64')
  if (
    head.VersionId !== input.versionId || head.ContentLength !== input.byteSize ||
    (head.ChecksumSHA256 !== checksum && head.Metadata?.['apollo-sha256']?.toLowerCase() !== input.sha256)
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'S3 artifact failed immutable identity verification')
}

export class S3VerifiedMediaStorage implements VerifiedMediaStorage {
  private readonly staging: LocalMediaUploadStorage
  private readonly bucket: string
  private readonly client: ArtifactS3Client

  constructor(staging: LocalMediaUploadStorage, options: S3ArtifactStorageOptions) {
    this.staging = staging
    this.bucket = options.bucket
    this.client = options.client
  }

  async promoteMaster(upload: Readonly<MediaUpload>, parts: readonly Readonly<MediaUploadPart>[] = []) {
    if (upload.status !== 'verified' || upload.actualSha256 !== upload.expectedSha256) {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Only verified media can become a master artifact')
    }
    const sourcePath = await this.staging.verifiedSourcePath(upload, parts)
    return this.promote({
      workspaceId: upload.workspaceId,
      sourcePath,
      sha256: upload.actualSha256,
      extension: extensionFor(upload),
      prefix: 'masters',
    })
  }

  async promoteDerived(input: { workspaceId: string; sourcePath: string; sha256: string; extension: string; prefix: string }) {
    return this.promote(input)
  }

  private async promote(input: { workspaceId: string; sourcePath: string; sha256: string; extension: string; prefix: string }) {
    const key = contentAddressedArtifactKey(input)
    const metadata = await stat(input.sourcePath).catch(() => null)
    if (!metadata?.isFile() || metadata.size <= 0 || await calculateFileSha256(input.sourcePath) !== input.sha256) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Promoted artifact source does not match its immutable identity')
    }
    let uploaded
    try {
      uploaded = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(input.sourcePath),
        ContentLength: metadata.size,
        ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
        Metadata: { 'apollo-sha256': input.sha256 },
      }))
    } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', 'S3 artifact promotion failed')
    }
    if (!uploaded.VersionId || uploaded.VersionId === 'null') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'S3 bucket versioning is required for artifact promotion')
    }
    await verifyHead({ client: this.client, bucket: this.bucket, key, versionId: uploaded.VersionId, sha256: input.sha256, byteSize: metadata.size })
    return Object.freeze({ key, path: input.sourcePath, byteSize: metadata.size, sha256: input.sha256 })
  }
}

function nodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body
  if (body && typeof body === 'object' && 'transformToWebStream' in body && typeof body.transformToWebStream === 'function') {
    return Readable.fromWeb(body.transformToWebStream() as never)
  }
  throw new DomainError('PERSISTENCE_CONFLICT', 'S3 artifact body is not readable')
}

export class S3ArtifactSourceMaterializer implements ArtifactSourceMaterializer {
  private readonly workRoot: string
  private readonly bucket: string
  private readonly client: ArtifactS3Client

  constructor(workRoot: string, options: S3ArtifactStorageOptions) {
    const resolved = resolve(workRoot.trim())
    if (!workRoot.trim() || !isAbsolute(resolved)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 artifact work root must be absolute')
    this.workRoot = normalize(resolved)
    this.bucket = options.bucket
    this.client = options.client
  }

  async materialize(input: { operationId: string; artifactKey: string; sha256: string; byteSize: number }) {
    assertKey(input.artifactKey)
    if (!input.operationId.trim() || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
      throw new DomainError('INVALID_ARGUMENT', 'Artifact materialization identity is invalid')
    }
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: input.artifactKey, ChecksumMode: 'ENABLED' }))
    if (!head.VersionId || head.VersionId === 'null') throw new DomainError('PERSISTENCE_CONFLICT', 'S3 artifact is not version-bound')
    await verifyHead({ client: this.client, bucket: this.bucket, key: input.artifactKey, versionId: head.VersionId, sha256: input.sha256, byteSize: input.byteSize })
    const operationNamespace = createHash('sha256').update(input.operationId).digest('hex').slice(0, 32)
    const directory = join(this.workRoot, operationNamespace)
    const target = join(directory, `${input.sha256}-${basename(input.artifactKey)}`)
    assertContained(this.workRoot, target)
    await mkdir(directory, { recursive: true })
    const staged = `${target}.${process.pid}.partial`
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: input.artifactKey, VersionId: head.VersionId }))
      await pipeline(nodeReadable(object.Body), createWriteStream(staged, { flags: 'wx' }))
      const metadata = await stat(staged)
      if (!metadata.isFile() || metadata.size !== input.byteSize || await calculateFileSha256(staged) !== input.sha256) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Materialized S3 artifact does not match its immutable identity')
      }
      await rm(target, { force: true })
      await rename(staged, target)
      return Object.freeze({ path: target, sha256: input.sha256, byteSize: input.byteSize })
    } catch (error) {
      await rm(staged, { force: true }).catch(() => undefined)
      if (error instanceof DomainError) throw error
      throw new DomainError('PERSISTENCE_CONFLICT', 'S3 artifact materialization failed')
    }
  }

  async cleanup(operationId: string): Promise<void> {
    const operationNamespace = createHash('sha256').update(operationId).digest('hex').slice(0, 32)
    const directory = join(this.workRoot, operationNamespace)
    assertContained(this.workRoot, directory)
    await rm(directory, { recursive: true, force: true })
  }
}

export function createArtifactS3ClientFromEnvironment(environment: NodeJS.ProcessEnv = process.env): { bucket: string; client: S3Client } {
  const endpointValue = required(environment.APOLLO_V2_S3_ENDPOINT, 'S3 endpoint')
  let parsed: URL
  try { parsed = new URL(endpointValue) } catch { throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 endpoint is invalid') }
  const allowInsecure = environment.APOLLO_V2_S3_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === 'true'
  if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !allowInsecure) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 endpoint is not allowed')
  }
  const forcePathStyle = environment.APOLLO_V2_S3_FORCE_PATH_STYLE?.trim().toLowerCase()
  if (forcePathStyle && !['true', 'false'].includes(forcePathStyle)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 path style setting is invalid')
  const config: S3ClientConfig = {
    endpoint: parsed.origin,
    region: required(environment.APOLLO_V2_S3_REGION, 'S3 region'),
    forcePathStyle: forcePathStyle !== 'false',
    credentials: {
      accessKeyId: required(environment.APOLLO_V2_S3_ACCESS_KEY_ID, 'S3 access key id'),
      secretAccessKey: required(environment.APOLLO_V2_S3_SECRET_ACCESS_KEY, 'S3 secret access key'),
      ...(environment.APOLLO_V2_S3_SESSION_TOKEN?.trim() ? { sessionToken: environment.APOLLO_V2_S3_SESSION_TOKEN.trim() } : {}),
    },
    maxAttempts: 2,
  }
  return { bucket: required(environment.APOLLO_V2_S3_BUCKET, 'S3 bucket'), client: new S3Client(config) }
}
