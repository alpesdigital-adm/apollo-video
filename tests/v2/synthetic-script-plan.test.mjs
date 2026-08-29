import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  assertSyntheticScriptBlock,
  assertSyntheticScriptPlanVersion,
  createSyntheticScriptBlock,
  createSyntheticScriptPlanHead,
  createSyntheticScriptPlanImpact,
  createSyntheticScriptPlanVersion,
} from '../../src/v2/domain/synthetic-script-plan.ts'

const at = '2029-01-01T00:00:00.000Z'
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

const block = (id, text, origin = { kind: 'initial-segmentation' }) => createSyntheticScriptBlock({
  id, workspaceId: 'workspace-1', projectId: 'project-1', planId: 'plan-1',
  exactText: text, locale: 'pt-BR', occurrence: 1,
  createdInVersionId: 'plan-version-1', origin, createdAt: at,
})

test('T-FR-102 block identity is immutable, hashed and lineage-aware', () => {
  const created = block('block-1', 'Primeira frase completa.')
  assert.equal(created.normalizedText, 'Primeira frase completa.')
  assert.equal(created.normalizedTextHash, sha('Primeira frase completa.'))
  assertSyntheticScriptBlock(created)
  assert.throws(
    () => assertSyntheticScriptBlock({ ...created, exactText: 'Outra frase.' }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  const edited = block('block-2', 'Frase editada.', { kind: 'edited', originBlockId: 'block-1' })
  assert.equal(edited.origin.originBlockId, 'block-1')
  assert.throws(
    () => block('block-3', 'Sem origem.', { kind: 'edited' }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => block('block-4', 'Origem proibida.', { kind: 'initial-segmentation', originBlockId: 'block-1' }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

const impactInput = {
  commandType: 'create-plan',
  baseVersionId: null,
  resultVersionId: 'plan-version-1',
  createdBlockIds: ['block-1', 'block-2'],
  reusedBlockIds: [],
  retiredBlockIds: [],
  invalidatedArtifactIds: [],
  renderSemantics: 'deferred-to-compile',
  cacheDecisions: [
    { blockId: 'block-1', decision: 'pending', reason: 'novo bloco sem geração aprovada com esta cache key' },
    { blockId: 'block-2', decision: 'pending', reason: 'novo bloco sem geração aprovada com esta cache key' },
  ],
}

test('T-FR-102 command impact separates created, reused and retired blocks', () => {
  const impact = createSyntheticScriptPlanImpact(impactInput)
  assert.equal(impact.impactHash, createSyntheticScriptPlanImpact(impactInput).impactHash)
  assert.throws(
    () => createSyntheticScriptPlanImpact({ ...impactInput, reusedBlockIds: ['block-1'] }),
    (error) => error.code === 'INVALID_ARGUMENT' && /created, reused and retired/.test(error.message),
  )
  assert.throws(
    () => createSyntheticScriptPlanImpact({
      ...impactInput,
      cacheDecisions: [{ blockId: 'block-9', decision: 'pending', reason: 'bloco desconhecido não pode decidir cache' }],
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /outside this command/.test(error.message),
  )
})

const versionInput = () => {
  const impact = createSyntheticScriptPlanImpact(impactInput)
  return {
    id: 'plan-version-1', planId: 'plan-1', workspaceId: 'workspace-1', projectId: 'project-1',
    sequence: 1, projectVersionId: 'project-version-1', profileSnapshotId: 'presenter:v1',
    locale: 'pt-BR', commandType: 'create-plan',
    blockSequence: ['block-1', 'block-2'],
    orderedNormalizedTextHashes: [sha('Primeira frase completa.'), sha('Frase editada.')],
    impact, createdAt: at,
  }
}

test('T-FR-102 plan versions are immutable, sequential and hash-verifiable', () => {
  const input = versionInput()
  const version = createSyntheticScriptPlanVersion(input)
  assert.equal(version.segmentationVersion, 'synthetic-script-segmentation/v1')
  assertSyntheticScriptPlanVersion(version, input.orderedNormalizedTextHashes)
  assert.throws(
    () => assertSyntheticScriptPlanVersion(
      { ...version, blockSequence: ['block-2', 'block-1'] },
      input.orderedNormalizedTextHashes,
    ),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => createSyntheticScriptPlanVersion({ ...input, sequence: 2 }),
    (error) => error.code === 'INVALID_ARGUMENT' && /parent/.test(error.message),
  )
  assert.throws(
    () => createSyntheticScriptPlanVersion({ ...input, sequence: 2, parentVersionId: 'plan-version-1', commandType: 'create-plan' }),
    (error) => error.code === 'INVALID_ARGUMENT' && /create-plan/.test(error.message),
  )
  assert.throws(
    () => createSyntheticScriptPlanVersion({ ...input, blockSequence: ['block-1', 'block-1'] }),
    (error) => error.code === 'INVALID_ARGUMENT' && /repeat/.test(error.message),
  )
  assert.throws(
    () => createSyntheticScriptPlanVersion({ ...input, orderedNormalizedTextHashes: [sha('só um')] }),
    (error) => error.code === 'INVALID_ARGUMENT' && /align/.test(error.message),
  )
  assert.throws(
    () => createSyntheticScriptPlanVersion({
      ...input,
      impact: createSyntheticScriptPlanImpact({ ...impactInput, resultVersionId: 'plan-version-9' }),
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /describe this version/.test(error.message),
  )
})

test('T-FR-102 plan head binds the workspace, project and current version', () => {
  const head = createSyntheticScriptPlanHead({
    id: 'plan-1', workspaceId: 'workspace-1', projectId: 'project-1',
    currentVersionId: 'plan-version-1', createdAt: at,
  })
  assert.equal(head.schemaVersion, 'synthetic-script-plan/v1')
  assert.throws(
    () => createSyntheticScriptPlanHead({
      id: 'p', workspaceId: 'workspace-1', projectId: 'project-1', currentVersionId: 'plan-version-1', createdAt: at,
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})
