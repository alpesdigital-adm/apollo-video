export interface OidcTransactionProtector {
  protect(codeVerifier: string, stateHash: string): Promise<string>
  open(protectedCodeVerifier: string, stateHash: string): Promise<string>
}

