import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const batchUiSource = readFileSync(
  new URL('../../src/app/batches/page.tsx', import.meta.url),
  'utf8',
)
const dashboardSource = readFileSync(
  new URL('../../src/app/page.tsx', import.meta.url),
  'utf8',
)
const architectureLintSource = readFileSync(
  new URL('../../scripts/lint-architecture.mjs', import.meta.url),
  'utf8',
)

test('T-FR-080 /batches reads and mutates production batches only through the public V2 API', () => {
  for (const endpoint of [
    "fetch(`/v1/batches?${params}`",
    "fetch('/v1/batches'",
    'fetch(`/v1/batches/${encodeURIComponent(batchId)}`',
    'fetch(`/v1/batches/${encodeURIComponent(batch.id)}/actions`',
    'fetch(`/v1/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/actions`',
  ]) {
    assert.ok(batchUiSource.includes(endpoint), `missing API path: ${endpoint}`)
  }
  assert.doesNotMatch(batchUiSource, /@prisma\/client|generated\/prisma|PrismaClient|DATABASE_URL/)
  assert.match(architectureLintSource, /V2 UI imports legacy runtime/)
  assert.match(architectureLintSource, /V2 UI bypasses the public API/)
})

test('T-FR-080 creation compiles only explicitly selected recipe and format cells', () => {
  assert.match(batchUiSource, /const selectedCells = possibleCells\.filter\(\(cell\) => matrix\.has\(cell\)\)/)
  assert.match(batchUiSource, /selectedCells\.map\(\(cell\) =>/)
  assert.match(batchUiSource, /Só as células marcadas serão criadas/)
  assert.match(batchUiSource, /Produto teórico/)
  assert.match(batchUiSource, /Saídas que serão criadas/)
  assert.match(batchUiSource, /sourceGroupId: 'sources'/)
  assert.match(batchUiSource, /outputSpecId: format\.id/)
  assert.doesNotMatch(batchUiSource, /flatMap\([^)]*recipes[^)]*\)\.flatMap/)
})

test('T-FR-080 creation fails closed on rights, item selection and budget', () => {
  assert.match(batchUiSource, /media\.rightsStatus === 'approved'/)
  assert.match(batchUiSource, /sourceIds\.size === 0/)
  assert.match(batchUiSource, /selectedCells\.length === 0/)
  assert.match(batchUiSource, /Number\.isSafeInteger\(maxCostMinorUnits\)/)
  assert.match(batchUiSource, /idempotency-key/)
  assert.match(batchUiSource, /globalThis\.crypto\.randomUUID\(\)/)
})

test('T-FR-080 tracking renders truthful step, item, artifact, progress and cost state', () => {
  assert.match(batchUiSource, /batch\.progress\.completedSteps/)
  assert.match(batchUiSource, /batch\.progress\.totalSteps/)
  assert.match(batchUiSource, /batch\.progress\.percent/)
  assert.match(batchUiSource, /selectedBatch\.progress\.spentMinorUnits/)
  assert.match(batchUiSource, /selectedBatch\.progress\.remainingMinorUnits/)
  assert.match(batchUiSource, /<StepRail compact steps=\{item\.steps\}/)
  assert.match(batchUiSource, /item\.artifactIds\.map/)
  assert.match(batchUiSource, /item\.retryCount/)
  assert.doesNotMatch(batchUiSource, /Math\.random|fakeProgress|simulatedProgress/)
})

test('T-FR-087 /batches supports independent retry, resume, cancel and bulk selection', () => {
  assert.match(batchUiSource, /action: 'resume' \| 'retry-step'/)
  assert.match(batchUiSource, /void itemAction\(selectedBatch, item, 'retry-step', failedStep\.step\)/)
  assert.match(batchUiSource, /void itemAction\(selectedBatch, item, 'resume'\)/)
  assert.match(batchUiSource, /async function bulkAction\(action: 'cancel' \| 'resume'\)/)
  assert.match(batchUiSource, /expectedBatchRevision: batch\.revision/)
  assert.match(batchUiSource, /expectedItemRevision: item\.revision/)
  assert.match(batchUiSource, /setSelectedIds\(new Set\(\)\)/)
})

test('dashboard exposes the V2 production-batch control room as a first-class destination', () => {
  assert.match(dashboardSource, /href="\/batches"/)
  assert.match(dashboardSource, />\s*Lotes\s*</)
  assert.doesNotMatch(architectureLintSource, /['"]src\/app\/batches['"]/)
})
