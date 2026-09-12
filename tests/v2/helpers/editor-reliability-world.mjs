import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  artifactPath,
  sha256Of,
  binaryDigest,
  colorMetadataFromStream,
  createProjectRow,
  createWorkspaceRow,
  drainProxyRenders,
  encodeRecording,
  issueApiClient,
  probeStreams,
} from './capture-journey.mjs'

/**
 * The smallest project the editor can honestly be opened against.
 *
 * Nothing here fabricates a succeeded operation. The proxy is materialised the
 * way the product materialises one: `POST /v1/projects/{id}/proxy-renders`
 * over HTTP against the running server, then the real `--once` render driver
 * (`scripts/run-v2-render-worker-once.mjs`) claims it. Every credential-audit
 * column on the operation is therefore written by the authenticated API call
 * itself, which is the only way those columns can agree with what
 * `hydrateExternalActorAudit` recomputes on the way back out.
 *
 * What is still SEEDED, named out loud because a reader must be able to tell
 * arranged from proved: the source recording's artifact/manifest/probe rows
 * (via `registerRecording`, over numbers MEASURED from the file ffmpeg just
 * wrote) and the compiled base version (`seedBaseProjectVersion`). Both are the
 * repository's own journey plumbing, and neither is the subject of any
 * measurement this suite takes.
 *
 * `.ts` arrives through `await import` at call time, never a static specifier:
 * tsx resolves a static specifier before it transforms the target.
 */

const CLIENT_SCOPES = Object.freeze([
  'projects:read',
  'projects:write',
  'projects:approve',
  'artifacts:read',
])

export async function encodeSharedProxy({ artifactRoot, key, seconds = 3, fps = 30 }) {
  const { resolveFfmpegBinary, resolveFfprobeBinaryPath } = await import(
    '../../../src/v2/infrastructure/media/ffmpeg-binary.ts'
  )
  const ffmpegPath = resolveFfmpegBinary()
  const ffprobePath = resolveFfprobeBinaryPath(undefined, undefined)
  const outputPath = artifactPath(artifactRoot, key)
  await mkdir(dirname(outputPath), { recursive: true })
  const encoded = await encodeRecording({
    ffmpegPath,
    outputPath,
    seconds,
    fps,
    videoInput: `testsrc=size=320x180:rate=${fps}`,
    width: 320,
    height: 180,
  })
  const streams = await probeStreams(ffprobePath, outputPath)
  const video = streams.find((stream) => stream.codec_type === 'video')
  if (!video) throw new Error('the encoded recording carries no video stream')
  return {
    ffmpegPath,
    ffprobePath,
    outputPath,
    key,
    seconds,
    fps,
    sha256: encoded.sha256,
    byteSize: encoded.byteSize,
    producerBinaryDigest: await binaryDigest(ffprobePath),
    colorMetadata: colorMetadataFromStream(video),
    pixelFormat: String(video.pix_fmt),
    probe: {
      width: Number(video.width),
      height: Number(video.height),
      duration: Number(video.duration ?? seconds),
      fps,
      codec: String(video.codec_name),
    },
  }
}

/** Workspace, API client, and the projects with their source recording. */
export async function seedEditorReliabilityWorld({ prisma, artifactRoot, suffix, proxy, projects }) {
  const { registerRecording, seedBaseProjectVersion } = await import('./capture-journey.mjs')

  const workspaceId = `editor-reliability-${suffix}`
  const clientId = `editor-reliability-client-${suffix}`
  const createdAt = new Date('2026-09-11T12:00:00.000Z')

  // Ordered by foreign key, not by taste: versions and snapshots reference the
  // artifacts, so artifacts cannot go first. A swallowed failure here leaves
  // rows behind that the next run then blames on the product, so each failure
  // is collected and reported instead of caught and discarded.
  const CLEANUP_ORDER = [
    'v2ReviewAnnotation',
    'v2RenderElementMap',
    'v2ProxyReview',
    'v2ProjectProxyRenderOperation',
    'v2ProjectFinalExportOperation',
    'v2PublicOperation',
    'v2EditCommand',
    'v2ProjectVersion',
    'v2ProjectSnapshot',
    'v2ProjectMediaAsset',
    'v2MediaArtifactManifest',
    'v2MediaArtifact',
    'v2PublicEventOutbox',
    'v2IdempotencyRecord',
    'v2ProjectCreationCommand',
    'v2UiSession',
    'v2WorkspaceUiPrincipal',
    'v2Project',
    'v2ApiClient',
  ]
  const cleanup = async () => {
    const failures = []
    for (const model of CLEANUP_ORDER) {
      if (!prisma[model]) continue
      try {
        await prisma[model].deleteMany({ where: { workspaceId } })
      } catch (error) {
        failures.push(new Error(`${model}: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    try {
      await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
    } catch (error) {
      failures.push(new Error(`v2Workspace: ${error instanceof Error ? error.message : String(error)}`))
    }
    if (failures.length) throw new AggregateError(failures, `fixture rows survived cleanup in ${workspaceId}`)
  }

  await cleanup()
  await createWorkspaceRow({ prisma, workspaceId, name: 'Editor Reliability Workspace', createdAt })
  const issued = await issueApiClient({
    prisma,
    workspaceId,
    clientId,
    name: 'Editor Reliability Client',
    createdAt,
    scopes: CLIENT_SCOPES,
  })

  const durationFrames = Math.max(1, Math.round(proxy.probe.duration * proxy.fps))
  const created = []
  for (const spec of projects) {
    const projectId = `project-${suffix}-${spec.slug}`
    const versionId = `version-${suffix}-${spec.slug}`
    const artifactId = `artifact-${suffix}-${spec.slug}`
    const key = `editor-reliability/${suffix}/${spec.slug}.mp4`
    const destination = artifactPath(artifactRoot, key)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(proxy.outputPath, destination)

    await createProjectRow({
      prisma,
      workspaceId,
      projectId,
      name: spec.name,
      objective: 'warming',
      format: '16:9',
      clientId,
      createdAt,
    })
    await registerRecording({
      prisma,
      workspaceId,
      projectId,
      artifactId,
      artifactKey: key,
      mediaType: 'video',
      container: 'mp4',
      sha256: proxy.sha256,
      byteSize: proxy.byteSize,
      probe: {
        width: proxy.probe.width,
        height: proxy.probe.height,
        duration: proxy.probe.duration,
        fps: proxy.fps,
      },
      colorMetadata: proxy.colorMetadata,
      pixelFormat: proxy.pixelFormat,
      producerVersion: 'ffprobe-static',
      producerBinaryDigest: proxy.producerBinaryDigest,
      role: 'source-master',
      originalFileName: `${spec.slug}.mp4`,
      createdAt,
      recipeId: 'editor-reliability-ingest',
    })
    await seedBaseProjectVersion({
      prisma,
      workspaceId,
      projectId,
      versionId,
      clientId,
      objective: 'warming',
      sourceArtifactId: artifactId,
      fps: proxy.fps,
      durationFrames,
      transcriptId: `transcript-${suffix}-${spec.slug}`,
      createdAt,
    })

    created.push({
      slug: spec.slug,
      name: spec.name,
      projectId,
      versionId,
      sourceArtifactId: artifactId,
      sourceManifestId: `manifest-${artifactId}`,
      colorMetadata: proxy.colorMetadata,
      sourceKey: key,
      sourcePath: destination,
      durationFrames,
      // Filled in by materialiseProxy, from the operation the product ran.
      proxyArtifactId: null,
      proxyHash: null,
      proxyOperationId: null,
      timeToFirstProxyMs: null,
    })
  }

  return {
    workspaceId,
    clientId,
    issued,
    createdAt,
    projects: created,
    bySlug: (slug) => {
      const found = created.find((entry) => entry.slug === slug)
      if (!found) throw new Error(`no seeded project named ${slug}`)
      return found
    },
    cleanup,
  }
}

/**
 * Enqueue one proxy render through the published route and let the real driver
 * claim it. The operation's audit columns come from this request, not from us.
 */
export async function materialiseProxy({
  prisma,
  baseUrl,
  token,
  workspaceId,
  project,
  workerEnvironment,
  serverLogs = () => '',
}) {
  const startedAt = Date.now()
  // A video render source without an exact colour pipeline compilation is
  // refused by `enqueueProjectProxyRenderService` with INVALID_RENDER_INPUT
  // ("Every video render source requires an exact color pipeline compilation").
  // Compiled here through the published route, over the colorimetry ffprobe
  // measured — not invented, and not written straight into the table.
  const stage = (id, kind, enabled, provider, parameters) => ({
    id,
    kind,
    version: 'v1',
    enabled,
    output: project.colorMetadata,
    implementation: {
      provider,
      version: 'v1',
      parameters,
      parametersHash: sha256Of(Buffer.from(JSON.stringify(parameters))),
    },
  })
  const compiled = await fetch(
    `${baseUrl}/v1/projects/${encodeURIComponent(project.projectId)}/color-pipeline-compilations`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': `${project.projectId}-color-1`,
      },
      body: JSON.stringify({
        sourceArtifactId: project.sourceArtifactId,
        sourceManifestId: project.sourceManifestId,
        outputMetadata: project.colorMetadata,
        stages: [
          stage('technical-rec709', 'technical', true, 'ffmpeg-zscale', { mode: 'identity' }),
          stage('match-source', 'match', false, 'apollo-match', { mode: 'bypass' }),
          stage('creative-none', 'creative-lut', false, 'apollo-lut', { mode: 'none' }),
          stage('output-rec709', 'output', true, 'ffmpeg-zscale', { dither: true }),
        ],
      }),
    },
  )
  if (compiled.status !== 201)
    throw new Error(
      `colour pipeline compilation returned ${compiled.status}: ${(await compiled.text()).slice(0, 400)}\n` +
        `server log tail:\n${serverLogs().slice(-3_000)}`,
    )
  const response = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(project.projectId)}/proxy-renders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `${project.projectId}-proxy-render-1`,
    },
    body: JSON.stringify({}),
  })
  const payload = await response.json()
  if (response.status !== 202)
    // `safeFailure` replaces the message an operator would need with a generic
    // one, so the server's own log tail is the only place the reason survives.
    throw new Error(
      `proxy render enqueue returned ${response.status}: ${JSON.stringify(payload).slice(0, 400)}\n` +
        `server log tail:\n${serverLogs().slice(-3_000)}`,
    )
  const operationId = payload.data.operation.id
  const outcomes = await drainProxyRenders({ prisma, workspaceId, environment: workerEnvironment, expected: 1 })
  if (outcomes.length !== 1 || outcomes[0].operationId !== operationId)
    throw new Error(`the driver claimed ${JSON.stringify(outcomes)} instead of ${operationId}`)
  const detail = await prisma.v2ProjectProxyRenderOperation.findUniqueOrThrow({
    where: { operationId },
    select: { outputArtifactId: true, projectVersionId: true },
  })
  const artifact = await prisma.v2MediaArtifact.findUniqueOrThrow({
    where: { id_workspaceId: { id: detail.outputArtifactId, workspaceId } },
    select: { sha256: true, byteSize: true, artifactKey: true },
  })
  project.proxyArtifactId = detail.outputArtifactId
  project.proxyHash = artifact.sha256
  project.proxyByteSize = Number(artifact.byteSize)
  project.proxyKey = artifact.artifactKey
  project.proxyOperationId = operationId
  project.proxyVersionId = detail.projectVersionId
  project.timeToFirstProxyMs = Date.now() - startedAt
  return project
}

/** The path a page open reduces to: ids replaced by stable tokens. */
export function tokenizePath(pathname, tokens) {
  let result = pathname
  for (const [value, token] of tokens) {
    if (!value) continue
    result = result.split(value).join(token)
    result = result.split(encodeURIComponent(value)).join(token)
  }
  return result.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '/{uuid}')
}

/** Collapse a recorded request list into `METHOD path -> {status: count}`. */
export function summarizeInventory(entries) {
  const byKey = new Map()
  for (const entry of entries) {
    const key = `${entry.method} ${entry.path}`
    const bucket = byKey.get(key) ?? { key, count: 0, statuses: {} }
    bucket.count += 1
    const status = String(entry.status)
    bucket.statuses[status] = (bucket.statuses[status] ?? 0) + 1
    byKey.set(key, bucket)
  }
  return [...byKey.values()].sort(
    (left, right) => right.count - left.count || left.key.localeCompare(right.key),
  )
}
