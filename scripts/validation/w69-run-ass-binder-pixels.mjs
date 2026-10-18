#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireWorkloadLock, releaseWorkloadLock, WorkloadLockHeldError } from './workload-lock.mjs'

/**
 * Supervised physical proof of the W69 ASS binder (ass-frame-clock/v2).
 *
 *   node scripts/validation/w69-run-ass-binder-pixels.mjs --base <BASE> [--dry-run]
 *
 * It takes the global workload lock `<BASE>/workload.lock` by exclusive create (it never waits for
 * it and never steals it), authenticates the pinned FFmpeg and font by SHA-256, runs the pixel proof
 * once, writes add-only evidence into a new `<BASE>/<run id>/` directory and releases the lock in
 * `finally`. It starts no database and downloads nothing. The proof itself is
 * tests/v2/ass-emission-clock-pixels.integration.mjs; this wrapper only supervises it.
 */
const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const TEST_FILE = 'tests/v2/ass-emission-clock-pixels.integration.mjs'
// Same pins as the authenticated v5 run (ffmpeg-8.1.1 full build, Arial). Override only with another independently approved pin.
const DEFAULTS = Object.freeze({
  ffmpeg: 'C:/Users/leand/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin/ffmpeg.exe',
  ffmpegSha256: '09948d4cdd0650da6ff5a87577469f2a218dc2615ae379f8f734d24c49de0f73',
  font: 'C:/Windows/Fonts/arial.ttf',
  fontSha256: 'b3658eadae55e682b5f69eb64c439c1ecc8f196c0bb8d4756d145d13bc86476a',
  fontFamily: 'Arial',
  fontFace: 'ArialMT',
  label: 'w69-ass-binder-pixels-v6',
  timeoutMs: 15 * 60_000,
})
const SOURCES = ['tests/v2/ass-emission-clock-pixels.integration.mjs', 'src/v2/domain/libass-clock-model.ts',
  'src/v2/domain/ass-emission-policy.ts', 'src/v2/infrastructure/media/ffmpeg-editorial-composition-graph.ts',
  'src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts']

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function parseArguments(argv) {
  const options = { ...DEFAULTS, dryRun: false, base: null }
  const take = (name, index) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--base') { options.base = take(argument, index); index += 1 }
    else if (argument === '--ffmpeg') { options.ffmpeg = take(argument, index); index += 1 }
    else if (argument === '--ffmpeg-sha256') { options.ffmpegSha256 = take(argument, index); index += 1 }
    else if (argument === '--font') { options.font = take(argument, index); index += 1 }
    else if (argument === '--font-sha256') { options.fontSha256 = take(argument, index); index += 1 }
    else if (argument === '--font-family') { options.fontFamily = take(argument, index); index += 1 }
    else if (argument === '--font-face') { options.fontFace = take(argument, index); index += 1 }
    else if (argument === '--label') { options.label = take(argument, index); index += 1 }
    else if (argument === '--timeout-ms') { options.timeoutMs = Number(take(argument, index)); index += 1 }
    else throw new Error(`Unknown argument ${argument}`)
  }
  if (options.base === null || !isAbsolute(options.base)) throw new Error('--base <absolute BASE directory> is required')
  if (!isAbsolute(options.ffmpeg) || !isAbsolute(options.font)) throw new Error('--ffmpeg and --font must be absolute paths')
  for (const pin of [options.ffmpegSha256, options.fontSha256]) if (!/^[a-f0-9]{64}$/.test(pin)) throw new Error('Pins must be SHA-256 hex')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60 * 60_000) throw new Error('--timeout-ms is out of range')
  return Object.freeze(options)
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

async function authenticate(options) {
  const ffmpeg = sha256(await readFile(options.ffmpeg)), font = sha256(await readFile(options.font))
  if (ffmpeg !== options.ffmpegSha256) throw new Error(`FFmpeg SHA-256 ${ffmpeg} differs from the pin`)
  if (font !== options.fontSha256) throw new Error(`Font SHA-256 ${font} differs from the pin`)
  return { ffmpeg, font }
}

async function sourceFacts() {
  const files = {}
  for (const file of SOURCES) files[file] = sha256(await readFile(join(REPO, file)))
  return { commit: git('rev-parse', 'HEAD'), dirtyStatusSha256: sha256(git('status', '--porcelain')), files }
}

export async function main(argv) {
  const options = parseArguments(argv)
  const runId = `${options.label}-${randomBytes(4).toString('hex')}`
  const evidenceRoot = join(options.base, runId)
  const lockPath = join(options.base, 'workload.lock')
  const plan = { runId, repo: REPO, test: TEST_FILE, evidenceRoot, lockPath, ffmpeg: options.ffmpeg, font: options.font,
    timeoutMs: options.timeoutMs, args: ['--experimental-transform-types', '--test', TEST_FILE] }
  if (options.dryRun) { console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2)); return 0 }

  const pins = await authenticate(options)
  const source = await sourceFacts()
  let lock
  try { lock = await acquireWorkloadLock({ lockPath, label: options.label }) } catch (error) {
    if (error instanceof WorkloadLockHeldError) {
      console.error(`BLOCKED: the global workload lock is held (${JSON.stringify(error.holder)}). Nothing was started.`)
      return 3
    }
    throw error
  }
  let released = 'not-attempted'
  try {
    await mkdir(evidenceRoot) // exclusive: a new run id never reuses a directory
    const logPath = join(evidenceRoot, `${runId}.log`)
    const log = createWriteStream(logPath, { flags: 'wx' })
    const startedAt = new Date().toISOString()
    const environment = { ...process.env, FFMPEG_BIN: options.ffmpeg, APOLLO_ASS_FFMPEG_SHA256: options.ffmpegSha256,
      APOLLO_ASS_FONT_PATH: options.font, APOLLO_ASS_FONT_SHA256: options.fontSha256, APOLLO_ASS_FONT_FAMILY: options.fontFamily,
      APOLLO_ASS_FONT_POSTSCRIPT_NAME: options.fontFace, APOLLO_ASS_EVIDENCE_ROOT: join(evidenceRoot, 'ass-clock') }
    const child = spawn(process.execPath, plan.args, { cwd: REPO, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, options.timeoutMs)
    const exit = await new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })) })
    clearTimeout(timer)
    await new Promise((done) => log.end(done))
    const logBytes = await readFile(logPath)
    const result = { schemaVersion: 'w69-ass-binder-pixels-run/v1', runId, ownerPid: process.pid, childPid: child.pid, plan,
      pins: { ...pins, fontFamily: options.fontFamily, fontFace: options.fontFace }, source, lock: lock.record,
      startedAt, completedAt: new Date().toISOString(), exitCode: exit.code, signal: exit.signal, timedOut,
      logSha256: sha256(logBytes), logBytes: logBytes.length, success: exit.code === 0 && !timedOut }
    await writeFile(join(evidenceRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ runId, evidenceRoot, exitCode: exit.code, timedOut, success: result.success }, null, 2))
    return result.success ? 0 : 1
  } finally {
    released = await releaseWorkloadLock(lock)
    console.log(`workload lock: ${released}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => { console.error(error); process.exitCode = 2 })
}
