import type { PublicOperationLeaseCommand } from './public-operation-repository.ts'
import type {
  SyntheticProductionRenderCheckpoint,
  SyntheticProductionRenderContext,
  SyntheticProductionRenderQualityReport,
} from '../../domain/synthetic-production-render.ts'
import type { SyntheticPresenterEditPlan } from '../../domain/synthetic-production.ts'
import type { SyntheticBuildAttestation } from '../../domain/synthetic-build-attestation.ts'
import type { PublicOperation } from '../../domain/public-operation.ts'

export interface SyntheticProductionRenderBinding {
  context: Readonly<SyntheticProductionRenderContext>
  plan: Readonly<SyntheticPresenterEditPlan>
  checkpoint?: Readonly<SyntheticProductionRenderCheckpoint>
  qualityReport?: Readonly<SyntheticProductionRenderQualityReport>
}

export interface SyntheticProductionRenderTerminalBinding extends SyntheticProductionRenderBinding {
  operation: Readonly<PublicOperation>
  attestation?: Readonly<SyntheticBuildAttestation>
}

export interface SyntheticProductionRenderRepository {
  readBinding(input: {
    workspaceId: string
    operationId: string
  }): Promise<Readonly<SyntheticProductionRenderBinding> | null>
  readLatestByRun(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<SyntheticProductionRenderTerminalBinding> | null>
  findReadyToFinalize(input: { now: string }): Promise<Readonly<{
    workspaceId: string
    operationId: string
    attempt: number
  }> | null>
  recordCheckpoint(input: PublicOperationLeaseCommand & {
    checkpoint: Readonly<SyntheticProductionRenderCheckpoint>
  }): Promise<boolean>
  recordQuality(input: PublicOperationLeaseCommand & {
    report: Readonly<SyntheticProductionRenderQualityReport>
  }): Promise<boolean>
  finalizeAttested(input: PublicOperationLeaseCommand): Promise<boolean>
}
