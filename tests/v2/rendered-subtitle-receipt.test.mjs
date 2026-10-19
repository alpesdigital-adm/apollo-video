import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRenderElementMap } from '../../src/v2/domain/review-system.ts'
import { createRenderedSubtitleReceipt } from '../../src/v2/domain/rendered-subtitle-receipt.ts'
import { createOutputSpec, OUTPUT_PRESETS } from '../../src/v2/domain/output-spec.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'

const sha = (character) => character.repeat(64)
const spec = createOutputSpec(OUTPUT_PRESETS['9:16'])
const event = 'Dialogue: 0,0:00:00.00,0:00:01.20,Default,,0,0,0,,{\\an5\\pos(200,300)}Ação\\Nclara'

function fixture(overrides = {}) {
  const map = buildRenderElementMap({
    proxyHash: sha('a'), fps: 30, durationFrames: 90,
    canvas: { width: 1080, height: 1920 }, source: { width: 1920, height: 1080 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 90 }],
    subtitleCues: [{ id: 'cue-1', startFrame: 0, endFrame: 36, text: 'Ação clara' }],
  })
  return {
    workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    variantId: 'variant-a', outputSpec: spec,
    outputSpecRevisionId: 'revision-1', outputSpecHash: calculateCanonicalHash(spec),
    producer: { operationId: 'render-1', attempt: 1 },
    outputArtifactId: 'artifact-1', outputSha256: sha('a'), outputByteSize: 1111,
    renderInputHash: sha('b'), ffmpegBinarySha256: sha('c'), map,
    assBytes: Buffer.from(`[Script Info]\n[Events]\n${event}\n`),
    drawnCues: [{ cueId: 'cue-1', startFrame: 0, endFrame: 36, displayText: 'Ação\nclara',
      assEventLine: event, anchorDecisionHash: sha('d') }],
    suppressedCueIds: ['cue-2'],
    ...overrides,
  }
}

test('W69 receipt binds exact emitted ASS text, output variant, producer and sampled map', () => {
  const input = fixture()
  const receipt = createRenderedSubtitleReceipt(input)
  assert.equal(receipt.drawnCues[0].displayText, 'Ação\nclara')
  assert.deepEqual(receipt.suppressedCueIds, ['cue-2'])
  assert.equal(receipt.mapCoverage, 'sampled')
  assert.equal(receipt.outputSha256, input.outputSha256)
  assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/)
  assert.notEqual(receipt.receiptHash, createRenderedSubtitleReceipt(fixture({
    variantId: 'variant-b',
  })).receiptHash)
  assert.notEqual(receipt.receiptHash, createRenderedSubtitleReceipt(fixture({
    producer: { operationId: 'render-1', attempt: 2 },
  })).receiptHash)
})

test('W69 receipt refuses text, missing or extra ASS event and a drawn suppressed cue', () => {
  const input = fixture()
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    drawnCues: [{ ...input.drawnCues[0], displayText: 'Ação clara' }],
  })), /text differs/)
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    assBytes: Buffer.from('[Events]\n'),
  })), /exactly the emitted ASS events/)
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    assBytes: Buffer.from(`[Events]\n${event}\n${event}\n`),
  })), /exactly the emitted ASS events/)
  const other = event.replace('Ação\\Nclara', 'Outro texto')
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    assBytes: Buffer.from(`[Events]\n${event}\n${other}\n`),
    drawnCues: [input.drawnCues[0], { ...input.drawnCues[0], cueId: 'cue-3' }],
  })), /text differs/)
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    suppressedCueIds: ['cue-1'],
  })), /Suppressed subtitle cue/)
  const late = event.replace('0:00:01.20', '0:00:01.30')
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    assBytes: Buffer.from(`[Events]\n${late}\n`),
    drawnCues: [{ ...input.drawnCues[0], assEventLine: late }],
  })), /timestamps differ/)
  const unsupported = event.replace('Ação\\Nclara', 'Ação\\hclara')
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    assBytes: Buffer.from(`[Events]\n${unsupported}\n`),
    drawnCues: [{ ...input.drawnCues[0], assEventLine: unsupported, displayText: 'Ação clara' }],
  })), /normalized ASS display text/)
  const wrongStyle = event.replace(',Default,', ',Caption,')
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    assBytes: Buffer.from(`[Events]\n${wrongStyle}\n`),
    drawnCues: [{ ...input.drawnCues[0], assEventLine: wrongStyle }],
  })), /subtitle-layer ASS Dialogue/)
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    assBytes: Buffer.from([0xff, 0xfe, 0xfd]),
  })), /valid UTF-8/)
})

test('W69 receipt refuses map/frame or source identity drift', () => {
  const input = fixture()
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    outputSha256: sha('e'),
  })), /map does not describe/)
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    drawnCues: [{ ...input.drawnCues[0], startFrame: 36, endFrame: 37 }],
  })), /timestamps differ/)
  assert.doesNotThrow(() => createRenderedSubtitleReceipt(fixture({
    map: { ...input.map, elements: input.map.elements.filter((element) => element.type !== 'subtitle') },
  })))
  const subtitle = input.map.elements.find((element) => element.type === 'subtitle')
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    map: { ...input.map, elements: [{ ...subtitle, frame: 36 }] },
  })), /Sampled subtitle map disagrees/)
})

test('W69 receipt rejects contradictory aspect, unpinned spec and forbidden ASS controls', () => {
  const input = fixture()
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    outputSpec: { ...spec, aspectRatio: '16:9' },
  })), /dimensions do not match/)
  assert.throws(() => createRenderedSubtitleReceipt(fixture({ outputSpecHash: sha('f') })), /revision hash differs/)
  assert.throws(() => createRenderedSubtitleReceipt(fixture({ outputSpecRevisionId: '' })), /missing/)
  for (const control of ['\0', '\t', '\r', '\x7f']) {
    const poisoned = event.replace('Ação', `A${control}ção`)
    assert.throws(() => createRenderedSubtitleReceipt(fixture({
      assBytes: Buffer.from(`[Events]\n${poisoned}\n`),
      drawnCues: [{ ...input.drawnCues[0], assEventLine: poisoned }],
    })), /control characters/)
  }
})

test('W69 empty and suppressed-only receipts need no fabricated sampled subtitle element', () => {
  const input = fixture()
  const map = { ...input.map, elements: input.map.elements.filter((element) => element.type !== 'subtitle') }
  for (const suppressedCueIds of [[], ['cue-1']]) {
    const receipt = createRenderedSubtitleReceipt(fixture({
      map, drawnCues: [], suppressedCueIds, assBytes: Buffer.from('[Events]\n'),
    }))
    assert.equal(receipt.drawnCues.length, 0)
    assert.deepEqual(receipt.suppressedCueIds, suppressedCueIds)
  }
})

test('W69 receipt validates exact floor boundaries independently of sampled coverage', () => {
  const input = fixture()
  const short = event.replace('0:00:00.00,0:00:01.20', '0:00:00.03,0:00:00.06')
  const map = { ...input.map, elements: [] }
  const drawn = { ...input.drawnCues[0], startFrame: 1, endFrame: 2, assEventLine: short }
  assert.doesNotThrow(() => createRenderedSubtitleReceipt(fixture({
    map, drawnCues: [drawn], assBytes: Buffer.from(`[Events]\n${short}\n`),
  })))
  const rounded = short.replace('0:00:00.06', '0:00:00.07')
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    map, drawnCues: [{ ...drawn, assEventLine: rounded }], assBytes: Buffer.from(`[Events]\n${rounded}\n`),
  })), /timestamps differ/)
})

test('W69 receipt retains 120 fps output but refuses unrepresentable cue boundaries', () => {
  const input = fixture()
  const outputSpec = createOutputSpec({ ...OUTPUT_PRESETS['9:16'], fps: 120 })
  const short = event.replace('0:00:00.00,0:00:01.20', '0:00:00.01,0:00:00.02')
  const properties = { outputSpec, outputSpecHash: calculateCanonicalHash(outputSpec),
    map: { ...input.map, fps: 120, elements: [] }, assBytes: Buffer.from(`[Events]\n${short}\n`) }
  assert.doesNotThrow(() => createRenderedSubtitleReceipt(fixture({ ...properties,
    drawnCues: [{ ...input.drawnCues[0], startFrame: 2, endFrame: 3, assEventLine: short }],
  })))
  assert.throws(() => createRenderedSubtitleReceipt(fixture({ ...properties,
    drawnCues: [{ ...input.drawnCues[0], startFrame: 1, endFrame: 2, assEventLine: short }],
  })), (error) => error.code === 'INVALID_RENDER_INPUT' && error.details.reason === 'ASS_BOUNDARY_UNREPRESENTABLE' &&
    /not representable/.test(error.message))
})

test('W69 receipt binds timestamps to the libass clock: the exact-rational v1 boundary of frame 111 at 30 fps is refused', () => {
  const input = fixture()
  const frames = { ...input.map, durationFrames: 150, elements: [] }
  // The frame reaches libass as now = 3699 ms, one below the exact 3700: the event must start at 3.69, not 3.70.
  const bound = event.replace('0:00:00.00,0:00:01.20', '0:00:03.69,0:00:03.73')
  const reprobated = event.replace('0:00:00.00,0:00:01.20', '0:00:03.70,0:00:03.73')
  const drawn = (line) => [{ ...input.drawnCues[0], startFrame: 111, endFrame: 112, assEventLine: line }]
  assert.doesNotThrow(() => createRenderedSubtitleReceipt(fixture({ map: frames, drawnCues: drawn(bound), assBytes: Buffer.from(`[Events]
${bound}
`) })))
  assert.throws(() => createRenderedSubtitleReceipt(fixture({ map: frames, drawnCues: drawn(reprobated), assBytes: Buffer.from(`[Events]
${reprobated}
`) })),
    /timestamps differ/)
})
