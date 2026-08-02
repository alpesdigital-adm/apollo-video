import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const batchUiSource = readFileSync(
  new URL('../../src/app/batches/page.tsx', import.meta.url),
  'utf8',
)
const dashboardSource = readFileSync(
  new URL('../../src/app/ProjectsPageClient.tsx', import.meta.url),
  'utf8',
)
const appShellSource = readFileSync(
  new URL('../../src/components/AppShellNavigation.tsx', import.meta.url),
  'utf8',
)
const appShellRegistrySource = readFileSync(
  new URL('../../src/v2/domain/app-shell.ts', import.meta.url),
  'utf8',
)
const capabilityHubSource = readFileSync(
  new URL('../../src/components/WorkspaceCapabilityHub.tsx', import.meta.url),
  'utf8',
)
const workspaceSelectorSource = readFileSync(
  new URL('../../src/components/WorkspaceSelector.tsx', import.meta.url),
  'utf8',
)
const workspaceSwitchRouteSource = readFileSync(
  new URL('../../src/app/v1/session/workspace/route.ts', import.meta.url),
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
  assert.match(batchUiSource, /batch\.visibleState\.tone/)
  assert.match(batchUiSource, /batch\.visibleState\.label/)
  assert.match(batchUiSource, /item\.visibleState\.tone/)
  assert.match(batchUiSource, /item\.visibleState\.label/)
  assert.match(batchUiSource, /batch\.visibleState\.availableActions\.includes\('cancel'\)/)
  assert.doesNotMatch(batchUiSource, /STATUS_STYLES\[batch\.status\]/)
  assert.doesNotMatch(batchUiSource, /STATUS_LABELS\[batch\.status\]/)
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
  assert.match(dashboardSource, /AppShellNavigation active="projects"/)
  assert.match(appShellRegistrySource, /id: 'batches', label: 'Lotes', href: '\/batches', available: true/)
  assert.doesNotMatch(architectureLintSource, /['"]src\/app\/batches['"]/)
})

test('F0.031 shell declares six canonical destinations and retains fail-closed unavailable rendering', () => {
  for (const id of ['projects', 'batches', 'library', 'presenters', 'brand', 'settings']) {
    assert.match(appShellRegistrySource, new RegExp(`id: '${id}'`))
  }
  assert.equal((appShellRegistrySource.match(/available: true/g) ?? []).length, 6)
  assert.match(appShellSource, /if \(!destination\.available\)/)
  assert.match(appShellSource, /aria-disabled="true"/)
  assert.match(appShellSource, /Capability V2 ainda não integrada/)
  assert.match(capabilityHubSource, /fetch\('\/v1\/capabilities'/)
  assert.match(capabilityHubSource, /Nenhum profile fictício foi criado/)
  assert.doesNotMatch(capabilityHubSource, /@prisma|PrismaClient|DATABASE_URL/)
})

test('F0.031 workspace selector rotates through the public API and destroys prior workspace client state', () => {
  assert.match(appShellSource, /<WorkspaceSelector \/>/)
  assert.match(workspaceSelectorSource, /fetch\('\/v1\/session', \{ cache: 'no-store'/)
  assert.match(workspaceSelectorSource, /fetch\('\/v1\/session\/workspace'/)
  assert.match(workspaceSelectorSource, /apollo:workspace-changing/)
  assert.match(workspaceSelectorSource, /startsWith\('apollo:workspace:'\)/)
  assert.match(workspaceSelectorSource, /startsWith\('apollo-workspace-'\)/)
  assert.match(workspaceSelectorSource, /window\.location\.assign\('\/'\)/)
  assert.match(workspaceSwitchRouteSource, /isSameOrigin\(request\)/)
  assert.match(workspaceSwitchRouteSource, /rotateDurableUiSessionService/)
  assert.doesNotMatch(workspaceSelectorSource, /@prisma|PrismaClient|DATABASE_URL/)
})

test('T-FR-084 /batches compiles and renders VariantRecipe through the public V2 API', () => {
  assert.match(
    batchUiSource,
    /\/v1\/batches\/\$\{encodeURIComponent\(selectedBatch!\.id\)\}\/variant-recipes\?limit=100/,
  )
  assert.match(
    batchUiSource,
    /\/v1\/batches\/\$\{encodeURIComponent\(selectedBatch\.id\)\}\/variant-recipes/,
  )
  assert.match(batchUiSource, /data-testid="variant-recipe-panel"/)
  assert.match(batchUiSource, /data-testid="create-variant-recipe"/)
  assert.match(
    batchUiSource,
    /expectedCompatibilityGraphRunHash:\s*activeCompatibilityGraph\.runHash/,
  )
  assert.match(batchUiSource, /edge\.decision === 'accepted'/)
  assert.match(batchUiSource, /proofOptionalObjectives/)
  assert.match(batchUiSource, /scores\.minimumEdgeScore/)
  assert.match(batchUiSource, /storyPlan\.blocks/)
  assert.match(batchUiSource, /editPlan\.duplicatesMasters/)
  assert.match(batchUiSource, /entry\.scriptBlockId/)
  assert.match(batchUiSource, /entry\.takeId/)
  assert.match(batchUiSource, /entry\.sourceRangeMs/)
})

test('T-FR-085 /batches preflights a bounded portfolio through the public V2 API before any job', () => {
  assert.match(
    batchUiSource,
    /\/v1\/batches\/\$\{encodeURIComponent\(selectedBatch!\.id\)\}\/variant-portfolio-preflights\?limit=100/,
  )
  assert.match(
    batchUiSource,
    /\/v1\/batches\/\$\{encodeURIComponent\(selectedBatch\.id\)\}\/variant-portfolio-preflights/,
  )
  assert.match(
    batchUiSource,
    /data-testid="variant-portfolio-preflight-panel"/,
  )
  assert.match(
    batchUiSource,
    /data-testid="create-variant-portfolio-preflight"/,
  )
  assert.match(
    batchUiSource,
    /data-testid="confirm-variant-portfolio-expansion"/,
  )
  assert.match(batchUiSource, /theoreticalCandidateCount/)
  assert.match(batchUiSource, /eligibleCandidateCount/)
  assert.match(batchUiSource, /estimatedCostMinorUnits/)
  assert.match(batchUiSource, /estimatedDurationSeconds/)
  assert.match(batchUiSource, /estimatedStorageBytes/)
  assert.match(batchUiSource, /expectedReuseRate/)
  assert.match(batchUiSource, /confirmationToken/)
  assert.match(batchUiSource, /produto cartesiano nunca materializado/)
  assert.match(batchUiSource, /0 jobs criados/)
})

test('T-FR-086 /batches edits only an explicit recipe, format and target scope through the public V2 API', () => {
  for (const endpoint of [
    '/edit-preflights?limit=100',
    '/edit-commands?limit=100',
    '/edit-preflights`',
    '/edit-preflights/${encodeURIComponent(activeBatchEditPreflight.id)}/commit',
  ]) {
    assert.ok(batchUiSource.includes(endpoint), `missing API path: ${endpoint}`)
  }
  assert.match(batchUiSource, /data-testid="batch-edit-panel"/)
  assert.match(batchUiSource, /data-testid="batch-edit-explicit-scope"/)
  assert.match(batchUiSource, /data-testid="create-batch-edit-preflight"/)
  assert.match(batchUiSource, /data-testid="commit-batch-edit"/)
  assert.match(batchUiSource, /batchEditDraftRecipeIds/)
  assert.match(batchUiSource, /batchEditDraftOutputSpecIds/)
  assert.match(batchUiSource, /batchEditDraftItems\.map\(\(item\) => item\.id\)/)
  assert.match(batchUiSource, /expectedBatchRevision: selectedBatch\.revision/)
  assert.match(
    batchUiSource,
    /expectedBatchDefinitionHash: selectedBatch\.definitionHash/,
  )
  assert.match(batchUiSource, /expectedPreflightHash:/)
  assert.match(batchUiSource, /expectedScopeHash:/)
  assert.match(batchUiSource, /commitToken: batchEditCommitToken/)
  assert.match(batchUiSource, /idempotency-key/)
})

test('T-FR-086 /batches previews diff, conflicts, invalidations, cost and per-item outcomes before and after commit', () => {
  assert.match(batchUiSource, /activeBatchEditPreflight\.sampleDiff/)
  assert.match(batchUiSource, /activeBatchEditPreflight\.protectedConflictCount/)
  assert.match(batchUiSource, /activeBatchEditPreflight\.invalidationCount/)
  assert.match(batchUiSource, /activeBatchEditPreflight\.estimatedCostMinorUnits/)
  assert.match(batchUiSource, /activeBatchEditPreflight\.budgetRemainingMinorUnits/)
  assert.match(batchUiSource, /activeBatchEditPreflight\.warningCodes/)
  assert.match(batchUiSource, /activeBatchEditCommand\.resultItems/)
  assert.match(batchUiSource, /result\.invalidatedSteps/)
  assert.match(batchUiSource, /batchEditMode/)
  assert.match(batchUiSource, /all-or-nothing/)
  assert.match(batchUiSource, /skip-failures/)
  assert.match(batchUiSource, /O primeiro clique apenas calcula/)
  assert.match(
    batchUiSource,
    /detailView === 'outputs'[\s\S]*selectedBatch\.items\.map[\s\S]*\{batchEditPanel\}[\s\S]*data-testid="script-alignment-panel"/,
  )
  assert.doesNotMatch(
    batchUiSource,
    /fetch\(['"`]\/api\/.*(?:batch|edit)/,
  )
})

test('T-FR-087 /batches retries all failed steps through the public partial-retry API', () => {
  assert.ok(
    batchUiSource.includes('/partial-retries?limit=100'),
    'partial retry history must load through the public API',
  )
  assert.ok(
    batchUiSource.includes('/partial-retries`'),
    'mixed retry must post through the public API',
  )
  assert.match(
    batchUiSource,
    /data-testid="batch-partial-retry-panel"/,
  )
  assert.match(
    batchUiSource,
    /data-testid="retry-all-failed-batch-steps"/,
  )
  assert.match(batchUiSource, /expectedStepHash: failedStep\.stepHash/)
  assert.match(batchUiSource, /expectedItemRevision: item\.revision/)
  assert.match(batchUiSource, /expectedBatchRevision: batch\.revision/)
  assert.match(batchUiSource, /preservedCompletedItemIds/)
  assert.match(batchUiSource, /preservedArtifactIds/)
  assert.match(batchUiSource, /spentMinorUnitsAfter/)
  assert.match(batchUiSource, /chargedMinorUnitsAtEnqueue/)
})
