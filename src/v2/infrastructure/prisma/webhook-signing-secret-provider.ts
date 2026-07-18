import { createHash } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import type { RecipeParameterCipher } from '../../application/ports/recipe-parameter-cipher.ts'
import type { WebhookSigningSecretProvider } from '../../application/ports/webhook-delivery-dispatch.ts'
import { DomainError } from '../../domain/errors.ts'
import { createWebhookSigningSecretPayload } from '../../domain/webhook-signing-secret-payload.ts'
import { webhookSigningSecretCipherContext } from '../security/webhook-signing-secret-protector.ts'

function unavailable(): never {
  throw new DomainError('WEBHOOK_SECRET_UNAVAILABLE', 'Webhook signing secret is unavailable')
}

function invalidPayload(): never {
  throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook signing secret payload is invalid')
}

export class PrismaWebhookSigningSecretProvider implements WebhookSigningSecretProvider {
  private readonly client: PrismaClient
  private readonly cipher: RecipeParameterCipher
  private readonly clock: () => Date

  constructor(cipher: RecipeParameterCipher, client: PrismaClient = getV2PostgresClient(), clock: () => Date = () => new Date()) {
    this.cipher = cipher
    this.client = client
    this.clock = clock
  }

  async open(request: Parameters<WebhookSigningSecretProvider['open']>[0]): Promise<Uint8Array> {
    const row = await this.client.v2WebhookSigningSecret.findFirst({
      where: {
        workspaceId: request.workspaceId,
        endpointId: request.endpointId,
        keyRef: request.keyRef,
        version: request.version,
      },
      include: { payload: true },
    })
    if (!row) unavailable()
    const now = this.clock()
    if (Number.isNaN(now.getTime())) invalidPayload()
    const eligible = row.status === 'active' || (
      row.status === 'retired' && row.usableUntil !== null && row.usableUntil > now
    )
    if (!eligible) unavailable()
    if (!row.payload) invalidPayload()
    let payload: ReturnType<typeof createWebhookSigningSecretPayload>
    try {
      payload = createWebhookSigningSecretPayload({
        secretId: row.payload.secretId,
        workspaceId: row.payload.workspaceId,
        endpointId: row.payload.endpointId,
        secretVersion: row.payload.secretVersion,
        keyId: row.payload.keyId,
        nonce: row.payload.nonce,
        ciphertext: row.payload.ciphertext,
        authTag: row.payload.authTag,
        createdAt: row.payload.createdAt.toISOString(),
      })
    } catch {
      invalidPayload()
    }
    if (
      payload.secretId !== row.id ||
      payload.workspaceId !== row.workspaceId ||
      payload.endpointId !== row.endpointId ||
      payload.secretVersion !== row.version
    ) invalidPayload()

    let encoded: string
    try {
      encoded = await this.cipher.open(
        {
          algorithm: payload.algorithm,
          keyId: payload.keyId,
          nonce: payload.nonce,
          ciphertext: payload.ciphertext,
          authTag: payload.authTag,
        },
        webhookSigningSecretCipherContext({
          secretId: row.id,
          workspaceId: row.workspaceId,
          endpointId: row.endpointId,
          version: row.version,
          keyRef: row.keyRef,
        }),
      )
    } catch {
      invalidPayload()
    }
    const opened = Buffer.from(encoded, 'base64url')
    if (
      opened.length < 32 ||
      opened.length > 512 ||
      opened.toString('base64url') !== encoded ||
      createHash('sha256').update(opened).digest('hex') !== row.fingerprint
    ) {
      opened.fill(0)
      invalidPayload()
    }
    const result = Uint8Array.from(opened)
    opened.fill(0)
    return result
  }
}
