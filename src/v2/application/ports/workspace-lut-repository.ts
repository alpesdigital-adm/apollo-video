import type { WorkspaceLutVersion } from '../../domain/workspace-lut.ts'

export interface WorkspaceLutRecord {
  lutId: string
  workspaceId: string
  status: 'active' | 'inactive'
  currentVersion: Readonly<WorkspaceLutVersion>
}
export interface PersistedWorkspaceLutImport {
  record: Readonly<WorkspaceLutRecord>
  idempotencyKey: string
  requestFingerprint: string
}
export interface WorkspaceLutRepository {
  findIdempotent(input: { workspaceId: string; createdByClientId: string; idempotencyKey: string }): Promise<Readonly<PersistedWorkspaceLutImport> | null>
  import(input: { value: Readonly<PersistedWorkspaceLutImport>; previewPng: Uint8Array }): Promise<Readonly<{ value: Readonly<PersistedWorkspaceLutImport>; replayed: boolean }>>
  read(input: { workspaceId: string; lutId: string }): Promise<Readonly<WorkspaceLutRecord> | null>
  list(input: { workspaceId: string; status?: 'active' | 'inactive'; limit: number }): Promise<readonly Readonly<WorkspaceLutRecord>[]>
  readPreview(input: { workspaceId: string; lutId: string; version: number }): Promise<Readonly<{ png: Uint8Array; sha256: string }> | null>
}
