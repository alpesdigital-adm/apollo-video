import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('T-F2-GATE is wired to real three-file, proof, long-form and five-format journeys', async () => {
  const [compatibility, contiguous, exports, workflow] = await Promise.all([
    read('tests/v2/prisma-compatibility-graph.integration.mjs'),
    read('tests/v2/contiguous-extraction-golden.integration.mjs'),
    read('tests/v2/export-matrix.e2e.mjs'),
    read('.github/workflows/ci.yml'),
  ])

  assert.match(compatibility, /T-F2-GATE/)
  assert.match(compatibility, /primaryByRole\.hook\?\.length, 6/)
  assert.match(compatibility, /primaryByRole\.body\?\.length, 3/)
  assert.match(compatibility, /primaryByRole\.cta\?\.length, 3/)
  assert.match(compatibility, /blindCartesianCount, 54/)
  assert.match(compatibility, /category: 'testimonial'/)
  assert.match(compatibility, /selectedProof\.selectedEvidence\.id/)
  assert.match(compatibility, /selectedIntegrityRun\.summary\.readyForAssembly/)

  assert.match(contiguous, /T-F2-GATE\/T-FR-134/)
  assert.match(contiguous, /SOURCE_DURATION_MS = 7_200_000/)
  assert.match(contiguous, /TARGET_DURATION_MS = 120_000/)
  assert.match(contiguous, /synthesizedRanges, false/)

  assert.match(exports, /T-F2-GATE\/F2\.028/)
  assert.match(exports, /FORMATS = \['9:16', '16:9', '4:5', '1:1', '21:9'\]/)
  assert.match(exports, /formatCritics\.length, 5/)
  assert.match(exports, /qualitySnapshotId/)

  assert.match(workflow, /Run Phase 2 three-file reuse, validated hook, testimonial proof and ProofMode E2E/)
  assert.match(workflow, /npm run test:integration:contiguous-extraction-golden/)
  assert.match(workflow, /npm run test:e2e:export-matrix/)
})
