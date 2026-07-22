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
