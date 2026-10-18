import test from 'node:test'
import assert from 'node:assert/strict'

import { setProjectSubtitleConfigurationService, readProjectSubtitleConfigurationService } from '../../src/v2/application/project-subtitle-configurations.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { materializeRenderInputSubtitles, requirePersistedSubtitleResolution } from '../../src/v2/domain/render-input-subtitles.ts'
import { parseProjectSubtitleConfigurationImpact, resolveProjectSubtitleRevertTarget } from '../../src/v2/domain/project-subtitle-configuration.ts'
import {
  SUBTITLE_MODES,
  SUBTITLE_PRESETS,
  materializeSubtitleRenderPolicy,
  resolveSubtitleConfig,
  subtitlePresetHash,
  validateSubtitleConfig,
} from '../../src/v2/domain/subtitle-system.ts'
import { parseSetProjectSubtitleConfigurationBody, presentProjectSubtitleResolution } from '../../src/v2/public-api/project-subtitle-configuration-contract.ts'
import { twoOutputIngestedWorld, untouchedFacts } from './helpers/m3-two-output-world.mjs'

/** One immutable transcript. Every assertion below re-hashes this exact object. */
const transcript = Object.freeze({ id: 'transcript-immutable-1', words: Object.freeze([Object.freeze({ text: 'A fala continua', startFrame: 0, endFrame: 30 })]) })
const TRANSCRIPT_HASH = calculateCanonicalHash(transcript)
const TRANSCRIPT_BYTES = stableSerialize(transcript)
const cues = Object.freeze([Object.freeze({ id: 'cue-1', startFrame: 0, endFrame: 30, text: 'A fala continua' })])

// Every Command below is born from a real sealed Version3/State3 of the two-output world (a 16:9 and a 9:16 output over one
// ingest), and each result becomes the sealed parent of the next one. `variantId` is the STABLE State variant id, never a ratio.
const world = await twoOutputIngestedWorld()
const VERTICAL = world.verticalVariantId
const WIDE = world.wideVariantId
const genesis = world.parent.version
const WORKSPACE = genesis.workspaceId
const PROJECT = genesis.projectId
const actor = world.actor

/** Outputs always belong to the version they were rendered from, each attributed to its output — like the real adapter. */
const outputsOf = (versionId) => Object.freeze([
  Object.freeze({ artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: versionId, variantId: VERTICAL }),
  Object.freeze({ artifactId: 'final-9x16', kind: 'final', sourceVersionId: versionId, variantId: VERTICAL }),
  Object.freeze({ artifactId: 'proxy-16x9', kind: 'proxy', sourceVersionId: versionId, variantId: WIDE }),
  Object.freeze({ artifactId: 'final-16x9', kind: 'final', sourceVersionId: versionId, variantId: WIDE }),
])

/**
 * In-memory stand-in for the Prisma repository. It keeps the same invariants the
 * PostgreSQL adapter enforces: one head per (project, variant), an append-only
 * configuration chain, optimistic concurrency on the current version, and replay
 * keyed by idempotency key plus request fingerprint.
 */
function repository(options = {}) {
  const configurations = new Map()
  const heads = new Map()
  const commands = new Map()
  let current = options.parent ?? world.parent
  return {
    get currentVersion() { return current.version },
    get currentBundle() { return current },
    get configurations() { return configurations },
    async findIdempotent({ idempotencyKey }) { return commands.get(idempotencyKey) ?? null },
    async readContext({ variantId }) {
      const headId = heads.get(variantId)
      const currentConfiguration = headId ? configurations.get(headId) : null
      const previousConfiguration = currentConfiguration?.previousConfigurationId ? configurations.get(currentConfiguration.previousConfigurationId) : null
      return Object.freeze({
        parent: current,
        transcript,
        directorPresetId: 'kinetic',
        ...(options.withoutWorkspaceDefault ? {} : { workspaceDefault: { presetId: 'clean-color', revision: 4 } }),
        durationFrames: 90,
        outputReferences: outputsOf(current.version.id),
        currentConfiguration: currentConfiguration ?? null,
        previousConfiguration: previousConfiguration ?? null,
      })
    },
    async commitOrReplay(input) {
      const { command, requestFingerprint } = input.bundle.origin
      if (current.version.id !== command.baseVersionId || current.version.baseHash !== command.baseHash) {
        throw Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT' })
      }
      const head = heads.get(input.configuration.variantId) ?? null
      assert.equal(head, input.configuration.previousConfigurationId, 'the head must be the configuration the commit says it replaces')
      configurations.set(input.configuration.id, input.configuration)
      heads.set(input.configuration.variantId, input.configuration.id)
      current = input.bundle
      const result = Object.freeze({ command, version: input.bundle.version, configuration: input.configuration, impact: input.impact, replayed: false })
      commands.set(command.idempotencyKey, Object.freeze({ requestFingerprint, result: Object.freeze({ ...result, replayed: true }) }))
      return result
    },
    async readCurrent({ variantId }) {
      const headId = heads.get(variantId)
      if (!headId) return null
      const configuration = configurations.get(headId)
      return Object.freeze({ command: { id: configuration.commandId, type: 'set-project-subtitle-mode', baseVersionId: configuration.baseVersionId, author: { type: 'api-client', id: actor.clientId }, createdAt: configuration.createdAt }, version: current.version, configuration, impact: null, replayed: false })
    },
  }
}

let sequence = 0
const run = (repo, body, key) => setProjectSubtitleConfigurationService({
  repository: repo,
  createId: (kind) => `subtitle-${kind}-${(sequence += 1).toString().padStart(4, '0')}`,
  clock: () => new Date('2026-08-13T20:01:00.000Z'),
})({ workspaceId: WORKSPACE, projectId: PROJECT, baseVersionId: repo.currentVersion.id, baseHash: repo.currentVersion.baseHash, variantId: VERTICAL, actor, idempotencyKey: key, ...body })

// 1/9 ------------------------------------------------------------------------
test('T-FR-171 the union of modes is closed and each mode resolves exactly one origin', () => {
  assert.deepEqual([...SUBTITLE_MODES], ['auto', 'workspace-default', 'manual', 'none'])
  const cases = [
    [{ mode: 'auto' }, 'director', 'kinetic'],
    [{ mode: 'workspace-default' }, 'workspace', 'clean-color'],
    [{ mode: 'manual', presetId: 'caps-stroke', presetVersion: 1 }, 'project', 'caps-stroke'],
    [{ mode: 'none' }, 'disabled', undefined],
  ]
  for (const [requested, origin, presetId] of cases) {
    const config = resolveSubtitleConfig({ requested, variantId: VERTICAL, transcript, directorPreset: 'kinetic', workspacePreset: 'clean-color', workspaceDefaultRevision: 4 })
    validateSubtitleConfig(config, transcript)
    assert.equal(config.origin, origin)
    assert.equal(config.resolved.presetId, presetId)
  }
  // Nothing outside the union resolves, and an unregistered preset never resolves.
  for (const mode of ['default', 'workspace', 'burned-in', 'AUTO', '']) {
    assert.throws(() => resolveSubtitleConfig({ requested: { mode }, variantId: VERTICAL, transcript, directorPreset: 'kinetic' }), /unsupported/)
  }
  assert.throws(() => resolveSubtitleConfig({ requested: { mode: 'manual', presetId: 'future-preset', presetVersion: 1 }, variantId: VERTICAL, transcript, directorPreset: 'kinetic' }), /registered/)
})

// 2/9 ------------------------------------------------------------------------
test('T-FR-171 the transcript hash is byte-identical across every mode and preset swap', async () => {
  const observed = new Set()
  for (const presetId of Object.keys(SUBTITLE_PRESETS)) {
    for (const requested of [{ mode: 'auto' }, { mode: 'workspace-default' }, { mode: 'manual', presetId, presetVersion: 1 }, { mode: 'none' }]) {
      const config = resolveSubtitleConfig({ requested, variantId: VERTICAL, transcript, directorPreset: presetId, workspacePreset: presetId, workspaceDefaultRevision: 4 })
      observed.add(config.transcriptHash)
    }
  }
  // 5 presets x 4 modes = 20 resolutions, one single transcript hash.
  assert.equal(observed.size, 1)
  assert.deepEqual([...observed], [TRANSCRIPT_HASH])

  // The same holds end to end, through persisted Commands on the real service.
  const repo = repository()
  const hashes = new Set()
  const bodies = [
    { action: 'set', requested: { mode: 'auto' } },
    { action: 'set', requested: { mode: 'workspace-default' } },
    { action: 'set', requested: { mode: 'manual', presetId: 'karaoke-pill', presetVersion: 1 } },
    { action: 'set', requested: { mode: 'none' } },
    { action: 'set', requested: { mode: 'manual', presetId: 'kinetic', presetVersion: 1 } },
  ]
  for (const [index, body] of bodies.entries()) {
    const result = await run(repo, body, `subtitle-hash-key-${index}`)
    hashes.add(result.configuration.transcriptHash)
    hashes.add(result.impact.transcriptHash)
  }
  assert.deepEqual([...hashes], [TRANSCRIPT_HASH], 'five persisted mode changes, one transcript hash')
  // And the transcript document itself never moved a byte.
  assert.equal(stableSerialize(transcript), TRANSCRIPT_BYTES)
  assert.equal(transcript.words[0].text, 'A fala continua')
})

// 3/9 ------------------------------------------------------------------------
test('T-FR-171 the resolution references a preset by versioned identity, never by copied style', async () => {
  const repo = repository()
  const result = await run(repo, { action: 'set', requested: { mode: 'manual', presetId: 'caps-stroke', presetVersion: 1 } }, 'subtitle-preset-key-1')
  const { resolved } = result.configuration
  assert.deepEqual(Object.keys(resolved).toSorted(), ['enabled', 'presetHash', 'presetId', 'presetVersion'])
  assert.equal(resolved.presetId, 'caps-stroke')
  assert.equal(resolved.presetVersion, 1)
  assert.equal(resolved.presetHash, subtitlePresetHash('caps-stroke'))
  assert.match(resolved.presetHash, /^[a-f0-9]{64}$/)
  // No mutable style token was copied into the persisted document.
  const serialized = stableSerialize(result.configuration)
  for (const token of ['fontFamily', 'Archivo Black', 'maxCharacters', 'reducedMotion', 'radius']) {
    assert.equal(serialized.includes(token), false, `${token} must not be copied into the configuration`)
  }
  // Every canonical F1.033 preset id is addressable and hashes distinctly.
  const hashes = Object.keys(SUBTITLE_PRESETS).map((presetId) => subtitlePresetHash(presetId))
  assert.deepEqual(Object.keys(SUBTITLE_PRESETS).toSorted(), ['caps-stroke', 'clean-color', 'karaoke-box', 'karaoke-pill', 'kinetic'])
  assert.equal(new Set(hashes).size, hashes.length)
  // A drifted preset reference is refused before it can reach a renderer, and so is
  // a document whose identity hash no longer matches its content.
  assert.throws(
    () => requirePersistedSubtitleResolution({ ...result.configuration, resolved: { ...resolved, presetHash: 'f'.repeat(64) } }),
    /registered preset by id and version hash/,
  )
  assert.throws(
    () => requirePersistedSubtitleResolution({ ...result.configuration, configurationHash: 'f'.repeat(64) }),
    /does not match its hash/,
  )
})

// 4/9 ------------------------------------------------------------------------
test('T-FR-171 auto resolves the Director preset and workspace-default inherits the workspace revision', async () => {
  const auto = await run(repository(), { action: 'set', requested: { mode: 'auto' } }, 'subtitle-auto-key-1')
  assert.equal(auto.configuration.origin, 'director')
  assert.equal(auto.configuration.resolved.presetId, 'kinetic')
  assert.equal(auto.configuration.workspaceDefaultRevision, undefined)

  const inherited = await run(repository(), { action: 'set', requested: { mode: 'workspace-default' } }, 'subtitle-workspace-key-1')
  assert.equal(inherited.configuration.origin, 'workspace')
  assert.equal(inherited.configuration.resolved.presetId, 'clean-color')
  assert.equal(inherited.configuration.workspaceDefaultRevision, 4, 'the inherited default is pinned to an immutable revision')

  // Inheriting from a workspace that declares no default is refused, not guessed.
  await assert.rejects(
    run(repository({ withoutWorkspaceDefault: true }), { action: 'set', requested: { mode: 'workspace-default' } }, 'subtitle-workspace-key-2'),
    /Workspace subtitle default is not configured/,
  )
})

// 5/9 ------------------------------------------------------------------------
test('T-FR-171 manual wins only on the target variant and leaves the other variants inherited', async () => {
  const repo = repository()
  const manual = await run(repo, { action: 'set', requested: { mode: 'manual', presetId: 'karaoke-box', presetVersion: 1 } }, 'subtitle-variant-key-1')
  assert.equal(manual.configuration.variantId, VERTICAL)
  assert.equal(manual.configuration.origin, 'project')
  assert.deepEqual(manual.command.scope.outputVariantIds, [VERTICAL])
  assert.equal(manual.command.scope.outputSpecIds, undefined, 'the scope names stable variants, not format aliases')

  const read = readProjectSubtitleConfigurationService({ repository: repo })
  assert.equal((await read({ workspaceId: WORKSPACE, projectId: PROJECT, variantId: VERTICAL })).configuration.origin, 'project')
  assert.equal(await read({ workspaceId: WORKSPACE, projectId: PROJECT, variantId: WIDE }), null, '16:9 stays inherited')

  // The impact never widens past the target variant, even though the 16:9 output has a proxy and a final of its own.
  assert.deepEqual(manual.impact.affectedArtifacts.map((item) => item.artifactId).toSorted(), ['final-9x16', 'proxy-9x16'])
  assert.deepEqual([...manual.impact.affectedVariantIds], [VERTICAL])
  assert.deepEqual([...manual.impact.affectedRanges], [{ startFrame: 0, endFrame: 90 }])
  assert.deepEqual([...manual.impact.minimalRenders], [{ kind: 'proxy', variantId: VERTICAL, ranges: [{ startFrame: 0, endFrame: 90 }] }])
  assert.equal(parseProjectSubtitleConfigurationImpact(JSON.parse(JSON.stringify(manual.impact))).impactHash, manual.impact.impactHash)

  // A second variant is configured independently and does not disturb the first.
  const otherVariant = await setProjectSubtitleConfigurationService({ repository: repo, createId: (kind) => `subtitle-${kind}-other-${(sequence += 1)}`, clock: () => new Date('2026-08-13T20:02:00.000Z') })({
    workspaceId: WORKSPACE, projectId: PROJECT, baseVersionId: repo.currentVersion.id, baseHash: repo.currentVersion.baseHash,
    variantId: WIDE, action: 'set', requested: { mode: 'none' }, actor, idempotencyKey: 'subtitle-variant-key-2',
  })
  assert.equal(otherVariant.configuration.origin, 'disabled')
  assert.equal(otherVariant.configuration.previousConfigurationId, null, 'the 16:9 head had no predecessor')
  assert.equal((await read({ workspaceId: WORKSPACE, projectId: PROJECT, variantId: VERTICAL })).configuration.resolved.presetId, 'karaoke-box')
})

// 6/9 ------------------------------------------------------------------------
test('T-FR-171 none produces a RenderInput that keeps the speech audio and carries zero cues', async () => {
  const repo = repository()
  await run(repo, { action: 'set', requested: { mode: 'manual', presetId: 'kinetic', presetVersion: 1 } }, 'subtitle-none-key-0')
  const disabled = await run(repo, { action: 'set', requested: { mode: 'none' } }, 'subtitle-none-key-1')
  assert.equal(disabled.configuration.origin, 'disabled')
  assert.equal(disabled.configuration.resolved.enabled, false)

  const section = materializeRenderInputSubtitles({ configuration: disabled.configuration, variantId: VERTICAL, transcriptHash: TRANSCRIPT_HASH, cues })
  assert.deepEqual([...section.cues], [], 'no cue reaches the renderer')
  assert.equal(section.presetId, null)
  assert.equal(section.presetHash, null)
  assert.equal(section.transcriptHash, TRANSCRIPT_HASH, 'the transcript binding survives the disable')

  const spec = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: '1'.repeat(64) },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: 'plan-subtitle', versionId: disabled.version.id, hash: '2'.repeat(64) },
    output: { id: 'preset-9x16', locale: 'pt-BR', aspectRatio: '9:16', width: 1080, height: 1920, fps: 30, safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames: 90 },
    assets: [
      { id: 'asset-primary', artifactId: 'artifact-primary', artifactKey: 'workspaces/1/masters/source.mp4', kind: 'video', role: 'primary', ordinal: 0, sha256: '3'.repeat(64), byteSize: 4096 },
      { id: 'asset-speech', artifactId: 'artifact-speech', artifactKey: 'workspaces/1/masters/speech.wav', kind: 'audio', role: 'speech', ordinal: 1, sha256: '4'.repeat(64), byteSize: 2048 },
    ],
    props: { subtitles: [...section.cues], subtitleOrigin: section.origin, subtitleTranscriptHash: section.transcriptHash },
  })
  assert.deepEqual(spec.props.subtitles, [], 'the RenderInput carries zero cues')
  assert.equal(spec.assets.some((asset) => asset.kind === 'audio' && asset.role === 'speech'), true, 'the speech audio is still rendered')
  assert.equal(spec.props.subtitleTranscriptHash, TRANSCRIPT_HASH)
  // The transcript and its evidence were not deleted or rewritten.
  assert.equal(stableSerialize(transcript), TRANSCRIPT_BYTES)
  assert.deepEqual(materializeSubtitleRenderPolicy(resolveSubtitleConfig({ requested: { mode: 'none' }, variantId: VERTICAL, transcript, directorPreset: 'kinetic' }), cues).cues, [])
})

// 7/9 ------------------------------------------------------------------------
test('T-FR-171 the worker consumes the persisted resolution exactly and never re-resolves it', async () => {
  const repo = repository()
  const applied = await run(repo, { action: 'set', requested: { mode: 'manual', presetId: 'clean-color', presetVersion: 1 } }, 'subtitle-worker-key-1')
  const section = materializeRenderInputSubtitles({ configuration: applied.configuration, variantId: VERTICAL, transcriptHash: TRANSCRIPT_HASH, cues })
  assert.equal(section.presetId, 'clean-color')
  assert.equal(section.presetHash, applied.configuration.resolved.presetHash)
  assert.equal(section.origin, 'project')
  assert.deepEqual([...section.cues], [...cues])
  // Same stored document in, same section hash out: the materialization is a
  // projection of the persisted resolution, not a fresh decision.
  assert.equal(materializeRenderInputSubtitles({ configuration: applied.configuration, variantId: VERTICAL, transcriptHash: TRANSCRIPT_HASH, cues }).sectionHash, section.sectionHash)
  // A resolution belonging to another variant or another transcript is refused.
  assert.throws(() => materializeRenderInputSubtitles({ configuration: applied.configuration, variantId: WIDE, transcriptHash: TRANSCRIPT_HASH, cues }), /another output variant/)
  assert.throws(() => materializeRenderInputSubtitles({ configuration: applied.configuration, variantId: VERTICAL, transcriptHash: 'b'.repeat(64), cues }), /different transcript/)
  // A tampered origin cannot survive: the hash is recomputed from the document.
  assert.throws(() => materializeRenderInputSubtitles({ configuration: { ...applied.configuration, origin: 'workspace' }, variantId: VERTICAL, transcriptHash: TRANSCRIPT_HASH, cues }), /does not match its hash/)
})

// 8/9 ------------------------------------------------------------------------
test('T-FR-171 revert returns the variant to the previous origin and is itself a Command', async () => {
  const repo = repository()
  const workspace = await run(repo, { action: 'set', requested: { mode: 'workspace-default' } }, 'subtitle-revert-key-1')
  const manual = await run(repo, { action: 'set', requested: { mode: 'manual', presetId: 'caps-stroke', presetVersion: 1 } }, 'subtitle-revert-key-2')
  assert.equal(manual.configuration.previousConfigurationId, workspace.configuration.id)

  assert.deepEqual(resolveProjectSubtitleRevertTarget({ current: manual.configuration, previous: workspace.configuration }), { mode: 'workspace-default' })
  const reverted = await run(repo, { action: 'revert' }, 'subtitle-revert-key-3')
  assert.equal(reverted.configuration.action, 'revert')
  assert.equal(reverted.configuration.origin, 'workspace', 'the panel switched back to the workspace level')
  assert.equal(reverted.configuration.resolved.presetId, 'clean-color')
  assert.equal(reverted.configuration.workspaceDefaultRevision, 4)
  assert.equal(reverted.configuration.previousConfigurationId, manual.configuration.id)
  assert.equal(reverted.command.type, 'set-project-subtitle-mode')
  assert.equal(reverted.version.parentVersionId, manual.version.id, 'the override version stays in history')
  assert.equal(reverted.configuration.transcriptHash, TRANSCRIPT_HASH)

  // Reverting the first configuration of a variant returns to the inherited auto.
  const fresh = repository()
  const first = await run(fresh, { action: 'set', requested: { mode: 'none' } }, 'subtitle-revert-key-4')
  assert.equal(first.configuration.previousConfigurationId, null)
  const backToAuto = await run(fresh, { action: 'revert' }, 'subtitle-revert-key-5')
  assert.equal(backToAuto.configuration.origin, 'director')
  assert.equal(backToAuto.configuration.requested.mode, 'auto')

  // Reverting an inherited variant is refused, and a revert never names a mode.
  await assert.rejects(run(repository(), { action: 'revert' }, 'subtitle-revert-key-6'), /no subtitle configuration to revert/)
  await assert.rejects(run(repository(), { action: 'revert', requested: { mode: 'auto' } }, 'subtitle-revert-key-7'), /cannot carry a subtitle mode/)
  assert.throws(() => resolveProjectSubtitleRevertTarget({ current: null, previous: null }), /no subtitle configuration to revert/)

  // The public body parser enforces the same state machine.
  const identity = { baseVersionId: 'version-subtitle-base', baseHash: 'a'.repeat(64), variantId: VERTICAL }
  assert.deepEqual(parseSetProjectSubtitleConfigurationBody({ ...identity, action: 'revert' }), { ...identity, action: 'revert' })
  assert.equal(parseSetProjectSubtitleConfigurationBody({ ...identity, mode: 'auto' }).action, 'set')
  assert.throws(() => parseSetProjectSubtitleConfigurationBody({ ...identity, action: 'revert', mode: 'auto' }), /cannot specify a subtitle mode/)
  assert.throws(() => parseSetProjectSubtitleConfigurationBody({ ...identity, mode: 'auto', presetId: 'kinetic' }), /cannot specify a manual preset/)
  assert.throws(() => parseSetProjectSubtitleConfigurationBody({ ...identity, mode: 'manual', presetId: 'kinetic' }), /Manual subtitle preset reference is invalid/)
  assert.throws(() => parseSetProjectSubtitleConfigurationBody({ ...identity, mode: 'workspace' }), /Subtitle mode must be one of/)

  // The panel reads a resolved origin, not a mode it has to interpret.
  const presented = presentProjectSubtitleResolution(reverted)
  assert.equal(presented.origin, 'workspace')
  assert.equal(presented.action, 'revert')
  assert.equal(presented.presetHash, subtitlePresetHash('clean-color'))
  assert.equal(presented.transcriptHash, TRANSCRIPT_HASH)
})

// 9/9 ------------------------------------------------------------------------
test('T-FR-171 replay is idempotent, a reused key with another payload fails and a stale base version is refused', async () => {
  const repo = repository()
  const first = await run(repo, { action: 'set', requested: { mode: 'manual', presetId: 'kinetic', presetVersion: 1 } }, 'subtitle-replay-key-1')
  const versionAfterFirst = repo.currentVersion.id

  // Replaying the identical request returns the identical documents, creates no
  // new version and no second configuration.
  const replayed = await setProjectSubtitleConfigurationService({ repository: repo, createId: () => { throw new Error('replay must not mint identifiers') }, clock: () => new Date('2026-08-13T20:05:00.000Z') })({
    workspaceId: WORKSPACE, projectId: PROJECT, baseVersionId: genesis.id, baseHash: genesis.baseHash,
    variantId: VERTICAL, action: 'set', requested: { mode: 'manual', presetId: 'kinetic', presetVersion: 1 }, actor, idempotencyKey: 'subtitle-replay-key-1',
  })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.configuration.id, first.configuration.id)
  assert.equal(replayed.configuration.configurationHash, first.configuration.configurationHash)
  assert.equal(replayed.impact.impactHash, first.impact.impactHash)
  assert.equal(repo.currentVersion.id, versionAfterFirst)
  assert.equal(repo.configurations.size, 1)

  // The same key with a different mode is a payload mismatch, never a silent overwrite.
  await assert.rejects(
    setProjectSubtitleConfigurationService({ repository: repo, createId: (kind) => `subtitle-${kind}-mismatch`, clock: () => new Date('2026-08-13T20:06:00.000Z') })({
      workspaceId: WORKSPACE, projectId: PROJECT, baseVersionId: genesis.id, baseHash: genesis.baseHash,
      variantId: VERTICAL, action: 'set', requested: { mode: 'none' }, actor, idempotencyKey: 'subtitle-replay-key-1',
    }),
    /Idempotency key was used with another subtitle configuration/,
  )

  // A concurrent writer already moved the project forward: the stale base is refused.
  await assert.rejects(
    setProjectSubtitleConfigurationService({ repository: repo, createId: (kind) => `subtitle-${kind}-stale`, clock: () => new Date('2026-08-13T20:07:00.000Z') })({
      workspaceId: WORKSPACE, projectId: PROJECT, baseVersionId: genesis.id, baseHash: genesis.baseHash,
      variantId: VERTICAL, action: 'set', requested: { mode: 'auto' }, actor, idempotencyKey: 'subtitle-stale-key-1',
    }),
    /base version is stale/,
  )
  assert.equal(repo.configurations.size, 1, 'a refused stale write persists nothing')

  // Retrying against the fresh head converges.
  const converged = await run(repo, { action: 'set', requested: { mode: 'auto' } }, 'subtitle-stale-key-2')
  assert.equal(converged.configuration.origin, 'director')
  assert.equal(converged.version.parentVersionId, versionAfterFirst)
  assert.equal(converged.configuration.transcriptHash, TRANSCRIPT_HASH)
})

// ===== multi-output (W66 S3): variantId is the STABLE State variant id; only the targeted output goes stale =====
const refusedWith = (reason) => (error) => error?.code === 'PRECONDITION_REQUIRED' && error.details?.reason === reason

test('S3 a subtitle configuration on one output leaves the other output untouched and lists only the targeted renders', async () => {
  const repo = repository()
  const before = { wide: untouchedFacts(repo.currentBundle, WIDE), vertical: untouchedFacts(repo.currentBundle, VERTICAL) }
  const result = await run(repo, { action: 'set', requested: { mode: 'manual', presetId: 'karaoke-box', presetVersion: 1 } }, 'subtitle-multi-key-1')
  assert.deepEqual(result.command.scope.outputVariantIds, [VERTICAL])
  // Only the 9:16 renders (its proxy and its final) are stale; the 16:9 proxy and final are not named by the impact.
  assert.deepEqual(result.impact.affectedArtifacts.map((item) => `${item.kind}:${item.variantId}`).toSorted(), [`final:${VERTICAL}`, `proxy:${VERTICAL}`])
  assert.deepEqual([...result.impact.affectedVariantIds], [VERTICAL])
  assert.deepEqual(result.impact.minimalRenders.map((render) => render.variantId), [VERTICAL])
  // The other entry keeps its output spec revision, spec hash and geometry byte-identical; its materialization is re-bound to the
  // new Version, as every child Command's is.
  const after = repo.currentBundle
  assert.deepEqual(untouchedFacts(after, WIDE), before.wide)
  assert.deepEqual(untouchedFacts(after, VERTICAL), before.vertical, 'a subtitle mode changes no output spec either')
  assert.equal(after.state.document.entries.find((entry) => entry.variantId === WIDE).consumption.materialization.document.resultVersionId, result.version.id)
  assert.equal(after.state.document.entries.length, 2)
})

test('S3 the variant is validated against the State of the base Version with its published reason', async () => {
  const repo = repository()
  const attempt = (variantId, key) => run(repo, { action: 'set', requested: { mode: 'none' }, variantId }, key)
  // An aspect ratio is not an output: the old spelling names no member of the State.
  await assert.rejects(attempt('9:16', 'subtitle-multi-unknown-1'), refusedWith('output-variant-unknown'))
  await assert.rejects(attempt('variant-that-does-not-exist', 'subtitle-multi-unknown-2'), refusedWith('output-variant-unknown'))
  assert.equal(repo.configurations.size, 0, 'a refused variant persists nothing')
  // Two outputs of one aspect ratio cannot be addressed apart (limitation, published).
  const twice = await twoOutputIngestedWorld({ sameRatioTwice: true })
  assert.equal(twice.verticalVariantIds.length, 2)
  const ambiguous = repository({ parent: twice.parent })
  for (const variantId of twice.verticalVariantIds) {
    await assert.rejects(run(ambiguous, { action: 'set', requested: { mode: 'none' }, variantId }, `subtitle-multi-ambiguous-${variantId}`), refusedWith('output-variant-ambiguous'))
  }
  // The 16:9 output of that State is still addressable.
  const wideOnly = await run(ambiguous, { action: 'set', requested: { mode: 'none' }, variantId: twice.wideVariantId }, 'subtitle-multi-ambiguous-wide')
  assert.equal(wideOnly.configuration.variantId, twice.wideVariantId)
})

test('S3 the request parser requires the variant and carries it through untouched', () => {
  const identity = { baseVersionId: 'version-subtitle-base', baseHash: 'a'.repeat(64) }
  assert.equal(parseSetProjectSubtitleConfigurationBody({ ...identity, variantId: ` ${VERTICAL} `, mode: 'auto' }).variantId, VERTICAL)
  assert.throws(() => parseSetProjectSubtitleConfigurationBody({ ...identity, mode: 'auto' }), /variantId is invalid/)
  assert.throws(() => parseSetProjectSubtitleConfigurationBody({ ...identity, variantId: '  ', mode: 'auto' }), /variantId is invalid/)
})
