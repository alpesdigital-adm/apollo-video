import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  exportProjectSubtitleSidecarService,
  listProjectSubtitleSidecarsService,
} from '../../src/v2/application/export-subtitle-sidecar.ts'
import {
  authorizeMediaDownloadGrantService,
  issueMediaDownloadGrantService,
} from '../../src/v2/application/manage-media-download-grant.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { parseSubtitleSidecar } from '../../src/v2/domain/subtitle-sidecar.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { TemporaryFileSubtitleSidecarStaging } from '../../src/v2/infrastructure/media/subtitle-sidecar-staging.ts'
import { HmacMediaDownloadGrantSigner } from '../../src/v2/infrastructure/security/media-download-grant-signer.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')

const WORKSPACE = 'workspace-sidecar-1'
const PROJECT = 'project-sidecar-1'
const VERSION_CURRENT = 'project-version-sidecar-5'
const VERSION_OLD = 'project-version-sidecar-4'

/** The T-FR-175 fixture: a diacritic, an internal break and a closing cue. */
const FIXTURE_CUES = Object.freeze([
  { id: 'cue-1', startFrame: 0, endFrame: 36, text: 'Ação e\nclareza', anchor: 'bottom' },
  { id: 'cue-2', startFrame: 45, endFrame: 75, text: 'Última cue.', anchor: 'bottom' },
])

const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

/** The same real compilation the renderer goldens use; no fake color pipeline. */
function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: WORKSPACE, artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2026-08-14T08:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: probe.workspaceId,
    projectId: PROJECT, sourceArtifactId: artifactId, sourceManifestId: manifestId,
    probe, outputMetadata: colorMetadata, createdByClientId: actor.clientId,
    createdAt: '2026-08-14T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

const actor = Object.freeze({
  clientId: 'client-sidecar-1',
  credentialId: 'credential-sidecar-1',
  workspaceId: WORKSPACE,
  environment: 'production',
  scopes: new Set(['projects:read', 'projects:write', 'artifacts:read']),
  authenticationKind: 'bearer',
  clientKillSwitchEngaged: false,
  workspaceKillSwitchEngaged: false,
  clientAccessStatus: 'active',
  workspaceAccessStatus: 'active',
  auditContext: {
    clientId: 'client-sidecar-1',
    credentialId: 'credential-sidecar-1',
    workspaceId: WORKSPACE,
    environment: 'production',
    actor: { type: 'api-client', id: 'client-sidecar-1' },
  },
})

/**
 * Controlled equivalents of the persistence adapters. They keep the real
 * immutability rules of the Postgres repositories — content-addressed replay,
 * one row per lineage, idempotency by key — without requiring a database, so the
 * proof runs on a host with no PostgreSQL. `prisma-subtitle-sidecar.integration`
 * covers the same flow against the real schema when a database is available.
 */
function inMemoryArtifacts() {
  const byId = new Map()
  const byKey = new Map()
  return {
    seed(record) {
      byId.set(record.id, record)
      byKey.set(record.artifactKey, record)
    },
    async findById(workspaceId, artifactId) {
      const record = byId.get(artifactId)
      return record && record.workspaceId === workspaceId ? record : null
    },
    async findColorProbe() { return null },
    async persistOrReplay(bundle) {
      const existing = byKey.get(bundle.manifest.artifact.artifactKey)
      if (existing) {
        assert.equal(existing.sha256, bundle.manifest.artifact.sha256)
        const manifest = existing.manifests.find(
          (entry) => entry.manifestHash === bundle.manifest.manifestHash,
        )
        if (manifest) return { artifactId: existing.id, manifestId: manifest.id, replayed: true }
        existing.manifests.push({
          id: bundle.manifestId,
          schemaVersion: bundle.manifest.schemaVersion,
          manifestHash: bundle.manifest.manifestHash,
          recipe: { ...bundle.manifest.recipe },
          sources: bundle.manifest.sources.map((source, ordinal) => ({ ...source, ordinal })),
          createdAt: bundle.createdAt,
        })
        return { artifactId: existing.id, manifestId: bundle.manifestId, replayed: false }
      }
      for (const source of bundle.manifest.sources) {
        assert.ok(byKey.has(source.artifactKey), 'manifest source must already exist')
      }
      const record = {
        id: bundle.artifactId,
        workspaceId: bundle.workspaceId,
        artifactKey: bundle.manifest.artifact.artifactKey,
        sha256: bundle.manifest.artifact.sha256,
        byteSize: BigInt(bundle.manifest.artifact.byteSize),
        mediaType: bundle.manifest.artifact.mediaType,
        container: bundle.manifest.artifact.container,
        status: 'available',
        lifecycleRevision: 1,
        manifests: [{
          id: bundle.manifestId,
          schemaVersion: bundle.manifest.schemaVersion,
          manifestHash: bundle.manifest.manifestHash,
          recipe: { ...bundle.manifest.recipe },
          sources: bundle.manifest.sources.map((source, ordinal) => ({ ...source, ordinal })),
          createdAt: bundle.createdAt,
        }],
        createdAt: bundle.createdAt,
      }
      byId.set(record.id, record)
      byKey.set(record.artifactKey, record)
      return { artifactId: record.id, manifestId: bundle.manifestId, replayed: false }
    },
    get size() { return byId.size },
  }
}

function inMemorySidecars(alignments) {
  const rows = []
  return {
    alignments,
    async readRenderedAlignment(input) {
      const key = `${input.projectVersionId ?? VERSION_CURRENT}:${input.variantId}`
      return alignments.get(key) ?? null
    },
    async findIdempotent(input) {
      const row = rows.find((item) =>
        item.record.workspaceId === input.workspaceId &&
        item.record.projectId === input.projectId &&
        item.idempotencyKey === input.idempotencyKey)
      return row ? { requestFingerprint: row.requestFingerprint, record: row.record } : null
    },
    async persistOrReplay(input) {
      const byLineage = rows.find((item) =>
        item.record.workspaceId === input.record.workspaceId &&
        item.record.lineageHash === input.record.lineageHash)
      if (byLineage) {
        assert.equal(byLineage.record.sha256, input.record.sha256)
        return { record: byLineage.record, replayed: true }
      }
      rows.push({ ...input })
      return { record: input.record, replayed: false }
    },
    async list(input) {
      return rows
        .map((item) => item.record)
        .filter((record) =>
          record.workspaceId === input.workspaceId &&
          record.projectId === input.projectId &&
          (!input.projectVersionId || record.projectVersionId === input.projectVersionId) &&
          (!input.variantId || record.variantId === input.variantId) &&
          (!input.format || record.format === input.format))
        .slice(0, input.limit)
    },
    get rows() { return rows },
  }
}

function inMemoryGrants() {
  const grants = new Map()
  return {
    async createOrReplay(grant) {
      const existing = [...grants.values()].find((item) =>
        item.workspaceId === grant.workspaceId &&
        item.clientId === grant.clientId &&
        item.idempotencyKey === grant.idempotencyKey)
      if (existing) return { grant: existing, replayed: true }
      grants.set(grant.id, grant)
      return { grant, replayed: false }
    },
    async find(input) {
      const grant = grants.get(input.grantId)
      return grant && grant.workspaceId === input.workspaceId && grant.clientId === input.clientId
        ? grant
        : undefined
    },
    async revokeOrReplay() { throw new Error('not used') },
  }
}

/**
 * Renders one small MP4 with the real editorial renderer and returns the real
 * artifact plus the RenderElementMap the renderer emitted for it.
 */
async function renderFixture(root, { cues = FIXTURE_CUES, operationId = 'sidecar-render' } = {}) {
  const sourcePath = join(root, `${operationId}-source.mp4`)
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', sourcePath,
  ], { windowsHide: true, timeout: 180_000 })
  const renderer = new FfmpegEditorialProxyRenderer({
    workRoot: join(root, 'work', operationId), ffmpegPath,
  })
  return renderer.render({
    operationId, renderKind: 'proxy',
    sources: [{
      artifactId: 'artifact-sidecar-source', path: sourcePath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-sidecar-source'),
    }],
    clips: [{
      id: 'clip-1', sourceArtifactId: 'artifact-sidecar-source',
      sourceInFrame: 0, sourceOutFrame: 90,
      timelineInFrame: 0, timelineOutFrame: 90, rate: 1,
    }],
    fps: 30, format: '9:16', subtitleCues: cues,
  })
}

function alignmentOf(rendered, storedOutput, overrides = {}) {
  return {
    projectId: PROJECT,
    projectVersionId: VERSION_CURRENT,
    projectVersionSequence: 5,
    isCurrentVersion: true,
    variantId: '9:16',
    outputKind: 'proxy',
    outputArtifactId: 'artifact-sidecar-proxy',
    outputManifestId: 'manifest-sidecar-proxy',
    outputArtifactKey: storedOutput.key,
    outputSha256: rendered.sha256,
    renderInputHash: 'b'.repeat(64),
    editPlanSnapshotId: 'snapshot-editplan-5',
    editPlanHash: 'c'.repeat(64),
    renderElementMapId: 'render-element-map-1',
    renderElementMapHash: renderElementMapHash(rendered.renderElementMap),
    map: rendered.renderElementMap,
    cueTexts: Object.fromEntries(FIXTURE_CUES.map((cue) => [cue.id, cue.text])),
    ...overrides,
  }
}

function seedRenderedOutput(artifacts, alignment, stored) {
  artifacts.seed({
    id: alignment.outputArtifactId,
    workspaceId: WORKSPACE,
    artifactKey: stored.key,
    sha256: stored.sha256,
    byteSize: BigInt(stored.byteSize),
    mediaType: 'video',
    container: 'mp4',
    status: 'available',
    lifecycleRevision: 1,
    manifests: [{
      id: alignment.outputManifestId,
      schemaVersion: 'media-artifact-manifest/v4',
      manifestHash: 'd'.repeat(64),
      recipe: { id: 'editorial-proxy', version: '1.0.0', parametersHash: 'e'.repeat(64) },
      renderInput: {
        ref: `render-input/sha256/${alignment.renderInputHash}`,
        inputHash: alignment.renderInputHash,
        canonicalByteSize: 1024,
        algorithm: 'aes-256-gcm',
      },
      sources: [],
      createdAt: '2026-08-14T09:00:00.000Z',
    }],
    createdAt: '2026-08-14T09:00:00.000Z',
  })
}

async function harness(root, { alignments }) {
  const storage = new LocalMediaUploadStorage(join(root, 'artifacts'))
  const artifacts = inMemoryArtifacts()
  const sidecars = inMemorySidecars(alignments)
  return {
    storage,
    artifacts,
    sidecars,
    dependencies: {
      sidecars,
      artifacts,
      persistence: artifacts,
      storage,
      staging: new TemporaryFileSubtitleSidecarStaging(join(root, 'staging')),
      clock: () => new Date('2026-08-14T09:30:00.000Z'),
    },
  }
}

test('T-FR-175 a sidecar is derived from the alignment of a real rendered MP4 and round-trips', {
  timeout: 10 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-sidecar-pipeline-'))
  try {
    const rendered = await renderFixture(root)
    const storage = new LocalMediaUploadStorage(join(root, 'artifacts'))
    const storedOutput = await storage.promoteDerived({
      workspaceId: WORKSPACE, sourcePath: rendered.outputPath, sha256: rendered.sha256,
      extension: 'mp4', prefix: 'editorial-proxies',
    })
    const alignment = alignmentOf(rendered, storedOutput)
    const alignments = new Map([[`${VERSION_CURRENT}:9:16`, alignment]])
    const context = await harness(root, { alignments })
    seedRenderedOutput(context.artifacts, alignment, storedOutput)

    const srt = await exportProjectSubtitleSidecarService(context.dependencies)({
      workspaceId: WORKSPACE, actor, projectId: PROJECT, variantId: '9:16',
      format: 'srt', idempotencyKey: 'idem-srt-1',
    })
    const vtt = await exportProjectSubtitleSidecarService(context.dependencies)({
      workspaceId: WORKSPACE, actor, projectId: PROJECT, variantId: '9:16',
      format: 'vtt', idempotencyKey: 'idem-vtt-1',
    })

    // The sidecar identity is the file on disk, not a report about it.
    for (const result of [srt, vtt]) {
      const path = join(root, 'artifacts', ...result.sidecar.artifactKey.split('/'))
      const bytes = await readFile(path)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sidecar.sha256)
      assert.equal(bytes.byteLength, result.sidecar.byteSize)
      assert.equal(result.sidecar.outputSha256, rendered.sha256)
      assert.equal(result.sidecar.renderElementMapHash, alignment.renderElementMapHash)
      assert.equal(result.projectVersion.current, true)
      assert.equal(result.replayed, false)

      const parsed = parseSubtitleSidecar(bytes, result.sidecar.format)
      assert.equal(parsed.length, 2)
      assert.equal(parsed[0].text, 'Ação e\nclareza')
      assert.equal(parsed[1].text, 'Última cue.')
      assert.deepEqual(
        [parsed[0].startMs, parsed[0].endMs, parsed[1].startMs, parsed[1].endMs],
        [0, 1200, 1500, 2500],
      )
      assert.equal(result.sidecar.cueCount, 2)
    }
    // SRT bytes carry CRLF explicitly; VTT bytes never carry a CR.
    const srtBytes = await readFile(join(root, 'artifacts', ...srt.sidecar.artifactKey.split('/')))
    const vttBytes = await readFile(join(root, 'artifacts', ...vtt.sidecar.artifactKey.split('/')))
    assert.ok(srtBytes.includes(Buffer.from('\r\n')))
    assert.ok(!vttBytes.includes(Buffer.from('\r')))
    assert.notEqual(srt.sidecar.sha256, vtt.sidecar.sha256)

    // Lineage reaches the manifest of a real artifact.
    const sidecarArtifact = await context.artifacts.findById(WORKSPACE, srt.sidecar.artifactId)
    assert.equal(sidecarArtifact.container, 'srt')
    assert.equal(sidecarArtifact.mediaType, 'data')
    assert.equal(sidecarArtifact.manifests[0].recipe.id, 'subtitle-sidecar')
    assert.equal(sidecarArtifact.manifests[0].sources[0].sha256, rendered.sha256)
    assert.equal(sidecarArtifact.manifests[0].sources[0].artifactKey, storedOutput.key)

    const listed = await listProjectSubtitleSidecarsService({ sidecars: context.sidecars })({
      workspaceId: WORKSPACE, actor, projectId: PROJECT,
    })
    assert.equal(listed.sidecars.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-175 reconstruction is byte-identical, replay does not duplicate, tamper fails closed', {
  timeout: 10 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-sidecar-invariants-'))
  try {
    const rendered = await renderFixture(root, { operationId: 'sidecar-invariants' })
    const storage = new LocalMediaUploadStorage(join(root, 'artifacts'))
    const storedOutput = await storage.promoteDerived({
      workspaceId: WORKSPACE, sourcePath: rendered.outputPath, sha256: rendered.sha256,
      extension: 'mp4', prefix: 'editorial-proxies',
    })
    const alignment = alignmentOf(rendered, storedOutput)
    const alignments = new Map([[`${VERSION_CURRENT}:9:16`, alignment]])
    const context = await harness(root, { alignments })
    seedRenderedOutput(context.artifacts, alignment, storedOutput)
    const run = (overrides) => exportProjectSubtitleSidecarService(context.dependencies)({
      workspaceId: WORKSPACE, actor, projectId: PROJECT, variantId: '9:16',
      format: 'srt', ...overrides,
    })

    const first = await run({ idempotencyKey: 'idem-1' })
    // A second request with another key re-derives from the same persisted state
    // and must land on the very same immutable artifact.
    const rederived = await run({ idempotencyKey: 'idem-2' })
    assert.equal(rederived.sidecar.sha256, first.sidecar.sha256)
    assert.equal(rederived.sidecar.artifactId, first.sidecar.artifactId)
    assert.equal(rederived.sidecar.id, first.sidecar.id)
    assert.equal(rederived.replayed, true)
    // Replaying the original key returns the same record without a second row.
    const replay = await run({ idempotencyKey: 'idem-1' })
    assert.equal(replay.replayed, true)
    assert.equal(context.sidecars.rows.length, 1)

    // Tamper 1: the stored map hash no longer describes the stored elements.
    const tamperedHash = { ...alignment, renderElementMapHash: 'f'.repeat(64) }
    alignments.set(`${VERSION_CURRENT}:9:16`, tamperedHash)
    await assert.rejects(
      () => run({ idempotencyKey: 'idem-tamper-1' }),
      (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    )

    // Tamper 2: a cue was widened in the map after the render.
    const widened = {
      ...alignment,
      map: {
        ...alignment.map,
        elements: alignment.map.elements.filter((element) =>
          !(element.elementId === 'subtitle:cue-2' && element.frame === 74)),
      },
    }
    alignments.set(`${VERSION_CURRENT}:9:16`, widened)
    await assert.rejects(
      () => run({ idempotencyKey: 'idem-tamper-2' }),
      (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    )

    // Tamper 3: the manifest lost the RenderInput that proves the render.
    alignments.set(`${VERSION_CURRENT}:9:16`, { ...alignment, renderInputHash: 'a'.repeat(64) })
    await assert.rejects(
      () => run({ idempotencyKey: 'idem-tamper-3' }),
      (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    )

    // Tamper 4: the cue text of the snapshot no longer covers a rendered cue.
    alignments.set(`${VERSION_CURRENT}:9:16`, {
      ...alignment,
      cueTexts: { 'cue-1': 'Ação e\nclareza' },
    })
    await assert.rejects(
      () => run({ idempotencyKey: 'idem-tamper-4' }),
      (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    )

    assert.equal(context.sidecars.rows.length, 1, 'no tampered attempt may persist a sidecar')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-175 a historical version yields its own sidecar and is reported as not current', {
  timeout: 10 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-sidecar-stale-'))
  try {
    const current = await renderFixture(root, { operationId: 'sidecar-current' })
    const historicalCues = [
      { id: 'cue-1', startFrame: 0, endFrame: 30, text: 'Ação antiga', anchor: 'bottom' },
      { id: 'cue-2', startFrame: 45, endFrame: 75, text: 'Última cue.', anchor: 'bottom' },
    ]
    const historical = await renderFixture(root, {
      operationId: 'sidecar-historical', cues: historicalCues,
    })
    const storage = new LocalMediaUploadStorage(join(root, 'artifacts'))
    const storedCurrent = await storage.promoteDerived({
      workspaceId: WORKSPACE, sourcePath: current.outputPath, sha256: current.sha256,
      extension: 'mp4', prefix: 'editorial-proxies',
    })
    const storedHistorical = await storage.promoteDerived({
      workspaceId: WORKSPACE, sourcePath: historical.outputPath, sha256: historical.sha256,
      extension: 'mp4', prefix: 'editorial-proxies',
    })
    const currentAlignment = alignmentOf(current, storedCurrent)
    const historicalAlignment = alignmentOf(historical, storedHistorical, {
      projectVersionId: VERSION_OLD,
      projectVersionSequence: 4,
      isCurrentVersion: false,
      outputArtifactId: 'artifact-sidecar-proxy-old',
      outputManifestId: 'manifest-sidecar-proxy-old',
      outputArtifactKey: storedHistorical.key,
      outputSha256: historical.sha256,
      renderInputHash: '9'.repeat(64),
      editPlanSnapshotId: 'snapshot-editplan-4',
      renderElementMapHash: renderElementMapHash(historical.renderElementMap),
      map: historical.renderElementMap,
      cueTexts: Object.fromEntries(historicalCues.map((cue) => [cue.id, cue.text])),
    })
    const alignments = new Map([
      [`${VERSION_CURRENT}:9:16`, currentAlignment],
      [`${VERSION_OLD}:9:16`, historicalAlignment],
    ])
    const context = await harness(root, { alignments })
    seedRenderedOutput(context.artifacts, currentAlignment, storedCurrent)
    seedRenderedOutput(context.artifacts, historicalAlignment, storedHistorical)

    const head = await exportProjectSubtitleSidecarService(context.dependencies)({
      workspaceId: WORKSPACE, actor, projectId: PROJECT, variantId: '9:16',
      format: 'srt', idempotencyKey: 'idem-head',
    })
    const old = await exportProjectSubtitleSidecarService(context.dependencies)({
      workspaceId: WORKSPACE, actor, projectId: PROJECT, variantId: '9:16',
      format: 'srt', projectVersionId: VERSION_OLD, idempotencyKey: 'idem-old',
    })

    assert.equal(head.projectVersion.current, true)
    assert.equal(old.projectVersion.current, false)
    assert.equal(old.projectVersion.id, VERSION_OLD)
    assert.notEqual(old.sidecar.sha256, head.sidecar.sha256)
    assert.notEqual(old.sidecar.artifactId, head.sidecar.artifactId)
    assert.notEqual(old.sidecar.lineageHash, head.sidecar.lineageHash)

    const oldBytes = await readFile(join(root, 'artifacts', ...old.sidecar.artifactKey.split('/')))
    assert.equal(parseSubtitleSidecar(oldBytes, 'srt')[0].text, 'Ação antiga')
    assert.equal(parseSubtitleSidecar(oldBytes, 'srt')[0].endMs, 1000)

    const scoped = await listProjectSubtitleSidecarsService({ sidecars: context.sidecars })({
      workspaceId: WORKSPACE, actor, projectId: PROJECT, projectVersionId: VERSION_OLD,
    })
    assert.equal(scoped.sidecars.length, 1)
    assert.equal(scoped.sidecars[0].projectVersionId, VERSION_OLD)

    // A variant that was never rendered has no alignment to derive from.
    await assert.rejects(
      () => exportProjectSubtitleSidecarService(context.dependencies)({
        workspaceId: WORKSPACE, actor, projectId: PROJECT, variantId: '16:9',
        format: 'srt', idempotencyKey: 'idem-missing',
      }),
      (error) => error.code === 'RENDER_ELEMENT_MAP_NOT_FOUND',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-175 the sidecar is downloaded through the existing media download grant', {
  timeout: 10 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-sidecar-download-'))
  try {
    const rendered = await renderFixture(root, { operationId: 'sidecar-download' })
    const storage = new LocalMediaUploadStorage(join(root, 'artifacts'))
    const storedOutput = await storage.promoteDerived({
      workspaceId: WORKSPACE, sourcePath: rendered.outputPath, sha256: rendered.sha256,
      extension: 'mp4', prefix: 'editorial-proxies',
    })
    const alignment = alignmentOf(rendered, storedOutput)
    const context = await harness(root, {
      alignments: new Map([[`${VERSION_CURRENT}:9:16`, alignment]]),
    })
    seedRenderedOutput(context.artifacts, alignment, storedOutput)
    const exported = await exportProjectSubtitleSidecarService(context.dependencies)({
      workspaceId: WORKSPACE, actor, projectId: PROJECT, variantId: '9:16',
      format: 'vtt', idempotencyKey: 'idem-download',
    })

    const grants = inMemoryGrants()
    const signer = new HmacMediaDownloadGrantSigner({
      baseUrl: 'https://api.example.test', secret: 's'.repeat(48),
    })
    const issue = issueMediaDownloadGrantService({
      artifacts: context.artifacts, grants, signer,
    })
    const issued = await issue({
      workspaceId: WORKSPACE, actor, artifactId: exported.sidecar.artifactId,
      idempotencyKey: 'sidecar-download-grant-1',
    })
    assert.equal(issued.grant.artifactId, exported.sidecar.artifactId)
    const replayed = await issue({
      workspaceId: WORKSPACE, actor, artifactId: exported.sidecar.artifactId,
      idempotencyKey: 'sidecar-download-grant-1',
    })
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.grant.id, issued.grant.id)

    const token = new URL(issued.downloadUrl).searchParams.get('token')
    const authorized = await authorizeMediaDownloadGrantService({ grants })({
      workspaceId: WORKSPACE, clientId: actor.clientId,
      grantId: issued.grant.id, token,
    })
    assert.equal(authorized.artifactId, exported.sidecar.artifactId)

    const record = await context.artifacts.findById(WORKSPACE, authorized.artifactId)
    const bytes = await readFile(join(root, 'artifacts', ...record.artifactKey.split('/')))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256)
    assert.equal(record.sha256, exported.sidecar.sha256)
    assert.equal(bytes.byteLength, exported.sidecar.byteSize)
    assert.equal(parseSubtitleSidecar(bytes, 'vtt')[1].text, 'Última cue.')

    await assert.rejects(
      () => authorizeMediaDownloadGrantService({ grants })({
        workspaceId: WORKSPACE, clientId: actor.clientId,
        grantId: issued.grant.id, token: 'not-the-token',
      }),
      (error) => error.code === 'MEDIA_DOWNLOAD_GRANT_REJECTED',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Referenced so the unused-import guard cannot hide a broken manifest helper.
assert.equal(typeof createMediaArtifactManifestV2, 'function')

