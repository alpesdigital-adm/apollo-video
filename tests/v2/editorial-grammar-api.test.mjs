import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { evaluateEditorialGrammarService } from '../../src/v2/application/evaluate-editorial-grammar.ts'
import { EDITORIAL_TIMELINE_GOLDENS } from '../../src/v2/domain/editorial-grammar.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { parseEditorialGrammarEvaluationBody } from '../../src/v2/public-api/editorial-grammar-contract.ts'

test('T-FR-060 public parser is exact and application preflight preserves the canonical hash', async () => {
  const parsed = parseEditorialGrammarEvaluationBody(JSON.parse(JSON.stringify(EDITORIAL_TIMELINE_GOLDENS.adequate)))
  const result = await evaluateEditorialGrammarService()(parsed)
  assert.equal(result.schemaVersion, 'editorial-grammar-evaluation/v1')
  assert.equal(result.distribution, 'adequate')
  assert.equal(result.valid, true)
  assert.match(result.evaluationHash, /^[a-f0-9]{64}$/)
  assert.throws(() => parseEditorialGrammarEvaluationBody({ ...EDITORIAL_TIMELINE_GOLDENS.adequate, hiddenStylePrompt: 'legacy' }), /unsupported field/)
  assert.throws(() => parseEditorialGrammarEvaluationBody({ ...EDITORIAL_TIMELINE_GOLDENS.adequate, motions: [{ id: 'motion-a' }] }), /unsupported|bounded text|integer/)
})

test('T-FR-060 public capability binds the authenticated natural-idempotency preflight contract', async () => {
  const capability = FOUNDATION_CAPABILITIES.find(({ id }) => id === 'apollo.editorial-grammar.evaluate')
  assert.deepEqual(capability, {
    id: 'apollo.editorial-grammar.evaluate', version: '1.0.0', title: 'Evaluate editorial treatment grammar',
    description: capability.description, exposure: 'public', operationKind: 'preflight', authMode: 'required',
    requiredScopes: ['projects:read'], inputSchemaRef: 'apollo://schemas/editorial-grammar-evaluation-request/v1',
    outputSchemaRef: 'apollo://schemas/editorial-grammar-evaluation/v1', endpoint: { method: 'POST', path: '/v1/editorial-grammar/evaluations' },
    toolName: 'apollo.editorial-grammar.evaluate', supportsDryRun: false, costClass: 'free', confirmation: 'none',
    successStatuses: [200], idempotency: 'natural', requestBodyRequired: true, queryParameters: undefined, availableIn: undefined,
  })
  const route = await readFile(new URL('../../src/app/v1/editorial-grammar/evaluations/route.ts', import.meta.url), 'utf8')
  assert.match(route, /authenticateExternalRequest\(request\)/)
  assert.match(route, /requireScope\(actor, 'projects:read'\)/)
  assert.match(route, /parseEditorialGrammarEvaluationBody\(value\)/)
  assert.match(route, /evaluateEditorialGrammarService\(\)/)
  assert.doesNotMatch(route, /\/api\//)
})

test('T-FR-060 API-facing goldens retain distinct excess, scarcity and adequate results', async () => {
  const service = evaluateEditorialGrammarService()
  const results = await Promise.all(Object.values(EDITORIAL_TIMELINE_GOLDENS).map((fixture) => service(parseEditorialGrammarEvaluationBody(JSON.parse(JSON.stringify(fixture))))))
  assert.deepEqual(results.map(({ distribution }) => distribution), ['excessive', 'scarce', 'adequate'])
  assert.equal(new Set(results.map(({ evaluationHash }) => evaluationHash)).size, 3)
})
