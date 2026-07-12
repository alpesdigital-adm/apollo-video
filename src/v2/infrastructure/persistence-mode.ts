import { DomainError } from '../domain/errors.ts'

export type V2PersistenceMode = 'sqlite-prototype' | 'postgres'

export function resolveV2PersistenceMode(): V2PersistenceMode {
  const configured = process.env.APOLLO_V2_PERSISTENCE
  const apiEnvironment = process.env.APOLLO_API_ENVIRONMENT ?? 'sandbox'
  const mode = configured ?? (apiEnvironment === 'production' ? 'postgres' : 'sqlite-prototype')

  if (mode !== 'sqlite-prototype' && mode !== 'postgres') {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'APOLLO_V2_PERSISTENCE is invalid')
  }
  if (apiEnvironment === 'production' && mode !== 'postgres') {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Production API cannot use the SQLite prototype',
    )
  }
  if (mode === 'postgres' && !process.env.V2_DATABASE_URL) {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'V2_DATABASE_URL is required')
  }

  return mode
}
