import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { readStoredOutputStateV3 } from '../../src/v2/infrastructure/prisma/output-state-consumption.ts'

// The sealed-rows reader every consumer calls right after a claim. Its seal check is ONE SHA-256 of the stored text: the State hash is the
// SHA-256 of the canonical text, so the text is the sealed State exactly when its own hash is the one the Version seals. (Parsing, re-serializing
// canonically and hashing again cost ~20 ms each on a 30 s master: more than the 30 ms in which a tsx launcher waits for a worker to acknowledge
// SIGTERM before it kills the worker with its claim still running.)
const scope = { workspaceId: 'workspace-1', projectId: 'project-1', versionId: 'version-1' }
const document = { schemaVersion: 'project-output-state/v3', id: 'state-1', workspaceId: 'workspace-1', projectId: 'project-1', resultVersionId: 'version-1',
  entries: [{ variantId: 'variant-1', spec: { output: { aspectRatio: '9:16' } } }], sourceDependencies: null }
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const canonical = serializeOutputCanonicalJson(document)

const clientFor = (overrides = {}) => ({
  $queryRawUnsafe: async () => [{ outputContractVersion: 3, baseHash: 'b'.repeat(64), outputStateId: 'state-1', outputStateHash: sha(canonical),
    stateJson: canonical, stateHash: sha(canonical), schemaVersion: 'project-output-state/v3', ...overrides }],
})

test('the stored State is the one its Version seals, byte for byte, and is answered as the parsed document', async () => {
  const stored = await readStoredOutputStateV3(clientFor(), scope)
  assert.deepEqual(stored.state.document, document)
  assert.equal(stored.state.stateHash, sha(canonical))
  assert.deepEqual(stored.version, { id: 'version-1', baseHash: 'b'.repeat(64) })
})

test('a State text that is not the sealed text is refused before it is parsed, whatever else still agrees', async () => {
  const altered = canonical.replace('9:16', '1:1')
  for (const row of [
    { stateJson: altered },
    { stateJson: `${canonical} ` },
    { stateJson: JSON.stringify(document, null, 1) },
    { stateHash: sha(altered), outputStateHash: sha(altered) },
  ]) {
    await assert.rejects(() => readStoredOutputStateV3(clientFor(row), scope),
      (error) => error.code === 'PERSISTENCE_CONFLICT' && /failed its own seal/.test(error.message), JSON.stringify(Object.keys(row)))
  }
})

test('the Version row, the State row and the document must name the same State', async () => {
  await assert.rejects(() => readStoredOutputStateV3(clientFor({ outputStateHash: 'c'.repeat(64) }), scope), /differs from the State its Version seals/)
  await assert.rejects(() => readStoredOutputStateV3(clientFor({ schemaVersion: 'project-output-state/v2' }), scope), /differs from the State its Version seals/)
  await assert.rejects(() => readStoredOutputStateV3(clientFor({ outputStateId: 'state-other' }), scope), /failed its own seal/)
  await assert.rejects(() => readStoredOutputStateV3(clientFor(), { ...scope, versionId: 'version-other' }), /failed its own seal/)
  await assert.rejects(() => readStoredOutputStateV3(clientFor({ stateJson: null }), scope), /differs from the State its Version seals/)
  await assert.rejects(() => readStoredOutputStateV3(clientFor({ outputContractVersion: 1 }), scope),
    (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'output-not-consumable')
  assert.equal(await readStoredOutputStateV3({ $queryRawUnsafe: async () => [] }, scope), null)
})
