import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { formatTicks, showBps, showNumber, showRatio, tickRateFrom } from '../../src/app/_operator/tick-format.ts'
import {
  classifyConflict,
  conflictingVersionFrom,
  REPEATED_REQUEST_MESSAGE,
  STALE_FENCE_CONFLICT_CODES,
} from '../../src/app/_operator/refusal.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../src/v2/domain/multicam-output-format.ts'
import { PLAYBACK_MODES } from '../../src/v2/domain/playback-mode.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { PUBLIC_ERROR_CATALOG } from '../../src/v2/public-api/public-error-catalog.ts'
import { PUBLIC_SCHEMAS } from '../../src/v2/public-api/schema-registry.ts'

/**
 * The Wave 20 operator pages, checked at the source.
 *
 * The browser suite beside this one drives the commands against a real
 * PostgreSQL and a production build, which is the only way to know a page
 * works. It costs a build, a database and a browser, so it is opt-in — and an
 * opt-in suite is not where a rule that must hold on every commit belongs.
 *
 * These are the rules that must hold on every commit, and each one is here
 * because it was broken:
 *
 * - **An enum is spread, never typed.** Both pickers on these pages were
 *   hand-typed copies of a domain constant. CONTRACT.md §2 records the Wave 19
 *   injury: every enum written from memory was wrong.
 * - **A fence is read from the API and from nothing else.** A page that took
 *   `baseVersionId` off the query string would pass every gate the repository
 *   has, including the browser suite, whenever the two happened to agree.
 * - **A 409 is read by its code.** Five codes share that status and only two of
 *   them mean "reload".
 * - **A rate that is not 1/N is still a rate.** The three pages truncated it.
 */

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const direction = read('src/app/multicam-direction/page.tsx')
const colour = read('src/app/color-match/page.tsx')
const playback = read('src/app/playback-map/page.tsx')
const diagnostic = read('src/app/sync-diagnostic/page.tsx')
const sessions = read('src/app/capture-sessions/page.tsx')

const schemaFor = (id) => {
  const found = PUBLIC_SCHEMAS.find((entry) => entry.id === id)
  assert.ok(found, `the published schema ${id} does not exist`)
  return found.schema
}

test('W20-UI the operator pickers spread the domain enum the request schema publishes', () => {
  // The authority, the page and the wire agree, and the check is on the values
  // rather than on the spelling of the import: a page that imported the
  // constant and then rendered its own array would pass a grep and fail here.
  assert.deepEqual(
    [...OUTPUT_ASPECT_RATIOS],
    schemaFor('direct-multicam-session-request').properties.format.properties.aspectRatio.enum,
    'the aspect ratios the domain owns are not the ones the direction request accepts',
  )
  assert.deepEqual(
    [...PLAYBACK_MODES],
    schemaFor('add-react-playback-anchor-request').properties.anchor.properties.mode.enum,
    'the playback modes the domain owns are not the ones the anchor request accepts',
  )

  assert.match(direction, /import \{ OUTPUT_ASPECT_RATIOS \} from '@\/v2\/domain\/multicam-output-format'/)
  assert.match(direction, /\{OUTPUT_ASPECT_RATIOS\.map\(/)
  assert.match(playback, /import \{ PLAYBACK_MODES \} from '@\/v2\/domain\/playback-mode'/)
  assert.match(playback, /\{PLAYBACK_MODES\.map\(/)

  // And no page keeps a second copy of either vocabulary. Both literals are
  // spelled out so the assertion fails on the exact shape that was there.
  for (const [name, source] of [['direction', direction], ['playback', playback], ['colour', colour]]) {
    assert.doesNotMatch(
      source, /\[\s*'16:9',\s*'9:16'/,
      `${name} kept a hand-typed copy of the aspect ratios`,
    )
    assert.doesNotMatch(
      source, /'playing',\s*'paused',\s*'rewind'/,
      `${name} kept a hand-typed copy of the playback modes`,
    )
  }

  // The leaf modules exist so a client page can import them: neither may grow
  // an import, because one import of canonical-hash.ts puts node:crypto back
  // into the browser bundle and the page has to type the enum again.
  for (const leaf of ['src/v2/domain/multicam-output-format.ts', 'src/v2/domain/playback-mode.ts']) {
    assert.doesNotMatch(read(leaf), /^import /m, `${leaf} must stay a leaf the browser can load`)
  }
})

test('W20-UI every command fence is read from the response that carried it', () => {
  // The whole point of the fence is that the page does not choose it. So every
  // fence field in the three pages is collected and compared against the exact
  // set of expressions that are allowed to produce one. A mutation that made
  // any of them fall back to the query string, to an input the operator types,
  // or to a state variable would show up here as an expression nobody approved
  // — which is what a hand-audit of six request bodies cannot promise.
  const fences = (source) => [...source.matchAll(/^\s*(baseVersionId|baseHash|projectBaseVersionId|projectBaseHash): (.+),$/gm)]
    .map((match) => `${match[1]} = ${match[2]}`)
    .sort()

  assert.deepEqual(fences(direction), [
    'baseHash = projectVersion.baseHash',
    'baseHash = projectVersion.baseHash',
    'baseVersionId = projectVersion.id',
    'baseVersionId = projectVersion.id',
  ], 'the direction page built a fence out of something other than the workspace read')

  assert.deepEqual(fences(colour), [
    'baseHash = read.plan.planHash',
    'baseHash = session.sessionHash',
    'baseVersionId = `${session.sessionId}:v${session.version}`',
    'baseVersionId = read.versionRef',
    'projectBaseHash = projectVersion.baseHash',
    'projectBaseHash = projectVersion.baseHash',
    'projectBaseVersionId = projectVersion.id',
    'projectBaseVersionId = projectVersion.id',
  ], 'the colour page built a fence out of something other than the session, plan or workspace read')

  assert.deepEqual(fences(playback), [
    'baseHash = listing.map.mapHash',
    'baseHash = session.sessionHash',
    'baseVersionId = `${session.sessionId}:v${session.version}`',
    'baseVersionId = listing.versionRef',
  ], 'the playback page built a fence out of something other than the session or map read')

  // The query string reaches exactly one place on each page: the two ids that
  // say which session is being looked at, read once on mount.
  for (const [name, source] of [['direction', direction], ['colour', colour], ['playback', playback]]) {
    assert.equal(
      [...source.matchAll(/URLSearchParams/g)].length, 1,
      `${name} reads the query string somewhere other than the link it was opened from`,
    )
  }
})

test('W20-UI a 409 is answered by its code, and the repeated request is not a reload', () => {
  assert.equal(classifyConflict(409, 'VERSION_CONFLICT'), 'stale-fence')
  assert.equal(classifyConflict(409, 'PERSISTENCE_CONFLICT'), 'stale-fence')
  assert.equal(classifyConflict(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH'), 'repeated-request')
  assert.equal(classifyConflict(409, 'TOOL_CONFIRMATION_REQUIRED'), 'other-conflict')
  assert.equal(classifyConflict(409, undefined), 'other-conflict')
  assert.equal(classifyConflict(422, 'VERSION_CONFLICT'), null)
  assert.equal(conflictingVersionFrom({ currentVersionId: 'v-9' }), 'v-9')
  assert.equal(conflictingVersionFrom({ currentVersion: 4 }), '4')
  assert.equal(conflictingVersionFrom(undefined), 'outra')

  // The catalogue is the authority on which codes can arrive as a 409, and the
  // page's remedy is right for exactly two of them. If a sixth code joins the
  // group, this says so rather than letting it inherit "reload".
  const conflict = Object.values(PUBLIC_ERROR_CATALOG)
    .filter((descriptor) => descriptor.status === 409)
    .map((descriptor) => descriptor.code)
  for (const code of STALE_FENCE_CONFLICT_CODES) {
    assert.ok(conflict.includes(code), `${code} is treated as a 409 and the catalogue does not put it there`)
  }
  assert.ok(conflict.includes('IDEMPOTENCY_PAYLOAD_MISMATCH'))
  assert.ok(
    conflict.length > STALE_FENCE_CONFLICT_CODES.size + 1,
    'the 409 group has shrunk to the codes this page knows; the branch may no longer be needed',
  )

  for (const [name, source] of [['direction', direction], ['colour', colour], ['playback', playback]]) {
    assert.match(
      source, /classifyConflict\(status, body\.error\?\.code\)/,
      `${name} does not read the code the envelope carries`,
    )
    assert.doesNotMatch(source, /status === 409/, `${name} still diagnoses a conflict by its status alone`)
    // The reload affordance lives inside `stale-conflict`, so the other two
    // branches have to clear it or they offer a remedy that does not apply.
    assert.match(source, /setConflict\(null\)/, `${name} leaves the reload button up on a refusal a reload cannot fix`)
  }
  assert.match(REPEATED_REQUEST_MESSAGE, /já foi enviado com outro conteúdo/)
})

test('W20-UI a colour override carries the scope the operator gave it', () => {
  const schema = schemaFor('add-multicam-match-override-request').properties.override
  assert.ok(schema.properties.range, 'the published override schema no longer offers a range')
  assert.ok(schema.properties.segmentId, 'the published override schema no longer offers a segment')

  for (const testId of ['override-range-start', 'override-range-end', 'override-segment']) {
    assert.ok(colour.includes(`data-testid="${testId}"`), `the override form has no ${testId}`)
  }
  assert.match(colour, /\.\.\.\(segmentId\.length === 0 \? \{\} : \{ segmentId \}\)/)
  assert.match(colour, /\.\.\.\(start\.length === 0 \? \{\} : \{ range: \{ start, end \} \}\)/)
  // The sentence that used to promise a scope the request never carried.
  assert.doesNotMatch(
    colour, /vale só\s+para o trecho que alcança/,
    'the page still promises a scope it may not have sent',
  )
  assert.ok(
    colour.includes('na câmera inteira: nenhum trecho foi indicado'),
    'an unscoped override is not reported as covering the whole camera',
  )
})

test('W20-UI a rate that is not 1/N is divided exactly rather than truncated', () => {
  // 30000/1001 is the rate the boundary accepts and the old reading refused to
  // represent: `denominator / numerator` in BigInt gave 29 ticks a second, and
  // a five-minute interval printed 3.3 % long with nothing saying it was
  // approximate. 8991 ticks is 299.9997 s; what must never come back is the
  // 310,034 s the truncation produced.
  const ntsc = tickRateFrom('1001/30000')
  assert.deepEqual(ntsc, { numerator: 1_001n, denominator: 30_000n })
  assert.equal(formatTicks('8991', ntsc), '299,999 s')

  const broadcast = tickRateFrom('1/90000')
  assert.equal(formatTicks('90000', broadcast), '1,000 s')
  assert.equal(formatTicks('135000', broadcast), '1,500 s')
  assert.equal(formatTicks('-90000', broadcast), '−1,000 s')
  // A 64-bit tick is not parsed into a Number on the way through.
  assert.equal(formatTicks('9007199254740993', tickRateFrom('1/1')), '9007199254740993,000 s')

  // No timebase is not a timebase of one: the raw string is shown instead of a
  // duration nobody measured.
  for (const absent of [undefined, '', 'nonsense', '0/1', '1/0', '-1/2']) {
    assert.equal(tickRateFrom(absent), null, `${JSON.stringify(absent)} was read as a usable rate`)
  }
  assert.equal(formatTicks('90000', null), '90000 ticks')

  // And the three readouts still refuse to render an absence as a number.
  assert.equal(showBps(null), 'não medida')
  assert.equal(showBps(0), '0.00 %')
  assert.equal(showRatio(null), 'não medida')
  assert.equal(showNumber(null), 'não medido')
  assert.equal(showNumber(0), '0.000')
})

test('W20-UI cross navigation runs both ways and never lands on an empty form', () => {
  // /sync-diagnostic was nominated as a sibling by all three pages and carried
  // no link back to any of them.
  for (const testId of ['link-capture-sessions', 'link-multicam-direction', 'link-color-match', 'link-playback-map']) {
    assert.ok(diagnostic.includes(`data-testid="${testId}"`), `the diagnostic has no ${testId}`)
  }
  for (const [name, source, siblings] of [
    ['direction', direction, ['link-capture-sessions', 'link-color-match', 'link-playback-map', 'link-sync-diagnostic']],
    ['colour', colour, ['link-capture-sessions', 'link-multicam-direction', 'link-playback-map', 'link-sync-diagnostic']],
    ['playback', playback, ['link-capture-sessions', 'link-multicam-direction', 'link-color-match', 'link-sync-diagnostic']],
  ]) {
    for (const testId of siblings) {
      assert.ok(source.includes(`data-testid="${testId}"`), `${name} does not link to ${testId}`)
    }
  }

  // The three links out of /capture-sessions are guarded, like the diagnostic
  // link beside them. Unguarded they rendered `?projeto=&sessao=` — the empty
  // form the comment above them says they exist to avoid.
  for (const testId of ['open-multicam-direction', 'open-color-match', 'open-playback-map']) {
    const index = sessions.indexOf(`data-testid="${testId}"`)
    assert.ok(index > 0, `capture-sessions has no ${testId}`)
    assert.match(
      sessions.slice(Math.max(0, index - 120), index), /\{selected && \(\s*$/m,
      `${testId} is offered before a session is chosen`,
    )
  }
  assert.doesNotMatch(
    sessions, /sessao=\$\{encodeURIComponent\(selected \?\? ''\)\}/,
    'a capture-sessions link still falls back to an empty session',
  )
})

test('W20-UI the fourth operator surface is built, and reads the gate the same way', () => {
  // This assertion replaced an expiring one. While the gate had no capability,
  // the fourth page could not be built without breaking the rule the whole wave
  // is about, and the descope was recorded in
  // docs/quality/wave20-operator-surfaces.md with a check that failed the day
  // the gate was published. That day came: six capabilities now carry the gate,
  // the page exists, and what is worth checking is no longer the absence but
  // the same property the other three pages are held to.
  const gateCapabilities = FOUNDATION_CAPABILITIES
    .map((capability) => capability.id)
    .filter((id) => /multicam-longform-gate/.test(id))
  assert.ok(
    gateCapabilities.length >= 1,
    'the gate lost its published capabilities; the fourth page has nothing to read',
  )

  const page = read('src/app/multicam-longform-gate/page.tsx')
  const declaredPaths = FOUNDATION_CAPABILITIES
    .filter((capability) => /multicam-longform-gate/.test(capability.id))
    .map((capability) => capability.endpoint.path)
  const templates = [...page.matchAll(/`(\/v1\/[^`]*)`/g)].map((match) => match[1])
  assert.ok(templates.length > 0, 'the gate page reaches no /v1 path at all')
  for (const template of templates) {
    const shape = template.replace(/\$\{[^}]*\}/g, '{}')
    const declared = declaredPaths.some(
      (path) => path.replace(/\{[^}]*\}/g, '{}').startsWith(shape.split('?')[0]),
    )
    assert.ok(declared, `the gate page reaches ${template}, which no gate capability declares`)
  }

  const note = read('docs/quality/wave20-operator-surfaces.md')
  assert.match(note, /F4\.016/, 'the note no longer names the surface it is about')
  assert.doesNotMatch(
    note, /não pode existir hoje/,
    'the note still says the gate page cannot exist, and it does exist',
  )
})
