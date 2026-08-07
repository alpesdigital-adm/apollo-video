import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BRIEF_COMPILER_GOLDEN_SET,
  briefCompilerService,
  parseBriefCompilation,
} from '../../src/v2/application/compile-brief.ts'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'

function emptyFields(overrides = {}) { return { audience: [], offer: [], constraints: [], mustUse: [], avoid: [], tone: [], successCriteria: [], ...overrides } }

test('Brief Compiler validates evidence, keeps provenance and requests review only for material conflict', async () => {
  const text = 'Público: gestores. Oferta: guia. E-mail contato@empresa.test.'
  const compile = briefCompilerService({
    model: {
      id: 'model-fake-v1',
      version: '2026-08-07',
      async generate({ text: source }) {
        const offerStart = source.indexOf('guia')
        return {
          fields: emptyFields({ audience: ['gestores'], offer: ['guia'] }),
          evidence: [
            { field: 'audience', start: source.indexOf('gestores'), end: source.indexOf('gestores') + 8, quote: 'gestores', confidence: .94 },
            { field: 'offer', start: offerStart, end: offerStart + 4, quote: 'guia', confidence: .96 },
          ],
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
  const invalid = briefCompilerService({ model: { id: 'fake', version: '1', async generate() { return { fields: emptyFields(), evidence: [{ field: 'offer', start: 0, end: 4, quote: 'fake', confidence: .8 }] } } } })
  await assert.rejects(() => invalid({ text: 'real source' }), /does not match source/)
  const safe = briefCompilerService({ model: { id: 'fake', version: '1', async generate() { return { fields: emptyFields(), evidence: [] } } } })
  const result = await safe({ text: BRIEF_COMPILER_GOLDEN_SET[1].text })
  assert.equal(result.compiled.requiresReview, true)
  assert.equal(result.compiled.conflicts[0].code, 'guardrail-conflict')
  assert.equal(BRIEF_COMPILER_GOLDEN_SET.length, 3)
})

test('evidence-bound compiler executes the ambiguous, malicious and contradictory goldens', async () => {
  const compile = createEvidenceBoundBriefCompiler()
  for (const golden of BRIEF_COMPILER_GOLDEN_SET) {
    const result = await compile({ text: golden.text })
    assert.equal(result.compiled.requiresReview, golden.expectedReview, golden.id)
    if (golden.expectedConflict) {
      assert.ok(result.compiled.conflicts.some((item) => item.code === golden.expectedConflict), golden.id)
    }
    for (const evidence of result.compiled.evidence) {
      assert.equal(golden.text.slice(evidence.start, evidence.end), evidence.quote)
    }
    assert.equal(result.audit.outputHash.length, 64)
    assert.equal(parseBriefCompilation(JSON.parse(JSON.stringify(result))).audit.outputHash, result.audit.outputHash)
  }
})

test('stored compilation fails closed after content-addressed output tampering', async () => {
  const result = await createEvidenceBoundBriefCompiler()({ text: 'PÃºblico: gestores. Oferta: guia.' })
  const stored = JSON.parse(JSON.stringify(result))
  stored.compiled.fields.offer[0] = 'resultado inventado'
  assert.throws(() => parseBriefCompilation(stored), /Stored brief compilation is invalid/)
})
