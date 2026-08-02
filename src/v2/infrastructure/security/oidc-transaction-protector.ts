import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { DomainError } from '../../domain/errors.ts'
import type { OidcTransactionProtector } from '../../application/ports/oidc-transaction-protector.ts'

const VERSION = 'v1'
const KEY_ID = 'oidc-transaction-v1'
const OPAQUE_VALUE = /^[A-Za-z0-9_-]{43}$/

function key(environment: NodeJS.ProcessEnv): Buffer {
  const secret = environment.APOLLO_OIDC_TRANSACTION_SECRET
  if (!secret || secret.length < 32) throw new DomainError('AUTH_NOT_CONFIGURED', 'OIDC transaction protection is not configured')
  return createHash('sha256').update(secret).digest()
}

export function nodeOidcTransactionProtector(
  environment: NodeJS.ProcessEnv = process.env,
): OidcTransactionProtector {
  return Object.freeze({
    async protect(codeVerifier: string, stateHash: string) {
      if (!OPAQUE_VALUE.test(codeVerifier)) throw new DomainError('INVALID_ARGUMENT', 'OIDC code verifier is invalid')
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key(environment), nonce)
      cipher.setAAD(Buffer.from(stateHash))
      const ciphertext = Buffer.concat([cipher.update(codeVerifier, 'utf8'), cipher.final()])
      return [VERSION, KEY_ID, nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
    },
    async open(protectedCodeVerifier: string, stateHash: string) {
      const [version, keyId, nonce, ciphertext, authTag, ...extra] = protectedCodeVerifier.split('.')
      if (version !== VERSION || keyId !== KEY_ID || !nonce || !ciphertext || !authTag || extra.length > 0) {
        throw new DomainError('AUTH_INVALID', 'OIDC transaction protection is invalid')
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key(environment), Buffer.from(nonce, 'base64url'))
        decipher.setAAD(Buffer.from(stateHash))
        decipher.setAuthTag(Buffer.from(authTag, 'base64url'))
        const value = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
        if (!OPAQUE_VALUE.test(value)) throw new Error('invalid verifier')
        return value
      } catch (error) {
        if (error instanceof DomainError) throw error
        throw new DomainError('AUTH_INVALID', 'OIDC transaction protection could not be opened')
      }
    },
  })
}
