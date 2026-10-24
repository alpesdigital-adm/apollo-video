import { DomainError } from '../domain/errors.ts'
import {
  resolveSubtitleOverridesForRender, type SubtitleOverrideRenderCue, type SubtitleSegmentOverride,
} from '../domain/subtitle-segment-override.ts'
import { defineEditorialPhraseRules, editorialRulesMatchingSpeech, type EditorialPhraseRule } from './editorial-phrase-rules.ts'

/**
 * What the Apollo was ASKED to take out of a video's speech: the `rules` of the `remove-spoken-content` Commands that made the
 * Version a Director directs. The Director holds no phrase of its own; it reads these from the project's own history.
 */
export interface SpeechRemovalLineageVersion {
  id: string
  parentVersionId: string | null
  commandId: string | null
  /** The type of the Command that made the Version (null: none). A `remove-spoken-content` Version must find its row in `commands`. */
  commandType: string | null
  forkedFromProjectId: string | null
  forkedFromVersionId: string | null
}

export interface SpeechRemovalLineageCommand {
  id: string
  type: string
  payload: Readonly<Record<string, unknown>>
}

/** One project's Versions and the Commands that matter to the walk (`remove-spoken-content` and manual undo/redo/restore). */
export interface SpeechRemovalLineageProject {
  versions: ReadonlyMap<string, Readonly<SpeechRemovalLineageVersion>>
  commands: ReadonlyMap<string, Readonly<SpeechRemovalLineageCommand>>
}

const REMOVAL_COMMAND = 'remove-spoken-content'
const MANUAL_EDIT_COMMAND = 'manual-edit'

function removalRulesOf(command: Readonly<SpeechRemovalLineageCommand>): readonly Readonly<EditorialPhraseRule>[] {
  const stored = command.payload.rules
  if (!Array.isArray(stored)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored remove-spoken-content Command has no rules', { commandId: command.id })
  }
  try {
    // The same definition the cut itself applied: ids, labels and alternatives are validated and tokenised identically.
    const rules = defineEditorialPhraseRules(stored as readonly Readonly<{ id: string; label: string; alternatives: readonly string[] }>[])
    // Only the confirmation capability writes this, with a verified actor; a client's explicit Command never carries it.
    const confirmation = command.payload.confirmation as { subject?: unknown; medium?: unknown } | undefined
    return confirmation !== undefined && typeof confirmation.subject === 'string' && (confirmation.medium === 'ui-session' || confirmation.medium === 'api-key-scope')
      ? rules.map((rule) => Object.freeze({ ...rule, confirmation: Object.freeze({ subject: confirmation.subject as string, medium: confirmation.medium as 'ui-session' | 'api-key-scope' }) }))
      : rules
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored remove-spoken-content rules are invalid', { commandId: command.id })
    }
    throw error
  }
}

/**
 * The phrase rules asked for in the lineage of `headVersionId`, newest request first. Along the parent chain every
 * `remove-spoken-content` Command contributes its rules; a manual undo/redo/restore does not add the Versions it steps over - it
 * returns to the Version it names, so the walk continues from there (what an undone removal asked is no longer asked). A forked
 * project continues in the Version it was forked from. No request in the lineage: no rules.
 */
export async function collectRequestedSpeechRemovals(input: {
  projectId: string
  headVersionId: string
  load: (projectId: string) => Promise<Readonly<SpeechRemovalLineageProject>>
}): Promise<readonly Readonly<EditorialPhraseRule>[]> {
  const rules: Readonly<EditorialPhraseRule>[] = []
  const visited = new Set<string>()
  let projectId = input.projectId
  let project = await input.load(projectId)
  let versionId: string | null = input.headVersionId
  while (versionId !== null) {
    const key = `${projectId}\u0000${versionId}`
    if (visited.has(key)) break
    visited.add(key)
    const version = project.versions.get(versionId)
    if (!version) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Director lineage names a Version that does not exist', { versionId })
    }
    const command = version.commandId === null ? undefined : project.commands.get(version.commandId)
    // Fail closed: a Version the lineage says a removal made, whose Command row is not there, would silently drop a request.
    if (version.commandType === REMOVAL_COMMAND && command?.type !== REMOVAL_COMMAND) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Director lineage names a remove-spoken-content Command that does not exist', { versionId, commandId: version.commandId })
    }
    const restores = command?.type === MANUAL_EDIT_COMMAND ? command.payload.restoresVersionId : undefined
    if (typeof restores === 'string') {
      versionId = restores
      continue
    }
    if (command?.type === REMOVAL_COMMAND) rules.push(...removalRulesOf(command))
    if (version.parentVersionId !== null) {
      versionId = version.parentVersionId
    } else if (version.forkedFromProjectId !== null && version.forkedFromVersionId !== null) {
      projectId = version.forkedFromProjectId
      project = await input.load(projectId)
      versionId = version.forkedFromVersionId
    } else {
      versionId = null
    }
  }
  return Object.freeze(rules)
}

/**
 * The requested removals that the captions a final would BURN say again. The Director checked the captions of its own plan; a text
 * exception on a caption segment (`apply-subtitle-segment-override`) made afterwards can write a removed phrase back without the Director
 * ever seeing it. So the check is repeated on what is actually drawn: the plan's cues with the output's exceptions applied (a hidden cue
 * says nothing), judged with the same phrase tokens the cut used. Returns the ids of the rules whose phrase is present, in rule order.
 */
export function requestedSpeechReintroducedByCaptions(input: {
  rules: readonly Readonly<EditorialPhraseRule>[]
  cues: readonly Readonly<SubtitleOverrideRenderCue>[]
  overrides: readonly Readonly<SubtitleSegmentOverride>[]
  variantId: string
}): readonly string[] {
  if (input.rules.length === 0) return Object.freeze([])
  const drawn = resolveSubtitleOverridesForRender({ cues: input.cues, overrides: input.overrides, variantId: input.variantId }).cues
  return Object.freeze(editorialRulesMatchingSpeech(drawn.map((cue) => cue.text).join(' '), input.rules))
}
