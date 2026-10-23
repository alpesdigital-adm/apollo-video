import { randomUUID } from 'node:crypto'

/**
 * A production batch with one recorded source whose script has four blocks (hook, body, proof, CTA) and its script alignment, written the way the
 * product leaves them. The take library and the compatibility graph are NOT here: the test (or the screen) makes them through the public API.
 * Controlled metadata only: the declared hashes and bytes of the source do not prove a render.
 */
export const COMPAT_LINES = Object.freeze({
  hook: 'Pare agora e descubra o erro que bloqueia suas vendas',
  body: 'O metodo organiza sua mensagem para atrair clientes certos',
  proof: 'Mais de cem profissionais aplicaram o metodo com clareza',
  cta: 'Clique no botao e fale com nossa equipe no WhatsApp',
})

export function libraryEvaluationDimensions(score) {
  return ['completeness', 'performance', 'audio', 'video', 'integrity'].map((dimension) => ({
    dimension, score, evaluatorVersion: 'compat-batch-world/v1', evidenceRefs: [`compat-batch-world-${dimension}`], reasonCodes: [],
  }))
}

export async function seedCompatBatch(prisma, { workspaceId, clientId, credentialId, projectId, batchId, objective, suffix, name = `Lote ${suffix}`, createdAt = new Date('2026-07-28T01:10:00.000Z') }) {
  const { calculateCanonicalHash, stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
  const { createMediaTranscript } = await import('../../../src/v2/domain/media-transcript.ts')
  const { createMediaArtifactManifestV2 } = await import('../../../src/v2/domain/media-artifact.ts')
  const { assetRightsRevision } = await import('../../../src/v2/domain/asset-rights.ts')
  const { setAssetRightsService } = await import('../../../src/v2/application/set-asset-rights.ts')
  const { PrismaAssetRightsRepository } = await import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { createScriptAlignmentRun, importScriptDocument } = await import('../../../src/v2/domain/script-alignment.ts')
  const { createProductionBatch, deriveBatchStatus } = await import('../../../src/v2/domain/production-batch.ts')
  const { productionBatchItemOperationId } = await import('../../../src/v2/domain/batch-item-result.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import('../../../src/v2/application/authenticate-api-client.ts')

  const auditContext = createExternalAuditContext({ clientId, credentialId, workspaceId, environment: 'production' })
  const audit = materializeActorAuditContext(Object.freeze({
    clientId, credentialId, workspaceId, environment: 'production', scopes: new Set(['projects:read', 'projects:write', 'projects:approve']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  }))
  const storedAudit = { actorCredentialId: audit.credentialId, actorEnvironment: audit.environment, actorAuthenticationKind: audit.authenticationKind, actorContextHash: audit.contextHash }
  const artifactId = `compat-world-artifact-${suffix}`
  const manifestId = `compat-world-manifest-${suffix}`
  const transcriptId = `compat-world-transcript-${suffix}`
  const alignmentId = `compat-world-alignment-${suffix}`

  const batch = createProductionBatch({
    id: batchId, workspaceId, projectId, name, objective,
    sourceGroups: [{ id: 'source-group-all', name: 'Gravacao', sourceArtifactIds: [artifactId] }],
    recipes: [{ id: 'recipe-compat', name: 'Receita', sourceGroupIds: ['source-group-all'] }],
    variants: [{ id: 'variant-vertical', name: 'Vertical', outputSpecId: '9:16', locale: 'pt-BR' }],
    budget: { currency: 'USD', maxCostMinorUnits: 1000, reservedCostMinorUnits: 0 },
    itemDefinitions: [{ id: `compat-world-item-${suffix}`, key: 'compat/vertical', sourceGroupId: 'source-group-all', recipeId: 'recipe-compat', variantId: 'variant-vertical' }],
    createdBy: { type: 'api-client', id: clientId },
    createdAt: createdAt.toISOString(),
  })
  await prisma.v2ProductionBatch.create({ data: {
    id: batch.id, workspaceId, projectId, schemaVersion: batch.schemaVersion, policyVersion: batch.policyVersion, name: batch.name, objective: batch.objective,
    aggregateStatus: deriveBatchStatus(batch), revision: batch.revision, sourceGroupsJson: stableSerialize(batch.sourceGroups), recipesJson: stableSerialize(batch.recipes),
    variantsJson: stableSerialize(batch.variants), budgetJson: stableSerialize(batch.budget), maxCostMinorUnits: batch.budget.maxCostMinorUnits,
    reservedCostMinorUnits: batch.budget.reservedCostMinorUnits, itemCount: batch.items.length, definitionHash: batch.definitionHash,
    requestFingerprint: calculateCanonicalHash({ batchId: batch.id }), idempotencyKey: `compat-world-batch-${suffix}`, createdByClientId: clientId,
    ...storedAudit, createdAt, updatedAt: createdAt,
  } })
  await prisma.v2ProductionBatchItem.createMany({ data: batch.items.map((item, sequence) => ({
    id: item.id, operationId: productionBatchItemOperationId({ workspaceId, batchId, itemId: item.id }), workspaceId, batchId, sequence, key: item.key,
    sourceGroupId: item.sourceGroupId, recipeId: item.recipeId, variantId: item.variantId, state: item.state, revision: item.revision, retryCount: item.retryCount,
    errorCode: item.error?.code, errorMessage: item.error?.message, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt), itemHash: item.itemHash,
  })) })
  await prisma.v2ProductionBatchStep.createMany({ data: batch.items.flatMap((item) => item.steps.map((step) => ({
    workspaceId, batchId, itemId: item.id, step: step.step, sequence: step.sequence, state: step.state, attempt: step.attempt, costMinorUnits: step.costMinorUnits,
    cacheHit: step.cacheHit, errorCode: step.error?.code, errorMessage: step.error?.message, stepHash: step.stepHash, updatedAt: new Date(item.updatedAt),
  }))) })

  const spoken = [COMPAT_LINES.hook, COMPAT_LINES.body, COMPAT_LINES.proof, COMPAT_LINES.cta].join(' ')
  const words = spoken.split(/\s+/).map((word, index) => ({ word, start: index * 0.25, end: index * 0.25 + 0.2 }))
  const transcript = createMediaTranscript({
    language: 'pt-BR', text: spoken, words, segments: [{ id: 1, start: 0, end: words.at(-1).end, text: spoken, confidence: 0.98 }],
    provider: 'fixture', model: 'compat-batch-world',
  })
  const artifactKey = `fixtures/${artifactId}.mp4`
  const artifactSha256 = calculateCanonicalHash({ artifactId })
  const manifest = createMediaArtifactManifestV2({
    artifactKey, artifactSha256, byteSize: 1, mediaType: 'video', container: 'mp4',
    recipe: { id: 'fixture.source', version: '1', parameters: { parameters: 'fixture', sourceIndex: 0 } }, sources: [],
    probe: { width: 1080, height: 1920, duration: words.at(-1).end, fps: 30 },
  })
  await prisma.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey, sha256: artifactSha256, byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', createdAt } })
  await prisma.v2MediaArtifactManifest.create({ data: {
    id: manifestId, workspaceId, artifactId, schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id,
    recipeVersion: manifest.recipe.version, parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest), createdAt,
  } })
  await prisma.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId, role: 'source-master', originalFileName: 'gravacao.mp4', createdAt } })
  await prisma.v2MediaTranscript.create({ data: {
    id: transcriptId, workspaceId, projectId, sourceArtifactId: artifactId, sourceManifestId: manifestId, schemaVersion: transcript.schemaVersion,
    language: transcript.language, provider: transcript.provider, model: transcript.model, transcriptHash: transcript.transcriptHash,
    transcriptJson: stableSerialize(transcript), createdAt,
  } })
  await setAssetRightsService({
    repository: new PrismaAssetRightsRepository(prisma), clock: () => createdAt, createId: () => `compat-world-rights-${suffix}`,
  })({
    workspaceId, artifactId, baseRevision: assetRightsRevision(artifactId, 0),
    draft: { status: 'approved', allowedUses: ['rendering', 'editorial-reuse'], prohibitedUses: [], allowedLocales: ['pt-BR'],
      consent: { status: 'approved', allowedUses: ['rendering', 'editorial-reuse'] } },
    actor: { type: 'api-client', id: clientId },
  })
  const alignment = createScriptAlignmentRun({
    id: alignmentId, workspaceId, projectId, batchId,
    document: importScriptDocument({
      title: 'Roteiro', locale: 'pt-BR',
      rawText: ['HOOK 1', 'BODY 2', 'PROOF 3', 'CTA 4'].map((label) => `${label}: ${COMPAT_LINES[label.split(' ')[0].toLowerCase()]}.`).join('\n'),
    }),
    sources: [{ transcriptId, sourceArtifactId: artifactId, transcriptHash: transcript.transcriptHash, language: transcript.language, transcript }],
    createdByClientId: clientId, createdAt: createdAt.toISOString(),
  })
  await prisma.v2ScriptAlignmentRun.create({ data: {
    id: alignment.id, workspaceId, projectId, batchId, schemaVersion: alignment.schemaVersion, algorithmVersion: alignment.algorithmVersion, status: alignment.status,
    revision: alignment.revision, documentHash: alignment.document.documentHash, documentJson: stableSerialize(alignment.document),
    sourceRefsJson: stableSerialize(alignment.sourceRefs), resultJson: stableSerialize(alignment), blockCount: alignment.summary.blockCount,
    reviewRequiredCount: alignment.summary.reviewRequiredCount, extraTakeCount: alignment.summary.extraTakeCount, runHash: alignment.runHash,
    requestFingerprint: calculateCanonicalHash({ alignmentId: alignment.id }), idempotencyKey: `compat-world-alignment-${suffix}`, createdByClientId: clientId,
    ...storedAudit, createdAt, updatedAt: createdAt,
  } })
  return { alignment, artifactId, batch }
}

/** The take library of the alignment, made through the public API the way the screen makes it. */
export async function createTakeLibraryThroughApi({ baseUrl, authorization, batchId, alignment, suffix, fetchImpl = globalThis.fetch }) {
  const candidates = [...new Map(alignment.alignments.flatMap((entry) => [...(entry.selectedCandidate ? [entry.selectedCandidate] : []), ...entry.alternatives])
    .map((candidate) => [candidate.id, candidate])).values()]
  const response = await fetchImpl(`${baseUrl}/v1/batches/${batchId}/take-libraries`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `compat-world-library-${suffix}` },
    body: JSON.stringify({
      alignmentId: alignment.id, expectedAlignmentRunHash: alignment.runHash,
      evaluations: candidates.map((candidate) => ({ sourceKind: 'alignment-candidate', sourceId: candidate.id, expectedSourceHash: candidate.candidateHash, dimensions: libraryEvaluationDimensions(0.94) })),
    }),
  })
  const payload = await response.json()
  if (response.status !== 201) throw new Error(`take library ${response.status}: ${JSON.stringify(payload).slice(0, 600)}`)
  return payload.data.library
}
