import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { MediaUploadContentStorage, MediaUploadVerifier } from '../../application/ports/media-transfer-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import type { MediaUpload, MediaUploadPart } from '../../domain/media-transfer.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'

const MIME_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Media storage path escaped its configured root')
  }
}

function extensionFor(upload: MediaUpload): string {
  const extension = MIME_EXTENSION[upload.mimeType]
  if (!extension) throw new DomainError('INVALID_ARGUMENT', 'Uploaded media MIME is not supported by local storage')
  return extension
}

function workspaceNamespace(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 32)
}

export class LocalMediaUploadStorage implements MediaUploadContentStorage, MediaUploadVerifier {
  readonly root: string

  constructor(root: string) {
    const resolved = resolve(root.trim())
    if (!root.trim() || !isAbsolute(resolved)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Local media storage root must be absolute')
    }
    this.root = normalize(resolved)
  }

  private uploadDirectory(uploadId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new DomainError('INVALID_ARGUMENT', 'uploadId is invalid')
    const directory = join(this.root, '.uploads', uploadId)
    assertContained(this.root, directory)
    return directory
  }

  private contentPath(uploadId: string, mode: 'single' | 'multipart', partNumber?: number): string {
    const directory = this.uploadDirectory(uploadId)
    if (mode === 'single') return join(directory, 'content')
    if (!Number.isInteger(partNumber) || (partNumber as number) < 1 || (partNumber as number) > 10_000) {
      throw new DomainError('INVALID_ARGUMENT', 'partNumber is invalid')
    }
    return join(directory, `part-${String(partNumber).padStart(5, '0')}`)
  }

  private expectedPartSize(upload: MediaUpload, mode: 'single' | 'multipart', partNumber?: number): bigint {
    if (mode === 'single') return BigInt(upload.byteSize)
    if (!upload.partSize || !partNumber) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Multipart session is incomplete')
    const total = BigInt(upload.byteSize)
    const partSize = BigInt(upload.partSize)
    const partCount = Number((total + partSize - BigInt(1)) / partSize)
    if (partNumber > partCount) throw new DomainError('INVALID_ARGUMENT', 'partNumber exceeds upload size')
    return partNumber === partCount ? total - partSize * BigInt(partCount - 1) : partSize
  }

  async write(input: {
    upload: Readonly<MediaUpload>
    mode: 'single' | 'multipart'
    partNumber?: number
    body: ReadableStream<Uint8Array>
    contentLength?: number
  }) {
    if (input.upload.sessionMode !== input.mode || input.upload.status !== 'uploading') {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload session does not match the active intent')
    }
    const expectedSize = this.expectedPartSize(input.upload, input.mode, input.partNumber)
    if (input.contentLength !== undefined && BigInt(input.contentLength) !== expectedSize) {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded content length does not match the signed part')
    }
    const target = this.contentPath(input.upload.id, input.mode, input.partNumber)
    const directory = this.uploadDirectory(input.upload.id)
    await mkdir(directory, { recursive: true })
    const staged = `${target}.${process.pid}.${Date.now()}.partial`
    const hash = createHash('sha256')
    let byteSize = BigInt(0)
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += BigInt(chunk.length)
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(input.body as never), meter, createWriteStream(staged, { flags: 'wx' }))
      if (byteSize !== expectedSize) {
        throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded bytes do not match the signed part size')
      }
      const checksum = hash.digest('hex')
      await rm(target, { force: true })
      await rename(staged, target)
      return Object.freeze({
        byteSize: byteSize.toString(),
        checksum,
        etag: `"${Buffer.from(checksum, 'hex').toString('base64url')}"`,
      })
    } catch (error) {
      await rm(staged, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async discard(uploadId: string): Promise<void> {
    await rm(this.uploadDirectory(uploadId), { recursive: true, force: true })
  }

  private async assembleMultipart(upload: MediaUpload, parts: readonly Readonly<MediaUploadPart>[]): Promise<string> {
    const directory = this.uploadDirectory(upload.id)
    await mkdir(directory, { recursive: true })
    const target = join(directory, 'assembled')
    const staged = `${target}.${process.pid}.${Date.now()}.partial`
    await rm(staged, { force: true })
    const output = createWriteStream(staged, { flags: 'wx' })
    try {
      for (const receipt of parts) {
        const partPath = this.contentPath(upload.id, 'multipart', receipt.partNumber)
        const metadata = await stat(partPath)
        if (!metadata.isFile() || metadata.size.toString() !== receipt.byteSize || await calculateFileSha256(partPath) !== receipt.checksum) {
          throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Stored multipart part does not match its receipt')
        }
        for await (const chunk of createReadStream(partPath)) {
          if (!output.write(chunk)) await new Promise<void>((resolveDrain, rejectDrain) => {
            output.once('drain', resolveDrain)
            output.once('error', rejectDrain)
          })
        }
      }
      await new Promise<void>((resolveEnd, rejectEnd) => {
        output.end(resolveEnd)
        output.once('error', rejectEnd)
      })
      await rm(target, { force: true })
      await rename(staged, target)
      return target
    } catch (error) {
      output.destroy()
      await rm(staged, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async verifiedSourcePath(upload: Readonly<MediaUpload>, parts: readonly Readonly<MediaUploadPart>[] = []): Promise<string> {
    const path = upload.sessionMode === 'multipart'
      ? await this.assembleMultipart(upload, parts)
      : this.contentPath(upload.id, 'single')
    const metadata = await stat(path).catch(() => null)
    if (!metadata?.isFile()) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded media bytes are missing')
    return path
  }

  async verify({ upload, parts }: { upload: Readonly<MediaUpload>; parts: readonly Readonly<MediaUploadPart>[] }) {
    const source = await this.verifiedSourcePath(upload, parts)
    const metadata = await stat(source)
    return Object.freeze({
      byteSize: metadata.size.toString(),
      mimeType: upload.mimeType,
      sha256: await calculateFileSha256(source),
    })
  }

  async promoteMaster(upload: Readonly<MediaUpload>, parts: readonly Readonly<MediaUploadPart>[] = []) {
    if (upload.status !== 'verified' || upload.actualSha256 !== upload.expectedSha256) {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Only verified media can become a master artifact')
    }
    const source = await this.verifiedSourcePath(upload, parts)
    return this.promote({
      workspaceId: upload.workspaceId,
      sourcePath: source,
      sha256: upload.actualSha256,
      extension: extensionFor(upload),
      prefix: 'masters',
    })
  }

  async promoteDerived(input: { workspaceId: string; sourcePath: string; sha256: string; extension: string; prefix: string }) {
    return this.promote(input)
  }

  private async promote(input: { workspaceId: string; sourcePath: string; sha256: string; extension: string; prefix: string }) {
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.prefix) || !/^[a-z0-9]{2,8}$/.test(input.extension)) {
      throw new DomainError('INVALID_ARGUMENT', 'Artifact storage identity is invalid')
    }
    const key = `workspaces/${workspaceNamespace(input.workspaceId)}/${input.prefix}/sha256/${input.sha256.slice(0, 2)}/${input.sha256}.${input.extension}`
    const target = join(this.root, ...key.split('/'))
    assertContained(this.root, target)
    await mkdir(join(target, '..'), { recursive: true })
    const existing = await stat(target).catch(() => null)
    if (!existing) {
      try {
        await copyFile(input.sourcePath, target, 1)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const metadata = await stat(target)
    if (!metadata.isFile() || await calculateFileSha256(target) !== input.sha256) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Content-addressed artifact failed integrity verification')
    }
    return Object.freeze({ key, path: target, byteSize: metadata.size, sha256: input.sha256 })
  }
}

export function createLocalMediaUploadStorageFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!root) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Local media storage is not configured')
  return new LocalMediaUploadStorage(root)
}
