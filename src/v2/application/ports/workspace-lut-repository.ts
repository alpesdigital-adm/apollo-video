import type { WorkspaceLutVersion } from '../../domain/workspace-lut.ts'

export interface WorkspaceLutRecord {
  lutId: string
  workspaceId: string
  status: 'active' | 'inactive'
  revision: number
  currentVersion: Readonly<WorkspaceLutVersion>
}
export interface PersistedWorkspaceLutImport {
  record: Readonly<WorkspaceLutRecord>
  idempotencyKey: string
  requestFingerprint: string
}
export interface WorkspaceLutStatusCommand {
  id: string
  workspaceId: string
  lutId: string
  baseRevision: number
  resultRevision: number
  status: 'active' | 'inactive'
  resultVersionId: string
  requestFingerprint: string
  idempotencyKey: string
  createdByClientId: string
  createdAt: string
}
export interface WorkspaceLutDefaultVersion {
  id: string
  workspaceId: string
  revision: number
  mode: 'none' | 'lut-version'
  lutVersion?: Readonly<WorkspaceLutVersion>
  selectionHash: string
  requestFingerprint: string
  idempotencyKey: string
  createdByClientId: string
  createdAt: string
}
export interface WorkspaceLutDefault {
  workspaceId: string
  revision: number
  current: Readonly<WorkspaceLutDefaultVersion> | null
}
export interface WorkspaceLutRepository {
  findIdempotent(input: { workspaceId: string; createdByClientId: string; idempotencyKey: string }): Promise<Readonly<PersistedWorkspaceLutImport> | null>
  import(input: { value: Readonly<PersistedWorkspaceLutImport>; previewPng: Uint8Array }): Promise<Readonly<{ value: Readonly<PersistedWorkspaceLutImport>; replayed: boolean }>>
  createVersion(input: { value: Readonly<PersistedWorkspaceLutImport>; previewPng: Uint8Array; expectedCurrentVersionId: string }): Promise<Readonly<{ value: Readonly<PersistedWorkspaceLutImport>; replayed: boolean }>>
  read(input: { workspaceId: string; lutId: string }): Promise<Readonly<WorkspaceLutRecord> | null>
  readVersion(input: { workspaceId: string; lutId: string; version: number }): Promise<Readonly<WorkspaceLutVersion> | null>
  list(input: { workspaceId: string; status?: 'active' | 'inactive'; limit: number }): Promise<readonly Readonly<WorkspaceLutRecord>[]>
  readPreview(input: { workspaceId: string; lutId: string; version: number }): Promise<Readonly<{ png: Uint8Array; sha256: string }> | null>
  findStatusIdempotent(input: { workspaceId: string; createdByClientId: string; idempotencyKey: string }): Promise<Readonly<{ command: Readonly<WorkspaceLutStatusCommand>; record: Readonly<WorkspaceLutRecord> }> | null>
  setStatus(input: { command: Readonly<WorkspaceLutStatusCommand> }): Promise<Readonly<{ command: Readonly<WorkspaceLutStatusCommand>; record: Readonly<WorkspaceLutRecord>; replayed: boolean }>>
  readDefault(input: { workspaceId: string }): Promise<Readonly<WorkspaceLutDefault>>
  findDefaultIdempotent(input: { workspaceId: string; createdByClientId: string; idempotencyKey: string }): Promise<Readonly<WorkspaceLutDefaultVersion> | null>
  setDefault(input: { value: Readonly<WorkspaceLutDefaultVersion>; expectedRevision: number }): Promise<Readonly<{ value: Readonly<WorkspaceLutDefaultVersion>; replayed: boolean }>>
}
