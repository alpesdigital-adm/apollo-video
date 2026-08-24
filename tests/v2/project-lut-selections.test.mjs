import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { setProjectLutSelectionService } from '../../src/v2/application/project-lut-selections.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { createProjectLutSelection, projectLutRef } from '../../src/v2/domain/project-lut-selection.ts'
import { createWorkspaceLutVersion } from '../../src/v2/domain/workspace-lut.ts'
import { createProjectLutSelectionImpact, createProjectLutSelectionInvalidations, parseProjectLutSelectionImpact } from '../../src/v2/domain/project-lut-selection-impact.ts'
import { LocalProjectLutRenderMaterializer } from '../../src/v2/infrastructure/media/local-project-lut-render-materializer.ts'
import { PrismaProjectLutSelectionRepository } from '../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts'
import { parseSetProjectLutSelectionBody, presentProjectLutSelectionResult } from '../../src/v2/public-api/project-lut-selection-contract.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const cube = `LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`

function externalActor(credentialId = 'credential-project-lut') {
  const auditContext = createExternalAuditContext({
    clientId: 'client-project-lut',
    credentialId,
    workspaceId: 'workspace-project-lut',
    environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

function baseVersion(overrides = {}) {
  return createProjectVersion({
    id: 'project-version-lut-base-1', workspaceId: 'workspace-project-lut', projectId: 'project-lut-test', sequence: 1,
    snapshotRefs: { brief: 'brief-snapshot-1', editPlan: 'edit-plan-snapshot-1', policies: 'policies-snapshot-1' },
    baseHash: 'a'.repeat(64), createdBy: 'client-project-lut', createdAt: '2026-07-31T17:00:00.000Z', ...overrides,
  })
}

function lutVersion() {
  return createWorkspaceLutVersion({
    id: 'workspace-lut-version-project-2', workspaceId: 'workspace-project-lut', lutId: 'workspace-lut-project', version: 2,
    name: 'Approved project look', owner: 'Apollo Studio', license: { policy: 'owned', name: 'Workspace' }, tags: ['approved'],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.65, cubeContent: cube,
    preview: { byteSize: 128, sha256: 'b'.repeat(64) }, createdByClientId: 'client-project-lut', createdAt: '2026-07-31T16:59:00.000Z',
  })
}

function memoryRepository(context) {
  const replays = new Map()
  let current = null
  return {
    commits: [],
    async findIdempotent({ idempotencyKey }) { return replays.get(idempotencyKey) ?? null },
    async readContext() {
      return {
        currentDurationFrames: 180,
        proxyVariantId: '9:16',
        outputReferences: [{ artifactId: 'artifact-project-lut-proxy-base', kind: 'proxy', sourceVersionId: context.currentVersion.id, variantId: '9:16' }],
        ...context,
      }
    },
    async commitOrReplay(input) {
      const impact = parseProjectLutSelectionImpact(input.command.payload.impact)
      const invalidations = createProjectLutSelectionInvalidations({ impact, createdAt: input.command.createdAt })
      const result = Object.freeze({ command: input.command, version: input.version, selection: input.selection, impact, invalidations, replayed: false })
      this.commits.push(input); current = result
      replays.set(input.command.idempotencyKey, Object.freeze({ requestFingerprint: input.requestFingerprint, result: Object.freeze({ ...result, replayed: true }) }))
      return result
    },
    async readCurrent() { return current },
  }
}

function service(repository) {
  const ids = { command: 0, version: 0, selection: 0 }
  return setProjectLutSelectionService({
    repository, createId: (kind) => `project-lut-${kind}-test-${++ids[kind]}`, createEventId: () => '00000000-0000-4000-8000-000000000181',
    clock: () => new Date('2026-07-31T17:01:00.000Z'),
  })
}

test('T-FR-181 workspace default resolves to an exact immutable LUT in a Command and new ProjectVersion', async () => {
  const base = baseVersion(); const lut = lutVersion()
  const repository = memoryRepository({ currentVersion: base, workspaceDefaultRevision: 3, resolvedLutVersion: lut })
  const apply = service(repository)
  const request = {
    workspaceId: base.workspaceId, projectId: base.projectId, baseVersionId: base.id, baseHash: base.baseHash,
    selection: { mode: 'workspace-default' }, reason: 'Use the approved look.', actor: externalActor(),
    idempotencyKey: 'project-lut-selection-default-1',
  }
  const result = await apply(request)

  assert.equal(result.command.type, 'set-project-lut-selection')
  assert.equal(result.command.payload.schemaVersion, 2)
  assert.equal(result.command.payload.mode, 'workspace-default')
  assert.equal(result.command.payload.intensity, 0.65)
  assert.equal(result.version.sequence, 2)
  assert.equal(result.version.parentVersionId, base.id)
  assert.deepEqual(result.version.snapshotRefs, base.snapshotRefs)
  assert.equal(result.version.commandId, result.command.id)
  assert.equal(result.selection.workspaceDefaultRevision, 3)
  assert.equal(result.selection.resolved.mode, 'lut-version')
  assert.deepEqual(result.selection.resolved.lut, {
    lutId: lut.lutId, versionId: lut.id, version: 2, name: lut.name, recordHash: lut.recordHash, cubeContentHash: lut.cube.contentHash,
  })
  assert.match(result.selection.selectionHash, /^[a-f0-9]{64}$/)
  assert.equal(repository.commits[0].event.type, 'project.version.created')
  assert.deepEqual(result.impact.dependencyTypes, ['visual'])
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 180 }])
  assert.deepEqual(result.impact.minimalRenders, [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 180 }] }])
  assert.equal(result.invalidations.length, 1)
  assert.equal(repository.commits[0].event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(repository.commits[0].authenticationAudit.credentialId, 'credential-project-lut')
  assert.match(repository.commits[0].authenticationAudit.contextHash, /^[a-f0-9]{64}$/)
  assert.equal((await apply(request)).replayed, true)
  await assert.rejects(apply({ ...request, selection: { mode: 'none' } }), /another project LUT selection/)
  await assert.rejects(
    apply({ ...request, actor: externalActor('credential-project-lut-other') }),
    /another project LUT selection/,
  )
})

test('T-FR-181 explicit none is version-bound and stale project bases are rejected before commit', async () => {
  const base = baseVersion(); const repository = memoryRepository({ currentVersion: base })
  const apply = service(repository)
  const common = {
    workspaceId: base.workspaceId, projectId: base.projectId, baseVersionId: base.id, selection: { mode: 'none' }, intensity: 0.4,
    actor: { type: 'director', id: 'director-project-lut' }, idempotencyKey: 'project-lut-selection-none-1',
  }
  await assert.rejects(apply({ ...common, baseHash: 'c'.repeat(64) }), /stale/)
  assert.equal(repository.commits.length, 0)
  const result = await apply({ ...common, baseHash: base.baseHash })
  assert.deepEqual(result.selection.resolved, { mode: 'none' })
  assert.equal(result.selection.workspaceDefaultRevision, undefined)
  assert.equal(result.selection.intensity, 0.4)
})

test('T-FR-233 LUT selection requests a full proxy without fabricating stale rows when no base output exists', async () => {
  const base = baseVersion()
  const repository = memoryRepository({ currentVersion: base, outputReferences: [] })
  const result = await service(repository)({
    workspaceId: base.workspaceId, projectId: base.projectId, baseVersionId: base.id, baseHash: base.baseHash,
    selection: { mode: 'none' }, actor: externalActor(),
    idempotencyKey: 'project-lut-selection-no-output-1',
  })
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.invalidations, [])
  assert.equal(result.impact.minimalRenders.length, 1)
})

test('T-FR-233 LUT selection before a timeline defers rendering without fabricating impact', async () => {
  const base = baseVersion()
  const repository = memoryRepository({ currentVersion: base, currentDurationFrames: 0, outputReferences: [] })
  const result = await service(repository)({
    workspaceId: base.workspaceId, projectId: base.projectId, baseVersionId: base.id, baseHash: base.baseHash,
    selection: { mode: 'none' }, actor: externalActor(),
    idempotencyKey: 'project-lut-selection-deferred-1',
  })
  assert.equal(result.impact.renderDeferredUntilTimeline, true)
  assert.deepEqual(result.impact.affectedRanges, [])
  assert.deepEqual(result.impact.affectedVariantIds, [])
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.impact.minimalRenders, [])
  assert.deepEqual(result.invalidations, [])
})

test('T-FR-242 project LUT selection rejects an unauthenticated external actor', async () => {
  const base = baseVersion()
  const repository = memoryRepository({ currentVersion: base })
  await assert.rejects(service(repository)({
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    baseVersionId: base.id,
    baseHash: base.baseHash,
    selection: { mode: 'none' },
    actor: { type: 'api-client', id: 'client-project-lut' },
    idempotencyKey: 'project-lut-selection-raw-client',
  }), /not trusted/)
  assert.equal(repository.commits.length, 0)
})

test('T-FR-242 project LUT command hydration rejects a tampered credential audit', async () => {
  const base = baseVersion()
  const memory = memoryRepository({ currentVersion: base, outputReferences: [] })
  await service(memory)({
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    baseVersionId: base.id,
    baseHash: base.baseHash,
    selection: { mode: 'none' },
    actor: externalActor(),
    idempotencyKey: 'project-lut-selection-audit-hydration',
  })
  const committed = memory.commits[0]
  const commandRow = {
    id: committed.command.id,
    workspaceId: committed.command.workspaceId,
    projectId: committed.command.projectId,
    baseVersionId: committed.command.baseVersionId,
    baseHash: committed.command.baseHash,
    type: committed.command.type,
    scopeJson: stableSerialize(committed.command.scope),
    payloadJson: stableSerialize(committed.command.payload),
    reason: committed.command.reason ?? null,
    actorType: committed.command.author.type,
    actorId: committed.command.author.id,
    delegatedUserId: committed.command.author.delegatedUserId ?? null,
    actorCredentialId: committed.authenticationAudit.credentialId,
    actorEnvironment: committed.authenticationAudit.environment,
    actorAuthenticationKind: committed.authenticationAudit.authenticationKind,
    actorContextHash: committed.authenticationAudit.contextHash,
    actorDelegatedIdentityId: null,
    actorWorkspaceRole: null,
    idempotencyKey: committed.command.idempotencyKey,
    requestFingerprint: committed.requestFingerprint,
    createdAt: new Date(committed.command.createdAt),
    artifactInvalidations: [],
  }
  const resultVersion = {
    id: committed.version.id,
    workspaceId: committed.version.workspaceId,
    projectId: committed.version.projectId,
    sequence: committed.version.sequence,
    parentVersionId: committed.version.parentVersionId,
    forkedFromProjectId: null,
    forkedFromVersionId: null,
    briefSnapshotId: committed.version.snapshotRefs.brief,
    treatmentSnapshotId: null,
    storySnapshotId: null,
    editPlanSnapshotId: committed.version.snapshotRefs.editPlan,
    policiesSnapshotId: committed.version.snapshotRefs.policies,
    baseHash: committed.version.baseHash,
    createdBy: committed.version.createdBy,
    commandId: committed.command.id,
    createdAt: new Date(committed.version.createdAt),
  }
  const selection = committed.selection
  const selectionRow = {
    id: selection.id,
    workspaceId: selection.workspaceId,
    projectId: selection.projectId,
    commandId: selection.commandId,
    baseVersionId: selection.baseVersionId,
    resultVersionId: selection.resultVersionId,
    requestedMode: selection.requested.mode,
    requestedLutId: null,
    requestedLutVersion: null,
    resolvedMode: selection.resolved.mode,
    resolvedLutVersionId: null,
    workspaceDefaultRevision: null,
    intensity: selection.intensity,
    selectionJson: stableSerialize(selection),
    selectionHash: selection.selectionHash,
    createdAt: new Date(selection.createdAt),
    command: commandRow,
    resultVersion,
    resolvedLutVersion: null,
  }
  const repository = new PrismaProjectLutSelectionRepository({
    v2EditCommand: { async findUnique() { return { id: commandRow.id, requestFingerprint: commandRow.requestFingerprint } } },
    v2ProjectLutSelection: { async findUnique() { return selectionRow } },
  })
  const replay = await repository.findIdempotent({
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    idempotencyKey: committed.command.idempotencyKey,
  })
  assert.equal(replay.result.command.author.id, 'client-project-lut')
  commandRow.actorCredentialId = 'credential-project-lut-tampered'
  await assert.rejects(repository.findIdempotent({
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    idempotencyKey: committed.command.idempotencyKey,
  }), /command audit/)
})

test('project LUT impact survives canonical persistence key ordering', () => {
  const impact = createProjectLutSelectionImpact({
    commandId: 'command-lut-persistence',
    baseVersionId: 'version-lut-persistence-base',
    resultVersionId: 'version-lut-persistence-result',
    selectionId: 'selection-lut-persistence',
    selectionHash: 'e'.repeat(64),
    resolvedMode: 'none',
    intensity: 0.75,
    durationFrames: 180,
    proxyVariantId: '9:16',
    outputReferences: [],
  })
  const persisted = JSON.parse(stableSerialize(impact))

  assert.deepEqual(parseProjectLutSelectionImpact(persisted), persisted)
  assert.equal(parseProjectLutSelectionImpact(persisted).impactHash, impact.impactHash)
})

test('T-FR-181 public project LUT selection contract is exact and hides persistence fields', () => {
  assert.deepEqual(parseSetProjectLutSelectionBody({
    baseVersionId: 'project-version-lut-base-1', baseHash: 'a'.repeat(64), selection: { mode: 'lut-version', lutId: 'workspace-lut-project', version: 2 }, intensity: 0.5,
  }).selection, { mode: 'lut-version', lutId: 'workspace-lut-project', version: 2 })
  assert.throws(() => parseSetProjectLutSelectionBody({ baseVersionId: 'base', baseHash: 'a'.repeat(64), selection: { mode: 'none', lutId: 'hidden' } }), /cannot identify/)
  assert.throws(() => parseSetProjectLutSelectionBody({ baseVersionId: 'base', baseHash: 'a'.repeat(64), selection: { mode: 'none' }, hidden: true }), /unknown fields/)

  const base = baseVersion(); const selection = {
    id: 'selection', requested: { mode: 'none' }, resolved: { mode: 'none' }, intensity: 1, selectionHash: 'd'.repeat(64), createdAt: '2026-07-31T17:01:00.000Z',
  }
  const impact = createProjectLutSelectionImpact({
    commandId: 'command', baseVersionId: base.id, resultVersionId: 'result', selectionId: selection.id,
    selectionHash: selection.selectionHash, resolvedMode: 'none', intensity: selection.intensity,
    durationFrames: 180, proxyVariantId: '9:16', outputReferences: [],
  })
  const presented = presentProjectLutSelectionResult({
    command: { id: 'command', type: 'set-project-lut-selection', baseVersionId: base.id, author: { type: 'api-client', id: 'client' }, createdAt: selection.createdAt },
    version: { ...base, id: 'result', sequence: 2, parentVersionId: base.id, commandId: 'command' }, selection, impact,
    invalidations: createProjectLutSelectionInvalidations({ impact, createdAt: selection.createdAt }), replayed: false,
  })
  assert.equal('workspaceId' in presented.selection, false)
  assert.equal('payload' in presented.command, false)
  assert.equal(presented.impact.impactHash, impact.impactHash)
  assert.deepEqual(presented.invalidations, [])
  assert.equal(presented.version.visibleState.label, 'current')
  assert.equal(presented.version.visibleState.primaryAction, 'open-result')
  assert.equal(Object.isFrozen(presented.version.visibleState), true)
})

test('T-FR-236 project LUT read and set expose the current selection version state', () => {
  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
  assert.equal(capabilities.get('apollo.projects.lut-selection.read').version, '3.0.0')
  assert.equal(capabilities.get('apollo.projects.lut-selection.read').outputSchemaRef, 'apollo://schemas/project-lut-selection-response/v3')
  assert.equal(capabilities.get('apollo.projects.lut-selection.set').version, '3.0.0')
  assert.equal(capabilities.get('apollo.projects.lut-selection.set').outputSchemaRef, 'apollo://schemas/project-lut-selection-applied/v3')
  assert.equal(getPublicSchema('apollo://schemas/project-lut-selection-response/v2').ref, 'apollo://schemas/project-lut-selection-response/v2')
  assert.equal(getPublicSchema('apollo://schemas/project-lut-selection-applied/v2').ref, 'apollo://schemas/project-lut-selection-applied/v2')

  for (const ref of [
    'apollo://schemas/project-lut-selection-response/v3',
    'apollo://schemas/project-lut-selection-applied/v3',
  ]) {
    const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
      .compile(getPublicSchema(ref).schema)
    for (const example of publicSchemaExamples(getPublicSchema(ref))) {
      assert.equal(validate(example), true, `${ref}: ${JSON.stringify(validate.errors)}`)
      const mismatched = structuredClone(example)
      const version = mismatched.data.result?.version ?? mismatched.data.version
      version.visibleState.label = 'superseded'
      assert.equal(validate(mismatched), false, ref)
    }
  }
})

test('T-FR-181 worker materializes the exact selected cube and intensity outside the renderer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-project-lut-materializer-'))
  try {
    const creativeCube = `LUT_3D_SIZE 2
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
1 0 0
`
    const lut = createWorkspaceLutVersion({
      id: 'workspace-lut-materialized-1', workspaceId: 'workspace-project-lut', lutId: 'workspace-lut-materialized', version: 1,
      name: 'Materialized look', owner: 'Apollo Studio', license: { policy: 'owned', name: 'Workspace' },
      compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.5, cubeContent: creativeCube,
      preview: { byteSize: 128, sha256: 'e'.repeat(64) }, createdByClientId: 'client-project-lut', createdAt: '2026-07-31T17:02:00.000Z',
    })
    const alternateLut = createWorkspaceLutVersion({
      id: 'workspace-lut-alternate-1', workspaceId: lut.workspaceId, lutId: 'workspace-lut-alternate', version: 1,
      name: 'Alternate look', owner: 'Apollo Studio', license: { policy: 'licensed', name: 'Workspace' },
      compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.75,
      cubeContent: `LUT_3D_SIZE 2\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n0 0 1\n`,
      preview: { byteSize: 128, sha256: 'd'.repeat(64) }, createdByClientId: 'client-project-lut', createdAt: '2026-07-31T17:02:00.000Z',
    })
    const selection = createProjectLutSelection({
      id: 'project-lut-materialized-selection', workspaceId: lut.workspaceId, projectId: 'project-lut-test',
      baseVersionId: 'project-version-lut-base-1', resultVersionId: 'project-version-lut-result-2', commandId: 'project-lut-command-materialized',
      requested: { mode: 'lut-version', lutId: lut.lutId, version: 1 }, resolved: { mode: 'lut-version', lut: projectLutRef(lut) }, intensity: 0.5,
      createdAt: '2026-07-31T17:03:00.000Z',
    })
    const creativeParameters = { mode: 'lut3d', intensity: 0.5 }
    const creative = { kind: 'creative-lut', enabled: true, implementation: { provider: 'apollo-lut', parameters: creativeParameters, parametersHash: calculateCanonicalHash(creativeParameters) }, lut: { artifactId: lut.id, sha256: lut.cube.contentHash } }
    const materializer = new LocalProjectLutRenderMaterializer(
      { async readEffectiveForVersion() { return { selection, resolvedLutVersion: lut } } },
      join(root, 'work'),
      { async readVersionById({ versionId }) { return versionId === alternateLut.id ? alternateLut : null } },
    )
    const result = await materializer.materialize({
      workspaceId: lut.workspaceId, projectId: selection.projectId, projectVersionId: selection.resultVersionId,
      operationId: 'operation-project-lut-materialized', compilations: [{ pipeline: { stages: [{ kind: 'technical' }, { kind: 'match' }, creative, { kind: 'output' }] } }],
    })
    const path = result.lutPaths[lut.id]
    assert.ok(path.startsWith(root))
    const content = await readFile(path, 'utf8')
    assert.match(content, /0\.5 0 0/)
    assert.match(result.materializedCubeHash, /^[a-f0-9]{64}$/)
    assert.equal(result.asset.artifactId, lut.id)
    assert.equal(result.asset.byteSize, Buffer.byteLength(content, 'utf8'))
    assert.match(result.asset.artifactKey, /^workspace-luts\//)
    await materializer.cleanup('operation-project-lut-materialized')
    await assert.rejects(access(path))

    const fullParameters = { mode: 'lut3d', intensity: 1 }
    const full = { ...creative, implementation: { ...creative.implementation, parameters: fullParameters, parametersHash: calculateCanonicalHash(fullParameters) } }
    const noneParameters = { mode: 'none' }
    const none = { ...creative, enabled: false, implementation: { ...creative.implementation, parameters: noneParameters, parametersHash: calculateCanonicalHash(noneParameters) }, lut: undefined }
    const alternateParameters = { mode: 'lut3d', intensity: 0.75 }
    const alternate = { ...creative, implementation: { ...creative.implementation, parameters: alternateParameters, parametersHash: calculateCanonicalHash(alternateParameters) }, lut: { artifactId: alternateLut.id, sha256: alternateLut.cube.contentHash } }
    const targeted = await materializer.materialize({
      workspaceId: lut.workspaceId, projectId: selection.projectId, projectVersionId: selection.resultVersionId,
      operationId: 'operation-project-lut-targeted',
      compilations: [{ pipeline: { stages: [{ kind: 'technical' }, { kind: 'match' }, creative, { kind: 'output' }] } }],
      executions: [
        { stages: [{ kind: 'technical' }, { kind: 'match' }, creative, { kind: 'output' }] },
        { stages: [{ kind: 'technical' }, { kind: 'match' }, full, { kind: 'output' }] },
        { stages: [{ kind: 'technical' }, { kind: 'match' }, none, { kind: 'output' }] },
        { stages: [{ kind: 'technical' }, { kind: 'match' }, alternate, { kind: 'output' }] },
      ],
    })
    assert.equal(targeted.assets.length, 3)
    assert.equal(targeted.materializedCubeHashes.length, 3)
    assert.equal(new Set(targeted.assets.map((asset) => asset.sha256)).size, 3)
    assert.equal(targeted.asset, undefined)
    const halfPath = targeted.lutPaths[`${lut.id}:${creative.implementation.parametersHash}`]
    const fullPath = targeted.lutPaths[`${lut.id}:${full.implementation.parametersHash}`]
    assert.notEqual(halfPath, fullPath)
    assert.match(await readFile(halfPath, 'utf8'), /0\.5 0 0/)
    assert.match(await readFile(fullPath, 'utf8'), /1 0 0/)
    assert.match(await readFile(targeted.lutPaths[`${alternateLut.id}:${alternate.implementation.parametersHash}`], 'utf8'), /0 0 1/)

    const mismatched = { ...full, lut: { ...full.lut, artifactId: 'workspace-lut-unselected-1' } }
    await assert.rejects(materializer.materialize({
      workspaceId: lut.workspaceId, projectId: selection.projectId, projectVersionId: selection.resultVersionId,
      operationId: 'operation-project-lut-mismatch', compilations: [{ pipeline: { stages: [{ kind: 'technical' }, { kind: 'match' }, mismatched, { kind: 'output' }] } }],
    }), /does not match/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
