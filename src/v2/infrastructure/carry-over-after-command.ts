import { randomUUID } from 'node:crypto'

import type { AuthenticatedExternalActor } from '../application/authenticate-api-client.ts'
import { carryOverUntouchedOutputs, carryOverUntouchedOutputService } from '../application/carry-over-untouched-output.ts'
import { outputVariantsOf } from '../domain/output-consumption.ts'
import { readStoredOutputStateV3 } from './prisma/output-state-consumption.ts'
import { PrismaProxyCarryOverRepository } from './prisma/proxy-carry-over-repository.ts'
import { createColorPipelineCompilationRepository, createFaceSourceWindowRepository, createProjectProxyRenderRepository } from './repository-factory.ts'
import { getV2PostgresClient } from './prisma-postgres/client.ts'

/**
 * W70 prep. Called by the routes of the Commands that are aimed at some outputs of a project, after the Command committed: every OTHER output of
 * the new head Version keeps the render, the review and the approval it had when nothing it is drawn from changed (see
 * `carryOverUntouchedOutputService`). Best effort and never throwing - the Command has committed and answers regardless; what could not be
 * carried keeps the render it had and is rendered on request.
 */
export async function carryOverAfterCommand(input: Readonly<{
  workspaceId: string
  projectId: string
  versionId: string
  commandId?: string
  affectedVariantIds: readonly string[]
  actor: AuthenticatedExternalActor
  traceId?: string
  log?: (message: string) => void
}>): Promise<void> {
  try {
    const client = getV2PostgresClient()
    const stored = await readStoredOutputStateV3(client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: input.versionId })
    if (!stored) return
    const carry = carryOverUntouchedOutputService({
      projects: createProjectProxyRenderRepository(), carryOvers: new PrismaProxyCarryOverRepository(client),
      colorPipelines: createColorPipelineCompilationRepository(), clock: () => new Date(), createId: randomUUID,
      // The reader the proxy render worker is wired with: the face windows a carry compares are read exactly as a render reads them.
      faceEvidence: createFaceSourceWindowRepository(),
    })
    const outcomes = await carryOverUntouchedOutputs({
      carry: ({ variantId }) => carry({ workspaceId: input.workspaceId, projectId: input.projectId, variantId, actor: input.actor,
        ...(input.commandId ? { commandId: input.commandId } : {}), ...(input.traceId ? { traceId: input.traceId } : {}) }),
      outputVariantIds: outputVariantsOf(stored.state).map((variant) => variant.variantId),
      affectedVariantIds: input.affectedVariantIds,
    })
    for (const outcome of outcomes) {
      if (outcome.error) (input.log ?? console.warn)(`carry-over of ${outcome.variantId} failed: ${outcome.error}`)
    }
  } catch (error) {
    (input.log ?? console.warn)(`carry-over after command failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
