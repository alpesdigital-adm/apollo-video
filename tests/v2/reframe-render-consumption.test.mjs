import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveEditorialRenderGeometry } from '../../src/v2/application/derive-editorial-render-geometry.ts'
import { projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { critiqueOutputFormat, FORMAT_QUALITY_CODES, selectExportableVariants } from '../../src/v2/domain/format-quality-critic.ts'
import { validateRenderElementMap } from '../../src/v2/domain/review-system.ts'
import { buildRecord, faceAt, sampledStream, SOURCE, SPECS, sha } from './helpers/reframe-trajectory-fixtures.mjs'

const PROXY_SHA = sha('7')
const map = (canvas) => validateRenderElementMap({ schemaVersion: 'render-element-map/v1', proxyHash: PROXY_SHA, fps: 30, durationFrames: 150, canvas, elements: [] }, PROXY_SHA)
const critique = (record, canvas, format, spec) => critiqueOutputFormat({
  outputSpecId: spec, format, proxyHash: PROXY_SHA, map: map(canvas), reframePlanHash: record.renderPlan.reframePlanHash,
  reframeIssues: record.issues, reframeRecordHash: record.recordHash,
})

test('W66r the reframe issues of one variant block or warn only that variant, localized by range and evidence', () => {
  const crowded = sampledStream(() => [faceAt(0.05), faceAt(0.85)])
  const blocked = buildRecord({ spec: SPECS.vertical, stream: crowded })
  const wide = buildRecord({ spec: SPECS.wide, stream: crowded })
  const verticalReport = critique(blocked, { width: 540, height: 960 }, '9:16', 'preset-9x16')
  const wideReport = critique(wide, { width: 960, height: 540 }, '16:9', 'preset-16x9')
  assert.deepEqual(FORMAT_QUALITY_CODES.filter((code) => code.startsWith('REFRAME_')),
    ['REFRAME_SUBJECTS_DO_NOT_FIT', 'REFRAME_TRACKING_LIMIT_EXCEEDED', 'REFRAME_PERCEPTION_UNCERTAIN', 'REFRAME_NO_SUBJECT_OBSERVATION'])
  assert.deepEqual([verticalReport.status, verticalReport.exportAllowed], ['blocked', false])
  assert.deepEqual(verticalReport.issues.map((issue) => [issue.code, issue.severity, issue.evidenceRange.startFrame, issue.evidenceRange.endFrame, issue.format]),
    [['REFRAME_SUBJECTS_DO_NOT_FIT', 'hard', 0, 150, '9:16']])
  assert.ok(verticalReport.issues[0].evidenceIds.includes(`face-envelope:${sha('e')}`), 'the issue names the sealed evidence it rests on')
  assert.ok(verticalReport.issues[0].evidenceIds.includes(`reframe-plan-record:${blocked.recordHash}`), 'and the plan record it came from')
  assert.equal(verticalReport.reframePlanHash, blocked.renderPlan.reframePlanHash)
  assert.deepEqual([wideReport.status, wideReport.exportAllowed, wideReport.issues.length], ['passed', true, 0], 'the other variant is untouched by the verdict of this one')
  const decisions = selectExportableVariants([verticalReport, wideReport])
  assert.deepEqual([decisions.approvedOutputSpecIds, decisions.blockedOutputSpecIds], [['preset-16x9'], ['preset-9x16']])
  // a person who must look is a warning, not a block
  const review = buildRecord({ stream: sampledStream((frame) => (frame >= 60 && frame < 90 ? [] : [faceAt(0.4)])) })
  const reviewReport = critique(review, { width: 540, height: 960 }, '9:16', 'preset-9x16')
  assert.deepEqual([reviewReport.status, reviewReport.exportAllowed, reviewReport.issues.map((issue) => [issue.code, issue.severity])],
    ['warning', true, [['REFRAME_NO_SUBJECT_OBSERVATION', 'warning']]])
  // the message says what the plan really does with a stretch where no subject was seen: the crop is carried over inside a clip that has a
  // framed subject, and only a clip with none is shown whole - it never claims the stretch is shown uncropped
  assert.match(reviewReport.issues[0].message, /carried over from the nearest framed subject, or the whole clip is shown when none was framed in it/)
  assert.doesNotMatch(reviewReport.issues[0].message, /uncropped/)
  // an issue of another output, or outside the rendered timeline, is not evidence about these frames
  assert.throws(() => critiqueOutputFormat({ outputSpecId: 'preset-16x9', format: '16:9', proxyHash: PROXY_SHA, map: map({ width: 960, height: 540 }),
    reframeIssues: blocked.issues }), /another output/)
  assert.throws(() => critiqueOutputFormat({ outputSpecId: 'preset-9x16', format: '9:16', proxyHash: PROXY_SHA, map: map({ width: 540, height: 960 }),
    reframeIssues: [{ ...blocked.issues[0], endFrame: 900 }] }), /outside the rendered timeline/)
})

const sealedSource = (record, variantId = SPECS.vertical.variantId, format = '9:16') => ({
  projectId: 'project-1', projectVersionId: 'version-1', editPlanSnapshotId: 'snapshot-1', editPlanHash: sha('1'),
  editPlan: { fps: 30, durationFrames: 150, subtitleTracks: [], overlayTracks: [], videoTracks: [] }, format,
  outputConsumption: { seal: { variantId }, sealHash: sha('4') },
  sourceArtifactId: SOURCE.artifactId, sourceManifestId: SOURCE.manifestId, sourceArtifactKey: 'k', sourceSha256: SOURCE.sha256,
  renderSources: [{ artifactId: SOURCE.artifactId, manifestId: SOURCE.manifestId, artifactKey: 'k', sha256: SOURCE.sha256, byteSize: 10, mediaType: 'video', container: 'mp4', role: 'source-master', probe: { width: SOURCE.width, height: SOURCE.height } }],
  originalFileName: 'f.mp4', uploadReceivedAt: '2026-10-19T00:00:00.000Z', criticIssues: [],
  reframePlan: record.renderPlan, reframeIssues: record.issues, reframeRecordHash: record.recordHash,
})
const geometry = (source) => deriveEditorialRenderGeometry({
  source, canvas: { width: 540, height: 960 }, workspaceId: 'workspace-1', projectId: 'project-1', clips: [], clock: () => new Date('2026-10-19T00:00:00.000Z'),
})

test('W66r the render consumes the persisted plan by the stable variant it is sealed to, never by its aspect ratio', async () => {
  const stream = sampledStream((frame) => [faceAt(0.3 + frame / 1000)])
  const vertical = buildRecord({ spec: SPECS.vertical, stream })
  const wide = buildRecord({ spec: SPECS.wide, stream })
  const derived = await geometry(sealedSource(vertical))
  assert.equal(derived.reframePlan.reframePlanHash, vertical.renderPlan.reframePlanHash)
  assert.deepEqual(derived.reframeIssues, vertical.issues)
  // the identity that used to pass (variantId spelled as the aspect ratio) is refused when the render is sealed to a stable variant
  const legacy = buildRecord({ spec: { ...SPECS.vertical, variantId: '9:16' }, stream })
  await assert.rejects(() => geometry(sealedSource(legacy)), (error) => error.code === 'INVALID_RENDER_INPUT' && /does not describe this render/.test(error.message))
  // the plan of the other output, or of another aspect ratio, is no plan for this one
  await assert.rejects(() => geometry(sealedSource(wide)), (error) => error.code === 'INVALID_RENDER_INPUT')
  await assert.rejects(() => geometry(sealedSource(vertical, SPECS.vertical.variantId, '16:9')), (error) => error.code === 'INVALID_RENDER_INPUT')
  // a plan of another variant that happens to share the aspect ratio is refused by the id alone
  await assert.rejects(() => geometry(sealedSource(vertical, 'variant-vertical-2')), (error) => error.code === 'INVALID_RENDER_INPUT')
  // no persisted plan: the render is what it always was
  const bare = sealedSource(vertical)
  delete bare.reframePlan; delete bare.reframeIssues; delete bare.reframeRecordHash
  const plain = await geometry(bare)
  assert.deepEqual([plain.reframePlan, plain.reframeIssues], [undefined, []])
})

test('W66r the plan is part of what a render is: another plan is another input, no plan keeps the identity of every earlier render', () => {
  const stream = sampledStream((frame) => [faceAt(0.3 + frame / 1000)])
  const record = buildRecord({ stream })
  const without = sealedSource(record)
  delete without.reframePlan; delete without.reframeIssues; delete without.reframeRecordHash
  const bindings = []
  const hashes = {
    none: projectProxyRenderInputHash({ source: without, colorPipelineBindings: bindings }),
    planned: projectProxyRenderInputHash({ source: sealedSource(record), colorPipelineBindings: bindings }),
    other: projectProxyRenderInputHash({ source: { ...sealedSource(record), reframeRecordHash: sha('f') }, colorPipelineBindings: bindings }),
  }
  assert.equal(new Set(Object.values(hashes)).size, 3)
  assert.equal(projectProxyRenderInputHash({ source: { ...without, reframeRecordHash: undefined }, colorPipelineBindings: bindings }), hashes.none, 'an absent plan is not a field of the identity')
})
