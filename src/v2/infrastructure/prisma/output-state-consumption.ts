import type { PrismaClient, Prisma } from '../../../../generated/prisma-v2/index.js'
import { createHash } from 'node:crypto'
import { DomainError } from '../../domain/errors.ts'
import { creationProjectMetadataV2, validateProjectCreationOutputCommandV2, type ProjectCreationOutputCommandV2 } from '../../domain/project-creation-command.ts'
import { buildCreationOutputVersionBundleV2, validateCreationOutputVersionBundleV2, type CreationOutputVersionBundleV2 } from '../../domain/output-version-bundle.ts'
import { serializeOutputCanonicalJson } from '../../domain/output-canonical-policy.ts'

type Reader = Pick<PrismaClient | Prisma.TransactionClient, '$queryRawUnsafe'>
export async function readPersistedCreationOutputBundleV2(client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; versionId: string }>): Promise<Readonly<CreationOutputVersionBundleV2> | null> {
  const rows = await client.$queryRawUnsafe<Array<{ commandJson: string; commandHash: string; stateJson: string;
    stateHash: string; versionJson: string; outputBaseHashJson: string; baseHash: string }>>(
    'SELECT c."commandJson", c."commandHash", s."stateJson", s."stateHash", v."outputVersionJson" AS "versionJson", v."outputBaseHashJson", v."baseHash" FROM "project_versions" v JOIN "project_output_states" s ON s."id"=v."outputStateId" AND s."resultVersionId"=v."id" AND s."projectId"=v."projectId" AND s."workspaceId"=v."workspaceId" AND s."stateHash"=v."outputStateHash" JOIN "project_creation_commands" c ON c."id"=s."creationCommandV2Id" AND c."workspaceId"=s."workspaceId" AND c."projectId"=s."projectId" AND c."versionId"=v."id" AND c."commandHash"=s."provenanceHash" WHERE v."id"=$1 AND v."projectId"=$2 AND v."workspaceId"=$3 AND v."outputContractVersion"=2',
    input.versionId, input.projectId, input.workspaceId)
  if (rows.length === 0) {
    const versions = await client.$queryRawUnsafe<Array<{ outputContractVersion: number }>>(
      'SELECT "outputContractVersion" FROM "project_versions" WHERE "id"=$1 AND "projectId"=$2 AND "workspaceId"=$3',
      input.versionId, input.projectId, input.workspaceId)
    if (versions.length !== 0) throw new DomainError('PERSISTENCE_CONFLICT', 'Operational output bundle requires exact contract two bindings')
    return null
  }
  try {
    if (rows.length !== 1) throw new Error('Ambiguous output bundle')
    const row = rows[0], command = validateProjectCreationOutputCommandV2(JSON.parse(row.commandJson) as ProjectCreationOutputCommandV2)
    const metadata = creationProjectMetadataV2(command)
    const projects = await client.$queryRawUnsafe<Array<{ ownerId: string | null; format: string | null; creationContractVersion: number }>>(
      'SELECT "ownerId",format,"creationContractVersion" FROM projects WHERE id=$1 AND "workspaceId"=$2',input.projectId,input.workspaceId)
    if (projects.length !== 1 || projects[0].creationContractVersion !== 2 || projects[0].ownerId !== metadata.ownerId ||
      projects[0].format !== metadata.format) throw new Error('Creation administrative metadata contradicts its Command')
    const expected = buildCreationOutputVersionBundleV2(command)
    const supplied: CreationOutputVersionBundleV2 = { schemaVersion: expected.schemaVersion, command,
      state: { document: JSON.parse(row.stateJson), stateHash: row.stateHash }, version: JSON.parse(row.versionJson),
      outputBaseHashJson: row.outputBaseHashJson }
    const bundle = validateCreationOutputVersionBundleV2(supplied)
    if (command.commandHash !== row.commandHash || bundle.version.baseHash !== row.baseHash ||
      bundle.version.id !== input.versionId || bundle.version.projectId !== input.projectId || bundle.version.workspaceId !== input.workspaceId ||
      row.commandJson !== serializeOutputCanonicalJson(command) || row.stateJson !== serializeOutputCanonicalJson(bundle.state.document) ||
      row.versionJson !== serializeOutputCanonicalJson(bundle.version)) throw new Error('Output bundle row/document mismatch')
    const references=command.payload.forkDerivation?.document.sourceReferences ?? []
    const links=await client.$queryRawUnsafe<Array<{ id:string;artifactId:string;role:string;originalFileName:string;uploadId:string|null;createdAt:Date }>>(
      'SELECT id,"artifactId",role,"originalFileName","uploadId","createdAt" FROM project_media_assets WHERE "projectId"=$1 AND "workspaceId"=$2',input.projectId,input.workspaceId)
    if(links.length!==references.length)throw new Error('Target media-link membership differs')
    for(const reference of references) {
      const link=links.find(l=>l.id===reference.targetLinkId)
      if(!link || link.artifactId!==reference.artifactId || link.role!==reference.role || link.originalFileName!==reference.originalFileName || link.uploadId!==null || link.createdAt.toISOString()!==command.createdAt)
        throw new Error('Target media-link factual binding differs')
      const facts=await client.$queryRawUnsafe<Array<{ artifactKey:string;sha256:string;byteSize:string;mediaType:string;container:string;manifestFacts:unknown }>>(
        'SELECT a."artifactKey",a.sha256,a."byteSize"::text AS "byteSize",a."mediaType",a.container,w66_fork_manifest_facts_v2($1,$2) AS "manifestFacts" FROM media_artifacts a WHERE a.id=$3 AND a."workspaceId"=$2',reference.manifestFacts.id,input.workspaceId,reference.artifactId)
      if(facts.length!==1 || facts[0].artifactKey!==reference.artifactKey || facts[0].sha256!==reference.artifactSha256 || facts[0].byteSize!==reference.artifactByteSize ||
        facts[0].mediaType!==reference.artifactMediaType || facts[0].container!==reference.artifactContainer ||
        serializeOutputCanonicalJson(facts[0].manifestFacts)!==serializeOutputCanonicalJson(reference.manifestFacts)) throw new Error('Stored manifest/artifact/recipe/protected-ref facts differ')
    }
    const snapshots = await client.$queryRawUnsafe<Array<{ id: string; kind: string; schemaVersion: number; contentJson: string; contentHash: string; createdAt: Date }>>(
      'SELECT id,kind,"schemaVersion","contentJson","contentHash","createdAt" FROM project_snapshots WHERE "workspaceId"=$1 AND "projectId"=$2 AND id IN ('+command.payload.snapshots.map((_,i)=>'$'+(i+3)).join(',')+')',input.workspaceId,input.projectId,...command.payload.snapshots.map(s=>s.id))
    if (snapshots.length !== command.payload.snapshots.length) throw new Error('Snapshot membership differs')
    for (const snapshot of command.payload.snapshots) {
      const actual = snapshots.find((s) => s.id === snapshot.id)
      if (!actual || actual.kind !== snapshot.kind || actual.schemaVersion !== snapshot.contentSchemaVersion ||
        actual.contentJson !== snapshot.contentJson || actual.contentHash !== snapshot.contentHash || actual.createdAt.toISOString() !== snapshot.createdAt ||
        createHash('sha256').update(actual.contentJson).digest('hex') !== actual.contentHash) throw new Error('Snapshot factual seal differs')
    }
    const members = await client.$queryRawUnsafe<Array<{ entryJson: string; specJson: string; entryHash: string; specHash: string; variantId: string; outputSpecRevisionId: string; geometryStatus: string }>>(
      'SELECT e."entryJson",e."entryHash",e."specHash",e."variantId",e."outputSpecRevisionId",e."geometryStatus",r."specJson" FROM project_output_state_entries e JOIN output_spec_revisions r ON r.id=e."outputSpecRevisionId" AND r."specHash"=e."specHash" AND r."variantId"=e."variantId" AND r."workspaceId"=e."workspaceId" AND r."projectId"=e."projectId" JOIN output_variants v ON v.id=e."variantId" AND v."workspaceId"=e."workspaceId" AND v."projectId"=e."projectId" AND v."createdCommandId"=r."createdCommandId" AND v."createdCommandHash"=r."createdCommandHash" WHERE e."stateId"=$1 AND e."workspaceId"=$2 AND e."projectId"=$3 AND r."createdCommandId"=$4 AND r."createdCommandHash"=$5 AND r."createdCommandKind"=$6',
      bundle.state.document.id,input.workspaceId,input.projectId,command.id,command.commandHash,'creation-command-v2')
    if (members.length !== bundle.state.document.entries.length) throw new Error('Entry membership differs')
    for (const entry of bundle.state.document.entries) {
      const actual = members.find((e) => e.variantId === entry.variantId)
      if (!actual || actual.outputSpecRevisionId !== entry.outputSpecRevisionId || actual.specHash !== entry.specHash || actual.geometryStatus !== 'blocked-v2' ||
        actual.entryJson !== serializeOutputCanonicalJson(entry) || actual.specJson !== serializeOutputCanonicalJson(entry.spec) ||
        actual.entryHash !== createHash('sha256').update(actual.entryJson).digest('hex')) throw new Error('Entry/revision factual seal differs')
    }
    for (const [table,field,expected] of [
      ['project_fork_crop_decisions','decisionJson',bundle.state.document.overlays],
      ['project_fork_invalidation_lineage','lineageJson',bundle.state.document.invalidations],
    ] as const) {
      // Table/field identifiers are closed literals, never caller-provided SQL.
      const actual = await client.$queryRawUnsafe<Array<{ document: string }>>(
        'SELECT "'+field+'" AS document FROM "'+table+'" WHERE "stateId"=$1 AND "workspaceId"=$2 AND "projectId"=$3',bundle.state.document.id,input.workspaceId,input.projectId)
      const expectedTexts = new Set(expected.map((e) => serializeOutputCanonicalJson(e)))
      if (actual.length !== expected.length || actual.some((e) => !expectedTexts.has(e.document))) throw new Error('Inactive lineage row differs')
    }
    const candidate = command.payload.renderableCandidate
    const candidates = await client.$queryRawUnsafe<Array<{ candidateJson: string; candidateHash: string }>>(
      'SELECT "candidateJson","candidateHash" FROM project_fork_renderable_candidates WHERE "projectVersionId"=$1 AND "workspaceId"=$2 AND "projectId"=$3',input.versionId,input.workspaceId,input.projectId)
    if (candidates.length !== (candidate ? 1 : 0) || candidate && (candidates[0].candidateJson !== serializeOutputCanonicalJson(candidate) ||
      candidates[0].candidateHash !== createHash('sha256').update(candidates[0].candidateJson).digest('hex'))) throw new Error('Candidate factual seal differs')
    const derivation = command.payload.forkDerivation
    if (derivation) {
      const rows = await client.$queryRawUnsafe<Array<{ derivationJson: string; derivationHash: string }>>(
        'SELECT "derivationJson","derivationHash" FROM project_fork_derivations WHERE id=$1 AND "targetVersionId"=$2 AND "targetProjectId"=$3 AND "workspaceId"=$4',derivation.document.id,input.versionId,input.projectId,input.workspaceId)
      if (rows.length !== 1 || rows[0].derivationJson !== serializeOutputCanonicalJson(derivation.document) || rows[0].derivationHash !== derivation.derivationHash) throw new Error('Derivation factual row differs')
    }
    return bundle
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^P[0-9]{4}$/.test(error.code)) throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored contract-two output bundle failed factual document validation')
  }
}
/** A fork receipt owns only its immutable creation facts. Later media/Commands
 * may extend either project; replay never compares those mutable collections
 * to the receipt or claims its Version is the current head. */
export async function readPersistedForkCreationOutputBundleV3(client: Reader,
  input: Readonly<{workspaceId:string;projectId:string;versionId:string}>): Promise<Readonly<CreationOutputVersionBundleV2>|null> {
  const anchor = await readPersistedOperationalOutputBundleV3(client,input)
  if (!anchor) return null
  if (anchor.schemaVersion !== 'project-creation-output-bundle/v2' || anchor.command.payload.forkDerivation?.schemaVersion !== 'project-fork-derivation/v3')
    throw new DomainError('PERSISTENCE_CONFLICT','Fork3 receipt requires its exact Creation2/derivation3 bindings')
  const derivation = anchor.command.payload.forkDerivation
  const rows = await client.$queryRawUnsafe<Array<{derivationJson:string;derivationHash:string}>>(
    'SELECT "derivationJson","derivationHash" FROM project_fork_derivations WHERE id=$1 AND "targetVersionId"=$2 AND "targetProjectId"=$3 AND "workspaceId"=$4 AND "schemaVersion"=$5',
    derivation.document.id,input.versionId,input.projectId,input.workspaceId,derivation.schemaVersion)
  if (rows.length !== 1 || rows[0].derivationJson !== serializeOutputCanonicalJson(derivation.document) || rows[0].derivationHash !== derivation.derivationHash)
    throw new DomainError('PERSISTENCE_CONFLICT','Fork3 immutable derivation row differs')
  await client.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_fork_source_v3($1::jsonb,false)',serializeOutputCanonicalJson(derivation.document.kernel.document.source))
  for (const ref of derivation.document.sourceReferences) {
    const links = await client.$queryRawUnsafe<Array<{artifactId:string;role:string;originalFileName:string;uploadId:string|null;createdAt:Date}>>(
      'SELECT "artifactId",role,"originalFileName","uploadId","createdAt" FROM project_media_assets WHERE id=$1::uuid AND "projectId"=$2 AND "workspaceId"=$3',ref.targetLinkId,input.projectId,input.workspaceId)
    if (links.length !== 1 || links[0].artifactId !== ref.artifactId || links[0].role !== ref.role || links[0].originalFileName !== ref.originalFileName ||
      links[0].uploadId !== null || links[0].createdAt.toISOString() !== anchor.command.createdAt)
      throw new DomainError('PERSISTENCE_CONFLICT','Fork3 creation-owned media reference differs')
  }
  return anchor
}


import { buildOperationalOutputVersionBundleV3, editorialDerivedBindingV3, type OperationalOutputVersionBundleV3, type OperationalOutputParentV3 } from '../../domain/output-version-bundle.ts'
import { readOutputNormalizationsV3, readEditorialSourceBindingV1 } from './output-version-materializer.ts'
type OperationalAnchorCacheV3={rows:Map<string,Readonly<OperationalOutputParentV3>|null>;visiting:Set<string>}
/**
 * What one transaction has already proved about sealed Versions. A Version's bundle is immutable and the rows its assertions look at are
 * locked by the owner transaction (the project, its artifacts, the Versions it builds on), so a second full verification of the SAME
 * Version inside the same transaction cannot answer differently: it would repeat the database assertion, the row's two canonical
 * serializations and the whole reconstruction (seconds, on a State that embeds the master's receipt) to learn what the first one proved.
 * The cache lives for ONE owner transaction and is never shared across transactions, requests or the committed readback; it holds only
 * Versions that were read and verified in full (never a null, never a failure).
 */
export type OperationalReadCacheV3=Readonly<{anchors:OperationalAnchorCacheV3;bundles:Map<string,Readonly<OperationalOutputParentV3>>}>
export function createOperationalReadCacheV3():OperationalReadCacheV3 {
  return Object.freeze({anchors:{rows:new Map(),visiting:new Set<string>()},bundles:new Map()})
}
const verifiedCanonical=new WeakMap<object,string>()
async function readOperationalAnchorV3(client:Reader,input:Readonly<{workspaceId:string;projectId:string;versionId:string}>,cache:OperationalAnchorCacheV3) {
  const key=JSON.stringify([input.workspaceId,input.projectId,input.versionId])
  if(cache.visiting.has(key))throw new DomainError('PERSISTENCE_CONFLICT','Operational output dependency cycle')
  if(cache.rows.has(key))return cache.rows.get(key)!
  cache.visiting.add(key)
  try {
    const versions=await client.$queryRawUnsafe<Array<{outputContractVersion:number;outputStateId:string|null;outputStateHash:string|null;
      baseHash:string;outputBaseHashJson:string;outputVersionJson:string}>>(
      'SELECT "outputContractVersion","outputStateId","outputStateHash","baseHash","outputBaseHashJson","outputVersionJson" FROM project_versions WHERE id=$1 AND "projectId"=$2 AND "workspaceId"=$3',
      input.versionId,input.projectId,input.workspaceId)
    if(versions.length===0){cache.rows.set(key,null);return null}
    if(versions.length!==1)throw new Error('Version identity ambiguous')
    const v=versions[0]
    if(v.outputContractVersion!==2&&v.outputContractVersion!==3)throw new DomainError('PRECONDITION_REQUIRED','Unsealed historical Version is audit only')
    let anchor:OperationalOutputParentV3
    if(v.outputContractVersion===2) {
      // Creation-owned membership only: later child ingest legitimately adds
      // media links to Project. The immutable creation anchors still match.
      await client.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_creation_anchor_v3($1)',v.outputStateId)
      const rows=await client.$queryRawUnsafe<Array<{commandJson:string;stateJson:string;stateHash:string}>>(
        'SELECT c."commandJson",s."stateJson",s."stateHash" FROM project_output_states s JOIN project_creation_commands c ON c.id=s."creationCommandV2Id" AND c."workspaceId"=s."workspaceId" AND c."projectId"=s."projectId" WHERE s.id=$1 AND s."resultVersionId"=$2 AND s."workspaceId"=$3 AND s."projectId"=$4',
        v.outputStateId,input.versionId,input.workspaceId,input.projectId)
      if(rows.length!==1)throw new Error('Creation anchor missing')
      const r=rows[0]
      anchor=validateCreationOutputVersionBundleV2({schemaVersion:'project-creation-output-bundle/v2',command:JSON.parse(r.commandJson),
        state:{document:JSON.parse(r.stateJson),stateHash:r.stateHash},version:JSON.parse(v.outputVersionJson),outputBaseHashJson:v.outputBaseHashJson})
      if(serializeOutputCanonicalJson(anchor.command)!==r.commandJson||serializeOutputCanonicalJson(anchor.state.document)!==r.stateJson)
        throw new Error('Creation anchor noncanonical')
    } else {
      // Local SQL authority confronts actual rows, parent sequence/seals and all
      // materialized facts. No recursive ancestry expansion is needed.
      await client.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_operational_state_v3($1)',v.outputStateId)
      const rows=await client.$queryRawUnsafe<Array<{bundleJson:string;bundleHash:string;originJson:string;originHash:string}>>(
        'SELECT "bundleJson","bundleHash","originJson","originHash" FROM output_operational_bundles WHERE "versionId"=$1 AND "projectId"=$2 AND "workspaceId"=$3',
        input.versionId,input.projectId,input.workspaceId)
      if(rows.length!==1)throw new Error('Operational bundle missing')
      const r=rows[0]
      if(createHash('sha256').update(r.bundleJson).digest('hex')!==r.bundleHash||createHash('sha256').update(r.originJson).digest('hex')!==r.originHash)
        throw new Error('Operational row SHA differs')
      anchor=JSON.parse(r.bundleJson)
      if(serializeOutputCanonicalJson(anchor)!==r.bundleJson||serializeOutputCanonicalJson((anchor as Extract<typeof anchor,{origin:unknown}>).origin)!==r.originJson)
        throw new Error('Operational row raw authority differs')
      // The stored text IS the canonical text of this anchor (just proved): the reconstruction compares against it without serializing again.
      verifiedCanonical.set(anchor,r.bundleJson)
    }
    if(anchor.version.id!==input.versionId||anchor.version.workspaceId!==input.workspaceId||anchor.version.projectId!==input.projectId||
      anchor.version.outputContractVersion!==v.outputContractVersion||anchor.version.outputStateId!==v.outputStateId||
      anchor.version.outputStateHash!==v.outputStateHash||anchor.state.document.id!==v.outputStateId||anchor.state.stateHash!==v.outputStateHash||
      anchor.version.baseHash!==v.baseHash||anchor.outputBaseHashJson!==v.outputBaseHashJson||
      serializeOutputCanonicalJson(anchor.version)!==v.outputVersionJson)throw new Error('Factual anchor differs from Version row')
    cache.rows.set(key,anchor);return anchor
  } catch(error) {
    if(error instanceof DomainError&&error.code==='PRECONDITION_REQUIRED')throw error
    if(error&&typeof error==='object'&&'code' in error&&/^P[0-9]{4}$/.test(String(error.code)))throw error
    throw new DomainError('PERSISTENCE_CONFLICT','Stored operational output anchor failed factual validation')
  } finally {cache.visiting.delete(key)}
}
export async function readPersistedOperationalOutputBundleV3(client:Reader,input:Readonly<{
  workspaceId:string;projectId:string;versionId:string
}>,reuse?:OperationalReadCacheV3):Promise<Readonly<OperationalOutputParentV3>|null> {
  const bundleKey=JSON.stringify([input.workspaceId,input.projectId,input.versionId])
  const proved=reuse?.bundles.get(bundleKey)
  if(proved!==undefined)return proved
  const result=await readPersistedOperationalOutputBundleUncachedV3(client,input,reuse?.anchors??{rows:new Map(),visiting:new Set()})
  if(reuse) {
    // Only Versions that exist are remembered: a Version this transaction is about to write must read as absent until it does.
    for(const [key,anchor] of reuse.anchors.rows)if(anchor===null)reuse.anchors.rows.delete(key)
    if(result!==null)reuse.bundles.set(bundleKey,result)
  }
  return result
}
async function readPersistedOperationalOutputBundleUncachedV3(client:Reader,input:Readonly<{
  workspaceId:string;projectId:string;versionId:string
}>,cache:OperationalAnchorCacheV3):Promise<Readonly<OperationalOutputParentV3>|null> {
  const stored=await readOperationalAnchorV3(client,input,cache)
  if(!stored||stored.schemaVersion==='project-creation-output-bundle/v2')return stored
  try {
    const parent=await readOperationalAnchorV3(client,{...input,versionId:stored.state.document.parentVersionId},cache)
    if(!parent)throw new Error('Parent anchor missing')
    const origin=stored.origin,target=origin.kind==='restore-command'?
      await readOperationalAnchorV3(client,{...input,versionId:origin.target.versionId},cache):null
    const ns=stored.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[])
    // A cut copy (the cut itself, and every child that carries its binding) is built from the receipts that binding names, which
    // live in the original project; a project's own State is built from the receipts it persisted itself.
    const binding=origin.kind==='editorial-cut-command'?origin.command.payload.sourceBinding:editorialDerivedBindingV3(stored)
    if(binding!==null)await readEditorialSourceBindingV1(client as Prisma.TransactionClient,binding,{lock:false,currentRights:false})
    const actual=binding!==null?
      (await Promise.all(binding.document.normalizationRefs.map(ref=>readOutputNormalizationsV3(client,{
        workspaceId:input.workspaceId,projectId:ref.projectId,ids:[ref.id],lock:false})))).flat():
      await readStoredOrderNormalizations(client,{workspaceId:input.workspaceId,projectId:input.projectId,
        ids:[...new Set(ns.map(n=>n.document.id))]})
    const materializationIds=Object.fromEntries(stored.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?
      [[e.variantId,e.consumption.materialization.document.id]]:[]))
    // An editorial cut over a copy whose children only configured it binds the authority of the Creation fork it descends from.
    const forkRootId=origin.kind==='editorial-cut-command'&&origin.command.payload.sourceBinding.document.authority.kind==='fork-derivation3'?
      origin.command.payload.sourceBinding.document.authority.forkRootVersionId:null
    const forkRoot=forkRootId!==null&&forkRootId!==parent.version.id?await readOperationalAnchorV3(client,{...input,versionId:forkRootId},cache):null
    // A renderable compile publishes a row beside its Version: the reconstruction rebuilds the State's alternate plan from that stored row.
    const renderableSnapshot=origin.kind==='renderable-compile-command'?
      await readRenderableSnapshotFactsV3(client,{workspaceId:input.workspaceId,projectId:input.projectId,snapshotId:origin.command.payload.snapshot.id}):null
    const fresh=buildOperationalOutputVersionBundleV3({allocation:{workspaceId:input.workspaceId,projectId:input.projectId,
      resultVersionId:input.versionId,stateId:stored.state.document.id,parentVersionId:parent.version.id,sequence:stored.version.sequence,
      createdBy:stored.version.createdBy,createdAt:stored.version.createdAt},parent,origin,restoreTarget:target,
      ...(forkRoot&&forkRoot.schemaVersion==='project-creation-output-bundle/v2'?{forkRoot}:{}),
      ...(renderableSnapshot===null?{}:{renderableSnapshot}),
      editPlanSnapshot:stored.editPlanSnapshot,normalizations:actual,materializationIds,
      // A child Command's replaced non-output snapshots are born with its Version; the origin declares which.
      ...(origin.kind==='child-command'?{replacementSnapshots:stored.snapshots.filter(s=>(origin.replaces as readonly string[]).includes(s.kind))}:{})})
    const storedCanonical=verifiedCanonical.get(stored)??serializeOutputCanonicalJson(stored)
    if(serializeOutputCanonicalJson(JSON.parse(stableSerializeOperational(fresh)))!==storedCanonical)
      throw new Error(`Reconstructed operational bundle differs at ${bundleDifferences(JSON.parse(serializeOutputCanonicalJson(JSON.parse(stableSerializeOperational(fresh)))),JSON.parse(storedCanonical)).join('; ')||'$'}`)
    return fresh
  } catch(error) {
    if(error instanceof DomainError&&['PRECONDITION_REQUIRED','ASSET_RIGHTS_BLOCKED'].includes(error.code))throw error
    if(error&&typeof error==='object'&&'code' in error&&/^P[0-9]{4}$/.test(String(error.code)))throw error
    // The internal reason travels in the message (it is never published: the presenter answers a bare persistence conflict).
    throw new DomainError('PERSISTENCE_CONFLICT',`Stored operational output bundle failed factual reconstruction: ${error instanceof Error?error.message:String(error)}`.slice(0,2400))
  }
}
import { stableSerialize as stableSerializeOperational } from '../../domain/canonical-hash.ts'
import { OUTPUT_CONSUMPTION_PURPOSES, outputConsumptionVerdictV3, outputConsumptionSealV3, outputConsumptionSealHashV3, outputEntryAspectRatio, publishedConsumptionReason,
  type OutputConsumptionEntry, type OutputConsumptionPurpose, type OutputConsumptionSealV3, type OutputConsumptionState, type OutputConsumptionVersion } from '../../domain/output-consumption.ts'
import type { ProjectOutputStateV2, ProjectOutputStateV3 } from '../../domain/project-output-state.ts'
import type { V2RenderablePlanSnapshotFacts } from '../../domain/project-fork-derivation.ts'
/** The stored row of a renderable plan snapshot, as the facts the bundle builder validates. */
async function readRenderableSnapshotFactsV3(client:Reader,input:Readonly<{workspaceId:string;projectId:string;snapshotId:string}>):Promise<Readonly<V2RenderablePlanSnapshotFacts>> {
  const rows=await client.$queryRawUnsafe<Array<Omit<V2RenderablePlanSnapshotFacts,'createdAt'>&{createdAt:Date}>>(
    'SELECT id,"workspaceId","projectId","projectVersionId","planId",origin,"sourceId","sourceHash","sourceVersion",fps,"durationFrames","clipCount","planJson","planHash","createdAt" FROM renderable_plan_snapshots WHERE id=$1 AND "workspaceId"=$2 AND "projectId"=$3',
    input.snapshotId,input.workspaceId,input.projectId)
  if(rows.length!==1)throw new Error('The renderable plan snapshot the Version binds is missing')
  const row=rows[0]
  return Object.freeze({...row,createdAt:row.createdAt.toISOString()})
}
/**
 * The receipts a State materialized, in the order that State lists them. The store answers in its own order; a State lists its
 * inherited observations before the ones a child adopted, so the order is part of what the reconstruction must reproduce.
 */
async function readStoredOrderNormalizations(client:Reader,input:Readonly<{workspaceId:string;projectId:string;ids:readonly string[]}>) {
  const read=await readOutputNormalizationsV3(client,{...input,lock:false})
  const byId=new Map(read.map(n=>[n.document.id,n]))
  return input.ids.flatMap(id=>{const found=byId.get(id);return found?[found]:[]})
}
/** The paths (keys in order, at most eight) at which two canonical documents differ: only what makes a reconstruction mismatch diagnosable. */
function bundleDifferences(left:unknown,right:unknown,path='$',found:string[]=[]):string[] {
  if(found.length>=8||Object.is(left,right))return found
  if(typeof left==='string'&&typeof right==='string'&&left.startsWith('{')&&right.startsWith('{')) {
    try { return bundleDifferences(JSON.parse(left),JSON.parse(right),path,found) } catch { /* not JSON text: compared as a value below */ }
  }
  if(typeof left!=='object'||typeof right!=='object'||left===null||right===null) {
    found.push(`${path} (${JSON.stringify(left)?.slice(0,100)} vs ${JSON.stringify(right)?.slice(0,100)})`)
    return found
  }
  const a=left as Record<string,unknown>,b=right as Record<string,unknown>
  for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort())bundleDifferences(a[key],b[key],`${path}.${key}`,found)
  return found
}
export type PersistedOutputConsumptionV3=Readonly<
  {status:'blocked';outputContractVersion:2|3;outputStateId:string;outputStateHash:string;reasons:readonly string[]} |
  {status:'materialized';outputContractVersion:3;bundle:OperationalOutputVersionBundleV3;
    entry:OperationalOutputVersionBundleV3['state']['document']['entries'][number]}
>
/**
 * Whether the TARGET project owns a perception authority of its own: a server perception snapshot written by a Director run of this very
 * project (the only writer of that table). Only a cut copy asks (a State that keeps its fork lineage, read for the `final` purpose); every
 * other State answers without a query. The source project's perception is never adopted: the copy has to run its own Director.
 */
export async function readTargetPerceptionAuthorityV3(client:Reader,scope:Readonly<{workspaceId:string;projectId:string}>,
  state:OutputConsumptionState,purpose:OutputConsumptionPurpose):Promise<boolean> {
  if(purpose!=='final'||state.document.schemaVersion==='project-output-state/v2'||state.document.sourceDependencies===null)return false
  const rows=await client.$queryRawUnsafe<Array<{found:number}>>(
    'SELECT 1 AS found FROM server_perception_snapshots WHERE "workspaceId"=$1 AND "projectId"=$2 LIMIT 1',scope.workspaceId,scope.projectId)
  return rows.length>0
}

/** Geometry/clock dependency admission only. No critic approval, render permit
 * or final publication is inferred. Runtime consumers must also evaluate their
 * current rights/lease/quality fences inside their owner transaction. The verdict itself is the domain's
 * (`outputConsumptionVerdictV3`); this audit read rebuilds the exact bundle first and applies it. */
export async function readPersistedOutputConsumptionV3(client:Reader,input:Readonly<{
  workspaceId:string;projectId:string;versionId:string;variantId:string;purpose:OutputConsumptionPurpose
}>):Promise<PersistedOutputConsumptionV3> {
  if(!(OUTPUT_CONSUMPTION_PURPOSES as readonly string[]).includes(input.purpose))throw new DomainError('PERSISTENCE_CONFLICT','Unknown output consumption purpose')
  const b=await readPersistedOperationalOutputBundleV3(client,input)
  if(!b)throw new DomainError('PRECONDITION_REQUIRED','Requested operational output Version missing')
  const verdict=outputConsumptionVerdictV3(b.state,input.variantId,input.purpose,
    await readTargetPerceptionAuthorityV3(client,input,b.state as OutputConsumptionState,input.purpose))
  if(verdict.status==='blocked')return Object.freeze({status:'blocked',outputContractVersion:b.schemaVersion==='project-creation-output-bundle/v2'?2:3,
    outputStateId:b.state.document.id,outputStateHash:b.state.stateHash,reasons:verdict.reasons})
  return Object.freeze({status:'materialized',outputContractVersion:3,bundle:b as OperationalOutputVersionBundleV3,entry:verdict.entry})
}

/** The sealed State a Version carries, read from its own rows: the State row must be the one the Version row seals, byte for byte. */
export type StoredOutputStateV3=Readonly<{version:OutputConsumptionVersion;state:OutputConsumptionState;
  /** Whether the project owns a server perception snapshot of its own (see `readTargetPerceptionAuthorityV3`): read in the same statement as the State. */
  targetPerceptionAuthority:boolean}>
/**
 * The cheap read every consumer can afford inside its owner transaction (a handful of rows, no reconstruction): the Version row and
 * the State row it seals. The State is append-only and database-guarded when written, so the row is as authoritative as the
 * bundle that produced it; the full rebuild (`readPersistedOperationalOutputBundleV3`) stays the audit read.
 */
export async function readStoredOutputStateV3(client:Reader,input:Readonly<{workspaceId:string;projectId:string;versionId:string}>):Promise<StoredOutputStateV3|null> {
  const rows=await client.$queryRawUnsafe<Array<{outputContractVersion:number;baseHash:string;outputStateId:string|null;outputStateHash:string|null;
    stateJson:string|null;stateHash:string|null;schemaVersion:string|null;targetPerception:boolean|null}>>(
    'SELECT v."outputContractVersion",v."baseHash",v."outputStateId",v."outputStateHash",s."stateJson",s."stateHash",s."schemaVersion",EXISTS(SELECT 1 FROM server_perception_snapshots p WHERE p."workspaceId"=v."workspaceId" AND p."projectId"=v."projectId") AS "targetPerception" FROM project_versions v LEFT JOIN project_output_states s ON s.id=v."outputStateId" AND s."resultVersionId"=v.id AND s."projectId"=v."projectId" AND s."workspaceId"=v."workspaceId" WHERE v.id=$1 AND v."projectId"=$2 AND v."workspaceId"=$3',
    input.versionId,input.projectId,input.workspaceId)
  if(rows.length===0)return null
  if(rows.length!==1)throw new DomainError('PERSISTENCE_CONFLICT','Stored output Version identity is ambiguous')
  const row=rows[0]!
  if(row.outputContractVersion!==2&&row.outputContractVersion!==3)
    throw new DomainError('PRECONDITION_REQUIRED','Unsealed historical Version is audit only',{reason:'output-not-consumable'})
  const expectedSchema=row.outputContractVersion===2?'project-output-state/v2':'project-output-state/v3'
  if(row.stateJson===null||row.stateHash===null||row.schemaVersion!==expectedSchema||row.outputStateHash!==row.stateHash)
    throw new DomainError('PERSISTENCE_CONFLICT','Stored output State differs from the State its Version seals')
  // The State hash is the SHA-256 of the canonical text (`calculateOutputCanonicalHash`), so the stored text is that text exactly when its own SHA-256 is the
  // hash the Version seals: no need to parse, re-serialize canonically and hash again. This runs on the event loop of every consumer right after a claim (a
  // sealed State of a 30 s master is over a megabyte), and the re-serialization alone was ~20 ms: more than the 30 ms in which a `tsx` launcher waits for a
  // worker to acknowledge a relayed SIGTERM before it kills the worker with its claim still running (Wave 23 journey 2).
  if(createHash('sha256').update(row.stateJson,'utf8').digest('hex')!==row.stateHash)
    throw new DomainError('PERSISTENCE_CONFLICT','Stored output State failed its own seal')
  let document:ProjectOutputStateV2['document']|ProjectOutputStateV3['document']
  try { document=JSON.parse(row.stateJson) } catch { throw new DomainError('PERSISTENCE_CONFLICT','Stored output State is not valid JSON') }
  if(document.schemaVersion!==expectedSchema||document.resultVersionId!==input.versionId||document.projectId!==input.projectId||document.workspaceId!==input.workspaceId||
    document.id!==row.outputStateId)
    throw new DomainError('PERSISTENCE_CONFLICT','Stored output State failed its own seal')
  return Object.freeze({version:Object.freeze({id:input.versionId,baseHash:row.baseHash}),
    state:Object.freeze({document,stateHash:row.stateHash}) as OutputConsumptionState,targetPerceptionAuthority:row.targetPerception===true})
}

export type RequiredOutputConsumptionV3=Readonly<{
  version:OutputConsumptionVersion
  state:Readonly<ProjectOutputStateV3>
  entry:OutputConsumptionEntry
  /** The aspect ratio the entry's sealed spec carries (null when it carries none): the one answer for "what format is this output". */
  aspectRatio:string|null
  seal:OutputConsumptionSealV3
  sealHash:string
}>
/**
 * The single place every consumer asks "may I consume this output?". It reads the exact Version (never the head, never the
 * project's format), applies the domain verdict for the purpose and answers either the exact State, entry and seal to put in the
 * consumer's context and input hash, or a PRECONDITION_REQUIRED whose `details.reason` names why (published by the presenter).
 * `variantId` absent means the State's only output. `reconstruct: true` rebuilds the whole bundle first (the audit read); the
 * default reads the sealed rows, which is what an owner transaction can afford.
 */
export async function requirePersistedOutputConsumptionV3(client:Reader,input:Readonly<{
  workspaceId:string;projectId:string;versionId:string;variantId?:string;purpose:OutputConsumptionPurpose;reconstruct?:boolean
}>):Promise<RequiredOutputConsumptionV3> {
  if(!(OUTPUT_CONSUMPTION_PURPOSES as readonly string[]).includes(input.purpose))throw new DomainError('PERSISTENCE_CONFLICT','Unknown output consumption purpose')
  const stored=input.reconstruct===true?await (async()=>{
    const b=await readPersistedOperationalOutputBundleV3(client,input)
    return b?Object.freeze({version:Object.freeze({id:b.version.id,baseHash:b.version.baseHash}),state:b.state as OutputConsumptionState,
      targetPerceptionAuthority:await readTargetPerceptionAuthorityV3(client,input,b.state as OutputConsumptionState,input.purpose)}):null
  })():await readStoredOutputStateV3(client,input)
  if(!stored)throw new DomainError('PRECONDITION_REQUIRED','Requested operational output Version missing',{reason:'output-version-missing'})
  const verdict=outputConsumptionVerdictV3(stored.state,input.variantId,input.purpose,
    stored.targetPerceptionAuthority)
  if(verdict.status==='blocked')throw new DomainError('PRECONDITION_REQUIRED','Output is not consumable for this purpose',
    {reason:publishedConsumptionReason(verdict.reasons),purpose:input.purpose,outputStateId:stored.state.document.id,reasons:verdict.reasons})
  const state=stored.state as Readonly<ProjectOutputStateV3>
  const seal=outputConsumptionSealV3(stored.version,state,verdict.entry,input.purpose)
  return Object.freeze({version:stored.version,state,entry:verdict.entry,aspectRatio:outputEntryAspectRatio(verdict.entry),seal,sealHash:outputConsumptionSealHashV3(seal)})
}
