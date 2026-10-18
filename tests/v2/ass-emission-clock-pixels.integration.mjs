import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { ASS_EMISSION_POLICY } from '../../src/v2/domain/ass-emission-policy.ts'
import { assCentisecondTimestamp, derivePinnedLibassNowMs, isAssBoundaryUnrepresentable } from '../../src/v2/domain/libass-clock-model.ts'
import { buildPreLibassClockStage } from '../../src/v2/infrastructure/media/ffmpeg-editorial-composition-graph.ts'
import { buildAssSubtitles, sliceRenderRange } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

const require = createRequire(import.meta.url)
const WIDTH = 320, HEIGHT = 240, FRAMES = 6
const ABSOLUTE_BUDGET_MS = 420000, PROCESS_BUDGET_MS = 30000
const frameSize = WIDTH * HEIGHT * 3

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
function errorEvidence(error) {
  const message = String(error?.message ?? error ?? '')
  const portable = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : null
  return { name: portable(error?.name), code: portable(error?.code),
    messageSha256: sha256(message), messageBytes: Buffer.byteLength(message, 'utf8') }
}

function observedPreLibassClock(log, indices) {
  const lines = log.split('\n').filter((line) => /\[Parsed_showinfo_/.test(line))
  const configurations = lines.filter((line) => /config (?:in|out) time_base:/.test(line))
  const timeBases = configurations.flatMap((line) => {
    const match = /config in time_base:\s*(-?\d+)\/(\d+)/.exec(line)
    return match ? [{ numerator: match[1], denominator: match[2] }] : []
  })
  const frames = lines.flatMap((line) => {
    const match = /\bn:\s*(\d+)\s+pts:\s*(-?\d+|NOPTS)\s+pts_time:\s*(\S+)/.exec(line)
    return match ? [{ frame: Number(match[1]), pts: match[2], ptsTimeText: match[3] }] : []
  })
  return { provider: 'FFmpeg showinfo immediately before libass', configurations, timeBases,
    // Integer PTS and rational time_base are retained as strings. The printed
    // pts_time is diagnostic text, not an arithmetic oracle or a rounded repair.
    frames, window: frames.filter((frame) => indices.includes(frame.frame)),
    status: timeBases.length && frames.length ? 'observed' : 'unavailable' }
}

/** Controlled text/geometry fixture, not a claim of verified facial perception.
 * Oracle is decoded FFmpeg pixels, never the arithmetic helper. Official
 * libavfilter/vf_subtitles.c passes pts * time_base * 1000 to ass_render_frame:
 * https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_subtitles.c */
function document(layer, fps, startFrame, endFrame, fontFamily) {
  const cue = { id: 'clock-cue', startFrame, endFrame, text: 'CLOCK' }
  // The streams under test hold at least four frames after the cue; the end of the fragment is not under test here.
  return buildAssSubtitles({ width: WIDTH, height: HEIGHT, fps, durationFrames: Math.max(FRAMES, endFrame + 4),
    cues: layer === 0 ? [cue] : [],
    ctaOverlays: layer === 1 ? [cue] : [],
    anchorPlan: layer === 0 ? { schemaVersion: 'subtitle-anchor-plan/v2', decisions: [{
      cueId: cue.id, suppressed: false, bounds: { x: 0.1, y: 0.6, width: 0.8, height: 0.2 },
    }] } : null,
  }).replaceAll(',Arial,', `,${fontFamily},`)
}

function boundaryClockPrefix(fps, start, clock) {
  return clock === 'lavfi' ? '' :
    `split=2[first][second];[first]trim=start_frame=0:end_frame=${start},setpts=PTS-STARTPTS,fps=${fps},setsar=1,format=yuv420p[firstout];` +
    `[second]trim=start_frame=${start}:end_frame=${start + 4},setpts=PTS-STARTPTS,fps=${fps},setsar=1,format=yuv420p[secondout];` +
    '[firstout][secondout]concat=n=2:v=1:a=0'
}

// These controls are explicit ASS fixtures, not a change to emission policy.
// Before/after pixel coverage discriminates sides of a boundary; it does not
// measure the integer timestamp passed inside libass or imply now=99ms.
const DIFFERENTIAL_TARGETS = [
  { fps: 60, target: 6, before: ['0:00:00.09', '0:00:00.10'], after: ['0:00:00.10', '0:00:00.11'] },
  { fps: 30, target: 111, before: ['0:00:03.69', '0:00:03.70'], after: ['0:00:03.70', '0:00:03.71'] },
  { fps: 100, target: 803, before: ['0:00:08.02', '0:00:08.03'], after: ['0:00:08.03', '0:00:08.04'] },
]
function differentialAss(layer, fps, target, fontFamily, interval) {
  const base = fps === 120 ? 2 : 1 // the target itself may be refused; the base only carries the event text
  const lines = document(layer, fps, base, base + 1, fontFamily).split('\n')
  let events = 0
  const result = lines.map((line) => {
    if (!line.startsWith('Dialogue:')) return line
    events += 1
    const fields = line.split(',')
    fields[1] = interval[0]; fields[2] = interval[1]
    return fields.join(',')
  }).join('\n')
  assert.equal(events, 1, 'differential fixture must change exactly one event interval')
  return result
}
// 100 fps frame 803 reaches libass at 8029 ms after frame 802 at 8020 ms: no centisecond lies in (8020, 8029],
// so no ASS event starts exactly there. The expectation is a typed refusal, proven below by exhausting the
// neighbouring centisecond pairs against real pixels. Every other target is bound and lights exactly its frame.
const BOUNDARY_TARGETS = [[30, 3], [60, 6], [30, 111], [60, 111], [100, 803]]
const REFUSED_TARGETS = new Set(['100:803'])
function originalCaseSchedule() {
  const cases = []
  const add = (metadata) => cases.push({ ...metadata, status: 'not-executed' })
  for (const [fps, start, end, expected] of [[30, 1, 2, [1]], [60, 1, 2, [1]], [100, 1, 2, [1]], [120, 2, 3, [2]]]) {
    for (const layer of [0, 1]) add({ fps, layer, interval: [start, end], expectedChangedFrames: expected })
    add({ fps, layer: 'empty', expectedChangedFrames: [] })
    add({ fps, layer: 'suppressed', interval: [1, 2], expectedChangedFrames: [] })
  }
  for (const [fps, start] of BOUNDARY_TARGETS)
    for (const clock of ['lavfi', 'trim-setpts-fps-concat'])
      for (const layer of [0, 1]) {
        const expectedBinding = REFUSED_TARGETS.has(`${fps}:${start}`) ? 'refused' : 'bound'
        add({ fps, layer, clock, interval: [start, start + 1], expectedBinding,
          expectedChangedFrames: expectedBinding === 'bound' ? [start] : null })
      }
  for (const layer of [0, 1]) add({ fps: 30, layer, clock: 'adjacent-cues', intervals: [[1, 2], [2, 3]],
    expectedFrames: { first: [1], next: [2], baseline: [0, 3, 4, 5] } })
  add({ fps: 30, layer: 1, clock: 'clipped-rebased-fragment', globalInterval: [3, 8],
    renderRange: [5, 9], expectedLocalIntervals: [[0, 3]], expectedChangedFrames: [0, 1, 2] })
  add({ fps: 30, layer: 1, clock: 'rounded-end-regression-control', interval: [1, 2],
    alteredAssEnd: '0:00:00.07', expectedChangedFrames: [1, 2] })
  for (const layer of [0, 1]) add({ fps: 120, layer, interval: [1, 2], expectedRejection: 'ASS_BOUNDARY_UNREPRESENTABLE' })
  return cases
}

const PIXEL_CAPTURE_POLICY = Object.freeze({ schemaVersion: 'ass-clock-pixel-capture-budget/v1',
  maxWindowFrames: 6, maxRequestedFrame: 805, lookaheadFrames: 1,
  logHeaderBytes: 64 * 1024, logBytesPerProcessedFrame: 1024, maxCombinedBytes: 4 * 1024 * 1024 })
function pixelCaptureBudget(indices) {
  assert.ok(Array.isArray(indices) && indices.length > 0 && indices.length <= PIXEL_CAPTURE_POLICY.maxWindowFrames &&
    indices.every((frame, index) => Number.isSafeInteger(frame) && frame >= 0 &&
      frame <= PIXEL_CAPTURE_POLICY.maxRequestedFrame && (index === 0 || frame === indices[index - 1] + 1)),
  'Pixel capture must use a declared contiguous frame window')
  // showinfo precedes select: late windows process all earlier frames. The
  // fixed graph can also expose one frame after the requested window (v4:806
  // for the requested last805). Reserve logs by that processing count, not
  // just the five/six raw output frames; excess logs/frames still fail closed.
  const maxProcessedFrames = indices.at(-1) + 1 + PIXEL_CAPTURE_POLICY.lookaheadFrames
  const rawBudgetBytes = frameSize * indices.length
  const logBudgetBytes = PIXEL_CAPTURE_POLICY.logHeaderBytes +
    PIXEL_CAPTURE_POLICY.logBytesPerProcessedFrame * maxProcessedFrames
  const combinedBudgetBytes = rawBudgetBytes + logBudgetBytes
  assert.ok(combinedBudgetBytes <= PIXEL_CAPTURE_POLICY.maxCombinedBytes, 'Combined capture exceeds global per-execution cap')
  return { ...PIXEL_CAPTURE_POLICY, maxProcessedFrames, rawBudgetBytes, logBudgetBytes, combinedBudgetBytes }
}

/** The exact filter the renderer places immediately before libass (buildPreLibassClockStage). */
function preLibassClockFilter(fps) {
  const [stage] = buildPreLibassClockStage({ inputLabel: 'in', outputFps: fps }).filters
  return stage.replace(/^\[in\]/, '').replace(/\[clocked\]$/, '')
}
function assertClosedStageClock(clock, fps) {
  assert.ok(clock.timeBases.length > 0 && clock.timeBases.every((tb) => tb.numerator === '1' && tb.denominator === String(fps)),
    'The observed pre-libass time base must be the inverse of the rate')
  assert.ok(clock.frames.length > 0 && clock.frames.every((frame) => frame.pts === String(frame.frame)),
    'The observed pre-libass PTS must number the frames consecutively from 0')
}
/** libass now of each observed frame, by the pinned conversion applied to the observed PTS and time base. */
function observedNowMs(clock) {
  const [timeBase] = clock.timeBases
  return new Map(clock.frames.map((frame) => [frame.frame, Number(derivePinnedLibassNowMs(frame.pts, timeBase))]))
}
const litFrames = (nowByFrame, indices, startCs, endCs) =>
  indices.filter((frame) => startCs * 10 <= nowByFrame.get(frame) && nowByFrame.get(frame) < endCs * 10)
const centiseconds = (timestamp) => {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(timestamp)
  return Number(match[1]) * 360000 + Number(match[2]) * 6000 + Number(match[3]) * 100 + Number(match[4])
}

function renderPixels(binary, root, fps, file, { indices = [0, 1, 2, 3, 4, 5], prefix = '', capture, timeoutMs = PROCESS_BUDGET_MS, absoluteDeadline, budgetError } = {}) {
  // Select AFTER libass, retaining the real incoming PTS even for late-frame
  // boundaries. A narrow raw window bounds memory without rebasing that clock.
  // showinfo passes input frames through unchanged and reports their real PTS:
  // https://ffmpeg.org/ffmpeg-filters.html#showinfo
  const bufferBudget = pixelCaptureBudget(indices)
  const filters = [prefix, preLibassClockFilter(fps), 'showinfo', file ? `subtitles=filename='${file}':fontsdir='fonts'` : '',
    `select=between(n\\,${indices[0]}\\,${indices.at(-1)})`].filter(Boolean).join(',')
  const args = [
    '-hide_banner', '-loglevel', 'verbose', '-threads', '1', '-filter_threads', '1',
    '-f', 'lavfi', '-i', `color=c=0x202020:s=${WIDTH}x${HEIGHT}:r=${fps}`,
    '-vf', filters,
    '-frames:v', String(indices.length), '-vsync', '0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ]
  if (absoluteDeadline !== undefined) {
    // Final monotonic gate immediately before spawning, after args construction.
    const remaining = Math.floor(absoluteDeadline - performance.now())
    if (remaining <= 0) throw budgetError()
    timeoutMs = Math.min(timeoutMs, PROCESS_BUDGET_MS, remaining)
  }
  const execution = spawnSync(binary, args,
    { cwd: root, windowsHide: true, timeout: timeoutMs, maxBuffer: bufferBudget.combinedBudgetBytes })
  // Record the process result before any process, byte-count or pixel assert.
  capture({ execution, args, fps, file, indices, prefix, filters, timeoutMs, bufferBudget })
  assert.ifError(execution.error)
  assert.equal(execution.status, 0, execution.stderr?.toString('utf8'))
  assert.equal(execution.stdout.length, bufferBudget.rawBudgetBytes, 'Raw output must exactly match the declared RGB window')
  assert.ok(execution.stderr.length <= bufferBudget.logBudgetBytes, 'FFmpeg logs exceed the declared processing-frame budget')
  assert.ok(execution.stdout.length + execution.stderr.length <= bufferBudget.combinedBudgetBytes,
    'FFmpeg output exceeds the combined raw/log budget')
  const log = execution.stderr.toString('utf8')
  const observedClock = observedPreLibassClock(log, indices)
  assertClosedStageClock(observedClock, fps)
  const clockFrames = observedClock.frames
  assert.ok(clockFrames.length <= bufferBudget.maxProcessedFrames &&
    clockFrames.every((frame) => frame.frame < bufferBudget.maxProcessedFrames),
  'Observed showinfo frames exceed the declared processing bound')
  return { raw: execution.stdout, log }
}

function changedFrames(actual, baseline, indices = [0, 1, 2, 3, 4, 5]) {
  assert.equal(actual.length, frameSize * indices.length)
  assert.equal(baseline.length, actual.length)
  return Array.from({ length: indices.length }, (_unused, frame) => frame).filter((frame) =>
    !actual.subarray(frame * frameSize, (frame + 1) * frameSize)
      .equals(baseline.subarray(frame * frameSize, (frame + 1) * frameSize))).map((frame) => indices[frame])
}

test('W69 pinned FFmpeg pixels prove exact subtitle and CTA frame coverage at 30/60/100/120 fps', { timeout: ABSOLUTE_BUDGET_MS + 30000 }, async (t) => {
  const deadline = performance.now() + ABSOLUTE_BUDGET_MS
  const evidenceRoot = process.env.APOLLO_ASS_EVIDENCE_ROOT
  let binary = process.env.FFMPEG_BIN
  const pinned = process.env.APOLLO_ASS_FFMPEG_SHA256
  const fontPath = process.env.APOLLO_ASS_FONT_PATH
  const fontSha256 = process.env.APOLLO_ASS_FONT_SHA256
  const fontFamily = process.env.APOLLO_ASS_FONT_FAMILY
  const fontFace = process.env.APOLLO_ASS_FONT_POSTSCRIPT_NAME
  const proof = { schemaVersion: 'ass-clock-pixels-proof/v4', platform: process.platform,
    scope: 'controlled ASS timing pixels; no activation or facial/editorial acceptance claim',
    ffmpeg: { path: binary, approvedSha256: pinned },
    font: { path: fontPath, approvedSha256: fontSha256, family: fontFamily, face: fontFace },
    source: { generator: `lavfi color=c=0x202020:s=${WIDTH}x${HEIGHT}`, frameCount: FRAMES, pixelFormat: 'rgb24' },
    configuration: { threads: 1, filterThreads: 1, vsync: 0, filter: 'subtitles=filename=<fixture>:fontsdir=fonts',
      preLibassClockStage: 'settb=1/<rate>,setpts=N immediately before showinfo and subtitles, as buildPreLibassClockStage places it in the renderer',
      diagnosticFilter: 'showinfo immediately before subtitles; same clock graph and coverage expectations',
      executionBudget: { absoluteMs: ABSOLUTE_BUDGET_MS, perProcessMs: PROCESS_BUDGET_MS, scope: 'version query plus all original and additional pixel executions' } },
    emissionPolicy: ASS_EMISSION_POLICY, pixelCapturePolicy: PIXEL_CAPTURE_POLICY,
    originalFailureBehavior: 'stop on first original failure; remaining original cases are not-executed',
    differentialProtocol: { schemaVersion: 'ass-clock-boundary-differential/v1', targets: DIFFERENTIAL_TARGETS,
      graphs: ['lavfi', 'trim-setpts-fps-concat'], layers: [0, 1], budgetMs: ABSOLUTE_BUDGET_MS,
      scope: 'pixel bracketing only; no direct observation of libass integer now' },
    cases: originalCaseSchedule(), diagnostics: [], discriminations: [], secondaryErrors: [],
    executions: [], outcome: { status: 'running' },
  }
  const artifacts = new Map()
  const assFiles = new Map()
  let root
  let primaryError
  let activeCase = null
  let activeDiagnostic = null
  let nextOriginalCase = 0
  let diagnosticSetupReady = false
  const writeAss = async (file, ass) => {
    assFiles.set(file, ass)
    await writeFile(join(root, file), ass)
  }
  const pixels = (selectedBinary, selectedRoot, fps, file, options = {}) => renderPixels(
    selectedBinary, selectedRoot, fps, file, { ...options, absoluteDeadline: deadline, budgetError: clockBudgetError, capture(record) {
      const id = String(proof.executions.length + 1).padStart(3, '0')
      const stem = `execution-${id}`
      const logBytes = record.execution.stderr ?? Buffer.alloc(0)
      const log = logBytes.toString('utf8')
      const raw = record.execution.stdout ?? Buffer.alloc(0)
      const ass = file ? assFiles.get(file) : undefined
      const config = { schemaVersion: 'ass-clock-execution/v3', caseIndex: activeCase, diagnosticIndex: activeDiagnostic,
        fps, source: `color=c=0x202020:s=${WIDTH}x${HEIGHT}:r=${fps}`,
        observedFrameIndices: record.indices, inputFilterGraph: record.prefix, effectiveFilterGraph: record.filters,
        args: record.args, file: file ?? null, timeoutMs: record.timeoutMs,
        maxBufferBytes: record.bufferBudget.combinedBudgetBytes, bufferBudget: record.bufferBudget,
        status: record.execution.status, signal: record.execution.signal,
        error: record.execution.error ? errorEvidence(record.execution.error) : null,
        rawBytes: raw.length, rawSha256: sha256(raw), logBytes: logBytes.length, logSha256: sha256(logBytes),
        combinedCapturedBytes: raw.length + logBytes.length,
        rawLayout: { width: WIDTH, height: HEIGHT, pixelFormat: 'rgb24', bytesPerFrame: frameSize,
          frameIndicesInByteOrder: record.indices },
        assSha256: ass === undefined ? null : sha256(ass),
        observedPreLibassClock: observedPreLibassClock(log, record.indices),
        effectiveLibassAndFontConfiguration: log.split('\n').filter((line) => /libass|fontselect:|font provider|Loading font/.test(line)),
        artifacts: { config: `${stem}.json`, log: `${stem}.log`, raw: `${stem}.rgb24`,
          ass: ass === undefined ? null : `${stem}.ass` },
      }
      // Every invocation, including baseline and failed FFmpeg, remains visible.
      artifacts.set(config.artifacts.log, logBytes)
      artifacts.set(config.artifacts.raw, raw)
      if (ass !== undefined) artifacts.set(config.artifacts.ass, ass)
      artifacts.set(config.artifacts.config, JSON.stringify(config, null, 2) + '\n')
      proof.executions.push(config)
    } })
  const beginCase = (metadata) => {
    activeCase = nextOriginalCase++
    assert.ok(activeCase < proof.cases.length, 'original case schedule must remain complete')
    Object.assign(proof.cases[activeCase], metadata, { status: 'pending' })
    return proof.cases[activeCase]
  }

  const clockBudgetError = () => {
    const error = new Error('The absolute ASS clock deadline is exhausted')
    error.code = 'ASS_CLOCK_BUDGET_EXHAUSTED'
    return error
  }
  const remainingTimeout = () => {
    const remaining = Math.floor(deadline - performance.now())
    if (remaining <= 0) throw clockBudgetError()
    return Math.min(PROCESS_BUDGET_MS, remaining)
  }
  const captureFfmpegVersion = () => {
    const record = { schemaVersion: 'ass-clock-version-execution/v1', args: ['-version'],
      invoked: false, timeoutMs: null, maxBufferBytes: 1024 * 1024, status: null, signal: null, error: null }
    let stdout = null, stderr = null
    try {
      const options = { windowsHide: true, maxBuffer: record.maxBufferBytes, stdio: ['ignore', 'pipe', 'pipe'] }
      record.timeoutMs = remainingTimeout() // Same absolute budget, at most 30s.
      options.timeout = record.timeoutMs
      record.invoked = true
      stdout = execFileSync(binary, record.args, options)
      record.status = 0
      return stdout.toString('utf8')
    } catch (error) {
      record.status = typeof error?.status === 'number' ? error.status : null
      record.signal = error?.signal ?? null
      record.error = errorEvidence(error)
      stdout = Buffer.isBuffer(error?.stdout) ? error.stdout : null
      stderr = Buffer.isBuffer(error?.stderr) ? error.stderr : null
      throw error
    } finally {
      // Preserve status/error and available bytes before any following process.
      record.stdoutBytes = stdout?.length ?? null
      record.stdoutSha256 = stdout === null ? null : sha256(stdout)
      record.stderrBytes = stderr?.length ?? null
      record.stderrSha256 = stderr === null ? null : sha256(stderr)
      record.stderrCapture = 'execFileSync exposes stderr only on failure'
      if (stdout !== null) artifacts.set('ffmpeg-version.stdout.log', stdout)
      if (stderr !== null) artifacts.set('ffmpeg-version.stderr.log', stderr)
      artifacts.set('ffmpeg-version-execution.json', JSON.stringify(record, null, 2) + '\n')
      proof.ffmpeg.versionExecution = record
    }
  }
  const preserveDiagnosticError = (error, diagnosticIndex) => {
    const evidence = errorEvidence(error)
    if (primaryError) proof.secondaryErrors.push({ scope: 'additional-diagnostic', diagnosticIndex, error: evidence })
    else {
      primaryError = error
      proof.outcome = { status: 'failed', scope: 'additional-diagnostic', error: evidence, diagnosticIndex }
    }
  }
  const runDiagnostic = async (metadata, action) => {
    const observed = { ...metadata, status: 'pending' }
    proof.diagnostics.push(observed)
    activeDiagnostic = proof.diagnostics.length - 1
    try {
      remainingTimeout() // No writes or new process after the absolute deadline.
      const value = await action(observed)
      observed.status = metadata.role === 'differential-control' ? 'observed' : 'passed'
      return { observed, value }
    } catch (error) {
      observed.error = errorEvidence(error)
      observed.status = error?.code === 'ASS_CLOCK_BUDGET_EXHAUSTED' ? 'not-executed' : 'failed'
      if (observed.status === 'not-executed') observed.reason = 'absolute-diagnostic-budget-exhausted'
      preserveDiagnosticError(error, activeDiagnostic)
      return { observed, value: null }
    }
  }
  /** Physical completeness proof for a refused boundary. Every centisecond pair around the boundary is
   * rendered; none may light exactly the requested frame, and each result must equal the model prediction
   * made from the PTS observed before libass. */
  const exhaustRefusedBoundary = async ({ fps, start, clock, indices, prefix, baseline }) => {
    const nowByFrame = observedNowMs(observedPreLibassClock(baseline.log, indices))
    const centre = Math.floor(nowByFrame.get(start) / 10)
    const results = []
    for (let startCs = centre - 2; startCs <= centre + 2; startCs += 1) {
      for (let endCs = startCs + 1; endCs <= startCs + 4; endCs += 1) {
        const interval = [assCentisecondTimestamp(BigInt(startCs)), assCentisecondTimestamp(BigInt(endCs))]
        const ass = differentialAss(1, fps, start, fontFamily, interval)
        await writeAss('exhaustion.ass', ass)
        const rendered = pixels(binary, root, fps, 'exhaustion.ass', { indices, prefix, timeoutMs: remainingTimeout() })
        const actual = changedFrames(rendered.raw, baseline.raw, indices)
        const predicted = litFrames(nowByFrame, indices, startCs, endCs)
        results.push({ startCs, endCs, actual, predicted, renderedRawSha256: sha256(rendered.raw) })
        assert.deepEqual(actual, predicted, `${fps} fps ${clock} [${startCs},${endCs}) cs: pixels differ from the model prediction`)
        assert.notDeepEqual(actual, [start], `${fps} fps ${clock} [${startCs},${endCs}) cs lights exactly frame ${start}: the refusal was wrong`)
      }
    }
    return { centreCs: centre, observedNowMs: Object.fromEntries(indices.map((frame) => [frame, nowByFrame.get(frame)])), pairs: results.length, results }
  }
  const additionalDiagnostics = async () => {
    activeCase = null
    for (const target of DIFFERENTIAL_TARGETS) {
      const { fps, target: start } = target
      const indices = [start - 2, start - 1, start, start + 1, start + 2]
      for (const clock of ['lavfi', 'trim-setpts-fps-concat']) {
        const prefix = boundaryClockPrefix(fps, start, clock)
        const common = { fps, targetFrame: start, clock, observedFrameIndices: indices, effectiveFilterGraph: prefix }
        const baseline = await runDiagnostic({ ...common, role: 'differential-baseline' }, async (observed) => {
          const output = pixels(binary, root, fps, undefined, { indices, prefix, timeoutMs: remainingTimeout(),
            absoluteDeadline: deadline, budgetError: clockBudgetError })
          assert.equal(output.raw.length, frameSize * indices.length)
          observed.rawSha256 = sha256(output.raw)
          return output
        })
        for (const layer of [0, 1]) {
          const controls = []
          for (const [side, interval] of [['before', target.before], ['after', target.after], ['original', null]]) {
            const metadata = { ...common, layer, role: side === 'original' ? 'diagnostic-original-boundary' : 'differential-control',
              side, assInterval: interval, expectedChangedFrames: side === 'original' ? [start] : null }
            if (baseline.value === null) {
              proof.diagnostics.push({ ...metadata, status: 'not-executed', reason: 'diagnostic-baseline-unavailable' })
              continue
            }
            const result = await runDiagnostic(metadata, async (observed) => {
              let ass
              try {
                ass = interval === null ? document(layer, fps, start, start + 1, fontFamily) :
                  differentialAss(layer, fps, start, fontFamily, interval)
              } catch (error) {
                if (!(interval === null && isAssBoundaryUnrepresentable(error))) throw error
                observed.binding = 'refused' // the original boundary is not representable: no original ASS exists
                observed.refusal = { reason: error.details.reason, refusal: error.refusal, frame: error.details.frame }
                return null
              }
              observed.assSha256 = sha256(ass)
              await writeAss('differential.ass', ass)
              // Check the monotonic balance again after asynchronous file I/O.
              const rendered = pixels(binary, root, fps, 'differential.ass', { indices, prefix, timeoutMs: remainingTimeout(),
                absoluteDeadline: deadline, budgetError: clockBudgetError })
              observed.baselineRawSha256 = sha256(baseline.value.raw)
              observed.renderedRawSha256 = sha256(rendered.raw)
              observed.effectiveLibassAndFontConfiguration = rendered.log.split('\n').filter((line) => /libass|fontselect:|font provider|Loading font/.test(line))
              const actual = changedFrames(rendered.raw, baseline.value.raw, indices)
              observed.changedFrames = actual // Retain coverage before any assertion.
              // The model, applied to the PTS observed before libass, must predict the pixels of every control.
              const clockNow = observedNowMs(observedPreLibassClock(rendered.log, indices))
              const [modelStart, modelEnd] = interval === null ? [null, null] : interval.map(centiseconds)
              if (interval !== null) {
                observed.predictedChangedFrames = litFrames(clockNow, indices, modelStart, modelEnd)
                assert.deepEqual(actual, observed.predictedChangedFrames,
                  `differential ${fps} fps ${clock} layer ${layer} ${side}: pixels differ from the model prediction`)
              }
              const pinnedFaceReported = rendered.log.split('\n').some((line) => line.includes('fontselect:') && line.includes(fontFace))
              observed.fontSelection = pinnedFaceReported ? 'pinned-face-reported' : actual.length === 0 ? 'no-rendered-text-frame' : 'unverified'
              // A control with no event on any decoded frame need not select a
              // font. Every changed-pixel control must report the pinned face.
              assert.ok(actual.length === 0 || pinnedFaceReported,
                'changed differential pixels must use the independently pinned font face')
              if (side === 'original') assert.deepEqual(actual, [start],
                `diagnostic-original-boundary ${fps} fps ${clock} layer ${layer} boundary ${start} must match original expected pixels`)
              return actual
            })
            if (side !== 'original') controls.push(result.observed)
          }
          const before = controls.find((item) => item.side === 'before'), after = controls.find((item) => item.side === 'after')
          proof.discriminations.push({ ...common, layer,
            scope: 'observed target-frame pixels under before/after ASS intervals; not libass integer now',
            beforeChangedFrames: before?.changedFrames ?? null, afterChangedFrames: after?.changedFrames ?? null,
            beforeLightsTarget: before?.status === 'observed' ? before.changedFrames.includes(start) : null,
            afterLightsTarget: after?.status === 'observed' ? after.changedFrames.includes(start) : null })
        }
      }
    }
    activeDiagnostic = null
    proof.diagnosticOutcome = { status: 'collection-finished', elapsedMs: Math.ceil(performance.now() - (deadline - ABSOLUTE_BUDGET_MS)),
      observed: proof.diagnostics.filter((item) => item.status === 'observed').length,
      passed: proof.diagnostics.filter((item) => item.status === 'passed').length,
      failed: proof.diagnostics.filter((item) => item.status === 'failed').length,
      notExecuted: proof.diagnostics.filter((item) => item.status === 'not-executed').length }
  }
  try {
    assert.ok(evidenceRoot && isAbsolute(evidenceRoot), 'owner must supply absolute private APOLLO_ASS_EVIDENCE_ROOT')
    binary ??= require('ffmpeg-static')
    proof.ffmpeg.path = binary
    proof.testSourceSha256 = sha256(await readFile(new URL(import.meta.url)))
    proof.rendererSourceSha256 = sha256(await readFile(new URL('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts', import.meta.url)))
    proof.emissionPolicySourceSha256 = sha256(await readFile(new URL('../../src/v2/domain/ass-emission-policy.ts', import.meta.url)))
    proof.clockModelSourceSha256 = sha256(await readFile(new URL('../../src/v2/domain/libass-clock-model.ts', import.meta.url)))
    proof.compositionGraphSourceSha256 = sha256(await readFile(new URL('../../src/v2/infrastructure/media/ffmpeg-editorial-composition-graph.ts', import.meta.url)))
    assert.match(pinned ?? '', /^[a-f0-9]{64}$/, 'owner must supply independently approved APOLLO_ASS_FFMPEG_SHA256')
    proof.ffmpeg.sha256 = sha256(await readFile(binary))
    assert.equal(proof.ffmpeg.sha256, pinned)
    assert.ok(fontPath && fontFamily && fontFace && !/[,\r\n]/.test(fontFamily), 'owner must supply explicit font file, family and face')
    assert.match(fontSha256 ?? '', /^[a-f0-9]{64}$/)
    proof.font.sha256 = sha256(await readFile(fontPath))
    assert.equal(proof.font.sha256, fontSha256)
    proof.ffmpeg.versionAndConfiguration = captureFfmpegVersion()
    root = await mkdtemp(join(tmpdir(), 'apollo-ass-clock-pixels-'))
    await mkdir(join(root, 'fonts'))
    await copyFile(fontPath, join(root, 'fonts', 'pinned-font.ttf'))
    proof.font.materializedSha256 = sha256(await readFile(join(root, 'fonts', 'pinned-font.ttf')))
    assert.equal(proof.font.materializedSha256, fontSha256)
    diagnosticSetupReady = true
    for (const [fps, start, end, expected] of [[30, 1, 2, [1]], [60, 1, 2, [1]], [100, 1, 2, [1]], [120, 2, 3, [2]]]) {
      activeCase = null
      const baseline = pixels(binary, root, fps)
      for (const layer of [0, 1]) {
        const observed = beginCase({ fps, layer, interval: [start, end], expectedChangedFrames: expected })
        const ass = document(layer, fps, start, end, fontFamily)
        observed.assSha256 = sha256(ass)
        await writeAss('clock.ass', ass)
        const rendered = pixels(binary, root, fps, 'clock.ass')
        observed.baselineRawSha256 = sha256(baseline.raw)
        observed.renderedRawSha256 = sha256(rendered.raw)
        observed.effectiveLibassAndFontConfiguration = rendered.log.split('\n').filter((line) => /libass|fontselect:|font provider|Loading font/.test(line))
        const selectedFonts = rendered.log.split('\n').filter((line) => line.includes('fontselect:'))
        assert.ok(selectedFonts.some((line) => line.includes(fontFace)), 'libass must report the pinned font face')
        const actual = changedFrames(rendered.raw, baseline.raw)
        observed.changedFrames = actual
        assert.deepEqual(actual, expected,
          `${fps} fps layer ${layer} must light only the intended frame, including frames 0/1/2`)
        observed.status = 'passed'
      }
      const emptyObserved = beginCase({ fps, layer: 'empty', expectedChangedFrames: [] })
      const empty = buildAssSubtitles({ width: WIDTH, height: HEIGHT, fps, durationFrames: FRAMES, cues: [], ctaOverlays: [] })
      emptyObserved.assSha256 = sha256(empty)
      await writeAss('empty.ass', empty)
      const emptyChanges = changedFrames(pixels(binary, root, fps, 'empty.ass').raw, baseline.raw)
      emptyObserved.changedFrames = emptyChanges
      assert.deepEqual(emptyChanges, [])
      emptyObserved.status = 'passed'
      const suppressedObserved = beginCase({ fps, layer: 'suppressed', interval: [1, 2], expectedChangedFrames: [] })
      const suppressed = buildAssSubtitles({ width: WIDTH, height: HEIGHT, fps, durationFrames: FRAMES,
        cues: [{ id: 'suppressed', startFrame: 1, endFrame: 2, text: 'CLOCK' }],
        anchorPlan: { schemaVersion: 'subtitle-anchor-plan/v2', decisions: [{ cueId: 'suppressed', suppressed: true }] },
      })
      suppressedObserved.assSha256 = sha256(suppressed)
      await writeAss('suppressed.ass', suppressed)
      const suppressedChanges = changedFrames(pixels(binary, root, fps, 'suppressed.ass').raw, baseline.raw)
      suppressedObserved.changedFrames = suppressedChanges
      assert.deepEqual(suppressedChanges, [])
      suppressedObserved.status = 'passed'
    }
    // These exact-centisecond and later-frame boundaries are deliberate gates:
    // IEEE double conversion in vf_subtitles may disagree with rational ceil.
    // A failure here blocks policy activation; it must never be rounded away.
    for (const [fps, start] of BOUNDARY_TARGETS) {
      const indices = [start - 2, start - 1, start, start + 1, start + 2]
      for (const clock of ['lavfi', 'trim-setpts-fps-concat']) {
        const prefix = boundaryClockPrefix(fps, start, clock)
        const options = { indices, prefix }
        activeCase = null
        const baseline = pixels(binary, root, fps, undefined, options)
        for (const layer of [0, 1]) {
          const expectedBinding = REFUSED_TARGETS.has(`${fps}:${start}`) ? 'refused' : 'bound'
          const observed = beginCase({ fps, layer, clock, interval: [start, start + 1], observedFrameIndices: indices,
            expectedBinding, expectedChangedFrames: expectedBinding === 'bound' ? [start] : null, effectiveFilterGraph: prefix })
          let ass
          try {
            ass = document(layer, fps, start, start + 1, fontFamily)
            observed.binding = 'bound'
          } catch (error) {
            assert.ok(isAssBoundaryUnrepresentable(error), `unexpected binder failure: ${error?.message}`)
            observed.binding = 'refused'
            observed.refusal = { reason: error.details.reason, refusal: error.refusal, frame: error.details.frame,
              previousMs: error.details.previousMs, currentMs: error.details.currentMs }
          }
          t.diagnostic(JSON.stringify({ fps, start, clock, layer, binding: observed.binding, refusal: observed.refusal ?? null }))
          assert.equal(observed.binding, expectedBinding, `${fps} fps boundary ${start}: the pure binder and the declared pixel schedule disagree`)
          if (observed.binding === 'refused') {
            // Prove the refusal physically: no centisecond pair near the boundary may light exactly [start].
            if (layer === 1) observed.exhaustion = await exhaustRefusedBoundary({ fps, start, clock, indices, prefix, baseline })
            observed.status = 'passed'
            continue
          }
          observed.assSha256 = sha256(ass)
          await writeAss('boundary.ass', ass)
          const rendered = pixels(binary, root, fps, 'boundary.ass', options)
          observed.baselineRawSha256 = sha256(baseline.raw)
          observed.renderedRawSha256 = sha256(rendered.raw)
          observed.effectiveLibassAndFontConfiguration = rendered.log.split('\n').filter((line) => /libass|fontselect:|font provider|Loading font/.test(line))
          const actual = changedFrames(rendered.raw, baseline.raw, indices)
          observed.changedFrames = actual
          t.diagnostic(JSON.stringify(observed))
          assert.deepEqual(actual, [start], `${fps} fps ${clock} layer ${layer} boundary ${start} must match actual libass pixels`)
          observed.status = 'passed'
        }
      }
    }
    // Adjacent events are compared with independently rendered solo cues, so
    // union coverage cannot hide the previous event bleeding into the next.
    for (const layer of [0, 1]) {
      const observed = beginCase({ fps: 30, layer, clock: 'adjacent-cues', intervals: [[1, 2], [2, 3]],
        expectedFrames: { first: [1], next: [2], baseline: [0, 3, 4, 5] }, comparedFrames: [] })
      const first = document(layer, 30, 1, 2, fontFamily)
      const next = document(layer, 30, 2, 3, fontFamily).replaceAll('CLOCK', 'NEXT')
      const together = first + next.split('\n').filter((line) => line.startsWith('Dialogue:')).join('\n') + '\n'
      const outputs = []
      for (const [name, ass] of [['first', first], ['next', next], ['adjacent', together]]) {
        await writeAss(`${name}.ass`, ass)
        outputs.push(pixels(binary, root, 30, `${name}.ass`).raw)
      }
      const baseline = pixels(binary, root, 30).raw
      observed.assSha256 = sha256(together)
      observed.renderedRawSha256 = sha256(outputs[2])
      for (let frame = 0; frame < FRAMES; frame += 1) {
        const expected = frame === 1 ? outputs[0] : frame === 2 ? outputs[1] : baseline
        const equal = outputs[2].subarray(frame * frameSize, (frame + 1) * frameSize)
          .equals(expected.subarray(frame * frameSize, (frame + 1) * frameSize))
        observed.comparedFrames.push({ frame, equal })
        assert.ok(equal, `adjacent layer ${layer} frame ${frame}`)
      }
      observed.status = 'passed'
    }
    // The same slicer the adapter invokes clips the CTA and rebases its clock.
    const fragmentObserved = beginCase({ fps: 30, layer: 1, clock: 'clipped-rebased-fragment', globalInterval: [3, 8],
      renderRange: [5, 9], expectedLocalIntervals: [[0, 3]], expectedChangedFrames: [0, 1, 2] })
    const fragment = sliceRenderRange({ clips: [{ id: 'fragment-clip', sourceArtifactId: 'fragment-source',
      sourceInFrame: 0, sourceOutFrame: 9, timelineInFrame: 0, timelineOutFrame: 9, rate: 1 }],
      ctaOverlays: [{ id: 'fragment-cta', startFrame: 3, endFrame: 8, text: 'CLOCK' }] },
    { startFrame: 5, endFrame: 9 })
    fragmentObserved.materializedRange = fragment
    fragmentObserved.localIntervals = fragment.ctaOverlays.map((cue) => [cue.startFrame, cue.endFrame])
    assert.deepEqual(fragment.ctaOverlays.map((cue) => [cue.startFrame, cue.endFrame]), [[0, 3]])
    const fragmentAss = buildAssSubtitles({ width: WIDTH, height: HEIGHT, fps: 30, durationFrames: 4,
      cues: [], ctaOverlays: fragment.ctaOverlays }).replaceAll(',Arial,', `,${fontFamily},`)
    fragmentObserved.assSha256 = sha256(fragmentAss)
    await writeAss('fragment.ass', fragmentAss)
    const prefix = 'trim=start_frame=5:end_frame=9,setpts=PTS-STARTPTS,fps=30'
    fragmentObserved.effectiveFilterGraph = prefix
    const indices = [0, 1, 2, 3]
    const fragmentBaseline = pixels(binary, root, 30, undefined, { prefix, indices })
    const fragmentPixels = pixels(binary, root, 30, 'fragment.ass', { prefix, indices })
    fragmentObserved.renderedRawSha256 = sha256(fragmentPixels.raw)
    fragmentObserved.changedFrames = changedFrames(fragmentPixels.raw, fragmentBaseline.raw, indices)
    assert.deepEqual(fragmentObserved.changedFrames, [0, 1, 2])
    fragmentObserved.status = 'passed'
    // Independent regression control: the old .07 end lights frame 2 too.
    const roundedObserved = beginCase({ fps: 30, layer: 1, clock: 'rounded-end-regression-control',
      interval: [1, 2], alteredAssEnd: '0:00:00.07', expectedChangedFrames: [1, 2] })
    const rounded = document(1, 30, 1, 2, fontFamily).replace('0:00:00.06', '0:00:00.07')
    roundedObserved.assSha256 = sha256(rounded)
    await writeAss('rounded.ass', rounded)
    roundedObserved.changedFrames = changedFrames(pixels(binary, root, 30, 'rounded.ass').raw, pixels(binary, root, 30).raw)
    assert.deepEqual(roundedObserved.changedFrames, [1, 2])
    roundedObserved.status = 'passed'
    for (const layer of [0, 1]) {
      const rejected = beginCase({ fps: 120, layer, interval: [1, 2], expectedRejection: 'ASS_BOUNDARY_UNREPRESENTABLE' })
      assert.throws(() => document(layer, 120, 1, 2, fontFamily), (error) => isAssBoundaryUnrepresentable(error) && error.details.frame === 1)
      rejected.status = 'passed'
    }
    proof.outcome = { status: 'passed' }
  } catch (error) {
    primaryError = error
    proof.outcome = { status: 'failed', error: errorEvidence(error), caseIndex: activeCase }
    if (activeCase !== null) proof.cases[activeCase].status = 'failed'
  } finally {
    // Additional predeclared diagnostics run even after the first original FAIL.
    // Their errors never replace that primary error or turn its outcome green.
    try {
      if (diagnosticSetupReady) await additionalDiagnostics()
      else proof.diagnosticOutcome = { status: 'not-executed', reason: 'pins-and-setup-not-verified' }
    } catch (error) {
      preserveDiagnosticError(error, activeDiagnostic)
    }
    // Archive captured bytes before removing scratch. The terminal postflight
    // envelope records cleanup separately without rewriting the primary proof.
    let evidenceDirectory
    let manifestSha256
    try {
      assert.ok(evidenceRoot && isAbsolute(evidenceRoot), 'absolute private evidence root is required')
      await mkdir(evidenceRoot, { recursive: true })
      evidenceDirectory = await mkdtemp(join(evidenceRoot, 'ass-clock-pixels-'))
      artifacts.set('proof.json', JSON.stringify(proof, null, 2) + '\n')
      const files = []
      for (const [path, bytes] of artifacts) {
        // Exclusive writes never replace artifacts from an earlier run.
        await writeFile(join(evidenceDirectory, path), bytes, { flag: 'wx' })
        files.push({ path, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes, 'utf8') })
      }
      const manifest = { schemaVersion: 'ass-clock-pixels-evidence-manifest/v1',
        proofSchemaVersion: proof.schemaVersion, outcomeScope: 'pixel-assertions-before-scratch-cleanup',
        outcome: proof.outcome, files }
      const manifestBytes = JSON.stringify(manifest, null, 2) + '\n'
      await writeFile(join(evidenceDirectory, 'manifest.json'), manifestBytes, { flag: 'wx' })
      manifestSha256 = sha256(manifestBytes)
    } catch (error) {
      t.diagnostic(JSON.stringify({ evidenceCaptureError: errorEvidence(error), outcome: proof.outcome }))
      primaryError ??= error
    } finally {
      try {
        if (root) await rm(root, { recursive: true, force: true })
        proof.cleanup = { status: 'completed' }
      } catch (error) {
        proof.cleanup = { status: 'failed', error: errorEvidence(error) }
        primaryError ??= error
      }
    }
    const terminal = { schemaVersion: 'ass-clock-pixels-postflight/v1', manifestSha256: manifestSha256 ?? null,
      pixelOutcome: proof.outcome, cleanup: proof.cleanup,
      outcome: primaryError ? { status: 'failed', error: errorEvidence(primaryError) } : { status: 'passed' } }
    try {
      if (evidenceDirectory) {
        const bytes = JSON.stringify(terminal, null, 2) + '\n'
        await writeFile(join(evidenceDirectory, 'postflight.json'), bytes, { flag: 'wx' })
        t.diagnostic(JSON.stringify({ evidenceDirectory, manifestSha256, postflightSha256: sha256(bytes), terminal }))
      }
    } catch (error) {
      t.diagnostic(JSON.stringify({ postflightCaptureError: errorEvidence(error), terminal }))
      primaryError ??= error
    }
    t.diagnostic(JSON.stringify(proof))
  }
  if (primaryError) throw primaryError
})
