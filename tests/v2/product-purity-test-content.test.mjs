import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Product purity guard. The Apollo edits according to the request of each video; the content of one-off test video (the phrases,
 * dates, timestamps and reasons of the Imersao master recovery case) is allowed to exist only in tests/. This test walks everything
 * the product ships or runs - src/, scripts/, remotion/, config/, prisma/, public/ - and fails on any trace of it, as a rule, a
 * default, a replacement value or an API example. It may hold the phrases below because it lives in tests/.
 */
const root = fileURLToPath(new URL('../../', import.meta.url))
const PRODUCT_ROOTS = ['src', 'scripts', 'remotion', 'config', 'prisma', 'public']
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.html',
  '.md', '.mdx', '.txt', '.sql', '.prisma', '.yml', '.yaml', '.toml', '.sh', '.ps1', '.svg', '.csv', '.env', '.example'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'generated', 'dist', 'build', 'out', '.git', '.apollo'])
const MAX_BYTES = 8 * 1024 * 1024

// Matched on text lower-cased and stripped of diacritics, so "Janeiro", "JANEIRO", "duração" and "duracao" are the same trace.
const TEST_CONTENT = Object.freeze([
  ['31 de janeiro / trinta e um de janeiro', /janeiro/],
  ['1 de fevereiro / primeiro de fevereiro', /fevereiro/],
  ['trinta e um', /trinta e um/],
  ['dois dias / dois dias de aula', /dois dias/],
  ['2 dias', /(?<![\w.])2 dias\b/],
  ['date-january-31', /date-january-31/],
  ['date-february-1', /date-february-1/],
  ['duration-two-days', /duration-two-days/],
  ['bloco de agenda', /bloco de agenda/],
  ['duracao obsoleta', /duracao obsoleta/],
  // The timestamps of the test master: 36,26 / 58,12 / 86,58 / 87,76 / 39,02 / 42,68 / 36,66 / 58,24 and the second seam 64,72.
  ...['36[.,]26', '58[.,]12', '86[.,]58', '87[.,]76', '39[.,]02', '42[.,]68', '36[.,]66', '58[.,]24', '64[.,]72']
    .map((digits) => [digits.replace('[.,]', ' (point or comma) '), new RegExp(`(?<![\\d.,])${digits}(?!\\d)`)]),
])

const fold = (text) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** The traces of the test content in `text`, as `[line, what]` pairs. */
function findTestContent(text) {
  const found = []
  fold(text).split(/\r?\n/).forEach((line, index) => {
    for (const [what, pattern] of TEST_CONTENT) if (pattern.test(line)) found.push([index + 1, what])
  })
  return found
}

function productFiles() {
  const roots = PRODUCT_ROOTS.filter((name) => existsSync(join(root, name)))
  // Tracked and untracked-but-not-ignored files: a new file is guarded before it is ever committed.
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots], { cwd: root, encoding: 'utf8' })
  if (listed.status === 0 && listed.stdout.length > 0) {
    return listed.stdout.split('\0').filter(Boolean).filter((path) => existsSync(join(root, path))).map((path) => join(root, path))
  }
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(join(directory, entry.name))) : [join(directory, entry.name)])
  return roots.flatMap((name) => walk(join(root, name)))
}

function isGuardedText(path) {
  const extension = extname(path).toLowerCase()
  return (TEXT_EXTENSIONS.has(extension) || extension === '') && statSync(path).size <= MAX_BYTES
}

test('the guard recognises the test content however it is written (case, accents, comma or point)', () => {
  for (const sample of [
    '31 de janeiro', '31 de Janeiro', 'TRINTA E UM DE JANEIRO', '1º de fevereiro', 'primeiro de Fevereiro', 'dois dias', 'Dois Dias de aula',
    'em 2 dias', "id: 'date-january-31'", "id: 'date-february-1'", "id: 'duration-two-days'", 'Bloco de agenda', 'Duração obsoleta',
    'sourceStartSeconds: 36.26', '36,26', '58.12', '86,58', '87.76', '39.02', '42,68', '36,66', '58.24', 'seam 64.72',
  ]) assert.ok(findTestContent(sample).length > 0, `the guard missed: ${sample}`)
  for (const sample of ['136.26', '36.261', 'frase de exemplo', 'phrase-rule-example-1', 'dos dias', '12 dias', 'um dia', '2 diasx2', 'sourceStartSeconds: 12.0']) {
    assert.deepEqual(findTestContent(sample), [], `the guard flagged innocent text: ${sample}`)
  }
})

test('nothing the product ships or runs carries the content of the one-off test video', () => {
  const offenders = []
  let scanned = 0
  for (const path of productFiles()) {
    if (!isGuardedText(path)) continue
    const text = readFileSync(path, 'utf8')
    if (text.includes('\0')) continue
    scanned += 1
    for (const [line, what] of findTestContent(text)) offenders.push(`${relative(root, path).replaceAll('\\', '/')}:${line} (${what})`)
  }
  assert.ok(scanned > 500, `the guard must scan the product, but only ${scanned} files were read`)
  assert.deepEqual(offenders, [], `test-video content leaked into the product (it may live only in tests/):\n${offenders.join('\n')}`)
})

// Golden sets and fixtures whose only consumers are tests live under tests/. These were product exports once; the product never read them.
const TEST_ONLY_SETS = Object.freeze([
  'BRIEF_COMPILER_GOLDEN_SET', 'TRANSFORMATION_GOLDENS', 'NARRATIVE_POLICY_FIXTURES',
  'NEGATIVE_GOAL_FIXTURES', 'IMAGE_EVAL_FIXTURES', 'CONFIDENCE_CALIBRATION_GOLDEN',
])

test('golden sets used only by tests are not declared in the product', () => {
  const offenders = []
  for (const path of productFiles()) {
    if (!isGuardedText(path)) continue
    const text = readFileSync(path, 'utf8')
    for (const name of TEST_ONLY_SETS) if (text.includes(name)) offenders.push(`${relative(root, path).replaceAll('\\', '/')} (${name})`)
  }
  assert.deepEqual(offenders, [], `test-only golden sets leaked back into the product (they live in tests/v2/helpers/):\n${offenders.join('\n')}`)
})
