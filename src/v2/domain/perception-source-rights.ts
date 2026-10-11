import { evaluateAssetUse, type AssetRightsSnapshot, type AssetUseContext } from './asset-rights.ts'

/**
 * OCR, temporal and face diagnosis analyze a project's attached source master.
 * This is editing of that master, not permission to reuse a library asset.
 * Callers must separately verify attachment, workspace and immutable source identity.
 * Analysis permission never grants editorial acceptance or verified facial coverage.
 */
export function evaluatePerceptionSourceAnalysisRights(
  snapshot: Readonly<AssetRightsSnapshot> | null,
  context: Readonly<Pick<AssetUseContext, 'workspaceId' | 'locale'>>,
  now: Date,
) {
  return evaluateAssetUse(snapshot, { workspaceId: context.workspaceId,
    locale: context.locale, use: 'editing' }, now)
}
