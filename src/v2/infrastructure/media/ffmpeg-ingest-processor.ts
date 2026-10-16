import { isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { MediaIngestProcessor, MediaNormalizationOwnerV3 } from '../../application/ports/media-ingest.ts'
import { DomainError } from '../../domain/errors.ts'
import { observeMediaFramesV3, observedAudioFromVideoProbeV3, videoMetadataFromObservedProbeV3 } from './video-probe.ts'
import { resolveFfmpegBinary } from './ffmpeg-binary.ts'
import { NodeOwnedFfmpegExecutor, assertOwnedFfmpegAdmission, type OwnedFfmpegExecutor } from './ffmpeg-owned-process.ts'
import { OwnedDeadlineIo } from './ffmpeg-owned-io.ts'

function assertContained(root:string,candidate:string) {
  const rel=relative(root,candidate)
  if(rel.startsWith('..')||isAbsolute(rel))throw new DomainError('PERSISTENCE_CONFLICT','Ingest work path escaped its root')
}
/** No stage renews the operation deadlines. IO phases retain their own shorter
 * 180s cap; every phase must settle before another is admitted. */
export class FfmpegIngestProcessor implements MediaIngestProcessor {
  private readonly workRoot:string
  private readonly ffmpegPath:string
  private readonly executor:OwnedFfmpegExecutor
  private readonly environment:NodeJS.ProcessEnv
  private readonly owners=new Map<string,{owner:Readonly<MediaNormalizationOwnerV3>;ios:OwnedDeadlineIo[];failed:boolean;directoryCreated:boolean}>()
  constructor(options:{workRoot:string;ffmpegPath?:string;executor?:OwnedFfmpegExecutor;environment?:NodeJS.ProcessEnv}) {
    this.workRoot=resolve(options.workRoot);this.ffmpegPath=resolveFfmpegBinary(options.ffmpegPath)
    this.executor=options.executor??new NodeOwnedFfmpegExecutor();this.environment=options.environment??process.env
    if(!isAbsolute(this.workRoot)||!isAbsolute(this.ffmpegPath))throw new DomainError('PERSISTENCE_NOT_CONFIGURED','Ingest requires exact work and executable paths')
  }
  private directory(operationId:string) {
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(operationId))throw new DomainError('INVALID_ARGUMENT','operationId is invalid')
    const state=this.owners.get(operationId)
    if(!state)throw new DomainError('PERSISTENCE_CONFLICT','Ingest directory has no bound attempt owner')
    const directory=join(this.workRoot,operationId+'-attempt-'+state.owner.attempt);assertContained(this.workRoot,directory);return directory
  }
  private admit(input:{operationId:string;owner:Readonly<MediaNormalizationOwnerV3>}) {
    assertOwnedFfmpegAdmission()
    const o=input.owner,now=performance.now()
    if(this.owners.has(input.operationId)||!Number.isSafeInteger(o.attempt)||o.attempt<1||!o.leaseOwner||
      !/^[a-f0-9]{64}$/.test(o.sourceSha256)||!Number.isSafeInteger(o.sourceByteSize)||o.sourceByteSize<1||
      !Number.isFinite(o.workEndMonotonicMs)||!Number.isFinite(o.hardEndMonotonicMs)||o.workEndMonotonicMs<=now||
      o.workEndMonotonicMs>now+30*60000||o.hardEndMonotonicMs<=o.workEndMonotonicMs||o.hardEndMonotonicMs>o.workEndMonotonicMs+5000)
      throw new DomainError('INVALID_ARGUMENT','Ingest owner/deadlines are invalid')
    this.owners.set(input.operationId,{owner:o,ios:[],failed:false,directoryCreated:false})
  }
  private io(operationId:string,signal?:AbortSignal) {
    const state=this.owners.get(operationId)
    if(!state||state.failed)throw new DomainError('RENDER_EXECUTION_FAILED','Ingest IO admission retained')
    for(const io of state.ios)io.assertCleanup()
    const hardEnd=Math.min(state.owner.hardEndMonotonicMs,performance.now()+180000)
    const io=new OwnedDeadlineIo({runId:operationId,workEndMonotonicMs:Math.min(state.owner.workEndMonotonicMs,hardEnd-5000),
      hardEndMonotonicMs:hardEnd,signal,otherAdmission:assertOwnedFfmpegAdmission})
    state.ios.push(io);return io
  }
  private async run(operationId:string,args:readonly string[],signal?:AbortSignal) {
    const state=this.owners.get(operationId)!
    const result=await this.executor.execute({executable:this.ffmpegPath,args,owner:{runId:operationId,operation:'media-ingest-normalization'},
      timeoutMs:30*60000,deadlineMonotonicMs:state.owner.workEndMonotonicMs,maxOutputBytes:2*1024*1024,signal})
    if(!result.spawnObserved||!result.closeObserved||result.exitCode!==0||result.signal)
      throw new DomainError('RENDER_EXECUTION_FAILED','Media normalization did not close successfully')
    return result
  }
  async normalize(input:{sourcePath:string;operationId:string;owner:Readonly<MediaNormalizationOwnerV3>;signal?:AbortSignal}) {
    if(!isAbsolute(input.sourcePath))throw new DomainError('INVALID_ARGUMENT','Ingest source path must be absolute')
    this.admit(input)
    try {
      const directory=this.directory(input.operationId),proxyPath=join(directory,'editing-proxy.mp4'),audioPath=join(directory,'speech.flac')
      let io=this.io(input.operationId,input.signal)
      const sourceBefore=await io.hashFile(input.sourcePath,input.owner.sourceByteSize),binaryBefore=await io.hashFile(this.ffmpegPath,256*1024*1024)
      if(sourceBefore.byteSize!==input.owner.sourceByteSize||sourceBefore.sha256!==input.owner.sourceSha256)
        throw new DomainError('PERSISTENCE_CONFLICT','Normalization source integrity differs')
      await io.mkdir(this.workRoot,{recursive:true})
      await io.mkdir(directory,{recursive:false});this.owners.get(input.operationId)!.directoryCreated=true
      const source=await observeMediaFramesV3(input.sourcePath,{mediaType:'video',operationId:input.operationId,executor:this.executor,io,
        deadlineMonotonicMs:input.owner.workEndMonotonicMs,signal:input.signal,environment:this.environment})
      const argv=['-hide_banner','-loglevel','error','-y','-i',input.sourcePath,'-map','0:v:0','-map','0:a:0?',
        '-vf','scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos',
        '-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000',
        '-movflags','+faststart',proxyPath]
      await this.run(input.operationId,argv,input.signal)
      await this.run(input.operationId,['-hide_banner','-loglevel','error','-y','-i',input.sourcePath,
        '-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','flac',audioPath],input.signal)
      io=this.io(input.operationId,input.signal)
      const derivative=await observeMediaFramesV3(proxyPath,{mediaType:'video',operationId:input.operationId,executor:this.executor,io,
        deadlineMonotonicMs:input.owner.workEndMonotonicMs,signal:input.signal,environment:this.environment})
      const proxyMetadata=await io.stat(proxyPath),audioMetadata=await io.stat(audioPath)
      if(!proxyMetadata.isFile()||proxyMetadata.size<=BigInt(0)||proxyMetadata.size>BigInt(Number.MAX_SAFE_INTEGER)||
        !audioMetadata.isFile()||audioMetadata.size<=BigInt(0))throw new DomainError('RENDER_OUTPUT_INVALID','Media normalization produced an empty derivative')
      const proxy=await io.hashFile(proxyPath,Number(proxyMetadata.size)),sourceAfter=await io.hashFile(input.sourcePath,input.owner.sourceByteSize),
        binaryAfter=await io.hashFile(this.ffmpegPath,256*1024*1024)
      if(sourceAfter.sha256!==sourceBefore.sha256||sourceAfter.byteSize!==sourceBefore.byteSize||
        binaryAfter.sha256!==binaryBefore.sha256||binaryAfter.byteSize!==binaryBefore.byteSize)
        throw new DomainError('PERSISTENCE_CONFLICT','Normalization input or executable changed')
      const observation={schemaVersion:'media-normalization-observation/v3' as const,operationId:input.operationId,
        attempt:input.owner.attempt,leaseOwner:input.owner.leaseOwner,sourceProbe:source.probe,derivativeProbe:derivative.probe,
        audioProbes:{source:observedAudioFromVideoProbeV3(source.probe),derivative:observedAudioFromVideoProbeV3(derivative.probe)},
        execution:{provider:'ffmpeg' as const,recipeVersion:'media-normalization-execution/2026-10-14-v3' as const,binarySha256:binaryBefore.sha256,argv,spawnObserved:true as const,closeObserved:true as const,
          exitCode:0 as const,sourceSha256Before:sourceBefore.sha256,sourceSha256After:sourceAfter.sha256,derivativeSha256:proxy.sha256,autorotate:true}}
      return Object.freeze({proxyPath,audioPath,proxySha256:proxy.sha256,proxyByteSize:proxy.byteSize,
        probe:videoMetadataFromObservedProbeV3(derivative.probe),observation:Object.freeze(observation)})
    } catch(error) {this.owners.get(input.operationId)!.failed=this.owners.get(input.operationId)!.ios.some(io=>io.isRetained());throw error}
  }
  async observeOriginalAudio(input:{sourcePath:string;operationId:string;owner:Readonly<MediaNormalizationOwnerV3>;signal?:AbortSignal}) {
    this.admit(input)
    try {
      const io=this.io(input.operationId,input.signal),before=await io.hashFile(input.sourcePath,input.owner.sourceByteSize)
      if(before.byteSize!==input.owner.sourceByteSize||before.sha256!==input.owner.sourceSha256)
        throw new DomainError('PERSISTENCE_CONFLICT','Audio observation source differs')
      const observed=await observeMediaFramesV3(input.sourcePath,{mediaType:'audio',operationId:input.operationId,executor:this.executor,io,
        deadlineMonotonicMs:input.owner.workEndMonotonicMs,signal:input.signal,environment:this.environment})
      const after=await io.hashFile(input.sourcePath,input.owner.sourceByteSize)
      if(after.byteSize!==before.byteSize||after.sha256!==before.sha256)throw new DomainError('PERSISTENCE_CONFLICT','Audio observation source changed')
      return Object.freeze({schemaVersion:'media-normalization-observation/v3' as const,operationId:input.operationId,
        attempt:input.owner.attempt,leaseOwner:input.owner.leaseOwner,sourceProbe:observed.probe,derivativeProbe:observed.probe,
        audioProbes:{source:observed.probe,derivative:observed.probe},execution:{provider:'ffprobe' as const,recipeVersion:'media-normalization-execution/2026-10-14-v3' as const,
          binarySha256:observed.probe.binarySha256,argv:observed.argv,spawnObserved:true as const,closeObserved:true as const,exitCode:0 as const,
          sourceSha256Before:before.sha256,sourceSha256After:after.sha256,derivativeSha256:after.sha256,autorotate:false}})
    } catch(error) {this.owners.get(input.operationId)!.failed=this.owners.get(input.operationId)!.ios.some(io=>io.isRetained());throw error}
  }
  async cleanup(operationId:string) {
    const state=this.owners.get(operationId)
    if(!state)return
    assertOwnedFfmpegAdmission()
    if(state.failed)throw new DomainError('RENDER_EXECUTION_FAILED','Ingest owner retained after failure')
    for(const io of state.ios)io.assertCleanup()
    if(state.directoryCreated)await this.io(operationId).rm(this.directory(operationId))
    this.owners.delete(operationId)
  }
}
export function createFfmpegIngestProcessorFromEnvironment(environment:NodeJS.ProcessEnv=process.env) {
  const artifactRoot=environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if(!artifactRoot)throw new DomainError('PERSISTENCE_NOT_CONFIGURED','Artifact root is not configured')
  return new FfmpegIngestProcessor({workRoot:join(resolve(artifactRoot),'.work'),environment,
    ...(environment.FFMPEG_PATH?.trim()?{ffmpegPath:environment.FFMPEG_PATH.trim()}:{})})
}
