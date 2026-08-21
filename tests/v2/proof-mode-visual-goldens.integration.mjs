import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import sharp from 'sharp'

import {
  compileApolloVideoRenderProps,
} from '../../src/v2/application/compile-apollo-video-render-props.ts'
import {
  compileProofModeRenderInput,
} from '../../src/v2/application/compile-proof-mode-render-input.ts'
import {
  renderAuthorizedInputService,
} from '../../src/v2/application/render-authorized-input.ts'
import {
  runNextPublicOperationService,
} from '../../src/v2/application/run-public-operation-worker.ts'
import {
  createProofModeRun,
  PROOF_MODES,
} from '../../src/v2/domain/proof-mode.ts'
import {
  OUTPUT_ASPECT_RATIOS,
} from '../../src/v2/domain/output-spec.ts'
import {
  calculateFileSha256,
} from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import {
  probeVideo,
} from '../../src/v2/infrastructure/media/video-probe.ts'
import {
  RemotionRenderInputRenderer,
} from '../../src/v2/infrastructure/remotion-render-input-renderer.ts'

const enabled =
  process.env.APOLLO_PROOF_MODE_VISUAL_E2E === '1'
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const ffmpegPath = path.join(
  process.cwd(),
  'node_modules',
  'ffmpeg-static',
  `ffmpeg${executableSuffix}`,
)
const ffprobePath = path.join(
  process.cwd(),
  'node_modules',
  'ffprobe-static',
  'bin',
  process.platform,
  process.arch,
  `ffprobe${executableSuffix}`,
)
const hash = (character) => character.repeat(64)
const RENDERER_IDENTITY = Object.freeze({
  id: 'remotion',
  version: '4.0.489',
  digest: hash('8'),
})
const PROJECT_VERSION_ID = 'project-version-proof-goldens'
const SUBTITLE_TEXT =
  'Esta legenda deve ficar oculta durante a prova'

async function runProcess(
  executable,
  args,
  options = {},
) {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectProcess(error)
      else resolveProcess(stdout)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`Process timeout: ${stderr.slice(-2_000)}`))
    }, options.timeoutMs ?? 180_000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', finish)
    child.once('close', (code) => {
      if (code === 0) {
        finish()
      } else {
        finish(new Error(
          `Process failed with ${code}: ${stderr.slice(-4_000)} ${stdout.slice(-1_000)}`,
        ))
      }
    })
    child.stdin.end(
      options.stdin === undefined
        ? undefined
        : JSON.stringify(options.stdin),
    )
  })
}

async function createMedia(directory) {
  const presenterPath = path.join(directory, 'presenter.mp4')
  const evidenceVideoPath = path.join(directory, 'evidence.mp4')
  const evidenceImagePath = path.join(directory, 'evidence.png')
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'color=c=0x204A74:s=640x360:r=30:d=8',
    '-f', 'lavfi',
    '-i', 'sine=frequency=330:sample_rate=48000:duration=8',
    '-vf', 'drawbox=x=220:y=70:w=200:h=220:color=0xE3B38B:t=fill',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    presenterPath,
  ])
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=s=640x360:r=30:d=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    evidenceVideoPath,
  ])
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'color=c=0xE9A23B:s=800x450',
    '-vf', 'drawbox=x=80:y=70:w=640:h=310:color=0x17202A:t=18',
    '-frames:v', '1', '-threads', '1',
    evidenceImagePath,
  ])
  return {
    presenter: await mediaDescriptor(
      presenterPath,
      'artifact-proof-presenter',
      'video',
    ),
    evidenceVideo: await mediaDescriptor(
      evidenceVideoPath,
      'artifact-proof-video',
      'video',
    ),
    evidenceImage: await mediaDescriptor(
      evidenceImagePath,
      'artifact-proof-image',
      'image',
    ),
  }
}

async function mediaDescriptor(filePath, artifactId, kind) {
  const metadata = await stat(filePath)
  return Object.freeze({
    filePath,
    uri: pathToFileURL(filePath).href,
    artifactId,
    artifactKey: `visual-goldens/${path.basename(filePath)}`,
    kind,
    sha256: await calculateFileSha256(filePath),
    byteSize: metadata.size,
  })
}

function createModeRun(mode) {
  const sourceMediaType =
    mode === 'proof-card' ? 'image' : 'video'
  const sourceArtifactId =
    mode === 'proof-card'
      ? 'artifact-proof-image'
      : 'artifact-proof-video'
  const evaluation = {
    id: `proof-integrity-evaluation-${mode}`,
    sequence: 1,
    proofNeedItemId: `proof-need-item-${mode}`,
    proofNeedItemHash: hash('a'),
    proofNeedResolution: 'selected-evidence',
    selectedEvidenceId: `evidence-${mode}`,
    selectedEvidenceHash: hash('b'),
    use: {
      includedContextRangeMs: [0, 1_000],
      includedAdjacentEvidenceIds: [],
    },
    comparisons: [],
    outcome: 'approved',
    allowedForAssembly: true,
    presentation: {
      schemaVersion: 'proof-integrity-presentation/v1',
      evidenceId: `evidence-${mode}`,
      evidenceHash: hash('b'),
      requiredContextRangeMs: [0, 1_000],
      requiredAdjacentEvidenceIds: [],
      visual: {
        attribution: 'Fonte verificada · Apollo',
        qualifiers: ['Amostra: 1.248 clientes', 'Período: 2025'],
        mandatory: true,
      },
      verbal: {
        attribution: 'Fonte verificada · Apollo',
        qualifiers: ['Amostra: 1.248 clientes', 'Período: 2025'],
        mandatory: true,
      },
      presentationHash: hash('c'),
    },
    fabricationSuggested: false,
    evaluatedAt: '2026-07-29T18:00:00.000Z',
    evaluationHash: hash('d'),
  }
  const item = {
    id: evaluation.proofNeedItemId,
    sequence: 1,
    storyBlockId: `story-block-${mode}`,
    claimId: `claim-${mode}`,
    claimText: 'Conversões verificadas aumentaram 32%',
    claimKind: 'outcome',
    type: 'data',
    function: 'build-trust',
    required: true,
    moment: {
      placement: 'existing-proof-block',
      afterStoryBlockId: `story-block-${mode}`,
      proofStoryBlockId: `proof-block-${mode}`,
      timelineFrame: 0,
      timelineMs: 0,
    },
    search: {},
    resolution: 'selected-evidence',
    selectedEvidence: {
      id: evaluation.selectedEvidenceId,
      evidenceHash: evaluation.selectedEvidenceHash,
      category: 'data',
      sourceArtifactId,
      sourceRangeMs: [0, 1_000],
      contextRangeMs: [0, 1_000],
      score: .99,
    },
    proofUnavailable: false,
    genericCardGenerated: false,
    itemHash: evaluation.proofNeedItemHash,
  }
  const proofNeedRun = {
    id: `proof-need-run-${mode}`,
    workspaceId: 'workspace-proof-goldens',
    projectId: 'project-proof-goldens',
    batchId: 'batch-proof-goldens',
    targetRecipeId: 'recipe-proof-goldens',
    targetRecipeHash: hash('e'),
    items: [item],
    runHash: hash('f'),
  }
  return createProofModeRun({
    id: `proof-mode-run-${mode}`,
    workspaceId: proofNeedRun.workspaceId,
    projectId: proofNeedRun.projectId,
    proofIntegrityRun: {
      schemaVersion: 'proof-integrity-run/v1',
      policyVersion: 'proof-integrity-policy/v1',
      id: `proof-integrity-run-${mode}`,
      workspaceId: proofNeedRun.workspaceId,
      projectId: proofNeedRun.projectId,
      batchId: proofNeedRun.batchId,
      targetRecipeId: proofNeedRun.targetRecipeId,
      targetRecipeHash: proofNeedRun.targetRecipeHash,
      proofNeedRunId: proofNeedRun.id,
      proofNeedRunHash: proofNeedRun.runHash,
      evaluations: [evaluation],
      summary: {
        evaluationCount: 1,
        approvedCount: 1,
        blockedCount: 0,
        notApplicableCount: 0,
        hardIssueCount: 0,
        fabricationSuggestionCount: 0,
        readyForAssembly: true,
      },
      createdByClientId: 'client-proof-goldens',
      createdAt: '2026-07-29T18:00:00.000Z',
      runHash: hash('1'),
    },
    proofNeedRun,
    sources: [{
      evaluation,
      proofNeedItem: item,
      sourceArtifactId,
      sourceMediaType,
      contextRequired: false,
    }],
    formats: OUTPUT_ASPECT_RATIOS,
    rhythm: 'measured',
    overrides: OUTPUT_ASPECT_RATIOS.map((format) => ({
      proofNeedItemId: item.id,
      format,
      mode,
      expectedEvaluationHash: evaluation.evaluationHash,
    })),
    createdByClientId: 'client-proof-goldens',
    createdAt: '2026-07-29T18:00:00.000Z',
  })
}

/**
 * Compiles the plan through the production compiler and materializes only the
 * asset URIs, exactly like the authorized materializer does for the worker.
 */
function renderInputFor(plan, media) {
  const evidence = plan.sourceMediaType === 'image'
    ? media.evidenceImage
    : media.evidenceVideo
  const spec = compileProofModeRenderInput({
    plan,
    projectVersionId: PROJECT_VERSION_ID,
    renderer: RENDERER_IDENTITY,
    presenter: {
      artifactId: media.presenter.artifactId,
      artifactKey: media.presenter.artifactKey,
      kind: 'video',
      sha256: media.presenter.sha256,
      byteSize: media.presenter.byteSize,
    },
    evidence: {
      artifactId: evidence.artifactId,
      artifactKey: evidence.artifactKey,
      kind: evidence.kind,
      sha256: evidence.sha256,
      byteSize: evidence.byteSize,
    },
    subtitles: [{
      text: SUBTITLE_TEXT,
      fromFrame: 0,
      toFrame:
        plan.timing.timelineEntryFrame +
        plan.timing.targetDurationFrames,
      anchor: 'bottom',
    }],
  })
  const uriById = new Map([
    ['primary-video', media.presenter.uri],
    ['proof-evidence', evidence.uri],
  ])
  return Object.freeze({
    ...spec,
    assets: Object.freeze(spec.assets.map((asset) => Object.freeze({
      ...asset,
      uri: uriById.get(asset.id),
    }))),
  })
}

async function renderStill(input, outputPath) {
  const request = {
    schemaVersion: 'apollo-remotion-render-request/v1',
    renderKind: 'still',
    outputPath,
    width: input.output.width,
    height: input.output.height,
    fps: input.output.fps,
    durationInFrames: input.output.durationInFrames,
    frame: Math.floor(input.output.durationInFrames / 2),
    inputProps: compileApolloVideoRenderProps(input),
  }
  await runProcess(
    process.execPath,
    [path.join(process.cwd(), 'remotion', 'scripts', 'render-materialized.mjs')],
    {
      cwd: path.join(process.cwd(), 'remotion'),
      stdin: request,
      timeoutMs: 180_000,
    },
  )
}

/**
 * Runs one proof render through the real durable artifact-render operation:
 * claim, lease, heartbeat, rendering/verifying/persisting phases, checkpoint
 * and success are all produced by the production worker service.
 */
async function renderThroughDurableOperation({
  input,
  outputRoot,
  outputKey,
  stageId,
}) {
  const authorizationId = `authorization-${stageId}`
  const artifactId = `artifact-output-${stageId}`
  const manifestId = `manifest-output-${stageId}`
  const receipt = Object.freeze({
    schemaVersion: 'materialized-render-input-receipt/v1',
    authorizationId,
    artifactId,
    manifestId,
    inputHash: input.inputHash,
    revalidationHash: hash('e'),
    assetCount: input.assets.length,
    revalidatedAt: '2026-07-29T18:00:00.000Z',
    validUntil: '2026-07-29T19:00:00.000Z',
  })
  let materializations = 0
  const render = renderAuthorizedInputService({
    materialize: async () => {
      materializations += 1
      return Object.freeze({
        receipt,
        getRenderInput: () => input,
        toJSON: () => receipt,
      })
    },
    renderer: new RemotionRenderInputRenderer({
      projectRoot: process.cwd(),
      outputRoot,
      timeoutMs: 8 * 60_000,
      createId: () => `proof-stage-${stageId}`,
    }),
    outputKeyFor: () => outputKey,
  })
  const phases = []
  const heartbeats = []
  let checkpoint
  let claimed = false
  let succeeded = false
  const operation = {
    id: `operation-${authorizationId}`,
    workspaceId: 'workspace-proof-goldens',
    clientId: 'client-proof-goldens',
    type: 'artifact-render',
    status: 'queued',
    phase: 'materializing',
    attempt: 1,
    maxAttempts: 1,
    target: { type: 'media-artifact', id: artifactId, manifestId },
  }
  const worker = runNextPublicOperationService({
    operations: {
      async claimNext(request) {
        if (claimed || request.type !== 'artifact-render') return null
        claimed = true
        return {
          operation,
          context: {
            kind: 'artifact-render',
            authorizationId,
            inputHash: input.inputHash,
          },
          lease: {
            owner: request.leaseOwner,
            attempt: 1,
            heartbeatAt: request.now,
            expiresAt: request.leaseUntil,
          },
        }
      },
      async heartbeat(request) {
        heartbeats.push(request.leaseUntil)
        return true
      },
      async advancePhase(request) {
        phases.push(request.phase)
        return true
      },
      async succeed() {
        succeeded = true
        operation.status = 'succeeded'
        return { operation }
      },
      async failOrRetry() {
        operation.status = 'failed'
        return { operation }
      },
    },
    checkpoints: {
      async findByOperationId() { return checkpoint ?? null },
      async record(value) {
        checkpoint = value
        return { checkpoint: value, replayed: false }
      },
    },
    render,
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
  })
  const outcome = await worker(`worker-${stageId}`)
  assert.deepEqual(outcome, {
    operationId: operation.id,
    status: 'succeeded',
  })
  assert.equal(succeeded, true)
  assert.deepEqual(
    phases,
    ['rendering', 'verifying', 'persisting'],
    'the proof render must traverse the durable operation phases',
  )
  assert.ok(
    heartbeats.length >= 2,
    'the worker must renew its lease around verification and persistence',
  )
  assert.ok(
    materializations >= 2,
    'the render input must be revalidated before the output is promoted',
  )
  assert.ok(checkpoint, 'the operation must persist a render checkpoint')
  assert.equal(checkpoint.outputKey, outputKey)
  assert.equal(checkpoint.output.inputHash, input.inputHash)
  return { checkpoint, phases, heartbeats }
}

async function extractFrame(videoPath, frameIndex, outputPath) {
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vf', `select=eq(n\\,${frameIndex})`,
    '-vsync', '0', '-frames:v', '1',
    outputPath,
  ])
}

async function countFrames(videoPath) {
  const stdout = await runProcess(ffprobePath, [
    '-v', 'error', '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'json', videoPath,
  ])
  return Number(JSON.parse(stdout).streams[0].nb_read_frames)
}

function channelValue(value) {
  const scaled = value / 255
  return scaled <= .03928
    ? scaled / 12.92
    : ((scaled + .055) / 1.055) ** 2.4
}

function relativeLuminance(red, green, blue) {
  return .2126 * channelValue(red) +
    .7152 * channelValue(green) +
    .0722 * channelValue(blue)
}

function contrastRatio(first, second) {
  const brighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (brighter + .05) / (darker + .05)
}

async function readRegion(framePath, rect) {
  const left = Math.max(0, Math.round(rect.x))
  const top = Math.max(0, Math.round(rect.y))
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const { data, info } = await sharp(framePath)
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = []
  for (let index = 0; index < data.length; index += info.channels) {
    pixels.push([data[index], data[index + 1], data[index + 2]])
  }
  return { pixels, width: info.width, height: info.height }
}

/**
 * Measures identification legibility inside one text band: the contrast
 * between the rendered glyphs and the band behind them, plus the vertical
 * extent the glyphs actually occupy in pixels.
 */
async function measureTextBand(framePath, rect, options = {}) {
  const inset = options.insetLeft ?? 0
  const region = await readRegion(framePath, {
    x: rect.x + inset,
    y: rect.y,
    width: Math.max(1, rect.width - inset),
    height: rect.height,
  })
  const luminances = region.pixels.map(([red, green, blue]) =>
    relativeLuminance(red, green, blue))
  const sorted = [...luminances].toSorted((left, right) => left - right)
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  const brightRows = new Set()
  let brightPixels = 0
  for (let index = 0; index < region.pixels.length; index += 1) {
    const [red, green, blue] = region.pixels[index]
    if (red >= 200 && green >= 200 && blue >= 200) {
      brightPixels += 1
      brightRows.add(Math.floor(index / region.width))
    }
  }
  const rows = [...brightRows].toSorted((left, right) => left - right)
  return {
    contrast: contrastRatio(percentile(.995), percentile(.10)),
    brightPixels,
    glyphHeightPixels: rows.length === 0
      ? 0
      : rows[rows.length - 1] - rows[0] + 1,
    meanLuminance:
      luminances.reduce((total, value) => total + value, 0) /
        luminances.length,
  }
}

async function meanColor(framePath, rect) {
  const region = await readRegion(framePath, rect)
  const totals = region.pixels.reduce(
    (accumulator, [red, green, blue]) => [
      accumulator[0] + red,
      accumulator[1] + green,
      accumulator[2] + blue,
    ],
    [0, 0, 0],
  )
  return totals.map((value) => value / region.pixels.length)
}

async function accentPixelCount(framePath, rect) {
  const region = await readRegion(framePath, rect)
  return region.pixels.filter(([red, green, blue]) =>
    red >= 190 && green >= 120 && green <= 215 && blue <= 110).length
}

function colorDistance(first, second) {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
  )
}

function centeredProbe(rect, fraction = .2) {
  const width = Math.max(4, Math.round(rect.width * fraction))
  const height = Math.max(4, Math.round(rect.height * fraction))
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  }
}

async function createContactSheet(entries, outputPath) {
  const thumbWidth = 320
  const thumbHeight = 260
  const labelHeight = 46
  const cellWidth = 344
  const cellHeight = thumbHeight + labelHeight + 18
  const composites = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const thumbnail = await sharp(entry.path)
      .resize(thumbWidth, thumbHeight, {
        fit: 'contain',
        background: '#090B10',
      })
      .png()
      .toBuffer()
    const label = Buffer.from(
      `<svg width="${thumbWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#10131A"/>
        <text x="50%" y="29" text-anchor="middle" fill="#FFFFFF"
          font-family="Arial" font-size="19" font-weight="700">${entry.format} · ${entry.mode}</text>
      </svg>`,
    )
    const column = index % OUTPUT_ASPECT_RATIOS.length
    const row = Math.floor(index / OUTPUT_ASPECT_RATIOS.length)
    composites.push({
      input: thumbnail,
      left: column * cellWidth + 12,
      top: row * cellHeight + 12,
    })
    composites.push({
      input: label,
      left: column * cellWidth + 12,
      top: row * cellHeight + 12 + thumbHeight,
    })
  }
  await sharp({
    create: {
      width: cellWidth * OUTPUT_ASPECT_RATIOS.length,
      height: cellHeight * PROOF_MODES.length,
      channels: 3,
      background: '#05070B',
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath)
}

test(
  'T-FR-132 renders fifteen visual goldens and three worker-produced proof MP4s',
  { skip: !enabled, timeout: 30 * 60_000 },
  async (context) => {
    const requestedRoot =
      process.env.APOLLO_PROOF_MODE_VISUAL_E2E_OUTPUT?.trim()
    const directory = requestedRoot
      ? path.join(
          path.resolve(requestedRoot),
          `proof-mode-${Date.now()}-${randomUUID().slice(0, 8)}`,
        )
      : await mkdtemp(path.join(os.tmpdir(), 'apollo-proof-mode-'))
    await mkdir(directory, { recursive: true })
    if (!requestedRoot) {
      context.after(() =>
        rm(directory, { recursive: true, force: true }))
    }
    const media = await createMedia(directory)
    const runs = new Map(PROOF_MODES.map((mode) => [
      mode,
      createModeRun(mode),
    ]))
    const stills = []
    const renderInputHashes = new Set()
    for (const mode of PROOF_MODES) {
      const run = runs.get(mode)
      for (const format of OUTPUT_ASPECT_RATIOS) {
        const plan = run.plans.find((candidate) =>
          candidate.format === format)
        assert.ok(plan)
        assert.equal(plan.mode, mode)
        const input = renderInputFor(plan, media)
        renderInputHashes.add(input.inputHash)
        const outputPath = path.join(
          directory,
          `${format.replace(':', 'x')}-${mode}.png`,
        )
        await renderStill(input, outputPath)
        const metadata = await sharp(outputPath).metadata()
        const statistics = await sharp(outputPath).stats()
        assert.deepEqual(
          [metadata.width, metadata.height],
          [plan.layout.canvas.width, plan.layout.canvas.height],
        )
        assert.ok(
          statistics.channels.some((channel) =>
            channel.max - channel.min >= 80),
          `${format}/${mode} lacks visual contrast`,
        )
        const credit = await measureTextBand(
          outputPath,
          plan.layout.creditRegion,
          { insetLeft: 14 },
        )
        assert.ok(
          credit.contrast >= plan.legibility.minimumContrast,
          `${format}/${mode} attribution contrast ${credit.contrast.toFixed(2)} is below ${plan.legibility.minimumContrast}`,
        )
        assert.ok(
          credit.glyphHeightPixels >=
            Math.round(plan.legibility.minimumFontPixels * .7),
          `${format}/${mode} attribution glyphs measured ${credit.glyphHeightPixels}px, below the legible minimum`,
        )
        const qualifiers = await measureTextBand(
          outputPath,
          plan.layout.qualifierRegion,
        )
        assert.ok(
          qualifiers.contrast >= plan.legibility.minimumContrast,
          `${format}/${mode} qualifier contrast ${qualifiers.contrast.toFixed(2)} is below ${plan.legibility.minimumContrast}`,
        )
        assert.ok(
          qualifiers.brightPixels > 0,
          `${format}/${mode} qualifiers were not drawn`,
        )
        const accent = await accentPixelCount(outputPath, {
          x: plan.layout.creditRegion.x,
          y: plan.layout.creditRegion.y,
          width: 8,
          height: plan.layout.creditRegion.height,
        })
        assert.ok(
          accent > 0,
          `${format}/${mode} lost the attribution identification marker`,
        )
        stills.push({
          format,
          mode,
          path: outputPath,
          planHash: plan.planHash,
          layoutHash: plan.layout.layoutHash,
          attribution: plan.presentation.visual.attribution,
          creditContrast: Number(credit.contrast.toFixed(2)),
          creditGlyphHeightPixels: credit.glyphHeightPixels,
          qualifierContrast: Number(qualifiers.contrast.toFixed(2)),
        })
      }
    }
    assert.equal(stills.length, 15)
    assert.equal(
      renderInputHashes.size,
      15,
      'the fifteen format/mode combinations must stay distinct render inputs',
    )
    assert.equal(
      new Set(stills.map((still) => still.layoutHash)).size,
      15,
      'no proof mode may alias another layout',
    )
    const contactSheetPath = path.join(
      directory,
      'proof-mode-contact-sheet.png',
    )
    await createContactSheet(stills, contactSheetPath)

    const outputRoot = path.join(directory, 'mp4')
    const framesRoot = path.join(directory, 'frames')
    await mkdir(outputRoot, { recursive: true })
    await mkdir(framesRoot, { recursive: true })
    const representatives = [
      ['cutaway', '9:16'],
      ['split-screen', '16:9'],
      ['proof-card', '1:1'],
    ]
    const videos = []
    for (const [mode, format] of representatives) {
      const plan = runs.get(mode).plans.find((candidate) =>
        candidate.format === format)
      assert.ok(plan)
      const input = renderInputFor(plan, media)
      const stageId = `${format.replace(':', 'x')}-${mode}`
      const outputKey = `${stageId}.mp4`
      const durable = await renderThroughDurableOperation({
        input,
        outputRoot,
        outputKey,
        stageId,
      })
      const outputPath = path.join(outputRoot, outputKey)
      const probe = await probeVideo(outputPath)
      assert.deepEqual(
        [probe.width, probe.height],
        [plan.layout.canvas.width, plan.layout.canvas.height],
      )
      assert.equal(
        (await stat(outputPath)).size,
        durable.checkpoint.output.byteSize,
        'the checkpoint must describe the promoted file',
      )
      const frames = await countFrames(outputPath)
      assert.equal(
        frames,
        input.output.durationInFrames,
        `${stageId} rendered ${frames} frames instead of the planned window`,
      )
      const lastFrame = frames - 1
      const midFrame = Math.floor(frames / 2)
      const framePaths = {}
      for (const [label, index] of [
        ['entry', 0],
        ['mid', midFrame],
        ['exit', lastFrame],
      ]) {
        framePaths[label] = path.join(
          framesRoot,
          `${stageId}-${label}.png`,
        )
        await extractFrame(outputPath, index, framePaths[label])
      }

      const entryAccent = await accentPixelCount(framePaths.entry, {
        x: plan.layout.creditRegion.x,
        y: plan.layout.creditRegion.y,
        width: 8,
        height: plan.layout.creditRegion.height,
      })
      const midAccent = await accentPixelCount(framePaths.mid, {
        x: plan.layout.creditRegion.x,
        y: plan.layout.creditRegion.y,
        width: 8,
        height: plan.layout.creditRegion.height,
      })
      const exitAccent = await accentPixelCount(framePaths.exit, {
        x: plan.layout.creditRegion.x,
        y: plan.layout.creditRegion.y,
        width: 8,
        height: plan.layout.creditRegion.height,
      })
      assert.equal(
        plan.timing.entryTransition.kind,
        'crossfade',
        `${stageId} measured rhythm must fade the proof in`,
      )
      assert.ok(
        plan.timing.entryTransition.durationFrames >= 4,
        `${stageId} entry transition is too short to read`,
      )
      assert.ok(
        entryAccent < midAccent,
        `${stageId} entry frame already shows the finished proof (${entryAccent} vs ${midAccent} accent pixels)`,
      )
      assert.equal(
        plan.timing.exitTransition.kind,
        'cut',
        `${stageId} exit transition changed`,
      )
      assert.ok(
        exitAccent > 0 && exitAccent >= Math.round(midAccent * .8),
        `${stageId} exit frame lost the attribution (${exitAccent} vs ${midAccent})`,
      )

      const credit = await measureTextBand(
        framePaths.mid,
        plan.layout.creditRegion,
        { insetLeft: 14 },
      )
      const qualifiers = await measureTextBand(
        framePaths.mid,
        plan.layout.qualifierRegion,
      )
      assert.ok(
        credit.contrast >= plan.legibility.minimumContrast,
        `${stageId} attribution contrast ${credit.contrast.toFixed(2)} below ${plan.legibility.minimumContrast}`,
      )
      assert.ok(
        credit.glyphHeightPixels >=
          Math.round(plan.legibility.minimumFontPixels * .7),
        `${stageId} attribution glyphs measured ${credit.glyphHeightPixels}px`,
      )
      assert.ok(
        qualifiers.contrast >= plan.legibility.minimumContrast,
        `${stageId} qualifier contrast ${qualifiers.contrast.toFixed(2)} below ${plan.legibility.minimumContrast}`,
      )
      assert.ok(
        qualifiers.brightPixels > 0,
        `${stageId} qualifiers were not drawn`,
      )

      const evidenceColor = await meanColor(
        framePaths.mid,
        centeredProbe(plan.layout.evidenceRegion),
      )
      let modeSignal
      if (mode === 'cutaway') {
        assert.equal(plan.layout.presenterRegion, undefined)
        const entryEvidence = await meanColor(
          framePaths.entry,
          centeredProbe(plan.layout.evidenceRegion),
        )
        modeSignal = colorDistance(evidenceColor, entryEvidence)
        assert.ok(
          modeSignal >= 24,
          `${stageId} cutaway never replaced the presenter (distance ${modeSignal.toFixed(1)})`,
        )
      } else if (mode === 'split-screen') {
        assert.ok(plan.layout.presenterRegion)
        const presenterColor = await meanColor(
          framePaths.mid,
          centeredProbe(plan.layout.presenterRegion),
        )
        modeSignal = colorDistance(evidenceColor, presenterColor)
        assert.ok(
          modeSignal >= 24,
          `${stageId} split screen shows the same source twice (distance ${modeSignal.toFixed(1)})`,
        )
      } else {
        assert.equal(plan.layout.presenterRegion, undefined)
        const cornerColor = await meanColor(framePaths.mid, {
          x: 4,
          y: 4,
          width: Math.round(plan.layout.canvas.width * .06),
          height: Math.round(plan.layout.canvas.height * .06),
        })
        const cornerLuminance = relativeLuminance(...cornerColor)
        const cardLuminance = relativeLuminance(...evidenceColor)
        modeSignal = cardLuminance / Math.max(cornerLuminance, 1e-6)
        assert.ok(
          cornerLuminance <= .1,
          `${stageId} proof card did not dim the background (luminance ${cornerLuminance.toFixed(3)})`,
        )
        assert.ok(
          modeSignal >= 3,
          `${stageId} proof card does not stand out from its background (ratio ${modeSignal.toFixed(1)})`,
        )
      }

      videos.push({
        mode,
        format,
        path: outputPath,
        outputKey,
        sha256: durable.checkpoint.output.outputSha256,
        byteSize: durable.checkpoint.output.byteSize,
        inputHash: input.inputHash,
        planHash: plan.planHash,
        frames,
        phases: durable.phases,
        heartbeats: durable.heartbeats.length,
        attribution: plan.presentation.visual.attribution,
        qualifiers: plan.presentation.visual.qualifiers,
        entryAccentPixels: entryAccent,
        midAccentPixels: midAccent,
        exitAccentPixels: exitAccent,
        creditContrast: Number(credit.contrast.toFixed(2)),
        creditGlyphHeightPixels: credit.glyphHeightPixels,
        qualifierContrast: Number(qualifiers.contrast.toFixed(2)),
        modeSignal: Number(modeSignal.toFixed(2)),
        framePaths,
      })
    }
    assert.equal(videos.length, 3)
    assert.equal(
      new Set(videos.map((video) => video.sha256)).size,
      3,
      'the three proof modes must produce three different videos',
    )
    await writeFile(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: 'proof-mode-visual-evidence/v2',
        renderedThrough: 'public-operation-worker/artifact-render',
        stills,
        videos,
        contactSheetPath,
      }, null, 2)}\n`,
      'utf8',
    )
    process.stdout.write(
      `ProofMode visual evidence: ${directory}\n`,
    )
  },
)
