import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type { CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'
import {
  SUBTITLE_MODES,
  SUBTITLE_ORIGINS,
  subtitlePresetHash,
  type SubtitleConfig,
  type SubtitleMode,
  type SubtitleModeRequest,
  type SubtitleOrigin,
  type SubtitlePresetId,
} from './subtitle-system.ts'

/**
 * Actions the closed subtitle state machine accepts.
 *
 * `set` moves the variant to one of the four modes. `revert` re-applies the mode
 * the variant carried before the current configuration — the panel's "back to the
 * workspace level" affordance — and it is a real Command, never a silent rollback
 * of an immutable ProjectVersion.
 */
export const PROJECT_SUBTITLE_CONFIGURATION_ACTIONS = ['set', 'revert'] as const
export type ProjectSubtitleConfigurationAction = (typeof PROJECT_SUBTITLE_CONFIGURATION_ACTIONS)[number]

export interface ProjectSubtitleConfiguration {
  schemaVersion: 'project-subtitle-configuration/v1'
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  resultVersionId: string
  commandId: string
  variantId: string
  action: ProjectSubtitleConfigurationAction
  /** Configuration this one replaced on the same variant, or null for the first. */
  previousConfigurationId: string | null
  requested: SubtitleModeRequest
  resolved: SubtitleConfig['resolved']
  origin: SubtitleOrigin
  transcriptHash: string
  workspaceDefaultRevision?: number
  configurationHash: string
  createdAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && SHA256.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

export function createProjectSubtitleConfiguration(
  input: Omit<ProjectSubtitleConfiguration, 'schemaVersion' | 'configurationHash'>,
): Readonly<ProjectSubtitleConfiguration> {
  assertDomain(
    [input.id, input.workspaceId, input.projectId, input.baseVersionId, input.resultVersionId, input.commandId, input.variantId].every((value) => ID.test(value)),
    'INVALID_ARGUMENT',
    'Subtitle configuration identity is invalid',
  )
  assertDomain(PROJECT_SUBTITLE_CONFIGURATION_ACTIONS.includes(input.action), 'INVALID_ARGUMENT', 'Subtitle configuration action is invalid')
  assertDomain(
    input.previousConfigurationId === null || (typeof input.previousConfigurationId === 'string' && ID.test(input.previousConfigurationId)),
    'INVALID_ARGUMENT',
    'Subtitle configuration previousConfigurationId is invalid',
  )
  assertDomain(input.previousConfigurationId !== input.id, 'INVALID_ARGUMENT', 'Subtitle configuration cannot replace itself')
  assertDomain(input.action !== 'revert' || input.previousConfigurationId !== null, 'INVALID_ARGUMENT', 'A revert must cite the configuration it replaced')
  assertDomain(SUBTITLE_MODES.includes(input.requested.mode), 'INVALID_ARGUMENT', 'Subtitle configuration mode is invalid')
  assertDomain(SUBTITLE_ORIGINS.includes(input.origin), 'INVALID_ARGUMENT', 'Subtitle configuration origin is invalid')
  assertDomain(SHA256.test(input.transcriptHash), 'INVALID_ARGUMENT', 'Subtitle configuration transcript hash is invalid')
  assertDomain((input.requested.mode === 'none') === (input.origin === 'disabled'), 'INVALID_ARGUMENT', 'Subtitle configuration disabled state is inconsistent')
  assertDomain(input.resolved.enabled === (input.origin !== 'disabled'), 'INVALID_ARGUMENT', 'Subtitle configuration resolution is inconsistent')
  if (input.resolved.enabled) {
    assertDomain(
      input.resolved.presetVersion === 1 && input.resolved.presetHash === subtitlePresetHash(input.resolved.presetId),
      'INVALID_ARGUMENT',
      'Subtitle configuration must reference a registered preset by id and version hash',
    )
  }
  assertDomain(
    (input.requested.mode === 'workspace-default') === (input.workspaceDefaultRevision !== undefined),
    'INVALID_ARGUMENT',
    'Only workspace-default carries a workspace default revision',
  )
  assertDomain(!Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'Subtitle configuration createdAt is invalid')
  const body = Object.freeze({ schemaVersion: 'project-subtitle-configuration/v1' as const, ...input })
  return Object.freeze({ ...body, configurationHash: calculateCanonicalHash(body) })
}

export interface ProjectSubtitleConfigurationImpactV1 {
  schemaVersion: 'project-subtitle-configuration-impact/v1'
  commandId: string
  commandType: 'set-project-subtitle-mode'
  baseVersionId: string
  resultVersionId: string
  variantId: string
  configurationId: string
  configurationHash: string
  action: ProjectSubtitleConfigurationAction
  requestedMode: SubtitleMode
  origin: SubtitleOrigin
  /** Versioned preset reference — never a copy of the mutable style tokens. */
  resolvedPresetId: SubtitlePresetId | null
  resolvedPresetHash: string | null
  /** Byte-identical across every mode and preset change; the transcript never moves. */
  transcriptHash: string
  changeKinds: readonly ['subtitle-configuration']
  dependencyTypes: readonly ['visual']
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  minimalRenders: readonly Readonly<{ kind: 'proxy'; variantId: string; ranges: readonly Readonly<CommandImpactRange>[] }>[]
  renderSemanticsChanged: true
  renderDeferredUntilTimeline: boolean
  impactHash: string
}

export function createProjectSubtitleConfigurationImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  variantId: string
  configurationId: string
  configurationHash: string
  action: ProjectSubtitleConfigurationAction
  requestedMode: SubtitleMode
  origin: SubtitleOrigin
  resolvedPresetId?: SubtitlePresetId | null
  resolvedPresetHash?: string | null
  transcriptHash: string
  durationFrames: number
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<ProjectSubtitleConfigurationImpactV1> {
  assertDomain(Number.isSafeInteger(input.durationFrames) && input.durationFrames >= 0, 'INVALID_ARGUMENT', 'Subtitle impact duration is invalid')
  assertDomain(PROJECT_SUBTITLE_CONFIGURATION_ACTIONS.includes(input.action), 'INVALID_ARGUMENT', 'Subtitle impact action is invalid')
  assertDomain(SUBTITLE_MODES.includes(input.requestedMode), 'INVALID_ARGUMENT', 'Subtitle impact requestedMode is invalid')
  assertDomain(SUBTITLE_ORIGINS.includes(input.origin), 'INVALID_ARGUMENT', 'Subtitle impact origin is invalid')
  assertDomain((input.requestedMode === 'none') === (input.origin === 'disabled'), 'INVALID_ARGUMENT', 'Subtitle impact disabled state is inconsistent')
  const enabled = input.origin !== 'disabled'
  assertDomain(
    enabled
      ? typeof input.resolvedPresetId === 'string' && typeof input.resolvedPresetHash === 'string'
      : (input.resolvedPresetId ?? null) === null && (input.resolvedPresetHash ?? null) === null,
    'INVALID_ARGUMENT',
    'Subtitle impact preset reference is inconsistent with its origin',
  )
  const baseVersionId = identifier(input.baseVersionId, 'baseVersionId')
  const variantId = identifier(input.variantId, 'variantId')
  assertDomain(input.durationFrames > 0 || input.affectedArtifacts.length === 0, 'INVALID_ARGUMENT', 'outputs cannot exist before a renderable timeline')
  const seen = new Set<string>()
  const outputs = input.affectedArtifacts
    .filter((item) => item.variantId === variantId)
    .map((item, index) => {
      const artifactId = identifier(item.artifactId, `affectedArtifacts[${index}].artifactId`)
      const sourceVersionId = identifier(item.sourceVersionId, `affectedArtifacts[${index}].sourceVersionId`)
      assertDomain(item.kind === 'proxy' || item.kind === 'final', 'INVALID_ARGUMENT', `affectedArtifacts[${index}].kind is invalid`)
      assertDomain(sourceVersionId === baseVersionId, 'INVALID_ARGUMENT', `affectedArtifacts[${index}] belongs to another version`)
      assertDomain(!seen.has(artifactId), 'INVALID_ARGUMENT', `affectedArtifacts[${index}].artifactId is duplicated`)
      seen.add(artifactId)
      return Object.freeze({ artifactId, sourceVersionId, variantId: identifier(item.variantId, `affectedArtifacts[${index}].variantId`), kind: item.kind })
    })
    .sort((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
  const range = input.durationFrames > 0 ? Object.freeze({ startFrame: 0, endFrame: input.durationFrames }) : undefined
  const body = {
    schemaVersion: 'project-subtitle-configuration-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'set-project-subtitle-mode' as const,
    baseVersionId,
    resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    variantId,
    configurationId: identifier(input.configurationId, 'configurationId'),
    configurationHash: sha256(input.configurationHash, 'configurationHash'),
    action: input.action,
    requestedMode: input.requestedMode,
    origin: input.origin,
    resolvedPresetId: enabled ? (input.resolvedPresetId as SubtitlePresetId) : null,
    resolvedPresetHash: enabled ? sha256(input.resolvedPresetHash, 'resolvedPresetHash') : null,
    transcriptHash: sha256(input.transcriptHash, 'transcriptHash'),
    changeKinds: Object.freeze(['subtitle-configuration'] as const),
    dependencyTypes: Object.freeze(['visual'] as const),
    affectedRanges: Object.freeze(range ? [range] : []),
    affectedVariantIds: Object.freeze(outputs.length > 0 ? [variantId] : []),
    affectedArtifacts: Object.freeze(outputs),
    minimalRenders: Object.freeze(range ? [Object.freeze({ kind: 'proxy' as const, variantId, ranges: Object.freeze([range]) })] : []),
    renderSemanticsChanged: true as const,
    renderDeferredUntilTimeline: input.durationFrames === 0,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

const IMPACT_KEYS = [
  'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId', 'variantId',
  'configurationId', 'configurationHash', 'action', 'requestedMode', 'origin', 'resolvedPresetId',
  'resolvedPresetHash', 'transcriptHash', 'changeKinds', 'dependencyTypes', 'affectedRanges',
  'affectedVariantIds', 'affectedArtifacts', 'minimalRenders', 'renderSemanticsChanged',
  'renderDeferredUntilTimeline', 'impactHash',
].sort()

export function parseProjectSubtitleConfigurationImpact(value: unknown): Readonly<ProjectSubtitleConfigurationImpactV1> {
  const impact = record(value, 'project subtitle configuration impact') as unknown as ProjectSubtitleConfigurationImpactV1
  const actualKeys = Object.keys(impact).sort()
  const affected = Array.isArray(impact.affectedRanges) ? impact.affectedRanges[0] : undefined
  const minimal = Array.isArray(impact.minimalRenders) ? impact.minimalRenders[0] : undefined
  const render = minimal && Array.isArray(minimal.ranges) ? minimal.ranges[0] : undefined
  assertDomain(
    actualKeys.length === IMPACT_KEYS.length && actualKeys.every((key, index) => key === IMPACT_KEYS[index]),
    'PERSISTENCE_CONFLICT',
    'Stored project subtitle configuration impact fields are invalid',
  )
  assertDomain(
    impact.schemaVersion === 'project-subtitle-configuration-impact/v1'
    && impact.commandType === 'set-project-subtitle-mode'
    && impact.renderSemanticsChanged === true
    && typeof impact.renderDeferredUntilTimeline === 'boolean'
    && JSON.stringify(impact.changeKinds) === JSON.stringify(['subtitle-configuration'])
    && JSON.stringify(impact.dependencyTypes) === JSON.stringify(['visual'])
    && PROJECT_SUBTITLE_CONFIGURATION_ACTIONS.includes(impact.action)
    && SUBTITLE_MODES.includes(impact.requestedMode)
    && SUBTITLE_ORIGINS.includes(impact.origin)
    && (impact.requestedMode === 'none') === (impact.origin === 'disabled')
    && (impact.origin === 'disabled'
      ? impact.resolvedPresetId === null && impact.resolvedPresetHash === null
      : typeof impact.resolvedPresetId === 'string' && typeof impact.resolvedPresetHash === 'string')
    && Array.isArray(impact.affectedRanges) && impact.affectedRanges.length === (impact.renderDeferredUntilTimeline ? 0 : 1)
    && (impact.renderDeferredUntilTimeline || (affected?.startFrame === 0 && Number.isSafeInteger(affected?.endFrame) && Number(affected?.endFrame) > 0))
    && Array.isArray(impact.affectedVariantIds) && Array.isArray(impact.affectedArtifacts)
    && impact.affectedVariantIds.every((item) => item === impact.variantId)
    && impact.affectedArtifacts.every((item) => item.variantId === impact.variantId)
    && Array.isArray(impact.minimalRenders) && impact.minimalRenders.length === (impact.renderDeferredUntilTimeline ? 0 : 1)
    && (impact.renderDeferredUntilTimeline
      ? impact.affectedArtifacts.length === 0 && impact.affectedVariantIds.length === 0
      : minimal?.kind === 'proxy' && minimal.variantId === impact.variantId && Array.isArray(minimal.ranges) && minimal.ranges.length === 1
        && render?.startFrame === 0 && render?.endFrame === affected?.endFrame),
    'PERSISTENCE_CONFLICT',
    'Stored project subtitle configuration impact is invalid',
  )
  sha256(impact.impactHash, 'impactHash')
  const recreated = createProjectSubtitleConfigurationImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    variantId: impact.variantId,
    configurationId: impact.configurationId,
    configurationHash: impact.configurationHash,
    action: impact.action,
    requestedMode: impact.requestedMode,
    origin: impact.origin,
    resolvedPresetId: impact.resolvedPresetId,
    resolvedPresetHash: impact.resolvedPresetHash,
    transcriptHash: impact.transcriptHash,
    durationFrames: impact.renderDeferredUntilTimeline ? 0 : affected!.endFrame,
    affectedArtifacts: impact.affectedArtifacts,
  })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored project subtitle configuration impact is inconsistent')
  return Object.freeze(impact)
}

/**
 * Requested mode a `revert` re-applies on one variant.
 *
 * The variant returns to the mode it carried before the current configuration.
 * When the current configuration is the first one, the variant returns to the
 * inherited automatic resolution — the Director's preset — which is exactly what
 * the panel calls "back to the level above".
 */
export function resolveProjectSubtitleRevertTarget(input: {
  current?: Readonly<ProjectSubtitleConfiguration> | null
  previous?: Readonly<ProjectSubtitleConfiguration> | null
}): SubtitleModeRequest {
  assertDomain(!!input.current, 'INVALID_ARGUMENT', 'There is no subtitle configuration to revert on this variant')
  const previous = input.previous ?? null
  if (!previous) return Object.freeze({ mode: 'auto' as const })
  assertDomain(previous.id !== input.current!.id, 'INVALID_ARGUMENT', 'Subtitle revert target cannot be the current configuration')
  assertDomain(previous.variantId === input.current!.variantId, 'INVALID_ARGUMENT', 'Subtitle revert target belongs to another variant')
  return Object.freeze({ ...previous.requested })
}
