import assert from 'node:assert/strict'
import test from 'node:test'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { assertMediaArtifactManifest, createMediaArtifactManifest, createMediaArtifactManifestV2,
  createReplayableMediaArtifactManifest, createReconstructableMediaArtifactManifest } from '../../src/v2/domain/media-artifact.ts'
import { readStoredProjectionManifest, readReviewPreviewContext } from '../../src/v2/infrastructure/prisma/review-annotation-repository.ts'
import { materializedEntry, stateClient, storedState } from './helpers/output-consumption-readers-fakes.mjs'

// Controlled DTO metadata only. No MP4/crypto plaintext read, persistence,
// worker execution, rights grant or editorial acceptance is claimed.
const workspaceId = 'workspace-projection', at = new Date('2026-10-12T12:00:00.000Z')
const sha = (character) => character.repeat(64)
const source = { artifactKey: 'projection/source.mp4', sha256: sha('b'), role: 'primary',
  execution: { tool: { id: 'ffmpeg', version: '8.1.1', digest: sha('c') } } }
const options = () => ({ artifactKey: 'projection/output.mp4', artifactSha256: sha('a'),
  byteSize: 4096, mediaType: 'video', container: 'mp4',
  recipe: { id: 'projection-fixture', version: '1.0.0', parameters: { setting: 1 } },
  sources: [source], probe: { width: 540, height: 960, duration: 2, fps: 30 } })
function renderInput() {
  return createRenderInputSpec({ schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: sha('c') },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: 'plan-projection', versionId: 'version-projection', hash: sha('d') },
    output: { id: 'preset-9x16', locale: 'pt-BR', aspectRatio: '9:16', width: 540, height: 960, fps: 30,
      safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, durationInFrames: 60 },
    assets: [{ id: 'source-asset', artifactId: 'source-artifact', artifactKey: source.artifactKey,
      kind: 'video', role: source.role, ordinal: 0, sha256: source.sha256, byteSize: 4096 }], props: {} })
}
function envelope(payload, hashField) {
  // Format-valid metadata stub; no assertion of encryption/authentication.
  return { workspaceId, ref: payload.ref, [hashField]: payload[hashField], canonicalByteSize: payload.canonicalByteSize,
    algorithm: 'aes-256-gcm', keyId: 'projection-fixture-key', nonce: 'a'.repeat(16), ciphertext: 'metadata-stub',
    authTag: 'b'.repeat(22), createdAt: at }
}
function fixture(version = 1, overrides = {}) {
  const input = { ...options(), ...overrides }
  let manifest, recipeParameters = null, protectedRenderInput = null
  if (version === 1) manifest = createMediaArtifactManifest({ ...input, sources: input.sources.map(({ artifactKey, sha256, role }) => ({ artifactKey, sha256, role })) })
  else if (version === 2) manifest = createMediaArtifactManifestV2(input)
  else {
    const result = version === 3 ? createReplayableMediaArtifactManifest(input) :
      createReconstructableMediaArtifactManifest({ ...input, renderInput: renderInput() })
    manifest = result.manifest
    recipeParameters = envelope(result.recipeParameters, 'parametersHash')
    if (version === 4) protectedRenderInput = envelope(result.renderInput, 'inputHash')
  }
  return { manifest, artifact: { id: 'artifact-projection', workspaceId, ...manifest.artifact, byteSize: BigInt(manifest.artifact.byteSize) },
    stored: { id: 'manifest-projection', workspaceId, artifactId: 'artifact-projection', schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version,
      parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest),
      recipeParametersRef: recipeParameters?.ref ?? null, recipeParameters,
      renderInputRef: protectedRenderInput?.ref ?? null, renderInputHash: protectedRenderInput?.inputHash ?? null,
      renderInput: protectedRenderInput, createdAt: at } }
}
const read = ({ artifact, stored }) => readStoredProjectionManifest(workspaceId, artifact, stored)
const blocked = (value) => assert.throws(() => read(value), (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')

test('projection reader accepts domain-constructed manifests v1/v2/v3/v4 and exposes no encrypted payloads', () => {
  for (const version of [1, 2, 3, 4]) {
    const value = fixture(version), before = stableSerialize(value.manifest)
    assert.deepEqual(read(value), value.manifest)
    assert.equal(stableSerialize(value.manifest), before)
    assert.equal('ciphertext' in read(value), false)
  }
})

test('projection reader rejects altered JSON, row seals/schema/recipe/scope and unexpected protected refs', () => {
  for (const mutate of [
    (i) => { i.stored.manifestJson = '{' },
    (i) => { const doc = JSON.parse(i.stored.manifestJson); doc.probe.fps = 60; i.stored.manifestJson = stableSerialize(doc) },
    (i) => { i.stored.manifestHash = sha('f') }, (i) => { i.stored.schemaVersion = 'media-artifact-manifest/v2' },
    (i) => { i.stored.recipeId = 'different-recipe' }, (i) => { i.stored.recipeVersion = 'different-version' },
    (i) => { i.stored.parametersHash = sha('f') }, (i) => { i.stored.artifactId = 'different-artifact' },
    (i) => { i.stored.workspaceId = 'workspace-sister' }, (i) => { i.artifact.workspaceId = 'workspace-sister' },
    (i) => { i.stored.recipeParametersRef = 'recipe-parameters/sha256/' + sha('f') },
    (i) => { i.stored.renderInputRef = 'render-input/sha256/' + sha('f'); i.stored.renderInputHash = sha('f') },
  ]) { const value = structuredClone(fixture()); mutate(value); blocked(value) }
})

test('valid fully resealed domain manifests cannot replace independent artifact row facts', () => {
  for (const override of [{ artifactKey: 'projection/forged.mp4' }, { artifactSha256: sha('f') },
    { byteSize: 8192 }, { mediaType: 'audio' }, { container: 'mkv' }]) {
    const original = fixture(), resealed = fixture(1, override)
    assert.doesNotThrow(() => assertMediaArtifactManifest(resealed.manifest))
    assert.equal(resealed.stored.manifestHash, resealed.manifest.manifestHash)
    blocked({ ...resealed, artifact: original.artifact })
  }
})

test('v3/v4 protected references bind row metadata and scope without decrypting or omitting links', () => {
  for (const version of [3, 4]) for (const mutate of [
    (i) => { i.stored.recipeParameters = null },
    (i) => { i.stored.recipeParametersRef = 'recipe-parameters/sha256/' + sha('f') },
    (i) => { i.stored.recipeParameters.parametersHash = sha('f') },
    (i) => { i.stored.recipeParameters.ref = 'recipe-parameters/sha256/' + sha('f') },
    (i) => { i.stored.recipeParameters.workspaceId = 'workspace-sister' },
    (i) => { i.stored.recipeParameters.canonicalByteSize = 0 },
    (i) => { i.stored.recipeParameters.algorithm = 'other' },
  ]) { const value = structuredClone(fixture(version)); mutate(value); blocked(value) }
  for (const mutate of [
    (i) => { i.stored.renderInput = null }, (i) => { i.stored.renderInputRef = 'render-input/sha256/' + sha('f') },
    (i) => { i.stored.renderInputHash = sha('f') }, (i) => { i.stored.renderInput.inputHash = sha('f') },
    (i) => { i.stored.renderInput.ref = 'render-input/sha256/' + sha('f') },
    (i) => { i.stored.renderInput.workspaceId = 'workspace-sister' },
    (i) => { i.stored.renderInput.canonicalByteSize = 4 * 1024 * 1024 + 1 },
  ]) { const value = structuredClone(fixture(4)); mutate(value); blocked(value) }
})

test('shared preview refuses actual operation project/workspace mismatch before artifact lookup', async () => {
  for (const operation of [{ workspaceId, projectId: 'project-sister' }, { workspaceId: 'workspace-sister', projectId: 'project-projection' }]) {
    let artifactReads = 0
    // The review is admitted from the sealed State of the Version it previews (purpose critic) before any operation is read.
    const sealed = storedState({ workspaceId, projectId: 'project-projection', versionId: 'version-projection', entries: [materializedEntry('variant-projection')] })
    const client = { ...stateClient([sealed]),
      v2Project: { async findFirst() { return { id: 'project-projection', currentVersionId: 'version-projection',
      versions: [{ id: 'version-projection', sequence: 1, createdAt: at, editPlanSnapshot: { contentJson: '{}' } }] } } },
      v2ProjectFinalExportOperation: { async findMany() { return [] } },
      v2ProjectProxyRenderOperation: { async findMany() { return [{ outputArtifactId: 'artifact-projection',
        projectVersionId: 'version-projection', createdAt: at, operation }] } },
      v2MediaArtifact: { async findFirst() { artifactReads++; throw new Error('must not reach artifact read') } } }
    await assert.rejects(() => readReviewPreviewContext(client, { workspaceId, projectId: 'project-projection' }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT' &&
        error.message === 'Review preview operation belongs to another project')
    assert.equal(artifactReads, 0)
  }
})
