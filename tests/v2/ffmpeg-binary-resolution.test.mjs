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
 * So two kinds of proof live here. The structural one says every ffmpeg spawn
 * in `src/` takes its path from `resolveFfmpegBinary`, and is itself checked
 * against sources that bypass it, because a scanner that matches nothing passes
 * quietly. The behavioural one exercises all four resolution steps, including
 * the one that only matters under a bundle: a directory laid out like
 * `.next/server/chunks`, a bundled path that does not exist, and the walk that
 * climbs out to a real installation.
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

/** The body of `function <name>(` in this source, by brace matching. */
function functionBody(source, name) {
  const declaration = source.indexOf(`function ${name}(`)
  if (declaration < 0) return null
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

/**
 * Every way a file could get an ffmpeg path without asking the resolver.
 *
 * Exported as a function over a source map rather than run inline, so the test
 * below can hand it a file that cheats and watch it complain — the only way to
 * know the rule would catch tomorrow's provider.
 */
function ffmpegRoutingViolations(sources) {
  const violations = []
  const routed = []
  for (const [path, source] of sources) {
    if (path === RESOLVER) continue

    if (/['"]ffmpeg-static['"]/.test(source)) {
      violations.push(`${path}: names ffmpeg-static instead of asking the resolver`)
    }
    if (/\|\|\s*'ffmpeg'/.test(source)) {
      violations.push(`${path}: falls back to the bare name 'ffmpeg', which resolves only on a machine that has one`)
    }

    // Every assignment of an ffmpeg binary path has to come from the resolver.
    for (const match of source.matchAll(/(?:this\.)?\bffmpegPath\s*=(?!=)/g)) {
      const statement = source.slice(match.index, match.index + 240)
      if (!statement.includes('resolveFfmpegBinary(')) {
        violations.push(`${path}: assigns an ffmpegPath that did not come from resolveFfmpegBinary`)
      }
    }

    // And every spawn whose binary argument mentions ffmpeg has to name either
    // the resolver, a verified field, or a local helper that calls it.
    const spawns = source.matchAll(/\b(?:execFileAsync|execFileSync|execFile|spawnSync|spawn)\(\s*([^,]+),/g)
    for (const spawn of spawns) {
      const binary = spawn[1].trim()
      if (!/ffmpeg/i.test(binary) || /ffprobe/i.test(binary)) continue
      if (binary.includes('resolveFfmpegBinary(')) {
        routed.push(path)
        continue
      }
      if (/^(?:this\.)?ffmpegPath$/.test(binary)) {
        if (!source.includes('resolveFfmpegBinary(')) {
          violations.push(`${path}: spawns ${binary} in a file that never calls resolveFfmpegBinary`)
        } else routed.push(path)
        continue
      }
      const helper = /^([A-Za-z_$][\w$]*)\(/.exec(binary)
      const body = helper ? functionBody(source, helper[1]) : null
      if (body && body.includes('resolveFfmpegBinary(')) {
        routed.push(path)
        continue
      }
      violations.push(`${path}: spawns ffmpeg as ${JSON.stringify(binary)}, which the resolver never produced`)
    }
  }
  return { violations, routed: [...new Set(routed)] }
}

test('every ffmpeg spawn in src/ takes its path from the resolver', () => {
  const sources = repositorySources()
  const { violations, routed } = ffmpegRoutingViolations(sources)
  assert.deepEqual(violations, [], violations.join('\n'))

  // A scanner that found nothing would also report no violations, so the
  // providers it did verify are counted and named.
  assert.ok(routed.length >= 12, `only ${routed.length} spawn sites were verified`)
  for (const expected of [
    'src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts',
    'src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts',
    'src/v2/infrastructure/media/ffmpeg-playback-fingerprint.ts',
    'src/v2/infrastructure/analysis/ffmpeg-multicam-visual-evidence-provider.ts',
    'src/v2/infrastructure/transformation/ffmpeg-transformation-critic.ts',
  ]) {
    assert.ok(routed.includes(expected), `${expected} was not seen spawning ffmpeg at all`)
  }

  // And the resolver is the one module allowed to name the package.
  const naming = [...sources].filter(([, source]) => /['"]ffmpeg-static['"]/.test(source)).map(([path]) => path)
  assert.deepEqual(naming, [RESOLVER])
})

test('the routing rule refuses the three ways a new provider could bypass the resolver', () => {
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
  ]
  for (const [what, source] of bypasses) {
    const { violations } = ffmpegRoutingViolations(new Map([['src/v2/infrastructure/media/new-provider.ts', source]]))
    assert.ok(violations.length > 0, `a provider that ${what} was accepted`)
  }
  // And an honest one passes, so the rule is not simply always red.
  const honest = new Map([[
    'src/v2/infrastructure/media/new-provider.ts',
    "import { resolveFfmpegBinary } from './ffmpeg-binary.ts'\n"
    + 'class P { constructor(o) { this.ffmpegPath = resolveFfmpegBinary(o.ffmpegPath) }\n'
    + "  async run() { await execFileAsync(this.ffmpegPath, ['-version']) } }\n",
  ]])
  assert.deepEqual(ffmpegRoutingViolations(honest).violations, [])
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
