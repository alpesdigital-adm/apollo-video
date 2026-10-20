import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { artifactPath, issueApiClient } from './helpers/capture-journey.mjs'
import { apiClient, startServer } from './helpers/issue-override-runtime.mjs'
import { bandRows } from './helpers/issue-override-proof.mjs'
import { CUES, OVERFLOW_CAPTION, runProxyWorkerOnce, seedIssueOverrideWorld } from './helpers/issue-override-world.mjs'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

/**
 * W69 tail proof (supervised harness; also a CI step). ONE project with TWO outputs (9:16 and 16:9) over one real recording, the real
 * `next start` server, PostgreSQL, the production proxy-render worker, real FFmpeg and real storage.
 *
 * For each output the sidecar (SRT and VTT) is exported through the public API, downloaded through the artifact content route and read back
 * by readers that are NOT the product writer: a small independent parser, and FFmpeg's own SRT/WebVTT demuxers (ffprobe packets). The cue
 * boundaries are then compared with the DECODED FRAMES of the delivered MP4 (the first and last frame with caption pixels of each cue).
 * Then a subtitle exception changes what the MP4 draws (a new text, a hidden cue, a text too long for the band): the sidecar of that output
 * follows the burned pixels exactly, the other output's sidecar does not move, a stale or blocked render is refused with its reason, and
 * the API is exercised for authorization, hash, download, replay and mismatch.
 */
const enabled = process.env.APOLLO_SUBTITLE_SIDECAR_OVERRIDE_E2E === '1'
const FPS = 30
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const evidence = { steps: [] }
const note = (label, value = {}) => { evidence.steps.push({ label, at: new Date().toISOString(), ...value }); console.log(`W69T-EVIDENCE ${JSON.stringify({ label, ...value })}`) }
const serialize = (value) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function waitFor(label, probe, { timeoutMs = 240_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try { last = await probe(); if (last) return last } catch (error) { last = error }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : serialize(last)}`)
    await delay(intervalMs)
  }
}

/** An independent reader of SRT and VTT. It shares no code with the product writer or the product parser. */
function readSidecar(bytes, format) {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${format}: UTF-8 byte order mark`)
  const text = bytes.subarray(3).toString('utf8')
  assert.equal(text, text.normalize('NFC'), `${format}: the whole file is NFC`)
  assert.ok(!text.includes('�'), `${format}: no replacement character`)
  if (format === 'srt') assert.ok(!/[^\r]\n/.test(text), 'srt: every line ends in CRLF')
  else assert.ok(!text.includes('\r'), 'vtt: LF only')
  const eol = format === 'srt' ? '\r\n' : '\n'
  const stamp = format === 'srt' ? /^(\d\d):(\d\d):(\d\d),(\d{3})$/ : /^(\d\d):(\d\d):(\d\d)\.(\d{3})$/
  const ms = (value) => { const m = stamp.exec(value); assert.ok(m, `${format}: timestamp ${value}`); return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) }
  const body = format === 'vtt' ? (assert.ok(text.startsWith('WEBVTT\n\n'), 'vtt: header'), text.slice('WEBVTT\n\n'.length)) : text
  assert.ok(body.endsWith(eol), `${format}: terminated`)
  return body.slice(0, body.length - eol.length).split(eol + eol).map((block, index) => {
    const lines = block.split(eol)
    if (format === 'srt') assert.equal(lines.shift(), String(index + 1), 'srt: sequential numbering')
    const [start, end] = lines[0].split(' --> ')
    return { start: ms(start), end: ms(end), text: lines.slice(1).join('\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }
  })
}

/** FFmpeg's own subtitle demuxer: the packets (start, duration) it reads from the file. */
async function demuxCues(ffprobePath, path) {
  const { stdout } = await run(ffprobePath, ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', path], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  return JSON.parse(stdout).packets.map((packet) => ({ start: Math.round(Number(packet.pts_time) * 1000), end: Math.round((Number(packet.pts_time) + Number(packet.duration_time)) * 1000) }))
}

/**
 * The frames of the delivered MP4 at which a caption appears or disappears, found in the rows of the bottom band.
 *  - Without a control, from the frame-to-frame change of the band: a caption is an opaque box with glyphs drawn on, or removed from, ONE frame,
 *    so the change spikes exactly there (valid only where the picture under the band is still, as in the 16:9 output).
 *  - With a control (the same output rendered with its captions hidden, same reframe plan, so the same picture) the frames are those where the
 *    band differs from the control's: valid whatever moves under the band, as in the reframed 9:16 output.
 * Returns the boundary frames and the decoded frame count.
 */
async function captionBoundaryFrames(ffmpegPath, mp4Path, format, frames, controlPath = null) {
  const rows = bandRows(format, 'bottom')
  const top = Math.max(0, rows.top - 10), height = Math.min(rows.canvas.height - top, rows.bottom - rows.top + 20)
  // Whole frames, no filter graph: a filter graph can re-time a stream whose timestamps are irregular and shift every frame after the first
  // irregularity; the band is cut out here, in code.
  const decode = async (path) => (await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', path, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, windowsHide: true })).stdout
  const stdout = await decode(mp4Path)
  const full = rows.canvas.width * rows.canvas.height
  const decoded = Math.floor(stdout.length / full)
  assert.ok(decoded >= frames - 1 && decoded <= frames + 1, `decoded ${decoded} frames (${stdout.length} bytes, ${full} per frame), expected ${frames}`)
  const differs = (left, right) => { let count = 0; for (let index = top * rows.canvas.width; index < (top + height) * rows.canvas.width; index += 1) if (Math.abs(left[index] - right[index]) > 60) count += 1; return count }
  const frame = (buffer, index) => buffer.subarray(index * full, (index + 1) * full)
  let spikes
  if (controlPath) {
    const control = await decode(controlPath)
    const common = Math.min(decoded, Math.floor(control.length / full))
    const flags = Array.from({ length: common }, (_unused, index) => differs(frame(stdout, index), frame(control, index)) >= 150)
    spikes = flags.flatMap((on, index) => ((index === 0 ? on : on !== flags[index - 1]) ? [index] : []))
  } else {
    const moved = [0]
    for (let index = 1; index < decoded; index += 1) moved.push(differs(frame(stdout, index), frame(stdout, index - 1)))
    spikes = moved.flatMap((count, index) => (count >= 150 ? [index] : []))
  }
  if (process.env.W69T_DEBUG_FRAMES) {
    const probe = await run(process.env.FFPROBE_BIN ?? require('ffprobe-static').path, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', mp4Path], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    const times = JSON.parse(probe.stdout).frames.map((entry) => Number(entry.best_effort_timestamp_time))
    const gaps = times.flatMap((time, index) => (index > 0 && Math.abs(time - times[index - 1] - 1 / 30) > 0.002 ? [[index, Number((time - times[index - 1]).toFixed(4))]] : []))
    console.log(`W69T-PTS ${format} frames=${times.length} first=${times[0]} last=${times.at(-1)} gaps=${JSON.stringify(gaps)}`)
  }
  if (process.env.W69T_DEBUG_FRAMES) console.log(`W69T-FRAMES ${format} ${controlPath ? 'control' : 'temporal'} spikes=${JSON.stringify(spikes)}`)
  return { spikes, decoded }
}
/** Frames a player shows for a cue [start, end) ms at 30 fps: frame k is presented at k/30 s, shown iff start <= t < end (exact integers). */
const framesShown = (cue, frames) => { const out = []; for (let k = 0; k < frames; k += 1) if (k * 1000 >= cue.start * FPS && k * 1000 < cue.end * FPS) out.push(k); return out }

test('W69 tail: the sidecar of each output follows the cues its MP4 burned, through override and recompile', { skip: !enabled, timeout: 1_500_000 }, async () => {
  const harnessUrl = process.env.V2_DATABASE_URL
  const poolOf = (limit) => { const url = new URL(harnessUrl); url.searchParams.set('connection_limit', String(limit)); return url.toString() }
  process.env.V2_DATABASE_URL = poolOf(3)
  const db = new PrismaClient({ datasources: { db: { url: poolOf(2) } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-w69t-'))
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const evidenceDir = process.env.APOLLO_SUBTITLE_SIDECAR_EVIDENCE_DIR ? join(process.env.APOLLO_SUBTITLE_SIDECAR_EVIDENCE_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`) : join(root, 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
  const ffprobePath = process.env.FFPROBE_BIN ?? require('ffprobe-static').path
  const servers = []
  let pump
  let failure
  try {
    const world = await seedIssueOverrideWorld({ db, artifactRoot, suffix, ffmpegPath })
    const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const environmentFor = (clientId) => ({
      APOLLO_API_ENVIRONMENT: 'production', APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
      APOLLO_UI_USERNAME: `w69t-${suffix}`, APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(`W69T-${suffix}-secure-passphrase`, `w69t-salt-${suffix}`),
      APOLLO_UI_SESSION_SECRET: `w69t-session-${suffix}-at-least-32-bytes-long`, APOLLO_UI_API_CLIENT_ID: clientId,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', V2_DATABASE_URL: poolOf(2),
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '100000',
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: process.env.APOLLO_PROTECTED_PAYLOAD_KEY_ID ?? `w69t-${suffix}`,
      APOLLO_PROTECTED_PAYLOAD_KEY: process.env.APOLLO_PROTECTED_PAYLOAD_KEY ?? Buffer.alloc(32, 7).toString('base64url'),
    })
    const server = await startServer({ appRoot: process.cwd(), environment: environmentFor(world.owner.clientId) })
    servers.push(server)
    const workerEnvironment = { ...process.env, ...environmentFor(world.owner.clientId) }
    const api = apiClient(server.baseUrl, world.owner.token)
    const strangerApi = apiClient(server.baseUrl, world.stranger.token)
    const readOnly = await issueApiClient({ prisma: db, workspaceId: world.owner.workspaceId, clientId: `w69t-${suffix}-reader`, name: 'W69T read only', createdAt: new Date(), scopes: ['projects:read', 'artifacts:read'] })
    const readerApi = apiClient(server.baseUrl, readOnly.token)
    const anonymousApi = apiClient(server.baseUrl, null)
    const projectPath = `/v1/projects/${world.projectId}`
    const workerFailures = []
    let stopped = false
    const pumpLoop = (async () => {
      while (!stopped) {
        const outcome = await runProxyWorkerOnce({ environment: workerEnvironment, workspaceId: world.owner.workspaceId, onFailure: (item) => workerFailures.push(String(item.error?.stack ?? item.error).slice(0, 600)) })
          .catch((error) => ({ status: 'driver-error', error: String(error).slice(0, 300) }))
        if (!outcome) await delay(600)
      }
    })()
    // The worker pass may be stuck inside the database; stopping it must not hold the run (the harness reaps the process).
    pump = { stop: async () => { stopped = true; await Promise.race([pumpLoop, delay(15_000)]) } }

    const WIDE = { key: 'wide', variantId: world.wideVariantId, format: '16:9' }
    const TALL = { key: 'tall', variantId: world.verticalVariantId, format: '9:16' }
    const head = async () => db.v2ProjectVersion.findUniqueOrThrow({ where: { id: (await db.v2Project.findUniqueOrThrow({ where: { id: world.projectId } })).currentVersionId } })
    const proxyOf = async (versionId, variantId) => {
      const operation = await db.v2ProjectProxyRenderOperation.findFirst({
        where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, projectVersionId: versionId, outputVariantId: variantId, operation: { status: 'succeeded' } }, orderBy: { createdAt: 'desc' },
      })
      if (!operation) return null
      const artifact = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id_workspaceId: { id: operation.outputArtifactId, workspaceId: world.owner.workspaceId } } })
      return { operationId: operation.operationId, artifactId: artifact.id, sha256: artifact.sha256, inputHash: operation.inputHash, path: artifactPath(artifactRoot, artifact.artifactKey), versionId }
    }
    const reviewOf = async (variantId, versionId) => {
      const response = await api('GET', `${projectPath}/proxy-reviews?variantId=${encodeURIComponent(variantId)}&projectVersionId=${versionId}`)
      assert.equal(response.status, 200, serialize(response.body))
      return response.data.review
    }
    const render = async (entry, label) => {
      const enqueued = await api('POST', `${projectPath}/proxy-renders`, { body: { variantId: entry.variantId }, key: `w69t-${suffix}-${entry.key}-${label}` })
      assert.equal(enqueued.status, 202, serialize(enqueued.body))
      await waitFor(`render of ${entry.key} (${label})`, async () => ['succeeded', 'failed'].includes((await db.v2PublicOperation.findUnique({ where: { id: enqueued.data.operation.id } }))?.status)).catch(async (error) => {
        // A render that never settles is a failure with evidence: who holds what in the database, and what the worker said.
        const activity = await db.$queryRawUnsafe(`SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS xact_age, left(query, 160) AS query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY xact_start NULLS LAST`).catch((cause) => [{ error: String(cause) }])
        const operation = await db.v2PublicOperation.findUnique({ where: { id: enqueued.data.operation.id } })
        await writeFile(join(evidenceDir, `diagnostic-${label}.json`), serialize({ error: String(error), operation, activity, workerFailures })).catch(() => undefined)
        throw error
      })
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: enqueued.data.operation.id } })).status, 'succeeded', `render ${label} succeeded: ${workerFailures.join(' | ')}`)
      const current = await head()
      return { proxy: await proxyOf(current.id, entry.variantId), review: await reviewOf(entry.variantId, current.id), versionId: current.id }
    }
    const override = async (entry, segmentId, dimensions, label) => {
      const base = await head()
      const response = await api('POST', `${projectPath}/subtitle-segment-overrides`, { key: `w69t-${suffix}-${entry.key}-${label}`,
        body: { baseVersionId: base.id, baseHash: base.baseHash, variantId: entry.variantId, segmentId, action: 'set', dimensions } })
      assert.equal(response.status, 201, serialize(response.body))
      return response.data
    }
    const exportSidecar = (entry, format, { key, projectVersionId, locale, client = api } = {}) =>
      client('POST', `${projectPath}/subtitle-sidecars`, { key: key ?? `w69t-${suffix}-${entry.key}-${format}-${randomUUID().slice(0, 6)}`, body: { variantId: entry.variantId, format, ...(locale ? { locale } : {}), ...(projectVersionId ? { projectVersionId } : {}) } })
    const downloadBytes = async (sidecar) => {
      const response = await fetch(new URL(`/v1/artifacts/${sidecar.artifactId}/content`, server.baseUrl), { headers: { authorization: `Bearer ${world.owner.token}` } })
      assert.equal(response.status, 200, 'the artifact content route serves the sidecar')
      return Buffer.from(await response.arrayBuffer())
    }
    const storedBytes = async (sidecar) => {
      const artifact = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id_workspaceId: { id: sidecar.artifactId, workspaceId: world.owner.workspaceId } } })
      return readFile(artifactPath(artifactRoot, artifact.artifactKey))
    }

    /** The whole chain for one exported sidecar: API record, download, storage, hash, independent parse, FFmpeg demux and the decoded frames. */
    const verify = async ({ entry, format, rendered, expectedTexts, expectedOmitted, label, controlPath = null }) => {
      const exported = await exportSidecar(entry, format, { projectVersionId: rendered.versionId })
      assert.ok([200, 201].includes(exported.status), `${label}: ${serialize(exported.body)}`)
      const { sidecar, alignment, projectVersion } = exported.data
      assert.equal(sidecar.variantId, entry.variantId)
      assert.equal(sidecar.outputSha256, rendered.proxy.sha256, `${label}: the sidecar names the SHA-256 of ITS OWN mp4`)
      assert.equal(sidecar.renderInputHash, rendered.proxy.inputHash, `${label}: and the RenderInput hash of its own render`)
      assert.equal(sidecar.outputArtifactId, rendered.proxy.artifactId)
      assert.equal(projectVersion.id, rendered.versionId)
      assert.deepEqual(alignment.omittedCueIds, expectedOmitted, `${label}: the cues the render did not draw are named`)
      assert.equal(alignment.subtitleOverridesHash, rendered.review.formatQuality.subtitleOverridesHash ?? null, `${label}: the exceptions named are the ones the review recorded`)
      const bytes = await downloadBytes(sidecar)
      assert.equal(sha256Of(bytes), sidecar.sha256, `${label}: the downloaded bytes are the bytes the record names`)
      assert.equal(sha256Of(await storedBytes(sidecar)), sidecar.sha256, `${label}: and the bytes in storage`)
      assert.equal(bytes.byteLength, sidecar.byteSize)
      const cues = readSidecar(bytes, format)
      assert.deepEqual(cues.map((cue) => cue.text), expectedTexts, `${label}: the cue texts are the texts burned in the MP4`)
      assert.equal(cues.length, sidecar.cueCount)
      for (let index = 0; index < cues.length; index += 1) {
        assert.ok(cues[index].end > cues[index].start, `${label}: positive range`)
        if (index > 0) assert.ok(cues[index].start >= cues[index - 1].end, `${label}: monotonic, no overlap`)
      }
      assert.equal(cues.at(-1).text, expectedTexts.at(-1), `${label}: the last cue is present`)
      // FFmpeg's own demuxer reads the same timing from the file
      const sidecarPath = join(evidenceDir, `${label.replaceAll(/[^a-z0-9]+/gi, '-')}.${format}`)
      await writeFile(sidecarPath, bytes)
      const demuxed = await demuxCues(ffprobePath, sidecarPath)
      assert.equal(demuxed.length, cues.length, `${label}: FFmpeg demuxes ${cues.length} cues`)
      demuxed.forEach((cue, index) => { assert.ok(Math.abs(cue.start - cues[index].start) <= 1 && Math.abs(cue.end - cues[index].end) <= 1, `${label}: demuxer ${serialize(cue)} vs file ${serialize(cues[index])}`) })
      // the decoded frames of the delivered MP4: first and last frame with caption pixels of each cue
      if (process.env.W69T_DEBUG_FRAMES) {
        await copyFile(rendered.proxy.path, join(evidenceDir, `${label}-delivered.mp4`))
        if (controlPath) await copyFile(controlPath, join(evidenceDir, `${label}-control.mp4`))
      }
      const { spikes, decoded } = await captionBoundaryFrames(ffmpegPath, rendered.proxy.path, entry.format, 150, controlPath)
      const shown = cues.map((cue) => framesShown(cue, 150))
      const expectedSpikes = [...new Set(shown.flatMap((frames) => [frames[0], frames.at(-1) + 1]))].toSorted((left, right) => left - right)
      assert.deepEqual(spikes, expectedSpikes, `${label}: the frames where the decoded MP4 gains or loses a caption are the first and the one-past-last frame the sidecar shows for each cue`)
      note(label, { format, decodedFrames: decoded, cues: cues.map((cue) => [cue.start, cue.end, cue.text]), spikes, sha: sidecar.sha256, mp4: rendered.proxy.sha256, replayed: exported.data.replayed })
      return { exported, sidecar, bytes, cues }
    }

    /* ------------------------------------------------------------ baseline: both outputs, V0 */
    const baseline = {}
    for (const entry of [WIDE, TALL]) {
      const plan = await api('POST', `${projectPath}/reframe-plans`, { body: { baseVersionId: world.headVersionId, variantId: entry.variantId } })
      assert.equal(plan.status, 200, serialize(plan.body))
      baseline[entry.key] = await render(entry, 'first')
      assert.notEqual(baseline[entry.key].review.status, 'blocked', `${entry.key}: a 25-character caption does not block at ${entry.format}`)
    }
    // The 9:16 output is reframed: its picture pans under the caption band, so its caption frames are measured against a control - the SAME
    // output rendered with its captions hidden (the reframe plan is carried to every Version, so the picture is the same).
    await override(TALL, 'cue-1', [{ kind: 'visibility', visible: false }], 'control-1')
    await override(TALL, 'cue-2', [{ kind: 'visibility', visible: false }], 'control-2')
    const control = await render(TALL, 'control')
    assert.equal(control.proxy.versionId, (await head()).id)
    const controlPathOf = { wide: null, tall: control.proxy.path }
    const V0 = {}
    for (const entry of [WIDE, TALL]) {
      V0[entry.key] = {}
      for (const format of ['srt', 'vtt']) {
        V0[entry.key][format] = await verify({ entry, format, rendered: baseline[entry.key], expectedTexts: [CUES[0].text, CUES[1].text], expectedOmitted: ['cue-3'], label: `v0-${entry.key}-${format}`, controlPath: controlPathOf[entry.key] })
      }
    }
    assert.notEqual(baseline.wide.proxy.sha256, baseline.tall.proxy.sha256)

    /* ------------------------------------------------------------ a stale render is refused with its reason */
    const afterFirst = await override(WIDE, 'cue-1', [{ kind: 'text', text: 'Ação' }], 'text-1')
    const stale = await exportSidecar(WIDE, 'srt')
    assert.equal(stale.status, 409, serialize(stale.body))
    assert.equal(stale.error.code, 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH')
    assert.equal(stale.error.details?.reason, 'render-stale', serialize(stale.error))
    assert.equal(stale.error.details?.renderedVersionId, world.headVersionId)
    assert.equal(stale.error.details?.requestedVersionId, afterFirst.version.id)
    note('stale-refused', { error: stale.error.code, reason: stale.error.details?.reason })

    /* ------------------------------------------------------------ text exception + recompile of ONE output */
    await override(WIDE, 'cue-2', [{ kind: 'text', text: 'Última cue.' }], 'text-2')
    const recompiled = await render(WIDE, 'after-text')
    assert.notEqual(recompiled.proxy.sha256, baseline.wide.proxy.sha256, 'the recompiled MP4 draws other pixels')
    assert.match(recompiled.review.formatQuality.subtitleOverridesHash ?? '', /^[a-f0-9]{64}$/)
    const edited = {}
    for (const format of ['srt', 'vtt']) {
      edited[format] = await verify({ entry: WIDE, format, rendered: recompiled, expectedTexts: ['Ação', 'Última cue.'], expectedOmitted: ['cue-3'], label: `text-${WIDE.key}-${format}` })
      assert.notEqual(edited[format].sidecar.sha256, V0.wide?.[format]?.sidecar.sha256)
    }
    // the other output's sidecar did not move: same record, same bytes, same MP4, replayed by lineage
    for (const format of ['srt', 'vtt']) {
      const again = await exportSidecar(TALL, format, { projectVersionId: baseline.tall.versionId })
      assert.equal(again.status, 200, serialize(again.body))
      assert.equal(again.data.replayed, true, 'the untouched output replays the sidecar it had')
      assert.equal(again.data.sidecar.sha256, V0.tall[format].sidecar.sha256)
      assert.equal(again.data.sidecar.id, V0.tall[format].sidecar.id)
      assert.equal(again.data.sidecar.outputSha256, baseline.tall.proxy.sha256)
    }
    // two outputs, two MP4s, two RenderInputs, two variants
    assert.notEqual(edited.srt.sidecar.outputSha256, V0.tall.srt.sidecar.outputSha256)
    assert.notEqual(edited.srt.sidecar.renderInputHash, V0.tall.srt.sidecar.renderInputHash)
    assert.notEqual(edited.srt.sidecar.variantId, V0.tall.srt.sidecar.variantId)

    /* ------------------------------------------------------------ the sidecar listing shows both outputs' sidecars, each with its Version */
    const listed = await api('GET', `${projectPath}/subtitle-sidecars?limit=100`)
    assert.equal(listed.status, 200)
    for (const item of [V0.wide.srt.sidecar, V0.tall.srt.sidecar, edited.srt.sidecar]) assert.ok(listed.data.sidecars.some((entry) => entry.id === item.id && entry.projectVersionId === item.projectVersionId))

    /* ------------------------------------------------------------ hide a cue: absent from the burned pixels AND the sidecar */
    await override(WIDE, 'cue-2', [{ kind: 'visibility', visible: false }], 'hide-2')
    const hidden = await render(WIDE, 'after-hide')
    const hiddenCues = {}
    for (const format of ['srt', 'vtt']) hiddenCues[format] = await verify({ entry: WIDE, format, rendered: hidden, expectedTexts: ['Ação'], expectedOmitted: ['cue-3'], label: `hidden-${WIDE.key}-${format}` })

    /* ------------------------------------------------------------ a text too long for the band: the render is reproved, no sidecar is exported for it */
    const tooLong = OVERFLOW_CAPTION
    await override(WIDE, 'cue-1', [{ kind: 'text', text: tooLong }], 'text-long')
    const overflowed = await render(WIDE, 'after-overflow')
    assert.equal(overflowed.review.status, 'blocked', serialize(overflowed.review.technicalIssues.concat(overflowed.review.criticIssues).map((issue) => [issue.code, issue.severity])))
    const blocked = await exportSidecar(WIDE, 'srt', { projectVersionId: overflowed.versionId })
    assert.equal(blocked.status, 409, serialize(blocked.body))
    assert.equal(blocked.error.details?.reason, 'render-blocked')
    assert.equal(blocked.error.details?.reviewHash, overflowed.review.reviewHash)
    assert.equal((await db.v2ProjectSubtitleSidecar.count({ where: { workspaceId: world.owner.workspaceId, projectVersionId: overflowed.versionId } })), 0, 'nothing was persisted for a reproved render')
    note('blocked-refused', { review: overflowed.review.status, reason: blocked.error.details?.reason })

    /* ------------------------------------------------------------ authorization */
    const probes = {
      strangerExport: await exportSidecar(WIDE, 'srt', { projectVersionId: hidden.versionId, client: strangerApi }),
      strangerList: await strangerApi('GET', `${projectPath}/subtitle-sidecars`),
      readerExport: await exportSidecar(WIDE, 'srt', { projectVersionId: hidden.versionId, client: readerApi }),
      anonymousExport: await exportSidecar(WIDE, 'srt', { projectVersionId: hidden.versionId, client: anonymousApi }),
    }
    assert.equal(probes.strangerExport.status, 404, 'another workspace: the project is not found')
    // The list is scoped by workspace: another workspace's token reads an empty list, byte for byte what it reads for a project that does not exist
    // (no data, and no way to tell the two apart).
    assert.equal(probes.strangerList.status, 200)
    assert.deepEqual(probes.strangerList.data.sidecars, [])
    const bogus = await strangerApi('GET', '/v1/projects/no-such-project/subtitle-sidecars')
    assert.deepEqual([bogus.status, bogus.data.sidecars], [probes.strangerList.status, probes.strangerList.data.sidecars])
    assert.equal(probes.readerExport.status, 403, `a client without projects:write may not export: ${serialize(probes.readerExport.body)}`)
    assert.equal(probes.anonymousExport.status, 401)
    assert.equal((await readerApi('GET', `${projectPath}/subtitle-sidecars`)).status, 200, 'but may read the list')
    const strangerDownload = await fetch(new URL(`/v1/artifacts/${hiddenCues.srt.sidecar.artifactId}/content`, server.baseUrl), { headers: { authorization: `Bearer ${world.stranger.token}` } })
    assert.ok([403, 404].includes(strangerDownload.status), `another workspace cannot download the sidecar (${strangerDownload.status})`)
    note('authorization', Object.fromEntries(Object.entries(probes).map(([name, response]) => [name, response.status])))

    /* ------------------------------------------------------------ replay, mismatch, storage */
    // A new lineage (another locale of the same render) under a key of ours: created once, replayed by the same key, refused for another request.
    const key = `w69t-${suffix}-replay`
    const first = await exportSidecar(WIDE, 'vtt', { key, locale: 'en-US', projectVersionId: hidden.versionId })
    assert.equal(first.status, 201, serialize(first.body))
    assert.equal(first.data.replayed, false)
    const replay = await exportSidecar(WIDE, 'vtt', { key, locale: 'en-US', projectVersionId: hidden.versionId })
    assert.equal(replay.status, 200)
    assert.equal(replay.data.replayed, true)
    assert.equal(replay.data.sidecar.id, first.data.sidecar.id)
    assert.equal(replay.data.sidecar.sha256, first.data.sidecar.sha256)
    const mismatch = await exportSidecar(WIDE, 'srt', { key, locale: 'en-US', projectVersionId: hidden.versionId })
    assert.equal(mismatch.status, 409, serialize(mismatch.body))
    assert.equal(mismatch.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
    // and a fresh key for the same request is answered by its lineage: the same sidecar, not a second one
    const sameLineage = await exportSidecar(WIDE, 'vtt', { locale: 'en-US', projectVersionId: hidden.versionId })
    assert.equal(sameLineage.data.sidecar.id, first.data.sidecar.id)
    assert.equal(sameLineage.data.replayed, true)
    // a corrupted file in storage is not served as the sidecar it was
    const artifactRow = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id_workspaceId: { id: first.data.sidecar.artifactId, workspaceId: world.owner.workspaceId } } })
    const storedPath = artifactPath(artifactRoot, artifactRow.artifactKey)
    const original = await readFile(storedPath)
    await writeFile(storedPath, Buffer.concat([original.subarray(0, original.length - 3), Buffer.from('xyz')]))
    const tampered = await fetch(new URL(`/v1/artifacts/${first.data.sidecar.artifactId}/content`, server.baseUrl), { headers: { authorization: `Bearer ${world.owner.token}` } })
    const tamperedBody = await tampered.arrayBuffer().then((buffer) => Buffer.from(buffer), (error) => ({ streamError: String(error) }))
    note('storage-tamper', { status: tampered.status, streamError: Buffer.isBuffer(tamperedBody) ? null : tamperedBody.streamError })
    assert.ok(tampered.status >= 400 || !Buffer.isBuffer(tamperedBody), 'a file whose bytes no longer match the recorded SHA-256 is refused by verified storage, never served as the sidecar')
    await writeFile(storedPath, original)

    assert.equal(workerFailures.length, 0, workerFailures.join('\n'))
  } catch (error) {
    failure = error
    throw error
  } finally {
    await pump?.stop().catch(() => undefined)
    for (const server of servers) await server.stop().catch(() => undefined)
    await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify({ ...evidence, failure: failure ? String(failure.stack ?? failure) : null }, null, 2)).catch(() => undefined)
    if (failure) for (const server of servers) await writeFile(join(evidenceDir, 'server-log-tail.txt'), server.logs.text.slice(-20_000)).catch(() => undefined)
    await db.$disconnect().catch(() => undefined)
    const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
    await disconnectV2PostgresClient().catch(() => undefined)
  }
})
