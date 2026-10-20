import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

import {
  classifyCommandFailure,
  compareIssues,
  createIdempotencyKeys,
  issueChips,
  issueKey,
  issueProvenance,
  mergeSubtitleDimensions,
  panCrop,
  reframeResetBody,
  reframeSetBody,
  subtitleResetBody,
  subtitleSetBody,
  validateFrameRange,
  validateSubtitleDimensions,
} from '../../src/v2/ui/issue-override-view.ts'

/**
 * W68 UI: the chips of a proxy review, the evidence behind them, the exact Command bodies the panel sends and the way a failed request
 * is named. The presentational components are rendered for real (react-dom/server) from their TSX source, transpiled in memory.
 */
const SHA = (letter) => letter.repeat(64)
const VARIANT = 'variant-tall-0001'

function issue(overrides = {}) {
  return {
    code: 'NO_SAFE_SUBTITLE_REGION', severity: 'warning', category: 'editorial', message: 'Every band collides.', outputSpecId: 'spec-9x16',
    evidenceRange: { startFrame: 100, endFrame: 130 }, elementIds: ['subtitle:cue-b'], evidenceIds: ['face-clearance:' + SHA('c')], correctable: true, ...overrides,
  }
}
function review(technical = [], critic = [], extra = {}) {
  return {
    id: 'proxy-review-1', projectVersionId: 'version-2', proxyArtifactId: 'artifact-proxy-1', proxyManifestId: 'manifest-1', inputHash: SHA('a'),
    outputSpecId: 'spec-9x16', reviewHash: SHA('b'), revision: 1, status: 'warning-ack-required', warningsAcknowledged: false,
    technicalIssues: technical, criticIssues: critic,
    formatQuality: { outputPresetHash: SHA('d'), status: 'warning', exportAllowed: true, explanation: 'ok', reportHash: SHA('e') }, ...extra,
  }
}

test('every issue of a review is a chip: hard is block, warning is review, nothing is truncated, blocks come first', () => {
  const many = Array.from({ length: 9 }, (_, index) => issue({ code: 'SUBTITLE_ANCHOR_FALLBACK', elementIds: [`subtitle:cue-${index}`], evidenceRange: { startFrame: index * 40, endFrame: index * 40 + 30 } }))
  const chips = issueChips(review(many, [issue({ code: 'REFRAME_TRACKING_LIMIT_EXCEEDED', severity: 'hard', elementIds: [], evidenceRange: { startFrame: 10, endFrame: 20 } })]), VARIANT)
  assert.equal(chips.length, 10)
  assert.equal(chips[0].severity, 'block'); assert.equal(chips[0].domain, 'reframe'); assert.equal(chips[0].acknowledgeable, false)
  assert.ok(chips.slice(1).every((chip) => chip.severity === 'review' && chip.acknowledgeable && chip.domain === 'caption'))
  assert.deepEqual(chips.slice(1).map((chip) => chip.cueId), many.map((_, index) => `cue-${index}`))
  assert.ok(chips.every((chip) => chip.variantId === VARIANT))
  assert.equal(new Set(chips.map((chip) => chip.key)).size, 10, 'each chip has its own identity')
})

test('a pixel-critic issue and a reframe issue are told apart from other issues by what they name', () => {
  const chips = issueChips(review([
    issue({ code: 'CAPTION_PLACEMENT_MISMATCH', severity: 'hard', elementIds: ['subtitle:cue-a'] }),
    issue({ code: 'OUTPUT_CLIPPING', severity: 'hard', elementIds: ['element-1'] }),
  ]), VARIANT)
  assert.deepEqual(chips.map((chip) => [chip.code, chip.domain]).toSorted(), [['CAPTION_PLACEMENT_MISMATCH', 'caption'], ['OUTPUT_CLIPPING', 'other']])
})

test('the provenance lists the review, the input, the proxy, the format report and every evidence id: nothing is summarized away', () => {
  const [chip] = issueChips(review([issue({ evidenceIds: ['face-clearance:' + SHA('c'), 'ocr-envelope-1'], placementPlanHash: SHA('f') })]), VARIANT)
  const rows = issueProvenance(chip, review([]), { artifactId: 'artifact-proxy-1', sha256: SHA('9') })
  const byLabel = (label) => rows.filter((row) => row.label === label).map((row) => row.value)
  assert.deepEqual(byLabel('Laudo'), [SHA('b')])
  assert.deepEqual(byLabel('Entrada do render'), [SHA('a')])
  assert.deepEqual(byLabel('Proxy sha256'), [SHA('9')])
  assert.deepEqual(byLabel('Laudo de formato'), [SHA('e')])
  assert.deepEqual(byLabel('Plano de posicionamento'), [SHA('f')])
  assert.deepEqual(byLabel('Elemento'), ['subtitle:cue-b'])
  assert.deepEqual(byLabel('Evidência'), ['face-clearance:' + SHA('c'), 'ocr-envelope-1'])
  assert.deepEqual(byLabel('Saída'), [VARIANT])
})

test('a set carries the COMPLETE dimension list: an untouched earlier exception is carried over, not dropped', () => {
  const hashes = { 'caps-stroke': SHA('1') }
  const current = [{ kind: 'text', text: 'fala corrigida' }]
  const moved = mergeSubtitleDimensions(current, { anchor: 'top' }, hashes)
  assert.deepEqual(moved.map((dimension) => dimension.kind), ['position', 'text'])
  const styled = mergeSubtitleDimensions(moved, { presetId: 'caps-stroke', visible: false }, hashes)
  assert.deepEqual(styled.map((dimension) => dimension.kind), ['position', 'style', 'text', 'visibility'])
  assert.deepEqual(styled.find((dimension) => dimension.kind === 'style'), { kind: 'style', presetId: 'caps-stroke', presetVersion: 1, presetHash: SHA('1') })
  // back to the inherited level, one dimension at a time
  assert.deepEqual(mergeSubtitleDimensions(styled, { anchor: null, presetId: null, text: null, visible: true }, hashes), [])
  assert.throws(() => mergeSubtitleDimensions([], { presetId: 'nope' }, hashes), /Predefinição desconhecida/)
  // text is normalized once (NFC, LF, trimmed) so the same words are the same exception
  assert.deepEqual(mergeSubtitleDimensions([], { text: '  Ação\r\nja  ' }, hashes), [{ kind: 'text', text: 'Ação\nja'.normalize('NFC') }])
  assert.match(validateSubtitleDimensions([]), /Altere ao menos uma propriedade/)
  assert.match(validateSubtitleDimensions([{ kind: 'text', text: 'x'.repeat(201) }]), /entre 1 e 200/)
  assert.equal(validateSubtitleDimensions([{ kind: 'position', anchor: 'top' }]), null)
})

test('the Command bodies are the published shapes: base version and hash, the stable variant, no range for a subtitle, a pan-only crop', () => {
  const base = { baseVersionId: 'version-2', baseHash: SHA('a'), variantId: VARIANT }
  assert.deepEqual(subtitleSetBody(base, { segmentId: 'cue-b', dimensions: [{ kind: 'position', anchor: 'top' }], protectedException: true, reason: '  mover  ' }), {
    ...base, segmentId: 'cue-b', action: 'set', dimensions: [{ kind: 'position', anchor: 'top' }], protected: true, reason: 'mover',
  })
  assert.deepEqual(subtitleResetBody(base, { segmentId: 'cue-b' }), { ...base, segmentId: 'cue-b', action: 'reset' })
  assert.ok(!('dimensions' in subtitleResetBody(base, { segmentId: 'cue-b' })) && !('protected' in subtitleResetBody(base, { segmentId: 'cue-b' })), 'a reset carries neither')
  const crop = panCrop({ x: 0.1, y: 0, width: 0.316, height: 1 }, 0.9)
  assert.deepEqual(crop, { x: 0.684, y: 0, width: 0.316, height: 1 }, 'the crop is moved inside the frame, never resized')
  assert.deepEqual(panCrop({ x: 0.1, y: 0, width: 0.316, height: 1 }, -3).x, 0)
  assert.deepEqual(reframeSetBody(base, { clipId: 'clip-1', startFrame: 10, endFrame: 40, crop }), { ...base, clipId: 'clip-1', startFrame: 10, endFrame: 40, action: 'set', crop })
  assert.deepEqual(reframeResetBody(base, { clipId: 'clip-1', startFrame: 10, endFrame: 40 }), { ...base, clipId: 'clip-1', startFrame: 10, endFrame: 40, action: 'reset' })
  assert.equal(validateFrameRange({ startFrame: 10, endFrame: 40 }, { startFrame: 0, endFrame: 90 }), null)
  assert.match(validateFrameRange({ startFrame: 40, endFrame: 40 }, { startFrame: 0, endFrame: 90 }), /maior que o inicial/)
  assert.match(validateFrameRange({ startFrame: 10, endFrame: 91 }, { startFrame: 0, endFrame: 90 }), /dentro do clipe/)
})

test('one payload is one idempotency key (a retry replays), another payload is another key', () => {
  let counter = 0
  const key = createIdempotencyKeys(() => `r${++counter}`)
  const first = key('subtitle-set', { a: 1 })
  assert.equal(key('subtitle-set', { a: 1 }), first)
  assert.notEqual(key('subtitle-set', { a: 2 }), first)
  assert.notEqual(key('subtitle-reset', { a: 1 }), first)
  assert.ok(first.length >= 8 && first.length <= 128)
})

test('a failed request is named by a closed kind, the published code and the request id: never a body or a stack', () => {
  const body = (code, extra = {}) => ({ error: { code, message: 'internal detail that must not be the headline', requestId: 'req-1', ...extra } })
  assert.equal(classifyCommandFailure(401, body('AUTH_REQUIRED')).kind, 'session-expired')
  assert.equal(classifyCommandFailure(404, body('PROJECT_NOT_FOUND')).kind, 'not-found')
  assert.equal(classifyCommandFailure(403, body('FORBIDDEN')).kind, 'forbidden')
  assert.equal(classifyCommandFailure(409, body('VERSION_CONFLICT')).kind, 'stale-base')
  assert.equal(classifyCommandFailure(409, body('IDEMPOTENCY_PAYLOAD_MISMATCH')).kind, 'idempotency-mismatch')
  assert.equal(classifyCommandFailure(422, body('ASSET_RIGHTS_BLOCKED')).kind, 'rights-blocked')
  assert.equal(classifyCommandFailure(429, null).kind, 'rate-limited')
  assert.equal(classifyCommandFailure(0, null).kind, 'unavailable')
  const stale = classifyCommandFailure(409, body('VERSION_CONFLICT'))
  assert.equal(stale.requestId, 'req-1'); assert.equal(stale.code, 'VERSION_CONFLICT')
  assert.match(stale.message, /nada foi gravado/)
  assert.ok(!stale.message.includes('internal detail'))
})

test('a before/after comparison says "not reported now" only against a review of a NEW render, and never invents a resolution', () => {
  const before = issueChips(review([issue(), issue({ code: 'SUBTITLE_ANCHOR_FALLBACK', elementIds: ['subtitle:cue-c'] })]), VARIANT)
  const waiting = compareIssues(before, null)
  assert.ok(waiting.every((row) => row.delta === 'still-reported'), 'without an after-review nothing is resolved')
  const after = issueChips(review([issue({ code: 'SUBTITLE_ANCHOR_FALLBACK', elementIds: ['subtitle:cue-c'] }), issue({ code: 'FACE_PERCEPTION_UNAVAILABLE', elementIds: ['subtitle:cue-d'] })]), VARIANT)
  const rows = compareIssues(before, after)
  assert.deepEqual(rows.map((row) => [row.code, row.delta]), [
    ['NO_SAFE_SUBTITLE_REGION', 'not-reported-now'], ['SUBTITLE_ANCHOR_FALLBACK', 'still-reported'], ['FACE_PERCEPTION_UNAVAILABLE', 'new'],
  ])
  assert.equal(issueKey(issue()), issueKey({ ...issue(), message: 'another sentence' }), 'the wording is not the identity')
})

/* ---- the components, rendered from their TSX ---- */

const jsxRuntime = import.meta.resolve('react/jsx-runtime')
const viewUrl = pathToFileURL(new URL('../../src/v2/ui/issue-override-view.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href
async function loadComponents() {
  const source = ts.transpileModule(readFileSync(new URL('../../src/components/IssueChips.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replace(/from ['"]@\/v2\/ui\/issue-override-view['"]/, `from '${viewUrl}'`)
    .replace(/from ['"]react\/jsx-runtime['"]/, `from '${jsxRuntime}'`)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('rendered chips: severity label, code, frames and timecode, cue id; evidence is open and lists every id', async () => {
  const { IssueChipList, IssueEvidence } = await loadComponents()
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const chips = issueChips(review([
    issue({ evidenceIds: ['face-clearance:' + SHA('c'), 'ocr-envelope-1'] }),
    issue({ code: 'SUBTITLE_ANCHOR_UNSTABLE', severity: 'hard', elementIds: ['subtitle:cue-z'], evidenceRange: { startFrame: 61, endFrame: 91 } }),
  ]), VARIANT)
  const blocked = chips.find((chip) => chip.severity === 'block'), reviewed = chips.find((chip) => chip.severity === 'review')
  const html = renderToStaticMarkup(createElement(IssueChipList, { chips, selectedKey: blocked.key, fps: 30, onSelect() {} }))
  assert.equal((html.match(/data-testid="issue-chip"/g) ?? []).length, 2)
  assert.match(html, /data-severity="block"[^>]*>.*?Bloqueado · SUBTITLE_ANCHOR_UNSTABLE/s)
  assert.match(html, /Revisar · NO_SAFE_SUBTITLE_REGION/)
  assert.match(html, /quadros 61–91 · 00:00:02:01/)
  assert.match(html, /legenda cue-z/)
  assert.match(html, /aria-pressed="true"/)
  const evidence = renderToStaticMarkup(createElement(IssueEvidence, { chip: blocked, rows: issueProvenance(blocked, review([]), { artifactId: 'artifact-proxy-1', sha256: null }) }))
  assert.match(evidence, /<details[^>]*open=""/, 'the evidence panel is open by default')
  assert.match(evidence, new RegExp(`Laudo</dt><dd[^>]*>${SHA('b')}`))
  assert.match(evidence, /subtitle:cue-z/)
  const noEvidence = renderToStaticMarkup(createElement(IssueEvidence, { chip: { ...reviewed, evidenceIds: [] }, rows: [] }))
  assert.match(noEvidence, /não traz identificadores de evidência/, 'an empty list says so, it does not hide')
})

test('the panel source cannot accept an issue: no resolve control, every Command carries a key and the version, a block has no acknowledge', () => {
  const panel = readFileSync(new URL('../../src/components/IssueOverridePanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /^'use client'/)
  assert.doesNotMatch(panel, /[Rr]esolver|[Rr]esolvido|acknowledge-warnings|proxy-reviews/, 'the panel never writes an acceptance')
  assert.match(panel, /Nenhum botão aqui aceita um problema/)
  assert.equal((panel.match(/'idempotency-key': idempotencyKeys\(/g) ?? []).length, 3, 'the two Commands and the recompile enqueue each carry their key')
  assert.match(panel, /\/subtitle-segment-overrides`/); assert.match(panel, /\/variant-reframe-overrides`/); assert.match(panel, /\/proxy-renders`/)
  assert.match(panel, /\/v1\/operations\/\$\{encodeURIComponent\(id\)\}\/cancel/)
  assert.match(panel, /Confirmar o cancelamento/)
  assert.match(panel, /router\.replace\(`\/login\?next=/)
  assert.match(panel, /writeDraft\(projectId, variantId/)
})
