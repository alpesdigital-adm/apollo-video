import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * T-F4.016 — every `file.ts:line` citation in the tree resolves to one file
 * and to a line that file has.
 *
 * This suite exists because a re-audit of the Wave 20 closing round found
 * twelve citations that named the wrong module or the wrong line, in comments
 * and documents that were otherwise correct. That is the same defect class as
 * the false sentences the round was closing — a claim about the code that its
 * own lookup contradicts — and it is the cheapest half of the class to catch
 * mechanically.
 *
 * **What this proves, stated narrowly.** Two things, both structural:
 *
 * 1. the basename resolves to exactly ONE tracked file. `multicam-direction.ts`
 *    is two files — 2346 lines under `domain/` and 1710 under `application/` —
 *    and a bare basename picks one at random for the reader. Nine of the twelve
 *    wrong citations were ambiguous like this;
 * 2. the cited line exists. A citation past the end of its file is a citation
 *    to a file that has since shrunk.
 *
 * **What it does NOT prove, and cannot.** That the cited line SAYS what the
 * sentence claims. A citation that drifts by twenty lines inside a long file
 * still passes here, and three of the twelve did exactly that. Only a reader
 * catches those, and the honest limit is written here rather than left for
 * somebody to discover by trusting the gate too far.
 *
 * **Historical citations.** A sentence that names the commit it was true at —
 * spec 05 §34.7 does, for `93aa7f55` — is still held to both rules, because a
 * reader still opens the file at HEAD. §34.7 carries both numbers for that
 * reason. There is no allowlist: an exemption nobody can see is how the class
 * came back.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const execFileAsync = promisify(execFile)

/**
 * A citation is a backticked path with a line, optionally a range: the shape
 * this repository already uses. A bare path with no line is not a citation
 * under this rule — it names a file, and the file either exists or does not,
 * which is a different check.
 */
const CITATION = /`([A-Za-z0-9_./[\]-]+\.(?:ts|tsx|mjs))[:](\d+)(?:-(\d+))?`/g

/** Where prose about the code lives. Generated output is not scanned. */
const SCANNED = /^(?:src|tests|docs|scripts)\/.*\.(?:ts|tsx|mjs|md)$/

test('T-F4.016 every file:line citation names one file and a line that file has', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 })
  const tracked = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  assert.ok(tracked.length > 100, `git ls-files returned ${tracked.length} paths; the scan would prove nothing`)

  // Line counts are read once per cited file rather than per citation: the same
  // twenty files carry most of the 190-odd citations in the tree.
  const lineCounts = new Map()
  const lineCountOf = async (file) => {
    if (!lineCounts.has(file)) {
      lineCounts.set(file, (await readFile(path.join(REPO, file), 'utf8')).split('\n').length)
    }
    return lineCounts.get(file)
  }

  const ambiguous = []
  const beyondEnd = []
  let counted = 0

  for (const source of tracked.filter((file) => SCANNED.test(file))) {
    const body = await readFile(path.join(REPO, source), 'utf8')
    const lines = body.split('\n')
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(CITATION)) {
        counted += 1
        const [, reference, first, last] = match
        const where = `${source}:${index + 1}`
        const candidates = tracked.filter((file) => file === reference || file.endsWith(`/${reference}`))
        if (candidates.length !== 1) {
          ambiguous.push(`${where} cites \`${reference}\`, which matches ${candidates.length} tracked files`)
          continue
        }
        const cited = Number(last ?? first)
        const total = await lineCountOf(candidates[0])
        if (cited > total) {
          beyondEnd.push(`${where} cites ${candidates[0]}:${cited}, and that file has ${total} lines`)
        }
      }
    }
  }

  // The count is asserted so a regex that stops matching cannot turn this suite
  // green by scanning nothing — the failure mode of every structural check.
  assert.ok(counted > 150, `found only ${counted} file:line citations; the pattern has stopped matching`)

  assert.deepEqual(
    ambiguous,
    [],
    'a citation whose basename matches more than one tracked file sends the reader to the wrong module; '
    + 'write the directory that disambiguates it (domain/, application/, prisma/, ports/)',
  )
  assert.deepEqual(beyondEnd, [], 'these citations name a line their file does not have')

  console.log(`T-F4.016 source citations: ${counted} checked, ${lineCounts.size} cited files, 0 ambiguous, 0 past end of file`)
})
