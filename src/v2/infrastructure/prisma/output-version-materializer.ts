import type { Prisma } from '../../../../generated/prisma-v2/index.js'
import { DomainError } from '../../domain/errors.ts'
import { serializeOutputCanonicalJson } from '../../domain/output-canonical-policy.ts'
import { validateOutputNormalizationV3, type SealedOutputNormalizationV3 } from '../../domain/output-materialization.ts'

type Tx=Pick<Prisma.TransactionClient,'$queryRawUnsafe'>
/** The caller owns the transaction and locks operation then Project before this
 * helper. Source artifacts are acquired once in UTF8/C order; normalizations and
 * manifests follow. Neither content hashes nor maps grant rights/quality. */
export async function readOutputNormalizationsV3(tx:Tx,input:Readonly<{
  workspaceId:string;projectId:string;ids:readonly string[];lock:boolean
}>):Promise<readonly Readonly<SealedOutputNormalizationV3>[]> {
  if(input.ids.length===0)return Object.freeze([])
  const ids=[...new Set(input.ids)].sort((a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8')))
  if(ids.length!==input.ids.length || ids.length>4096)throw new DomainError('PERSISTENCE_CONFLICT','Normalization membership is ambiguous')
  const placeholders=ids.map((_,i)=>'$'+(i+3)).join(',')
  // Discovery reads no grant. Re-read after source locks avoids preserving an
  // authority row changed while waiting under Serializable.
  const discovery=await tx.$queryRawUnsafe<Array<{sourceArtifactId:string;derivativeArtifactId:string}>>(
    'SELECT "sourceArtifactId","derivativeArtifactId" FROM output_normalization_receipts WHERE "workspaceId"=$1 AND "projectId"=$2 AND id IN ('+placeholders+')',
    input.workspaceId,input.projectId,...ids)
  if(discovery.length!==ids.length)throw new DomainError('PERSISTENCE_CONFLICT','Requested normalization fact missing')
  if(input.lock) {
    const artifacts=[...new Set(discovery.flatMap(r=>[r.sourceArtifactId,r.derivativeArtifactId]))]
      .sort((a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8')))
    const held=await tx.$queryRawUnsafe<Array<{id:string}>>(
      'SELECT id FROM media_artifacts WHERE "workspaceId"=$1 AND id IN ('+artifacts.map((_,i)=>'$'+(i+2)).join(',')+') ORDER BY id COLLATE "C" FOR UPDATE',
      input.workspaceId,...artifacts)
    if(held.length!==artifacts.length)throw new DomainError('PERSISTENCE_CONFLICT','Normalization source artifact missing')
  }
  const rows=await tx.$queryRawUnsafe<Array<{id:string;receiptJson:string;receiptHash:string}>>(
    'SELECT id,"receiptJson","receiptHash" FROM output_normalization_receipts WHERE "workspaceId"=$1 AND "projectId"=$2 AND id IN ('+
      placeholders+') ORDER BY id COLLATE "C"'+(input.lock?' FOR SHARE':''),
    input.workspaceId,input.projectId,...ids)
  if(rows.length!==ids.length)throw new DomainError('PERSISTENCE_CONFLICT','Normalization facts changed after discovery')
  const result:SealedOutputNormalizationV3[]=[]
  for(const row of rows) {
    await tx.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_normalization_v3($1,$2,$3)',row.id,input.projectId,input.workspaceId)
    try {
      const sealed=validateOutputNormalizationV3({document:JSON.parse(row.receiptJson),receiptHash:row.receiptHash})
      if(sealed.document.id!==row.id || sealed.document.workspaceId!==input.workspaceId ||
        sealed.document.projectId!==input.projectId || serializeOutputCanonicalJson(sealed.document)!==row.receiptJson)
        throw new Error('Row mismatch')
      result.push(sealed)
    } catch {throw new DomainError('PERSISTENCE_CONFLICT','Stored normalization document failed factual validation')}
  }
  return Object.freeze(result)
}

/**
 * Under the commit transaction: every receipt a child Version adopted is still persisted exactly as it was sealed,
 * its artifacts are locked (UTF8/C order, before any rights read), and the rights it was adopted under are still
 * the current ones. A recording whose rights moved since the Command was sealed is a stale Command (VERSION_CONFLICT):
 * it is re-sealed against the rights now current. The asset-use policy over the final materialization
 * (assertCurrentOutputSourceUseV3) runs after this and has the last word.
 */
export async function assertAdoptedObservationsCurrentV3(tx:Prisma.TransactionClient,bundle:OperationalOutputVersionBundleV3) {
  if(bundle.origin.kind!=='child-command'||bundle.origin.adoptions.length===0)return
  const {workspaceId,projectId}=bundle.version,adoptions=bundle.origin.adoptions
  const stored=await readOutputNormalizationsV3(tx,{workspaceId,projectId,ids:adoptions.map(a=>a.receiptId),lock:true})
  for(const adoption of adoptions) {
    const receipt=stored.find(n=>n.document.id===adoption.receiptId)
    if(!receipt||receipt.receiptHash!==adoption.receiptHash||receipt.document.source.artifactId!==adoption.sourceArtifactId||
      receipt.document.source.manifestId!==adoption.sourceManifestId||receipt.document.source.manifest.manifestHash!==adoption.sourceManifestHash)
      throw new DomainError('PERSISTENCE_CONFLICT','An adopted observation is not the persisted receipt it names',{receiptId:adoption.receiptId})
  }
  const artifacts=await tx.v2MediaArtifact.findMany({where:{workspaceId,id:{in:adoptions.map(a=>a.sourceArtifactId)}},include:{currentRightsSnapshot:true}})
  for(const adoption of adoptions) {
    const artifact=artifacts.find(a=>a.id===adoption.sourceArtifactId),snapshot=artifact?.currentRightsSnapshot
    if(!artifact||!snapshot||snapshot.id!==adoption.rights.snapshotId||snapshot.snapshotHash!==adoption.rights.snapshotHash||artifact.rightsRevision!==adoption.rights.revision)
      throw new DomainError('VERSION_CONFLICT','The rights an adopted recording was sealed under are no longer current',{artifactId:adoption.sourceArtifactId})
  }
}

import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import type { OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
/** This narrow publication guard uses the existing asset-use policy. Its
 * role allowlist is the proxy authority allowlist; the operational derivative
 * has its own available artifact and rendering grant, never inherited consent. */
export async function assertCurrentOutputSourceUseV3(tx:Prisma.TransactionClient,bundle:OperationalOutputVersionBundleV3) {
  const mats=bundle.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?[e.consumption.materialization.document]:[])
  const facts=mats.flatMap(m=>m.normalizations.flatMap(n=>[n.document.source,n.document.derivative]))
  const byId=new Map(facts.map(f=>[f.artifactId,f]))
  if(!byId.size)return
  const project=await tx.v2Project.findFirst({where:{id:bundle.version.projectId,workspaceId:bundle.version.workspaceId},select:{locale:true}})
  if(!project?.locale)throw new DomainError('PERSISTENCE_CONFLICT','Output source locale missing')
  const sources=await tx.v2MediaArtifact.findMany({where:{workspaceId:bundle.version.workspaceId,id:{in:[...byId.keys()]}},include:{currentRightsSnapshot:true}})
  const links=await tx.v2ProjectMediaAsset.findMany({where:{workspaceId:bundle.version.workspaceId,projectId:bundle.version.projectId,artifactId:{in:[...byId.keys()]}}})
  // Clock follows ALL reads, immediately before synchronous policy evaluation.
  const clocks=await tx.$queryRawUnsafe<Array<{now:Date}>>('SELECT clock_timestamp() AS now')
  const now=clocks[0]?.now
  if(clocks.length!==1||!(now instanceof Date)||Number.isNaN(now.getTime()))throw new DomainError('PERSISTENCE_CONFLICT','Output source clock unavailable')
  if(sources.length!==byId.size)throw new DomainError('PERSISTENCE_CONFLICT','Output source disappeared')
  for(const artifact of sources) {
    const fact=byId.get(artifact.id)!,matches=links.filter(l=>l.artifactId===artifact.id),m=fact.manifest.artifact
    if(matches.length!==1||artifact.status!=='available'||artifact.artifactKey!==m.artifactKey||artifact.sha256!==m.sha256||
      artifact.byteSize!==BigInt(m.byteSize)||artifact.mediaType!==m.mediaType||artifact.container!==m.container)
      throw new DomainError('PERSISTENCE_CONFLICT','Output source association or bytes contradict materialization')
    const link=matches[0]!
    let use:'rendering'|'editorial-reuse'
    if(link.role==='source-master'&&artifact.mediaType==='video'||link.role==='source-audio'&&artifact.mediaType==='audio'||
      link.role==='editing-proxy'&&artifact.mediaType==='video')use='rendering'
    else if(link.role==='selected-insert'&&['video','audio'].includes(artifact.mediaType))use='editorial-reuse'
    else throw new DomainError('PERSISTENCE_CONFLICT','Unsupported output source role/media type')
    const music=[...new Map(mats.flatMap(m=>Array.isArray(m.audioTracks)?m.audioTracks:[]).filter(t=>t&&typeof t==='object'&&!Array.isArray(t)&&t.artifactId===artifact.id)
      .map(t=>[serializeOutputCanonicalJson(t),t])).values()]
    if(music.length) {
      if(music.length!==1||!artifact.currentRightsSnapshot||artifact.currentRightsSnapshot.id!==(music[0] as {rightsSnapshotId?:unknown}).rightsSnapshotId||
        artifact.currentRightsSnapshot.status!=='approved'||artifact.currentRightsSnapshot.expiresAt&&artifact.currentRightsSnapshot.expiresAt<=now)
        throw new DomainError('ASSET_RIGHTS_BLOCKED','Music source no longer has its approved current pinned rights')
    } else {
      const rights=artifact.currentRightsSnapshot?hydrateAssetRights(artifact.currentRightsSnapshot):null
      if(evaluateAssetUse(rights,{workspaceId:bundle.version.workspaceId,use,locale:project.locale},now).outcome!=='allow')
        throw new DomainError('ASSET_RIGHTS_BLOCKED','Output source current rights/consent deny use')
    }
  }
}

import { createEditorialSourceBindingV1, type EditorialSourceBindingV1 } from '../../domain/output-materialization.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { PrismaAssetRightsRepository } from './asset-rights-repository.ts'
/** Caller has locked both projects in C order before artifacts. This validates
 * original immutable producers; it never creates target transcript/receipt rows.
 * Historical readback confronts the immutable snapshot, current TX additionally
 * confronts the audited pointer/revision and evaluates its current rights. */
export async function readEditorialSourceBindingV1(tx:Prisma.TransactionClient,binding:EditorialSourceBindingV1,
  options:Readonly<{lock:boolean;currentRights:boolean}>):Promise<Readonly<EditorialSourceBindingV1>> {
  const fresh=createEditorialSourceBindingV1(binding.document),d=fresh.document
  if(fresh.bindingHash!==binding.bindingHash)throw new DomainError('PERSISTENCE_CONFLICT','Editorial binding seal differs')
  const ids=[...new Set(d.inventory.map(i=>i.artifactId))].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
  if(options.lock) {
    const held=await tx.$queryRawUnsafe<Array<{id:string}>>('SELECT id FROM media_artifacts WHERE "workspaceId"=$1 AND id IN ('+
      ids.map((_,i)=>'$'+(i+2)).join(',')+') ORDER BY id COLLATE "C" FOR UPDATE',d.workspaceId,...ids)
    if(held.length!==ids.length)throw new DomainError('PERSISTENCE_CONFLICT','Editorial source artifact disappeared')
  }
  const transcript=await tx.v2MediaTranscript.findFirst({where:{id:d.transcript.id,workspaceId:d.workspaceId,
    projectId:d.transcript.projectId,sourceArtifactId:d.transcript.sourceArtifactId,sourceManifestId:d.transcript.sourceManifestId}})
  if(!transcript||transcript.transcriptHash!==d.transcript.document.transcriptHash||transcript.transcriptJson!==stableSerialize(d.transcript.document)||
    transcript.createdAt.toISOString()!==d.transcript.createdAt)throw new DomainError('PERSISTENCE_CONFLICT','Editorial original transcript producer differs')
  const links=await tx.v2ProjectMediaAsset.findMany({where:{projectId:d.projectId,workspaceId:d.workspaceId}})
  if(options.currentRights&&links.length!==d.inventory.length||d.inventory.some(i=>!links.some(l=>l.id===i.linkId&&l.artifactId===i.artifactId&&l.role===i.role)))
    throw new DomainError('PERSISTENCE_CONFLICT','Editorial exact target inventory differs')
  const artifacts=await tx.v2MediaArtifact.findMany({where:{workspaceId:d.workspaceId,id:{in:ids}},include:{currentRightsSnapshot:true}})
  const project=await tx.v2Project.findFirst({where:{id:d.projectId,workspaceId:d.workspaceId},select:{locale:true,status:true}})
  if(!project?.locale||options.currentRights&&project.status==='archived'||artifacts.length!==ids.length)throw new DomainError('PERSISTENCE_CONFLICT','Editorial target lifecycle/locale differs')
  const rights=options.currentRights?await new PrismaAssetRightsRepository(tx).findCurrentForArtifacts(d.workspaceId,ids):null
  const decisions:{snapshot:ReturnType<typeof hydrateAssetRights>|null;use:'rendering'|'editorial-reuse';artifactId:string}[]=[]
  for(const i of d.inventory) {
    const a=artifacts.find(a=>a.id===i.artifactId)!
    const manifest=await tx.v2MediaArtifactManifest.findFirst({where:{id:i.manifestId,artifactId:i.artifactId,workspaceId:d.workspaceId}})
    if(!manifest||manifest.manifestHash!==i.manifestHash||a.sha256!==i.artifactSha256||options.currentRights&&a.status!=='available')
      throw new DomainError('PERSISTENCE_CONFLICT','Editorial bound manifest/bytes/lifecycle differs')
    const pinned=i.rightsSnapshotId?await tx.v2AssetRightsSnapshot.findFirst({where:{id:i.rightsSnapshotId,artifactId:i.artifactId,workspaceId:d.workspaceId}}):null
    if((pinned?.snapshotHash??null)!==i.rightsHash||pinned&&pinned.sequence>i.rightsRevision)
      throw new DomainError('PERSISTENCE_CONFLICT','Editorial immutable rights binding differs')
    if(options.currentRights) {
      const current=rights!.get(i.artifactId)??null
      if(a.currentRightsSnapshotId!==i.rightsSnapshotId||a.rightsRevision!==i.rightsRevision||
        (current?.id??null)!==i.rightsSnapshotId||(current?.snapshotHash??null)!==i.rightsHash)
        throw new DomainError('VERSION_CONFLICT','Editorial current audited rights binding changed')
      const use=i.role==='selected-insert'?'editorial-reuse':
        (i.role==='source-master'||i.role==='editing-proxy')&&a.mediaType==='video'||i.role==='source-audio'&&a.mediaType==='audio'?'rendering':null
      if(!use)throw new DomainError('PERSISTENCE_CONFLICT','Editorial inventory role has no authority')
      decisions.push({snapshot:current,use,artifactId:i.artifactId})
    }
  }
  for(const r of d.normalizationRefs) {
    const ns=await readOutputNormalizationsV3(tx,{workspaceId:d.workspaceId,projectId:r.projectId,ids:[r.id],lock:false})
    if(ns[0]?.receiptHash!==r.receiptHash)throw new DomainError('PERSISTENCE_CONFLICT','Editorial original normalization reference differs')
  }
  // Current evaluations are synchronous after every authority read.
  if(options.currentRights) {
    const rows=await tx.$queryRawUnsafe<Array<{now:Date}>>('SELECT clock_timestamp() AS now'),now=rows[0]?.now
    if(rows.length!==1||!(now instanceof Date)||Number.isNaN(now.getTime()))throw new DomainError('PERSISTENCE_CONFLICT','Editorial rights clock unavailable')
    for(const x of decisions)if(evaluateAssetUse(x.snapshot,{workspaceId:d.workspaceId,use:x.use,locale:project.locale},now).outcome!=='allow')
      throw new DomainError('ASSET_RIGHTS_BLOCKED','Editorial target rights deny actual reused source',{artifactId:x.artifactId})
  }
  return fresh
}
