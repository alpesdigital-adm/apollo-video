import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import { DomainError } from '../../domain/errors.ts'
import type {
  ApiCredentialCrypto,
  IssuedApiCredential,
  ParsedApiCredential,
} from '../../application/ports/api-credential-crypto.ts'

const TOKEN_PREFIX = 'apollo_v2'
const HASH_BYTES = 32
const scryptAsync = promisify(scrypt)

function hashSecret(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, HASH_BYTES)
}

export function issueApiCredential(clientId: string, credentialId: string): IssuedApiCredential {
  const secret = randomBytes(32).toString('base64url')
  const secretSalt = randomBytes(16).toString('base64url')
  const secretHash = hashSecret(secret, secretSalt).toString('hex')

  return {
    token: `${TOKEN_PREFIX}.${clientId}.${credentialId}.${secret}`,
    credentialId,
    secretSalt,
    secretHash,
  }
}

export function parseApiCredential(token: string): ParsedApiCredential {
  const parts = token.split('.')
  const [prefix, clientId] = parts
  const legacy = parts.length === 3
  const credentialId = legacy ? clientId : parts[2]
  const secret = legacy ? parts[2] : parts[3]
  if (
    prefix !== TOKEN_PREFIX ||
    !clientId ||
    !credentialId ||
    !secret ||
    (parts.length !== 3 && parts.length !== 4) ||
    !/^[A-Za-z0-9_-]{3,80}$/.test(clientId) ||
    !/^[A-Za-z0-9_-]{3,80}$/.test(credentialId) ||
    secret.length < 32
  ) {
    throw new DomainError('AUTH_INVALID', 'Invalid API credential')
  }

  return { clientId, credentialId, secret }
}

export async function verifyApiCredential(
  secret: string,
  secretSalt: string,
  expectedHash: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false
  const actual = (await scryptAsync(secret, secretSalt, HASH_BYTES)) as Buffer
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export const nodeApiCredentialCrypto: ApiCredentialCrypto = Object.freeze({
  issue: issueApiCredential,
  parse: parseApiCredential,
  verify: verifyApiCredential,
})
