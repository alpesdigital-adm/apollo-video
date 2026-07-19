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

test('project editor prioritizes the approved final artifact and eagerly loads its preview', () => {
  assert.match(
    projectEditorSource,
    /const editingProxy = useMemo\(\(\) => finalOutput \?\? /,
  )
  assert.match(
    projectEditorSource,
    /playsInline preload="auto"/,
  )
  assert.match(projectEditorSource, /src=\{`\/v1\/artifacts\/\$\{encodeURIComponent\(editingProxy\.artifactId\)\}\/content`\}/)
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
