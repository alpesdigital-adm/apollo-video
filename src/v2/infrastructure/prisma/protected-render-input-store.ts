import type { PrismaClient } from '@prisma/client'

import type { ProtectedRenderInputStore } from '../../application/ports/protected-render-input-store.ts'
import type { RecipeParameterCipher } from '../../application/ports/recipe-parameter-cipher.ts'
import { DomainError } from '../../domain/errors.ts'
import { assertRenderInputPayload } from '../../domain/render-input-payload.ts'
import type { RenderInputSpecV1 } from '../../domain/render-input.ts'
import { renderInputCipherContext } from '../security/recipe-parameter-cipher.ts'

type ProtectedRenderInputClient = Pick<PrismaClient, 'v2RenderInputPayload'>

export class PrismaProtectedRenderInputStore implements ProtectedRenderInputStore {
  private readonly client: ProtectedRenderInputClient
  private readonly cipher: RecipeParameterCipher

  constructor(
    client: ProtectedRenderInputClient,
    cipher: RecipeParameterCipher,
  ) {
    this.client = client
    this.cipher = cipher
  }

  async read(
    workspaceId: string,
    ref: string,
    inputHash: string,
  ): Promise<RenderInputSpecV1 | null> {
    const stored = await this.client.v2RenderInputPayload.findUnique({
      where: { workspaceId_ref: { workspaceId, ref } },
    })
    if (!stored) return null
    if (stored.workspaceId !== workspaceId || stored.ref !== ref || stored.inputHash !== inputHash) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Protected RenderInput identity does not match the requested manifest link',
      )
    }

    const canonicalJson = await this.cipher.open(
      {
        algorithm: stored.algorithm as 'aes-256-gcm',
        keyId: stored.keyId,
        nonce: stored.nonce,
        ciphertext: stored.ciphertext,
        authTag: stored.authTag,
      },
      renderInputCipherContext(workspaceId, ref),
    )
    const payload = {
      ref,
      inputHash,
      canonicalJson,
      canonicalByteSize: stored.canonicalByteSize,
    }
    assertRenderInputPayload(payload)
    return JSON.parse(canonicalJson) as RenderInputSpecV1
  }
}
