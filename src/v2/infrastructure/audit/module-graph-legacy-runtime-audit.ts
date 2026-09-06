import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { LegacyRuntimeAuditPort } from '../../application/ports/multicam-longform-gate-repository.ts'
import {
  calculateLegacyRuntimeAuditHash,
  type LegacyRuntimeAuditResult,
  type LegacyRuntimeAuditViolation,
} from '../../domain/multicam-longform-gate.ts'

/**
 * Criterion 10 of the F4.016 gate: prove the code behind the other nine
 * imports no legacy runtime.
 *
 * `scripts/lint-architecture.mjs` already refuses these imports at CI time.
 * That is a gate on the change, not on the release, and AGENTS.md L152 asks
 * for a check that the phase gate itself can point at. So this walks the
 * static import graph from the application services the gate reads through and
 * reports what it found, with a hash over the finding so the answer is
 * evidence rather than a claim.
 *
 * It is deliberately a denylist. An allowlist over every npm specifier the
 * product legitimately uses would be a second package.json that drifts, and a
 * drifted allowlist fails the gate for the wrong reason.
 */

/**
 * The root the scan reads its sources from.
 *
 * Resolved when the audit runs, never when it is compiled. It used to be
 * `resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')`, and inside
 * `next build` webpack replaces `import.meta.url` with the absolute path of the
 * source file **on the build machine**. The bundled server therefore carried a
 * frozen root: run the built app from any other directory and all ten entry
 * modules were unreadable, which the scanner then published as ten
 * `legacy-runtime-import` violations naming pure-V2 modules — an accusation it
 * never measured. `process.cwd()` is what a Next server, `npm test` and the
 * scripts all run from, and a caller that knows better passes `repositoryRoot`.
 *
 * (The earlier `new URL('../../../../', import.meta.url)` failed differently
 * and even louder: webpack treats that exact pattern as an asset reference and
 * `next build` broke with "Can't resolve '../../../../'" for every `/v1` route.
 * Neither spelling of `import.meta.url` belongs in this module.)
 */
function defaultRepositoryRoot(): string {
  return process.cwd()
}

const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'] as const
const MAX_MODULES = 4000
const SELF_MODULE =
  'src/v2/infrastructure/audit/module-graph-legacy-runtime-audit.ts'

/** The modules every gate criterion's evidence is read through. */
export const GATE_RUNTIME_ENTRY_MODULES = Object.freeze([
  'src/v2/application/multicam-longform-gate.ts',
  'src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts',
  'src/v2/application/multicam-direction.ts',
  'src/v2/application/multicam-color-match.ts',
  'src/v2/application/color-critic.ts',
  'src/v2/application/react-playback-map.ts',
  'src/v2/application/editorial-synthesis.ts',
  'src/v2/application/sync-diagnostic.ts',
  'src/v2/application/capture-session.ts',
  'src/v2/application/capture-protocol.ts',
])

const STATIC_IMPORT = /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g

function normalize(value: string): string {
  return value.split(sep).join('/')
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/**
 * Resolve the specifier the way the TypeScript sources are written: they carry
 * explicit `.ts` extensions, so a resolver that guesses is only needed for the
 * `.mjs` helpers a few modules pull in.
 */
async function resolveModule(
  root: string,
  from: string,
  specifier: string,
): Promise<string | null> {
  const base = specifier.startsWith('@/')
    ? join(root, 'src', specifier.slice(2))
    : resolve(dirname(from), specifier)
  for (const candidate of [base, ...EXTENSIONS.map((extension) => `${base}${extension}`)]) {
    try {
      await readFile(candidate, 'utf8')
      return candidate
    } catch {
      continue
    }
  }
  return null
}

function classify(
  root: string,
  from: string,
  specifier: string,
): LegacyRuntimeAuditViolation['marker'] | null {
  if (specifier.startsWith('@/lib/') || specifier === '@/lib') {
    return 'legacy-runtime-import'
  }
  if (isRelative(specifier)) {
    const legacyRoot = join(root, 'src', 'lib')
    const target = resolve(dirname(from), specifier)
    if (target === legacyRoot || target.startsWith(`${legacyRoot}${sep}`)) {
      return 'legacy-runtime-import'
    }
  }
  if (specifier === '@prisma/client' || specifier.startsWith('@prisma/client/')) {
    return 'legacy-prisma-client'
  }
  if (/(^|[/@])(better-)?sqlite3?($|[/-])/.test(specifier)) {
    return 'sqlite-persistence'
  }
  if (/\/api\/process(\/|$)|routes\/api\/process/.test(specifier)) {
    return 'legacy-process-route'
  }
  if (/dual-write|dualWrite|compat(ibility)?-layer/.test(specifier)) {
    return 'dual-write-compatibility'
  }
  return null
}

/**
 * Markers that live in a module's text rather than in a specifier: the retired
 * narrative engine was reachable by name and not only by import, and a graph
 * walk that only read `from '...'` would call a file clean while it called
 * `analyzeContent()`.
 *
 * `editPlanJson` is deliberately not a marker, and the first run of this
 * scanner is why. It names a retired `Project` column, but Wave 18 also gave
 * `editorial_syntheses` a column of that name, so matching the identifier
 * flagged `apply-editorial-cut-command.ts` and `editorial-synthesis-repository.ts`
 * — both entirely V2. A marker that fires on the new model is worse than no
 * marker: it teaches the reader to ignore the criterion. `scenesJson` has no
 * V2 namesake and stays.
 */
const TEXT_MARKERS: readonly Readonly<{
  marker: LegacyRuntimeAuditViolation['marker']
  pattern: RegExp
  label: string
}>[] = Object.freeze([
  {
    marker: 'legacy-process-route',
    pattern: /\bnarrativeEngine\b|\banalyzeContent\s*\(/,
    label: 'retired narrative engine',
  },
  {
    marker: 'dual-write-compatibility',
    pattern: /\bscenesJson\b/,
    label: 'retired scenesJson column',
  },
])

export class ModuleGraphLegacyRuntimeAudit implements LegacyRuntimeAuditPort {
  private readonly entryModules: readonly string[]
  private readonly repositoryRoot: string
  private readonly clock: () => Date

  constructor(options?: {
    entryModules?: readonly string[]
    /** Where the sources are, resolved by the caller at run time. */
    repositoryRoot?: string
    clock?: () => Date
  }) {
    this.entryModules = options?.entryModules ?? GATE_RUNTIME_ENTRY_MODULES
    this.repositoryRoot = resolve(options?.repositoryRoot ?? defaultRepositoryRoot())
    this.clock = options?.clock ?? (() => new Date())
  }

  async audit(): Promise<Readonly<LegacyRuntimeAuditResult>> {
    const root = this.repositoryRoot
    const v2Root = join(root, 'src', 'v2')
    const queue: string[] = []
    const seen = new Set<string>()
    const violations: LegacyRuntimeAuditViolation[] = []
    const unreadableEntryModules: string[] = []

    for (const entry of this.entryModules) {
      const absolute = join(root, entry)
      try {
        await readFile(absolute, 'utf8')
        if (!seen.has(absolute)) {
          seen.add(absolute)
          queue.push(absolute)
        }
      } catch {
        unreadableEntryModules.push(entry)
      }
    }

    while (queue.length > 0 && seen.size <= MAX_MODULES) {
      const current = queue.shift()
      if (!current) break
      let source: string
      try {
        source = await readFile(current, 'utf8')
      } catch {
        continue
      }
      const modulePath = normalize(relative(root, current))
      // This module spells every marker out in order to look for them, so
      // scanning it would report itself. Excluding it by path is honest;
      // obfuscating the patterns so they miss their own source would not be.
      for (const text of modulePath === SELF_MODULE ? [] : TEXT_MARKERS) {
        if (text.pattern.test(source)) {
          violations.push({ marker: text.marker, module: modulePath, specifier: text.label })
        }
      }
      for (const match of source.matchAll(STATIC_IMPORT)) {
        const specifier = match[2]
        if (!specifier) continue
        const marker = classify(root, current, specifier)
        if (marker) violations.push({ marker, module: modulePath, specifier })
        if (!isRelative(specifier) && !specifier.startsWith('@/')) continue
        const resolved = await resolveModule(root, current, specifier)
        // Only the product's own V2 tree is walked. The graph beyond it is
        // node_modules and generated clients, whose contents are not what
        // "no legacy runtime" is about, and following them would turn a gate
        // criterion into a dependency audit.
        if (!resolved || seen.has(resolved)) continue
        if (resolved !== v2Root && !resolved.startsWith(`${v2Root}${sep}`)) continue
        seen.add(resolved)
        queue.push(resolved)
      }
    }

    // A named entry module the scanner could not read is reported as exactly
    // that, and never as a legacy import. It used to be pushed in as a
    // `legacy-runtime-import` violation, which made a root the process cannot
    // read — a relocated build, a standalone bundle with no sources beside it —
    // publish ten accusations against modules nobody looked at. Not reading a
    // file is missing evidence for the whole criterion; the domain turns this
    // list into `evidence-missing` on all three checks.
    const body = {
      schemaVersion: 'legacy-runtime-audit/v1' as const,
      entryModules: Object.freeze([...this.entryModules]),
      unreadableEntryModules: Object.freeze([...unreadableEntryModules].sort()),
      scannedModuleCount: seen.size,
      violations: Object.freeze(
        violations
          .map((violation) => Object.freeze({ ...violation }))
          .sort((left, right) =>
            `${left.module}:${left.marker}`.localeCompare(`${right.module}:${right.marker}`)),
      ),
      scannedAt: this.clock().toISOString(),
    }
    return Object.freeze({
      ...body,
      auditHash: calculateLegacyRuntimeAuditHash(body),
    })
  }
}
