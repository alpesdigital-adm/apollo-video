import assert from 'node:assert/strict'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  artifactPath,
  sha256Of,
  binaryDigest,
  colorMetadataFromStream,
  createProjectRow,
  createWorkspaceRow,
  encodeRecording,
  issueApiClient,
  probeStreams,
  sweepSamples,
  writePcm,
} from './capture-journey.mjs'

function diagnosticJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
}

async function runRealFactoryOnceWithDiagnostic({ prisma, workspaceId, operationId, environment }) {
  const waiting = await prisma.v2PublicOperation.count({
    where: { workspaceId, type: 'project-proxy-render', status: { in: ['queued', 'running', 'retrying'] } },
  })
  if (waiting !== 1) throw new Error(`the queue was holding ${waiting} proxy renders, not 1`)
  const importedFactory = await import('../../../src/v2/infrastructure/repository-factory.ts')
  const factory = importedFactory.createProjectProxyRenderWorker ? importedFactory : importedFactory.default
  const { disconnectV2PostgresClient } = await import('../../../src/v2/infrastructure/prisma-postgres/client.ts')
  let diagnostic = null
  try {
    const worker = factory.createProjectProxyRenderWorker(
      environment,
      () => new Date(),
      ({ operationId: failedOperationId, error }) => {
        diagnostic = {
          operationId: failedOperationId,
          name: error instanceof Error ? error.name : typeof error,
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null,
          message: error instanceof Error ? error.message : String(error),
          details: typeof error === 'object' && error !== null && 'details' in error ? error.details : null,
          stack: error instanceof Error ? error.stack : null,
          cause: error instanceof Error && error.cause ? String(error.cause) : null,
        }
      },
    )
    const outcome = await worker(`editor-reliability-test-driver:${process.pid}`, { workspaceId, operationId })
    if (outcome?.status !== 'succeeded')
      throw new Error(
        `real worker factory test-driver ended ${diagnosticJson(outcome)}; first failure=${diagnosticJson(diagnostic)}`,
      )
    return [outcome]
  } finally {
    await disconnectV2PostgresClient()
  }
}

/**
 * The smallest project the editor can honestly be opened against.
 *
 * Nothing here fabricates a succeeded operation. The proxy is materialised the
 * way the product materialises one: `POST /v1/projects/{id}/proxy-renders`
 * over HTTP against the running server, then a test driver calls the real
 * worker factory once with failure diagnostics enabled. Every credential-audit
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
  // Cancelling a render that failed is a product action, not a database edit:
  // `POST /v1/operations/{id}/cancel` requires this scope.
  'operations:cancel',
])

export async function encodeSharedProxy({ artifactRoot, key, seconds = 3, fps = 30 }) {
  const { resolveFfmpegBinary, resolveFfprobeBinaryPath } = await import(
    '../../../src/v2/infrastructure/media/ffmpeg-binary.ts'
  )
  const ffmpegPath = resolveFfmpegBinary()
  const ffprobePath = resolveFfprobeBinaryPath(undefined, undefined)
  const outputPath = artifactPath(artifactRoot, key)
  const pcmPath = `${outputPath}.pcm`
  await mkdir(dirname(outputPath), { recursive: true })
  await writePcm(pcmPath, sweepSamples({ seconds }))
  const encoded = await encodeRecording({
    ffmpegPath,
    outputPath,
    seconds,
    fps,
    pcmPath,
    videoInput: `testsrc=size=320x180:rate=${fps}`,
    width: 320,
    height: 180,
  })
  const streams = await probeStreams(ffprobePath, outputPath)
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  if (!video) throw new Error('the encoded recording carries no video stream')
  if (!audio || audio.codec_name !== 'aac') throw new Error('the encoded recording carries no AAC audio stream')
  if (Number(video.nb_read_frames) !== seconds * fps)
    throw new Error(`the encoded recording has ${video.nb_read_frames} frames, expected ${seconds * fps}`)
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
      audioCodec: String(audio.codec_name),
      audioSampleRate: Number(audio.sample_rate),
      decodedFrames: Number(video.nb_read_frames),
    },
  }
}

/** Workspace, API client, and the projects with their source recording. */
export async function seedEditorReliabilityWorld({ prisma, artifactRoot, suffix, proxy, projects }) {
  const { registerRecording, seedBaseProjectVersion } = await import('./capture-journey.mjs')
  const { calculateCanonicalHash, stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
  const { createProductionBrief } = await import('../../../src/v2/domain/production-brief.ts')
  const { assetRightsRevision, createAssetRightsSnapshot } = await import('../../../src/v2/domain/asset-rights.ts')
  const { createAssetRightsChangeIntent } = await import('../../../src/v2/domain/asset-rights-change.ts')
  const { PrismaAssetRightsRepository } = await import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts')

  const workspaceId = `editor-reliability-${suffix}`
  const clientId = `editor-reliability-client-${suffix}`
  const createdAt = new Date()

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
    // Every public table with a workspaceId, swept until a pass deletes nothing.
    // A hand-maintained order cannot keep up with the tables the real routes
    // write (colour pipeline compilations, the LUT selection command, render
    // element maps…), and the one that fell out of date is what left rows
    // behind for the next run to trip over. Foreign keys decide the order: a
    // delete that a child blocks simply retries on the next pass.
    const tables = (
      await prisma.$queryRawUnsafe(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'workspaceId'
          ORDER BY table_name`,
      )
    ).map((row) => row.table_name)
    let remaining = new Set(tables)
    let lastErrors = new Map()
    for (let pass = 0; pass < tables.length + 2 && remaining.size; pass += 1) {
      const stillBlocked = new Set()
      lastErrors = new Map()
      for (const table of remaining) {
        try {
          await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "workspaceId" = $1`, workspaceId)
        } catch (error) {
          stillBlocked.add(table)
          lastErrors.set(table, error instanceof Error ? error.message.split('\n').pop() : String(error))
        }
      }
      if (stillBlocked.size === remaining.size) break
      remaining = stillBlocked
    }
    const failures = [...lastErrors].map(([table, message]) => new Error(`${table}: ${message}`))
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM workspaces WHERE id = $1`, workspaceId)
    } catch (error) {
      failures.push(new Error(`workspaces: ${error instanceof Error ? error.message.split('\n').pop() : String(error)}`))
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `fixture rows survived cleanup in ${workspaceId}: ${failures.map((error) => error.message).join(' | ')}`,
      )
  }

  /** What is still in this workspace — the proof cleanup left nothing. */
  const residue = async () => {
    const tables = (
      await prisma.$queryRawUnsafe(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'workspaceId' ORDER BY table_name`,
      )
    ).map((row) => row.table_name)
    const left = []
    for (const table of tables) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "workspaceId" = $1`,
        workspaceId,
      )
      const count = Number(rows?.[0]?.n ?? 0)
      if (count > 0) left.push({ table, count })
    }
    return { tablesChecked: tables.length, left, clean: left.length === 0 }
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
    // This master is generated by the fixture itself, so its ownership and
    // permitted uses are known rather than inferred. Automatic cataloging of
    // the rendered proxy must inherit this persisted source evidence.
    const rights = createAssetRightsSnapshot({
      id: `rights-${artifactId}`,
      workspaceId,
      artifactId,
      sequence: 1,
      draft: {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedMarkets: ['BRA'],
        allowedLocales: ['pt-BR'],
        consent: { status: 'not-required', allowedUses: [] },
      },
      createdBy: { type: 'api-client', id: clientId },
      createdAt: createdAt.toISOString(),
    })
    await new PrismaAssetRightsRepository(prisma).setCurrent(
      rights,
      assetRightsRevision(artifactId, 0),
      createAssetRightsChangeIntent({
        workspaceId,
        artifactId,
        snapshotHash: rights.snapshotHash,
        baseRevision: assetRightsRevision(artifactId, 0),
        actor: { kind: 'internal', actorType: 'api-client', actorId: clientId },
        changedAt: createdAt.toISOString(),
      }),
    )
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

    // The shared capture helper deliberately seeds only a placeholder brief.
    // The editor workspace is stricter: it hydrates `productionBrief`, so this
    // fixture must carry the same canonical value the product creates.
    const briefContent = {
      schemaVersion: 1,
      productionBrief: createProductionBrief({
        ownerText: 'Público geral. Oferta de boas-vindas. Tom direto e natural.',
      }),
      createdAt: createdAt.toISOString(),
    }
    await prisma.v2ProjectSnapshot.update({
      where: { id: `${projectId}-snapshot-brief` },
      data: {
        schemaVersion: Number(briefContent.schemaVersion),
        contentJson: stableSerialize(briefContent),
        contentHash: calculateCanonicalHash(briefContent),
      },
    })

    // `seedBaseProjectVersion` writes the policies snapshot as `{kind:'policies'}`
    // with row schemaVersion 1. `hydratePolicySnapshot` requires
    // `Number(content.schemaVersion) === row.schemaVersion`, and Number(undefined)
    // is NaN, so every read of that project refuses with PERSISTENCE_CONFLICT
    // ("Stored project policy snapshot identity is invalid"). Rewritten here with
    // the content shape `createProjectService` itself writes (create-project.ts
    // 149-155), hashed with the same function the reader verifies with.
    // capture-journey.mjs is shared with the Wave 18 journey and is not touched;
    // the version's baseHash does not include the policies hash, so it stands.
    const policiesContent = {
      schemaVersion: 1,
      workspaceId,
      state: 'unconfigured',
      brandKitMode: 'inherit',
      guardrails: [],
      createdAt: createdAt.toISOString(),
    }
    await prisma.v2ProjectSnapshot.update({
      where: { id: `${projectId}-snapshot-policies` },
      data: {
        schemaVersion: Number(policiesContent.schemaVersion),
        contentJson: stableSerialize(policiesContent),
        contentHash: calculateCanonicalHash(policiesContent),
      },
    })
    // The shared seeder and the readers use the same canonical hasher. Keep all
    // untouched snapshots byte-for-byte intact and prove their stored identity
    // instead of rewriting evidence that this fixture did not create.
    for (const snapshot of await prisma.v2ProjectSnapshot.findMany({
      where: { workspaceId, projectId },
      select: { id: true, contentJson: true, contentHash: true },
    })) {
      assert.equal(
        snapshot.contentHash,
        calculateCanonicalHash(JSON.parse(snapshot.contentJson)),
        `seeded snapshot ${snapshot.id} is not canonically hashed`,
      )
    }

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
    residue,
  }
}

/**
 * Enqueue one proxy render through the published route and let the test driver
 * of the real factory claim it. Audit columns come from the request, not us.
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
  // The render worker refuses a version with no explicit LUT selection
  // ("ProjectVersion has no explicit LUT selection", thrown by
  // LocalProjectLutRenderMaterializer). Selecting `none` through the published
  // route is the product's own way of making the choice explicit — and that
  // route enqueues the proxy render itself, so this one call is both steps.
  const baseVersion = await prisma.v2ProjectVersion.findFirstOrThrow({
    where: { workspaceId, projectId: project.projectId },
    orderBy: { sequence: 'desc' },
    select: { id: true, baseHash: true },
  })
  project.lutBaseVersionId = baseVersion.id
  project.lutBaseHash = baseVersion.baseHash
  const response = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(project.projectId)}/lut-selection`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `${project.projectId}-lut-1`,
    },
    body: JSON.stringify({
      baseVersionId: baseVersion.id,
      baseHash: baseVersion.baseHash,
      selection: { mode: 'none' },
      reason: 'Editor reliability journey selects no creative LUT.',
    }),
  })
  const payload = await response.json()
  if (![200, 201].includes(response.status) || !payload?.data?.operation)
    // `safeFailure` replaces the message an operator would need with a generic
    // one, so the server's own log tail is the only place the reason survives.
    throw new Error(
      `LUT selection + proxy enqueue returned ${response.status}: ${JSON.stringify(payload).slice(0, 400)}\n` +
        `server log tail:\n${serverLogs().slice(-3_000)}`,
    )
  const operationId = payload.data.operation.id
  const outcomes = await runRealFactoryOnceWithDiagnostic({
    prisma,
    workspaceId,
    operationId,
    environment: workerEnvironment,
  })
  if (outcomes.length !== 1 || outcomes[0].operationId !== operationId)
    throw new Error(`the real factory test-driver claimed ${JSON.stringify(outcomes)} instead of ${operationId}`)
  const detail = await prisma.v2ProjectProxyRenderOperation.findUniqueOrThrow({
    where: { operationId },
    select: { outputArtifactId: true, outputManifestId: true, projectVersionId: true, version: { select: { projectId: true } } },
  })
  const artifact = await prisma.v2MediaArtifact.findUniqueOrThrow({
    where: { id_workspaceId: { id: detail.outputArtifactId, workspaceId } },
    select: { sha256: true, byteSize: true, artifactKey: true },
  })
  project.proxyArtifactId = detail.outputArtifactId
  project.proxyManifestId = detail.outputManifestId
  project.proxyHash = artifact.sha256
  project.proxyByteSize = Number(artifact.byteSize)
  project.proxyKey = artifact.artifactKey
  project.proxyOperationId = operationId
  project.proxyVersionId = detail.projectVersionId
  project.proxyVersionProjectId = detail.version.projectId
  project.proxyManifest = await prisma.v2MediaArtifactManifest.findUniqueOrThrow({
    where: { id_workspaceId: { id: detail.outputManifestId, workspaceId } },
    select: { id: true, artifactId: true, recipeId: true, recipeVersion: true, manifestHash: true },
  })
  project.proxyLineage = await prisma.v2MediaArtifactLineage.findMany({
    where: { workspaceId, manifestId: detail.outputManifestId },
    orderBy: { ordinal: 'asc' },
    select: { sourceArtifactId: true, role: true, ordinal: true },
  })
  project.timeToFirstProxyMs = Date.now() - startedAt
  return project
}

export async function replayProxyEnqueue({ prisma, baseUrl, token, workspaceId, project }) {
  const response = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(project.projectId)}/lut-selection`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `${project.projectId}-lut-1`,
    },
    body: JSON.stringify({
      baseVersionId: project.lutBaseVersionId,
      baseHash: project.lutBaseHash,
      selection: { mode: 'none' },
      reason: 'Editor reliability journey selects no creative LUT.',
    }),
  })
  const payload = await response.json()
  const operations = await prisma.v2ProjectProxyRenderOperation.count({
    where: { workspaceId, projectId: project.projectId },
  })
  return { status: response.status, operationId: payload?.data?.operation?.id ?? null, operations }
}

/**
 * Every row in this workspace that carries credential audit and is missing any
 * of it — i.e. every row `hydrateExternalActorAudit` will refuse on the way out
 * with PERSISTENCE_CONFLICT.
 *
 * Read straight from `information_schema`, so it needs no list of tables to
 * maintain and cannot silently miss one a migration added.
 */
export async function auditCensus({ prisma, workspaceId }) {
  const tables = await prisma.$queryRawUnsafe(
    `SELECT c.table_name,
            EXISTS (SELECT 1 FROM information_schema.columns w
                    WHERE w.table_schema = 'public' AND w.table_name = c.table_name
                      AND w.column_name = 'workspaceId') AS has_workspace,
            EXISTS (SELECT 1 FROM information_schema.columns a
                    WHERE a.table_schema = 'public' AND a.table_name = c.table_name
                      AND a.column_name = 'actorKind') AS has_actor_kind
       FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'actorCredentialId'
      ORDER BY c.table_name`,
  )
  const incomplete = []
  for (const { table_name: table, has_workspace: scoped, has_actor_kind: actorKindScoped } of tables) {
    const where =
      `"actorCredentialId" IS NULL OR "actorContextHash" IS NULL ` +
      `OR "actorEnvironment" IS NULL OR "actorAuthenticationKind" IS NULL`
    const auditScope = actorKindScoped ? `"actorKind" = 'external' AND (${where})` : where
    const sql = scoped
      ? `SELECT count(*)::int AS n FROM "${table}" WHERE ("${'workspaceId'}" = $1) AND (${auditScope})`
      : `SELECT count(*)::int AS n FROM "${table}" WHERE ${auditScope}`
    const rows = scoped
      ? await prisma.$queryRawUnsafe(sql, workspaceId)
      : await prisma.$queryRawUnsafe(sql)
    const count = Number(rows?.[0]?.n ?? 0)
    if (count > 0) incomplete.push({ table, count, workspaceScoped: Boolean(scoped) })
  }
  return {
    tablesWithCredentialAudit: tables.length,
    incomplete,
    clean: incomplete.length === 0,
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
  return [...byKey.values()].sort(
    (left, right) => right.count - left.count || left.key.localeCompare(right.key),
  )
}
