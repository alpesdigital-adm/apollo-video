import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'

/**
 * Pinned inventory of the private Python package root (OpenVINO, OpenCV, NumPy) the face detector imports.
 *
 * The manifest lists every file with its SHA-256 and size; its own SHA-256 is pinned by configuration. A full
 * verification hashes every listed file and refuses any unlisted file or link. A quick verification compares size and
 * modification time with the fingerprint taken at the last full verification, so the per-operation cost stays small
 * while a swapped or edited file is still caught (and a full verification is repeated on a schedule).
 */
export type FaceRuntimeManifest = Readonly<{
  schemaVersion: 'face-runtime-manifest/v1'
  files: readonly Readonly<{ path: string; sha256: string; bytes: number }>[]
}>

const SHA = /^[a-f0-9]{64}$/
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 2_000_000_000
const conflict = (message: string): never => { throw new DomainError('PERSISTENCE_CONFLICT', message) }
const notConfigured = (message: string): never => { throw new DomainError('PERSISTENCE_NOT_CONFIGURED', message) }

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) conflict('Face runtime root contains a link')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        found.push(relative(root, path).split(sep).join('/'))
        if (found.length > MAX_FILES) conflict('Face runtime root has too many files')
      } else conflict('Face runtime root contains a special file')
    }
  }
  await walk(root)
  return found.sort()
}

export async function buildFaceRuntimeManifest(root: string): Promise<FaceRuntimeManifest> {
  if (!isAbsolute(root)) notConfigured('Face runtime root must be absolute')
  const files = []
  for (const path of await listFiles(root)) {
    const full = join(root, ...path.split('/'))
    const info = await stat(full)
    if (info.size > MAX_FILE_BYTES) conflict('Face runtime file is too large')
    files.push(Object.freeze({ path, sha256: await hashFile(full), bytes: info.size }))
  }
  return Object.freeze({ schemaVersion: 'face-runtime-manifest/v1' as const, files: Object.freeze(files) })
}

export const faceRuntimeManifestSha256 = (manifest: FaceRuntimeManifest) => calculateCanonicalHash(manifest)

export class FaceRuntimeInventory {
  readonly root: string
  readonly manifest: FaceRuntimeManifest
  readonly manifestSha256: string
  private fingerprint = new Map<string, string>()
  private fullVerifiedAt = 0
  private readonly fullIntervalMs: number
  private readonly now: () => number

  private constructor(root: string, manifest: FaceRuntimeManifest, manifestSha256: string, fullIntervalMs: number, now: () => number) {
    this.root = root; this.manifest = manifest; this.manifestSha256 = manifestSha256
    this.fullIntervalMs = fullIntervalMs; this.now = now
  }

  /** Loads the manifest file and refuses it unless its canonical hash is the pinned one. */
  static async load(input: { root: string; manifestPath: string; manifestSha256: string; fullVerifyIntervalMs?: number; now?: () => number }): Promise<FaceRuntimeInventory> {
    if (!isAbsolute(input.root) || !isAbsolute(input.manifestPath) || !SHA.test(input.manifestSha256)) notConfigured('Face runtime inventory configuration is invalid')
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(input.manifestPath, 'utf8')) } catch { return notConfigured('Face runtime manifest is unreadable') }
    const manifest = parsed as FaceRuntimeManifest
    if (!manifest || manifest.schemaVersion !== 'face-runtime-manifest/v1' || !Array.isArray(manifest.files) ||
        manifest.files.length === 0 || manifest.files.length > MAX_FILES || Object.keys(manifest).length !== 2) notConfigured('Face runtime manifest is invalid')
    const seen = new Set<string>()
    for (const file of manifest.files) {
      if (!file || Object.keys(file).sort().join('|') !== 'bytes|path|sha256' || typeof file.path !== 'string' ||
          file.path.length === 0 || file.path.startsWith('/') || file.path.split('/').some((part) => part === '..' || part === '' || part === '.') ||
          !SHA.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || seen.has(file.path)) {
        notConfigured('Face runtime manifest entry is invalid')
      }
      seen.add(file.path)
    }
    if (faceRuntimeManifestSha256(manifest) !== input.manifestSha256) notConfigured('Face runtime manifest differs from its pinned hash')
    return new FaceRuntimeInventory(input.root, manifest, input.manifestSha256, input.fullVerifyIntervalMs ?? 3_600_000, input.now ?? Date.now)
  }

  async verifyFull(): Promise<void> {
    const listed = new Set(this.manifest.files.map((file) => file.path))
    const present = await listFiles(this.root)
    if (present.length !== listed.size || present.some((path) => !listed.has(path))) conflict('Face runtime inventory drifted')
    const next = new Map<string, string>()
    for (const file of this.manifest.files) {
      const full = join(this.root, ...file.path.split('/'))
      const info = await lstat(full)
      if (!info.isFile() || info.size !== file.bytes || await hashFile(full) !== file.sha256) conflict('Face runtime file differs from its pinned hash')
      next.set(file.path, `${info.size}:${info.mtimeMs}`)
    }
    this.fingerprint = next
    this.fullVerifiedAt = this.now()
  }

  /** Cheap per-operation check; escalates to a full verification when none is current. */
  async verify(): Promise<void> {
    if (this.fingerprint.size === 0 || this.now() - this.fullVerifiedAt >= this.fullIntervalMs) return this.verifyFull()
    for (const file of this.manifest.files) {
      const info = await lstat(join(this.root, ...file.path.split('/'))).catch(() => null)
      if (!info || !info.isFile() || this.fingerprint.get(file.path) !== `${info.size}:${info.mtimeMs}`) conflict('Face runtime file changed since verification')
    }
  }
}
