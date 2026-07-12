export interface ParsedApiCredential {
  clientId: string
  credentialId: string
  secret: string
}

export interface IssuedApiCredential {
  token: string
  credentialId: string
  secretSalt: string
  secretHash: string
}

export interface ApiCredentialCrypto {
  issue(clientId: string, credentialId: string): IssuedApiCredential
  parse(token: string): ParsedApiCredential
  verify(secret: string, secretSalt: string, expectedHash: string): Promise<boolean>
}
