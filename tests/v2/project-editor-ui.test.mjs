import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const projectEditorSource = readFileSync(
  new URL('../../src/app/projects/[id]/page.tsx', import.meta.url),
  'utf8',
)
const appLayoutSource = readFileSync(
  new URL('../../src/app/layout.tsx', import.meta.url),
  'utf8',
)
const dockerfileSource = readFileSync(
  new URL('../../Dockerfile', import.meta.url),
  'utf8',
)

test('project editor prioritizes the version-bound review artifact with the approved final as fallback', () => {
  assert.match(
    projectEditorSource,
    /media\.find\(\(item\) => item\.artifactId === review\?\.session\.proxyArtifactId\)/,
  )
  assert.match(
    projectEditorSource,
    /\?\? finalOutput/,
  )
  assert.match(
    projectEditorSource,
    /playsInline\s+preload="auto"/,
  )
  assert.match(projectEditorSource, /src=\{review\?\.session\.proxyUrl \?\? `\/v1\/artifacts\/\$\{encodeURIComponent\(editingProxy\.artifactId\)\}\/content`\}/)
  assert.match(projectEditorSource, /if \(video\.networkState === 0\) video\.load\(\)/)
  assert.match(projectEditorSource, /'Reproduzir preview'/)
  assert.doesNotMatch(projectEditorSource, /<video[^>]+preload="metadata"/)
})

test('Apollo version is globally visible and receives the deployed build revision', () => {
  assert.match(appLayoutSource, /Apollo · \{versionLabel\}/)
  assert.match(appLayoutSource, /fixed bottom-2 right-3/)
  assert.match(appLayoutSource, /pointer-events-none/)
  assert.match(dockerfileSource, /ARG APOLLO_BUILD_REVISION=local/)
  assert.match(
    dockerfileSource,
    /ENV NEXT_TELEMETRY_DISABLED=1 \\\s+APOLLO_BUILD_REVISION=\$APOLLO_BUILD_REVISION/,
  )
})

test('project editor exposes version-bound spatial review through the public annotation API', () => {
  assert.match(projectEditorSource, /new URLSearchParams\(\{ limit: '50' \}\)/)
  assert.match(projectEditorSource, /query\.set\('projectVersionId', projectVersionId\)/)
  assert.match(projectEditorSource, /'idempotency-key': crypto\.randomUUID\(\)/)
  assert.match(projectEditorSource, /captureReviewScreenshot\(\)/)
  assert.match(projectEditorSource, /onPointerDown=\{beginReviewMark\}/)
  assert.match(projectEditorSource, /onPointerMove=\{moveReviewMark\}/)
  assert.match(projectEditorSource, /onPointerUp=\{finishReviewMark\}/)
  assert.match(projectEditorSource, /review\.session\.stale/)
  assert.match(projectEditorSource, /Marcar ajuste/)
  assert.match(projectEditorSource, /A versão do vídeo não foi alterada/)
})

test('project editor switches immutable previews without losing timecode and exposes all nine application scopes', () => {
  assert.match(projectEditorSource, /const preservedPreviewTimeMs = useRef<number \| null>\(null\)/)
  assert.match(projectEditorSource, /preservedPreviewTimeMs\.current = Math\.round\(video\.currentTime \* 1000\)/)
  assert.match(projectEditorSource, /function initializePreviewPosition\(\): void/)
  assert.match(projectEditorSource, /data-testid="review-version-rail"/)
  assert.match(projectEditorSource, /data-testid="review-stale-banner"/)
  for (const kind of ['frame', 'region', 'clip', 'scene', 'range', 'project', 'formats', 'locales', 'recipes']) {
    assert.match(projectEditorSource, new RegExp(`${kind}:`))
  }
  assert.match(projectEditorSource, /data-testid="review-application-scope"/)
  assert.match(projectEditorSource, /data-testid="review-global-toggle"/)
  assert.match(projectEditorSource, /data-testid="review-global-confirmation"/)
  assert.match(projectEditorSource, /confirmedGlobal: reviewGlobalConfirmed/)
})

test('annotation seek keeps the media position, visible timecode and performance sample synchronized', () => {
  assert.match(projectEditorSource, /function seekPreviewToFrame\(frame: number\)/)
  assert.match(projectEditorSource, /previewSeekStartedAt\.current = performance\.now\(\)\s+video\.currentTime = Math\.max\(0, frame \/ fps\)\s+readPreviewPosition\(\)/)
  assert.match(projectEditorSource, /function finishPreviewSeek\(\): void \{[\s\S]*?readPreviewPosition\(\)\s+\}/)
  assert.match(projectEditorSource, /onClick=\{\(\) => seekPreviewToFrame\(annotation\.frame\)\}/)
  assert.match(projectEditorSource, /data-testid="project-preview"/)
  assert.match(projectEditorSource, /data-testid="review-overlay"/)
})

test('T-FR-214 project editor exposes typed impact gates and explicit immutable patch confirmation', () => {
  assert.match(projectEditorSource, /\/patch-proposals/)
  assert.match(projectEditorSource, /data-testid="review-patch-impact"/)
  assert.match(projectEditorSource, /PATCH_GATE_LABELS/)
  assert.match(projectEditorSource, /Intenção/)
  assert.match(projectEditorSource, /Proteções/)
  assert.match(projectEditorSource, /Política/)
  assert.match(projectEditorSource, /Budget/)
  assert.match(projectEditorSource, /data-testid="review-patch-apply"/)
  assert.match(projectEditorSource, /Confirmar e criar versão/)
  assert.match(projectEditorSource, /data-testid="review-patch-comparison"/)
})

test('T-FR-215 project editor batches selected annotations with explicit atomic or partial semantics', () => {
  assert.match(projectEditorSource, /reviewBatchSelection/)
  assert.match(projectEditorSource, /Promise\.all\(/)
  assert.match(projectEditorSource, /\/patch-batches/)
  assert.match(projectEditorSource, /prepareReviewPatchBatch\('all-or-nothing'\)/)
  assert.match(projectEditorSource, /prepareReviewPatchBatch\('partial-retry'\)/)
  assert.match(projectEditorSource, /data-testid="review-batch-toolbar"/)
  assert.match(projectEditorSource, /data-testid="review-batch-impact"/)
  assert.match(projectEditorSource, /Caderno do lote/)
  assert.match(projectEditorSource, /Confirmar lote/)
})

test('T-FR-216 project editor exposes the API-backed timeline, inspector and keyboard/mouse gestures', () => {
  assert.match(projectEditorSource, /\/timeline/)
  assert.match(projectEditorSource, /\/manual-edits/)
  assert.match(projectEditorSource, /data-testid="manual-editor"/)
  assert.match(projectEditorSource, /data-testid=\{`manual-clip-\$\{clip\.id\}`\}/)
  assert.match(projectEditorSource, /onPointerDown=\{\(event\) => manualPointerDown\(event, clip\.id\)\}/)
  assert.match(projectEditorSource, /onPointerUp=\{manualPointerUp\}/)
  assert.match(projectEditorSource, /onKeyDown=\{manualKeyboard\}/)
  assert.match(projectEditorSource, /event\.key\.toLowerCase\(\) === 's'/)
  assert.match(projectEditorSource, /event\.key === 'Delete'/)
  assert.match(projectEditorSource, /data-testid="manual-inspector"/)
  for (const field of ['layout', 'text', 'subtitle', 'color', 'motion', 'audioGain']) {
    assert.match(projectEditorSource, new RegExp(field))
  }
  assert.match(projectEditorSource, /data-testid="manual-undo"/)
  assert.match(projectEditorSource, /data-testid="manual-redo"/)
  assert.match(projectEditorSource, /expectedRevision: manualTimeline\.timeline\.revision/)
})

test('T-FR-217 project editor compares immutable previews and exposes explicit preserved-version actions', () => {
  assert.match(projectEditorSource, /\/version-comparisons/)
  assert.match(projectEditorSource, /data-testid="version-compare"/)
  assert.match(projectEditorSource, /data-testid=\{`compare-mode-\$\{mode\}`\}/)
  assert.match(projectEditorSource, /\(\['toggle', 'split', 'overlay'\] as const\)/)
  assert.match(projectEditorSource, /comparison\.synchronized/)
  assert.match(projectEditorSource, /synchronizeComparedVideo/)
  assert.match(projectEditorSource, /data-testid="compare-semantic-diff"/)
  assert.match(projectEditorSource, /issuesResolved/)
  assert.match(projectEditorSource, /issuesAdded/)
  assert.match(projectEditorSource, /submitVersionComparisonAction\('accept'\)/)
  assert.match(projectEditorSource, /submitVersionComparisonAction\('reopen'\)/)
  assert.match(projectEditorSource, /submitVersionComparisonAction\('restore'\)/)
  assert.match(projectEditorSource, /sem apagar o histórico/)
})

test('T-FR-120 project editor exposes API-backed source versus clean evidence', () => {
  assert.match(
    projectEditorSource,
    /\/source-deconstructions\?limit=20/,
  )
  assert.match(
    projectEditorSource,
    /data-testid="source-deconstruction-panel"/,
  )
  assert.match(
    projectEditorSource,
    /data-testid="source-deconstruction-source-track"/,
  )
  assert.match(
    projectEditorSource,
    /data-testid="source-deconstruction-clean-track"/,
  )
  assert.match(
    projectEditorSource,
    /data-testid="source-deconstruction-transcript"/,
  )
  assert.match(projectEditorSource, /O que fica\. O que sai\. Por quê\./)
  assert.match(projectEditorSource, /comparison\.removedRangesMs/)
  assert.match(projectEditorSource, /semanticContaminants\.map/)
  assert.match(projectEditorSource, /SOURCE_CONTAMINANT_LABELS/)
  assert.match(
    projectEditorSource,
    /contexto \{selectedSourceDeconstruction\.contextPreserved/,
  )
})

test('T-FR-230 project editor exposes the persisted proxy verdict and blocks final export until release', () => {
  assert.match(projectEditorSource, /\/proxy-reviews/)
  assert.match(projectEditorSource, /data-testid="proxy-review-gate"/)
  assert.match(projectEditorSource, /Laudo do proxy/)
  assert.match(projectEditorSource, /Correção obrigatória/)
  assert.match(projectEditorSource, /Ressalvas para decidir/)
  assert.match(projectEditorSource, /Liberado para alta/)
  assert.match(projectEditorSource, /data-testid="proxy-review-issues"/)
  assert.match(projectEditorSource, /data-testid="proxy-review-acknowledge"/)
  assert.match(projectEditorSource, /baseRevision: proxyReview\.reviewHash/)
  assert.match(projectEditorSource, /expectedRevision: proxyReview\.revision/)
  assert.match(projectEditorSource, /proxyReview\?\.projectVersionId !== workspace\.version\?\.id \|\| !proxyReview\.finalAllowed/)
  assert.match(projectEditorSource, /Aguardando liberação do proxy/)
})
