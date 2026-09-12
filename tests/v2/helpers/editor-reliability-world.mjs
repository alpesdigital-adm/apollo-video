import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  artifactPath,
  createWorkspaceRow,
  encodeRecording,
  issueApiClient,
  probeStreams,
  sha256Of,
} from './capture-journey.mjs'

/**
 * The smallest project the editor can honestly be opened against.
 *
 * What is REAL here: the proxy bytes (ffmpeg encodes them, ffprobe measures
 * them, the sha256 written to `v2MediaArtifact` is the digest of the file the
 * route will serve), the workspace/API client/project rows (created through
 * the published application services), and the render element map (built by
 * the domain factory over the measured fps/duration).
 *
 * What is SEEDED rather than driven, and must be reported as the limit of any
 * measurement taken against it: the proxy render OPERATION. A real
 * `project-proxy-render` would arrive through `POST .../proxy-renders` and the
 * worker loop; this fixture writes the succeeded operation rows the worker
 * would have left behind, exactly as `tests/v2/prisma-review-annotation.
 * integration.mjs` does, so `timeToFirstProxyMs` is NOT measured by anything
 * that uses this fixture.
 *
 * `.ts` arrives through `await import` at call time, never a static specifier:
 * tsx resolves a static specifier before it transforms the target.
 */

const PROXY_SCOPES = Object.freeze([
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
  if (!video) throw new Error('encoded proxy carries no video stream')
  return {
    ffmpegPath,
    ffprobePath,
    outputPath,
    key,
    seconds,
    fps,
    sha256: encoded.sha256,
    byteSize: encoded.byteSize,
    probe: {
      width: Number(video.width),
      height: Number(video.height),
      durationSeconds: Number(video.duration ?? seconds),
      fps,
      codec: String(video.codec_name),
      frames: Number(video.nb_read_frames ?? video.nb_frames ?? 0),
    },
  }
}

/**
 * Seed one workspace + one API client + N projects that share the proxy bytes.
 *
 * Each project gets its own artifact row and its own copy of the file, so a
 * negative written against one project cannot corrupt the other's evidence.
 */
export async function seedEditorReliabilityWorld({
  prisma,
  artifactRoot,
  suffix,
  proxy,
  projects,
}) {
  const { createProjectService } = await import('../../../src/v2/application/create-project.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import(
    '../../../src/v2/application/authenticate-api-client.ts'
  )
  const { PrismaProjectCreationRepository } = await import(
    '../../../src/v2/infrastructure/prisma/project-creation-repository.ts'
  )
  const { PrismaRenderElementMapRepository } = await import(
    '../../../src/v2/infrastructure/prisma/render-element-map-repository.ts'
  )
  const { buildRenderElementMap } = await import('../../../src/v2/domain/review-system.ts')

  const workspaceId = `editor-reliability-${suffix}`
  const clientId = `editor-reliability-client-${suffix}`
  const createdAt = new Date('2026-09-11T12:00:00.000Z')
  const createdAtIso = createdAt.toISOString()

  const cleanup = async () => {
    for (const model of [
      'v2ReviewAnnotation',
      'v2RenderElementMap',
      'v2ProjectProxyRenderOperation',
      'v2PublicOperation',
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
    ]) {
      if (prisma[model]) await prisma[model].deleteMany({ where: { workspaceId } })
    }
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  await cleanup()
  await createWorkspaceRow({
    prisma,
    workspaceId,
    name: 'Editor Reliability Workspace',
    createdAt,
  })
  const issued = await issueApiClient({
    prisma,
    workspaceId,
    clientId,
    name: 'Editor Reliability Client',
    createdAt,
    scopes: PROXY_SCOPES,
  })
  const auditContext = createExternalAuditContext({
    clientId: issued.client.id,
    credentialId: issued.credential.id,
    workspaceId,
    environment: 'production',
  })
  const actor = Object.freeze({
    ...auditContext,
    scopes: new Set(PROXY_SCOPES),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
  const authenticationAudit = materializeActorAuditContext(actor)

  // Event ids are globally unique, not workspace-scoped: a counter-derived id
  // survives this fixture's cleanup only to collide with the next run.
  let entityCounter = 0
  const created = []
  for (const spec of projects) {
    const result = await createProjectService({
      repository: new PrismaProjectCreationRepository(prisma),
      clock: () => createdAt,
      createId: (kind) => `${kind}-${suffix}-${++entityCounter}`,
      createEventId: () => randomUUID(),
    })({
      workspaceId,
      name: spec.name,
      objective: 'discovery',
      format: '9:16',
      actor,
      idempotency: { clientId, key: `${suffix}-${spec.slug}` },
    })

    const entry = {
      slug: spec.slug,
      name: spec.name,
      projectId: result.project.id,
      versionId: result.version.id,
      artifactId: null,
      manifestId: null,
      proxyHash: null,
      proxyKey: null,
      proxyPath: null,
      byteSize: null,
    }

    if (spec.withProxy !== false) {
      const artifactId = `artifact-${suffix}-${spec.slug}`
      const manifestId = `manifest-${suffix}-${spec.slug}`
      const key = `editor-reliability/${suffix}/${spec.slug}.mp4`
      const destination = artifactPath(artifactRoot, key)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(proxy.outputPath, destination)
      const bytes = await readFile(destination)
      const sha256 = sha256Of(bytes)
      const byteSize = (await stat(destination)).size

      await prisma.v2MediaArtifact.create({
        data: {
          id: artifactId,
          workspaceId,
          artifactKey: key,
          sha256,
          byteSize: BigInt(byteSize),
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
          createdAt,
        },
      })
      await prisma.v2MediaArtifactManifest.create({
        data: {
          id: manifestId,
          workspaceId,
          artifactId,
          schemaVersion: 'media-artifact-manifest/v1',
          manifestHash: sha256Of(Buffer.from(`manifest:${artifactId}:${sha256}`)),
          recipeId: 'review-proxy',
          recipeVersion: 'v1',
          parametersHash: sha256Of(Buffer.from(`parameters:${artifactId}`)),
          manifestJson: JSON.stringify({
            probe: {
              width: proxy.probe.width,
              height: proxy.probe.height,
              duration: proxy.probe.durationSeconds,
              fps: proxy.probe.fps,
            },
          }),
          createdAt,
        },
      })
      await prisma.v2ProjectMediaAsset.create({
        data: {
          id: randomUUID(),
          workspaceId,
          projectId: result.project.id,
          artifactId,
          role: 'editing-proxy',
          originalFileName: `${spec.slug}.mp4`,
          createdAt,
        },
      })
      const operationId = `operation-${suffix}-${spec.slug}`
      await prisma.v2PublicOperation.create({
        data: {
          id: operationId,
          workspaceId,
          projectId: result.project.id,
          clientId: issued.client.id,
          actorCredentialId: authenticationAudit.credentialId,
          actorEnvironment: authenticationAudit.environment,
          actorAuthenticationKind: authenticationAudit.authenticationKind,
          actorContextHash: authenticationAudit.contextHash,
          type: 'project-proxy-render',
          status: 'succeeded',
          phase: 'completed',
          targetType: 'media-artifact',
          targetId: artifactId,
          cancelable: false,
          retryable: false,
          attempt: 1,
          // `public_operations_progress_check` is not decorative: a succeeded
          // project-proxy-render must carry 4/4 'render'. The older fixture in
          // prisma-review-annotation.integration.mjs predates that constraint.
          progressCompleted: 4,
          progressTotal: 4,
          progressUnit: 'render',
          resultJson: JSON.stringify({ artifactId }),
          idempotencyKey: `${suffix}-${spec.slug}-render`,
          requestFingerprint: sha256Of(Buffer.from(`fingerprint:${operationId}`)),
          createdAt,
          updatedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
        },
      })
      await prisma.v2ProjectProxyRenderOperation.create({
        data: {
          operationId,
          workspaceId,
          projectId: result.project.id,
          projectVersionId: result.version.id,
          editPlanSnapshotId: result.version.snapshotRefs.editPlan,
          sourceArtifactId: artifactId,
          sourceManifestId: manifestId,
          colorPipelineBindingsJson: JSON.stringify([]),
          inputHash: sha256Of(Buffer.from(`input:${operationId}`)),
          outputArtifactId: artifactId,
          outputManifestId: manifestId,
          originalFileName: `${spec.slug}.mp4`,
          createdAt,
        },
      })
      const durationFrames = Math.max(1, Math.round(proxy.probe.durationSeconds * proxy.fps))
      const map = buildRenderElementMap({
        proxyHash: sha256,
        fps: proxy.fps,
        durationFrames,
        canvas: { width: 1080, height: 1920 },
        source: { width: proxy.probe.width, height: proxy.probe.height },
        clips: [
          {
            id: `clip-${suffix}-${spec.slug}`,
            sourceArtifactId: artifactId,
            timelineInFrame: 0,
            timelineOutFrame: durationFrames,
          },
        ],
        subtitleCues: [
          {
            id: `cue-${suffix}-${spec.slug}`,
            startFrame: 0,
            endFrame: durationFrames,
            text: 'Legenda de verificacao',
          },
        ],
      })
      await new PrismaRenderElementMapRepository(prisma).persistOrReplay({
        workspaceId,
        projectId: result.project.id,
        projectVersionId: result.version.id,
        proxyArtifactId: artifactId,
        map,
        createdAt: createdAtIso,
      })

      entry.artifactId = artifactId
      entry.manifestId = manifestId
      entry.proxyHash = sha256
      entry.proxyKey = key
      entry.proxyPath = destination
      entry.byteSize = byteSize
      entry.durationFrames = durationFrames
    }

    created.push(entry)
  }

  return {
    workspaceId,
    clientId,
    issued,
    authenticationAudit,
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
  return [...byKey.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

export { join }
