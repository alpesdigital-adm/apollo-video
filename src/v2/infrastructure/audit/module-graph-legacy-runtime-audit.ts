import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * The repository root, resolved from this file rather than from `cwd`.
 *
 * Not `new URL('../../../../', import.meta.url)`, which is what this was: that
 * exact pattern is the one webpack treats as an asset reference, so it tried to
 * resolve the repository root as a module and `next build` failed with
 * "Can't resolve '../../../../'" for every `/v1` route, because they all reach
 * this module through `repository-factory`. `createRequire(import.meta.url)`
 * elsewhere in `infrastructure/` builds fine; it is `new URL` plus a literal
 * that webpack intercepts. Splitting the two keeps the same path at runtime and
 * leaves webpack nothing to resolve.
 */
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const V2_ROOT = join(REPOSITORY_ROOT, 'src', 'v2')
const LEGACY_RUNTIME_ROOT = join(REPOSITORY_ROOT, 'src', 'lib')
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
async function resolveModule(from: string, specifier: string): Promise<string | null> {
  const base = specifier.startsWith('@/')
    ? join(REPOSITORY_ROOT, 'src', specifier.slice(2))
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
  from: string,
  specifier: string,
): LegacyRuntimeAuditViolation['marker'] | null {
  if (specifier.startsWith('@/lib/') || specifier === '@/lib') {
    return 'legacy-runtime-import'
  }
  if (isRelative(specifier)) {
    const target = resolve(dirname(from), specifier)
    if (target === LEGACY_RUNTIME_ROOT || target.startsWith(`${LEGACY_RUNTIME_ROOT}${sep}`)) {
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
  private readonly clock: () => Date

  constructor(options?: {
    entryModules?: readonly string[]
    clock?: () => Date
  }) {
    this.entryModules = options?.entryModules ?? GATE_RUNTIME_ENTRY_MODULES
    this.clock = options?.clock ?? (() => new Date())
  }

  async audit(): Promise<Readonly<LegacyRuntimeAuditResult>> {
    const queue: string[] = []
    const seen = new Set<string>()
    const violations: LegacyRuntimeAuditViolation[] = []
    const missingEntries: string[] = []

    for (const entry of this.entryModules) {
      const absolute = join(REPOSITORY_ROOT, entry)
      try {
        await readFile(absolute, 'utf8')
        if (!seen.has(absolute)) {
          seen.add(absolute)
          queue.push(absolute)
        }
      } catch {
        missingEntries.push(entry)
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
      const modulePath = normalize(relative(REPOSITORY_ROOT, current))
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
        const marker = classify(current, specifier)
        if (marker) violations.push({ marker, module: modulePath, specifier })
        if (!isRelative(specifier) && !specifier.startsWith('@/')) continue
        const resolved = await resolveModule(current, specifier)
        // Only the product's own V2 tree is walked. The graph beyond it is
        // node_modules and generated clients, whose contents are not what
        // "no legacy runtime" is about, and following them would turn a gate
        // criterion into a dependency audit.
        if (!resolved || seen.has(resolved)) continue
        if (resolved !== V2_ROOT && !resolved.startsWith(`${V2_ROOT}${sep}`)) continue
        seen.add(resolved)
        queue.push(resolved)
      }
    }

    // A named entry module that does not exist is not a clean scan: the check
    // that was meant to cover it never ran. It is reported as a violation of
    // the marker whose absence it can no longer prove.
    for (const entry of missingEntries) {
      violations.push({
        marker: 'legacy-runtime-import',
        module: entry,
        specifier: null,
      })
    }

    const body = {
      schemaVersion: 'legacy-runtime-audit/v1' as const,
      entryModules: Object.freeze([...this.entryModules]),
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
