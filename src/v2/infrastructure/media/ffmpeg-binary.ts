import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ffmpegStatic from 'ffmpeg-static'

import { DomainError } from '../../domain/errors.ts'

/**
 * Where ffmpeg is — resolved so that it survives a production build.
 *
 * `ffmpeg-static` computes its answer as `path.join(__dirname, 'ffmpeg.exe')`.
 * That is right when the module is loaded from `node_modules`, and wrong the
 * moment a bundler rewrites `__dirname`: under `next build` the module lands in
 * `.next/server/chunks`, so every provider in the built server points at
 * `.next/server/chunks/ffmpeg.exe`, which does not exist. Nothing said so. The
 * spawn failed, the provider reported a render that could not be executed, and
 * the public envelope answered 422 RENDER_EXECUTION_FAILED — a sentence about
 * the render, for a fault in the deployment. Wave 20's browser E2E only got
 * past it by naming `FFMPEG_BIN` in the server's environment, which fixes one
 * test and no deployment.
 *
 * So the path is decided here, once, in four steps:
 *
 * 1. **What the deployment said**, verbatim — a constructor option first, then
 *    `APOLLO_V2_FFMPEG_PATH`, `FFMPEG_PATH`, `APOLLO_FFMPEG_PATH`, `FFMPEG_BIN`
 *    (ffmpeg-static's own override). Taken unchecked and on purpose: an
 *    operator who names a path is entitled to the spawn error for that path,
 *    and suites that point ffmpeg at `process.execPath` to watch a provider
 *    fail depend on exactly that.
 * 2. **The bundled binary, if it is on disk.** `ffmpeg-static`'s answer is
 *    correct outside a bundle and checkable inside one, so it is checked
 *    instead of trusted.
 * 3. **A resolution that survives bundling.** `node_modules/ffmpeg-static/…`
 *    is searched from the working directory and from this module's own
 *    location, walking up ancestors the way Node's own resolution does. From
 *    `.next/server/chunks` that walk reaches the installation at the project
 *    root; from `src/v2/infrastructure/media` it reaches the same place.
 * 4. **`PATH`.** A container that installed ffmpeg with its package manager has
 *    a real binary and no `node_modules`; the old code covered that case by
 *    returning the bare name `'ffmpeg'` and hoping. Here the entry is found on
 *    `PATH` and named absolutely, or it is not found at all.
 *
 * And when none of the four finds anything, it refuses by name — with the
 * variable to set and the directories that were searched — rather than handing
 * back a string that will fail later as somebody else's error.
 *
 * The refusal is `PERSISTENCE_NOT_CONFIGURED`: 503, and no longer retryable,
 * because a machine with no ffmpeg installed still has none on the retry.
 * `details.binary` and `details.variables` reach the caller through the
 * presenter, so the answer names the executable that is missing and the
 * variable that would point at it; `details.searched` stays in the server,
 * where directory listings belong. The first version of this repair answered a
 * generic "The request could not be completed" with `retryable: true` and
 * dropped all of that.
 */

/** Every environment variable that may name the binary, in the order they win. */
export const FFMPEG_PATH_ENVIRONMENT_VARIABLES = Object.freeze([
  'APOLLO_V2_FFMPEG_PATH',
  'FFMPEG_PATH',
  'APOLLO_FFMPEG_PATH',
  // ffmpeg-static reads this one itself, so a deployment that sets it is
  // already served by step 2 — it is listed so the order is stated rather than
  // inherited from a dependency.
  'FFMPEG_BIN',
] as const)

const EXECUTABLE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
  } catch {
    return false
  }
  if (process.platform === 'win32') return true
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A directory and every ancestor of it, nearest first. */
function ancestors(from: string): readonly string[] {
  const directories: string[] = []
  let current = from
  for (;;) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories
}

/**
 * The directories a `node_modules` lookup should start from.
 *
 * Two of them, because the two failure modes are different: a bundled server
 * runs from the project root but is *loaded* from `.next/server/chunks`, and a
 * worker started somewhere else is loaded from `src` but may run from
 * anywhere. Under a bundler `import.meta.url` may not be a file URL at all,
 * which is why it is read defensively.
 *
 * The working directory leads, and that ordering is measured rather than
 * assumed: in this repository's own `next build` output webpack froze
 * `import.meta.url` into the chunk as the build machine's source path
 * (`file:///…/src/v2/infrastructure/media/ffmpeg-binary.ts`), which on a
 * deployed machine names a directory that does not exist. `process.cwd()` is
 * the one root that is still true wherever the server is running.
 */
function searchRoots(): readonly string[] {
  const roots: string[] = [process.cwd()]
  try {
    roots.push(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // Not a file URL under this bundler; the working directory still is one.
  }
  const seen = new Set<string>()
  const unique: string[] = []
  for (const directory of roots.flatMap((root) => ancestors(root))) {
    if (seen.has(directory)) continue
    seen.add(directory)
    unique.push(directory)
  }
  return unique
}

/** `node_modules/<packagePath>` under any ancestor of the given roots. */
function findInInstalledPackages(
  packagePath: readonly string[],
  roots: readonly string[],
): string | null {
  for (const directory of roots) {
    const candidate = join(directory, 'node_modules', ...packagePath)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/** The first entry on `PATH` that is a real executable with this name. */
function findOnPath(binaryName: string, environment: NodeJS.ProcessEnv): string | null {
  const entries = environment.PATH ?? environment.Path ?? environment.path ?? ''
  for (const directory of entries.split(delimiter)) {
    const trimmed = directory.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    const candidate = join(trimmed, binaryName)
    if (isAbsolute(candidate) && isExecutableFile(candidate)) return candidate
  }
  return null
}

function firstDeclared(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
  variables: readonly string[],
): string | null {
  const explicit = configured?.trim()
  if (explicit) return explicit
  for (const variable of variables) {
    const value = environment[variable]?.trim()
    if (value) return value
  }
  return null
}

export interface MediaBinaryResolution {
  /** `ffmpeg` or `ffprobe`; the platform's executable suffix is added here. */
  readonly binaryName: string
  /** Environment variables that may name it, in the order they win. */
  readonly variables: readonly string[]
  /** A path the caller was configured with, which beats every variable. */
  readonly configured?: string | undefined
  readonly environment: NodeJS.ProcessEnv
  /** What the `*-static` package answered — trusted only if it is on disk. */
  readonly bundled?: string | undefined
  /** The path inside `node_modules` that holds the executable. */
  readonly packagePath: readonly string[]
  /** Where the `node_modules` walk starts; defaults to cwd and this module. */
  readonly roots?: readonly string[] | undefined
  /** What to answer when nothing is found; `null` refuses instead. */
  readonly fallback?: string | null | undefined
}

/**
 * The four steps, once, for both binaries.
 *
 * Taking the roots as an argument is what makes the bundled case testable
 * without a production build: a test can point the walk at a directory laid out
 * like `.next/server/chunks` and watch it climb to a real installation, which
 * is precisely what the defect needed and what no unit test could otherwise
 * reach.
 */
export function resolveMediaBinary(input: MediaBinaryResolution): string {
  const declared = firstDeclared(input.configured, input.environment, input.variables)
  if (declared) return declared

  const fileName = `${input.binaryName}${EXECUTABLE_SUFFIX}`
  const bundled = input.bundled?.trim() ?? ''
  if (bundled && isExecutableFile(bundled)) return bundled

  const roots = input.roots ?? searchRoots()
  const installed = findInInstalledPackages([...input.packagePath, fileName], roots)
  if (installed) return installed

  const onPath = findOnPath(fileName, input.environment)
  if (onPath) return onPath

  const fallback = input.fallback ?? null
  if (fallback !== null) return fallback
  throw new DomainError(
    'PERSISTENCE_NOT_CONFIGURED',
    `No ${input.binaryName} binary could be found. Set ${input.variables[0]} to the executable, `
    + `or install ${input.packagePath[0]} where the server can reach it.`,
    {
      binary: input.binaryName,
      variables: [...input.variables],
      bundled: bundled || null,
      searched: roots.map((directory) => join(directory, 'node_modules', ...input.packagePath)),
    },
  )
}

/**
 * The ffmpeg binary this process should spawn.
 *
 * Every ffmpeg spawn site in `src/` goes through here — a rule the structural
 * test `ffmpeg-binary-resolution.test.mjs` enforces, because the defect this
 * function exists for is invisible until a production build runs, and a new
 * provider that imports `ffmpeg-static` directly would bring it straight back.
 *
 * @throws DomainError `PERSISTENCE_NOT_CONFIGURED` when no binary exists.
 */
export function resolveFfmpegBinary(
  configured?: string,
  environment: NodeJS.ProcessEnv = process.env,
  roots?: readonly string[],
): string {
  return resolveMediaBinary({
    binaryName: 'ffmpeg',
    variables: FFMPEG_PATH_ENVIRONMENT_VARIABLES,
    configured,
    environment,
    bundled: typeof ffmpegStatic === 'string' ? ffmpegStatic : undefined,
    packagePath: ['ffmpeg-static'],
    roots,
    fallback: null,
  })
}

/**
 * The ffprobe binary, with the same bundling repair.
 *
 * `resolveFfprobeBinary` already handled the case ffprobe-static was added for
 * — a bare `'ffprobe'` resolves only on a machine that happens to have one —
 * but it trusted `ffprobe-static`'s path without checking it, so it carries the
 * identical bundling defect: inside `.next/server/chunks` that path names a
 * `bin/win32/x64/ffprobe.exe` that was never copied there. Found while fixing
 * ffmpeg; repaired here so both binaries are resolved the same way. The bare
 * name stays as the last resort, because that is the behaviour every existing
 * caller was written against.
 */
export const FFPROBE_PATH_ENVIRONMENT_VARIABLES = Object.freeze([
  'APOLLO_V2_FFPROBE_PATH',
  'FFPROBE_PATH',
] as const)

export function resolveFfprobeBinaryPath(
  bundledPath: string | undefined,
  configured: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  roots?: readonly string[],
  /**
   * `undefined` keeps the historical bare-name last resort; `null` refuses.
   *
   * Composition roots that used to refuse an unresolvable ffprobe themselves
   * pass `null`, so the repair does not quietly turn one of their refusals into
   * a guess that fails later as somebody else's error.
   */
  fallback?: string | null,
): string {
  return resolveMediaBinary({
    binaryName: 'ffprobe',
    variables: FFPROBE_PATH_ENVIRONMENT_VARIABLES,
    configured,
    environment,
    bundled: bundledPath,
    packagePath: ['ffprobe-static', 'bin', process.platform, process.arch],
    roots,
    // The bare name, still, and only here: every caller of this function was
    // written against a resolver that never threw, and turning a probe into a
    // refusal is a behaviour change this fix did not measure.
    fallback: fallback === undefined ? bundledPath?.trim() || 'ffprobe' : fallback,
  })
}
