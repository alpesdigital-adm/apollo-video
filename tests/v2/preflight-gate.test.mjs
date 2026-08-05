import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { HmacPreflightCommitTokenIssuer } from '../../src/v2/infrastructure/security/preflight-commit-token.ts'
import {
  PREFLIGHT_ACTION_POLICIES,
  PREFLIGHT_REQUIRED_ACTION_CLASSES,
  requirePreflightForActionService,
} from '../../src/v2/application/preflight-gate.ts'

test('batch, final matrix, variable generation and destructive actions require trusted preflight', () => {
  assert.deepEqual(PREFLIGHT_REQUIRED_ACTION_CLASSES, ['batch', 'final-matrix', 'variable-generation', 'destructive'])
  const issuer = new HmacPreflightCommitTokenIssuer('g'.repeat(32))
  const claims = { clientId: 'client-1', workspaceId: 'workspace-1', fingerprint: 'a'.repeat(64), snapshot: 'b'.repeat(64), costFingerprint: 'c'.repeat(64), expiresAt: '2026-07-17T01:00:00.000Z' }
  const gate = requirePreflightForActionService({ issuer, clock: () => new Date('2026-07-17T00:30:00.000Z') })
  const required = new Map([
    ['batch-edit.commit', 'batch'],
    ['variant-portfolio.confirm', 'variable-generation'],
    ['final-export-matrix.commit', 'final-matrix'],
    ['destructive-command.commit', 'destructive'],
  ])
  for (const [actionId, actionClass] of required) {
    assert.equal(PREFLIGHT_ACTION_POLICIES[actionId].actionClass, actionClass)
    assert.throws(() => gate({ actionId, ...claims }), /required/)
    const authorized = gate({
      actionId,
      ...claims,
      token: issuer.issue(claims),
    })
    assert.equal(authorized.valid, true)
    assert.equal(authorized.actionClass, actionClass)
  }
  const bounded = requirePreflightForActionService()({
    actionId: 'project-final-export.enqueue',
  })
  assert.equal(bounded.required, false)
  assert.equal(bounded.actionClass, 'bounded')
  assert.throws(
    () => gate({ actionId: 'caller-declared-bounded', ...claims }),
    /not explicitly classified/,
  )
})

test('operational high-impact services use the central action registry', async () => {
  const applicationRoot = fileURLToPath(
    new URL('../../src/v2/application/', import.meta.url),
  )
  const sources = await Promise.all([
    'batch-edits.ts',
    'variant-portfolio-preflights.ts',
    'enqueue-project-final-export.ts',
  ].map((file) => readFile(
    new URL(`../../src/v2/application/${file}`, import.meta.url),
    'utf8',
  )))
  assert.match(sources[0], /requirePreflightForActionService/)
  assert.match(sources[0], /actionId: 'batch-edit\.commit'/)
  assert.doesNotMatch(sources[0], /validatePreflightCommitTokenService/)
  assert.match(sources[1], /requirePreflightForActionService/)
  assert.match(sources[1], /actionId: 'variant-portfolio\.confirm'/)
  assert.doesNotMatch(sources[1], /validatePreflightCommitTokenService/)
  assert.match(sources[2], /actionId: 'project-final-export\.enqueue'/)

  const directValidators = []
  for (const entry of await readdir(applicationRoot, {
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      ['preflight-gate.ts', 'validate-preflight-commit-token.ts']
        .includes(entry.name)
    ) continue
    const source = await readFile(join(applicationRoot, entry.name), 'utf8')
    if (source.includes('validatePreflightCommitTokenService')) {
      directValidators.push(entry.name)
    }
  }
  assert.deepEqual(directValidators, [])
})
