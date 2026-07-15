import type { WebhookSigningSecretProvider } from '../../application/ports/webhook-delivery-dispatch.ts'
import { DomainError } from '../../domain/errors.ts'

const CONFIG_NAME = 'APOLLO_V2_WEBHOOK_SIGNING_SECRETS_JSON'
const MAX_CONFIG_BYTES = 256 * 1_024
const MAX_SECRETS = 1_000
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SECRET_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{2,217}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const ENTRY_KEYS = ['endpointId', 'keyRef', 'secretBase64url', 'version', 'workspaceId']

interface ConfiguredSigningSecret {
  workspaceId: string
  endpointId: string
  keyRef: string
  version: number
  secretBase64url: string
}

function unavailable(message: string): never {
  throw new DomainError('WEBHOOK_SECRET_UNAVAILABLE', message)
}

function invalidConfiguration(): never {
  throw new DomainError(
    'PERSISTENCE_NOT_CONFIGURED',
    'Webhook signing secret provider configuration is invalid',
  )
}

function identity(input: {
  workspaceId: string
  endpointId: string
  keyRef: string
  version: number
}): string {
  return `${input.workspaceId}\u0000${input.endpointId}\u0000${input.keyRef}\u0000${input.version}`
}

function parseEntry(value: unknown): ConfiguredSigningSecret {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidConfiguration()
  }
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).sort().join('\u0000') !== ENTRY_KEYS.join('\u0000')) {
    invalidConfiguration()
  }
  const workspaceId = typeof entry.workspaceId === 'string' ? entry.workspaceId.trim() : ''
  const endpointId = typeof entry.endpointId === 'string' ? entry.endpointId.trim().toLowerCase() : ''
  const keyRef = typeof entry.keyRef === 'string' ? entry.keyRef.trim() : ''
  const version = entry.version
  const secretBase64url = typeof entry.secretBase64url === 'string'
    ? entry.secretBase64url.trim()
    : ''
  if (
    !SAFE_ID_PATTERN.test(workspaceId) ||
    !UUID_V4_PATTERN.test(endpointId) ||
    !SECRET_REF_PATTERN.test(keyRef) ||
    keyRef.includes('@') ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1 ||
    Number(version) > 1_000_000 ||
    !BASE64URL_PATTERN.test(secretBase64url)
  ) {
    invalidConfiguration()
  }
  const decoded = Buffer.from(secretBase64url, 'base64url')
  if (
    decoded.length < 32 ||
    decoded.length > 512 ||
    decoded.toString('base64url') !== secretBase64url
  ) {
    decoded.fill(0)
    invalidConfiguration()
  }
  decoded.fill(0)
  return Object.freeze({
    workspaceId,
    endpointId,
    keyRef,
    version: Number(version),
    secretBase64url,
  })
}

export function createEnvironmentWebhookSigningSecretProvider(
  environment: NodeJS.ProcessEnv = process.env,
): WebhookSigningSecretProvider {
  const rawConfiguration = environment[CONFIG_NAME]?.trim() ?? ''
  if (
    rawConfiguration.length < 2 ||
    Buffer.byteLength(rawConfiguration, 'utf8') > MAX_CONFIG_BYTES
  ) {
    invalidConfiguration()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawConfiguration)
  } catch {
    invalidConfiguration()
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_SECRETS) {
    invalidConfiguration()
  }
  const entries = new Map<string, string>()
  for (const rawEntry of parsed) {
    const entry = parseEntry(rawEntry)
    const key = identity(entry)
    if (entries.has(key)) invalidConfiguration()
    entries.set(key, entry.secretBase64url)
  }

  return Object.freeze({
    async open(request: Parameters<WebhookSigningSecretProvider['open']>[0]) {
      const workspaceId = request.workspaceId.trim()
      const endpointId = request.endpointId.trim().toLowerCase()
      const keyRef = request.keyRef.trim()
      if (
        !SAFE_ID_PATTERN.test(workspaceId) ||
        !UUID_V4_PATTERN.test(endpointId) ||
        !SECRET_REF_PATTERN.test(keyRef) ||
        keyRef.includes('@') ||
        !Number.isSafeInteger(request.version) ||
        request.version < 1 ||
        request.version > 1_000_000
      ) {
        unavailable('Webhook signing secret request is invalid')
      }
      const encoded = entries.get(identity({
        workspaceId,
        endpointId,
        keyRef,
        version: request.version,
      }))
      if (!encoded) unavailable('Webhook signing secret is unavailable')
      const secret = Buffer.from(encoded, 'base64url')
      if (secret.length < 32 || secret.length > 512) {
        secret.fill(0)
        unavailable('Webhook signing secret is unavailable')
      }
      const opened = Uint8Array.from(secret)
      secret.fill(0)
      return opened
    },
  })
}
