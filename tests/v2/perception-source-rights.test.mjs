import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { evaluatePerceptionSourceAnalysisRights } from '../../src/v2/domain/perception-source-rights.ts'

const at = new Date('2026-10-11T12:00:00.000Z')
const context = { workspaceId: 'analysis-workspace', locale: 'pt-BR' }
const ingestUses = ['distribution', 'editing', 'rendering', 'transcription']
function rights(change = {}) {
  return createAssetRightsSnapshot({ id: 'analysis-rights', workspaceId: context.workspaceId,
    artifactId: 'analysis-master', sequence: 1, createdAt: at.toISOString(),
    createdBy: { type: 'api-client', id: 'analysis-uploader' },
    draft: { owner: 'Authenticated workspace uploader', license: 'workspace-authorized',
      status: 'approved', allowedUses: ingestUses, prohibitedUses: [],
      consent: { status: 'not-required', allowedUses: [] }, ...change } })
}

test('perception analysis accepts the normal ingest editing grant without library reuse', async () => {
  const snapshot = rights()
  assert.equal(snapshot.allowedUses.includes('editorial-reuse'), false)
  assert.equal(evaluatePerceptionSourceAnalysisRights(snapshot, context, at).outcome, 'allow')
  const source = await readFile(new URL('../../src/v2/application/run-media-ingest-worker.ts', import.meta.url), 'utf8')
  assert.match(source, /allowedUses: \['distribution', 'editing', 'rendering', 'transcription'\], prohibitedUses: \[\]/)
  assert.match(source, /consent: \{ status: 'not-required', allowedUses: \[\] \}/)
})

test('perception analysis denies missing editing, revocation, expiry, prohibition and scoped consent', () => {
  const cases = [
    [null, context, 'RIGHTS_MISSING'],
    [rights({ allowedUses: ['editorial-reuse'] }), context, 'RIGHTS_USE_NOT_ALLOWED'],
    [rights({ status: 'revoked' }), context, 'RIGHTS_STATUS_REVOKED'],
    [rights({ status: 'unknown' }), context, 'RIGHTS_STATUS_UNKNOWN'],
    [rights({ expiresAt: at.toISOString() }), context, 'RIGHTS_EXPIRED'],
    [rights({ allowedUses: ['rendering'], prohibitedUses: ['editing'] }), context, 'RIGHTS_USE_PROHIBITED'],
    [rights({ allowedLocales: ['en-US'] }), context, 'RIGHTS_LOCALE_NOT_ALLOWED'],
    [rights(), { ...context, workspaceId: 'other-workspace' }, 'RIGHTS_WORKSPACE_NOT_ALLOWED'],
    [rights({ consent: { status: 'revoked', allowedUses: [] } }), context, 'CONSENT_STATUS_REVOKED'],
    [rights({ consent: { status: 'approved', allowedUses: ['rendering'] } }), context, 'CONSENT_USE_NOT_ALLOWED'],
    [rights({ consent: { status: 'approved', allowedUses: ['editing'], expiresAt: at.toISOString() } }), context, 'CONSENT_EXPIRED'],
    [rights({ consent: { status: 'approved', allowedUses: ['editing'], allowedLocales: ['en-US'] } }), context, 'CONSENT_LOCALE_NOT_ALLOWED'],
  ]
  for (const [snapshot, scope, code] of cases) {
    const decision = evaluatePerceptionSourceAnalysisRights(snapshot, scope, at)
    assert.equal(decision.outcome, 'deny', code)
    assert.ok(decision.reasonCodes.includes(code), code)
  }
})
