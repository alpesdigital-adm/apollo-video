import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Editorial literals guard (ADR-160, docs/specs/01 s7.4.5). "Nothing is fixed, everything comes from the request of each video": an
 * editorial value (zoom off, a 4 s opening, a 32/42-character caption block, a caption preset, a role by position, a layout, a locale,
 * a pre-selected objective, a placeholder sentence) may not sit in the product as a literal. The one module allowed to name such a
 * value is the policy resolution, where each rule is named and tested (tests/v2/editorial-policy-resolution.test.mjs).
 *
 * The product still carries literals from before the rule. They are listed in BASELINE, as `file :: pattern = count`, and the list can
 * only shrink: a literal that is not in it fails this test, and so does an entry whose count is no longer what the scan finds - the slice
 * that fixes a literal removes (or lowers) its entry in the same commit. When the baseline is empty the rule is fully in force.
 */
const root = fileURLToPath(new URL('../../', import.meta.url))
const PRODUCT_ROOTS = ['src', 'remotion', 'scripts', 'config']
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'generated', 'dist', 'build', 'out', '.git', '.apollo'])

/** The modules where a rule may name an editorial value: the resolution (every rule named and tested), and nothing else. */
const RESOLUTION_MODULES = Object.freeze([
  'src/v2/domain/editorial-policy-resolution.ts',
  'src/v2/domain/editorial-request.ts',
])

/**
 * `id` is the label the baseline uses. Two patterns are narrower than the words of the design on purpose:
 *  - 'workspace-default' only as a list of one (`['workspace-default']`, the Lotes audience default); the subtitle and LUT selection
 *    MODES that spell the same word are values a requester names explicitly, which is a request, not a default;
 *  - 'discovery' only as the initial value of a state hook or the objective setter (`useState<...>('discovery')`, `setObjective('discovery')`),
 *    never as an analysis tag.
 */
const PATTERNS = Object.freeze([
  { id: "automaticZoom: false", regex: /automaticZoom: false/ },
  { id: "fps * 4", regex: /fps \* 4\b/ },
  { id: "'landscape-inset' as const", regex: /'landscape-inset' as const/ },
  { id: "maxCharactersPerBlock: <digit>", regex: /maxCharactersPerBlock: \d/ },
  { id: "track-captions-pt-br", regex: /track-captions-pt-br/ },
  { id: "presetId: 'clean-color'", regex: /presetId: 'clean-color'/ },
  { id: "index === 0 ? 'hook'", regex: /index === 0 \? 'hook'/ },
  { id: "['workspace-default'] (list of one)", regex: /\[\s*'workspace-default'\s*\]/ },
  { id: 'placeholder="Ex.', regex: /placeholder="Ex\./ },
  { id: "('discovery') as an initial objective", regex: /(?:useState<[^>]*>|setObjective)\('discovery'\)/ },
  { id: "?? 'pt-BR'", regex: /\?\? 'pt-BR'/ },
])

/**
 * Violations that existed when the rule was adopted, by `file :: pattern`. Only ever lower a count or delete an entry.
 * (Never add one: fix the literal, or move the rule into the resolution module.)
 */
const BASELINE = Object.freeze({
  "src/app/ProjectsPageClient.tsx :: ('discovery') as an initial objective": 2,
  "src/app/ProjectsPageClient.tsx :: ?? 'pt-BR'": 1,
  "src/app/ProjectsPageClient.tsx :: placeholder=\"Ex.": 3,
  "src/app/batches/page.tsx :: ['workspace-default'] (list of one)": 1,
  "src/app/batches/page.tsx :: placeholder=\"Ex.": 1,
  "src/app/localization/page.tsx :: placeholder=\"Ex.": 1,
  "src/app/projects/[id]/page.tsx :: ('discovery') as an initial objective": 2,
  "src/app/projects/[id]/page.tsx :: ?? 'pt-BR'": 1,
  "src/app/projects/[id]/page.tsx :: automaticZoom: false": 1,
  "src/app/projects/[id]/page.tsx :: placeholder=\"Ex.": 2,
  "src/v2/application/apply-editorial-cut-command.ts :: automaticZoom: false": 2,
  "src/v2/application/apply-editorial-cut-command.ts :: fps * 4": 1,
  "src/v2/application/apply-editorial-cut-command.ts :: maxCharactersPerBlock: <digit>": 2,
  "src/v2/application/create-project.ts :: ?? 'pt-BR'": 1,
  "src/v2/application/multicam-direction.ts :: automaticZoom: false": 1,
  "src/v2/application/multicam-direction.ts :: fps * 4": 1,
  "src/v2/application/renderable-edit-plan.ts :: 'landscape-inset' as const": 1,
  "src/v2/application/renderable-edit-plan.ts :: automaticZoom: false": 1,
  "src/v2/application/renderable-edit-plan.ts :: fps * 4": 1,
  "src/v2/application/run-project-final-export-worker.ts :: fps * 4": 1,
  "src/v2/application/run-project-proxy-render-worker.ts :: fps * 4": 1,
  "src/v2/domain/contiguous-extraction.ts :: automaticZoom: false": 2,
  "src/v2/domain/director-run.ts :: automaticZoom: false": 1,
  "src/v2/domain/director-run.ts :: fps * 4": 1,
  "src/v2/domain/production-modes.ts :: index === 0 ? 'hook'": 1,
  "src/v2/infrastructure/prisma/image-analysis-repository.ts :: ?? 'pt-BR'": 1,
  "src/v2/infrastructure/prisma/long-form-index-workflow-repository.ts :: ?? 'pt-BR'": 2,
  "src/v2/infrastructure/prisma/media-library-repository.ts :: ?? 'pt-BR'": 1,
  "src/v2/infrastructure/prisma/project-final-export-repository.ts :: ?? 'pt-BR'": 1,
  "src/v2/infrastructure/prisma/review-annotation-repository.ts :: ?? 'pt-BR'": 1,
  "src/v2/public-api/schema-examples.ts :: automaticZoom: false": 20,
})

const keyOf = (file, patternId) => `${file} :: ${patternId}`

const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line)

function productFiles() {
  const roots = PRODUCT_ROOTS.filter((name) => existsSync(join(root, name)))
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots], { cwd: root, encoding: 'utf8' })
  if (listed.status === 0 && listed.stdout.length > 0) {
    return listed.stdout.split('\0').filter(Boolean).filter((path) => existsSync(join(root, path))).map((path) => join(root, path))
  }
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(join(directory, entry.name))) : [join(directory, entry.name)])
  return roots.flatMap((name) => walk(join(root, name)))
}

/** The editorial literals in `text`, as `patternId` per hit (comment lines are prose, not code). */
export function findEditorialLiterals(text) {
  const found = []
  for (const line of text.split(/\r?\n/)) {
    if (isCommentLine(line)) continue
    for (const pattern of PATTERNS) if (pattern.regex.test(line)) found.push(pattern.id)
  }
  return found
}

function scanProduct() {
  const counts = new Map()
  let scanned = 0
  for (const path of productFiles()) {
    if (!CODE_EXTENSIONS.has(extname(path).toLowerCase()) || statSync(path).size > 8 * 1024 * 1024) continue
    const file = relative(root, path).replaceAll('\\', '/')
    if (RESOLUTION_MODULES.includes(file)) continue
    scanned += 1
    for (const id of findEditorialLiterals(readFileSync(path, 'utf8'))) counts.set(keyOf(file, id), (counts.get(keyOf(file, id)) ?? 0) + 1)
  }
  return { counts, scanned }
}

test('the scan recognises each forbidden editorial literal, and only as code', () => {
  const samples = [
    "automaticZoom: false", "Math.round(input.fps * 4)", "layout: 'landscape-inset' as const", 'maxCharactersPerBlock: 42',
    "id: 'track-captions-pt-br'", "presetId: 'clean-color' as const", "role: index === 0 ? 'hook' : 'argument'",
    "audienceTags: ['workspace-default']", '<input placeholder="Ex.: uma frase" />', "useState<StrategicObjectiveId>('discovery')",
    "setObjective('discovery')", "locale: request.locale ?? 'pt-BR'",
  ]
  for (const sample of samples) assert.ok(findEditorialLiterals(sample).length === 1, `the scan missed: ${sample}`)
  for (const sample of [
    '// automaticZoom: false', ' * maxCharactersPerBlock: 42', "tags.push('discovery')", "mode: 'workspace-default'",
    "['workspace-default', 'lut-version', 'none']", 'maxCharactersPerBlock: policy.captions.maxCharactersPerBlock', 'fps * 40', 'const fps4 = 4',
  ]) assert.deepEqual(findEditorialLiterals(sample), [], `the scan flagged innocent text: ${sample}`)
})

test('the resolution modules are the only exemption, and they exist', () => {
  assert.deepEqual([...RESOLUTION_MODULES].sort(), [
    'src/v2/domain/editorial-policy-resolution.ts',
    'src/v2/domain/editorial-request.ts',
  ])
  for (const file of RESOLUTION_MODULES) assert.ok(existsSync(join(root, file)), `${file} is exempt but does not exist`)
})

test('no editorial literal outside the baseline, and no baseline entry that is no longer true (the baseline only shrinks)', () => {
  const { counts, scanned } = scanProduct()
  assert.ok(scanned > 500, `the guard must scan the product, but only ${scanned} files were read`)
  const lines = (entries) => entries.map(([key, count]) => `  ${JSON.stringify(key)}: ${count},`).join('\n')
  const added = [...counts].filter(([key, count]) => count > (BASELINE[key] ?? 0))
  assert.deepEqual(added, [], `new editorial literal(s) - the rule is "nothing is fixed": derive the value from the request, or name the rule in the resolution module:\n${lines(added)}`)
  const stale = Object.entries(BASELINE).filter(([key, count]) => (counts.get(key) ?? 0) < count)
  assert.deepEqual(stale, [], `baseline entries that are no longer true (the literal was fixed): lower or delete them, the baseline only shrinks:\n${lines(stale)}`)
  for (const key of Object.keys(BASELINE)) assert.ok(PATTERNS.some((pattern) => key.endsWith(` :: ${pattern.id}`)), `baseline entry names no known pattern: ${key}`)
})
