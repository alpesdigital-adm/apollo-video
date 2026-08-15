import test from 'node:test';import assert from 'node:assert/strict'
import {applySubtitleOverride,chooseSubtitleAnchor,exportSubtitleSidecar,OFL_LICENSE_URL,quickSubtitlePreview,readSubtitlePreset,resetSubtitleOverride,resolveSubtitleConfig,resolveSubtitleMvpFormat,resolveSubtitleRenderMetrics,SUBTITLE_ANCHOR_FIXTURES,SUBTITLE_FORMAT_BY_ASPECT_RATIO,SUBTITLE_PRESETS,SUBTITLE_STYLE_REGISTRY,SUBTITLE_VISUAL_GOLDENS,subtitleFontStack,validateSubtitlePreset} from '../../src/v2/domain/subtitle-system.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { compileApolloVideoRenderProps } from '../../src/v2/application/compile-apollo-video-render-props.ts'
test('T-FR-170 defines five content-addressed responsive licensed presets and deterministic CSS previews',()=>{assert.deepEqual(Object.keys(SUBTITLE_PRESETS),['kinetic','karaoke-box','karaoke-pill','caps-stroke','clean-color']);for(const value of Object.values(SUBTITLE_PRESETS)){assert.equal(validateSubtitlePreset(value).typography.licensed,true);assert.equal(value.typography.licenseSpdx,'OFL-1.1');assert.equal(value.typography.glyphCoverage,'latin-ext');assert.deepEqual(Object.keys(value.responsive.formats),['9:16','16:9']);const {presetHash,...body}=value;assert.equal(presetHash,calculateCanonicalHash(body))}const {registryHash,...registryBody}=SUBTITLE_STYLE_REGISTRY;assert.equal(registryHash,calculateCanonicalHash(registryBody));const preview=quickSubtitlePreview('kinetic',{text:'Olá',format:'9:16',background:'dark'});assert.equal(preview.renderKind,'instant-css-preview');assert.match(preview.css,/font-size:clamp/);assert.match(preview.css,/prefers-reduced-motion/);assert.equal(preview.presetHash,readSubtitlePreset('kinetic').presetHash);assert.equal(SUBTITLE_VISUAL_GOLDENS.length,20);assert.equal(new Set(SUBTITLE_VISUAL_GOLDENS.map((item)=>`${item.presetId}:${item.format}:${item.background}`)).size,20)})
test('T-FR-170 fails closed for tampered registry records and invalid preview input',()=>{const preset=SUBTITLE_PRESETS.kinetic;assert.throws(()=>validateSubtitlePreset({...preset,presetHash:'0'.repeat(64)}),/hash/);assert.throws(()=>quickSubtitlePreview('kinetic',{text:' ',format:'9:16',background:'dark'}),/invalid/)})
const materializedInput = (aspectRatio, width, height, subtitleStyle) => ({
  schemaVersion: 'materialized-render-input/v1', inputHash: '1'.repeat(64),
  renderer: { id: 'remotion', version: '4.0.489', digest: '2'.repeat(64) },
  composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
  plan: { id: 'plan-subtitle-format', versionId: 'version-subtitle-format', hash: '3'.repeat(64) },
  output: { id: `out-${aspectRatio}`, locale: 'pt-BR', aspectRatio, width, height, fps: 30, safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, durationInFrames: 30 },
  assets: [{ id: 'primary-video', artifactId: 'artifact-video', artifactKey: 'v.mp4', kind: 'video', role: 'primary', ordinal: 0, sha256: '4'.repeat(64), byteSize: 4096, uri: 'file:///worker/v.mp4' }],
  props: { primaryVideoAssetId: 'primary-video', scenes: [], subtitles: [{ text: 'Ação com clareza', fromFrame: 0, toFrame: 30 }], palette: { primary: '#4ECDC4', secondary: '#2457A7', accent: '#FFB800', text: '#FFFFFF', background: '#07111F' }, subtitleStyle },
})

test('T-FR-170 authors distinct 9:16 and 16:9 limits per preset and fails closed on a shared style', () => {
  for (const preset of Object.values(SUBTITLE_PRESETS)) {
    const portrait = preset.responsive.formats['9:16']
    const landscape = preset.responsive.formats['16:9']
    assert.equal(portrait.referenceHeight, 1920)
    assert.equal(landscape.referenceHeight, 1080)
    assert.notDeepEqual(portrait, landscape, `${preset.id} must author its own 16:9 limits`)
    assert.equal(preset.typography.licenseUrl, OFL_LICENSE_URL)
    assert.equal(preset.animation.version, 1)
    // A landscape render that reused the portrait tokens is rejected, never silently accepted.
    assert.throws(() => validateSubtitlePreset({ ...preset, responsive: { ...preset.responsive, formats: { '9:16': portrait, '16:9': portrait } } }), /distinct 9:16 and 16:9/)
  }
  // Distinct across presets too: no two presets collapse onto the same landscape geometry.
  const landscapes = Object.values(SUBTITLE_PRESETS).map((preset) => JSON.stringify(preset.responsive.formats['16:9']))
  assert.equal(new Set(landscapes).size, 5)
})

test('T-FR-170 requires every preset to guarantee its own legibility', () => {
  for (const preset of Object.values(SUBTITLE_PRESETS)) {
    const opaqueContainer = preset.background.shape !== 'none' && preset.background.opacity >= .5
    assert.ok(opaqueContainer || preset.stroke.widthEm > 0, `${preset.id} has neither container nor stroke`)
    // Stripping the treatment must be rejected, never silently rendered as white-on-white.
    if (!opaqueContainer) {
      assert.throws(() => validateSubtitlePreset({ ...preset, stroke: { widthEm: 0, color: '#000000' } }), /contrasting stroke/)
    }
  }
  assert.equal(SUBTITLE_PRESETS['karaoke-box'].background.shape, 'box')
  assert.equal(SUBTITLE_PRESETS['karaoke-pill'].background.shape, 'pill')
  assert.equal(SUBTITLE_PRESETS.kinetic.background.shape, 'none')
  // A stroke that matches the glyph fill is no treatment at all.
  assert.throws(() => validateSubtitlePreset({ ...SUBTITLE_PRESETS.kinetic, stroke: { widthEm: .07, color: '#FFFFFF' } }), /contrasting stroke/)
  assert.throws(() => validateSubtitlePreset({ ...SUBTITLE_PRESETS.kinetic, background: { ...SUBTITLE_PRESETS.kinetic.background, opacity: .4 } }), /shape and opacity disagree/)
  // The CSS preview publishes the same outline the Remotion renderer paints.
  assert.match(quickSubtitlePreview('caps-stroke', { text: 'AÇÃO', format: '16:9', background: 'light' }).css, /-webkit-text-stroke:0\.12em #000000/)
  // The outline is floored at rasterization scale so a proxy render never loses its contrast.
  assert.equal(resolveSubtitleRenderMetrics(SUBTITLE_PRESETS.kinetic, '9:16', 1920).strokePx, 6.2)
  assert.equal(resolveSubtitleRenderMetrics(SUBTITLE_PRESETS.kinetic, '16:9', 540).strokePx, 3)
  assert.equal(resolveSubtitleRenderMetrics(SUBTITLE_PRESETS['karaoke-pill'], '16:9', 540).strokePx, 0)
  assert.equal(quickSubtitlePreview('karaoke-pill', { text: 'Ação', format: '16:9', background: 'light' }).css.includes('-webkit-text-stroke'), false)
})

test('T-FR-170 resolves the MVP subtitle format from the declared output and fails closed otherwise', () => {
  assert.deepEqual(SUBTITLE_FORMAT_BY_ASPECT_RATIO, { '9:16': '9:16', '4:5': '9:16', '16:9': '16:9', '1:1': '16:9', '21:9': '16:9' })
  assert.equal(SUBTITLE_STYLE_REGISTRY.formatByAspectRatio, SUBTITLE_FORMAT_BY_ASPECT_RATIO)
  assert.equal(resolveSubtitleMvpFormat('16:9'), '16:9')
  assert.equal(resolveSubtitleMvpFormat('4:5'), '9:16')
  assert.throws(() => resolveSubtitleMvpFormat('3:2'), /no registered subtitle format/)
  // The compiler — not the canvas — decides, and a 16:9 output carries the 16:9 tokens.
  const landscape = compileApolloVideoRenderProps(materializedInput('16:9', 1920, 1080, 'caps-stroke'))
  const portrait = compileApolloVideoRenderProps(materializedInput('9:16', 1080, 1920, 'caps-stroke'))
  assert.equal(landscape.subtitleFormat, '16:9')
  assert.equal(portrait.subtitleFormat, '9:16')
  assert.equal(landscape.subtitlePreset.presetHash, SUBTITLE_PRESETS['caps-stroke'].presetHash)
  assert.notEqual(
    resolveSubtitleRenderMetrics(landscape.subtitlePreset, landscape.subtitleFormat, 1080).fontPx,
    resolveSubtitleRenderMetrics(portrait.subtitlePreset, portrait.subtitleFormat, 1080).fontPx,
  )
})

test('T-FR-170 scales authored limits by canvas height and keeps one deterministic font stack', () => {
  const preset = SUBTITLE_PRESETS.kinetic
  const delivery = resolveSubtitleRenderMetrics(preset, '9:16', 1920)
  const proxy = resolveSubtitleRenderMetrics(preset, '9:16', 960)
  assert.equal(delivery.fontPx, preset.responsive.formats['9:16'].fontPx)
  assert.equal(proxy.fontPx, Math.round(preset.responsive.formats['9:16'].fontPx / 2))
  assert.equal(delivery.bottomPx, Math.round(1920 * preset.responsive.formats['9:16'].bottom))
  assert.throws(() => resolveSubtitleRenderMetrics(preset, '4:3', 1080), /no limits for the requested format/)
  assert.throws(() => resolveSubtitleRenderMetrics(preset, '9:16', 0), /canvas height is invalid/)
  // The materialized asset face leads the stack without erasing the registered family/fallbacks.
  assert.deepEqual(subtitleFontStack(preset, 'ApolloResourceFont'), ['ApolloResourceFont', 'Inter', 'Noto Sans', 'Arial', 'sans-serif'])
  assert.deepEqual(subtitleFontStack(preset), ['Inter', 'Noto Sans', 'Arial', 'sans-serif'])
  assert.ok(quickSubtitlePreview('kinetic', { text: 'Ação', format: '9:16', background: 'dark' }).css.includes('"Inter","Noto Sans","Arial",sans-serif'))
})

test('T-FR-171 resolves auto/workspace/manual/none per variant without altering transcript',()=>{const transcript={words:['Olá']};const auto=resolveSubtitleConfig({mode:'auto',workspacePreset:'kinetic',variantId:'9:16',transcript});const manual=resolveSubtitleConfig({mode:'manual',workspacePreset:'kinetic',manualPreset:'caps-stroke',variantId:'16:9',transcript});const none=resolveSubtitleConfig({mode:'none',workspacePreset:'kinetic',variantId:'9:16',transcript});assert.equal(auto.origin,'director');assert.equal(manual.origin,'project');assert.equal(none.origin,'disabled');assert.equal(auto.transcriptHash,manual.transcriptHash)})
test('T-FR-172 validates typography, breaking, highlight, background, animation, margins and glyph/contrast limits',()=>{const style=validateSubtitlePreset(SUBTITLE_PRESETS['karaoke-box']);assert.equal(style.lineBreaking.maxLines,2);assert.equal(style.animation.reducedMotion,'none');assert.throws(()=>validateSubtitlePreset({...style,typography:{...style.typography,licensed:false}}),/licensed/)})
test('T-FR-173 chooses stable safe anchors from faces/OCR/CTA/logo/inserts and reports no safe region',()=>{const first=chooseSubtitleAnchor({occupied:SUBTITLE_ANCHOR_FIXTURES.lowerFace,safeArea:{top:.05,bottom:.05}});assert.ok(first.anchor);assert.equal(chooseSubtitleAnchor({occupied:SUBTITLE_ANCHOR_FIXTURES.lowerFace,previous:first.anchor,safeArea:{top:.05,bottom:.05}}).stable,true);assert.equal(chooseSubtitleAnchor({occupied:SUBTITLE_ANCHOR_FIXTURES.fullScreen,safeArea:{top:.05,bottom:.05}}).issue,'NO_SAFE_SUBTITLE_REGION');assert.deepEqual(Object.keys(SUBTITLE_ANCHOR_FIXTURES),['lowerFace','fullScreen','multiple'])})
test('T-FR-174 applies protected segment override only to selected variant/range and resets minimally',()=>{const override={id:'o1',segmentId:'s1',variantId:'9:16',rangeMs:[1000,2000],position:'top',styleId:'kinetic',text:'Novo',visibility:'visible',protected:true};assert.equal(applySubtitleOverride({base:{text:'Base'},override,variantId:'16:9',rangeMs:[1000,2000]}).applied,false);const applied=applySubtitleOverride({base:{text:'Base'},override,variantId:'9:16',rangeMs:[1500,1800]});assert.equal(applied.value.text,'Novo');assert.equal(applied.protected,true);assert.deepEqual(resetSubtitleOverride(override,{text:'Base'}).invalidatedRanges,[[1000,2000]])})
test('T-FR-175 exports UTF-8 SRT/VTT from rendered alignment with monotonic normalized timestamps',()=>{const cues=[{startMs:0,endMs:1200,text:'Ação e\nclareza'},{startMs:1500,endMs:2500,text:'Última cue.'}];const srt=exportSubtitleSidecar(cues,'srt');const vtt=exportSubtitleSidecar(cues,'vtt');assert.match(srt,/00:00:00,000 --> 00:00:01,200/);assert.match(vtt,/WEBVTT/);assert.match(vtt,/Última cue/);assert.throws(()=>exportSubtitleSidecar([{startMs:0,endMs:1000,text:'a'},{startMs:900,endMs:1200,text:'b'}],'srt'),/non-overlapping/)})
