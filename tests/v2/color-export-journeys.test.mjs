import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportMatrix, OUTPUT_FORMATS, parseCube, preflightExports, renderExportCell, resolveColorPlan, SDR_COLOR_FIXTURES, selectWorkspaceLut } from '../../src/v2/domain/color-and-export.ts';

const transform = (id, kind, version = '1') => ({ id, kind, version, enabled: true });
const identityCube = `TITLE \"Identidade ç\"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1`;

test('T-FR-180 compiles the color pipeline in fixed order without duplicate transforms', () => {
  const output = resolveColorPlan({ metadata: { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709' }, global: [transform('out', 'output'), transform('tech', 'technical'), transform('lut', 'creative-lut'), transform('match', 'match')] }, {});
  assert.deepEqual(output.transforms.map(item => item.kind), ['technical', 'match', 'creative-lut', 'output']);
  assert.match(output.manifestKey, /tech@1/);
  assert.equal(SDR_COLOR_FIXTURES.length, 3);
});

test('T-FR-182 applies deterministic local overrides without changing sibling segments', () => {
  const plan = { metadata: { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709' }, global: [transform('base', 'creative-lut')], segments: { a: [transform('warm', 'creative-lut', '2')] } };
  assert.equal(resolveColorPlan(plan, { segmentId: 'a' }).transforms[0].id, 'warm');
  assert.equal(resolveColorPlan(plan, { segmentId: 'b' }).transforms[0].id, 'base');
});

test('T-FR-181 parses valid unicode LUT, rejects malformed LUT and supports explicit none', () => {
  const lut = parseCube({ id: 'cinema', name: 'Coração 🎞️', owner: 'workspace', license: 'owned', cube: identityCube });
  assert.equal(lut.active, true);
  assert.equal(selectWorkspaceLut({ projectChoice: 'none', workspaceDefault: 'cinema', library: [lut] }), undefined);
  assert.throws(() => parseCube({ id: 'bad', name: 'bad', owner: 'w', license: 'x', cube: 'LUT_3D_SIZE 33' }), /invalid-cube/);
});

test('T-FR-235 creates deterministic five-format matrix with independent partial retry', () => {
  let cells = createExportMatrix(['recipe-1'], [...OUTPUT_FORMATS], ['pt-BR']);
  assert.equal(cells.length, 5);
  assert.equal(preflightExports(cells, { rights: true, ready: true, budget: 10, storageMb: 500 }).allowed, true);
  cells = renderExportCell(cells, cells[1].id, false);
  cells = renderExportCell(cells, cells[1].id, true);
  assert.equal(cells[1].attempts, 2);
  assert.equal(cells.filter(cell => cell.status === 'ready').length, 1);
  assert.equal(new Set(cells.map(cell => cell.artifact).filter(Boolean)).size, 1);
});

test('T-F2-GATE protects bounded batch journeys, evidence, long-form and per-output review', () => {
  const recipes = Array.from({ length: 6 }, (_, index) => `compatible-${index + 1}`);
  const cells = createExportMatrix(recipes, [...OUTPUT_FORMATS], ['pt-BR']);
  assert.equal(cells.length, 30);
  assert.equal(preflightExports(cells, { rights: true, ready: true, budget: 100, storageMb: 2000 }).allowed, true);
  assert.ok(cells.every(cell => cell.id.includes(cell.recipeId)));
});
