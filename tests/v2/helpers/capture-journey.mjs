import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { NextRequest } from 'next/server'

/**
 * The plumbing two product journeys share: real media, real rows, real routes.
 *
 * Both journeys under `tests/v2/*-journey.e2e.mjs` drive the published `/v1`
 * handlers against a migrated PostgreSQL and a local artifact root. What lives
 * here is only what neither journey is ABOUT: generating the recordings with
 * ffmpeg, measuring them with ffprobe, registering the artifacts the media
 * ingest pipeline would have registered, issuing an API client, and invoking a
 * route handler with a `NextRequest`.
 *
 * Two things are seeded rather than driven, and both are named out loud because
 * a reader has to be able to tell what was proved from what was arranged:
 *
 * - **Media artifacts, manifests and colour probes.** The media ingest worker
 *   is a polling loop with no `--once`, and its subject is the ingest pipeline,
 *   not the capture domain. Every value written here is MEASURED from the file
 *   that was just encoded — sha256 of the bytes, `width`/`height`/`duration`/
 *   `fps` and the colour metadata from ffprobe, and the producer digest from
 *   the ffprobe binary itself. Nothing is typed in.
 * - **Speaker diarization runs.** Diarization is a paid provider call. The runs
 *   are built by the domain factory (so their hashes are the ones the reader
 *   re-verifies) and their segments name the stretches where the generated
 *   audio actually carries that speaker's tone.
 *
 * Everything from `POST /v1/projects/{id}/capture-sessions` onwards goes
 * through a published route.
 *
 * `.ts` arrives through `await import` at module scope, never a static
 * specifier: tsx resolves a static specifier before it transforms the target,
 * so an `.mjs` naming a `.ts` export statically dies at link time. The Wave 20
 * precedent (`tests/v2/wave20-fixtures.mjs`) reaches the domain the same way.
 */

const { createApiClientService } = await import('../../../src/v2/application/create-api-client.ts')
const { calculateVersionHash, stableSerialize } = await import('../../../src/v2/application/version-hash.ts')
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createMediaColorProbe } = await import('../../../src/v2/domain/color-and-export.ts')
const { createDesiredAction, createDesiredActionReference } = await import('../../../src/v2/domain/desired-action.ts')
const { createMediaArtifactManifestV2 } = await import('../../../src/v2/domain/media-artifact.ts')
const { createEditorialAudioTimelineHash } = await import('../../../src/v2/domain/production-modes.ts')
const { createSpeakerDiarizationRun } = await import('../../../src/v2/domain/speaker-diarization.ts')
const { createWorkspace } = await import('../../../src/v2/domain/workspace.ts')
const { PrismaApiClientRepository } = await import('../../../src/v2/infrastructure/prisma/api-client-repository.ts')
const { PrismaWorkspaceRepository } = await import('../../../src/v2/infrastructure/prisma/workspace-repository.ts')
const { nodeApiCredentialCrypto } = await import('../../../src/v2/infrastructure/security/api-credential.ts')

const execFileAsync = promisify(execFile)

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** 16 kHz mono is what the sync correlator prepares its audio at. */
export const SAMPLE_RATE = 16_000

/**
 * The isolation this suite family refuses to run without.
 *
 * Copied in shape from `prisma-long-form-index-workflow.e2e.mjs`: a loopback
 * host, a database whose name says `e2e`, a labelled `application_name`, and
 * bounded pool settings. A destructive suite that would happily point at a
 * shared server is one misconfigured environment away from deleting somebody
 * else's rows.
 */
export function assertIsolatedDatabase() {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must name a disposable local PostgreSQL')
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname),
    'this journey is restricted to a disposable local PostgreSQL',
  )
  assert.match(url.searchParams.get('application_name') ?? '', /^apollo-video-e2e-[a-z0-9-]+$/)
  for (const [name, maximum] of [['connection_limit', 5], ['pool_timeout', 10], ['connect_timeout', 10]]) {
    const value = Number(url.searchParams.get(name))
    assert.ok(
      Number.isInteger(value) && value >= 1 && value <= maximum,
      `${name} must be an integer between 1 and ${maximum}`,
    )
  }
  assert.match(url.pathname.slice(1), /(?:^|_)e2e(?:_|$)/)
}

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A deterministic pseudo-random stream. No `Math.random`: a golden must replay. */
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296 - 0.5
  }
}

/**
 * One second-by-second chirp sweep, distinct in every second.
 *
 * The correlator needs an acoustic event it can find; a constant tone would
 * align equally well at every lag, which is ADR-151's point restated as a
 * fixture: two signals agreeing corroborate the instant only when the signal
 * differs across instants.
 */
export function sweepSamples({ seconds, sampleRate = SAMPLE_RATE }) {
  const samples = new Float64Array(seconds * sampleRate)
  for (let second = 0; second < seconds; second += 1) {
    const start = 180 + 13 * ((second * 7) % seconds)
    const span = second % 2 === 0 ? 150 : -150
    for (let sample = 0; sample < sampleRate; sample += 1) {
      const t = sample / sampleRate
      samples[second * sampleRate + sample] =
        0.55 * Math.sin(2 * Math.PI * (start * t + (span * t * t) / 2))
    }
  }
  return samples
}

/**
 * The same room heard by a recorder that started `lagSeconds` later.
 *
 * A little noise on top so the two files are not byte-identical: a correlator
 * that only ever sees a shifted copy of its own reference is not being asked
 * the question a second microphone asks.
 */
export function laggedSamples(reference, { seconds, sampleRate = SAMPLE_RATE, lagSeconds, seed }) {
  const samples = new Float64Array(seconds * sampleRate)
  const noise = lcg(seed)
  const shift = Math.round(lagSeconds * sampleRate)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = (reference[index + shift] ?? 0) + 0.08 * noise()
  }
  return samples
}

export function pcmBuffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32_767), index * 2)
  }
  return buffer
}

/**
 * Encode one recording: a picture from `lavfi`, and the PCM beside it.
 *
 * `-shortest` is deliberate — the audio and the picture are generated at the
 * same length, and a mismatch would show up as a duration the probe disagrees
 * with rather than being silently padded.
 */
export async function encodeRecording({
  ffmpegPath,
  outputPath,
  seconds,
  fps,
  videoInput = null,
  videoInputs = null,
  videoFilter = null,
  filterComplex = null,
  pcmPath = null,
  sampleRate = SAMPLE_RATE,
  width = 320,
  height = 180,
}) {
  const pictures = videoInputs ?? [videoInput]
  await mkdir(dirname(outputPath), { recursive: true })
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    ...pictures.flatMap((source) => ['-f', 'lavfi', '-i', source]),
    ...(pcmPath ? ['-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmPath] : []),
    ...(filterComplex ? ['-filter_complex', filterComplex, '-map', '[picture]'] : []),
    ...(filterComplex && pcmPath ? ['-map', `${pictures.length}:a:0`] : []),
    ...(videoFilter ? ['-vf', videoFilter] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    // Tagged, not left to a reader's guess: an untagged h264 stream probes as
    // `unknown` colorimetry, and a colour pipeline compiled over `unknown`
    // would hand zscale a token it refuses. These four are what ffprobe is then
    // asked to report back, and `colorMetadataFromStream` refuses anything else.
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-s', `${width}x${height}`, '-r', String(fps),
    ...(pcmPath ? ['-c:a', 'aac', '-b:a', '96k', '-ar', String(sampleRate), '-ac', '1'] : []),
    '-t', String(seconds), '-shortest', outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 })
  const bytes = await readFile(outputPath)
  return { sha256: sha256Of(bytes), byteSize: (await stat(outputPath)).size }
}

/** An audio-only recording: the dedicated recorder of a podcast. */
export async function encodeAudioRecording({ ffmpegPath, outputPath, pcmPath, seconds, sampleRate = SAMPLE_RATE }) {
  await mkdir(dirname(outputPath), { recursive: true })
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmPath,
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(sampleRate), '-ac', '1',
    '-t', String(seconds), outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 })
  const bytes = await readFile(outputPath)
  return { sha256: sha256Of(bytes), byteSize: (await stat(outputPath)).size }
}

export async function writePcm(path, samples) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, pcmBuffer(samples))
}

/** Every stream ffprobe reports, with the frames actually decoded. */
export async function probeStreams(ffprobePath, path) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,codec_name,width,height,duration,r_frame_rate,pix_fmt,color_space,color_transfer,color_primaries,color_range,nb_read_frames,sample_rate',
    '-of', 'json', path,
  ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  return JSON.parse(stdout).streams
}

/** The mean RGB of one decoded frame, from raw pixels rather than a thumbnail. */
export async function meanRgbAt(ffmpegPath, path, second) {
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-vf', 'scale=8:8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  const raw = Buffer.from(stdout)
  let red = 0
  let green = 0
  let blue = 0
  for (let index = 0; index + 2 < raw.length; index += 3) {
    red += raw[index]
    green += raw[index + 1]
    blue += raw[index + 2]
  }
  const pixels = Math.max(1, Math.floor(raw.length / 3))
  return { red: red / pixels, green: green / pixels, blue: blue / pixels }
}

export async function binaryDigest(path) {
  return sha256Of(await readFile(path))
}

/**
 * One API client with a live credential, and the bearer token to use it.
 *
 * `APOLLO_API_ENVIRONMENT` has to say `production` before the first route is
 * called or the authenticator refuses a production credential.
 */
export async function issueApiClient({ prisma, workspaceId, clientId, name, createdAt, scopes }) {
  return createApiClientService({
    repository: new PrismaApiClientRepository(prisma),
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => createdAt,
  })({
    id: clientId,
    workspaceId,
    name,
    environment: 'production',
    scopes: [...scopes],
  })
}

export async function createWorkspaceRow({ prisma, workspaceId, name, createdAt }) {
  await new PrismaWorkspaceRepository(prisma).create(createWorkspace({
    id: workspaceId,
    slug: workspaceId,
    name,
    status: 'active',
    createdAt: createdAt.toISOString(),
  }))
}

export async function createProjectRow({
  prisma, workspaceId, projectId, name, objective, format, clientId, createdAt,
}) {
  await prisma.v2Project.create({
    data: {
      id: projectId,
      workspaceId,
      name,
      status: 'reviewing-proxy',
      objective,
      format,
      locale: 'pt-BR',
      createdByType: 'api-client',
      createdById: clientId,
      createdAt,
      updatedAt: createdAt,
    },
  })
}

/**
 * The rows the ingest pipeline leaves behind for one recording.
 *
 * The manifest is built by the domain factory over MEASURED numbers, the
 * colour probe carries the colorimetry ffprobe reported and the digest of the
 * ffprobe binary that reported it, and the project link is what
 * `hydrateSource` and `loadTrustedProbe` both refuse to work without.
 */
export async function registerRecording({
  prisma, workspaceId, projectId, artifactId, artifactKey, mediaType, container,
  sha256, byteSize, probe, colorMetadata, pixelFormat, producerVersion, producerBinaryDigest,
  role, originalFileName, createdAt, recipeId,
}) {
  const manifest = createMediaArtifactManifestV2({
    artifactKey,
    artifactSha256: sha256,
    byteSize,
    mediaType,
    container,
    recipe: { id: recipeId, version: '1.0.0', parameters: { artifactId, mediaType } },
    sources: [],
    probe,
  })
  const manifestId = `manifest-${artifactId}`
  await prisma.v2MediaArtifact.create({
    data: {
      id: artifactId,
      workspaceId,
      artifactKey,
      sha256,
      byteSize: BigInt(byteSize),
      mediaType,
      container,
      status: 'available',
      createdAt,
    },
  })
  await prisma.v2MediaArtifactManifest.create({
    data: {
      id: manifestId,
      workspaceId,
      artifactId,
      schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      recipeId: manifest.recipe.id,
      recipeVersion: manifest.recipe.version,
      parametersHash: manifest.recipe.parametersHash,
      manifestJson: stableSerialize(manifest),
      createdAt,
    },
  })
  await prisma.v2ProjectMediaAsset.create({
    data: {
      // The link's id is a UUID column, not a readable name.
      id: randomUUID(),
      workspaceId,
      projectId,
      artifactId,
      role,
      originalFileName,
      createdAt,
    },
  })
  let probeId = null
  if (colorMetadata) {
    const colorProbe = createMediaColorProbe({
      id: `color-probe-${artifactId}`,
      workspaceId,
      artifactId,
      manifestId,
      detection: {
        state: 'ready',
        metadata: colorMetadata,
        pixelFormat,
        hdrMode: 'sdr',
      },
      producer: { provider: 'ffprobe', version: producerVersion, binaryDigest: producerBinaryDigest },
      createdAt: createdAt.toISOString(),
    })
    await prisma.v2MediaColorProbe.create({
      data: {
        id: colorProbe.id,
        workspaceId,
        artifactId,
        manifestId,
        schemaVersion: colorProbe.schemaVersion,
        state: 'ready',
        metadataJson: stableSerialize(colorMetadata),
        pixelFormat,
        hdrMode: 'sdr',
        reasonsJson: stableSerialize([]),
        producerProvider: colorProbe.producer.provider,
        producerVersion: colorProbe.producer.version,
        producerBinaryDigest: colorProbe.producer.binaryDigest,
        createdAt,
        probeHash: colorProbe.probeHash,
      },
    })
    probeId = colorProbe.id
  }
  return { manifestId, manifestHash: manifest.manifestHash, probeId }
}

/**
 * The project version a direction is computed against.
 *
 * A single-source `DirectedEditPlan` over the recording the project links as
 * its `source-master`: the plan the operator had before any camera work, and
 * the base the multicam command re-cuts. Its hash is the one the fence in
 * every subsequent request has to name.
 */
export async function seedBaseProjectVersion({
  prisma, workspaceId, projectId, versionId, clientId, objective,
  sourceArtifactId, fps, durationFrames, transcriptId, createdAt,
}) {
  const desiredActionRef = createDesiredActionReference(createDesiredAction({ objective }))
  const baseClips = [{
    id: 'clip-base-0001',
    sourceArtifactId,
    sourceInFrame: 0,
    sourceOutFrame: durationFrames,
    timelineInFrame: 0,
    timelineOutFrame: durationFrames,
    rate: 1,
  }]
  const basePlan = {
    schemaVersion: 2,
    state: 'compiled',
    id: `edit-plan-${versionId}`,
    projectVersionId: versionId,
    storyPlanId: `story-${projectId}`,
    treatmentPlanId: `treatment-${projectId}`,
    directorRunId: `director-run-${projectId}`,
    fps,
    durationFrames,
    sources: [{ id: sourceArtifactId, artifactId: sourceArtifactId, kind: 'video', durationSeconds: durationFrames / fps }],
    videoTracks: [{ id: 'track-primary-video', kind: 'base-video', clips: baseClips }],
    overlayTracks: [],
    subtitleTracks: [],
    audioTracks: [],
    effectTracks: [],
    transitions: [],
    markers: [],
    protectedElements: [],
    localeVariantRefs: [],
    formatVariantRefs: [],
    lineageRefs: [sourceArtifactId],
    editorial: { commandType: 'source-ingest', exclusions: [], retainedSourceRanges: [] },
    retimedTranscript: { sourceTranscriptId: transcriptId, words: [] },
    movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 },
    composition: {
      layout: 'landscape-inset',
      background: 'blurred-source',
      foregroundScale: 1,
      verticalPosition: 0.5,
      faceSafeFallback: [0.14, 0.08, 0.72, 0.56],
      subtitleSafeRegion: [0.08, 0.7, 0.84, 0.24],
    },
    director: { plannerVersion: 'capture-journey-base/v1', decisions: [], assumptions: [] },
    desiredActionRef,
    audioTimelineHash: createEditorialAudioTimelineHash({ fps, clips: baseClips }),
    createdAt: createdAt.toISOString(),
  }
  for (const [kind, content] of [['brief', { kind: 'brief' }], ['policies', { kind: 'policies' }]]) {
    await prisma.v2ProjectSnapshot.create({
      data: {
        id: `${projectId}-snapshot-${kind}`,
        workspaceId,
        projectId,
        kind,
        schemaVersion: 1,
        contentJson: stableSerialize(content),
        contentHash: calculateVersionHash(content),
        createdAt,
      },
    })
  }
  await prisma.v2ProjectSnapshot.create({
    data: {
      id: `${projectId}-snapshot-edit-plan`,
      workspaceId,
      projectId,
      kind: 'edit-plan',
      schemaVersion: 2,
      contentJson: stableSerialize(basePlan),
      contentHash: calculateVersionHash(basePlan),
      createdAt,
    },
  })
  const baseHash = calculateVersionHash({
    projectId,
    sequence: 1,
    editPlanHash: calculateVersionHash(basePlan),
  })
  await prisma.v2ProjectVersion.create({
    data: {
      id: versionId,
      workspaceId,
      projectId,
      sequence: 1,
      briefSnapshotId: `${projectId}-snapshot-brief`,
      editPlanSnapshotId: `${projectId}-snapshot-edit-plan`,
      policiesSnapshotId: `${projectId}-snapshot-policies`,
      baseHash,
      createdBy: clientId,
      createdAt,
    },
  })
  await prisma.v2Project.update({ where: { id: projectId }, data: { currentVersionId: versionId } })
  return { baseHash, basePlan }
}

/**
 * The rows a diarization run hangs from: a transcript, a public operation and a
 * long-form index workflow.
 *
 * Not decoration — `speaker_diarization_runs.workflowId` is a foreign key into
 * `long_form_index_workflows`, which is itself keyed to a `public_operations`
 * row and a `media_transcripts` row. Skipping any of the three makes the run
 * unstorable, so the scaffolding is built here once instead of being rebuilt,
 * subtly differently, in each journey.
 */
export async function storeDiarizationWorkflow({
  prisma, workspaceId, projectId, workflowId, operationId, transcriptId,
  sourceArtifactId, sourceArtifactSha256, sourceManifestId, sourceManifestHash,
  durationMs, clientId, createdAt,
}) {
  await prisma.v2MediaTranscript.create({
    data: {
      id: transcriptId,
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceManifestId,
      schemaVersion: 'media-transcript/v1',
      language: 'pt-BR',
      provider: 'openai',
      model: 'whisper-1',
      providerVersion: 'v1',
      transcriptHash: sha256Of(`${transcriptId}-body`),
      transcriptJson: stableSerialize({ words: [] }),
      createdAt,
    },
  })
  await prisma.v2PublicOperation.create({
    data: {
      id: operationId,
      workspaceId,
      projectId,
      clientId,
      type: 'long-form-index',
      status: 'succeeded',
      phase: 'completed',
      targetType: 'media-artifact',
      targetId: sourceArtifactId,
      // `public_operations_progress_check` ties status, phase and progress
      // together: a long-form index that succeeded has all six stages done.
      progressUnit: 'stage',
      progressTotal: 6,
      progressCompleted: 6,
      attempt: 1,
      startedAt: createdAt,
      completedAt: createdAt,
      resultJson: stableSerialize({ workflowId }),
      cancelable: false,
      retryable: false,
      idempotencyKey: `${operationId}-key`,
      requestFingerprint: sha256Of(`${operationId}-fingerprint`),
      createdAt,
      updatedAt: createdAt,
    },
  })
  await prisma.v2LongFormIndexWorkflow.create({
    data: {
      id: workflowId,
      workspaceId,
      projectId,
      operationId,
      sourceArtifactId,
      sourceArtifactSha256,
      sourceManifestId,
      sourceManifestHash,
      sourceTranscriptId: transcriptId,
      durationMs,
      schemaVersion: 'long-form-index-workflow/v1',
      policyVersion: 'long-form-index-workflow-policy/v1',
      status: 'succeeded',
      budgetCurrency: 'USD',
      maximumCostMinorUnits: 10_000,
      maximumElapsedMs: 600_000,
      maximumConcurrency: 2,
      completedStageCount: 5,
      searchableStageCount: 5,
      resultCount: 1,
      costMinorUnits: 10,
      elapsedMs: 1_000,
      duplicateSegments: false,
      resumable: true,
      workflowJson: stableSerialize({ id: workflowId }),
      runHash: sha256Of(`${workflowId}-run`),
      requestFingerprint: sha256Of(`${workflowId}-fingerprint`),
      idempotencyKey: `${workflowId}-key`,
      createdByClientId: clientId,
      createdAt,
      updatedAt: createdAt,
    },
  })
}

/**
 * A speaker diarization run over one recording, stored the way its own
 * repository stores it.
 *
 * The projection the direction reads (`PrismaMulticamDiarizationSource`)
 * re-derives the run from `runJson` and refuses a body that does not reproduce
 * the stored hashes, so the run has to be built by the domain factory. Written
 * segment-by-segment rather than nested because `workspaceId` and `projectId`
 * are half of each segment's composite key back to its run.
 */
export async function storeDiarizationRun({
  prisma, workspaceId, projectId, runId, workflowId, transcriptId, sourceArtifactId,
  sourceArtifactSha256, sourceManifestId, sourceManifestHash, durationMs, segments,
  clientId, createdAt,
}) {
  const run = createSpeakerDiarizationRun({
    id: runId,
    workspaceId,
    projectId,
    workflowId,
    sourceArtifactId,
    sourceArtifactSha256,
    sourceManifestId,
    sourceManifestHash,
    // The transcript the workflow indexed, not one invented for this run: the
    // column is a foreign key into `media_transcripts`.
    sourceTranscriptId: transcriptId,
    sourceTranscriptHash: sha256Of(`${transcriptId}-body`),
    durationMs,
    providerInput: {
      sha256: sourceArtifactSha256,
      byteSize: 8_192,
      durationMs,
      preparation: {
        toolId: 'ffmpeg',
        toolVersion: 'static',
        configurationHash: sha256Of(`${runId}-preparation`),
      },
    },
    provider: { id: 'openai', model: 'gpt-4o-transcribe-diarize', version: 'v1' },
    segments,
    usageSeconds: Math.round(durationMs / 1_000),
    costMinorUnits: 10,
    elapsedMs: 1_000,
    requestFingerprint: sha256Of(`${runId}-fingerprint`),
    idempotencyKey: `${workflowId}:diarization:${runId}`,
    createdByClientId: clientId,
    createdAt: createdAt.toISOString(),
  })
  await prisma.v2SpeakerDiarizationRun.create({
    data: {
      id: run.id,
      workspaceId,
      projectId,
      workflowId,
      sourceArtifactId,
      sourceArtifactSha256: run.sourceArtifactSha256,
      sourceManifestId: run.sourceManifestId,
      sourceManifestHash: run.sourceManifestHash,
      sourceTranscriptId: run.sourceTranscriptId,
      sourceTranscriptHash: run.sourceTranscriptHash,
      durationMs: run.durationMs,
      providerInputJson: stableSerialize(run.providerInput),
      providerInputHash: calculateCanonicalHash(run.providerInput),
      schemaVersion: run.schemaVersion,
      policyVersion: run.policyVersion,
      providerId: run.provider.id,
      providerModel: run.provider.model,
      providerVersion: run.provider.version,
      speakerCount: run.speakerCount,
      segmentCount: run.segmentCount,
      usageSeconds: run.usageSeconds,
      costMinorUnits: run.costMinorUnits,
      elapsedMs: run.elapsedMs,
      identityResolved: run.identityResolved,
      physicalMaterialized: run.physicalMaterialized,
      requestFingerprint: run.requestFingerprint,
      idempotencyKey: run.idempotencyKey,
      createdByClientId: clientId,
      createdAt,
      runJson: stableSerialize(run),
      runHash: run.runHash,
    },
  })
  await prisma.v2SpeakerDiarizationSegment.createMany({
    data: run.segments.map((segment) => ({
      id: segment.id,
      workspaceId,
      projectId,
      runId: run.id,
      ordinal: segment.ordinal,
      providerSegmentId: segment.providerSegmentId,
      providerLabel: segment.providerLabel,
      speakerKey: segment.speakerKey,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      textHash: segment.textHash,
      segmentJson: stableSerialize(segment),
      segmentHash: segment.segmentHash,
    })),
  })
  return run
}

/**
 * Call one published route handler.
 *
 * The handler, not a copy of what it does: a body the contract would reject, a
 * scope the route requires, or an idempotency header the route reads are all
 * live here. `params` is handed in as the promise Next hands it.
 */
export async function callRoute(handler, {
  method = 'GET', path, token, cookie, body, idempotencyKey, params = {},
}) {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      // A bearer token OR a UI session cookie. Both, and the authenticator
      // would take the header and the human decision the cookie carries would
      // silently become an unattended one.
      ...(cookie ? { cookie } : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await handler(request, { params: Promise.resolve(params) })
  const payload = await response.json()
  return { status: response.status, payload, data: payload.data, response }
}

/**
 * Log in as a person, and hand back the cookie that says so.
 *
 * Some decisions are refused to an unattended credential by name — choosing the
 * colour reference camera is one: "the reference camera is a human decision; an
 * unattended credential cannot make it" (`multicam-color-match.ts:166`). The
 * bootstrap login is how the operator pages obtain that actor, so a journey
 * that needs it uses the same route rather than fabricating an actor.
 */
export async function loginUiSession(sessionRoute, { username, password }) {
  const request = new NextRequest('http://localhost/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const response = await sessionRoute.POST(request)
  assert.ok(
    response.status >= 200 && response.status < 300,
    `POST /v1/session answered ${response.status}: ${JSON.stringify(await response.json())}`,
  )
  const cookie = response.cookies.get('apollo_session')
  assert.ok(cookie?.value, 'the login set a session cookie')
  return `apollo_session=${cookie.value}`
}

/** `callRoute`, but a status outside `expected` fails with the envelope in the message. */
export async function callRouteOk(handler, input, expected = [200, 201, 202]) {
  const result = await callRoute(handler, input)
  assert.ok(
    expected.includes(result.status),
    `${input.method ?? 'GET'} ${input.path} answered ${result.status}: ${JSON.stringify(result.payload)}`,
  )
  return result
}

/**
 * A worker driver, through its npm SCRIPT rather than its file.
 *
 * Two Wave 19 suites shipped green over a broken script definition because the
 * suite ran the file and CI ran the same file; running `npm run <script>` here
 * means a typo in package.json fails the journey.
 */
export function runNpmScriptOnce(script, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', '--silent', script, ...(args.length > 0 ? ['--', ...args] : [])],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * A one-shot driver that has no npm script, run the way CI runs it.
 *
 * `scripts/run-v2-render-worker-once.mjs` is invoked directly by
 * `mvp-core-full-journey.e2e.mjs` too: it is the file, under tsx, with the kind
 * in the environment. Named here rather than inlined so the two journeys cannot
 * drift apart on how the worker is started.
 */
export function runNodeScriptOnce(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', script],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** The one JSON line a `--once` driver prints, or `null` when it printed none. */
export function outcomeLine(stdout, prefix) {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix))
  return line ? JSON.parse(line.slice(prefix.length)) : null
}

export function artifactPath(artifactRoot, artifactKey) {
  return join(artifactRoot, artifactKey)
}

/**
 * The colorimetry ffprobe reported, in the tokens the render path consumes.
 *
 * `zscale` is handed `primaries`, `transfer`, `matrix` and `range` verbatim
 * (`ffmpeg-color-pipeline-processor.ts:106`), so this refuses anything it did
 * not measure rather than substituting a plausible default: a probe that
 * silently answers `bt709` for an untagged file is a measurement nobody made.
 * `colorSpace` is the free-form label the domain carries beside them.
 */
export function colorMetadataFromStream(stream) {
  assert.equal(stream.color_primaries, 'bt709', 'the encode was tagged bt709 primaries')
  assert.equal(stream.color_transfer, 'bt709', 'the encode was tagged bt709 transfer')
  assert.equal(stream.color_space, 'bt709', 'the encode was tagged bt709 matrix')
  assert.equal(stream.color_range, 'tv', 'the encode was tagged limited range')
  return Object.freeze({
    colorSpace: 'rec709',
    transfer: 'bt709',
    primaries: 'bt709',
    matrix: 'bt709',
    range: 'limited',
    bitDepth: 8,
  })
}
