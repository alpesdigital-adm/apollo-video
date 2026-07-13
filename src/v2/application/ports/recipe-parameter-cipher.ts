export interface SealedRecipeParameters {
  algorithm: 'aes-256-gcm'
  keyId: string
  nonce: string
  ciphertext: string
  authTag: string
}

export interface RecipeParameterCipher {
  seal(plaintext: string, context: string): Promise<SealedRecipeParameters>
  open(sealed: SealedRecipeParameters, context: string): Promise<string>
}
