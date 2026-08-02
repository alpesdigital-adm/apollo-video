import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const dashboardSource = readFileSync(
  new URL('../../src/app/page.tsx', import.meta.url),
  'utf8',
)

test('T-FR-236 dashboard consumes the public visible-state contract without inferring legacy statuses', () => {
  assert.match(dashboardSource, /visibleState: VisibleState/)
  assert.match(dashboardSource, /projectBucket\(project\.visibleState\)/)
  assert.match(dashboardSource, /PROJECT_TONE_CLASSES\[project\.visibleState\.tone\]/)
  assert.match(dashboardSource, /PROJECT_STATE_LABELS\[project\.visibleState\.label\]/)
  assert.match(dashboardSource, /PROJECT_ACTION_LABELS\[project\.visibleState\.primaryAction\]/)
  assert.doesNotMatch(dashboardSource, /function projectState\(status:/)
  assert.doesNotMatch(
    dashboardSource,
    /status === ['"](?:complete|error|ready|awaiting-review|directing|rendering)['"]/,
  )
  assert.equal(
    existsSync(new URL('../../src/v2/domain/project-dashboard.ts', import.meta.url)),
    false,
  )
})
