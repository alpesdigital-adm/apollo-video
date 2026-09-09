import { DomainError } from '../domain/errors.ts'
import type { MusicAnalysisRun } from '../application/ports/music-led-montage.ts'
export function parseMusicAnalysisBody(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  const body = raw as Record<string, unknown>, unknown = Object.keys(body).filter(key => !['projectVersionId', 'artifactId'].includes(key))
  if (unknown.length) throw new DomainError('INVALID_ARGUMENT', 'Request body contains unknown fields', { fields: unknown })
  for (const key of ['projectVersionId', 'artifactId'] as const) if (typeof body[key] !== 'string' || body[key].trim().length < 3 || body[key].trim().length > 128) throw new DomainError('INVALID_ARGUMENT', `${key} is invalid`)
  return Object.freeze({ projectVersionId: (body.projectVersionId as string).trim(), artifactId: (body.artifactId as string).trim() })
}
export function presentMusicAnalysisRun(run: Readonly<MusicAnalysisRun>) { const { sourceArtifactKey: _key, ...safe } = run; return safe }
