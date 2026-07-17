import assert from 'node:assert/strict'
import test from 'node:test'
import { BRIEF_COMPILER_GOLDEN_SET, briefCompilerService } from '../../src/v2/application/compile-brief.ts'

function emptyFields(overrides = {}) { return { audience: [], offer: [], constraints: [], mustUse: [], avoid: [], tone: [], successCriteria: [], ...overrides } }

test('Brief Compiler validates evidence, keeps provenance and requests review only for material conflict', async () => {
  const text = 'Público: gestores. Oferta: guia. E-mail contato@empresa.test.'
  const compile = briefCompilerService({
    model: {
      id: 'model-fake-v1',
      async generate() {
        return {
          fields: emptyFields({ audience: ['gestores'], offer: ['guia'] }),
          evidence: [{ field: 'audience', start: 9, end: 17, quote: 'gestores', confidence: .94 }],
          conflicts: [{ code: 'contradiction', message: 'Minor wording ambiguity', material: false, evidence: [0] }],
        }
      },
    },
  })
  const result = await compile({ text })
  assert.equal(result.compiled.requiresReview, false)
  assert.equal(result.audit.modelId, 'model-fake-v1')
  assert.equal(result.audit.inputRedacted.includes('contato@empresa.test'), false)
  assert.match(result.audit.inputHash, /^[a-f0-9]{64}$/)
})

test('Brief Compiler rejects fabricated evidence and detects malicious guardrail override', async () => {
  const invalid = briefCompilerService({ model: { id: 'fake', async generate() { return { fields: emptyFields(), evidence: [{ field: 'offer', start: 0, end: 4, quote: 'fake', confidence: .8 }] } } } })
  await assert.rejects(() => invalid({ text: 'real source' }), /does not match source/)
  const safe = briefCompilerService({ model: { id: 'fake', async generate() { return { fields: emptyFields(), evidence: [] } } } })
  const result = await safe({ text: BRIEF_COMPILER_GOLDEN_SET[1].text })
  assert.equal(result.compiled.requiresReview, true)
  assert.equal(result.compiled.conflicts[0].code, 'guardrail-conflict')
  assert.equal(BRIEF_COMPILER_GOLDEN_SET.length, 3)
})
