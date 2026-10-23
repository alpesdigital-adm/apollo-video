import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createProjectService } from '../../src/v2/application/create-project.ts'
import { applyEditorialCutCommandService } from '../../src/v2/application/apply-editorial-cut-command.ts'
import { duplicateProjectService } from '../../src/v2/application/duplicate-project.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { prepareEditorialSourceFixture } from './helpers/operational-editorial-fixture.mjs'
import { createOutputSpecRevisionBody } from '../../src/v2/domain/output-spec-revision.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { createQueuedPublicOperation,startPublicOperationAttempt,advancePublicOperationPhase } from '../../src/v2/domain/public-operation.ts'
import { validateOutputObservedProbeV3,sealOutputNormalizationV3 } from '../../src/v2/domain/output-materialization.ts'
import { observedAudioFromVideoProbeV3 } from '../../src/v2/infrastructure/media/video-probe.ts'
import { compileInitialSourceEditPlan } from '../../src/v2/application/apply-editorial-cut-command.ts'
import { createProjectSnapshot } from '../../src/v2/domain/project-snapshot.ts'
import { buildOperationalOutputVersionBundleV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { createMediaArtifactManifest } from '../../src/v2/domain/media-artifact.ts'
import { rebindSnapshotContentForDuplicate } from '../../src/v2/domain/project-snapshot-rebind.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createProjectCreationCommand, createProjectCreationOutputCommandV2 } from '../../src/v2/domain/project-creation-command.ts'
import { buildCreationOutputVersionBundleV2 } from '../../src/v2/domain/output-version-bundle.ts'
import { createPublicEvent } from '../../src/v2/domain/public-event.ts'
import { createWorkspace } from '../../src/v2/domain/workspace.ts'
import { PrismaCreationOutputBundleRepositoryV2 } from '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
import { configureIdempotencyWinnerWait } from '../../src/v2/infrastructure/prisma/idempotency-record-persistence.ts'

// The exhaustion tests below count attempts: keep the lost-race budget at three attempts and never sleep (this file's process only).
configureIdempotencyWinnerWait({ delaysMs: [0, 0], async sleep() {} })

class InMemoryProjectCreationRepository {
  constructor(workspaces) {
    this.workspaces = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    this.records = new Map()
    this.events = new Map()
    this.lastBundle = undefined
  }

  async persist(input) {
    const c = input.proposal
    const workspace = this.workspaces.get(c.workspaceId)
    if (!workspace || workspace.status !== 'active') {
      throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
    }

    const identity = [
      c.workspaceId,
      c.author.id,
      input.idempotencyKey,
    ].join(':')
    const existing = this.records.get(identity)

    if (existing) {
      if (existing.fingerprint !== c.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was already used with a different request',
        )
      }
      return { ...existing.result, replayed: true }
    }

    const bundle = buildCreationOutputVersionBundleV2(input.recompose(null))
    const events = ['project.created', 'project.version.created'].map((type, i) => createPublicEvent({
      id: input.eventIds[i], workspaceId: c.workspaceId, type, version: '1.0.0', occurredAt: c.createdAt,
      ...(i === 1 ? { sequence: 1 } : {}), actor: { clientId: c.author.id },
      resource: { type: i === 0 ? 'project' : 'project-version', id: i === 0 ? c.projectId : c.versionId },
      data: { projectId: c.projectId, versionId: c.versionId },
    }))
    this.lastWrite = input
    this.lastBundle = { ...bundle, project: { id: c.projectId }, snapshots: c.payload.snapshots, events, auditCommand: c }
    for (const event of events) {
      if (this.events.has(event.id)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Duplicate public event')
      }
      this.events.set(event.id, event)
    }
    const result = { bundle, replayed: false }
    this.records.set(identity, {
      fingerprint: c.requestFingerprint,
      result,
    })
    return result
  }
}

class InMemoryProjectDuplicationRepository {
  constructor(source) {
    this.source = source
    this.record = undefined
    this.lastBundle = undefined
    this.sourceReads = 0
  }

  async findIdempotent(input) {
    if (!this.record || this.record.key !== input.key) return null
    if (this.record.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was already used with a different duplication request',
      )
    }
    return { ...this.record.result, replayed: true }
  }

  async readSource(input) {
    this.sourceReads += 1
    return input.workspaceId === this.source.project.workspaceId &&
      input.projectId === this.source.project.id
      ? this.source
      : null
  }

  async duplicateOrReplay(bundle) {
    const sealed=buildCreationOutputVersionBundleV2(bundle.write.recompose({schemaVersion:'project-creation-source-facts/v3',
      project:this.source.projectFacts,bundle:this.source.bundle,snapshots:this.source.snapshots,
      editPlanSnapshot:this.source.snapshots.find(s=>s.kind==='edit-plan'),renderablePlanSnapshot:this.source.renderablePlanSnapshot,
      references:this.source.media.map(ref=>({...ref,targetLinkId:bundle.write.proposal.payload.forkDerivation.document.sourceReferences.find(r=>r.sourceLinkId===ref.sourceLinkId).targetLinkId}))}))
    this.lastBundle = {...bundle,bundle:sealed,version:sealed.version,snapshots:sealed.command.payload.snapshots,auditCommand:sealed.command}
    const result = {
      project: bundle.project,
      version: sealed.version,
      bundle: sealed,
      sharedArtifactIds: [...new Set(bundle.media.map((item) => item.artifactId))],
      copiedBytes: 0,
      replayed: false,
    }
    this.record = {
      key: bundle.idempotency.key,
      requestFingerprint: bundle.idempotency.requestFingerprint,
      result,
    }
    return result
  }
}

function createFixture() {
  const workspace = createWorkspace({
    id: 'workspace-1',
    slug: 'alpes-digital',
    name: '  Alpes   Digital ',
    status: 'active',
    createdAt: '2026-07-12T13:00:00.000Z',
  })
  const repository = new InMemoryProjectCreationRepository([workspace])
  const counters = new Map()
  let eventCounter = 0
  const service = createProjectService({
    repository,
    clock: () => new Date('2026-07-12T13:01:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
    createEventId: () => {
      eventCounter += 1
      return `00000000-0000-4000-8000-${String(eventCounter).padStart(12, '0')}`
    },
  })

  return { workspace, repository, service }
}

function actor({
  clientId = 'client-1',
  credentialId = 'credential-1',
  workspaceId = 'workspace-1',
  scopes = ['projects:write'],
} = {}) {
  const auditContext = createExternalAuditContext({
    clientId,
    credentialId,
    workspaceId,
    environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(scopes),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

async function createDuplicationFixture({editorialSource=false}={}) {
  const creation = createFixture()
  const source = await creation.service(request())
  // This repository reads the current Project row, not the immutable creation
  // receipt. No child has been committed in this controlled fixture.
  // Explicit controlled segmentation is part of the source producer input,
  // before compiler/snapshot/State seals. Phrase cuts expand to real segments.
  const editorialTranscript=editorialSource?createMediaTranscript({language:'pt-BR',text:'Fonte controlada.',
    words:[{word:'Fonte',start:0,end:1},{word:'controlada.',start:1,end:2}],
    segments:[{id:0,start:0,end:1,text:'Fonte'},{id:1,start:1,end:2,text:'controlada.'}],
    provider:'controlled',model:'explicit-domain-fixture'}):null
  const prepared=editorialSource?await prepareEditorialSourceFixture(creation,source,{transcript:editorialTranscript}):null
  const currentVersion=prepared?.bundle.version??source.creationVersion
  const currentProject = Object.freeze({ ...source.projectAtCreation, currentVersionId: currentVersion.id })
  const manifest=createMediaArtifactManifest({artifactKey:'controlled/master.mp4',artifactSha256:'a'.repeat(64),byteSize:1000,
    mediaType:'video',container:'mp4',recipe:{id:'direct-upload',version:'1.0.0',parameters:{mimeType:'video/mp4'}}})
  const repository = new InMemoryProjectDuplicationRepository({
    project: currentProject,
    version: currentVersion,
    bundle: prepared?.bundle??source.bundle,
    projectFacts:{id:currentProject.id,workspaceId:currentProject.workspaceId,currentVersionId:currentVersion.id,name:currentProject.name,
      status:'draft',format:null,ownerId:currentProject.ownerId,administrationRevision:1,updatedAt:currentVersion.createdAt,
      objective:currentProject.objective,locale:currentProject.locale ?? null,createdByType:currentProject.createdBy.type,createdById:currentProject.createdBy.id,createdAt:currentProject.createdAt},
    renderablePlanSnapshot:null,
    snapshots: prepared?.bundle.snapshots??creation.repository.lastBundle.snapshots,
    media: prepared?.refs??[{
      artifactId: 'artifact-source-1',
      role: 'source-master',
      originalFileName: 'master.mp4',
      sourceLinkId:'11111111-1111-4111-8111-111111111111',workspaceId:'workspace-1',sourceProjectId:currentProject.id,sourceLinkCreatedAt:currentProject.createdAt,
      artifactKey:manifest.artifact.artifactKey,artifactSha256:manifest.artifact.sha256,artifactByteSize:String(manifest.artifact.byteSize),artifactMediaType:'video',
      artifactContainer:'mp4',artifactLifecycleRevision:1,purpose:'editing',manifestFacts:{id:'manifest-source-1',artifactId:'artifact-source-1',workspaceId:'workspace-1',
        schemaVersion:manifest.schemaVersion,manifestJson:JSON.stringify(manifest),manifestHash:manifest.manifestHash,createdAt:currentProject.createdAt,
        recipeId:manifest.recipe.id,recipeVersion:manifest.recipe.version,parametersHash:manifest.recipe.parametersHash,recipeParametersRef:null,renderInputRef:null,
        renderInputHash:null,recipeParameters:null,renderInput:null},
    }],
  })
  const counters = new Map()
  const service = duplicateProjectService({
    repository,
    clock: () => new Date(editorialSource?'2026-10-14T12:00:03.000Z':'2026-07-12T13:03:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      if(kind==='project-media-asset')return `22222222-2222-4222-8222-${String(next).padStart(12,'0')}`
      return `${kind}-duplicate-${next}`
    },
    createEventId:()=>{const n=(counters.get('event')??0)+1;counters.set('event',n);return `00000000-0000-4000-8000-${String(100+n).padStart(12,'0')}`},
  })
  const duplicateRequest = (overrides = {}) => ({
    workspaceId: 'workspace-1',
    projectId: source.projectAtCreation.id,
    expectedVersionId: currentVersion.id,
    expectedVersionHash: currentVersion.baseHash,
    actor: actor(),
    idempotency: { clientId: 'client-1', key: 'duplicate-project-1' },
    ...overrides,
  })
  assert.equal(repository.source.project.currentVersionId, currentVersion.id)
  assert.equal(duplicateRequest().expectedVersionHash, repository.source.version.baseHash)
  return { repository, service, source: { ...source, project: currentProject, version: currentVersion, bundle:prepared?.bundle??source.bundle }, prepared, duplicateRequest }
}

function request(overrides = {}) {
  const { idempotency, ...fields } = overrides
  return {
    workspaceId: 'workspace-1',
    name: '  Campanha   Julho  ',
    objective: 'discovery',
    briefing: 'alpha beta gamma',
    actor: actor(),
    idempotencyKey: idempotency?.key ?? 'create-project-1',
    ...fields,
  }
}

test('workspace aggregate normalizes stable public fields', () => {
  const { workspace } = createFixture()

  assert.equal(workspace.slug, 'alpes-digital')
  assert.equal(workspace.name, 'Alpes Digital')
  assert.ok(Object.isFrozen(workspace))
})

test('create project persists an initial version and immutable snapshots', async () => {
  const { repository, service } = createFixture()
  const result = await service(request())
  const project = result.projectAtCreation, version = result.creationVersion

  assert.equal(result.replayed, false)
  assert.equal(project.name, 'Campanha Julho')
  assert.equal(project.status, 'draft')
  assert.equal(project.objective, 'discovery')
  assert.equal(project.format, undefined)
  assert.equal(project.locale, undefined, 'no language is assumed when the request states none (ADR-160)')
  assert.equal(project.currentVersionId, undefined)
  assert.equal(version.sequence, 1)
  assert.equal(version.outputContractVersion, 2)
  assert.equal(version.outputStateHash, result.bundle.state.stateHash)
  assert.deepEqual(result.bundle.state.document.entries, [])
  assert.equal(repository.lastBundle.snapshots.length, 3)
  assert.deepEqual(
    repository.lastBundle.snapshots.map((snapshot) => snapshot.kind),
    ['brief', 'edit-plan', 'policies'],
  )
  assert.ok(repository.lastBundle.snapshots.every((snapshot) => snapshot.contentHash.length === 64))
  assert.equal(version.snapshotRefs.brief, repository.lastBundle.snapshots[0].id)
  assert.equal(version.snapshotRefs.editPlan, repository.lastBundle.snapshots[1].id)
  const brief = JSON.parse(repository.lastBundle.snapshots[0].contentJson)
  assert.equal(brief.productionBrief.ownerInput.trust, 'owner-authorized')
  // Creation reads nothing of the briefing: what it covers is answered by the interpretation (revise-editorial-request), so the brief makes no
  // claim about audience, offer or tone until a reading exists.
  assert.deepEqual(brief.productionBrief.summary.coverage, {
    audience: false, offer: false, tone: false,
  })
  assert.deepEqual(brief.productionBrief.assumptions, [])
  assert.equal(brief.editorialRequest, undefined)
  assert.equal(brief.outputSpec, undefined)
  assert.equal(brief.objective, 'discovery')
  assert.deepEqual(
    repository.lastBundle.events.map((event) => event.type),
    ['project.created', 'project.version.created'],
  )
  assert.deepEqual(repository.lastBundle.events[0].actor, {
    clientId: 'client-1',
  })
  assert.deepEqual(repository.lastBundle.events[0].resource, {
    type: 'project',
    id: project.id,
  })
  assert.equal(repository.lastBundle.events[1].sequence, 1)
  assert.equal(repository.lastBundle.events[1].data.projectId, project.id)
  assert.equal(repository.events.size, 2)
  assert.equal(repository.lastBundle.auditCommand.payload.callerIntent.kind, 'initialize-empty')
  assert.equal(repository.lastBundle.auditCommand.audit.clientId, 'client-1')
  assert.equal(repository.lastBundle.auditCommand.audit.credentialId, 'credential-1')
  assert.equal(repository.lastBundle.auditCommand.projectId, project.id)
  assert.equal(repository.lastBundle.auditCommand.versionId, version.id)
  assert.equal(repository.lastBundle.auditCommand.requestFingerprint.length, 64)
  assert.equal(repository.lastBundle.auditCommand.commandHash.length, 64)
})

test('create project persists an unread and an absent briefing as explicit non-generating states', async () => {
  const partialFixture = createFixture()
  await partialFixture.service(request({
    briefing: 'alpha',
  }))
  const partial = JSON.parse(
    partialFixture.repository.lastBundle.snapshots[0].contentJson,
  ).productionBrief
  assert.deepEqual(partial.summary.coverage, {
    audience: false, offer: false, tone: false,
  })
  assert.deepEqual(partial.assumptions, [])
  assert.equal(partial.readyForExpensiveGeneration, false)

  const absentFixture = createFixture()
  const first = await absentFixture.service(request({ briefing: undefined }))
  const replay = await absentFixture.service(request({ briefing: '   ' }))
  const absent = JSON.parse(
    absentFixture.repository.lastBundle.snapshots[0].contentJson,
  ).productionBrief
  assert.equal(absent.ownerInput, undefined)
  assert.deepEqual(absent.assumptions, [
    'briefing-absent', 'audience-not-specified',
    'offer-not-specified', 'tone-not-specified',
  ])
  assert.equal(absent.summary.supplied, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.projectAtCreation.id, first.projectAtCreation.id)
})

test('creation root rejects implicit format and a forged persisted Command without new writes', async () => {
  const { repository, service } = createFixture()
  await assert.rejects(() => service(request({ format: '9:16' })), e => e.code === 'INVALID_ARGUMENT')
  assert.equal(repository.records.size, 0)
  const created = await service(request())
  const forged = structuredClone(created.bundle.command)
  forged.payload.callerIntent.name = 'Forged persisted intent'
  assert.throws(() => buildCreationOutputVersionBundleV2(forged), e => e.code === 'INVALID_COMMAND' || e.code === 'INVALID_PROJECT_VERSION')
  const scopeMismatch = structuredClone(created.bundle.command)
  scopeMismatch.workspaceId = 'workspace-other'
  assert.throws(() => createProjectCreationOutputCommandV2(scopeMismatch), e => e.code === 'AUTH_INVALID' || e.code === 'INVALID_COMMAND')
  assert.equal(repository.records.size, 1)
})

test('create project persists the complete canonical Desired Action without inventing fields', async () => {
  const { repository, service } = createFixture()
  await service(request({
    objective: 'sale',
    desiredAction: {
      destination: { type: 'url', value: ' https://checkout.example/oferta ' },
      verbalCta: ' Compre agora ',
      visualCta: ' Ver oferta ',
      disclosures: ['Condições no site'],
    },
    idempotency: { clientId: 'client-1', key: 'create-project-sale' },
  }))
  const brief = JSON.parse(repository.lastBundle.snapshots.find(
    (snapshot) => snapshot.kind === 'brief',
  ).contentJson)
  assert.deepEqual(brief.desiredAction, {
    schemaVersion: 1,
    kind: 'buy',
    destination: { type: 'url', value: 'https://checkout.example/oferta' },
    verbalCta: 'Compre agora',
    visualCta: 'Ver oferta',
    disclosures: ['Condições no site'],
  })
  await assert.rejects(
    () => service(request({
      objective: 'sale',
      idempotency: { clientId: 'client-1', key: 'create-project-sale-missing' },
    })),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('same idempotency key and payload replays the original result', async () => {
  const { repository, service } = createFixture()
  const first = await service(request())
  const replay = await service(request())

  assert.equal(replay.replayed, true)
  assert.equal(replay.projectAtCreation.id, first.projectAtCreation.id)
  assert.equal(replay.creationVersion.id, first.creationVersion.id)
  assert.equal(repository.events.size, 2)
})

test('same idempotency key with a different payload is rejected', async () => {
  const { service } = createFixture()
  await service(request())

  await assert.rejects(
    () => service(request({ name: 'Outra campanha' })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('same client and idempotency key cannot replay through a different credential', async () => {
  const { service } = createFixture()
  await service(request())

  await assert.rejects(
    () => service(request({ actor: actor({ credentialId: 'credential-2' }) })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('project creation command hashes create and duplicate lineage without accepting partial sources', async () => {
  const { repository, service } = createFixture()
  await service(request())
  const audit = repository.lastBundle.auditCommand.audit
  const duplicate = createProjectCreationCommand({
    id: 'project-creation-command-duplicate-1',
    workspaceId: 'workspace-1',
    action: 'duplicate',
    projectId: 'project-duplicate-1',
    versionId: 'project-version-duplicate-1',
    sourceProjectId: repository.lastBundle.project.id,
    sourceVersionId: repository.lastBundle.version.id,
    audit,
    requestFingerprint: 'a'.repeat(64),
    createdAt: '2026-07-12T13:02:00.000Z',
  })
  const changedSource = createProjectCreationCommand({
    ...duplicate,
    sourceVersionId: 'project-version-source-changed',
  })

  assert.ok(Object.isFrozen(duplicate))
  assert.equal(duplicate.action, 'duplicate')
  assert.notEqual(duplicate.commandHash, changedSource.commandHash)
  assert.throws(
    () => createProjectCreationCommand({
      ...duplicate,
      sourceVersionId: undefined,
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => createProjectCreationCommand({
      ...duplicate,
      workspaceId: 'workspace-other',
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('project duplication persists actor-bound copy-on-write lineage without copying bytes', async () => {
  const { repository, service, source, duplicateRequest } = await createDuplicationFixture()
  const result = await service(duplicateRequest({ name: 'Cópia segura' }))

  assert.equal(result.replayed, false)
  assert.equal(result.project.name, 'Cópia segura')
  assert.equal(result.project.duplicatedFromProjectId, source.project.id)
  assert.equal(result.version.forkedFromProjectId, source.project.id)
  assert.equal(result.version.forkedFromVersionId, source.version.id)
  assert.notDeepEqual(result.version.snapshotRefs, source.version.snapshotRefs)
  assert.equal(repository.lastBundle.snapshots.length, 3)
  // Content-addressed kinds keep their hash; the EditPlan is rebound to the copy version
  // (see the dedicated rebinding test), so only its hash may differ.
  for (const copy of repository.lastBundle.snapshots) {
    const original = repository.source.snapshots.find((item) => item.kind === copy.kind)
    assert.equal(copy.contentHash === original.contentHash, copy.kind !== 'edit-plan', copy.kind)
  }
  assert.equal(repository.lastBundle.snapshots.every((snapshot) =>
    snapshot.projectId === result.project.id), true)
  assert.deepEqual(result.sharedArtifactIds, ['artifact-source-1'])
  assert.equal(result.copiedBytes, 0)
  assert.equal(repository.lastBundle.auditCommand.payload.callerIntent.kind, 'fork-with-content')
  assert.equal(repository.lastBundle.auditCommand.payload.forkDerivation.document.kernel.document.source.version.projectId, source.project.id)
  assert.equal(repository.lastBundle.auditCommand.payload.forkDerivation.document.kernel.document.source.version.id, source.version.id)
  assert.equal(repository.lastBundle.auditCommand.audit.credentialId, 'credential-1')
})

test('project duplication replays before source reads and rejects another credential', async () => {
  const { repository, service, duplicateRequest } = await createDuplicationFixture()
  const first = await service(duplicateRequest())
  const replay = await service(duplicateRequest())

  assert.equal(replay.replayed, true)
  assert.equal(replay.project.id, first.project.id)
  assert.equal(repository.sourceReads, 1)
  await assert.rejects(
    () => service(duplicateRequest({ actor: actor({ credentialId: 'credential-2' }) })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('project creation retries serialization conflicts before returning an explicit conflict (zero-wait schedule: three attempts)', async () => {
  const { repository, service } = createFixture()
  await service(request())
  let attempts = 0
  const prismaRepository = new PrismaCreationOutputBundleRepositoryV2({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => prismaRepository.persist(repository.lastWrite),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('unknown workspace is rejected before a project is persisted', async () => {
  const { service } = createFixture()

  await assert.rejects(
    () => service(request({
      workspaceId: 'workspace-missing',
      actor: actor({ workspaceId: 'workspace-missing' }),
    })),
    (error) => error instanceof DomainError && error.code === 'WORKSPACE_NOT_FOUND',
  )
})


function parsedByKind(snapshots) {
  return Object.fromEntries(snapshots.map((snapshot) => [snapshot.kind, JSON.parse(snapshot.contentJson)]))
}

test('duplicated EditPlan names the copy version with its canonical hash recomputed and leaves the source untouched', async () => {
  const { repository, service, source, duplicateRequest } = await createDuplicationFixture()
  const sourceBefore = structuredClone(repository.source.snapshots)
  const result = await service(duplicateRequest())
  const copies = repository.lastBundle.snapshots
  const originals = repository.source.snapshots
  const originalPlan = parsedByKind(originals)['edit-plan']
  const copyPlan = parsedByKind(copies)['edit-plan']

  assert.equal(originalPlan.projectVersionId, source.version.id)
  assert.equal(copyPlan.projectVersionId, result.version.id)
  assert.equal(copyPlan.id, `edit-plan-${result.version.id}`)
  const { projectVersionId: _a, id: _b, ...copyRest } = copyPlan
  const { projectVersionId: _c, id: _d, ...originalRest } = originalPlan
  assert.deepEqual(copyRest, originalRest, 'only the version binding changes')
  const copyRow = copies.find((item) => item.kind === 'edit-plan')
  const originalRow = originals.find((item) => item.kind === 'edit-plan')
  assert.equal(copyRow.contentJson, stableSerialize(copyPlan))
  assert.equal(copyRow.contentHash, calculateCanonicalHash(copyPlan))
  assert.notEqual(copyRow.contentHash, originalRow.contentHash)
  for (const kind of ['brief', 'policies']) {
    const copy = copies.find((item) => item.kind === kind)
    const original = originals.find((item) => item.kind === kind)
    assert.equal(copy.contentJson, original.contentJson)
    assert.equal(copy.contentHash, original.contentHash)
  }
  assert.deepEqual(originals, sourceBefore, 'duplication never rewrites the source snapshots')
})

test('a copy is a first-class version for the editorial Command and the original stays unchanged', async () => {
  const { repository, service, source, prepared, duplicateRequest } = await createDuplicationFixture({editorialSource:true})
  const sourceBefore = structuredClone({ version: source.version, snapshots: repository.source.snapshots })
  const copy = await service(duplicateRequest()),derivation=copy.bundle.command.payload.forkDerivation,original=derivation.document.kernel.document.source
  const transcript=prepared.transcript,normalization=prepared.n,variantId=copy.bundle.state.document.entries[0].variantId
  assert.equal(copy.bundle.state.document.consumption.status,'blocked')
  const inventory=derivation.document.sourceReferences.map(r=>({linkId:r.targetLinkId,artifactId:r.artifactId,role:r.role,manifestId:r.manifestFacts.id,
    manifestHash:r.manifestFacts.manifestHash,artifactSha256:r.artifactSha256,rightsSnapshotId:null,rightsHash:null,rightsRevision:0}))
  const committed=[];let allocation=0
  const editorial=applyEditorialCutCommandService({repository:{
    async findIdempotentResult(){return null},
    async readContext({projectId,transcriptId,variantId:requestedVariant}) {
      return projectId===copy.project.id?{projectId,workspaceId:'workspace-1',currentVersion:copy.version,parent:copy.bundle,transcriptId,transcript,
        sourceArtifactId:normalization.document.source.artifactId,sourceDurationSeconds:2,sourceFps:30,currentDurationFrames:60,variantId:requestedVariant,
        normalizations:[normalization],outputReferences:[],sourceBindingFacts:{schemaVersion:'editorial-source-binding/v1',canonicalPolicyVersion:'output-canonical-json/v1',
          workspaceId:'workspace-1',projectId,authority:{kind:'fork-derivation3',sourceProjectId:original.version.projectId,sourceVersionId:original.version.id,
            sourceBaseHash:original.version.baseHash,sourceStateId:original.state.document.id,sourceStateHash:original.state.stateHash,
            forkRootVersionId:copy.version.id,forkRootStateId:copy.bundle.state.document.id,forkRootStateHash:copy.bundle.state.stateHash,
            derivationId:derivation.document.id,derivationHash:derivation.derivationHash},
          transcript:prepared.bundle.origin.transcript,normalizationRefs:[{id:normalization.document.id,projectId:normalization.document.projectId,receiptHash:normalization.receiptHash}],inventory}}:null
    },
    async commitOrReplay(input) {
      committed.push(input)
      const bundle=buildOperationalOutputVersionBundleV3(input.proposal),editPlan=JSON.parse(bundle.editPlanSnapshot.contentJson)
      return {command:input.command,version:bundle.version,editPlan,exclusions:editPlan.editorial.exclusions,retainedSourceRanges:editPlan.editorial.retainedSourceRanges,
        impact:input.command.payload.impact,invalidations:[],outputBundle:bundle,replayed:false}
    },
  },clock:()=>new Date('2026-10-14T12:00:04.000Z'),createId:kind=>kind+'-editorial-'+(++allocation),createEventId:()=> '00000000-0000-4000-8000-0000000000e1'})
  const request={workspaceId:'workspace-1',projectId:copy.project.id,baseVersionId:copy.version.id,baseHash:copy.version.baseHash,
    sourceTranscriptId:prepared.bundle.origin.transcript.id,variantId,rules:[{id:'cut-this',label:'controlada',alternatives:['controlada']}],
    reason:'Editorial Command on a duplicated project.',actor:actor(),idempotency:{clientId:'client-1',key:'editorial-on-copy-1'}}
  const result=await editorial(request)
  assert.equal(result.version.parentVersionId,copy.version.id)
  assert.equal(result.version.sequence,2)
  assert.equal(committed.length,1)
  assert.equal(JSON.parse(committed[0].snapshot.contentJson).projectVersionId,result.version.id)
  assert.deepEqual({version:source.version,snapshots:repository.source.snapshots},sourceBefore)
  assert.equal(result.version.outputContractVersion,3);assert.equal(result.command.payload.schemaVersion,3)
  assert.equal(result.outputBundle.state.document.transition,'editorial-cut')
  const entry=result.outputBundle.state.document.entries[0],materialization=entry.consumption.materialization.document
  assert.equal(entry.spec.schemaVersion,'output-spec-revision/v3');assert.equal(entry.specHash,copy.bundle.state.document.entries[0].specHash)
  assert.equal(materialization.schemaVersion,'editorial-derived-materialization/v1');assert.deepEqual(materialization.normalizations,[normalization])
  assert.equal(materialization.sourceBinding.document.transcript.projectId,source.version.projectId)
  assert.notEqual(materialization.sourceBinding.document.projectId,source.version.projectId)
  assert.deepEqual(materialization.emission,{subtitles:'suppressed-missing-visual-clock-authority',cta:'suppressed-missing-visual-clock-authority'})
  assert.equal(result.editPlan.durationFrames,30);assert.equal(result.editPlan.subtitleTracks[0].cues[0].text,'Fonte')
  assert.deepEqual(result.editPlan.subtitleTracks[0].cues[0].sourceWordIndices,[0])
  assert.deepEqual(result.retainedSourceRanges,[{sourceStartSeconds:0,sourceEndSeconds:1}])
  assert.equal(result.impact.schemaVersion,'editorial-cut-impact/v2');assert.deepEqual(result.impact.affectedVariantIds,[variantId])
  await assert.rejects(()=>editorial({...request,variantId:undefined}),e=>e.code==='INVALID_COMMAND')
  assert.equal(committed.length,1,'Missing explicit variant does not publish')
  const bad=structuredClone(committed[0].proposal)
  bad.origin.command.payload.sourceBinding.document.transcript.projectId=copy.project.id
  const {createEditorialSourceBindingV1}=await import('../../src/v2/domain/output-materialization.ts')
  assert.throws(()=>createEditorialSourceBindingV1(bad.origin.command.payload.sourceBinding.document),e=>e.code==='INVALID_RENDER_INPUT')
  const resealed=structuredClone(committed[0].proposal),{createEditCommand}=await import('../../src/v2/domain/edit-command.ts')
  resealed.origin.command.payload.sourceBinding.document.authority.derivationHash='f'.repeat(64)
  resealed.origin.command.payload.sourceBinding=createEditorialSourceBindingV1(resealed.origin.command.payload.sourceBinding.document)
  const {schemaVersion,commandHash,...commandBody}=resealed.origin.command
  resealed.origin.command=createEditCommand(commandBody)
  assert.throws(()=>buildOperationalOutputVersionBundleV3(resealed),e=>e.code==='INVALID_COMMAND'&&e.message==='Editorial root needs its exact fork3 derivation authority')
  assert.deepEqual({version:source.version,snapshots:repository.source.snapshots},sourceBefore)
})

test('snapshot rebinding changes only owner-binding fields and recomputes the canonical hash', () => {
  const source = { projectId: 'project-a', versionId: 'version-a' }
  const copy = { projectId: 'project-b', versionId: 'version-b' }
  const rebind = (kind, content, hash = 'f'.repeat(64)) => rebindSnapshotContentForDuplicate({
    kind, contentJson: stableSerialize(content), contentHash: hash, source, copy,
  })

  const brief = rebind('brief', { schemaVersion: 1, objective: 'discovery' })
  assert.deepEqual([brief.rebound, brief.contentHash], [false, 'f'.repeat(64)])

  const plan = rebind('edit-plan', { id: 'edit-plan-version-a', projectVersionId: 'version-a', fps: 30 })
  assert.equal(plan.rebound, true)
  assert.deepEqual(JSON.parse(plan.contentJson), { id: 'edit-plan-version-b', projectVersionId: 'version-b', fps: 30 })
  assert.equal(plan.contentHash, calculateCanonicalHash(JSON.parse(plan.contentJson)))

  // A plan produced by a Command keeps the base plan's id: only the version binding moves.
  const carried = rebind('edit-plan', { id: 'edit-plan-version-0', projectVersionId: 'version-a', fps: 30 })
  assert.deepEqual(JSON.parse(carried.contentJson), { id: 'edit-plan-version-0', projectVersionId: 'version-b', fps: 30 })

  // A policy snapshot created at an earlier version still names the copy's only version.
  const policy = rebind('policies', { schemaVersion: 2, workspaceId: 'workspace-1', projectId: 'project-a', projectVersionId: 'version-older', commandId: 'command-1' })
  assert.deepEqual(JSON.parse(policy.contentJson), { schemaVersion: 2, workspaceId: 'workspace-1', projectId: 'project-b', projectVersionId: 'version-b', commandId: 'command-1' })

  assert.throws(
    () => rebindSnapshotContentForDuplicate({ kind: 'brief', contentJson: '{', contentHash: 'f'.repeat(64), source, copy }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('a language the request states is kept, canonicalized, and none is invented when it is absent', async () => {
  const stated = await createFixture().service({ ...request(), locale: 'en-us' })
  assert.equal(stated.projectAtCreation.locale, 'en-US')
  const absent = await createFixture().service(request())
  assert.equal(absent.bundle.command.payload.callerIntent.locale, null)
  assert.equal('locale' in absent.projectAtCreation, false)
})
