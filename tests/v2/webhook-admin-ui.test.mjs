import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../../src/components/WebhookControlRoom.tsx', import.meta.url),
  'utf8',
)
const hubSource = readFileSync(
  new URL('../../src/components/WorkspaceCapabilityHub.tsx', import.meta.url),
  'utf8',
)
const settingsPageSource = readFileSync(
  new URL('../../src/app/workspace-settings/page.tsx', import.meta.url),
  'utf8',
)

test('T-FR-244 webhook administration UI uses only the public V2 API in parallel', () => {
  for (const path of [
    "fetch('/v1/webhooks/endpoints?limit=100'",
    "fetch('/v1/webhooks/subscriptions?limit=100'",
    "fetch('/v1/webhooks/deliveries?limit=100'",
    "fetch('/v1/events/catalog'",
    '/signing-secrets/rotations?limit=100',
  ]) assert.ok(source.includes(path), `missing public API read: ${path}`)
  assert.match(source, /Promise\.all\(\[/)
  assert.doesNotMatch(source, /@prisma|generated\/prisma|PrismaClient|DATABASE_URL|repository-factory/)
  assert.match(hubSource, /section === 'settings' \? <WebhookControlRoom \/>/)
  assert.match(settingsPageSource, /requireActiveUiPageSession\('\/workspace-settings'\)/)
})

test('T-FR-244 webhook administration UI operates lifecycle, subscriptions and replay with fences', () => {
  for (const evidence of [
    "idempotency-key': actionKey",
    '/challenge`',
    'JSON.stringify({ status, baseRevision: endpoint.revision })',
    'JSON.stringify({ status, baseRevision: subscription.revision })',
    '/signing-secrets/rotations`',
    '/activate`',
    '/cancel`',
    '/replay`',
  ]) assert.ok(source.includes(evidence), `missing fenced UI action: ${evidence}`)
  assert.match(source, /globalThis\.crypto\.randomUUID\(\)/)
  assert.doesNotMatch(source, /Math\.random|\/api\/|localStorage|sessionStorage/)
})

test('T-FR-244 webhook UI renders real attempt diagnostics and one-time secret handling', () => {
  assert.match(source, /data-testid="webhook-attempt-timeline"/)
  assert.match(source, /diagnostic\.attempts\.map/)
  assert.match(source, /attempt\.responseStatus/)
  assert.match(source, /attempt\.errorCode/)
  assert.match(source, /data-testid="webhook-secret-disclosure"/)
  assert.match(source, /Esta chave não será exibida novamente/)
  assert.match(source, /setSecret\(''\)/)
  assert.match(source, /role=\{messageTone === 'error' \? 'alert' : 'status'\}/)
  assert.match(source, /setMessageTone\('error'\)/)
})
