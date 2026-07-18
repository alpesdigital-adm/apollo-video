import { createHash } from 'node:crypto';

export type FoundationWorkspace = { id: string; ownerId: string; status: 'active' | 'suspended' | 'archived'; createdAt: string; updatedAt: string; settings: { version: number; locale: string; retentionDays: number } };
export function createFoundationWorkspace(input: { id: string; ownerId: string; locale?: string; now?: string }): FoundationWorkspace { const now=input.now??new Date().toISOString(); if(!input.id||!input.ownerId) throw new Error('workspace-identity-required'); return {id:input.id,ownerId:input.ownerId,status:'active',createdAt:now,updatedAt:now,settings:{version:1,locale:input.locale??'pt-BR',retentionDays:90}}; }
export function resolveWorkspaceActor(workspace: FoundationWorkspace, actor: { workspaceId: string; role: string }) { if(actor.workspaceId!==workspace.id||workspace.status!=='active') throw new Error('workspace-access-denied'); return {...actor,resolvedServerSide:true}; }

export type BrandKit = { version: number; colors?: string[]; logos?: { assetId:string;checksum:string;rightsId:string }[]; handles?: {instagram?:string;youtube?:string}; professional?:string; company?:string; introAssetId?:string; instructions?:string };
export function resolveBrandKit(kit?:Partial<BrandKit>,use=false):BrandKit|undefined { if(!use||!kit) return undefined; return {version:kit.version??1,...kit}; }

export type GuardrailRule={kind:'allow'|'deny'|'require'|'disclosure'|'escalation';subject:string;value:string;source:'owner';version:number};
export function compileOwnerGuardrails(instructions:string,version=1):GuardrailRule[]{ return instructions.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const match=line.match(/^(allow|deny|require|disclosure|escalation)\s+([^:]+):\s*(.+)$/i);if(!match)throw new Error('unstructured-guardrail');return {kind:match[1].toLowerCase() as GuardrailRule['kind'],subject:match[2].trim(),value:match[3].trim(),source:'owner',version}}); }
export function treatIngestedContent(value:string){return {value,channel:'untrusted-content' as const,instructions:[] as never[]};}

export type PolicyLayer='legal-platform'|'workspace'|'project'|'briefing'|'learned-preference';
const POLICY_PRIORITY:PolicyLayer[]=['legal-platform','workspace','project','briefing','learned-preference'];
export type PolicyRule={id:string;layer:PolicyLayer;subject:string;effect:'allow'|'deny'|'require';value:string;version:number};
export function resolvePolicy(rules:PolicyRule[]){const conflicts:string[]=[];const winners:PolicyRule[]=[];for(const subject of new Set(rules.map(x=>x.subject))){const same=rules.filter(x=>x.subject===subject);for(const layer of POLICY_PRIORITY){const at=same.filter(x=>x.layer===layer);if(!at.length)continue;if(new Set(at.map(x=>`${x.effect}:${x.value}`)).size>1){conflicts.push(`${subject}:${layer}`);break}winners.push(at[0]);break}}return {allowed:!conflicts.length,winners,conflicts,decisionLog:winners.map(x=>({ruleId:x.id,reason:`highest-priority:${x.layer}`}))};}
export function createPolicySnapshot(input:{rules:PolicyRule[];brandKit?:BrandKit;consentVersions:string[]}){const canonical=JSON.stringify(input);return {id:`policy-${createHash('sha256').update(canonical).digest('hex').slice(0,16)}`,createdAt:new Date(0).toISOString(),...structuredClone(input),immutable:true};}

export type MasterAsset={id:string;workspaceId:string;state:'uploading'|'verifying'|'ready'|'quarantined'|'deleted';storageKey:string;checksum?:string;bytes?:number};
export function transitionMaster(asset:MasterAsset,next:MasterAsset['state'],verification?:{checksum:string;bytes:number}){const allowed:Record<MasterAsset['state'],Array<MasterAsset['state']>>={uploading:['verifying','deleted'],verifying:['ready','quarantined','deleted'],ready:['deleted'],quarantined:['deleted'],deleted:[]};if(!allowed[asset.state].includes(next))throw new Error('invalid-master-transition');return {...asset,state:next,...(next==='ready'?verification:{})};}
export function createDerivative(master:MasterAsset,recipe:{id:string;version:string;toolVersion:string},checksum:string){if(master.state!=='ready')throw new Error('master-not-ready');return {id:`${master.id}:derivative:${recipe.id}@${recipe.version}`,parentAssetId:master.id,recipe,checksum,immutable:true};}
export function checksumChunks(chunks:Iterable<Uint8Array>){const hash=createHash('sha256');let bytes=0;for(const chunk of chunks){hash.update(chunk);bytes+=chunk.byteLength}return {checksum:hash.digest('hex'),bytes,loadedWholeFile:false};}
export function canonicalObjectKey(checksum:string){if(!/^[a-f0-9]{64}$/.test(checksum))throw new Error('invalid-checksum');return `sha256/${checksum.slice(0,2)}/${checksum}`;}

export type NormalizationRecipe={id:string;version:string;codec:string;container:string;audio:string;resolution:string;frameRate:string;toolVersion:string};
export function planNormalization(master:MasterAsset,recipe:NormalizationRecipe){if(master.state!=='ready'||!master.checksum)throw new Error('master-not-normalizable');const key=createHash('sha256').update(`${master.checksum}:${JSON.stringify(recipe)}`).digest('hex');return {jobId:`normalize:${key.slice(0,16)}`,idempotencyKey:key,parentAssetId:master.id,recipe,status:'queued' as const,lineage:{sourceChecksum:master.checksum,toolVersion:recipe.toolVersion}};}

export type TimebaseMetadata={ptsStart:number;dtsStart:number;timebase:{num:number;den:number};nominalFps:number;realFps:number;durationTicks:number};
export function sourceTickToSeconds(meta:TimebaseMetadata,tick:number){return tick*meta.timebase.num/meta.timebase.den;}
export function sourceTickToFrame(meta:TimebaseMetadata,tick:number,timelineFps:number){return Math.round(sourceTickToSeconds(meta,tick)*timelineFps);}
export function frameToSourceTick(meta:TimebaseMetadata,frame:number,timelineFps:number){return Math.round(frame/timelineFps*meta.timebase.den/meta.timebase.num);}

export type UsageRights={status:'allowed'|'unknown'|'restricted'|'expired'|'revoked';owner:string;license:string;uses:string[];territories:string[];locales:string[];expiresAt?:string;consent:'granted'|'not-required'|'missing'};
export function authorizeAssetUse(rights:UsageRights,input:{use:string;territory:string;locale:string;now:string;authorizedReview?:boolean}){const expired=rights.expiresAt&&new Date(rights.expiresAt)<=new Date(input.now);const reasons=[...(rights.status!=='allowed'?[`status:${rights.status}`]:[]),...(expired?['expired']:[]),...(!rights.uses.includes(input.use)?['use']:[]),...(!rights.territories.includes(input.territory)?['territory']:[]),...(!rights.locales.includes(input.locale)?['locale']:[]),...(rights.consent==='missing'?['consent']:[])];return {allowed:reasons.length===0||(Boolean(input.authorizedReview)&&rights.status==='restricted'),reasons,reviewApplied:Boolean(input.authorizedReview),audited:true};}

export type AssetContract={id:string;kind:'video'|'audio'|'image'|'document'|'synthetic'|'derivative';common:{workspaceId:string;checksum:string;rightsId:string};metadata:Record<string,unknown>};
const REQUIRED:Record<AssetContract['kind'],string[]>={video:['durationMs','width','height'],audio:['durationMs','sampleRate'],image:['width','height'],document:['mimeType','pages'],synthetic:['provider','lineageId'],derivative:['parentAssetId','recipeId']};
export function validateAssetContract(asset:AssetContract){const missing=REQUIRED[asset.kind].filter(x=>asset.metadata[x]===undefined);if(!asset.id||!asset.common.workspaceId||!asset.common.rightsId||missing.length)throw new Error(`invalid-${asset.kind}-asset:${missing.join(',')}`);return asset;}
