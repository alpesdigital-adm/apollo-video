import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../../src/components/WorkspaceLutLibrary.tsx', import.meta.url),
  'utf8',
)
const hubSource = readFileSync(
  new URL('../../src/components/WorkspaceCapabilityHub.tsx', import.meta.url),
  'utf8',
)

test('T-FR-181 LUT library UI reads only immutable public V2 resources', () => {
  for (const evidence of [
    "fetch('/v1/session'",
    '/luts?limit=100`,',
    '/lut-default`,',
    'Promise.all([',
    'currentVersion.preview.path',
  ]) assert.ok(source.includes(evidence), `missing API-first read: ${evidence}`)
  assert.doesNotMatch(source, /@prisma|generated\/prisma|PrismaClient|DATABASE_URL|\/api\//)
  assert.match(hubSource, /section === 'brand' \? <WorkspaceLutLibrary \/>/)
})

test('T-FR-181 import validates the client envelope and sends the cube to the authoritative API', () => {
  for (const evidence of [
    ".endsWith('.cube')",
    '8 * 1024 * 1024',
    'cubeContent = await file.text()',
    "method: 'POST'",
    "'idempotency-key': idempotencyKey('ui-lut-import')",
    'license: { policy: licensePolicy',
    'compatibility: { inputColorSpace, outputColorSpace }',
  ]) assert.ok(source.includes(evidence), `missing import evidence: ${evidence}`)
  assert.match(source, /globalThis\.crypto\.randomUUID\(\)/)
  assert.doesNotMatch(source, /Math\.random/)
})

test('T-FR-181 comparison and lifecycle preserve immutable historical versions', () => {
  assert.match(source, /data-testid="lut-comparison-table"/)
  assert.match(source, /data-testid=\{`lut-compare-/)
  assert.match(source, /baseRevision: lifecycle\.lifecycle\.revision/)
  assert.match(source, /LUT removida das novas seleções\. Versões antigas continuam reproduzíveis\./)
  assert.match(source, /currentDefaultId !== lut\.id/)
  assert.match(source, /Troque o padrão antes de retirar\./)
  assert.doesNotMatch(source, /method: ['"]DELETE['"]|deleteLut|removeLut/)
})

test('T-FR-181 workspace default supports immutable version selection and explicit none', () => {
  assert.match(source, /selection: lut \? \{ mode: 'lut-version', lutId: lut\.id, version: lut\.currentVersion\.version \} : \{ mode: 'none' \}/)
  assert.match(source, /baseRevision: workspaceDefault\.revision/)
  assert.match(source, /Usar sem LUT/)
  assert.match(source, /Alterar o padrão não reescreve projetos antigos/)
})
