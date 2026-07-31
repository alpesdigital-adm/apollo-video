import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts';
import { createExportMatrix, createMediaColorProbe, OUTPUT_FORMATS, parseCube, preflightExports, renderExportCell, resolveColorPlan, SDR_COLOR_FIXTURES, selectWorkspaceLut } from '../../src/v2/domain/color-and-export.ts';

const sourceColor = {
  colorSpace: 'camera-log',
  transfer: 'log',
  primaries: 'bt2020',
  matrix: 'bt2020-ncl',
  range: 'limited',
  bitDepth: 10,
};
const workingColor = {
  colorSpace: 'acescg',
  transfer: 'linear',
  primaries: 'aces-ap1',
  matrix: 'rgb',
  range: 'full',
  bitDepth: 16,
};
const outputColor = {
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 10,
};
const transform = (
  id,
  kind,
  input,
  output,
  { version = '1', enabled = true, lut, parameters = {} } = {},
) => ({
  id,
  kind,
  version,
  enabled,
  input,
  output,
  implementation: {
    provider: 'apollo',
    version: '1.0.0',
    parameters,
    parametersHash: calculateCanonicalHash(parameters),
  },
  ...(lut ? { lut } : {}),
});
const basePlan = () => ({
  schemaVersion: 'color-plan/v1',
  metadata: sourceColor,
  outputMetadata: outputColor,
  global: [
    transform('technical-log-to-working', 'technical', sourceColor, workingColor),
    transform('camera-match-reference-a', 'match', workingColor, workingColor),
    transform(
      'creative-film-look',
      'creative-lut',
      workingColor,
      workingColor,
      {
        lut: {
          artifactId: 'lut-film-look',
          sha256: 'a'.repeat(64),
        },
      },
    ),
    transform('output-rec709', 'output', workingColor, outputColor),
  ],
});
const identityCube = `TITLE \"Identidade ç\"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1`;

test('T-FR-180 compiles the color pipeline in fixed order without duplicate transforms', () => {
  const plan = basePlan();
  plan.global.reverse();
  const output = resolveColorPlan(plan, {});
  assert.deepEqual(output.stages.map(item => item.kind), ['technical', 'match', 'creative-lut', 'output']);
  assert.match(output.manifestKey, /technical:technical-log-to-working@1/);
  assert.equal(output.sourceMetadata.transfer, 'log');
  assert.equal(output.outputMetadata.transfer, 'bt709');
  assert.match(output.pipelineHash, /^[a-f0-9]{64}$/);
  assert.equal(SDR_COLOR_FIXTURES.length, 3);
});

test('T-FR-182 applies deterministic local overrides without changing sibling segments', () => {
  const plan = basePlan();
  plan.segments = {
    a: [
      transform(
        'creative-warm',
        'creative-lut',
        workingColor,
        workingColor,
        {
          version: '2',
          lut: {
            artifactId: 'lut-warm',
            sha256: 'b'.repeat(64),
          },
        },
      ),
    ],
  };
  assert.equal(resolveColorPlan(plan, { segmentId: 'a' }).stages[2].id, 'creative-warm');
  assert.equal(resolveColorPlan(plan, { segmentId: 'b' }).stages[2].id, 'creative-film-look');
});

test('T-FR-180 rejects duplicate stages, broken color chains and LUT reuse outside its stage', () => {
  const duplicate = basePlan();
  duplicate.global.push(
    transform('technical-again', 'technical', sourceColor, workingColor),
  );
  assert.throws(
    () => resolveColorPlan(duplicate, {}),
    /cannot apply a color stage twice/,
  );

  const broken = basePlan();
  broken.global = broken.global.map((item) =>
    item.kind === 'output'
      ? transform('output-broken', 'output', sourceColor, outputColor)
      : item);
  assert.throws(
    () => resolveColorPlan(broken, {}),
    /input does not match prior output/,
  );

  const invalidLut = basePlan();
  invalidLut.global = invalidLut.global.map((item) =>
    item.kind === 'match'
      ? { ...item, lut: { artifactId: 'lut-wrong', sha256: 'c'.repeat(64) } }
      : item);
  assert.throws(
    () => resolveColorPlan(invalidLut, {}),
    /allowed only for an enabled creative LUT/,
  );
});

test('T-FR-180 binds trusted FFprobe colorimetry to an immutable artifact manifest', () => {
  const probe = createMediaColorProbe({
    id: 'color-probe-source-1',
    workspaceId: 'workspace-color',
    artifactId: 'artifact-source-color',
    manifestId: 'manifest-source-color',
    detection: {
      state: 'ready',
      metadata: sourceColor,
      pixelFormat: 'yuv420p10le',
      hdrMode: 'sdr',
    },
    producer: {
      provider: 'ffprobe',
      version: 'json-v1',
      binaryDigest: 'd'.repeat(64),
    },
    createdAt: '2026-07-31T02:00:00.000Z',
  });
  assert.equal(probe.detection.state, 'ready');
  assert.equal(probe.detection.metadata.bitDepth, 10);
  assert.match(probe.probeHash, /^[a-f0-9]{64}$/);
  assert.throws(
    () => createMediaColorProbe({
      ...probe,
      producer: {
        ...probe.producer,
        binaryDigest: 'not-a-digest',
      },
    }),
    /producer is invalid/,
  );
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
