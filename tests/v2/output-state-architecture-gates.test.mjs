import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  CONTRACT_ONE_HISTORY,
  PENDING_ROWS,
  VERSION_BUILDER,
  VERSION_WRITER,
  outputStateArchitectureViolations,
} from '../../scripts/output-state-architecture-rules.mjs'

/**
 * Both directions, as for every structural gate: the rule must fire on the shape it exists to catch and stay
 * silent on the shapes that only look like it, and the transitional list must be unable to hide a regression.
 */
const none = []
const clean = { rel: 'application/example.ts', source: 'export const x = 1\n' }
const writer = { rel: VERSION_WRITER, source: "await insert(tx,'project_versions',{ id })\n" }
const builder = { rel: VERSION_BUILDER, source: 'export function createProjectVersion() {}\n' }

test('the shared persistence file and the builder definition are the only allowed places', () => {
  assert.deepEqual(outputStateArchitectureViolations([clean, writer, builder], none), [])
  for (const rel of CONTRACT_ONE_HISTORY) {
    assert.deepEqual(outputStateArchitectureViolations([{ rel, source: 'createProjectVersion({})\n' }], none), [], rel)
  }
})

test('a second ProjectVersion writer is refused in every spelling', () => {
  for (const source of [
    'await transaction.v2ProjectVersion.create({ data })',
    'await tx.v2ProjectVersion . createMany ({ data })',
    'await tx.v2ProjectVersion.upsert({})',
    'await tx.$executeRawUnsafe(`INSERT INTO "project_versions" (id) VALUES ($1)`)',
    "await insert(tx, 'project_versions', { id })",
  ]) {
    const found = outputStateArchitectureViolations([{ rel: 'infrastructure/prisma/other-repository.ts', source }], none)
    assert.equal(found.length, 1, source)
    assert.match(found[0], /writes a ProjectVersion row outside the shared writer/)
  }
  assert.deepEqual(outputStateArchitectureViolations([{ rel: 'infrastructure/prisma/reader.ts', source: 'await tx.v2ProjectVersion.findMany({})\n// project_versions\n' }], none), [])
})

test('the retired builder is refused outside its definition and the contract-one history', () => {
  const found = outputStateArchitectureViolations([{ rel: 'application/lut.ts', source: "import { createProjectVersion } from '../domain/project-version.ts'\n" }], none)
  assert.equal(found.length, 1)
  assert.match(found[0], /retired createProjectVersion builder/)
  assert.deepEqual(outputStateArchitectureViolations([{ rel: 'application/lut.ts', source: 'const createProjectVersionV3 = 1\n' }], none), [])
})

test('the pending list cannot hide a regression nor outlive a fix', () => {
  const pendingFile = { rel: 'application/pending.ts', source: 'createProjectVersion({})\n' }
  assert.deepEqual(outputStateArchitectureViolations([pendingFile], ['application/pending.ts']), [])
  assert.match(outputStateArchitectureViolations([pendingFile], none)[0], /retired createProjectVersion builder/)
  assert.match(outputStateArchitectureViolations([{ ...pendingFile, source: 'export {}\n' }], ['application/pending.ts'])[0], /remove it from PENDING_ROWS/)
  assert.match(outputStateArchitectureViolations([], ['application/gone.ts'])[0], /absent/)
})

test('the real source tree satisfies the rule with exactly the declared pending rows', async () => {
  const root = fileURLToPath(new URL('../../src/v2/', import.meta.url))
  const files = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
    }
  }
  await walk(root)
  const sources = await Promise.all(files.map(async (path) => ({ rel: relative(root, path).split(sep).join('/'), source: await readFile(path, 'utf8') })))
  assert.deepEqual(outputStateArchitectureViolations(sources), [])
  assert.deepEqual([...PENDING_ROWS].sort(), [...PENDING_ROWS], 'keep the list sorted')
})
