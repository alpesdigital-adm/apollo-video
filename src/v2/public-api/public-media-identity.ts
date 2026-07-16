import { DomainError } from '../domain/errors.ts'

const FORBIDDEN_PUBLIC_STORAGE_KEYS = new Set([
  'storagePath', 'storageUri', 'bucket', 'objectKey', 'filesystemPath', 'filePath', 'permanentUrl',
])

export function publicArtifactReference(artifactId: string): string {
  const normalized = artifactId.trim()
  if (normalized.length < 3 || normalized.length > 128 || /[\\/]/.test(normalized)) {
    throw new DomainError('INVALID_MEDIA_ARTIFACT', 'Artifact cannot be represented publicly')
  }
  return `artifact:${normalized}`
}

export function assertNoPermanentStorageIdentity(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPermanentStorageIdentity(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_STORAGE_KEYS.has(key)) throw new DomainError('INVALID_PUBLIC_SCHEMA', `Permanent storage identity is forbidden at ${path}.${key}`)
    if (key === 'artifactKey' && (typeof item !== 'string' || !/^artifact:[^\\/]+$/.test(item))) {
      throw new DomainError('INVALID_PUBLIC_SCHEMA', `artifactKey must be an opaque logical reference at ${path}.${key}`)
    }
    assertNoPermanentStorageIdentity(item, `${path}.${key}`)
  }
}
