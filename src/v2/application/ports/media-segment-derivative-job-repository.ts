export type MediaSegmentDerivativeJobStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'canceled'

export interface MediaSegmentDerivativeJob {
  id: string
  workspaceId: string
  segmentId: string
  consumerKey: string
  sourceSha256: string
  segmentHash: string
  rightsSnapshotId: string
  clientId: string
  actorContextHash: string
  idempotencyKey: string
  requestFingerprint: string
  status: MediaSegmentDerivativeJobStatus
  attempt: number
  maxAttempts: number
  deadlineAt: string
  outputArtifactId?: string
  outputManifestId?: string
  errorCode?: string
  createdAt: string
  updatedAt: string
}

export interface MediaSegmentDerivativeJobRepository {
  enqueue(input: Omit<MediaSegmentDerivativeJob, 'status' | 'attempt' | 'maxAttempts' | 'updatedAt'>): Promise<Readonly<{ job: MediaSegmentDerivativeJob; replayed: boolean }>>
  read(workspaceId: string, jobId: string): Promise<Readonly<MediaSegmentDerivativeJob> | null>
  cancel(workspaceId: string, jobId: string, actorContextHash: string, now: Date): Promise<Readonly<MediaSegmentDerivativeJob> | null>
  retry(workspaceId: string, jobId: string, actorContextHash: string, now: Date): Promise<Readonly<MediaSegmentDerivativeJob> | null>
  claim(owner: string, now: Date, leaseUntil: Date): Promise<Readonly<MediaSegmentDerivativeJob> | null>
  heartbeat(jobId: string, owner: string, attempt: number, now: Date, leaseUntil: Date): Promise<boolean>
  succeed(jobId: string, owner: string, attempt: number, outputArtifactId: string, outputManifestId: string, now: Date): Promise<boolean>
  failOrRetry(jobId: string, owner: string, attempt: number, errorCode: string, retryable: boolean, now: Date): Promise<boolean>
}
