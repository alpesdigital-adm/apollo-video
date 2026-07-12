export interface ParsedApiCredential {
  clientId: string
  secret: string
}

export interface IssuedApiCredential {
  token: string
  secretSalt: string
  secretHash: string
}

export interface ApiCredentialCrypto {
  issue(clientId: string): IssuedApiCredential
  parse(token: string): ParsedApiCredential
  verify(secret: string, secretSalt: string, expectedHash: string): Promise<boolean>
}
