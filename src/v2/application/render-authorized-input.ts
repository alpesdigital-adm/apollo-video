import { DomainError } from '../domain/errors.ts'
import type { AuthorizedMaterializedRenderInput } from './materialize-authorized-render-input.ts'
import type {
  CommittedRenderReceipt,
  RenderInputRenderer,
} from './ports/render-input-renderer.ts'

export interface AuthorizedRenderReceipt {
  schemaVersion: 'authorized-render-receipt/v1'
  authorizationId: string
  artifactId: string
  manifestId: string
  inputHash: string
  revalidationHash: string
  output: Readonly<CommittedRenderReceipt>
}

type MaterializeAuthorized = (request: {
  workspaceId: string
  authorizationId: string
}) => Promise<AuthorizedMaterializedRenderInput>

export function renderAuthorizedInputService(dependencies: {
  materialize: MaterializeAuthorized
  renderer: RenderInputRenderer
  outputKeyFor: (request: {
    workspaceId: string
    authorizationId: string
    artifactId: string
    inputHash: string
  }) => string
}) {
  return async function renderAuthorizedInput(request: {
    workspaceId: string
    authorizationId: string
    signal?: AbortSignal
    beforeCommit?: () => Promise<void>
  }): Promise<Readonly<AuthorizedRenderReceipt>> {
    const initialLease = await dependencies.materialize({
      workspaceId: request.workspaceId,
      authorizationId: request.authorizationId,
    })
    const initialReceipt = initialLease.receipt
    const staged = await dependencies.renderer.stage(initialLease.getRenderInput(), {
      outputKey: dependencies.outputKeyFor({
        workspaceId: request.workspaceId,
        authorizationId: request.authorizationId,
        artifactId: initialReceipt.artifactId,
        inputHash: initialReceipt.inputHash,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    })

    try {
      if (request.signal?.aborted) {
        throw new DomainError('RENDER_EXECUTION_FAILED', 'Render execution was cancelled')
      }
      const commitLease = await dependencies.materialize({
        workspaceId: request.workspaceId,
        authorizationId: request.authorizationId,
      })
      if (
        commitLease.receipt.inputHash !== initialReceipt.inputHash ||
        commitLease.receipt.revalidationHash !== initialReceipt.revalidationHash
      ) {
        throw new DomainError(
          'MATERIALIZATION_REVALIDATION_FAILED',
          'Render inputs or rights changed before output promotion',
          { reasonCode: 'PRE_COMMIT_REVALIDATION_CHANGED' },
        )
      }
      if (request.signal?.aborted) {
        throw new DomainError('RENDER_EXECUTION_FAILED', 'Render execution was cancelled')
      }
      await request.beforeCommit?.()
      if (request.signal?.aborted) {
        throw new DomainError('RENDER_EXECUTION_FAILED', 'Render execution was cancelled')
      }
      const output = await staged.commit()
      return Object.freeze({
        schemaVersion: 'authorized-render-receipt/v1',
        authorizationId: initialReceipt.authorizationId,
        artifactId: initialReceipt.artifactId,
        manifestId: initialReceipt.manifestId,
        inputHash: initialReceipt.inputHash,
        revalidationHash: initialReceipt.revalidationHash,
        output,
      })
    } catch (error) {
      try {
        await staged.discard()
      } catch (cleanupError) {
        throw new DomainError(
          'RENDER_OUTPUT_CLEANUP_FAILED',
          'Partial render output could not be removed',
          { operationFailed: true, cleanupFailed: true },
        )
      }
      throw error
    }
  }
}
