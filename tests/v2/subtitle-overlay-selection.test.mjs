import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveActiveSubtitleLayers } from '../../remotion/src/lib/subtitle-overlay-selection.ts';

const cue = (text, anchor = 'bottom') => ({
  text,
  startTime: 0,
  endTime: 2,
  startFrame: 0,
  endFrame: 60,
  anchor,
});

const resolve = (subtitles, overrides = {}) =>
  resolveActiveSubtitleLayers({
    subtitles,
    frame: 30,
    fps: 30,
    format: '9:16',
    ...overrides,
  });

test('renders the first active cue from each distinct top and bottom anchor', () => {
  const layers = resolve([
    cue('Conteúdo gerado com IA', 'top'),
    cue('Olá mundo', 'bottom'),
    cue('legenda posterior', 'bottom'),
  ]);

  assert.deepEqual(
    layers.map((layer) => ({ text: layer.subtitle.text, placement: layer.placement })),
    [
      { text: 'Conteúdo gerado com IA', placement: 'top' },
      { text: 'Olá mundo', placement: 'bottom' },
    ],
  );
});

test('keeps source precedence when composition redirects both anchors to the top', () => {
  const layers = resolve(
    [cue('primeira no array', 'bottom'), cue('segunda no array', 'top')],
    { topFactor: 1 },
  );

  assert.equal(layers.length, 1);
  assert.equal(layers[0].subtitle.text, 'primeira no array');
  assert.equal(layers[0].placement, 'top');
});

test('keeps split-50 single-slot precedence and full hide behavior', () => {
  const subtitles = [cue('primeira no array', 'top'), cue('segunda no array', 'bottom')];
  const splitLayers = resolve(subtitles, { activeLayout: 'split-50' });

  assert.equal(splitLayers.length, 1);
  assert.equal(splitLayers[0].subtitle.text, 'primeira no array');
  assert.equal(splitLayers[0].placement, 'center');
  assert.equal(splitLayers[0].mode, 'two-word-center');
  assert.deepEqual(resolve(subtitles, { hideFactor: 1 }), []);
});

test('keeps end frames exclusive and never duplicates a cue at the topFactor seam', () => {
  assert.deepEqual(resolve([cue('já terminou')], { frame: 60 }), []);
  assert.deepEqual(resolve([cue('costura invisível')], { topFactor: 0.5 }), []);
});
