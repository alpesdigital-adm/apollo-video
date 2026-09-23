import type {
  SyntheticPhaseGateEvidenceReferenceInput,
} from '../../domain/synthetic-phase-gate.ts'
import type { SyntheticPhaseGateEvidenceQuery } from './synthetic-phase-gate-repository.ts'

export type SyntheticPhaseGateEvidenceReference =
  Readonly<SyntheticPhaseGateEvidenceReferenceInput>

export interface SyntheticProviderExecutionEvidence {
  kind:
    | 'elevenlabs-audio-alignment'
    | 'heygen-generated-audio-avatar'
    | 'heygen-ready-audio-avatar'
  runtimeClass: 'controlled' | 'live'
  passed: boolean
  references: readonly SyntheticPhaseGateEvidenceReference[]
}

export interface SyntheticCatalogueEvidence {
  master: SyntheticPhaseGateEvidenceReference
  segments: readonly SyntheticPhaseGateEvidenceReference[]
  currentAuthorityValid: boolean
}

export interface SyntheticCrossProjectReuseEvidence {
  decision: SyntheticPhaseGateEvidenceReference
  master: SyntheticPhaseGateEvidenceReference
  consumerProject: SyntheticPhaseGateEvidenceReference
  sourceProjectId: string
  consumerProjectId: string
  providerWorkCount: number
  consumedByProduction: boolean
}

export interface SyntheticTransformationEvidence {
  ledger: SyntheticPhaseGateEvidenceReference
  rejectedReport?: SyntheticPhaseGateEvidenceReference
  approvedResult?: SyntheticPhaseGateEvidenceReference
  rejectedBeforeFallback: boolean
  fallbackApproved: boolean
}

export interface SyntheticProviderSwapEvidence {
  editPlan: SyntheticPhaseGateEvidenceReference
  renderManifest: SyntheticPhaseGateEvidenceReference
  buildAttestation: SyntheticPhaseGateEvidenceReference
  runtimeIdentityMatches: boolean
  assetsMatch: boolean
  propsHashMatches: boolean
  providerNeutral: boolean
}

export interface SyntheticPhaseGateEvidenceSources {
  projectVersionId: string
  projectVersionHash: string
  providerExecutions: readonly Readonly<SyntheticProviderExecutionEvidence>[]
  catalogues: readonly Readonly<SyntheticCatalogueEvidence>[]
  reuses: readonly Readonly<SyntheticCrossProjectReuseEvidence>[]
  transformations: readonly Readonly<SyntheticTransformationEvidence>[]
  swaps: readonly Readonly<SyntheticProviderSwapEvidence>[]
}

export interface SyntheticPhaseGateEvidenceReader {
  read(
    input: Readonly<SyntheticPhaseGateEvidenceQuery>,
  ): Promise<Readonly<SyntheticPhaseGateEvidenceSources> | null>
}
