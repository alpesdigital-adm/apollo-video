import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

// The Version guards are deferred constraint triggers. Prisma 5.22's interactive transaction RESOLVES when COMMIT is refused
// by one (measured twice in the supervised PG runs: the callback's value came back, every row had rolled back), so a writer
// that stops at COMMIT answers success for a Version that was never stored. The shared writer cannot settle the guards itself
// (callers still write the head, events and domain rows after it), so every caller must, as its last write.
const directory = new URL('../../src/v2/infrastructure/prisma/', import.meta.url)
const writers = readdirSync(directory).filter((name) => name.endsWith('.ts') && name !== 'project-version-commit.ts')
  .map((name) => ({ name, text: readFileSync(new URL(name, directory), 'utf8') }))
  .filter(({ text }) => text.includes('commitProjectVersionWithOutputState('))

test('the shared Version writer is called by a known set of repositories', () => {
  assert.deepEqual(writers.map(({ name }) => name), [
    'director-run-repository.ts', 'manual-edit-repository.ts', 'media-library-repository.ts', 'multicam-direction-command-repository.ts',
    'project-color-plan-repository.ts', 'project-lut-selection-repository.ts', 'project-policy-overrides-repository.ts',
    'project-subtitle-configuration-repository.ts', 'review-patch-batch-repository.ts', 'review-patch-repository.ts',
    'source-transcript-replacement-repository.ts', 'subtitle-segment-override-repository.ts',
  ], 'a new caller of commitProjectVersionWithOutputState must settle the deferred guards too, and be listed here')
})

test('every Version writer forces the deferred guards after the shared writer and before it returns', () => {
  for (const { name, text } of writers) {
    const commit = text.indexOf('await commitProjectVersionWithOutputState(')
    const settle = text.indexOf('await settleDeferredOutputGuards(')
    assert.ok(commit >= 0, `${name} commits through the shared writer`)
    assert.ok(settle > commit, `${name} settles the deferred guards after the shared writer`)
    assert.equal(text.split('await settleDeferredOutputGuards(').length - 1, 1, `${name} settles exactly once`)
    assert.match(text, /import \{ commitProjectVersionWithOutputState, settleDeferredOutputGuards \} from '\.\/project-version-commit\.ts'/, name)
  }
})

test('the settle step is the guards-immediate statement and the writer documents why', () => {
  const text = readFileSync(new URL('project-version-commit.ts', directory), 'utf8')
  assert.match(text, /export async function settleDeferredOutputGuards\(tx: Prisma\.TransactionClient\): Promise<void> \{\s*await tx\.\$executeRawUnsafe\('SET CONSTRAINTS ALL IMMEDIATE'\)/)
  assert.match(text, /does not report a refused COMMIT/)
})
