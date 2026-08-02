export interface OidcAuthorizationTransaction {
  stateHash: string
  browserBindingHash: string
  nonceHash: string
  protectedCodeVerifier: string
  issuer: string
  clientId: string
  redirectUri: string
  returnTo: string
  createdAt: string
  expiresAt: string
  consumedAt?: string
}

export interface OidcAuthorizationRepository {
  create(input: Readonly<OidcAuthorizationTransaction>): Promise<void>
  consume(input: Readonly<{
    stateHash: string
    browserBindingHash: string
    consumedAt: string
  }>): Promise<Readonly<OidcAuthorizationTransaction> | null>
  deleteExpired(input: Readonly<{ before: string; limit: number }>): Promise<number>
}

