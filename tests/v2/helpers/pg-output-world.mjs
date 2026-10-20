// A project with a sealed head Version, for PostgreSQL suites.
//
// A ProjectVersion is born together with its sealed output State, and the database refuses a Version row that is
// not (contracts two and three only). A suite therefore cannot insert project, snapshot and Version rows by hand any
// more. This builds the same world the product builds: the creation Command (root, contract 2) through
// createProjectService and PrismaCreationOutputBundleRepositoryV2, then one explicit output variant (contract 3)
// through createProjectOutputVariantService and PrismaOperationalOutputBundleRepositoryV3. Nothing is written
// around those repositories.
//
// Two rules follow from "sealed":
// - Sealed rows are append-only. Nothing here deletes them, and a suite must not delete them either: every identity
//   is unique to the invocation (`uniqueRun`), and the owner of a disposable schema resets it between runs.
// - The head carries no media. A plan with duration needs observed sources, so a suite that needs a compiled
//   timeline has to ingest (or fork) one; this world is for suites that need a project and a Version to hang rows on.
//
// Pure counterpart: output-world.mjs (the same services on an in-memory repository).
import { randomUUID } from 'node:crypto'

const { compileInitialSourceEditPlan } = await import('../../../src/v2/application/apply-editorial-cut-command.ts')
const { createExternalAuditContext, materializeActorAuditContext } = await import('../../../src/v2/application/authenticate-api-client.ts')
const { createProjectService, createProjectOutputVariantService } = await import('../../../src/v2/application/create-project.ts')
const { assetRightsRevision, createAssetRightsSnapshot } = await import('../../../src/v2/domain/asset-rights.ts')
const { createAssetRightsChangeIntent } = await import('../../../src/v2/domain/asset-rights-change.ts')
const { calculateCanonicalHash, stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createMediaTranscript } = await import('../../../src/v2/domain/media-transcript.ts')
const { serializeOutputCanonicalJson } = await import('../../../src/v2/domain/output-canonical-policy.ts')
const { advancePublicOperationPhase, createQueuedPublicOperation, startPublicOperationAttempt, succeedPublicOperation } = await import('../../../src/v2/domain/public-operation.ts')
const { externalActorAuditData } = await import('../../../src/v2/infrastructure/prisma/external-actor-audit.ts')
const { PrismaMediaArtifactRepository } = await import('../../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
const { readAdoptableObservationsV3 } = await import('../../../src/v2/infrastructure/prisma/output-adoptable-observations.ts')
const { readPersistedOperationalOutputBundleV3 } = await import('../../../src/v2/infrastructure/prisma/output-state-consumption.ts')
const { commitProjectVersionWithOutputState, settleDeferredOutputGuards } = await import('../../../src/v2/infrastructure/prisma/project-version-commit.ts')
const { PrismaCreationOutputBundleRepositoryV2, PrismaOperationalOutputBundleRepositoryV3 } = await import('../../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts')
import { controlledAudioNormalization, controlledNormalization, recordingNames } from './operational-editorial-fixture.mjs'
import { recompiledChild, variantBody } from './output-world.mjs'

/** Identities unique to this invocation: `id('project')` is `<prefix>-<run>-project-<n>`. */
export function uniqueRun(prefix) {
  const run = randomUUID().replaceAll('-', '').slice(0, 12)
  let counter = 0
  return Object.freeze({ run, id: (kind) => `${prefix}-${run}-${kind}-${++counter}` })
}

/**
 * The authenticated actor the application services take (the shape `authenticateApiClient` yields), for a PG suite that
 * has no HTTP layer. `ensureWorkspaceActor` creates the workspace and API client rows it names.
 */
export function testActor({ workspaceId, clientId, credentialId = `${clientId}-credential`, environment = 'sandbox', scopes = ['projects:write', 'media:write'] }) {
  const auditContext = createExternalAuditContext({ workspaceId, clientId, credentialId, environment })
  return Object.freeze({ ...auditContext, auditContext, scopes: new Set(scopes), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' })
}

/**
 * The rows a sealed Command's author must have: the workspace and the API client the Command names (the creation
 * Command and every edit Command carry foreign keys to both). Created when missing, never replaced.
 */
export async function ensureWorkspaceActor(client, { workspaceId, actor, createdAt = new Date() }) {
  if (!(await client.v2Workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }))) {
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: workspaceId, createdAt, updatedAt: createdAt } })
  }
  if (!(await client.v2ApiClient.findFirst({ where: { id: actor.clientId, workspaceId }, select: { id: true } }))) {
    await client.v2ApiClient.create({ data: { id: actor.clientId, workspaceId, name: actor.clientId, allowedEnvironmentsJson: JSON.stringify([actor.environment]),
      scopeGrantsJson: JSON.stringify([...actor.scopes]), createdBy: actor.clientId, createdAt } })
  }
}

/**
 * Creates the root and, unless `variant` is false, one explicit output variant on it.
 *
 * `ids` pins identities the suite already names (`{ project: 'my-project' }`); every other kind is allocated from
 * `uniqueRun`. `variant` may carry the output/profile/preset of the variant to create (default: the 16:9 example the
 * public contract publishes). The returned `head` is the variant Version when one was created, else the root.
 */
export async function seedSealedProject(client, {
  workspaceId, actor, prefix = 'world', ids = {}, name = 'Sealed world project', objective = 'discovery',
  locale = 'pt-BR', variant = {}, at = () => new Date(),
}) {
  const allocate = uniqueRun(prefix)
  await ensureWorkspaceActor(client, { workspaceId, actor })
  const createId = (kind) => ids[kind] ?? allocate.id(kind)
  const dependencies = (repository) => ({ repository, clock: at, createId, createEventId: randomUUID })
  const created = await createProjectService(dependencies(new PrismaCreationOutputBundleRepositoryV2(client)))({
    workspaceId, name, objective, locale, actor, idempotencyKey: allocate.id('root-request'),
  })
  const projectId = created.projectAtCreation.id
  const root = created.bundle
  if (variant === false) return Object.freeze({ projectId, root, variant: null, head: root, run: allocate.run, createId })
  const child = await createProjectOutputVariantService(dependencies(new PrismaOperationalOutputBundleRepositoryV3(client)))({
    ...variantBody(), ...variant, workspaceId, projectId, baseVersionId: root.version.id, baseHash: root.version.baseHash,
    actor, idempotencyKey: allocate.id('variant-request'),
  })
  const bundle = child.bundle
  const entry = bundle.state.document.entries.find((item) => item.variantId === bundle.origin.result.command.payload.variantId)
    ?? bundle.state.document.entries.at(-1)
  return Object.freeze({
    projectId, root, variant: bundle, head: bundle, variantId: entry.variantId, run: allocate.run, createId,
  })
}

/** The row of an AssetRightsSnapshot, every column its integrity check reads back (hydrateAssetRights recomputes the seal). */
export function assetRightsRow(snapshot) {
  const list = (value) => (value === undefined ? null : JSON.stringify(value))
  return {
    id: snapshot.id, workspaceId: snapshot.workspaceId, artifactId: snapshot.artifactId, sequence: snapshot.sequence,
    schemaVersion: snapshot.schemaVersion, snapshotHash: snapshot.snapshotHash, owner: snapshot.owner ?? null, license: snapshot.license ?? null,
    status: snapshot.status, allowedUsesJson: JSON.stringify(snapshot.allowedUses), prohibitedUsesJson: JSON.stringify(snapshot.prohibitedUses),
    allowedWorkspaceIdsJson: JSON.stringify(snapshot.allowedWorkspaceIds), allowedMarketsJson: list(snapshot.allowedMarkets),
    allowedLocalesJson: list(snapshot.allowedLocales), allowedSyntheticOperationsJson: list(snapshot.allowedSyntheticOperations),
    expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null, consentStatus: snapshot.consent.status,
    consentAllowedUsesJson: JSON.stringify(snapshot.consent.allowedUses), consentAllowedMarketsJson: list(snapshot.consent.allowedMarkets),
    consentAllowedLocalesJson: list(snapshot.consent.allowedLocales), consentSyntheticOperationsJson: list(snapshot.consent.allowedSyntheticOperations),
    consentExpiresAt: snapshot.consent.expiresAt ? new Date(snapshot.consent.expiresAt) : null,
    consentDocumentArtifactId: snapshot.consent.documentArtifactId ?? null, sourceNote: snapshot.sourceNote ?? null,
    createdByType: snapshot.createdBy.type, createdById: snapshot.createdBy.id, createdAt: new Date(snapshot.createdAt),
  }
}

/**
 * Stores a rights snapshot and makes it the artifact's current one at its sequence (the pointer and the revision), with the audit change
 * that revision names: anything that reads the artifact's rights back with its history (a fork, a duplicate) refuses a revision that has
 * no audit change.
 */
export async function persistCurrentRights(client, snapshot) {
  await client.v2AssetRightsSnapshot.create({ data: assetRightsRow(snapshot) })
  await client.v2MediaArtifact.update({ where: { id: snapshot.artifactId }, data: { currentRightsSnapshotId: snapshot.id, rightsRevision: snapshot.sequence } })
  const change = createAssetRightsChangeIntent({ workspaceId: snapshot.workspaceId, artifactId: snapshot.artifactId, snapshotHash: snapshot.snapshotHash,
    baseRevision: assetRightsRevision(snapshot.artifactId, snapshot.sequence - 1),
    actor: { kind: 'internal', actorType: snapshot.createdBy.type, actorId: snapshot.createdBy.id }, changedAt: snapshot.createdAt })
  await client.v2AssetRightsChange.create({ data: { id: change.id, workspaceId: change.workspaceId, artifactId: change.artifactId, sequence: snapshot.sequence,
    snapshotId: snapshot.id, snapshotHash: change.snapshotHash, baseRevision: change.baseRevision,
    resultRevision: assetRightsRevision(snapshot.artifactId, snapshot.sequence), actorKind: 'internal', actorType: snapshot.createdBy.type,
    actorId: snapshot.createdBy.id, requestFingerprint: change.requestFingerprint, changedAt: new Date(change.changedAt) } })
  return snapshot
}

// ---- recordings and compiled heads ----------------------------------------------------------------------------------
//
// A project whose head carries a timeline needs observed sources: the State of a Version that plays a recording can only be
// sealed over a receipt that recording's ingest persisted (artifact, manifest, project link, succeeded media-ingest
// operation, the sealed normalization receipt and the rights granted to it). `persistRecording` leaves exactly those rows,
// from the same controlled receipt the pure world seals; `commitSealedChild` then commits a real child Command that adopts
// them (project-version-commit.ts: the shared writer, the head moved by compare-and-swap, the deferred guards settled).
//
// Every identity derives from `slug`, so a suite passes slugs that carry its `uniqueRun` id and nothing here deletes.

/** The uses a recording's rights grant by default: those the editing, rendering, analysis and library paths read. */
export const RECORDING_ALLOWED_USES = Object.freeze(['distribution', 'editing', 'editorial-reuse', 'rendering', 'transcription'])
const TRANSACTION_OPTIONS = Object.freeze({ maxWait: 5000, timeout: 60_000 })

/**
 * Persists one recording the way its ingest leaves it. `sourceSha256`, `sourceByteSize` and `sourceKey` name the real file
 * when a worker reads the bytes back; the proxy keeps the controlled facts. `rights.status` is the source's grant
 * (default approved; `source: false` leaves the source without a grant); the proxy is always granted. `persistReceipt: false` builds the receipt without storing anything
 * (for a test that proves an unpersisted receipt cannot be adopted).
 */
export async function persistRecording(client, {
  workspaceId, projectId, actor, slug, createdAt = new Date().toISOString(), durationFrames = 60, nativeFps = 30,
  sourceSha256, sourceByteSize, sourceKey, rights = {}, persistReceipt = true, width, height,
}) {
  const scope = { workspaceId, projectId }
  const names = recordingNames(slug)
  const receipt = controlledNormalization(projectId, scope, { slug, createdAt, nativeFps, durationFrames, sourceSha256, sourceByteSize, sourceKey, ...(width === undefined ? {} : { width, height }) })
  const document = receipt.document
  if (!persistReceipt) return Object.freeze({ slug, names, receipt, sourceRights: null, proxyRights: null })
  const audit = materializeActorAuditContext(actor)
  const artifacts = new PrismaMediaArtifactRepository(client)
  for (const [fact, lineageIds] of [[document.source, []], [document.derivative, [document.source.artifactId]]]) {
    await artifacts.persistOrReplay({ workspaceId, artifactId: fact.artifactId, manifestId: fact.manifestId, lineageIds, manifest: fact.manifest, createdAt })
  }
  for (const [fact, role] of [[document.source, 'source-master'], [document.derivative, 'editing-proxy']]) {
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId: fact.artifactId, role,
      originalFileName: `${slug}-${role}.mp4`, createdAt: new Date(createdAt) } })
  }
  const queued = createQueuedPublicOperation({ ...scope, id: document.operationId, clientId: actor.clientId, type: 'media-ingest',
    target: { type: 'media-artifact', id: document.source.artifactId, manifestId: document.source.manifestId }, createdAt })
  const operation = succeedPublicOperation(advancePublicOperationPhase(startPublicOperationAttempt(queued, createdAt), 'persisting', createdAt), createdAt)
  await client.v2PublicOperation.create({ data: { ...scope, id: operation.id, clientId: actor.clientId, ...externalActorAuditData(audit, workspaceId, actor.clientId),
    type: operation.type, status: operation.status, phase: operation.phase, targetType: operation.target.type, targetId: operation.target.id,
    progressCompleted: operation.progress.completed, progressTotal: operation.progress.total, progressUnit: operation.progress.unit,
    cancelable: operation.cancelable, retryable: operation.retryable, attempt: operation.attempt, maxAttempts: operation.maxAttempts,
    idempotencyKey: `${document.operationId}-key`, requestFingerprint: calculateCanonicalHash({ ingest: slug }),
    resultJson: stableSerialize(operation.result), createdAt: new Date(operation.createdAt), updatedAt: new Date(operation.updatedAt),
    startedAt: new Date(operation.startedAt), completedAt: new Date(operation.completedAt) } })
  await client.v2OutputNormalizationReceipt.create({ data: { id: document.id, workspaceId, projectId, operationId: document.operationId,
    sourceArtifactId: document.source.artifactId, sourceManifestId: document.source.manifestId, sourceManifestHash: document.source.manifest.manifestHash,
    derivativeArtifactId: document.derivative.artifactId, derivativeManifestId: document.derivative.manifestId,
    derivativeManifestHash: document.derivative.manifest.manifestHash, receiptJson: serializeOutputCanonicalJson(document), receiptHash: receipt.receiptHash,
    createdAt: new Date(document.createdAt) } })
  const grant = (artifactId, status, sequence, allowedUses) => persistCurrentRights(client, createAssetRightsSnapshot({
    id: `rights-${artifactId}-${sequence}`, workspaceId, artifactId, sequence,
    draft: { status, allowedUses: status === 'approved' ? allowedUses : [], prohibitedUses: [], sourceNote: `${slug}-${sequence}`, consent: { status: 'not-required', allowedUses: [] } },
    createdBy: { type: 'api-client', id: actor.clientId }, createdAt }))
  const allowedUses = rights.allowedUses ?? RECORDING_ALLOWED_USES
  // `rights.source === false`: the source is left ungranted, for a suite that proves the grant its own ingest stage writes.
  const sourceRights = rights.source === false ? null : await grant(document.source.artifactId, rights.status ?? 'approved', 1, allowedUses)
  const proxyRights = await grant(document.derivative.artifactId, 'approved', 1, allowedUses)
  return Object.freeze({ slug, names, receipt, sourceRights, proxyRights })
}


/**
 * The ingest's receipt for a video recording whose artifact and manifest ALREADY exist (a journey that generated and probed real
 * media registers the rows itself): the controlled normalization takes that manifest verbatim as its source, and this persists
 * what the rest of an ingest leaves behind - the editing proxy (artifact, manifest, link, approved grant), the succeeded
 * media-ingest operation and the receipt row - so a child Command can adopt the recording. The source's own grant stays with the
 * caller (a journey grants rights through the production service).
 */
export async function persistReceiptForExistingVideo(client, {
  workspaceId, projectId, actor, artifactId, createdAt = new Date().toISOString(), nativeFps, durationFrames, width, height, slug: given, derivative,
}) {
  const scope = { workspaceId, projectId }
  const manifestRow = await client.v2MediaArtifactManifest.findFirstOrThrow({ where: { artifactId, workspaceId }, orderBy: { createdAt: 'asc' } })
  const manifest = JSON.parse(manifestRow.manifestJson)
  const fps = nativeFps ?? manifest.probe?.fps ?? 30
  // One source can be ingested into several projects: each ingest has its own operation, proxy and receipt, named by `slug`.
  const slug = given ?? `existing-${artifactId}`
  const receipt = controlledNormalization(projectId, scope, { slug, createdAt, nativeFps: fps,
    durationFrames: durationFrames ?? Math.max(2, Math.round((manifest.probe?.duration ?? 2) * fps)),
    width: width ?? manifest.probe?.width, height: height ?? manifest.probe?.height,
    ...(derivative ? { derivativeKey: derivative.key, derivativeSha256: derivative.sha256, derivativeByteSize: derivative.byteSize } : {}),
    source: { artifactId, manifestId: manifestRow.id, manifest } })
  const document = receipt.document
  const audit = materializeActorAuditContext(actor)
  await new PrismaMediaArtifactRepository(client).persistOrReplay({ workspaceId, artifactId: document.derivative.artifactId,
    manifestId: document.derivative.manifestId, lineageIds: [`lineage-${document.derivative.artifactId}-0`], manifest: document.derivative.manifest, createdAt })
  await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId: document.derivative.artifactId,
    role: 'editing-proxy', originalFileName: `${slug}-proxy.mp4`, createdAt: new Date(createdAt) } })
  const queued = createQueuedPublicOperation({ ...scope, id: document.operationId, clientId: actor.clientId, type: 'media-ingest',
    target: { type: 'media-artifact', id: artifactId, manifestId: manifestRow.id }, createdAt })
  const operation = succeedPublicOperation(advancePublicOperationPhase(startPublicOperationAttempt(queued, createdAt), 'persisting', createdAt), createdAt)
  await client.v2PublicOperation.create({ data: { ...scope, id: operation.id, clientId: actor.clientId, ...externalActorAuditData(audit, workspaceId, actor.clientId),
    type: operation.type, status: operation.status, phase: operation.phase, targetType: operation.target.type, targetId: operation.target.id,
    progressCompleted: operation.progress.completed, progressTotal: operation.progress.total, progressUnit: operation.progress.unit,
    cancelable: operation.cancelable, retryable: operation.retryable, attempt: operation.attempt, maxAttempts: operation.maxAttempts,
    idempotencyKey: `${document.operationId}-key`, requestFingerprint: calculateCanonicalHash({ ingest: slug }),
    resultJson: stableSerialize(operation.result), createdAt: new Date(operation.createdAt), updatedAt: new Date(operation.updatedAt),
    startedAt: new Date(operation.startedAt), completedAt: new Date(operation.completedAt) } })
  await client.v2OutputNormalizationReceipt.create({ data: { id: document.id, workspaceId, projectId, operationId: document.operationId,
    sourceArtifactId: artifactId, sourceManifestId: manifestRow.id, sourceManifestHash: document.source.manifest.manifestHash,
    derivativeArtifactId: document.derivative.artifactId, derivativeManifestId: document.derivative.manifestId,
    derivativeManifestHash: document.derivative.manifest.manifestHash, receiptJson: serializeOutputCanonicalJson(document), receiptHash: receipt.receiptHash,
    createdAt: new Date(document.createdAt) } })
  const proxyRights = await persistCurrentRights(client, createAssetRightsSnapshot({
    id: `rights-${document.derivative.artifactId}-1`, workspaceId, artifactId: document.derivative.artifactId, sequence: 1,
    draft: { status: 'approved', allowedUses: [...RECORDING_ALLOWED_USES], prohibitedUses: [], sourceNote: `${slug}-proxy`, consent: { status: 'not-required', allowedUses: [] } },
    createdBy: { type: 'api-client', id: actor.clientId }, createdAt }))
  return Object.freeze({ slug, receipt, proxyRights, operationId: document.operationId, sourceArtifactId: artifactId, sourceManifestId: manifestRow.id })
}

/**
 * The receipt an audio upload's ingest leaves (kind ffprobe-original-audio, source = derivative) for an audio recording whose
 * artifact and manifest already exist: the succeeded media-ingest operation and the sealed receipt row. Grant rights separately.
 */
export async function persistReceiptForExistingAudio(client, { workspaceId, projectId, actor, artifactId, createdAt = new Date().toISOString(), durationSeconds, channels }) {
  const scope = { workspaceId, projectId }
  const manifestRow = await client.v2MediaArtifactManifest.findFirstOrThrow({ where: { artifactId, workspaceId }, orderBy: { createdAt: 'asc' } })
  const manifest = JSON.parse(manifestRow.manifestJson)
  const slug = `existing-${artifactId}`
  const receipt = controlledAudioNormalization(projectId, scope, { slug, createdAt, channels,
    durationSeconds: durationSeconds ?? manifest.probe?.duration ?? 2, source: { artifactId, manifestId: manifestRow.id, manifest } })
  const document = receipt.document
  const audit = materializeActorAuditContext(actor)
  const queued = createQueuedPublicOperation({ ...scope, id: document.operationId, clientId: actor.clientId, type: 'media-ingest',
    target: { type: 'media-artifact', id: artifactId, manifestId: manifestRow.id }, createdAt })
  const operation = succeedPublicOperation(advancePublicOperationPhase(startPublicOperationAttempt(queued, createdAt), 'persisting', createdAt), createdAt)
  await client.v2PublicOperation.create({ data: { ...scope, id: operation.id, clientId: actor.clientId, ...externalActorAuditData(audit, workspaceId, actor.clientId),
    type: operation.type, status: operation.status, phase: operation.phase, targetType: operation.target.type, targetId: operation.target.id,
    progressCompleted: operation.progress.completed, progressTotal: operation.progress.total, progressUnit: operation.progress.unit,
    cancelable: operation.cancelable, retryable: operation.retryable, attempt: operation.attempt, maxAttempts: operation.maxAttempts,
    idempotencyKey: `${document.operationId}-key`, requestFingerprint: calculateCanonicalHash({ ingest: slug }),
    resultJson: stableSerialize(operation.result), createdAt: new Date(operation.createdAt), updatedAt: new Date(operation.updatedAt),
    startedAt: new Date(operation.startedAt), completedAt: new Date(operation.completedAt) } })
  await client.v2OutputNormalizationReceipt.create({ data: { id: document.id, workspaceId, projectId, operationId: document.operationId,
    sourceArtifactId: artifactId, sourceManifestId: manifestRow.id, sourceManifestHash: document.source.manifest.manifestHash,
    derivativeArtifactId: artifactId, derivativeManifestId: manifestRow.id, derivativeManifestHash: document.source.manifest.manifestHash,
    receiptJson: serializeOutputCanonicalJson(document), receiptHash: receipt.receiptHash, createdAt: new Date(document.createdAt) } })
  return Object.freeze({ slug, receipt, sourceArtifactId: artifactId, sourceManifestId: manifestRow.id })
}

/**
 * Commits a real child Command onto the project's current head and moves the head to it. The Version's EditPlan is
 * `mutatePlan(parentPlan)`; `adopt` lists source artifact ids whose persisted receipts the child adopts (offers read from the
 * database, exactly as the product reads them). `suffix` allocates the Version, Command, State and snapshot ids and must be
 * unique to the invocation. Returns the sealed bundle that is now the head (`moveHead: false` stores the Version and leaves the
 * head where it was, for a suite that moves the head itself, later and under a lock).
 */
export async function commitSealedChild(client, {
  workspaceId, projectId, actor, suffix, mutatePlan = (plan) => plan, createdAt, adopt = [], type = 'apply-review-patch', moveHead = true, versionId, snapshotId,
}) {
  const scope = { workspaceId, projectId }
  const head = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
  const parent = await readPersistedOperationalOutputBundleV3(client, { ...scope, versionId: head.currentVersionId })
  const at = createdAt ?? new Date(Math.max(Date.now(), Date.parse(parent.version.createdAt) + 1000)).toISOString()
  const adoptable = adopt.length ? await readAdoptableObservationsV3(client, { ...scope, sourceArtifactIds: adopt }) : undefined
  const bundle = recompiledChild(parent, actor, mutatePlan, { suffix, type, createdAt: at, ...(versionId ? { versionId } : {}), ...(snapshotId ? { snapshotId } : {}), ...(adoptable === undefined ? {} : { adoptable }) })
  await client.$transaction(async (tx) => {
    await commitProjectVersionWithOutputState(tx, bundle)
    if (moveHead) {
      const moved = await tx.v2Project.updateMany({ where: { id: projectId, workspaceId, currentVersionId: parent.version.id }, data: { currentVersionId: bundle.version.id } })
      if (moved.count !== 1) throw new Error(`the head of ${projectId} moved while ${suffix} was committed`)
    }
    await settleDeferredOutputGuards(tx)
  }, TRANSACTION_OPTIONS)
  return bundle
}

/** A plan that plays each recording whole, one after the other (`clipFrames` overrides a recording's length). */
export function planPlayingRecordings(recordings, { fps = 30, clipFrames = {} } = {}) {
  const transcript = createMediaTranscript({ language: 'pt-BR', text: 'Fonte controlada.', words: [{ word: 'Fonte', start: 0, end: 1 }, { word: 'controlada.', start: 1, end: 2 }],
    segments: [{ id: 0, start: 0, end: 2, text: 'Fonte controlada.' }], provider: 'controlled', model: 'explicit-domain-fixture' })
  return (parentPlan) => {
    const first = recordings[0]
    const base = compileInitialSourceEditPlan({ id: parentPlan.id, projectVersionId: parentPlan.projectVersionId, transcriptId: `transcript-${first.slug}`, transcript,
      sourceArtifactId: first.names.sourceArtifactId, sourceDurationSeconds: 2, fps, createdAt: parentPlan.createdAt })
    let cursor = 0
    const clips = recordings.map((recording) => {
      const frames = clipFrames[recording.slug] ?? recording.receipt.document.sourceProbe.frames.length
      const clip = { id: `clip-${recording.slug}`, sourceArtifactId: recording.names.sourceArtifactId, sourceInFrame: 0, sourceOutFrame: frames,
        timelineInFrame: cursor, timelineOutFrame: cursor + frames, rate: 1 }
      cursor += frames
      return clip
    })
    const ids = recordings.map((recording) => recording.names.sourceArtifactId)
    return { ...JSON.parse(stableSerialize(base)), durationFrames: cursor, videoTracks: [{ ...base.videoTracks[0], clips }], subtitleTracks: [],
      sources: recordings.map((recording) => ({ id: recording.names.sourceArtifactId, artifactId: recording.names.sourceArtifactId, kind: 'video',
        durationSeconds: recording.receipt.document.sourceProbe.frames.length / 30 })), lineageRefs: ids }
  }
}

/**
 * Root, one explicit variant and the recordings in `recordings` (`{ slug, durationFrames?, sourceSha256?, sourceByteSize?,
 * sourceKey?, rights? }`; slugs are made unique to the run), then one child Command that adopts all of them and plays them
 * in order: a project whose head is a compiled timeline over observed, rights-granted sources.
 */
export async function seedIngestedProject(client, { workspaceId, actor, prefix = 'world', ids = {}, recordings = [{ slug: 'source' }], variant, plan, at, ...rest }) {
  const world = await seedSealedProject(client, { workspaceId, actor, prefix, ids, variant, at, ...rest })
  const persisted = []
  for (const spec of recordings) {
    persisted.push(await persistRecording(client, { workspaceId, projectId: world.projectId, actor, ...spec, slug: `${prefix}-${world.run}-${spec.slug}` }))
  }
  const head = await commitSealedChild(client, { workspaceId, projectId: world.projectId, actor, suffix: `${prefix}-${world.run}-ingested`,
    mutatePlan: plan ?? planPlayingRecordings(persisted), adopt: persisted.map((recording) => recording.names.sourceArtifactId) })
  const bySlug = Object.fromEntries(persisted.map((recording, index) => [recordings[index].slug, recording]))
  return Object.freeze({ ...world, head, recordings: bySlug, recordingList: persisted })
}
