import assert from 'node:assert/strict'
import test from 'node:test'

import { defineEditorialPhraseRules, editorialRulesMatchingSpeech } from '../../src/v2/application/editorial-phrase-rules.ts'
import { collectRequestedSpeechRemovals } from '../../src/v2/application/requested-speech-removals.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

// The Director forbids in the captions only what the project itself asked to remove. Nothing here is a product phrase: every rule
// below is a request a user could have sent.

const rule = (id, ...alternatives) => ({ id, label: alternatives[0], alternatives })
const removal = (id, ...rules) => ({ id, type: 'remove-spoken-content', payload: { schemaVersion: 3, rules } })
const manualRestore = (id, restoresVersionId) => ({ id, type: 'manual-edit', payload: { schemaVersion: 2, action: 'undo', restoresVersionId } })
const version = (id, parentVersionId, commandId = null, fork = {}) => ({
  id, parentVersionId, commandId, forkedFromProjectId: fork.projectId ?? null, forkedFromVersionId: fork.versionId ?? null,
})
const project = (versions, commands) => ({
  versions: new Map(versions.map((item) => [item.id, item])),
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
