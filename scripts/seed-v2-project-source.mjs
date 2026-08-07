import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

import { PrismaClient } from '../generated/prisma-v2/index.js'

import { beginMediaUploadService } from '../src/v2/application/begin-media-upload.ts'
import { createExternalAuditContext } from '../src/v2/application/authenticate-api-client.ts'
import { enqueueMediaIngestService } from '../src/v2/application/enqueue-media-ingest.ts'
import { createProjectService } from '../src/v2/application/create-project.ts'
import { issueMediaUploadSessionService } from '../src/v2/application/issue-media-upload-session.ts'
import { completeMediaUploadService } from '../src/v2/application/manage-media-upload.ts'
import { receiveMediaUploadContentService } from '../src/v2/application/receive-media-upload-content.ts'
import { calculateFileSha256 } from '../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { LocalMediaUploadStorage } from '../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { PrismaMediaTransferRepository } from '../src/v2/infrastructure/prisma/media-transfer-repository.ts'
import { PrismaProjectCreationRepository } from '../src/v2/infrastructure/prisma/project-creation-repository.ts'
import { PrismaPublicOperationRepository } from '../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { createMediaUploadSessionSignerFromEnvironment } from '../src/v2/infrastructure/security/media-upload-session-signer.ts'

const DEFAULTS = Object.freeze({
  objective: 'discovery',
  format: '9:16',
  locale: 'pt-BR',
  sourceMime: 'video/mp4',
  waitSeconds: 900,
})

export function readSeedArguments(values) {
  const parsed = new Map()
  const allowed = new Set([
    'seed-id', 'workspace-id', 'client-id', 'credential-id', 'api-environment',
    'project-name', 'source-file',
    'source-mime', 'objective', 'format', 'locale', 'briefing', 'wait-seconds',
  ])
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    }
    if (!allowed.has(key.slice(2))) throw new Error(`${key} is not a supported seed argument`)
    if (parsed.has(key.slice(2))) throw new Error(`${key} was provided more than once`)
    parsed.set(key.slice(2), value)
  }
  const required = (name) => {
    const value = parsed.get(name)?.trim()
    if (!value) throw new Error(`--${name} is required`)
    return value
  }
  const seedId = required('seed-id')
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(seedId)) {
    throw new Error('--seed-id must contain 3-80 letters, digits, dot, underscore or hyphen')
  }
  const sourceMime = parsed.get('source-mime')?.trim().toLowerCase() ?? DEFAULTS.sourceMime
  if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(sourceMime)) {
    throw new Error('--source-mime is not supported for a source seed')
  }
  const waitSeconds = Number(parsed.get('wait-seconds') ?? DEFAULTS.waitSeconds)
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 10 || waitSeconds > 3_600) {
    throw new Error('--wait-seconds must be an integer between 10 and 3600')
  }
  const apiEnvironment = required('api-environment')
  if (!['sandbox', 'production'].includes(apiEnvironment)) {
    throw new Error('--api-environment must be sandbox or production')
  }
  return Object.freeze({
    seedId,
    workspaceId: required('workspace-id'),
    clientId: required('client-id'),
    credentialId: required('credential-id'),
    apiEnvironment,
    projectName: required('project-name'),
    sourceFile: resolve(required('source-file')),
    sourceMime,
    waitSeconds,
    objective: parsed.get('objective')?.trim() || DEFAULTS.objective,
    format: parsed.get('format')?.trim() || DEFAULTS.format,
    locale: parsed.get('locale')?.trim() || DEFAULTS.locale,
    ...(parsed.get('briefing')?.trim() ? { briefing: parsed.get('briefing').trim() } : {}),
  })
}

function contentStream(path, start, end) {
  const stream = createReadStream(path, {
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  })
  return Readable.toWeb(stream)
}

export async function seedV2ProjectSource({
  client,
  arguments: input,
  environment = process.env,
  clock = () => new Date(),
}) {
  const clientRow = await client.v2ApiClient.findFirst({
    where: { id: input.clientId, workspaceId: input.workspaceId, status: 'active' },
    select: {
      id: true,
      status: true,
      apiKillSwitchEngaged: true,
      allowedEnvironmentsJson: true,
      scopeGrantsJson: true,
      workspace: {
        select: { apiAccessStatus: true, apiKillSwitchEngaged: true },
      },
      credentials: {
        where: { id: input.credentialId },
        select: { id: true, status: true, expiresAt: true },
        take: 1,
      },
    },
  })
  if (!clientRow) throw new Error('Active API client was not found in the requested workspace')
  const credential = clientRow.credentials[0]
  if (
    !credential || credential.status !== 'active' ||
    (credential.expiresAt && credential.expiresAt <= clock())
  ) {
    throw new Error('The exact active API credential was not found for the seed actor')
  }
  const environments = JSON.parse(clientRow.allowedEnvironmentsJson)
  const scopes = JSON.parse(clientRow.scopeGrantsJson)
  if (!environments.includes(input.apiEnvironment) || !scopes.includes('projects:write')) {
    throw new Error('The seed actor is not authorized to create projects in this environment')
  }
  const auditContext = createExternalAuditContext({
    clientId: clientRow.id,
    credentialId: credential.id,
    workspaceId: input.workspaceId,
    environment: input.apiEnvironment,
  })
  const actor = Object.freeze({
    ...auditContext,
    scopes: new Set(scopes),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: clientRow.apiKillSwitchEngaged,
    workspaceKillSwitchEngaged: clientRow.workspace.apiKillSwitchEngaged,
    clientAccessStatus: clientRow.status,
    workspaceAccessStatus: clientRow.workspace.apiAccessStatus,
    auditContext,
  })

  const sourceMetadata = await stat(input.sourceFile)
  if (!sourceMetadata.isFile() || sourceMetadata.size < 1) {
    throw new Error('--source-file must point to a non-empty regular file')
  }
  const checksum = await calculateFileSha256(input.sourceFile)
  const storageRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!storageRoot) throw new Error('APOLLO_V2_ARTIFACT_ROOT is required')
  const storage = new LocalMediaUploadStorage(storageRoot)
  const signer = createMediaUploadSessionSignerFromEnvironment(environment)
  const project = await createProjectService({
    repository: new PrismaProjectCreationRepository(client),
    clock,
    createId: (kind) => `${kind}-${randomUUID()}`,
    createEventId: randomUUID,
  })({
    workspaceId: input.workspaceId,
    name: input.projectName,
    objective: input.objective,
    format: input.format,
    locale: input.locale,
    ...(input.briefing ? { briefing: input.briefing } : {}),
    actor,
    idempotency: { clientId: input.clientId, key: `seed-project:${input.seedId}` },
  })

  const transfers = new PrismaMediaTransferRepository(client)
  const begun = await beginMediaUploadService({ repository: transfers, clock })({
    workspaceId: input.workspaceId,
    actor,
    projectId: project.project.id,
    fileName: basename(input.sourceFile),
    rightsConfirmed: true,
    idempotencyKey: `seed-upload:${input.seedId}`,
    kind: 'video',
    size: sourceMetadata.size.toString(),
    mimeType: input.sourceMime,
    checksum,
  })

  let verifiedUpload = begun.upload
  if (verifiedUpload.status !== 'verified') {
    const issued = await issueMediaUploadSessionService({
      repository: transfers,
      signer,
      clock,
    })({ workspaceId: input.workspaceId, actor, uploadId: verifiedUpload.id })
    const receive = receiveMediaUploadContentService({ repository: transfers, storage, clock })
    if (issued.session.mode === 'single') {
      await receive({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        uploadId: verifiedUpload.id,
        mode: 'single',
        maxParts: 1,
        sessionExpiresAt: issued.session.expiresAt,
        mimeType: input.sourceMime,
        expectedSha256: checksum,
        body: contentStream(input.sourceFile),
        contentLength: sourceMetadata.size,
      })
    } else {
      const partSize = Number(issued.session.partSize)
      for (let partNumber = 1; partNumber <= issued.session.maxParts; partNumber += 1) {
        const start = (partNumber - 1) * partSize
        const length = Math.min(partSize, sourceMetadata.size - start)
        await receive({
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          uploadId: verifiedUpload.id,
          mode: 'multipart',
          maxParts: issued.session.maxParts,
          sessionExpiresAt: issued.session.expiresAt,
          partNumber,
          mimeType: input.sourceMime,
          expectedSha256: checksum,
          body: contentStream(input.sourceFile, start, start + length - 1),
          contentLength: length,
        })
      }
    }
    verifiedUpload = (await completeMediaUploadService({
      repository: transfers,
      verifier: storage,
      clock,
    })({ workspaceId: input.workspaceId, actor, uploadId: verifiedUpload.id })).upload
  }

  const operations = new PrismaPublicOperationRepository(client)
  const operation = await enqueueMediaIngestService({
    operations,
    clock,
  })({ upload: verifiedUpload, actor })
  const brief = await client.v2ProjectSnapshot.findUnique({
    where: { id: project.version.snapshotRefs.brief },
    select: { contentJson: true, contentHash: true },
  })
  if (!brief) throw new Error('Persisted project brief snapshot was not found')
  const outputSpec = JSON.parse(brief.contentJson).outputSpec
  const deadline = Date.now() + input.waitSeconds * 1_000
  let completedOperation = operation
  while (!['succeeded', 'failed', 'cancelled'].includes(completedOperation.operation.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`Ingest operation ${operation.operation.id} did not finish within ${input.waitSeconds}s; keep the supervised ingest worker running and rerun with the same --seed-id`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    const persisted = await operations.findById(input.workspaceId, operation.operation.id)
    if (!persisted) throw new Error('Persisted ingest operation was not found')
    completedOperation = persisted
  }
  if (completedOperation.operation.status !== 'succeeded') {
    throw new Error(`Ingest operation ${operation.operation.id} ended as ${completedOperation.operation.status}`)
  }
  const assets = await client.v2ProjectMediaAsset.findMany({
    where: { workspaceId: input.workspaceId, projectId: project.project.id, uploadId: verifiedUpload.id },
    orderBy: { role: 'asc' },
    select: { artifactId: true, role: true },
  })
  const sourceAsset = assets.find((asset) => asset.role === 'source-master')
  const proxyAsset = assets.find((asset) => asset.role === 'editing-proxy')
  if (!sourceAsset || !proxyAsset) throw new Error('Successful ingest did not persist the expected source and proxy assets')
  const sourceFingerprint = createHash('sha256').update(`${sourceMetadata.size}:${checksum}`).digest('hex')
  return Object.freeze({
    workspaceId: input.workspaceId,
    project: { id: project.project.id, versionId: project.version.id, replayed: project.replayed },
    outputSpec: { ...outputSpec, snapshotHash: brief.contentHash },
    source: { uploadId: verifiedUpload.id, artifactId: sourceAsset.artifactId, proxyArtifactId: proxyAsset.artifactId, checksum, byteSize: sourceMetadata.size.toString(), fingerprint: sourceFingerprint },
    ingestOperation: { id: completedOperation.operation.id, status: completedOperation.operation.status, replayed: operation.replayed },
  })
}

export async function main(values = process.argv.slice(2), environment = process.env) {
  const client = new PrismaClient()
  try {
    const result = await seedV2ProjectSource({ client, arguments: readSeedArguments(values), environment })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await client.$disconnect()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
