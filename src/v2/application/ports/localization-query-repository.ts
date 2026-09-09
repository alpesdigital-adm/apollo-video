import type { CanonicalScriptVersion, LocalizationVariant, LocalizedAudioMode } from '../../domain/localization.ts'

export interface LocalizationCandidate { alignmentId: string; alignmentHash: string; batchId: string; projectVersionId: string; sourceLocale: string; blocks: readonly { sourceScriptBlockId: string; role: string; text: string; sourceRangeMs: readonly [number, number]; reviewStatus: string }[] }
export interface LocalizationProfileSummary { id: string; targetLocale: string; market?: string; allowedModes: readonly LocalizedAudioMode[]; profileHash: string }
export type LocalizationVariantView = Readonly<LocalizationVariant & {
  allowedModes: readonly { mode: LocalizedAudioMode; allowed: boolean; reasons: readonly string[] }[]
  stale: { isStale: boolean; latestCanonicalScriptVersionId?: string }
}>

export interface LocalizationQueryRepository {
  listCanonicals(input: { workspaceId: string; projectId: string }): Promise<readonly CanonicalScriptVersion[]>
  listCandidates(input: { workspaceId: string; projectId: string }): Promise<readonly LocalizationCandidate[]>
  listProfiles(input: { workspaceId: string }): Promise<readonly LocalizationProfileSummary[]>
  listVariants(input: { workspaceId: string; projectId: string }): Promise<readonly LocalizationVariantView[]>
  readVariant(input: { workspaceId: string; projectId: string; variantId: string }): Promise<LocalizationVariantView | null>
}
