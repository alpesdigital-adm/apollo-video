export interface OidcProviderConfiguration {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  recoveryUrl: string
  allowInsecureLoopback: boolean
}
export interface OidcProviderClaims {
  issuer: string
  subject: string
  nonce: string
  issuedAt: number
  expiresAt: number
  email?: string
  emailVerified?: boolean
}

export interface OidcProvider {
  authorizationUrl(input: Readonly<{
    state: string
    nonce: string
    codeChallenge: string
  }>): Promise<string>
  exchangeAndVerify(input: Readonly<{
    code: string
    codeVerifier: string
    expectedNonceHash: string
  }>): Promise<Readonly<OidcProviderClaims>>
}
