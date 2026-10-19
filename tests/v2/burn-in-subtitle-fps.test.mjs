import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createProjectOutputVariantService, parseCreateProjectOutputVariantBody } from '../../src/v2/application/create-project.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION } from '../../src/v2/domain/output-canonical-policy.ts'
import { createOutputSpecRevisionBody, sealOutputSpecRevision } from '../../src/v2/domain/output-spec-revision.ts'
import {
  assertSubtitleDeliverySupportedAtFps, BURN_IN_SUBTITLE_FPS_UNSUPPORTED, BURN_IN_SUBTITLE_MAX_FPS,
  isBurnInSubtitleFpsUnsupported,
} from '../../src/v2/domain/output-spec.ts'

/**
 * Burned-in subtitles are refused above 90 fps where the OutputSpec and its subtitle delivery meet, with one typed error
 * and before any renderer, clock, cache or repository is involved. Outputs without burned-in subtitles keep 1..120 fps.
 * 24-90 fps have a 100% representable ASS clock (docs/quality/w69-materialized-subtitle-clock-v2.md); 100 fps already has
 * frame 803 that no centisecond separates (tests/v2/ass-emission-clock-pixels.integration.mjs, physical).
 */
const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
const hash = 'a'.repeat(64)
const configuration = { schemaVersion: 'controlled-subtitle-configuration/v1', ...policy, purpose: 'contract fixture, no face approval' }
const sealedConfiguration = { schemaVersion: configuration.schemaVersion, document: configuration, hash: calculateOutputCanonicalHash(configuration) }
const encoding = (kind, fps) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true,
  width: 320, height: 320, fps, quality: { mode: 'crf', value: kind === 'final' ? 18 : 23, preset: kind === 'final' ? 'medium' : 'veryfast' },
  audio: { codec: 'aac', bitrateKbps: kind === 'final' ? 192 : 160, sampleRateHz: 48000, channels: 1 } })
const subtitlesFor = (mode, { fonts = true } = {}) => mode === 'none'
  ? { mode, configuration: null, fontAssets: [] }
  : { mode, configuration: sealedConfiguration, fontAssets: fonts ? [{ artifactId: 'font-alpha', sha256: hash }] : [] }

function revisionInput({ fps, mode, fonts = true }) {
  return { ...policy, id: 'revision-alpha', variantId: 'variant-alpha', workspaceId: 'workspace-alpha', projectId: 'project-alpha', revisionNumber: 1,
    output: { id: 'variant-alpha', locale: 'pt-BR', aspectRatio: '1:1', width: 320, height: 320, fps,
      safeArea: { top: .05, bottom: .05, left: .05, right: .05 }, deliveryProfileId: 'profile-alpha' },
    profile: { schemaVersion: 'materialized-delivery-profile/v1', id: 'profile-alpha', version: 1,
      rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding('final', fps), proxy: encoding('proxy', fps),
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 1, scaleY: 1 }, subtitles: subtitlesFor(mode, { fonts }) },
    preset: null, createdAt: '2026-10-18T00:00:00.000Z' }
}

const typedRefusal = (fps) => (error) => isBurnInSubtitleFpsUnsupported(error) && error.code === 'INVALID_OUTPUT_SPEC' &&
  error.reason === BURN_IN_SUBTITLE_FPS_UNSUPPORTED && error.details.reason === 'SUBTITLE_BURN_IN_FPS_UNSUPPORTED' &&
  error.details.mode === 'burn-in' && error.details.fps === fps && error.details.maxFps === 90 && /90 fps/.test(error.message)

test('the limit is 90 fps and is a named constant', () => {
  assert.equal(BURN_IN_SUBTITLE_MAX_FPS, 90)
  assert.equal(BURN_IN_SUBTITLE_FPS_UNSUPPORTED, 'SUBTITLE_BURN_IN_FPS_UNSUPPORTED')
})

test('every rate from 1 to 120 is decided by mode and rate alone: burn-in up to 90, everything else up to 120', () => {
  for (let fps = 1; fps <= 120; fps += 1) {
    for (const mode of ['none', 'sidecar']) {
      assert.doesNotThrow(() => createOutputSpecRevisionBody(revisionInput({ fps, mode })), `${mode} ${fps} fps`)
    }
    if (fps <= 90) assert.doesNotThrow(() => createOutputSpecRevisionBody(revisionInput({ fps, mode: 'burn-in' })), `burn-in ${fps} fps`)
    else assert.throws(() => createOutputSpecRevisionBody(revisionInput({ fps, mode: 'burn-in' })), typedRefusal(fps), `burn-in ${fps} fps`)
  }
})

test('the refusal is the first thing decided: it does not depend on, or hide behind, any other defect', () => {
  // no font artifacts and no configuration would also be refused, but the rate answer comes first and typed
  assert.throws(() => createOutputSpecRevisionBody(revisionInput({ fps: 120, mode: 'burn-in', fonts: false })), typedRefusal(120))
  const bare = revisionInput({ fps: 100, mode: 'burn-in' })
  bare.profile.subtitles = { mode: 'burn-in', configuration: null, fontAssets: [] }
  assert.throws(() => createOutputSpecRevisionBody(bare), typedRefusal(100))
  // below the limit the same defects keep their own, different, untyped-by-rate errors
  assert.throws(() => createOutputSpecRevisionBody(revisionInput({ fps: 30, mode: 'burn-in', fonts: false })),
    (error) => error.code === 'INVALID_OUTPUT_SPEC' && !isBurnInSubtitleFpsUnsupported(error) && /font/i.test(error.message))
})

test('sealing a revision applies the same rule, so a stored or replayed spec cannot reach a render either', () => {
  const command = { kind: 'edit-command', id: 'command-alpha', hash }
  assert.doesNotThrow(() => sealOutputSpecRevision(revisionInput({ fps: 90, mode: 'burn-in' }), command))
  assert.throws(() => sealOutputSpecRevision(revisionInput({ fps: 91, mode: 'burn-in' }), command), typedRefusal(91))
  assert.doesNotThrow(() => sealOutputSpecRevision(revisionInput({ fps: 120, mode: 'sidecar' }), command))
})

test('the guard function itself: only burn-in is limited, and non-integer rates are not silently accepted', () => {
  for (const mode of ['none', 'sidecar']) assert.doesNotThrow(() => assertSubtitleDeliverySupportedAtFps(mode, 120))
  assert.doesNotThrow(() => assertSubtitleDeliverySupportedAtFps('burn-in', 90))
  assert.throws(() => assertSubtitleDeliverySupportedAtFps('burn-in', 90.5), isBurnInSubtitleFpsUnsupported)
  assert.throws(() => assertSubtitleDeliverySupportedAtFps('burn-in', 91), typedRefusal(91))
})

test('the public create-output-variant path refuses it at parse time, before any repository is read', async () => {
  const body = (fps, mode) => ({ baseVersionId: 'version-base', baseHash: hash,
    output: { locale: 'pt-BR', aspectRatio: '1:1', width: 320, height: 320, fps, deliveryProfileId: 'profile-alpha',
      safeArea: { top: .05, bottom: .05, left: .05, right: .05 } },
    profile: { schemaVersion: 'materialized-delivery-profile/v1', id: 'profile-alpha', version: 1,
      rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding('final', fps), proxy: encoding('proxy', fps),
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 1, scaleY: 1 }, subtitles: subtitlesFor(mode) },
    preset: null })
  assert.doesNotThrow(() => parseCreateProjectOutputVariantBody(body(90, 'burn-in')))
  assert.doesNotThrow(() => parseCreateProjectOutputVariantBody(body(120, 'sidecar')))
  assert.doesNotThrow(() => parseCreateProjectOutputVariantBody(body(120, 'none')))
  assert.throws(() => parseCreateProjectOutputVariantBody(body(120, 'burn-in')), typedRefusal(120))

  let reads = 0
  const auditContext = createExternalAuditContext({ clientId: 'client-alpha', credentialId: 'credential-alpha', workspaceId: 'workspace-alpha', environment: 'production' })
  const actor = { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
  const create = createProjectOutputVariantService({
    clock: () => new Date('2026-10-18T00:00:00.000Z'), createId: (kind) => kind + '-alpha', createEventId: () => 'event-alpha',
    repository: { read: async () => { reads += 1; return null }, persistChild: async () => { throw new Error('must not persist') } },
  })
  await assert.rejects(create({ workspaceId: 'workspace-alpha', projectId: 'project-alpha', actor, idempotencyKey: 'idem-alpha', ...body(100, 'burn-in') }),
    typedRefusal(100))
  assert.equal(reads, 0, 'the project is not even read')
})
