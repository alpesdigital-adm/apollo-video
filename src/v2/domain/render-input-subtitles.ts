import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  createProjectSubtitleConfiguration,
  type ProjectSubtitleConfiguration,
} from './project-subtitle-configuration.ts'
import { subtitlePresetHash, type SubtitleOrigin, type SubtitlePresetId } from './subtitle-system.ts'

/**
 * Subtitle section the renderer receives inside a materialized `RenderInput`.
 *
 * The worker and the renderer never resolve a subtitle mode. They read the
 * resolution the Command already persisted and materialize it verbatim: this
 * function accepts a stored `ProjectSubtitleConfiguration` and nothing that could
 * be re-resolved (no mode, no workspace default, no Director preset). Feeding it a
 * request instead of a resolution is a type error, and a tampered stored document
 * fails the hash check below before a single frame is rendered.
 */
export interface RenderInputSubtitleSection<TCue> {
  schemaVersion: 'render-input-subtitles/v1'
  configurationId: string
  configurationHash: string
  variantId: string
  origin: SubtitleOrigin
  enabled: boolean
  presetId: SubtitlePresetId | null
  presetVersion: 1 | null
  presetHash: string | null
  transcriptHash: string
  cues: readonly TCue[]
  sectionHash: string
}

/**
 * Re-derives the stored configuration through its own constructor. A copied style
 * token, a swapped preset or an edited origin changes `configurationHash` and is
 * rejected here — the renderer refuses to guess what the operator meant.
 */
export function requirePersistedSubtitleResolution(
  configuration: Readonly<ProjectSubtitleConfiguration>,
): Readonly<ProjectSubtitleConfiguration> {
  const { schemaVersion, configurationHash, ...input } = configuration
  assertDomain(schemaVersion === 'project-subtitle-configuration/v1', 'INVALID_RENDER_INPUT', 'Subtitle resolution schema is unsupported')
  const recreated = createProjectSubtitleConfiguration(input)
  assertDomain(recreated.configurationHash === configurationHash, 'INVALID_RENDER_INPUT', 'Persisted subtitle resolution does not match its hash')
  if (recreated.resolved.enabled) {
    assertDomain(recreated.resolved.presetHash === subtitlePresetHash(recreated.resolved.presetId), 'INVALID_RENDER_INPUT', 'Persisted subtitle preset version drifted from the registry')
  }
  return recreated
}

export function materializeRenderInputSubtitles<TCue>(input: {
  configuration: Readonly<ProjectSubtitleConfiguration>
  variantId: string
  transcriptHash: string
  cues: readonly TCue[]
}): Readonly<RenderInputSubtitleSection<TCue>> {
  const configuration = requirePersistedSubtitleResolution(input.configuration)
  assertDomain(configuration.variantId === input.variantId, 'INVALID_RENDER_INPUT', 'Subtitle resolution belongs to another output variant')
  assertDomain(
    configuration.transcriptHash === input.transcriptHash,
    'INVALID_RENDER_INPUT',
    'Subtitle resolution is bound to a different transcript',
  )
  // `none` removes the rendered cues and nothing else: the transcript, its hash and
  // every audio/speech decision upstream stay exactly where they were.
  const cues = Object.freeze(configuration.resolved.enabled ? [...input.cues] : [])
  const body = {
    schemaVersion: 'render-input-subtitles/v1' as const,
    configurationId: configuration.id,
    configurationHash: configuration.configurationHash,
    variantId: configuration.variantId,
    origin: configuration.origin,
    enabled: configuration.resolved.enabled,
    presetId: configuration.resolved.enabled ? configuration.resolved.presetId : null,
    presetVersion: configuration.resolved.enabled ? (1 as const) : null,
    presetHash: configuration.resolved.enabled ? configuration.resolved.presetHash : null,
    transcriptHash: configuration.transcriptHash,
    cues,
  }
  return Object.freeze({ ...body, sectionHash: calculateCanonicalHash(body) })
}
