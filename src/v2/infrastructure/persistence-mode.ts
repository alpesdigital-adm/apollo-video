import { DomainError } from '../domain/errors.ts'

export type V2PersistenceMode = 'postgres'

export function resolveV2PersistenceMode(): V2PersistenceMode {
  const configured = process.env.APOLLO_V2_PERSISTENCE
  const mode = configured ?? 'postgres'

  if (mode !== 'postgres') {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Apollo V2 requires PostgreSQL; compatibility persistence is not supported',
    )
  }
  if (!process.env.V2_DATABASE_URL) {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'V2_DATABASE_URL is required')
  }

  return 'postgres'
}
