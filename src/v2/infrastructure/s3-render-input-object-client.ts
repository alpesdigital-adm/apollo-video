import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { DomainError } from '../domain/errors.ts'

const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION = /^[a-z0-9][a-z0-9-]{1,62}$/

export interface S3RenderInputObjectClient {
  resolve(input: {
    artifactKey: string
    sha256: string
    byteSize: number
    validUntil: string
  }): Promise<Readonly<{ uri: string; sha256: string; byteSize: number }>>
}

export interface S3RenderInputObjectClientOptions {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  forcePathStyle: boolean
  signedUrlTtlSeconds: number
  allowInsecureHttp?: boolean
  clock?: () => Date
  client?: S3Client
  presign?: typeof getSignedUrl
}

function endpoint(value: string, allowInsecureHttp: boolean): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 endpoint is invalid')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  const isolatedService = /^[a-z0-9][a-z0-9-]{0,62}$/.test(parsed.hostname)
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    (parsed.protocol === 'http:' && !loopback && !(allowInsecureHttp && isolatedService)) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    !['', '/'].includes(parsed.pathname)
  ) {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 endpoint is not allowed')
  }
  return parsed.origin
}

function required(value: string, field: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', `${field} is invalid`)
  }
  return normalized
}

export class AwsS3RenderInputObjectClient implements S3RenderInputObjectClient {
  private readonly bucket: string
  private readonly signedUrlTtlSeconds: number
  private readonly client: S3Client
  private readonly presign: typeof getSignedUrl
  private readonly clock: () => Date

  constructor(options: S3RenderInputObjectClientOptions) {
    const configuredEndpoint = endpoint(options.endpoint, options.allowInsecureHttp === true)
    const region = required(options.region, 'S3 region', 63)
    const bucket = required(options.bucket, 'S3 bucket', 63)
    const accessKeyId = required(options.accessKeyId, 'S3 access key id', 256)
    const secretAccessKey = required(options.secretAccessKey, 'S3 secret access key', 1024)
    if (!REGION.test(region) || !BUCKET.test(bucket)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 region or bucket is invalid')
    }
    if (!Number.isSafeInteger(options.signedUrlTtlSeconds) || options.signedUrlTtlSeconds < 30 || options.signedUrlTtlSeconds > 300) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 signed URL TTL must be between 30 and 300 seconds')
    }
    const credentials = {
      accessKeyId,
      secretAccessKey,
      ...(options.sessionToken ? { sessionToken: required(options.sessionToken, 'S3 session token', 8192) } : {}),
    }
    const config: S3ClientConfig = {
      endpoint: configuredEndpoint,
      region,
      forcePathStyle: options.forcePathStyle,
      credentials,
      maxAttempts: 2,
    }
    this.bucket = bucket
    this.signedUrlTtlSeconds = options.signedUrlTtlSeconds
    this.client = options.client ?? new S3Client(config)
    this.presign = options.presign ?? getSignedUrl
    this.clock = options.clock ?? (() => new Date())
  }

  private remainingLifetimeSeconds(validUntilValue: string): number {
    const now = this.clock()
    const validUntil = new Date(validUntilValue)
    const remainingSeconds = Math.floor((validUntil.getTime() - now.getTime()) / 1_000)
    if (Number.isNaN(now.getTime()) || Number.isNaN(validUntil.getTime()) || remainingSeconds < 1) {
      throw new DomainError(
        'MATERIALIZATION_AUTHORIZATION_EXPIRED',
        'Materialization authorization expired before the S3 URL could be signed',
      )
    }
    return remainingSeconds
  }

  async resolve(input: { artifactKey: string; sha256: string; byteSize: number; validUntil: string }) {
    this.remainingLifetimeSeconds(input.validUntil)
    let head
    try {
      head = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: input.artifactKey,
        ChecksumMode: 'ENABLED',
      }))
    } catch {
      throw new DomainError(
        'MATERIALIZATION_REVALIDATION_FAILED',
        'S3 render asset could not be inspected',
        { reasonCode: 'ASSET_BYTES_NOT_FOUND' },
      )
    }
    const expectedChecksum = Buffer.from(input.sha256, 'hex').toString('base64')
    const metadataChecksum = head.Metadata?.['apollo-sha256']?.trim().toLowerCase()
    if (
      head.ContentLength !== input.byteSize ||
      (head.ChecksumSHA256 !== expectedChecksum && metadataChecksum !== input.sha256) ||
      !head.VersionId || head.VersionId === 'null'
    ) {
      throw new DomainError(
        'MATERIALIZATION_REVALIDATION_FAILED',
        'S3 render asset does not match its immutable identity',
        { reasonCode: 'ASSET_CONTENT_MISMATCH' },
      )
    }
    let uri: string
    try {
      const remainingSeconds = this.remainingLifetimeSeconds(input.validUntil)
      uri = await this.presign(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: input.artifactKey, VersionId: head.VersionId }),
        { expiresIn: Math.min(this.signedUrlTtlSeconds, remainingSeconds) },
      )
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError(
        'MATERIALIZATION_REVALIDATION_FAILED',
        'S3 render asset URL could not be signed',
        { reasonCode: 'STORAGE_READ_FAILED' },
      )
    }
    return Object.freeze({ uri, sha256: input.sha256, byteSize: input.byteSize })
  }
}
