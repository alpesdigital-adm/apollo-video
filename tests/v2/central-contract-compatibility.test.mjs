import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaArtifactManifest } from '../../src/v2/domain/media-artifact.ts'
import { timelineSpanForRate, assertClipRate } from '../../src/v2/domain/clip-timing.ts'
import { createOutputSpec } from '../../src/v2/domain/output-spec.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'

test('T-F0-033 SourceAsset manifest is content-addressed and storage-location free', () => {
  const manifest = createMediaArtifactManifest({
    artifactKey: 'workspace/source/master.mp4', artifactSha256: 'a'.repeat(64), byteSize: 1024,
    mediaType: 'video', container: 'mp4', recipe: { id: 'source-ingest', version: '1.0.0', parameters: { profile: 'master' } },
  })
  assert.equal(manifest.artifact.sha256, 'a'.repeat(64))
  assert.doesNotMatch(JSON.stringify(manifest), /(?:uri|url|path|credential|secret)/i)
})

test('T-F0-033 TimelineSegment timing remains frame-first and reverse fails closed', () => {
  assert.equal(timelineSpanForRate(150, assertClipRate(2)), 75)
  assert.equal(timelineSpanForRate(30, assertClipRate(0.5)), 60)
  for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => assertClipRate(rate), (error) => error?.code === 'INVALID_RENDER_INPUT')
  }
})

test('T-F0-033 OutputSpec and EditCommand enforce the Spec 02 boundaries', () => {
  const output = createOutputSpec({ id: 'output-1', locale: 'pt-BR', aspectRatio: '9:16', width: 1080, height: 1920, fps: 30, safeArea: { top: .05, right: .05, bottom: .05, left: .05 } })
  assert.ok(Object.isFrozen(output.safeArea))
  assert.throws(() => createOutputSpec({ ...output, width: 1079 }), (error) => error?.code === 'INVALID_OUTPUT_SPEC')
  const command = createEditCommand({ id: 'command-1', workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'version-1', baseHash: 'b'.repeat(64), author: { type: 'api-client', id: 'client-1' }, type: 'manual-edit', scope: { clipIds: ['clip-1'], frameRange: { startFrame: 10, endFrame: 20 } }, payload: { operation: 'trim' }, idempotencyKey: 'request-1', createdAt: '2026-08-03T00:00:00.000Z' })
  assert.equal(command.schemaVersion, 1)
  assert.ok(Object.isFrozen(command.scope.frameRange))
  assert.throws(() => createEditCommand({ ...command, scope: {} }), (error) => error?.code === 'INVALID_SCOPE')
})
