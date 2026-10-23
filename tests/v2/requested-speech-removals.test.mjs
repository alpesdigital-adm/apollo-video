import assert from 'node:assert/strict'
import test from 'node:test'

import { defineEditorialPhraseRules, editorialRulesMatchingSpeech } from '../../src/v2/application/editorial-phrase-rules.ts'
import { collectRequestedSpeechRemovals, requestedSpeechReintroducedByCaptions } from '../../src/v2/application/requested-speech-removals.ts'
import { createSubtitleSegmentOverride } from '../../src/v2/domain/subtitle-segment-override.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

// The Director forbids in the captions only what the project itself asked to remove. Nothing here is a product phrase: every rule
// below is a request a user could have sent.

const rule = (id, ...alternatives) => ({ id, label: alternatives[0], alternatives })
const removal = (id, ...rules) => ({ id, type: 'remove-spoken-content', payload: { schemaVersion: 3, rules } })
const manualRestore = (id, restoresVersionId) => ({ id, type: 'manual-edit', payload: { schemaVersion: 2, action: 'undo', restoresVersionId } })
const version = (id, parentVersionId, commandId = null, fork = {}) => ({
  id, parentVersionId, commandId, commandType: fork.commandType, forkedFromProjectId: fork.projectId ?? null, forkedFromVersionId: fork.versionId ?? null,
})
// The type of a Version's Command is what the Command row says, unless the fixture states it (a row that is missing).
const project = (versions, commands) => ({
  versions: new Map(versions.map((item) => [item.id, {
    ...item, commandType: item.commandType ?? commands.find((command) => command.id === item.commandId)?.type ?? null,
  }])),
  commands: new Map(commands.map((item) => [item.id, item])),
})
const idsOf = (rules) => rules.map((item) => item.id)

test('captions match a requested phrase with the same tokens the cut uses (case, accents, punctuation, any alternative)', () => {
  const rules = defineEditorialPhraseRules([rule('phrase-rule-1', 'promoção relâmpago', 'oferta relampago')])
  assert.deepEqual(editorialRulesMatchingSpeech('Hoje tem PROMOÇÃO, relâmpago!', rules), ['phrase-rule-1'])
  assert.deepEqual(editorialRulesMatchingSpeech('Hoje tem Oferta-Relâmpago', rules), [])
  assert.deepEqual(editorialRulesMatchingSpeech('Hoje tem oferta relâmpago', rules), ['phrase-rule-1'])
  assert.deepEqual(editorialRulesMatchingSpeech('promoção', rules), [])
  assert.deepEqual(editorialRulesMatchingSpeech('promoção da semana relâmpago', rules), [])
  assert.deepEqual(editorialRulesMatchingSpeech('qualquer texto', []), [])
})

test('a project that asked for nothing forbids nothing', async () => {
  const lineage = project([version('v1', null), version('v2', 'v1')], [])
  assert.deepEqual(await collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v2', load: async () => lineage }), [])
})

test('every remove-spoken-content request in the parent chain contributes its rules', async () => {
  const lineage = project(
    [version('v1', null), version('v2', 'v1', 'c2'), version('v3', 'v2', 'c-other'), version('v4', 'v3', 'c4')],
    [removal('c2', rule('phrase-rule-a', 'frase a')), removal('c4', rule('phrase-rule-b', 'frase b'), rule('phrase-rule-c', 'frase c')),
      { id: 'c-other', type: 'run-director', payload: {} }],
  )
  const rules = await collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v4', load: async () => lineage })
  assert.deepEqual(idsOf(rules), ['phrase-rule-b', 'phrase-rule-c', 'phrase-rule-a'])
  assert.deepEqual(rules[0].alternatives, [['frase', 'b']])
  // a head before the second request does not carry it
  assert.deepEqual(idsOf(await collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v3', load: async () => lineage })), ['phrase-rule-a'])
})

test('an undo returns to the Version it names: the request it stepped over is no longer asked', async () => {
  const lineage = project(
    [version('v1', null), version('v2', 'v1', 'c2'), version('v3', 'v2', 'c3'), version('v4', 'v3', 'c4')],
    [removal('c2', rule('phrase-rule-a', 'frase a')), removal('c3', rule('phrase-rule-b', 'frase b')), manualRestore('c4', 'v2')],
  )
  assert.deepEqual(idsOf(await collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v4', load: async () => lineage })), ['phrase-rule-a'])
})

test('a fork continues in the Version it was forked from, in the other project', async () => {
  const source = project([version('s1', null), version('s2', 's1', 'sc2')], [removal('sc2', rule('phrase-rule-source', 'frase origem'))])
  const fork = project([version('f1', null, 'fc1', { projectId: 'source', versionId: 's2' }), version('f2', 'f1', 'fc2')],
    [removal('fc2', rule('phrase-rule-fork', 'frase fork'))])
  const loaded = []
  const rules = await collectRequestedSpeechRemovals({
    projectId: 'fork', headVersionId: 'f2', load: async (projectId) => { loaded.push(projectId); return projectId === 'fork' ? fork : source },
  })
  assert.deepEqual(idsOf(rules), ['phrase-rule-fork', 'phrase-rule-source'])
  assert.deepEqual(loaded, ['fork', 'source'])
})

test('a lineage that loops terminates, and stored rules that are not valid are a persistence conflict', async () => {
  const loop = project([version('v1', 'v2', 'c1'), version('v2', 'v1')], [removal('c1', rule('phrase-rule-a', 'frase a'))])
  assert.deepEqual(idsOf(await collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v2', load: async () => loop })), ['phrase-rule-a'])
  const invalid = project([version('v1', null, 'c1')], [{ id: 'c1', type: 'remove-spoken-content', payload: { rules: [{ id: 'X', label: '', alternatives: [] }] } }])
  await assert.rejects(
    collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v1', load: async () => invalid }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  await assert.rejects(
    collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'missing', load: async () => loop }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('a Version a remove-spoken-content Command made, whose Command row is missing, fails closed instead of being skipped', async () => {
  const missingRow = project([version('v1', null), version('v2', 'v1', 'c2', { commandType: 'remove-spoken-content' })], [])
  await assert.rejects(
    collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v2', load: async () => missingRow }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT' && /does not exist/.test(error.message),
  )
  // a Command of another type that the walk does not load is not a missing request
  const other = project([version('v1', null), version('v2', 'v1', 'c2', { commandType: 'run-director' })], [])
  assert.deepEqual(await collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v2', load: async () => other }), [])
  // a row of another type under a removal Version is a conflict too
  const wrongType = project([version('v2', null, 'c2', { commandType: 'remove-spoken-content' })], [{ id: 'c2', type: 'run-director', payload: {} }])
  await assert.rejects(
    collectRequestedSpeechRemovals({ projectId: 'p1', headVersionId: 'v2', load: async () => wrongType }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

// A text exception on a caption can write a removed phrase back after the Director read the plan. The final is judged on what it burns.
const VARIANT = 'variant-tall-0001'
let counter = 0
const exception = (segmentId, range, dimensions, extra = {}) => {
  counter += 1
  return createSubtitleSegmentOverride({
    id: `override-${counter}-${segmentId}`, workspaceId: 'workspace-x', projectId: 'project-x', baseVersionId: 'version-base', resultVersionId: `version-${counter}`,
    commandId: `command-${counter}`, variantId: VARIANT, segmentId, range, action: 'set', dimensions, protected: false, previousOverrideId: null,
    createdAt: '2026-10-20T10:00:00.000Z', ...extra,
  })
}
const CUES = [
  { id: 'cue-a', startFrame: 20, endFrame: 50, text: 'primeira fala' },
  { id: 'cue-b', startFrame: 100, endFrame: 130, text: 'segunda fala' },
]
const requested = defineEditorialPhraseRules([rule('phrase-rule-requested-1', 'promoção relâmpago')])

test('a text exception that writes a requested phrase back is found; one that does not, or a request that was never made, is not', () => {
  const reintroduces = exception('cue-b', { startFrame: 100, endFrame: 130 }, [{ kind: 'text', text: 'Aproveite a PROMOÇÃO, relâmpago!' }])
  assert.deepEqual(requestedSpeechReintroducedByCaptions({ rules: requested, cues: CUES, overrides: [reintroduces], variantId: VARIANT }), ['phrase-rule-requested-1'])
  const harmless = exception('cue-b', { startFrame: 100, endFrame: 130 }, [{ kind: 'text', text: 'outra fala' }])
  assert.deepEqual(requestedSpeechReintroducedByCaptions({ rules: requested, cues: CUES, overrides: [harmless], variantId: VARIANT }), [])
  // nothing was asked: nothing is forbidden, whatever the exception says
  assert.deepEqual(requestedSpeechReintroducedByCaptions({ rules: [], cues: CUES, overrides: [reintroduces], variantId: VARIANT }), [])
  // an exception of another output does not reach this one
  assert.deepEqual(requestedSpeechReintroducedByCaptions({ rules: requested, cues: CUES, overrides: [reintroduces], variantId: 'variant-wide-0001' }), [])
  // a phrase split across two cues is found as the Director found it (the cues are read as one speech)
  const split = [{ id: 'cue-a', startFrame: 20, endFrame: 50, text: 'hoje tem promoção' }, { id: 'cue-b', startFrame: 100, endFrame: 130, text: 'relâmpago na loja' }]
  assert.deepEqual(requestedSpeechReintroducedByCaptions({ rules: requested, cues: split, overrides: [], variantId: VARIANT }), ['phrase-rule-requested-1'])
})

test('a caption hidden by an exception says nothing, and a text exception that removes the phrase clears it', () => {
  const cues = [{ id: 'cue-a', startFrame: 20, endFrame: 50, text: 'promoção relâmpago' }]
  const hidden = exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'visibility', visible: false }])
  assert.deepEqual(requestedSpeechReintroducedByCaptions({ rules: requested, cues, overrides: [hidden], variantId: VARIANT }), [])
  const rewritten = exception('cue-a', { startFrame: 20, endFrame: 50 }, [{ kind: 'text', text: 'fala sem o pedido' }])
  assert.deepEqual(requestedSpeechReintroducedByCaptions({ rules: requested, cues, overrides: [rewritten], variantId: VARIANT }), [])
})
