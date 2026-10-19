import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createOracle, BASE } from './oracle-config.mjs'
import { evaluateOutput, summarize } from './corpus-evaluate.mjs'
import { buildFrozenManifest, codeHashes, sha256Bytes } from './corpus-generate.mjs'
import { FORMATS, faceRectOf, toOutput, visibleShare } from './corpus-geometry.mjs'
import {
  createRenderer, criticRequest, encodeSource, outputSpecOf, planOutput, presetBands, renderOutput, sha256Of, TIMELINE,
} from './render-world.mjs'

const { FfmpegMp4PixelCritic } = await import('../../../src/v2/infrastructure/media/ffmpeg-mp4-pixel-critic.ts')
const { measureInk } = await import('../../../src/v2/domain/mp4-pixel-geometry.ts')
const { safeAreaOvershootPixels, verifyMp4QualityReport, MP4_PIXEL_CRITIC_POLICY_SHA256 } = await import('../../../src/v2/domain/mp4-pixel-quality.ts')
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')
const { critiqueOutputFormat, selectExportableVariants } = await import('../../../src/v2/domain/format-quality-critic.ts')
const { sealMp4Evidence } = await import('../../../src/v2/domain/mp4-pixel-quality.ts')

/**
 * W67 controlled corpus, RUN phases. `render` builds the sources and renders every output (delivered + the three controls) through the
 * product renderer; `evaluate` runs the critic with the real oracle on the delivered files and compares its sealed reports with the labels.
 * Both refuse to start unless the frozen manifest re-derives byte for byte and every frozen code file still has its frozen hash.
 *
 *   node corpus-run.mjs render   <frozen.json> <out-dir>
 *   node corpus-run.mjs evaluate <frozen.json> <out-dir>
 */
const require = createRequire(import.meta.url)
const ffmpegPath = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? require('ffmpeg-static')
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const [phase, frozenPath, outDirectory] = process.argv.slice(2)
if (!['render', 'evaluate'].includes(phase) || !frozenPath || !outDirectory) throw new Error('usage: corpus-run.mjs <render|evaluate> <frozen.json> <out-dir>')

const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'))
const hashWithoutTime = (manifest) => { const { manifestHash: _hash, frozenAtUtc: _time, ...body } = manifest; return calculateCanonicalHash({ ...body, frozenAtUtc: null }) }
const currentCode = codeHashes(repositoryRoot)
const codeDrift = Object.entries(frozen.codeHashes).filter(([path, hash]) => currentCode[path] !== hash).map(([path]) => path)
if (codeDrift.length > 0) throw new Error(`frozen code changed after the freeze: ${codeDrift.join(', ')}`)
const rebuilt = await buildFrozenManifest({ repositoryRoot, set: frozen.selection.source.set, count: frozen.selection.count, visualExclusions: frozen.selection.visualExclusions, forcedIds: frozen.selection.forcedIds ?? null, now: new Date(frozen.frozenAtUtc) })
if (hashWithoutTime(rebuilt) !== hashWithoutTime(frozen)) throw new Error('the frozen manifest does not re-derive from the frozen inputs')
if (frozen.policy.sha256 !== MP4_PIXEL_CRITIC_POLICY_SHA256) throw new Error('the critic policy differs from the frozen policy')
mkdirSync(outDirectory, { recursive: true })

const startedAt = new Date().toISOString()
const manifest = JSON.parse(readFileSync(`${BASE}/openimages-w61-v5-manifest.json`, 'utf8'))
if (sha256Bytes(`${BASE}/openimages-w61-v5-manifest.json`) !== frozen.selection.source.manifestSha256) throw new Error('V5 manifest differs from the frozen one')
const items = manifest.sets[frozen.selection.source.set].selected
const outputsDirectory = join(outDirectory, 'outputs')
const sourcesDirectory = join(outDirectory, 'sources')
mkdirSync(outputsDirectory, { recursive: true }); mkdirSync(sourcesDirectory, { recursive: true })
const ffmpegVersion = execFileSync(ffmpegPath, ['-version'], { windowsHide: true }).toString().split('\n')[0]
const ffmpegSha256 = sha256Of(ffmpegPath)
const pathOf = (output, kind) => join(outputsDirectory, output.id, `${kind}.mp4`)

async function renderPhase() {
  const ledger = { phase: 'render', startedAt, ffmpegVersion, ffmpegSha256, harnessRunId: process.env.APOLLO_S2D_RUN_ID ?? null, frozenManifestHash: frozen.manifestHash, sources: [], outputs: [] }
  const renderer = createRenderer({ workRoot: join(outDirectory, 'work'), ffmpegPath })
  const sources = new Map()
  for (const image of frozen.images) {
    const item = items.find((candidate) => candidate.id === image.id)
    const bytesSha = sha256Of(item.mirrorPath)
    if (bytesSha !== image.mirrorSha256) throw new Error(`mirror bytes of ${image.id} differ from the frozen hash`)
    const encoded = encodeSource({ ffmpegPath, imagePath: item.mirrorPath, outPath: join(sourcesDirectory, `${image.id}.mp4`) })
    sources.set(image.id, encoded)
    ledger.sources.push({ imageId: image.id, mirrorSha256: bytesSha, sourcePath: encoded.path, sourceSha256: encoded.sha256, bytes: statSync(encoded.path).size })
  }
  const bands = {}
  for (const format of Object.keys(FORMATS)) bands[format] = await presetBands(format, { width: 1024, height: 768 })
  for (const output of frozen.outputs) {
    const item = items.find((candidate) => candidate.id === output.imageId)
    const spec = outputSpecOf({ imageId: output.imageId, format: output.format, variant: output.variant, face: faceRectOf(item.boxes[0]), source: { width: item.mirrorWidth, height: item.mirrorHeight }, bands: bands[output.format] })
    const planned = await planOutput(spec, bands[output.format])
    const entry = { outputId: output.id, plannerDecision: { anchor: planned.decision.anchor, disposition: planned.decision.disposition, expectedTarget: spec.framing.target, blockers: spec.blockers }, placementPlanHash: planned.placementPlan.placementPlanHash, reframePlanHash: planned.reframePlan.reframePlanHash, files: {} }
    for (const kind of ['delivered', 'captions-off', 'cta-off', 'overlays-off']) {
      const started = Date.now()
      const rendered = await renderOutput({ renderer, spec, planned, sourcePath: sources.get(output.imageId).path, kind })
      mkdirSync(join(outputsDirectory, output.id), { recursive: true })
      copyFileSync(rendered.outputPath, pathOf(output, kind))
      entry.files[kind] = { sha256: sha256Of(pathOf(output, kind)), bytes: statSync(pathOf(output, kind)).size, renderMs: Date.now() - started, rendererSha256: rendered.sha256 }
      if (entry.files[kind].sha256 !== rendered.sha256) throw new Error(`copied ${kind} of ${output.id} differs from the render`)
      // the renderer's own element map of the delivered file: the export-gate proof hands it to the variant's format critic, as the worker does
      if (kind === 'delivered') writeFileSync(join(outputsDirectory, output.id, 'render-element-map.json'), JSON.stringify(rendered.renderElementMap))
      await renderer.cleanup(`${output.id}-${kind}`).catch(() => undefined)
    }
    ledger.outputs.push(entry)
    console.log(JSON.stringify({ event: 'rendered', output: output.id, anchor: entry.plannerDecision.anchor, expected: entry.plannerDecision.expectedTarget, delivered: entry.files.delivered.sha256.slice(0, 12) }))
  }
  ledger.finishedAt = new Date().toISOString()
  writeFileSync(join(outDirectory, 'render-ledger.json'), JSON.stringify(ledger, null, 2))
}

function decodeFrame(path, frame, width, height) {
  const bytes = execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (bytes.byteLength !== width * height * 3) throw new Error(`frame ${frame} of ${path} did not decode`)
  return bytes
}

/** Reference check of the LABELS on the delivered pixels, from the human box by construction (not an input of the critic). */
function labelSanity(output, item) {
  const canvas = FORMATS[output.format]
  const face = faceRectOf(item.boxes[0])
  const placed = (frame) => toOutput(face, frame < 45 ? output.windowA : output.windowB)
  const rectPx = (box) => ({ x0: Math.max(0, Math.floor(box.x0 * canvas.width)), y0: Math.max(0, Math.floor(box.y0 * canvas.height)), x1: Math.min(canvas.width, Math.ceil(box.x1 * canvas.width)), y1: Math.min(canvas.height, Math.ceil(box.y1 * canvas.height)) })
  const result = { captionOverGroundTruthFace: null, ctaOvershootPixels: null, groundTruthVisibleShareAtFrame60: visibleShare(placed(60)) }
  const midCue = Math.floor((TIMELINE.cue.startFrame + TIMELINE.cue.endFrame) / 2), midCta = Math.floor((TIMELINE.cta.startFrame + TIMELINE.cta.endFrame) / 2)
  const d = pathOf(output, 'delivered')
  const caption = measureInk(decodeFrame(d, midCue, canvas.width, canvas.height), decodeFrame(pathOf(output, 'captions-off'), midCue, canvas.width, canvas.height), canvas.width, canvas.height)
  const rect = rectPx(placed(midCue))
  let overlap = 0
  if (caption.mask) for (let y = rect.y0; y < rect.y1; y += 1) for (let x = rect.x0; x < rect.x1; x += 1) overlap += caption.mask[y * canvas.width + x]
  result.captionOverGroundTruthFace = { frame: midCue, inkPixels: caption.facts.pixels, inkInsideHumanBox: overlap }
  const cta = measureInk(decodeFrame(d, midCta, canvas.width, canvas.height), decodeFrame(pathOf(output, 'cta-off'), midCta, canvas.width, canvas.height), canvas.width, canvas.height)
  result.ctaOvershootPixels = cta.facts.bbox ? { frame: midCta, overshoot: safeAreaOvershootPixels(cta.facts.bbox, canvas, canvas.safeArea), bbox: cta.facts.bbox } : { frame: midCta, overshoot: null }
  return result
}

async function evaluatePhase() {
  const ledger = JSON.parse(readFileSync(join(outDirectory, 'render-ledger.json'), 'utf8'))
  if (ledger.frozenManifestHash !== frozen.manifestHash) throw new Error('the render ledger belongs to another freeze')
  const reportsDirectory = join(outDirectory, 'reports'); mkdirSync(reportsDirectory, { recursive: true })
  const oracle = await createOracle()
  const evaluations = [], extras = []
  for (const output of frozen.outputs) {
    for (const [kind, file] of Object.entries(ledger.outputs.find((entry) => entry.outputId === output.id).files)) {
      if (sha256Of(pathOf(output, kind)) !== file.sha256) throw new Error(`${output.id}/${kind} bytes changed since the render`)
    }
    const item = items.find((candidate) => candidate.id === output.imageId)
    const source = ledger.sources.find((entry) => entry.imageId === output.imageId)
    const spec = outputSpecOf({ imageId: output.imageId, format: output.format, variant: output.variant, face: faceRectOf(item.boxes[0]), source: { width: item.mirrorWidth, height: item.mirrorHeight }, bands: { ...frozen.formats[output.format].bands } })
    const critic = new FfmpegMp4PixelCritic({ oracle, workRoot: join(outDirectory, 'critic-work'), ffmpegPath, ffmpegBinarySha256: ffmpegSha256 })
    const started = Date.now()
    const verification = await critic.verify(criticRequest({
      spec, deliveredPath: pathOf(output, 'delivered'), sourcePath: source.sourcePath, sourceSha256: source.sourceSha256,
      renderInputHash: calculateCanonicalHash({ output: output.id, placementPlanHash: ledger.outputs.find((entry) => entry.outputId === output.id).placementPlanHash, reframePlanHash: ledger.outputs.find((entry) => entry.outputId === output.id).reframePlanHash }),
      renderControl: async (kind) => ({ path: pathOf(output, kind) }),
    }))
    verifyMp4QualityReport(verification.report)
    writeFileSync(join(reportsDirectory, `${output.id}.json`), JSON.stringify(verification.report, null, 2))
    const evaluation = evaluateOutput({ outputId: output.id, format: output.format, variant: output.variant, labels: output.labels, report: verification.report })
    evaluations.push(evaluation)
    // informational measurements against the human box, by construction
    const gt = (frame) => toOutput(faceRectOf(item.boxes[0]), frame < 45 ? output.windowA : output.windowB)
    const iouWith = (box, rect) => { const x0 = Math.max(box.x, rect.x0), y0 = Math.max(box.y, rect.y0), x1 = Math.min(box.x + box.width, rect.x1), y1 = Math.min(box.y + box.height, rect.y1); const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return inter / (box.width * box.height + (rect.x1 - rect.x0) * (rect.y1 - rect.y0) - inter) }
    const perModel = { 'oracle-0204-v9': { visible: 0, found: 0, extra: 0 }, 'oracle-retail-0004': { visible: 0, found: 0, extra: 0 }, union: { visible: 0, found: 0, extra: 0 } }
    const registrationError = []
    for (const sample of verification.report.samples) {
      const rect = gt(sample.frameIndex)
      const fully = visibleShare(rect) >= 0.999
      const boxes = sample.facts.protectedRegions.filter((region) => region.origin !== 'source-projection')
      for (const [model, counters] of Object.entries(perModel)) {
        const own = model === 'union' ? boxes : boxes.filter((region) => region.origin === model)
        if (fully) { counters.visible += 1; if (own.some((region) => iouWith(region.box, rect) >= 0.3)) counters.found += 1 }
        counters.extra += own.filter((region) => iouWith(region.box, rect) < 0.1).length
      }
      if (sample.facts.subject.state === 'measured') {
        const p = sample.facts.subject.projected
        const expected = rect
        const ix = Math.max(0, Math.min(p.x1, expected.x1) - Math.max(p.x0, expected.x0)), iy = Math.max(0, Math.min(p.y1, expected.y1) - Math.max(p.y0, expected.y0))
        const union = (p.x1 - p.x0) * (p.y1 - p.y0) + (expected.x1 - expected.x0) * (expected.y1 - expected.y0) - ix * iy
        registrationError.push({ frame: sample.frameIndex, iouWithConstruction: (ix * iy) / union })
      }
    }
    const iouValues = registrationError.map((entry) => entry.iouWithConstruction).toSorted((a, b) => a - b)
    extras.push({ outputId: output.id, oracleVsHumanBox: perModel, projection: { frames: iouValues.length, medianIou: iouValues[Math.floor(iouValues.length / 2)] ?? null, minIou: iouValues[0] ?? null }, labelSanity: labelSanity(output, item), criticMs: Date.now() - started, reportHash: verification.report.reportHash })
    console.log(JSON.stringify({ event: 'evaluated', output: output.id, verdict: verification.report.verdict, issues: verification.report.issues.map((issue) => [issue.code, issue.severity, issue.evidenceRange.startFrame, issue.evidenceRange.endFrame]) }))
  }
  // ---- the export gate on the real reports: the production domain gate decides, and only an approved variant is promoted ----
  // The promotion here is an emulation (a content-addressed copy into a private directory); the decision is the production code's
  // (critiqueOutputFormat + selectExportableVariants). The worker-level proof (no storage call for a blocked variant) is in
  // tests/v2/project-final-export.test.mjs.
  const formatReports = new Map()
  for (const output of frozen.outputs) {
    const report = JSON.parse(readFileSync(join(reportsDirectory, `${output.id}.json`), 'utf8'))
    const map = JSON.parse(readFileSync(join(outputsDirectory, output.id, 'render-element-map.json'), 'utf8'))
    formatReports.set(output.id, critiqueOutputFormat({
      outputSpecId: report.identity.outputSpecId, format: output.format, proxyHash: report.artifact.sha256, map,
      mp4PixelIssues: report.issues, mp4Evidence: sealMp4Evidence(report),
    }))
  }
  const promotedDirectory = join(outDirectory, 'promoted'); mkdirSync(promotedDirectory, { recursive: true })
  const gate = []
  for (const output of frozen.outputs) {
    const selection = selectExportableVariants([formatReports.get(output.id)])
    const approved = selection.approvedOutputSpecIds.length === 1
    if (approved) copyFileSync(pathOf(output, 'delivered'), join(promotedDirectory, `${sha256Of(pathOf(output, 'delivered'))}.mp4`))
    gate.push({ outputId: output.id, format: output.format, variant: output.variant, approved, blockingCodes: selection.decisions[0].blockingCodes, warningCodes: selection.decisions[0].warningCodes })
  }
  // independence between formats: the 9:16 and the 16:9 of one photograph, in every pairing of a clean and a defective variant
  const independence = []
  for (const image of frozen.images) for (const [tall, wide] of [['combined', 'clean'], ['clean', 'combined'], ['caption', 'crop'], ['cta', 'clean']]) {
    const tallReport = formatReports.get(`${image.id}-9x16-${tall}`), wideReport = formatReports.get(`${image.id}-16x9-${wide}`)
    const selection = selectExportableVariants([tallReport, wideReport])
    independence.push({ imageId: image.id, tall, wide, approved: selection.approvedOutputSpecIds, blocked: selection.blockedOutputSpecIds })
  }
  const exportGate = { decisions: gate, independence, promotedFiles: gate.filter((entry) => entry.approved).length, blockedVariants: gate.filter((entry) => !entry.approved).length }
  const summary = summarize(evaluations)
  writeFileSync(join(outDirectory, 'evaluation.json'), JSON.stringify({ phase: 'evaluate', startedAt, finishedAt: new Date().toISOString(), frozenManifestHash: frozen.manifestHash, summary, evaluations, extras, exportGate }, null, 2))
  console.log(JSON.stringify({ event: 'summary', accepted: summary.accepted, totals: summary.totals }))
  // contact sheets: eleven delivered frames of every output, tiled, for the visual review (private, never committed)
  const sheets = join(outDirectory, 'contact-sheets'); mkdirSync(sheets, { recursive: true })
  for (const output of frozen.outputs) {
    const frames = [0, 8, 17, 27, 31, 37, 43, 44, 45, 60, 89].map((frame) => `eq(n\\,${frame})`).join('+')
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', pathOf(output, 'delivered'), '-vf', `select=${frames},scale=${output.format === '9:16' ? 180 : 320}:-1,tile=${output.format === '9:16' ? 11 : 4}x${output.format === '9:16' ? 1 : 3}`, '-frames:v', '1', join(sheets, `${output.id}.png`)], { windowsHide: true })
  }
}

if (phase === 'render') await renderPhase()
else await evaluatePhase()
if (!existsSync(outDirectory)) throw new Error('no output directory')
