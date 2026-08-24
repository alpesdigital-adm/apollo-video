import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts';
import { compileColorPlanTargets, createColorPlan, createExportMatrix, createMediaColorProbe, OUTPUT_FORMATS, parseCube, preflightExports, renderExportCell, resolveColorPlan, SDR_COLOR_FIXTURES, selectWorkspaceLut } from '../../src/v2/domain/color-and-export.ts';
import { createProjectColorPlan, parseProjectColorPlan } from '../../src/v2/domain/project-color-plan.ts';
import { createProjectColorPlanImpact, createProjectColorPlanInvalidations, parseProjectColorPlanImpact } from '../../src/v2/domain/project-color-plan-impact.ts';
import { createProjectVersion } from '../../src/v2/domain/project-version.ts';
import { setProjectColorPlanService } from '../../src/v2/application/project-color-plans.ts';

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
  assert.deepEqual(
    SDR_COLOR_FIXTURES.map((fixture) => fixture.source),
    ['rec709-camera-a', 'rec709-camera-b', 'rec709-clipping-ramp'],
  );
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

test('T-FR-182 canonicalizes every override layer and rejects dormant invalid transforms', () => {
  const left = basePlan();
  left.sources = {
    'SOURCE-B': [transform('match-b', 'match', workingColor, workingColor)],
    'source-a': [transform('match-a', 'match', workingColor, workingColor)],
  };
  left.cameras = {
    'camera-a': [transform('camera-a-match', 'match', workingColor, workingColor)],
  };
  left.segments = {
    'segment-a': [transform('segment-a-look', 'creative-lut', workingColor, workingColor, {
      lut: { artifactId: 'lut-segment-a', sha256: 'e'.repeat(64) },
    })],
  };
  const right = basePlan();
  right.sources = {
    'source-a': [transform('match-a', 'match', workingColor, workingColor)],
    'source-b': [transform('match-b', 'match', workingColor, workingColor)],
  };
  right.cameras = left.cameras;
  right.segments = left.segments;

  const canonical = createColorPlan(left);
  assert.deepEqual(Object.keys(canonical.sources), ['source-a', 'source-b']);
  assert.equal(canonical.planHash, createColorPlan(right).planHash);
  assert.equal(
    resolveColorPlan(left, { sourceId: 'SOURCE-A', cameraId: 'CAMERA-A', segmentId: 'SEGMENT-A' }).stages[2].id,
    'segment-a-look',
  );

  const dormantInvalid = basePlan();
  dormantInvalid.segments = {
    unused: [{
      ...transform('invalid-unused', 'match', workingColor, workingColor),
      implementation: {
        ...transform('invalid-unused', 'match', workingColor, workingColor).implementation,
        parametersHash: '0'.repeat(64),
      },
    }],
  };
  assert.throws(
    () => resolveColorPlan(dormantInvalid, { segmentId: 'other' }),
    /parametersHash does not match parameters/,
  );
});

test('T-FR-182 compiles a content-addressed target manifest without leaking sibling overrides', () => {
  const plan = basePlan();
  plan.sources = {
    'source-b': [transform('source-b-match', 'match', workingColor, workingColor)],
  };
  plan.cameras = {
    'camera-b': [transform('camera-b-match', 'match', workingColor, workingColor)],
  };
  plan.segments = {
    'segment-b': [transform('segment-b-look', 'creative-lut', workingColor, workingColor, {
      lut: { artifactId: 'lut-segment-b', sha256: 'f'.repeat(64) },
    })],
  };
  const targets = [
    { sourceId: 'source-b', cameraId: 'camera-b', segmentId: 'segment-b' },
    { sourceId: 'source-a', cameraId: 'camera-a', segmentId: 'segment-a' },
  ];
  const compiled = compileColorPlanTargets({ plan, targets });
  const reordered = compileColorPlanTargets({ plan, targets: targets.toReversed() });
  assert.equal(compiled.manifestHash, reordered.manifestHash);
  assert.equal(compiled.colorPlanHash, createColorPlan(plan).planHash);
  assert.equal(compiled.targets.length, 2);
  const sibling = compiled.targets.find((target) => target.target.segmentId === 'segment-a');
  const overridden = compiled.targets.find((target) => target.target.segmentId === 'segment-b');
  assert.equal(sibling.stages[1].id, 'camera-match-reference-a');
  assert.equal(sibling.stages[2].id, 'creative-film-look');
  assert.equal(overridden.stages[1].id, 'camera-b-match');
  assert.equal(overridden.stages[2].id, 'segment-b-look');
  assert.throws(
    () => compileColorPlanTargets({ plan, targets: [targets[0], targets[0]] }),
    /targets must be unique/,
  );
});

test('T-FR-182 requires each differently encoded source to enter through its own technical transform', () => {
  const log2 = {
    colorSpace: 'camera-log2', transfer: 'log2', primaries: 'bt2020',
    matrix: 'bt2020-ncl', range: 'limited', bitDepth: 12,
  };
  const plan = basePlan();
  plan.sourceMetadata = { 'source-b': log2 };
  plan.sources = {
    'source-b': [
      transform('technical-log2-to-working', 'technical', log2, workingColor),
      transform('match-source-b', 'match', workingColor, workingColor),
    ],
  };
  const sourceA = resolveColorPlan(plan, { sourceId: 'source-a' });
  const sourceB = resolveColorPlan(plan, { sourceId: 'source-b' });
  assert.equal(sourceA.sourceMetadata.transfer, 'log');
  assert.equal(sourceB.sourceMetadata.transfer, 'log2');
  assert.equal(sourceB.stages[0].id, 'technical-log2-to-working');

  const missingTechnical = structuredClone(plan);
  missingTechnical.sources['source-b'] = [transform('match-source-b', 'match', workingColor, workingColor)];
  assert.throws(
    () => resolveColorPlan(missingTechnical, { sourceId: 'source-b' }),
    /technical input does not match prior output/,
  );
});

test('T-FR-182 binds ColorPlan, target manifest and full-timeline invalidation to one versioned command', () => {
  const colorPlan = createProjectColorPlan({
    id: 'project-color-plan-1',
    workspaceId: 'workspace-color',
    projectId: 'project-color',
    commandId: 'command-color-plan-1',
    baseVersionId: 'project-version-color-1',
    resultVersionId: 'project-version-color-2',
    plan: basePlan(),
    targets: [
      { sourceId: 'source-a', segmentId: 'segment-a' },
      { sourceId: 'source-b', cameraId: 'camera-b', segmentId: 'segment-b' },
    ],
    createdAt: '2026-08-24T12:00:00.000Z',
  });
  assert.equal(parseProjectColorPlan(JSON.parse(JSON.stringify(colorPlan))).recordHash, colorPlan.recordHash);
  const impact = createProjectColorPlanImpact({
    commandId: colorPlan.commandId,
    baseVersionId: colorPlan.baseVersionId,
    resultVersionId: colorPlan.resultVersionId,
    colorPlanId: colorPlan.id,
    colorPlanHash: colorPlan.plan.planHash,
    compiledManifestHash: colorPlan.compiled.manifestHash,
    durationFrames: 300,
    proxyVariantId: '9:16',
    outputReferences: [
      { artifactId: 'artifact-proxy-color-1', kind: 'proxy', sourceVersionId: colorPlan.baseVersionId, variantId: '9:16' },
      { artifactId: 'artifact-final-color-1', kind: 'final', sourceVersionId: colorPlan.baseVersionId, variantId: '16:9' },
    ],
  });
  assert.equal(parseProjectColorPlanImpact(JSON.parse(JSON.stringify(impact))).impactHash, impact.impactHash);
  assert.deepEqual(impact.affectedRanges, [{ startFrame: 0, endFrame: 300 }]);
  assert.deepEqual(impact.affectedVariantIds, ['16:9', '9:16']);
  assert.equal(createProjectColorPlanInvalidations({ impact, createdAt: colorPlan.createdAt }).length, 2);

  const tampered = JSON.parse(JSON.stringify(colorPlan));
  tampered.compiled.targets[0].pipelineHash = '0'.repeat(64);
  assert.throws(() => parseProjectColorPlan(tampered), /inconsistent/);
});

test('T-FR-182 applies ColorPlan through the shared Command and immutable ProjectVersion model', async () => {
  const currentVersion = createProjectVersion({
    id: 'project-version-color-service-1',
    workspaceId: 'workspace-color-service',
    projectId: 'project-color-service',
    sequence: 1,
    snapshotRefs: {
      brief: 'snapshot-brief-color-service',
      editPlan: 'snapshot-edit-color-service',
      policies: 'snapshot-policy-color-service',
    },
    baseHash: '1'.repeat(64),
    createdBy: 'system-color-service',
    createdAt: '2026-08-24T11:00:00.000Z',
  });
  const outputs = [{
    artifactId: 'artifact-color-service-proxy',
    kind: 'proxy',
    sourceVersionId: currentVersion.id,
    variantId: '9:16',
  }];
  let stored = null;
  const repository = {
    async findIdempotent() {
      return stored ? { requestFingerprint: stored.requestFingerprint, result: stored.result } : null;
    },
    async readContext() {
      return {
        currentVersion,
        targets: [
          { sourceId: 'source-a', segmentId: 'clip-a' },
          { sourceId: 'source-b', cameraId: 'camera-b', segmentId: 'clip-b' },
        ],
        trustedSourceMetadata: {
          'source-a': sourceColor,
          'source-b': sourceColor,
        },
        currentDurationFrames: 180,
        proxyVariantId: '9:16',
        outputReferences: outputs,
      };
    },
    async commitOrReplay(commit) {
      const result = Object.freeze({
        command: commit.command,
        version: commit.version,
        colorPlan: commit.colorPlan,
        impact: commit.command.payload.impact,
        invalidations: createProjectColorPlanInvalidations({ impact: commit.command.payload.impact, createdAt: commit.command.createdAt }),
        replayed: false,
      });
      stored = { requestFingerprint: commit.requestFingerprint, result };
      return result;
    },
  };
  const ids = {
    command: 'command-color-service-1',
    version: 'project-version-color-service-2',
    'color-plan': 'project-color-plan-service-1',
  };
  const service = setProjectColorPlanService({
    repository,
    createId: (kind) => ids[kind],
    createEventId: () => '20000000-0000-4000-8000-000000000001',
    clock: () => new Date('2026-08-24T12:00:00.000Z'),
  });
  const plan = basePlan();
  plan.sourceMetadata = { 'source-a': sourceColor, 'source-b': sourceColor };
  plan.sources = {
    'source-b': [transform('source-b-match', 'match', workingColor, workingColor)],
  };
  plan.cameras = {
    'camera-b': [transform('camera-b-match', 'match', workingColor, workingColor)],
  };
  plan.segments = {
    'clip-b': [transform('clip-b-look', 'creative-lut', workingColor, workingColor, {
      lut: { artifactId: 'lut-clip-b', sha256: '7'.repeat(64) },
    })],
  };
  const request = {
    workspaceId: currentVersion.workspaceId,
    projectId: currentVersion.projectId,
    baseVersionId: currentVersion.id,
    baseHash: currentVersion.baseHash,
    plan,
    actor: { type: 'system', id: 'system-color-service' },
    idempotencyKey: 'color-plan-service-001',
  };
  const applied = await service(request);
  assert.equal(applied.command.type, 'set-project-color-plan');
  assert.equal(applied.version.parentVersionId, currentVersion.id);
  assert.equal(applied.colorPlan.compiled.targets.length, 2);
  assert.deepEqual(applied.impact.affectedRanges, [{ startFrame: 0, endFrame: 180 }]);
  assert.equal(applied.invalidations.length, 1);
  assert.equal(applied.replayed, false);
  assert.equal((await service(request)).colorPlan.recordHash, applied.colorPlan.recordHash);

  const unknownTarget = structuredClone(request);
  unknownTarget.idempotencyKey = 'color-plan-service-002';
  unknownTarget.plan.segments = {
    missing: [transform('missing-look', 'creative-lut', workingColor, workingColor, {
      lut: { artifactId: 'lut-missing', sha256: '8'.repeat(64) },
    })],
  };
  stored = null;
  await assert.rejects(() => service(unknownTarget), /outside the current EditPlan/);
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
  assert.throws(() => parseCube({ id: 'bad', name: 'bad', owner: 'w', license: 'x', cube: 'LUT_3D_SIZE 33' }), /row count/);
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
