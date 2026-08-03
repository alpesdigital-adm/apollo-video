export interface ParsedApiCredential {
  readonly clientId: string
  readonly credentialId: string
  readonly secret: string
}

export interface IssuedApiCredential {
  readonly token: string
  readonly credentialId: string
  readonly secretSalt: string
  readonly secretHash: string
}

export interface ApiCredentialCrypto {
  issue(clientId: string, credentialId: string): IssuedApiCredential
  parse(token: string): ParsedApiCredential
  verify(secret: string, secretSalt: string, expectedHash: string): Promise<boolean>
}
