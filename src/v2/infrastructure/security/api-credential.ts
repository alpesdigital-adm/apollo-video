import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'

import { DomainError } from '../../domain/errors.ts'
import type {
  ApiCredentialCrypto,
  IssuedApiCredential,
  ParsedApiCredential,
} from '../../application/ports/api-credential-crypto.ts'

const TOKEN_PREFIX = 'apollo_v2'
const HASH_BYTES = 32
const SECRET_BYTES = 32
const SALT_BYTES = 16
const SAFE_ID = /^[A-Za-z0-9_-]{3,80}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const SALT = /^[A-Za-z0-9_-]{22}$/
const HASH = /^[a-f0-9]{64}$/
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

function hashSecret(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, HASH_BYTES, SCRYPT_OPTIONS)
}

function hashSecretAsync(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, HASH_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

export function issueApiCredential(clientId: string, credentialId: string): IssuedApiCredential {
  if (!SAFE_ID.test(clientId) || !SAFE_ID.test(credentialId)) {
    throw new DomainError('INVALID_API_CLIENT', 'API credential identifiers are invalid')
  }
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const secretSalt = randomBytes(SALT_BYTES).toString('base64url')
  const secretHash = hashSecret(secret, secretSalt).toString('hex')

  return Object.freeze({
    token: `${TOKEN_PREFIX}.${clientId}.${credentialId}.${secret}`,
    credentialId,
    secretSalt,
    secretHash,
  })
}

export function parseApiCredential(token: string): ParsedApiCredential {
  const parts = token.split('.')
  const [prefix, clientId, credentialId, secret] = parts
  if (
    prefix !== TOKEN_PREFIX ||
    !clientId ||
    !credentialId ||
    !secret ||
    parts.length !== 4 ||
    !SAFE_ID.test(clientId) ||
    !SAFE_ID.test(credentialId) ||
    !SECRET.test(secret)
  ) {
    throw new DomainError('AUTH_INVALID', 'Invalid API credential')
  }

  return Object.freeze({ clientId, credentialId, secret })
}

export async function verifyApiCredential(
  secret: string,
  secretSalt: string,
  expectedHash: string,
): Promise<boolean> {
  if (!SECRET.test(secret) || !SALT.test(secretSalt) || !HASH.test(expectedHash)) return false
  try {
    const actual = await hashSecretAsync(secret, secretSalt)
    const expected = Buffer.from(expectedHash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export const nodeApiCredentialCrypto: ApiCredentialCrypto = Object.freeze({
  issue: issueApiCredential,
  parse: parseApiCredential,
  verify: verifyApiCredential,
})
