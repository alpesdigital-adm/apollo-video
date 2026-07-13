import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

import type {
  RecipeParameterCipher,
  SealedRecipeParameters,
} from '../../application/ports/recipe-parameter-cipher.ts'
import { DomainError } from '../../domain/errors.ts'

const ALGORITHM = 'aes-256-gcm'

export function createAesRecipeParameterCipher(config: {
  keyId: string
  key: Buffer
}): RecipeParameterCipher {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(config.keyId) || config.key.length !== 32) {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Recipe parameter cipher is invalid')
  }

  return Object.freeze({
    async seal(plaintext: string, context: string): Promise<SealedRecipeParameters> {
      const nonce = randomBytes(12)
      const cipher = createCipheriv(ALGORITHM, config.key, nonce)
      cipher.setAAD(Buffer.from(context, 'utf8'))
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ])
      return {
        algorithm: ALGORITHM,
        keyId: config.keyId,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      }
    },

    async open(sealed: SealedRecipeParameters, context: string): Promise<string> {
      if (sealed.algorithm !== ALGORITHM || sealed.keyId !== config.keyId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Recipe parameter cipher metadata is invalid')
      }
      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          config.key,
          Buffer.from(sealed.nonce, 'base64url'),
        )
        decipher.setAAD(Buffer.from(context, 'utf8'))
        decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64url'))
        return Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Recipe parameter payload failed authentication')
      }
    },
  })
}

export function createRecipeParameterCipherFromEnvironment(): RecipeParameterCipher {
  const keyId = process.env.APOLLO_RECIPE_PARAMETER_KEY_ID?.trim() ?? ''
  const encodedKey = process.env.APOLLO_RECIPE_PARAMETER_KEY?.trim() ?? ''
  let key: Buffer
  try {
    key = Buffer.from(encodedKey, 'base64url')
  } catch {
    key = Buffer.alloc(0)
  }
  return createAesRecipeParameterCipher({ keyId, key })
}
