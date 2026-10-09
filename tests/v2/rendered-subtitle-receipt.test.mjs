import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRenderElementMap } from '../../src/v2/domain/review-system.ts'
import { createRenderedSubtitleReceipt } from '../../src/v2/domain/rendered-subtitle-receipt.ts'

const sha = (character) => character.repeat(64)
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
    variantId: 'variant-9x16', outputSpec: { format: '9:16', width: 1080, height: 1920, fps: 30 },
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
    variantId: 'variant-16x9', outputSpec: { ...input.outputSpec, format: '16:9' },
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
  assert.throws(() => createRenderedSubtitleReceipt(fixture({
    map: { ...input.map, elements: input.map.elements.filter((element) => element.type !== 'subtitle') },
  })), /Sampled subtitle map disagrees/)
})
