import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRenderElementMap, renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  assertRenderedSubtitleCues,
  collectRenderedSubtitleCues,
  encodeSubtitleSidecar,
  normalizeSubtitleCueText,
  parseSubtitleSidecar,
  subtitleSidecarFrameToMs,
  subtitleSidecarLineageHash,
  SUBTITLE_SIDECAR_SCHEMA_VERSION,
} from '../../src/v2/domain/subtitle-sidecar.ts'

const proxyHash = 'a'.repeat(64)

/**
 * The round-trip fixture required by T-FR-175: a diacritic, an internal line
 * break and a closing cue. The frames are the ones a 30 fps render would emit.
 */
const CUES = Object.freeze([
  { id: 'cue-1', startFrame: 0, endFrame: 36, text: 'Ação e\nclareza' },
  { id: 'cue-2', startFrame: 45, endFrame: 75, text: 'Última cue.' },
])

function fixtureMap(cues = CUES) {
  return buildRenderElementMap({
    proxyHash, fps: 30, durationFrames: 90,
    canvas: { width: 1080, height: 1920 }, source: { width: 1920, height: 1080 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 90 }],
    subtitleCues: cues,
  })
}

const texts = (cues = CUES) => Object.fromEntries(cues.map((cue) => [cue.id, cue.text]))

test('W69 VTT emits literal markup/entities and decodes exactly once', () => {
  const literal = '<b>&amp; <00:00:00.100> &lt; >'
  const cues = [{ cueId: 'literal-1', startFrame: 0, endFrame: 30, startMs: 0, endMs: 1000, text: literal }]
  const encoded = encodeSubtitleSidecar({ cues, format: 'vtt', locale: 'pt-BR' })
  assert.ok(encoded.bytes.toString('utf8').includes('&lt;b&gt;&amp;amp;'))
  assert.equal(parseSubtitleSidecar(encoded.bytes, 'vtt')[0].text, literal)
  const srt = encodeSubtitleSidecar({ cues, format: 'srt', locale: 'pt-BR' })
  assert.equal(parseSubtitleSidecar(srt.bytes, 'srt')[0].text, literal)
})

test('T-FR-175 derives cue timing from the rendered element map, not from the cue list', () => {
  const map = fixtureMap()
  const rendered = collectRenderedSubtitleCues({ map, texts: texts() })
  assert.equal(rendered.length, 2)
  assert.deepEqual(
    rendered.map((cue) => [cue.cueId, cue.startFrame, cue.endFrame, cue.startMs, cue.endMs]),
    [['cue-1', 0, 36, 0, 1200], ['cue-2', 45, 75, 1500, 2500]],
  )
  // The map is the only timing source: frames present in the map decide the
  // milliseconds, through the single documented rounding rule.
  assert.equal(subtitleSidecarFrameToMs(45, 30), 1500)
  assert.equal(subtitleSidecarFrameToMs(1, 29.97), 33)
})

test('T-FR-175 SRT is CRLF and VTT is LF, both UTF-8 with BOM', () => {
  const map = fixtureMap()
  const rendered = collectRenderedSubtitleCues({ map, texts: texts() })
  const srt = encodeSubtitleSidecar({ cues: rendered, format: 'srt', locale: 'pt-BR' })
  const vtt = encodeSubtitleSidecar({ cues: rendered, format: 'vtt', locale: 'pt-BR' })

  assert.deepEqual([...srt.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.deepEqual([...vtt.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const srtText = srt.bytes.subarray(3).toString('utf8')
  const vttText = vtt.bytes.subarray(3).toString('utf8')
  assert.equal(srtText, [
    '1', '00:00:00,000 --> 00:00:01,200', 'Ação e', 'clareza', '',
    '2', '00:00:01,500 --> 00:00:02,500', 'Última cue.', '',
  ].join('\r\n'))
  assert.ok(vttText.startsWith('WEBVTT\n\n'))
  assert.ok(!vttText.includes('\r'))
  assert.ok(vttText.includes('00:00:01.500 --> 00:00:02.500'))
  // Every LF in the SRT is preceded by a CR: the file does not depend on the
  // host EOL, so Windows and Linux produce the same checksum.
  const bytes = [...srt.bytes]
  assert.ok(bytes.every((byte, index) => byte !== 0x0a || bytes[index - 1] === 0x0d))
  assert.equal(srt.encoding, 'utf-8-bom')
  assert.equal(srt.eol, '\r\n')
  assert.equal(vtt.eol, '\n')
})

test('T-FR-175 round-trips Ação, the internal line break and the last cue', () => {
  const map = fixtureMap()
  const rendered = collectRenderedSubtitleCues({ map, texts: texts() })
  for (const format of ['srt', 'vtt']) {
    const encoded = encodeSubtitleSidecar({ cues: rendered, format, locale: 'pt-BR' })
    const parsed = parseSubtitleSidecar(encoded.bytes, format)
    assert.deepEqual(
      parsed.map((cue) => [cue.startMs, cue.endMs, cue.text]),
      rendered.map((cue) => [cue.startMs, cue.endMs, cue.text]),
      `${format} round-trip must preserve text and timing`,
    )
    assert.equal(parsed[0].text, 'Ação e\nclareza')
    assert.equal(parsed[1].text, 'Última cue.')
    assert.equal(parsed[0].text.normalize('NFC'), parsed[0].text)
  }
})

test('T-FR-175 the same rendered alignment always reconstructs the same bytes', () => {
  const first = encodeSubtitleSidecar({
    cues: collectRenderedSubtitleCues({ map: fixtureMap(), texts: texts() }),
    format: 'srt', locale: 'pt-BR',
  })
  const second = encodeSubtitleSidecar({
    cues: collectRenderedSubtitleCues({ map: fixtureMap(), texts: texts() }),
    format: 'srt', locale: 'pt-BR',
  })
  assert.equal(first.sha256, second.sha256)
  assert.equal(first.byteSize, second.byteSize)
  assert.ok(first.bytes.equals(second.bytes))
})

test('T-FR-175 rejects non-positive ranges, non-monotonic order and overlaps before writing', () => {
  const base = { cueId: 'cue-1', startFrame: 0, endFrame: 1 }
  assert.throws(
    () => assertRenderedSubtitleCues([{ ...base, startMs: 100, endMs: 100, text: 'a' }]),
    /range is not positive/,
  )
  assert.throws(
    () => assertRenderedSubtitleCues([
      { ...base, startMs: 0, endMs: 1000, text: 'a' },
      { cueId: 'cue-2', startFrame: 0, endFrame: 1, startMs: 900, endMs: 1200, text: 'b' },
    ]),
    /not monotonic or overlaps/,
  )
  assert.throws(
    () => assertRenderedSubtitleCues([{ ...base, startMs: 0, endMs: 1000, text: 'a' }], 500),
    /closes after the rendered duration/,
  )
  assert.throws(() => assertRenderedSubtitleCues([]), /at least one rendered cue/)
})

test('T-FR-175 rejects text that would break the sidecar grammar', () => {
  assert.equal(normalizeSubtitleCueText('  Ação \r\n clareza  ', 'cue-1'), 'Ação\nclareza')
  assert.throws(() => normalizeSubtitleCueText('a --> b', 'cue-1'), /timing separator/)
  assert.throws(() => normalizeSubtitleCueText('a\u0000b', 'cue-1'), /control characters/)
  assert.throws(() => normalizeSubtitleCueText('   ', 'cue-1'), /empty or too long/)
  // blank lines are not drawn by the renderer (they are dropped from the canonical text); five written lines are too many
  assert.equal(normalizeSubtitleCueText('a\n\n\n\n\nb', 'cue-1'), 'a\nb')
  assert.throws(() => normalizeSubtitleCueText('a\nb\nc\nd\ne', 'cue-1'), /line breaks are invalid/)
  // the markup characters libass does not draw are not part of the text a sidecar carries either
  assert.equal(normalizeSubtitleCueText('{\\an8}Ação {x}', 'cue-1'), 'an8Ação x')
})

test('T-FR-175 a cue present in the map but missing from the snapshot fails closed', () => {
  const map = fixtureMap()
  assert.throws(
    () => collectRenderedSubtitleCues({ map, texts: { 'cue-1': 'Ação' } }),
    /do not match/,
  )
  assert.throws(
    () => collectRenderedSubtitleCues({ map, texts: { ...texts(), 'cue-3': 'Sobra' } }),
    /do not match/,
  )
  const withoutSubtitles = buildRenderElementMap({
    proxyHash, fps: 30, durationFrames: 90,
    canvas: { width: 1080, height: 1920 }, source: { width: 1920, height: 1080 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-1', timelineInFrame: 0, timelineOutFrame: 90 }],
  })
  assert.throws(
    () => collectRenderedSubtitleCues({ map: withoutSubtitles, texts: {} }),
    /no subtitle element/,
  )
})

test('T-FR-175 a cue whose rendered frames have a hole is a conflict, not a shorter cue', () => {
  const map = fixtureMap()
  const punctured = {
    ...map,
    elements: map.elements.filter((element) =>
      !(element.elementId === 'subtitle:cue-1' && element.frame === 10)),
  }
  assert.throws(
    () => collectRenderedSubtitleCues({ map: punctured, texts: texts() }),
    /contiguous frame range/,
  )
})

test('T-FR-175 the lineage hash separates version, variant, artifact, format and locale', () => {
  const map = fixtureMap()
  const lineage = {
    schemaVersion: SUBTITLE_SIDECAR_SCHEMA_VERSION,
    workspaceId: 'workspace-1', projectId: 'project-1',
    projectVersionId: 'version-5', variantId: '9:16',
    outputArtifactId: 'artifact-proxy', outputSha256: proxyHash, outputKind: 'proxy',
    renderInputHash: 'b'.repeat(64), editPlanSnapshotId: 'snapshot-1',
    editPlanHash: 'c'.repeat(64), renderElementMapHash: renderElementMapHash(map),
    format: 'srt', locale: 'pt-BR',
  }
  const base = subtitleSidecarLineageHash(lineage)
  assert.notEqual(base, calculateCanonicalHash(lineage), 'pre-literal encoder identity cannot replay into the new recipe')
  assert.equal(subtitleSidecarLineageHash({ ...lineage }), base)
  for (const change of [
    { projectVersionId: 'version-4' }, { variantId: '16:9' }, { format: 'vtt' },
    { locale: 'en-US' }, { renderElementMapHash: 'd'.repeat(64) },
    { renderInputHash: 'e'.repeat(64) }, { outputSha256: 'f'.repeat(64) },
  ]) {
    assert.notEqual(subtitleSidecarLineageHash({ ...lineage, ...change }), base)
  }
})
