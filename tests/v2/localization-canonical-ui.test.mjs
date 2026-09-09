import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../../src/app/localization/page.tsx', import.meta.url),
  'utf8',
)

test('F5 localization UI creates a canonical script only from a reviewed candidate with immutable fences', () => {
  assert.match(source, /canonical-script-versions\/candidates/)
  assert.match(source, /data-testid="canonical-script-panel"/)
  assert.match(source, /data-testid="canonical-candidate"/)
  assert.match(source, /expectedAlignmentHash: candidate\.alignmentHash/)
  assert.match(source, /projectVersionId: candidate\.projectVersionId/)
  assert.match(source, /alignmentId: candidate\.alignmentId/)
  assert.match(source, /data-testid="approve-canonical-script"/)
  assert.match(source, /Aprovar e criar versão canônica/)
  assert.doesNotMatch(source, /fetch\([^)]*\/api\/process/)
})

test('F5 canonical approval exposes per-block protection, adaptation and CTA instead of a generic action', () => {
  assert.match(source, /Afirmações protegidas/)
  assert.match(source, /Ressalvas obrigatórias/)
  assert.match(source, /Fatos que não podem mudar/)
  assert.match(source, /adaptationLevel/)
  assert.match(source, /ctaAction/)
  assert.match(source, /ctaDestination/)
  assert.match(source, /protectionsByBlock/)
  assert.match(source, /idempotency-key/)
})

test('F5 localization profile form captures locale, market and explicit allowed modes', () => {
  assert.match(source, /data-testid="create-localization-profile"/)
  assert.match(source, /newProfileLocale/)
  assert.match(source, /newProfileMarket/)
  assert.match(source, /newProfileModes/)
  assert.match(source, /allowedModes: newProfileModes/)
  assert.match(source, /newProfileModes\.length === 0/)
})

test('F5 translation UI performs preflight, displays the configured bound, then confirms the exact token', () => {
  assert.match(source, /localization-variants\/\$\{encodeURIComponent\(variant\.id\)\}\/translation-preflight/)
  assert.match(source, /\.estimatedCostMicros \/ 1_000_000/)
  assert.match(source, /\.maximumCostMicros \/ 1_000_000/)
  assert.match(source, /expectedPreflightHash: translationPreflight\.preflight\.preflightHash/)
  assert.match(source, /commitToken: translationPreflight\.commitToken/)
  assert.match(source, /Confirmar custo e traduzir/)
  assert.doesNotMatch(source, /data-testid="translation-preflight-required"\s*\n\s*disabled\s/)
})
