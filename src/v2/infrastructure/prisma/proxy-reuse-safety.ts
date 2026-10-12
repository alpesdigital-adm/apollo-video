import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } from '../../application/ports/editorial-proxy-renderer.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { validateRenderElementMap, renderElementMapHash, type RenderElement, type RenderElementMap } from '../../domain/review-system.ts'

type Database = PrismaClient | Prisma.TransactionClient

/**
 * A conservative cache receipt for the current unknown-face renderer. The recipe
 * and digest identify a declared implementation version, not a binary hash or
 * independently judged pixels. The stored map must attest that no subtitle was
 * drawn. W69 will replace this with a complete materialized pixel receipt.
 */
type ReusableProxyInput = Readonly<{
  workspaceId: string
  projectId: string
  baseVersionId: string
  operationId: string
  artifactId: string
  manifestId: string
}>

async function readReusableProxyReceipt(database: Database, input: ReusableProxyInput, expectedMapId?: string) {
  const [operation, artifact, mapRow] = await Promise.all([
    database.v2ProjectProxyRenderOperation.findFirst({ where: {
      operationId: input.operationId, workspaceId: input.workspaceId,
      projectId: input.projectId, projectVersionId: input.baseVersionId,
      outputArtifactId: input.artifactId, outputManifestId: input.manifestId,
      operation: { status: 'succeeded', phase: 'completed' },
    }, select: { operationId: true } }),
    database.v2MediaArtifact.findFirst({ where: {
      id: input.artifactId, workspaceId: input.workspaceId, status: 'available',
    }, include: { manifests: { where: { id: input.manifestId,
      workspaceId: input.workspaceId, artifactId: input.artifactId }, take: 1 } } }),
    database.v2RenderElementMap.findFirst({ where: {
      ...(expectedMapId === undefined ? {} : { id: expectedMapId }),
      workspaceId: input.workspaceId, projectId: input.projectId,
      projectVersionId: input.baseVersionId, proxyArtifactId: input.artifactId,
    } }),
  ])
  const manifest = artifact?.manifests[0]
  if (!operation || !artifact || !manifest || !mapRow ||
      manifest.workspaceId !== input.workspaceId || manifest.artifactId !== input.artifactId ||
      (expectedMapId !== undefined && mapRow.id !== expectedMapId) ||
      mapRow.workspaceId !== input.workspaceId || mapRow.projectId !== input.projectId ||
      mapRow.projectVersionId !== input.baseVersionId || mapRow.proxyArtifactId !== input.artifactId ||
      !Number.isSafeInteger(Number(artifact.byteSize))) return null
  let body: Record<string, unknown>, elements: unknown
  try {
    body = JSON.parse(manifest.manifestJson) as Record<string, unknown>
    elements = JSON.parse(mapRow.elementsJson) as unknown
  } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(elements)) return null
  const artifactBody = body.artifact as Record<string, unknown> | undefined
  const recipe = body.recipe as Record<string, unknown> | undefined
  const sources = body.sources
  const { manifestHash, ...content } = body
  const declaredRendererDigest = createHash('sha256')
    .update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`).digest('hex')
  if (!artifactBody || typeof artifactBody !== 'object' || Array.isArray(artifactBody) ||
      artifactBody.artifactKey !== artifact.artifactKey ||
      artifactBody.sha256 !== artifact.sha256 ||
      artifactBody.byteSize !== Number(artifact.byteSize) ||
      manifest.manifestHash !== manifestHash ||
      calculateCanonicalHash(content) !== manifestHash ||
      !recipe || typeof recipe !== 'object' || Array.isArray(recipe) ||
      recipe.id !== 'editorial-proxy' || recipe.version !== EDITORIAL_PROXY_RECIPE_VERSION ||
      !Array.isArray(sources) || !sources.some((source) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) return false
        const execution = (source as Record<string, unknown>).execution
        if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return false
        const tool = (execution as Record<string, unknown>).tool
        return Boolean(tool && typeof tool === 'object' && !Array.isArray(tool) &&
          (tool as Record<string, unknown>).id === 'ffmpeg' &&
          (tool as Record<string, unknown>).digest === declaredRendererDigest)
      })) return null
  let map: Readonly<RenderElementMap>
  try {
    map = validateRenderElementMap({
      schemaVersion: mapRow.schemaVersion as RenderElementMap['schemaVersion'],
      proxyHash: mapRow.proxyHash, fps: mapRow.fps, durationFrames: mapRow.durationFrames,
      canvas: { width: mapRow.canvasWidth, height: mapRow.canvasHeight },
      elements: elements as RenderElement[],
    }, artifact.sha256)
    if (renderElementMapHash(map) !== mapRow.mapHash ||
        map.elements.some((element) => element.type === 'subtitle')) return null
  } catch { return null }
  return Object.freeze({ proxy: Object.freeze({ operationId: operation.operationId,
    artifactId: artifact.id, manifestId: manifest.id,
    artifactKey: artifact.artifactKey, sha256: artifact.sha256,
    byteSize: Number(artifact.byteSize) }), map: Object.freeze({
      schemaVersion: map.schemaVersion, proxyHash: map.proxyHash, mapHash: mapRow.mapHash,
      fps: map.fps, durationFrames: map.durationFrames,
      canvasWidth: map.canvas.width, canvasHeight: map.canvas.height,
      elementsJson: stableSerialize(map.elements),
    }) })
}

/** Copy admission locks follow publisher order in the same Serializable
 * transaction. A join never determines lock order. */
export async function readSafeReusableProxyReceipt(transaction: Prisma.TransactionClient, input: ReusableProxyInput) {
  const operation = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "public_operations"
    WHERE "id" = ${input.operationId} AND "workspaceId" = ${input.workspaceId} AND "projectId" = ${input.projectId}
      AND "status" = 'succeeded' AND "phase" = 'completed' FOR UPDATE`)
  if (operation.length !== 1) return null
  const detail = await transaction.$queryRaw<{ operationId: string }[]>(Prisma.sql`SELECT "operationId" FROM "project_proxy_render_operations"
    WHERE "operationId" = ${input.operationId} AND "workspaceId" = ${input.workspaceId} AND "projectId" = ${input.projectId}
      AND "projectVersionId" = ${input.baseVersionId} AND "outputArtifactId" = ${input.artifactId}
      AND "outputManifestId" = ${input.manifestId} FOR UPDATE`)
  if (detail.length !== 1) return null
  const project = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "projects"
    WHERE "id" = ${input.projectId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`)
  if (project.length !== 1) return null
  const artifact = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "media_artifacts"
    WHERE "id" = ${input.artifactId} AND "workspaceId" = ${input.workspaceId} AND "status" = 'available' FOR UPDATE`)
  if (artifact.length !== 1) return null
  const manifest = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "media_artifact_manifests"
    WHERE "id" = ${input.manifestId} AND "workspaceId" = ${input.workspaceId} AND "artifactId" = ${input.artifactId} FOR SHARE`)
  if (manifest.length !== 1) return null
  const map = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "render_element_maps"
    WHERE "workspaceId" = ${input.workspaceId} AND "projectId" = ${input.projectId}
      AND "projectVersionId" = ${input.baseVersionId} AND "proxyArtifactId" = ${input.artifactId} FOR SHARE`)
  if (map.length !== 1) return null
  return readReusableProxyReceipt(transaction, input, map[0]!.id)
}

/** External shape remains unchanged; internal map authority never spills into
 * RenderInput or inputHash through incidental object spread. */
export async function readSafeReusableProxy(database: Database, input: ReusableProxyInput) {
  return (await readReusableProxyReceipt(database, input))?.proxy ?? null
}
