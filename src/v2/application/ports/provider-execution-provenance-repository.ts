export const PROVIDER_TRANSPORT_OBSERVATION_SCHEMA_VERSION = 'provider-transport-observation/v1' as const
export const PROVIDER_TRANSPORT_EVIDENCE_SCHEMA_VERSION = 'provider-transport-evidence/v1' as const
export const PROVIDER_EXECUTION_RECEIPT_SCHEMA_VERSION = 'provider-execution-receipt/v1' as const

export type ProviderTransportPhase = 'submit' | 'retrieve'
export type ProviderRuntimeClass = 'controlled' | 'live'

/**
 * Adapter-owned facts captured at the transport boundary. The observation is
 * deliberately redacted: hashes and an endpoint class are durable; request
 * bodies, credentials and URLs are not.
 */
export interface ProviderTransportObservation {
  schemaVersion: typeof PROVIDER_TRANSPORT_OBSERVATION_SCHEMA_VERSION
  phase: ProviderTransportPhase
  runtimeClass: ProviderRuntimeClass
  adapterId: string
  adapterVersion: string
  adapterConfigHash: string
  endpointClass: string
  method: string
  requestHash: string
  responseHash: string
  responseStatus: number
  providerJobRef?: string
  observedAt: string
  observationHash: string
}

/** Job/attempt/lease binding added by the worker to an adapter observation. */
export interface ProviderTransportEvidence extends Omit<ProviderTransportObservation, 'schemaVersion'> {
  schemaVersion: typeof PROVIDER_TRANSPORT_EVIDENCE_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  jobId: string
  attempt: number
  inputHash: string
  authorizationHash: string
  jobHash: string
  leaseOwner: string
  leaseToken: string
  evidenceHash: string
}

export interface ProviderExecutionReceiptResult {
  resultRecordId: string
  resultRecordHash: string
  role: 'primary-audio' | 'primary-video' | 'alignment-evidence'
  artifactId: string
  artifactSha256: string
  byteSize: number
}

export interface ProviderExecutionReceipt {
  schemaVersion: typeof PROVIDER_EXECUTION_RECEIPT_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  jobId: string
  attempt: number
  runtimeClass: ProviderRuntimeClass
  adapterId: string
  adapterVersion: string
  adapterConfigHash: string
  inputHash: string
  authorizationHash: string
  providerJobRef: string
  leaseOwner: string
  leaseToken: string
  submitEvidenceId: string
  submitEvidenceHash: string
  retrieveEvidenceId?: string
  retrieveEvidenceHash?: string
  results: readonly Readonly<ProviderExecutionReceiptResult>[]
  createdAt: string
  receiptHash: string
}

export interface ProviderExecutionProvenanceRepository {
  recordEvidence(input: {
    evidence: Readonly<ProviderTransportEvidence>
  }): Promise<Readonly<{ evidence: Readonly<ProviderTransportEvidence>; replayed: boolean }>>
  listEvidenceByJob(input: {
    workspaceId: string
    projectId: string
    jobId: string
  }): Promise<readonly Readonly<ProviderTransportEvidence>[]>
  createReceipt(input: {
    receipt: Readonly<ProviderExecutionReceipt>
  }): Promise<Readonly<{ receipt: Readonly<ProviderExecutionReceipt>; replayed: boolean }>>
  readReceiptByJob(input: {
    workspaceId: string
    projectId: string
    jobId: string
  }): Promise<Readonly<ProviderExecutionReceipt> | null>
}
