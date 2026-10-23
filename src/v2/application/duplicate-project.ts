import { assertDomain, DomainError } from '../domain/errors.ts'
import { createProject, normalizeProjectName } from '../domain/project.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectCreationOutputCommandV2, creationProjectMetadataV2 } from '../domain/project-creation-command.ts'
import { buildCreationOutputVersionBundleV2 } from '../domain/output-version-bundle.ts'
import { createProjectForkSourceV3, forkOwnedIdentitiesV3, createProjectForkKernelV3, createProjectForkDerivationV3,
  materializeForkEditPlanV3, remapForkSnapshotDocumentV3, buildForkRenderablePlanCandidateV3,
  validateProjectForkCallerRequestV3, PROJECT_FORK_COMPILE_POLICY_VERSION } from '../domain/project-fork-derivation.ts'
import { calculateOutputCanonicalHash, serializeOutputCanonicalJson, OUTPUT_CANONICAL_POLICY_VERSION } from '../domain/output-canonical-policy.ts'
import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { ProjectDuplicationRepository, ProjectDuplicationResult } from './ports/project-duplication-repository.ts'
import type { CreationSourceFactsV3 } from './ports/output-version-bundle-repository.ts'

const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
export function duplicateProjectService(dependencies: {
  repository: ProjectDuplicationRepository; clock: () => Date; createEventId: () => string
  createId: (kind: 'project' | 'project-version' | 'project-output-state' | 'project-snapshot' |
    'project-media-asset' | 'project-creation-command' | 'project-fork-derivation' | 'fork-identity' | 'idempotency-record') => string
}) {
  return async (request: {
    workspaceId: string; projectId: string; expectedVersionId: string; expectedVersionHash: string; name?: string;
    actor: AuthenticatedExternalActor; idempotency: Readonly<{clientId: string; key: string; ttlSeconds?: number}>
  }): Promise<Readonly<ProjectDuplicationResult>> => {
    assertDomain(Object.keys(request).every(k => ['workspaceId','projectId','expectedVersionId','expectedVersionHash','name','actor','idempotency'].includes(k)) &&
      Object.keys(request.idempotency).every(k => ['clientId','key','ttlSeconds'].includes(k)), 'INVALID_ARGUMENT', 'Duplication fields are unsupported')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor), workspaceId = request.workspaceId.trim(), projectId = request.projectId.trim(),
      clientId = request.idempotency.clientId.trim(), key = request.idempotency.key.trim(), ttlSeconds = request.idempotency.ttlSeconds ?? 86400
    assertDomain(audit.workspaceId === workspaceId && audit.clientId === clientId, 'AUTH_INVALID', 'Duplication actor scope differs')
    assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(key), 'INVALID_ARGUMENT', 'Idempotency key requires 3-128 portable characters')
    assertDomain(Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 604800, 'INVALID_ARGUMENT', 'Duplication TTL is invalid')
    const callerRequest = validateProjectForkCallerRequestV3({ ...policy, schemaVersion: 'project-duplication-request/v3', workspaceId,
      sourceProjectId: projectId, sourceVersionId: request.expectedVersionId.trim(), sourceVersionHash: request.expectedVersionHash,
      requestedName: request.name === undefined ? null : normalizeProjectName(request.name), actorContextHash: audit.contextHash })
    const requestFingerprint = calculateOutputCanonicalHash(callerRequest)
    const replay = await dependencies.repository.findIdempotent({ workspaceId, clientId, key, audit, requestFingerprint, callerRequest })
    if (replay) return replay
    const source = await dependencies.repository.readSource({ workspaceId, projectId })
    if (!source) throw new DomainError('PROJECT_NOT_FOUND', 'Source project was not found')
    if (source.project.currentVersionId !== callerRequest.sourceVersionId || source.version.id !== callerRequest.sourceVersionId ||
      source.version.baseHash !== callerRequest.sourceVersionHash || source.bundle.version.id !== source.version.id ||
      source.bundle.version.baseHash !== source.version.baseHash) {
      const completed = await dependencies.repository.findIdempotent({workspaceId,clientId,key,audit,requestFingerprint,callerRequest})
      if(completed)return completed
      throw new DomainError('VERSION_CONFLICT', 'Source current Version changed before duplication',
        { currentVersionId: source.version.id, currentVersionHash: source.version.baseHash })
    }
    const createdAtDate = dependencies.clock(), createdAt = createdAtDate.toISOString(), targetProjectId = dependencies.createId('project'),
      targetVersionId = dependencies.createId('project-version'), stateId = dependencies.createId('project-output-state'),
      commandId = dependencies.createId('project-creation-command'), derivationId = dependencies.createId('project-fork-derivation')
    const initial = createProjectForkSourceV3({ bundle: source.bundle, snapshots: source.snapshots, renderablePlanSnapshot: source.renderablePlanSnapshot })
    const identityMap = forkOwnedIdentitiesV3(initial, source.renderablePlanSnapshot).map(member => ({ kind: member.kind, sourceId: member.id,
      targetId: member.kind === 'version' ? targetVersionId : member.kind === 'state' ? stateId : member.kind === 'snapshot'
        ? dependencies.createId('project-snapshot') : member.kind === 'edit-plan' ? 'edit-plan-' + targetVersionId : dependencies.createId('fork-identity') }))
    const identityIndex = new Map(identityMap.map(member => [member.kind + ':' + member.sourceId, member]))
    const mapped = (kind: string, id: string) => {
      const value = identityIndex.get(kind + ':' + id)
      assertDomain(value !== undefined, 'PERSISTENCE_CONFLICT', 'Duplication map member is missing'); return value.targetId
    }
    const references = source.media.map(ref => ({ ...ref, targetLinkId: dependencies.createId('project-media-asset') }))
    const cropDecisions = initial.state.document.overlays.map(overlay => ({ sourceOverlayId: overlay.id,
      sourceOverlayHash: calculateOutputCanonicalHash(overlay), newOverlayId: mapped('overlay',overlay.id),
      newVariantId: mapped('variant',overlay.variantId), newClipId: mapped('clip',overlay.clipId), copiedDocument: overlay.document,
      author: { type: 'api-client' as const, id: audit.clientId, ...(audit.delegatedUserId ? {delegatedUserId:audit.delegatedUserId} : {}) },
      createdAt, geometryStatus: 'requires-target-materialization' as const }))
    const name = callerRequest.requestedName ?? normalizeProjectName(source.projectFacts.name + ' (cópia)')
    const target = { commandId, workspaceId, projectId: targetProjectId, resultVersionId: targetVersionId, stateId,
      parentVersionId: null, sequence: 1, createdBy: audit.clientId, createdAt } as const
    const snapshotKinds = source.snapshots.map(s=>s.kind)
    const compose = (facts: Readonly<CreationSourceFactsV3>) => {
      const current = createProjectForkSourceV3({bundle:facts.bundle,snapshots:facts.snapshots,renderablePlanSnapshot:facts.renderablePlanSnapshot})
      const kernel = createProjectForkKernelV3({ ...policy, schemaVersion: 'project-fork-kernel/v3', id: derivationId,
        callerIntent: {schemaVersion:'project-creation-intent/v2',kind:'fork-with-content',name}, audit, target, source: current,
        sourceRenderablePlanSnapshot: facts.renderablePlanSnapshot, identityMap, cropDecisions, compilePolicyVersion: PROJECT_FORK_COMPILE_POLICY_VERSION })
      const derivation = createProjectForkDerivationV3({ ...policy, schemaVersion:'project-fork-derivation/v3', id:derivationId,kernel,
        kernelCanonicalJson: serializeOutputCanonicalJson(kernel.document), sourceEditPlanSnapshot:facts.editPlanSnapshot,
        sourceReferences:facts.references,sourceProject:facts.project })
      const snapshots = snapshotKinds.map(kind => {
        const original = facts.snapshots.find(s=>s.kind===kind)
        assertDomain(original!==undefined,'PERSISTENCE_CONFLICT','Fork3 refreshed source snapshot kind is missing')
        const document = original.kind === 'edit-plan' ? materializeForkEditPlanV3(derivation) :
          remapForkSnapshotDocumentV3(JSON.parse(original.contentJson),original.kind,current,target,identityMap,facts.renderablePlanSnapshot)
        return createProjectSnapshot({id:mapped('snapshot',original.id),workspaceId,projectId:targetProjectId,kind:original.kind,
          contentSchemaVersion:original.contentSchemaVersion,contentJson:stableSerialize(document),contentHash:calculateCanonicalHash(document),createdAt})
      })
      const candidate = buildForkRenderablePlanCandidateV3(derivation)
      return createProjectCreationOutputCommandV2({ ...policy,id:commandId,workspaceId,projectId:targetProjectId,versionId:targetVersionId,audit,createdAt,
        payload:{...policy,schemaVersion:'project-creation-output-payload/v2',callerIntent:kernel.document.callerIntent,
          allocations:{stateId,snapshotRefs:Object.fromEntries(snapshots.map(s=>[s.kind,s.id])),renderablePlanSnapshotId:candidate?.id??null},snapshots,
          forkDerivation:derivation,renderableCandidate:candidate} })
    }
    const facts: CreationSourceFactsV3 = {schemaVersion:'project-creation-source-facts/v3',project:source.projectFacts,bundle:source.bundle,
      snapshots:source.snapshots,editPlanSnapshot:source.snapshots.find(s=>s.kind==='edit-plan')!,renderablePlanSnapshot:source.renderablePlanSnapshot,references}
    const proposal = compose(facts), bundle = buildCreationOutputVersionBundleV2(proposal), metadata = creationProjectMetadataV2(proposal)
    const project = createProject({id:targetProjectId,workspaceId,name:metadata.name,status:'draft',...(metadata.objective!==null?{objective:metadata.objective}:{}),...(metadata.locale!==null?{locale:metadata.locale}:{}),
      ownerId:audit.clientId,duplicatedFromProjectId:projectId,createdBy:proposal.author,createdAt})
    const idempotency = {id:dependencies.createId('idempotency-record'),workspaceId,clientId,key,requestFingerprint,
      expiresAt:new Date(createdAtDate.getTime()+ttlSeconds*1000).toISOString()}
    const write = {proposal,idempotencyKey:key,idempotencyRecordId:idempotency.id,eventIds:[dependencies.createEventId(),dependencies.createEventId()] as const,
      forkCallerRequest:callerRequest,expiresAt:idempotency.expiresAt,recompose:(fresh:Readonly<import('./ports/output-version-bundle-repository.ts').CreationSourceFactsV2|CreationSourceFactsV3>|null)=>{
        assertDomain(fresh !== null && 'schemaVersion' in fresh && fresh.schemaVersion === 'project-creation-source-facts/v3',
          'PERSISTENCE_CONFLICT','Fork3 writer must provide actual discriminated source3 facts')
        return compose(fresh)
      }}
    return dependencies.repository.duplicateOrReplay({sourceProjectId:projectId,sourceVersionId:source.version.id,sourceVersionHash:source.version.baseHash,
      project,version:bundle.version,bundle,write,snapshots:proposal.payload.snapshots,
      media:references.map(ref=>({id:ref.targetLinkId,artifactId:ref.artifactId,role:ref.role,originalFileName:ref.originalFileName,createdAt})),
      auditCommand:proposal,idempotency})
  }
}
