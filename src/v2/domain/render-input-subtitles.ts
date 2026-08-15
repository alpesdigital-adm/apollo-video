import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  createProjectSubtitleConfiguration,
  type ProjectSubtitleConfiguration,
} from './project-subtitle-configuration.ts'
import { SUBTITLE_STYLE_REGISTRY, subtitlePresetHash, type SubtitleOrigin, type SubtitlePresetId } from './subtitle-system.ts'

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
  schemaVersion: 'render-input-subtitles/v2'
  configurationId: string
  configurationHash: string
  variantId: string
  origin: SubtitleOrigin
  enabled: boolean
  presetId: SubtitlePresetId | null
  presetVersion: 1 | null
  presetHash: string | null
  /**
   * Content address of the whole F1.033 registry the resolution was taken from. `presetHash`
   * proves *this* preset did not change; `registryHash` proves the section was materialized
   * against the same registry revision the renderer is running with. Both the compiler and the
   * renderer re-check it, so a resolution persisted before a registry revision cannot be replayed
   * into a render that would draw it differently.
   */
  registryHash: string
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
    schemaVersion: 'render-input-subtitles/v2' as const,
    configurationId: configuration.id,
    configurationHash: configuration.configurationHash,
    variantId: configuration.variantId,
    origin: configuration.origin,
    enabled: configuration.resolved.enabled,
    presetId: configuration.resolved.enabled ? configuration.resolved.presetId : null,
    presetVersion: configuration.resolved.enabled ? (1 as const) : null,
    presetHash: configuration.resolved.enabled ? configuration.resolved.presetHash : null,
    registryHash: SUBTITLE_STYLE_REGISTRY.registryHash,
    transcriptHash: configuration.transcriptHash,
    cues,
  }
  return Object.freeze({ ...body, sectionHash: calculateCanonicalHash(body) })
}

/**
 * Gate the renderer runs on the section it received. The compiler already materialized it against
 * the registry; this re-checks the same identity at render time so a section that travelled
 * through a queue, a retry or a different deploy cannot draw with a registry the resolution never
 * saw. A mismatch fails closed — the render never starts.
 */
export function requireRenderInputSubtitleRegistry<TCue>(
  section: Readonly<RenderInputSubtitleSection<TCue>>,
): Readonly<RenderInputSubtitleSection<TCue>> {
  assertDomain(section.schemaVersion === 'render-input-subtitles/v2', 'INVALID_RENDER_INPUT', 'Subtitle render input schema is unsupported')
  assertDomain(section.registryHash === SUBTITLE_STYLE_REGISTRY.registryHash, 'INVALID_RENDER_INPUT', 'Subtitle render input was materialized against a different subtitle registry')
  const { sectionHash, ...body } = section
  assertDomain(sectionHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Subtitle render input hash is inconsistent')
  if (section.enabled) {
    assertDomain(
      section.presetId !== null && section.presetVersion === 1 && section.presetHash === subtitlePresetHash(section.presetId),
      'INVALID_RENDER_INPUT', 'Subtitle render input preset drifted from the registry',
    )
  } else {
    // `none` suppresses cues and nothing else: no preset identity, but the transcript is intact.
    assertDomain(section.cues.length === 0 && section.presetId === null && section.presetHash === null, 'INVALID_RENDER_INPUT', 'Disabled subtitles cannot carry cues or a preset')
    assertDomain(/^[a-f0-9]{64}$/.test(section.transcriptHash), 'INVALID_RENDER_INPUT', 'Disabled subtitles must still carry their transcript identity')
  }
  return section
}
