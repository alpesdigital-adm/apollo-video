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
  compileProofModeRenderScene,
} from '../../src/v2/application/compile-proof-mode-render-scene.ts'
import {
  createProofModeRun,
  PROOF_MODES,
} from '../../src/v2/domain/proof-mode.ts'
import {
  OUTPUT_ASPECT_RATIOS,
  OUTPUT_PRESETS,
} from '../../src/v2/domain/output-spec.ts'
import {
  createRenderInputSpec,
} from '../../src/v2/domain/render-input.ts'
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
const hash = (character) => character.repeat(64)

async function runProcess(
  executable,
  args,
  options = {},
) {
  await new Promise((resolveProcess, rejectProcess) => {
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
      else resolveProcess()
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
    '-i', 'color=c=0x204A74:s=640x360:r=30:d=6',
    '-f', 'lavfi',
    '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
    '-vf', 'drawbox=x=220:y=70:w=200:h=220:color=0xE3B38B:t=fill',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    presenterPath,
  ])
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=s=640x360:r=30:d=6',
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

function renderInputFor(plan, media) {
  const output = OUTPUT_PRESETS[plan.format]
  const evidence = plan.sourceMediaType === 'image'
    ? media.evidenceImage
    : media.evidenceVideo
  const durationInFrames = plan.timing.targetDurationFrames
  const scene = compileProofModeRenderScene({
    plan,
    evidenceAssetId: 'proof-evidence',
    fps: output.fps,
    timelineDurationFrames: durationInFrames,
  })
  const spec = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: {
      id: 'remotion',
      version: '4.0.489',
      digest: hash('8'),
    },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: {
      id: plan.id,
      versionId: 'project-version-proof-goldens',
      hash: plan.planHash,
    },
    output: {
      ...output,
      id: `proof-${plan.format.replace(':', 'x')}-${plan.mode}`,
      durationInFrames,
    },
    assets: [
      {
        id: 'primary-video',
        artifactId: media.presenter.artifactId,
        artifactKey: media.presenter.artifactKey,
        kind: 'video',
        role: 'presenter',
        ordinal: 0,
        sha256: media.presenter.sha256,
        byteSize: media.presenter.byteSize,
      },
      {
        id: 'proof-evidence',
        artifactId: evidence.artifactId,
        artifactKey: evidence.artifactKey,
        kind: evidence.kind,
        role: 'proof-evidence',
        ordinal: 1,
        sha256: evidence.sha256,
        byteSize: evidence.byteSize,
      },
    ],
    props: {
      primaryVideoAssetId: 'primary-video',
      scenes: [scene],
      subtitles: [{
        text: 'Esta legenda deve ficar oculta durante a prova',
        fromFrame: 0,
        toFrame: durationInFrames,
        anchor: 'bottom',
      }],
      palette: {
        primary: '#FFB800',
        secondary: '#20202A',
        accent: '#FFB800',
        text: '#FFFFFF',
        background: '#050508',
      },
      stylePreset: 'creator-clean',
      subtitleStyle: 'kinetic',
      gradePreset: 'natural',
    },
  })
  return Object.freeze({
    ...spec,
    assets: Object.freeze(spec.assets.map((asset) => ({
      ...asset,
      uri: asset.id === 'primary-video'
        ? media.presenter.uri
        : evidence.uri,
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
  'T-FR-132 renders and inspects 15 visual goldens plus three real MP4 modes',
  { skip: !enabled, timeout: 20 * 60_000 },
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
    for (const mode of PROOF_MODES) {
      const run = runs.get(mode)
      for (const format of OUTPUT_ASPECT_RATIOS) {
        const plan = run.plans.find((candidate) =>
          candidate.format === format)
        assert.ok(plan)
        const input = renderInputFor(plan, media)
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
        stills.push({ format, mode, path: outputPath })
      }
    }
    assert.equal(stills.length, 15)
    const contactSheetPath = path.join(
      directory,
      'proof-mode-contact-sheet.png',
    )
    await createContactSheet(stills, contactSheetPath)

    const outputRoot = path.join(directory, 'mp4')
    await mkdir(outputRoot, { recursive: true })
    let stageSequence = 0
    const renderer = new RemotionRenderInputRenderer({
      projectRoot: process.cwd(),
      outputRoot,
      timeoutMs: 8 * 60_000,
      createId: () => `proof-stage-${++stageSequence}`,
    })
    const representatives = [
      ['cutaway', '9:16'],
      ['split-screen', '16:9'],
      ['proof-card', '1:1'],
    ]
    const videos = []
    for (const [mode, format] of representatives) {
      const plan = runs.get(mode).plans.find((candidate) =>
        candidate.format === format)
      const input = renderInputFor(plan, media)
      const outputKey =
        `${format.replace(':', 'x')}-${mode}.mp4`
      const staged = await renderer.stage(input, { outputKey })
      const receipt = await staged.commit()
      const outputPath = path.join(outputRoot, outputKey)
      const probe = await probeVideo(outputPath)
      assert.deepEqual(
        [probe.width, probe.height],
        [plan.layout.canvas.width, plan.layout.canvas.height],
      )
      assert.equal(receipt.inputHash, input.inputHash)
      videos.push({
        mode,
        format,
        path: outputPath,
        sha256: receipt.outputSha256,
      })
    }
    await writeFile(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: 'proof-mode-visual-evidence/v1',
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
