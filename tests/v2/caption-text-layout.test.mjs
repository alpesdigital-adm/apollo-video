import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalCaptionText, captionFontPx, captionTextWidthPx, CAPTION_BOX_PADDING_PX, layoutCaption, measureCaptionLine,
} from '../../src/v2/domain/caption-text-layout.ts'
import { CAPTION_BAND_TOLERANCE_PX } from '../../src/v2/domain/caption-pixel-verdict.ts'
import { OUTPUT_FORMAT_REGISTRY, readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { assPresetOutlineWidth } from '../../src/v2/domain/subtitle-ass-preset-style.ts'
import { deriveSubtitleRegion } from '../../src/v2/domain/subtitle-region.ts'
import { readSubtitlePreset, resolveSubtitleMvpFormat, resolveSubtitleRenderMetrics } from '../../src/v2/domain/subtitle-system.ts'
import { SUBTITLE_LINE_HEIGHT, SUBTITLE_PRESET_IDS } from '../../src/v2/domain/subtitle-style-tokens.ts'

/**
 * W69-tail / W70-prep. The caption geometry the FFmpeg path draws with. The invariant is the single geometry: for every registered preset,
 * both subtitle formats and both the proxy and the delivery canvas, `maxLines` lines drawn at the font the layout chooses fit the band that
 * `deriveSubtitleRegion` certifies (the band the W65 pixel critic judges the pixels against), and a line is broken by the measured width of
 * its text, not by a character count.
 */
test('canonicalCaptionText is the one text a caption burns and a sidecar carries', () => {
  assert.equal(canonicalCaptionText('  Ação  '), 'Ação')
  // NFC: a decomposed "Acao" with combining marks composes
  assert.equal(canonicalCaptionText('Ação'), 'Ação')
  assert.equal(canonicalCaptionText('Ação'), 'Ação')
  assert.equal(canonicalCaptionText('linha um\r\nlinha  dois\rlinha\ttrês'), 'linha um\nlinha dois\nlinha três')
  assert.equal(canonicalCaptionText('{\\an8}com {markup} e \\N dentro'), 'an8com markup e N dentro')
  assert.equal(canonicalCaptionText('um\n\n  \ndois'), 'um\ndois')
  assert.equal(canonicalCaptionText('{}\\'), '')
  assert.equal(canonicalCaptionText('Última cue.'), 'Última cue.')
})

test('the measure is monotonic in the font size, additive over characters and never narrower than the Arial Bold pixels', () => {
  assert.equal(measureCaptionLine('', 30), 0)
  assert.ok(measureCaptionLine('abc', 40) > measureCaptionLine('abc', 20))
  assert.ok(Math.abs(measureCaptionLine('abc', 30) + measureCaptionLine('def', 30) - measureCaptionLine('abcdef', 30)) < 1e-9)
  // letters with a diacritic take their base letter, so a line is as wide with accents as without
  assert.equal(measureCaptionLine('Ação ú é', 30), measureCaptionLine('Acao u e', 30))
  // Measured on delivered pixels (Arial Bold, libass, FFmpeg 6.1.1): a 25-character line at 36 px was 397 px wide, at 22 px 243 px.
  assert.ok(measureCaptionLine('Primeira legenda do video', 36) >= 397)
  assert.ok(measureCaptionLine('Primeira legenda do video', 22) >= 243)
  assert.ok(measureCaptionLine('Segunda legenda mais longa que a anterior', 22) >= 405)
  assert.ok(measureCaptionLine('MMMMMMMMMMMM', 30) >= 264 && measureCaptionLine('iiiiiiiiiiiiiiii', 30) >= 116)
  assert.throws(() => measureCaptionLine('a', 0), /font size/)
})

test('layoutCaption breaks by measured width, balances a pair, keeps every word and the author\'s line breaks', () => {
  const text = 'Primeira legenda do video de hoje com bastante texto'
  const wide = layoutCaption({ text, fontPx: 22, maxWidthPx: 900, maxLines: 2 })
  assert.deepEqual(wide.lines, [text], 'a line that fits is one line, whatever its character count')
  assert.equal(wide.fits, true)
  assert.equal(wide.heightPx, 22)
  const narrow = layoutCaption({ text, fontPx: 22, maxWidthPx: 300, maxLines: 2 })
  assert.equal(narrow.lines.length, 2)
  assert.equal(narrow.lines.join(' '), text, 'nothing is dropped or reordered')
  assert.ok(narrow.widthPx <= 300 && narrow.fits)
  // balanced: the wider line of the pair is the narrowest possible split of the same words
  const words = text.split(' ')
  const widest = Math.max(...narrow.lines.map((line) => measureCaptionLine(line, 22)))
  for (let split = 1; split < words.length; split += 1) {
    const pair = [words.slice(0, split).join(' '), words.slice(split).join(' ')]
    assert.ok(widest <= Math.max(...pair.map((line) => measureCaptionLine(line, 22))) + 1e-9, `split ${split} is not narrower`)
  }
  // three lines are laid out in full and reported as not fitting two
  const three = layoutCaption({ text: `${text} ${text}`, fontPx: 22, maxWidthPx: 300, maxLines: 2 })
  assert.ok(three.lines.length >= 3 && three.fits === false)
  assert.equal(three.lines.join(' '), `${text} ${text}`, 'a caption that does not fit is never cut')
  assert.equal(three.heightPx, three.lines.length * 22)
  // an unbreakable word wider than the line stays on a line of its own and the layout says it does not fit
  const long = layoutCaption({ text: 'curto Pneumoultramicroscopicossilicovulcanoconiotico fim', fontPx: 30, maxWidthPx: 200, maxLines: 2 })
  assert.ok(long.lines.includes('Pneumoultramicroscopicossilicovulcanoconiotico') && long.fits === false)
  // the author's line break is kept; wrapping happens inside a line only
  const authored = layoutCaption({ text: 'Primeira linha\nSegunda linha', fontPx: 22, maxWidthPx: 900, maxLines: 2 })
  assert.deepEqual(authored.lines, ['Primeira linha', 'Segunda linha'])
  assert.deepEqual(layoutCaption({ text: ' Ação  ', fontPx: 22, maxWidthPx: 900, maxLines: 2 }).lines, ['Ação'])
  assert.throws(() => layoutCaption({ text: '{}', fontPx: 22, maxWidthPx: 900, maxLines: 2 }), /empty/)
  assert.throws(() => layoutCaption({ text: 'a', fontPx: 22, maxWidthPx: 0, maxLines: 2 }), /positive width/)
  assert.deepEqual(layoutCaption({ text, fontPx: 22, maxWidthPx: 300, maxLines: 2 }), narrow, 'deterministic')
})

test('captionFontPx is the preset size unless the certified band is too short for its lines', () => {
  assert.equal(captionFontPx({ metrics: { fontPx: 23, strokePx: 3 }, bandHeightPx: 200, maxLines: 2 }), 23)
  assert.equal(captionFontPx({ metrics: { fontPx: 23, strokePx: 3 }, bandHeightPx: 55.2, maxLines: 2 }), 22)
  assert.equal(captionFontPx({ metrics: { fontPx: 23, strokePx: 3 }, bandHeightPx: 1, maxLines: 2 }), 1)
  assert.equal(captionTextWidthPx(800, 1), 800 - 2 * (1 + CAPTION_BOX_PADDING_PX))
  assert.equal(captionTextWidthPx(2, 5), 1)
})

const CANVASES = [
  ...Object.entries(OUTPUT_FORMAT_REGISTRY.presets).map(([ratio, preset]) => ({ label: `${ratio} proxy`, ratio, canvas: { width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height } }))
    .filter((entry) => ['9:16', '16:9'].includes(entry.ratio)),
  ...['9:16', '16:9'].map((ratio) => ({ label: `${ratio} delivery`, ratio, canvas: { width: readOutputFormatPreset(ratio).spec.width, height: readOutputFormatPreset(ratio).spec.height } })),
]

for (const presetId of SUBTITLE_PRESET_IDS) {
  for (const { label, ratio, canvas } of CANVASES) {
    test(`single geometry: ${presetId} at ${label} draws its lines inside the band the plan certifies`, () => {
      const preset = readSubtitlePreset(presetId)
      const spec = readOutputFormatPreset(ratio).spec
      const region = deriveSubtitleRegion({ spec, presetId })
      const metrics = resolveSubtitleRenderMetrics(preset, resolveSubtitleMvpFormat(ratio), canvas.height)
      const bandHeightPx = region.bounds.height * canvas.height
      const bandWidthPx = region.bounds.width * canvas.width
      const fontPx = captionFontPx({ metrics, bandHeightPx, maxLines: preset.lineBreaking.maxLines })
      const outline = assPresetOutlineWidth(presetId, fontPx)
      const tolerance = CAPTION_BAND_TOLERANCE_PX
      // the lines the preset asks for, drawn at the chosen font, are inside the band (libass: a line is `fontPx` tall, plus the box padding)
      const drawn = preset.lineBreaking.maxLines * fontPx + 2 * outline
      assert.ok(drawn <= bandHeightPx + tolerance, `${presetId}@${label}: ${drawn}px of lines vs a ${bandHeightPx.toFixed(1)}px band (+${tolerance})`)
      assert.ok(fontPx <= metrics.fontPx && fontPx >= metrics.fontPx - 2, `${presetId}@${label}: the font is the preset's own (${metrics.fontPx}) or one the band forces (${fontPx})`)
      assert.ok(fontPx * SUBTITLE_LINE_HEIGHT * preset.lineBreaking.maxLines + 2 * metrics.strokePx <= bandHeightPx + 1e-6, 'and the band holds the lines at the layout line height')
      // a caption of the preset's own limit (maxCharacters per line, maxLines lines) fits the band's width on its lines
      const text = Array.from({ length: preset.lineBreaking.maxLines }, () => 'a'.repeat(preset.lineBreaking.maxCharacters)).join('\n')
      const layout = layoutCaption({ text, fontPx, maxWidthPx: captionTextWidthPx(bandWidthPx, outline), maxLines: preset.lineBreaking.maxLines })
      assert.equal(layout.lines.length, preset.lineBreaking.maxLines)
      // 24-40 character cues (the case that blocked at 16:9), within what the preset itself groups into a cue, never exceed the lines the band holds
      for (const length of [24, 30, 36, 40].filter((candidate) => candidate <= preset.lineBreaking.maxLines * preset.lineBreaking.maxCharacters)) {
        const caption = layoutCaption({ text: 'palavra '.repeat(Math.ceil(length / 8)).slice(0, length).trim(), fontPx, maxWidthPx: captionTextWidthPx(bandWidthPx, outline), maxLines: preset.lineBreaking.maxLines })
        assert.ok(caption.lines.length <= preset.lineBreaking.maxLines, `${length} characters take ${caption.lines.length} line(s) at ${presetId}@${label}`)
        assert.ok(caption.lines.length * fontPx + 2 * outline <= bandHeightPx + tolerance)
        assert.ok(caption.widthPx <= bandWidthPx)
      }
    })
  }
}

test('witness: the fixed 20-character wrap at the canvas-proportional font did NOT fit the 16:9 band (the defect this layout removes)', () => {
  const canvas = { width: 960, height: 540 }
  const preset = readSubtitlePreset('kinetic')
  const region = deriveSubtitleRegion({ spec: readOutputFormatPreset('16:9').spec, presetId: 'kinetic' })
  const bandHeightPx = region.bounds.height * canvas.height
  const oldFont = Math.max(32, Math.min(72, Math.round(Math.min(canvas.width * 0.059, canvas.height * 0.067))))
  assert.equal(oldFont, 36)
  // two lines (anything over 20 characters) at 36 px are 2 * 36 + 2 = 74 rows in a band of ~55
  assert.ok(2 * oldFont + 2 > bandHeightPx + CAPTION_BAND_TOLERANCE_PX)
  const metrics = resolveSubtitleRenderMetrics(preset, '16:9', canvas.height)
  const font = captionFontPx({ metrics, bandHeightPx, maxLines: preset.lineBreaking.maxLines })
  assert.ok(2 * font + 2 <= bandHeightPx + CAPTION_BAND_TOLERANCE_PX)
})
