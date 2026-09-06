import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'

import { readdirSync, readFileSync } from 'node:fs'

import {
  FFMPEG_PATH_ENVIRONMENT_VARIABLES,
  resolveFfmpegBinary,
  resolveMediaBinary,
} from '../../src/v2/infrastructure/media/ffmpeg-binary.ts'
import { resolveFfprobeBinary } from '../../src/v2/infrastructure/media/ffmpeg-sync-marker-renderer.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

/**
 * The defect this file guards is invisible until a production build runs.
 *
 * `ffmpeg-static` answers `path.join(__dirname, 'ffmpeg.exe')`; a bundler
 * rewrites `__dirname`; the built server spawns a file inside
 * `.next/server/chunks` that was never put there, and the operator is told the
 * render failed. No unit test saw it, no integration test saw it — they all run
 * from source, where the package's answer happens to be right — and the browser
 * E2E only got past it by naming the binary in the server's environment.
 *
 * So two kinds of proof live here. The structural one says every spawn in
 * `src/` — every one, whatever its first argument is spelled, ffprobe included
 * — takes its path from the resolver, and is itself checked against sources
 * that bypass it, because a scanner that matches nothing passes quietly. The
 * behavioural one exercises all four resolution steps, including the one that
 * only matters under a bundle: a directory laid out like `.next/server/chunks`,
 * a bundled path that does not exist, and the walk that climbs out to a real
 * installation.
 *
 * The structural half is written this way because the first version of it was
 * not: it only looked at spawns whose argument text already said "ffmpeg", only
 * audited assignments literally spelled `ffmpegPath`, and only refused the bare
 * name after `||`. A provider that called its field `encoderPath` and wrote
 * `?? 'ffmpeg'` passed it, and so did the one ffprobe resolution in this
 * repository that had never been repaired.
 */

const root = resolve(import.meta.dirname, '../..')
const RESOLVER = 'src/v2/infrastructure/media/ffmpeg-binary.ts'
const EXECUTABLE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

function sourceFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

function repositorySources() {
  const sources = new Map()
  for (const file of sourceFiles(join(root, 'src'))) {
    sources.set(relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8'))
  }
  return sources
}

/** The three functions allowed to answer with the path of a media binary. */
const RESOLVER_CALL = /\bresolve(?:FfmpegBinary|FfprobeBinaryPath|FfprobeBinary)\(/

/**
 * A bare executable name used as a value: `|| 'ffmpeg'`, `?? 'ffprobe'`, the
 * tail of a ternary, a plain assignment, a `return`.
 *
 * The rule used to be `|| 'ffmpeg'` alone, and one operator — `??` — walked
 * straight past it. `===` and its neighbours are excluded so a comparison
 * against the provider name `'ffprobe'` is not read as a fallback.
 */
const BARE_BINARY_NAME =
  /(?:\|\||\?\?|(?<![=!<>])=|\?[^\n?]*:|\breturn)\s*['"](?:ffmpeg|ffprobe)(?:\.exe)?['"]/

/**
 * Spawns in `src/` whose first argument is not a media binary, one by one.
 *
 * Every spawn is audited, however its argument is spelled — keying on the text
 * "ffmpeg" is exactly how a provider that named its field `encoderPath` walked
 * past the old rule. The price is that the spawns which genuinely are not
 * ffmpeg or ffprobe have to be declared here, by file and by expression, and
 * the test fails when one of these stops being true as loudly as when a new
 * undeclared spawn appears.
 */
const NON_MEDIA_SPAWNS = new Map([
  ['src/v2/infrastructure/image/tesseract-image-vision-provider.ts', ['this.binary']],
  ['src/v2/infrastructure/remotion-render-input-renderer.ts', ["'taskkill'", 'process.execPath']],
])

/**
 * Spawn sites whose binary arrives as a function parameter, with the modules
 * that supply it.
 *
 * A file that never assigns the path cannot be checked against the resolver on
 * its own, so the check moves to its callers: the set of modules in `src/` that
 * import it has to be exactly `producers`, and in each of those the fields it
 * reads have to be resolver-derived themselves.
 */
const INBOUND_SPAWNS = new Map([
  ['src/v2/infrastructure/media/audio-concatenation.ts', Object.freeze({
    expressions: ['ffprobePath', 'input.ffmpegPath'],
    fields: ['ffmpegPath', 'ffprobePath'],
    producers: ['src/v2/infrastructure/repository-factory.ts'],
  })],
])

/** Block and line comments removed, so no rule ever reads prose as code. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Every spawn in a file, first argument first.
 *
 * `promisify(execFile)` is bound to a different name in almost every provider —
 * `execFileAsync` in most, `run` in the audio concatenation — so the names are
 * read out of the file rather than guessed; otherwise a whole module's spawns
 * are invisible to the scan.
 */
function spawnExpressions(source) {
  const aliases = [...source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*(?:execFile|spawn)\s*\)/g,
  )].map((match) => match[1])
  const names = ['execFileAsync', 'execFileSync', 'execFile', 'spawnSync', 'spawn', ...aliases]
  const pattern = new RegExp(String.raw`\b(?:${names.join('|')})\(\s*([^,\n]+),`, 'g')
  return [...source.matchAll(pattern)].map((match) => match[1].trim())
}

/** The body of `function <name>(` or `const <name> = (…) =>`, by brace matching. */
function functionBody(source, name) {
  const declaration = [`function ${name}(`, `${name} = (`, `${name}: (`]
    .map((form) => source.indexOf(form))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0]
  if (declaration === undefined) return null
  const opening = source.indexOf('{', declaration)
  if (opening < 0) return null
  let depth = 0
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(opening, index + 1)
    }
  }
  return null
}

/** Everything assigned to `<field>` or `this.<field>` in this file. */
function assignedValues(source, field) {
  const pattern = new RegExp(String.raw`(?:^|[^\w$.])(?:this\.)?${field}\s*=(?!=)`, 'g')
  const values = []
  for (const match of source.matchAll(pattern)) {
    const from = match.index + match[0].length
    values.push(source.slice(from, from + 240))
  }
  return values
}

const IDENTIFIER_CHAIN = /^(?:this\.)?[A-Za-z_$][\w$]*(?:[?!]?\.[A-Za-z_$][\w$]*)*$/

/**
 * Where a spawned expression got its value: the resolver, a caller, or nowhere
 * anybody can name.
 *
 * The identifier is traced back to its assignment in the same file — through a
 * local helper, and through one more assignment if that helper answered with
 * another local — and an expression that cannot be traced is a violation rather
 * than a skip. That is the whole difference from the rule this replaced, which
 * only ever looked at arguments whose text already said "ffmpeg".
 */
function traceSpawnedBinary(source, expression, depth = 0) {
  const value = expression.trim()
  if (RESOLVER_CALL.test(value)) return { kind: 'routed' }
  if (depth > 2) {
    return { kind: 'violation', why: `${JSON.stringify(value)} could not be traced to the resolver` }
  }

  const call = /^([A-Za-z_$][\w$]*)\(/.exec(value)
  if (call) {
    const body = functionBody(source, call[1])
    if (body && RESOLVER_CALL.test(body)) return { kind: 'routed' }
    return { kind: 'violation', why: `spawns the answer of ${call[1]}(), which never asks the resolver` }
  }
  if (!IDENTIFIER_CHAIN.test(value)) {
    return { kind: 'violation', why: `spawns ${JSON.stringify(value)}, which the resolver never produced` }
  }

  const field = value.replace(/[?!]/g, '').split('.').pop()
  const assignments = assignedValues(source, field)
  if (assignments.length === 0) return { kind: 'inbound', field }
  for (const assigned of assignments) {
    if (RESOLVER_CALL.test(assigned)) continue
    const first = /^\s*([^;\n]+)/.exec(assigned)
    const inner = first
      ? traceSpawnedBinary(source, first[1].trim(), depth + 1)
      : { kind: 'violation' }
    if (inner.kind === 'routed') continue
    return {
      kind: 'violation',
      why: `assigns ${field} from ${JSON.stringify((first?.[1] ?? assigned).trim().slice(0, 60))}, `
        + 'which did not come from the resolver',
    }
  }
  return { kind: 'routed' }
}

/**
 * Every way a file could get an ffmpeg or an ffprobe path without asking the
 * resolver.
 *
 * Exported as a function over a source map rather than run inline, so the test
 * below can hand it a file that cheats and watch it complain — the only way to
 * know the rule would catch tomorrow's provider.
 */
function mediaBinaryRoutingViolations(sources) {
  const violations = []
  const routed = []
  const inbound = []
  const declaredNonMedia = []
  for (const [path, raw] of sources) {
    if (path === RESOLVER) continue
    const source = withoutComments(raw)

    if (/['"]ffmpeg-static['"]/.test(source)) {
      violations.push(`${path}: names ffmpeg-static instead of asking the resolver`)
    }
    // ffprobe-static may be named, because its path is what the resolver checks
    // against the disk — but only by a file that hands it straight over.
    if (/['"]ffprobe-static['"]/.test(source) && !RESOLVER_CALL.test(source)) {
      violations.push(`${path}: names ffprobe-static without handing its path to the resolver`)
    }
    if (BARE_BINARY_NAME.test(source)) {
      violations.push(`${path}: falls back to a bare executable name, which resolves only on a machine that has one`)
    }

    for (const expression of spawnExpressions(source)) {
      if ((NON_MEDIA_SPAWNS.get(path) ?? []).includes(expression)) {
        declaredNonMedia.push(`${path}::${expression}`)
        continue
      }
      const traced = traceSpawnedBinary(source, expression)
      if (traced.kind === 'routed') {
        routed.push(path)
        continue
      }
      if (traced.kind === 'inbound') {
        const entry = INBOUND_SPAWNS.get(path)
        if (entry && entry.expressions.includes(expression)) {
          inbound.push(`${path}::${expression}`)
          continue
        }
        violations.push(
          `${path}: spawns ${JSON.stringify(expression)}, whose ${traced.field} this file never resolves `
          + 'and which no declared caller supplies',
        )
        continue
      }
      violations.push(`${path}: ${traced.why}`)
    }
  }
  return {
    violations,
    routed: [...new Set(routed)],
    inbound: [...new Set(inbound)].sort(),
    declaredNonMedia: [...new Set(declaredNonMedia)].sort(),
  }
}

test('every ffmpeg and ffprobe spawn in src/ takes its path from the resolver', () => {
  const sources = repositorySources()
  const { violations, routed, inbound, declaredNonMedia } = mediaBinaryRoutingViolations(sources)
  assert.deepEqual(violations, [], violations.join('\n'))

  // A scanner that found nothing would also report no violations, so the
  // providers it did verify are counted and named — ffprobe among them, which
  // the rule this replaced skipped by construction.
  assert.ok(routed.length >= 15, `only ${routed.length} spawn sites were verified`)
  for (const expected of [
    'src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts',
    'src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts',
    'src/v2/infrastructure/media/ffmpeg-playback-fingerprint.ts',
    'src/v2/infrastructure/analysis/ffmpeg-multicam-visual-evidence-provider.ts',
    'src/v2/infrastructure/transformation/ffmpeg-transformation-critic.ts',
    // The four ffprobe resolutions, including the one that stayed unrepaired
    // while the commit that fixed the others said there had been three.
    'src/v2/infrastructure/media/video-probe.ts',
    'src/v2/infrastructure/media/synthetic-critic-media-integrity.ts',
    'src/v2/infrastructure/media/ffmpeg-sync-marker-renderer.ts',
    'src/v2/infrastructure/media/ffmpeg-speaker-diarization-audio-preparer.ts',
  ]) {
    assert.ok(routed.includes(expected), `${expected} was not seen spawning a media binary at all`)
  }

  // The two lists of exceptions are pinned, so an entry that stops being true
  // is as red as an entry nobody declared.
  assert.deepEqual(declaredNonMedia, [
    'src/v2/infrastructure/image/tesseract-image-vision-provider.ts::this.binary',
    "src/v2/infrastructure/remotion-render-input-renderer.ts::'taskkill'",
    'src/v2/infrastructure/remotion-render-input-renderer.ts::process.execPath',
  ])
  assert.deepEqual(inbound, [
    'src/v2/infrastructure/media/audio-concatenation.ts::ffprobePath',
    'src/v2/infrastructure/media/audio-concatenation.ts::input.ffmpegPath',
  ])

  // And the resolver is the one module allowed to name ffmpeg-static.
  const naming = [...sources].filter(([, source]) => /['"]ffmpeg-static['"]/.test(source)).map(([path]) => path)
  assert.deepEqual(naming, [RESOLVER])
})

test('a spawn whose binary comes from a caller is checked in the caller', () => {
  const sources = repositorySources()
  for (const [path, entry] of INBOUND_SPAWNS) {
    const moduleName = path.replace(/^.*\//, '').replace(/\.tsx?$/, '')
    const importers = [...sources]
      .filter(([other, source]) => other !== path && new RegExp(`['"][^'"]*${moduleName}\\.ts['"]`).test(source))
      .map(([other]) => other)
      .sort()
    assert.deepEqual(
      importers, [...entry.producers].sort(),
      `${path} is spawned with a binary from a module nobody checked`,
    )
    for (const producer of entry.producers) {
      const source = withoutComments(sources.get(producer))
      for (const field of entry.fields) {
        const assignments = assignedValues(source, field)
        assert.ok(assignments.length > 0, `${producer} never produces ${field}`)
        for (const assigned of assignments) {
          assert.match(
            assigned, RESOLVER_CALL,
            `${producer} hands ${path} a ${field} that did not come from the resolver`,
          )
        }
      }
    }
  }
})

test('the routing rule refuses every way a new provider could bypass the resolver', () => {
  const bypasses = [
    [
      'imports the package directly',
      "import ffmpegStatic from 'ffmpeg-static'\nconst binary = ffmpegStatic\n",
    ],
    [
      'keeps the bare-name fallback',
      "class P { constructor(o) { this.ffmpegPath = o.ffmpegPath || 'ffmpeg' } }\n",
    ],
    [
      'spawns something the resolver never produced',
      "const ffmpegBinary = '/usr/bin/ffmpeg'\nawait execFileAsync(ffmpegBinary, ['-version'])\n",
    ],
    // The two evasions the previous rule let through, measured on this repository:
    // one operator and one field name were the whole of its grip.
    [
      'swaps || for ?? in the bare-name fallback',
      "class P { constructor(o) { this.encoderPath = o.encoderPath ?? 'ffmpeg' }\n"
      + "  async run(i, o) { await execFileAsync(this.encoderPath, ['-y', '-i', i, o]) } }\n",
    ],
    [
      'calls the field something other than ffmpegPath',
      "class P { constructor(o) { this.encoderPath = o.encoderPath ?? process.env.FFMPEG_BIN }\n"
      + "  async run(i, o) { await execFileAsync(this.encoderPath, ['-y', '-i', i, o]) } }\n",
    ],
    [
      'hides the spawn behind its own promisified alias',
      'const go = promisify(execFile)\nconst chosen = process.env.FFMPEG_BIN\n'
      + "await go(chosen, ['-version'])\n",
    ],
    [
      'takes the binary from a caller nobody declared',
      "async function probe(input) { await execFileAsync(input.probePath, ['-version']) }\n",
    ],
    [
      'trusts ffprobe-static without checking it',
      "const ffprobeStatic = require('ffprobe-static')\n"
      + "class P { constructor(o) { this.probe = o.probe || ffprobeStatic.path }\n"
      + "  async run() { execFileSync(this.probe, ['-version']) } }\n",
    ],
    [
      'returns the bare name from a helper',
      "function pick(o) { if (o.path) return o.path\n  return 'ffprobe' }\n"
      + "await execFileAsync(pick({}), ['-version'])\n",
    ],
    [
      'names the resolver in a doc comment and asks something else in code',
      '/** resolveFfmpegBinary( is named here in prose only. */\n'
      + 'class P { constructor(o) { this.tool = o.tool ?? process.env.TOOL }\n'
      + "  async run() { await execFileAsync(this.tool, ['-version']) } }\n",
    ],
  ]
  for (const [what, source] of bypasses) {
    const { violations } = mediaBinaryRoutingViolations(
      new Map([['src/v2/infrastructure/media/new-provider.ts', source]]),
    )
    assert.ok(violations.length > 0, `a provider that ${what} was accepted`)
  }
  // And an honest one passes, so the rule is not simply always red.
  const honest = new Map([[
    'src/v2/infrastructure/media/new-provider.ts',
    "import { resolveFfmpegBinary, resolveFfprobeBinaryPath } from './ffmpeg-binary.ts'\n"
    + "const ffprobeStatic = require('ffprobe-static')\n"
    + 'class P { constructor(o) { this.ffmpegPath = resolveFfmpegBinary(o.ffmpegPath)\n'
    + '    this.probePath = resolveFfprobeBinaryPath(ffprobeStatic?.path, o.probePath) }\n'
    + "  async run() { await execFileAsync(this.ffmpegPath, ['-version'])\n"
    + "    await execFileAsync(this.probePath, ['-version']) } }\n",
  ]])
  assert.deepEqual(mediaBinaryRoutingViolations(honest).violations, [])
})

test('what the deployment named wins, unchecked, in the order the resolver declares', () => {
  const absent = join(tmpdir(), 'apollo-ffmpeg-that-does-not-exist')
  assert.equal(existsSync(absent), false)
  // Unchecked on purpose: suites that point ffmpeg at a binary which cannot
  // encode depend on getting that binary rather than a repaired one.
  assert.equal(resolveFfmpegBinary(absent, {}), absent)

  assert.deepEqual([...FFMPEG_PATH_ENVIRONMENT_VARIABLES], [
    'APOLLO_V2_FFMPEG_PATH', 'FFMPEG_PATH', 'APOLLO_FFMPEG_PATH', 'FFMPEG_BIN',
  ])
  const environment = {
    APOLLO_V2_FFMPEG_PATH: '/first', FFMPEG_PATH: '/second',
    APOLLO_FFMPEG_PATH: '/third', FFMPEG_BIN: '/fourth',
  }
  assert.equal(resolveFfmpegBinary(undefined, environment), '/first')
  assert.equal(resolveFfmpegBinary(undefined, { ...environment, APOLLO_V2_FFMPEG_PATH: '  ' }), '/second')
  assert.equal(resolveFfmpegBinary(undefined, { FFMPEG_BIN: '/fourth' }), '/fourth')
  // A configured path beats every variable.
  assert.equal(resolveFfmpegBinary('/configured', environment), '/configured')
})

test('a bundled path that is not on disk is climbed out of, not returned', (t) => {
  // The production layout, reproduced: a chunk directory deep inside a build,
  // a `ffmpeg.exe` beside it that nobody ever copied, and the installation at
  // the project root where the walk has to reach it.
  const projectRoot = mkdtempSync(join(tmpdir(), 'apollo-bundle-'))
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }))
  const chunks = join(projectRoot, '.next', 'server', 'chunks')
  mkdirSync(chunks, { recursive: true })
  const installed = join(projectRoot, 'node_modules', 'ffmpeg-static')
  mkdirSync(installed, { recursive: true })
  const real = join(installed, `ffmpeg${EXECUTABLE_SUFFIX}`)
  writeFileSync(real, '#!/bin/sh\nexit 0\n')
  chmodSync(real, 0o755)
  const bundled = join(chunks, `ffmpeg${EXECUTABLE_SUFFIX}`)
  assert.equal(existsSync(bundled), false, 'the bundled path must be the absent one')

  const roots = [chunks, join(projectRoot, '.next', 'server'), join(projectRoot, '.next'), projectRoot]
  const resolved = resolveMediaBinary({
    binaryName: 'ffmpeg',
    variables: [...FFMPEG_PATH_ENVIRONMENT_VARIABLES],
    environment: { PATH: '' },
    bundled,
    packagePath: ['ffmpeg-static'],
    roots,
    fallback: null,
  })
  assert.equal(resolved, real)

  // Same walk, with the bundled path correct: it is used as it stands.
  assert.equal(resolveMediaBinary({
    binaryName: 'ffmpeg',
    variables: [...FFMPEG_PATH_ENVIRONMENT_VARIABLES],
    environment: { PATH: '' },
    bundled: real,
    packagePath: ['ffmpeg-static'],
    roots,
    fallback: null,
  }), real)
})

test('PATH is searched before refusing, and named absolutely', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-path-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const onPath = join(directory, `ffmpeg${EXECUTABLE_SUFFIX}`)
  writeFileSync(onPath, '#!/bin/sh\nexit 0\n')
  chmodSync(onPath, 0o755)

  const empty = mkdtempSync(join(tmpdir(), 'apollo-empty-'))
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  const resolved = resolveMediaBinary({
    binaryName: 'ffmpeg',
    variables: [...FFMPEG_PATH_ENVIRONMENT_VARIABLES],
    environment: { PATH: [join(tmpdir(), 'apollo-nothing-here'), directory].join(delimiter) },
    bundled: join(empty, 'ffmpeg'),
    packagePath: ['ffmpeg-static'],
    roots: [empty],
    fallback: null,
  })
  assert.equal(resolved, onPath, 'the entry on PATH was not named absolutely')
})

test('with no binary anywhere the resolver refuses by name instead of guessing', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'apollo-none-'))
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  let refusal = null
  try {
    resolveMediaBinary({
      binaryName: 'ffmpeg',
      variables: [...FFMPEG_PATH_ENVIRONMENT_VARIABLES],
      environment: { PATH: '' },
      bundled: join(empty, 'ffmpeg'),
      packagePath: ['ffmpeg-static'],
      roots: [empty],
      fallback: null,
    })
  } catch (error) {
    refusal = error
  }
  assert.ok(refusal instanceof DomainError, 'a missing ffmpeg was not refused')
  assert.equal(refusal.code, 'PERSISTENCE_NOT_CONFIGURED')
  assert.match(refusal.message, /APOLLO_V2_FFMPEG_PATH/)
  assert.deepEqual(refusal.details.searched, [join(empty, 'node_modules', 'ffmpeg-static')])
  assert.equal(refusal.details.bundled, join(empty, 'ffmpeg'))

  // The same absence with a fallback declared answers instead of refusing —
  // which is what keeps ffprobe's long-standing bare-name behaviour intact.
  assert.equal(resolveMediaBinary({
    binaryName: 'ffprobe',
    variables: ['FFPROBE_PATH'],
    environment: { PATH: '' },
    packagePath: ['ffprobe-static'],
    roots: [empty],
    fallback: 'ffprobe',
  }), 'ffprobe')
})

test('the resolver answers with a binary this machine can actually run', () => {
  const ffmpeg = resolveFfmpegBinary(undefined, {})
  assert.ok(existsSync(ffmpeg), `resolved ffmpeg does not exist: ${ffmpeg}`)
  const version = String(execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', timeout: 30_000 }))
    .split('\n')[0].trim()
  assert.match(version, /^ffmpeg version /)

  const ffprobe = resolveFfprobeBinary(undefined, {})
  assert.ok(existsSync(ffprobe), `resolved ffprobe does not exist: ${ffprobe}`)
  const probeVersion = String(execFileSync(ffprobe, ['-version'], { encoding: 'utf8', timeout: 30_000 }))
    .split('\n')[0].trim()
  assert.match(probeVersion, /^ffprobe version /)
  console.log(`ffmpeg-binary: ${version} at ${ffmpeg}; ${probeVersion} at ${ffprobe}`)
})
