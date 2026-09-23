import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { SyntheticBuildAttestationRunner } from '../application/ports/synthetic-build-attestation-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { SYNTHETIC_BUILD_CHECKS } from '../domain/synthetic-build-attestation.ts'

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface CommandExecutor {
  execute(
    executable: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<Readonly<CommandResult>>
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const CHECK_TIMEOUT_MS = 5 * 60 * 1000

class ProcessCommandExecutor implements CommandExecutor {
  private readonly cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  private async terminateTree(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      })
      await new Promise<void>((resolve) => {
        killer.once('error', () => resolve())
        killer.once('close', () => resolve())
      })
      return
    }
    try { process.kill(-child.pid, 'SIGTERM') } catch { return }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (child.exitCode === null && !child.signalCode) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { return }
    }
  }

  async execute(
    executable: string,
    args: readonly string[],
    options: { signal?: AbortSignal } = {},
  ) {
    if (options.signal?.aborted) throw new Error('Build attestation command was aborted')
    const child = spawn(executable, [...args], {
      cwd: this.cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let terminalError: Error | null = null
    let timedOut = false
    let aborted = false
    let termination: Promise<void> | null = null
    const terminate = () => {
      termination ??= this.terminateTree(child)
      return termination
    }
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminalError = new Error('Build attestation command exceeded its bounded output')
        void terminate()
        return
      }
      target.push(chunk)
    }
    child.stdout!.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr!.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.on('error', (error) => { terminalError = error })
    const abort = () => { aborted = true; void terminate() }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      void terminate()
    }, CHECK_TIMEOUT_MS)
    timeout.unref()
    const code = await new Promise<number | null>((resolve) => {
      child.once('close', (exitCode) => resolve(exitCode))
    })
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    if (termination) await termination
    if (aborted) throw new Error('Build attestation command was aborted')
    if (timedOut) throw new Error('Build attestation command timed out')
    if (terminalError) throw terminalError
    return Object.freeze({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    })
  }
}

function digestLog(result: Readonly<CommandResult>): string {
  return createHash('sha256')
    .update(`exit=${result.exitCode}\nstdout-bytes=${Buffer.byteLength(result.stdout)}\n`)
    .update(result.stdout)
    .update(`\nstderr-bytes=${Buffer.byteLength(result.stderr)}\n`)
    .update(result.stderr)
    .digest('hex')
}

const CHECK_COMMANDS = Object.freeze({
  architecture: Object.freeze([process.execPath, ['scripts/lint-architecture.mjs']] as const),
  'domain-language': Object.freeze([process.execPath, ['scripts/lint-domain-language.mjs']] as const),
  'provider-swap': Object.freeze([
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', 'tests/v2/synthetic-provider-swap.test.mjs'],
  ] as const),
  'compiler-render-contracts': Object.freeze([
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', 'tests/v2/synthetic-production.test.mjs'],
  ] as const),
})

export class NodeSyntheticBuildAttestationRunner
implements SyntheticBuildAttestationRunner {
  private readonly executor: CommandExecutor
  private readonly clock: () => Date
  private readonly cwd: string

  constructor(input: {
    cwd: string
    executor?: CommandExecutor
    clock?: () => Date
  }) {
    this.cwd = input.cwd
    this.executor = input.executor ?? new ProcessCommandExecutor(input.cwd)
    this.clock = input.clock ?? (() => new Date())
  }

  private async renderBundleHash() {
    const root = join(this.cwd, 'remotion', 'build')
    const files: string[] = []
    const visit = async (directory: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Build attestation requires the materialized Remotion bundle',
        )
      }
      for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile()) files.push(path)
        else {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Remotion bundle contains an unsupported or linked entry',
          )
        }
      }
    }
    await visit(root)
    if (files.length === 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Remotion bundle is empty')
    }
    const digest = createHash('sha256')
    for (const path of files) {
      const content = await readFile(path)
      digest.update(relative(root, path).replaceAll('\\', '/'))
      digest.update('\0')
      digest.update(String(content.byteLength))
      digest.update('\0')
      digest.update(createHash('sha256').update(content).digest('hex'))
      digest.update('\n')
    }
    return digest.digest('hex')
  }

  private async git(args: readonly string[], signal?: AbortSignal) {
    const result = await this.executor.execute('git', args, { signal })
    if (result.exitCode !== 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Build attestation could not inspect Git state')
    }
    return result.stdout.trim()
  }

  private async inspectIdentity(signal?: AbortSignal) {
    const tasks = await Promise.allSettled([
      this.git(['rev-parse', 'HEAD'], signal),
      this.git(['status', '--porcelain=v1', '--untracked-files=all'], signal),
      this.git([
        'ls-files', '-s', '--',
        'src/v2/domain',
        'src/v2/application',
        'src/v2/public-api',
        'src/v2/infrastructure/remotion-render-input-renderer.ts',
        'remotion/src',
        'remotion/scripts/render-materialized.mjs',
        'tests/v2/synthetic-provider-swap.test.mjs',
        'tests/v2/synthetic-production.test.mjs',
      ], signal),
      this.git(['ls-files', '-s'], signal),
      this.renderBundleHash(),
      readFile(join(this.cwd, 'package.json')),
      readFile(join(this.cwd, 'package-lock.json')),
    ])
    const failure = tasks.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    const [commitSha, status, trackedGraph, wholeTree, renderBundleHash, packageJson, packageLock] =
      tasks.map((result) => (result as PromiseFulfilledResult<unknown>).value) as
        [string, string, string, string, string, Buffer, Buffer]
    if (status.length > 0) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Build attestation requires a clean tracked and untracked worktree',
      )
    }
    return Object.freeze({
      commitSha,
      treeHash: createHash('sha256').update(wholeTree).digest('hex'),
      contractGraphHash: createHash('sha256').update(trackedGraph).digest('hex'),
      toolchainHash: calculateCanonicalHash({
        node: process.version,
        versions: process.versions,
        packageJsonHash: createHash('sha256').update(packageJson).digest('hex'),
        packageLockHash: createHash('sha256').update(packageLock).digest('hex'),
      }),
      renderBundleHash,
    })
  }

  async run(input: { signal?: AbortSignal } = {}) {
    const startedAt = this.clock().toISOString()
    const before = await this.inspectIdentity(input.signal)
    const checks = []
    for (const definition of SYNTHETIC_BUILD_CHECKS) {
      const command = CHECK_COMMANDS[definition.code]
      const checkStartedAt = this.clock().toISOString()
      const result = await this.executor.execute(command[0], command[1], { signal: input.signal })
      const checkCompletedAt = this.clock().toISOString()
      checks.push(Object.freeze({
        code: definition.code,
        command: definition.command,
        exitCode: result.exitCode,
        logHash: digestLog(result),
        startedAt: checkStartedAt,
        completedAt: checkCompletedAt,
      }))
      if (result.exitCode !== 0) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          `Build attestation check ${definition.code} failed`,
        )
      }
    }
    const after = await this.inspectIdentity(input.signal)
    if (
      before.commitSha !== after.commitSha ||
      before.treeHash !== after.treeHash ||
      before.contractGraphHash !== after.contractGraphHash ||
      before.toolchainHash !== after.toolchainHash ||
      before.renderBundleHash !== after.renderBundleHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Build identity changed while attestation checks were running',
      )
    }
    return Object.freeze({
      identity: before,
      checks: Object.freeze(checks),
      startedAt,
      completedAt: this.clock().toISOString(),
    })
  }
}
