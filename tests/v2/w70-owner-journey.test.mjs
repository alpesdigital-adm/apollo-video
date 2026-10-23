import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { runJourney } from '../../scripts/validation/w70-owner-journey.mjs'
import {
  ASPECT_RATIOS, EXIT, JourneyError, buildVariantBody, decisionFileName, detectContainer, mentionsHead, parseArguments, parseDecision, parseOutputs,
  parseOutputSpecFile, parseRequests, sanitize, substitute, substitutePath, usage,
} from '../../scripts/validation/w70-journey-lib.mjs'

// The driver carries no editorial content, and neither does this suite: every string below is a placeholder.
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..')
const sha = 'a'.repeat(64)
const ENV = { APOLLO_API_BASE_URL: 'http://127.0.0.1:9999/', APOLLO_API_TOKEN: 'token-placeholder-value' }
const base = (extra = []) => ['--briefing', resolve('/abs/briefing.txt'), '--outputs', 'A', '--master', resolve('/abs/master.bin'), '--master-sha256', sha, '--master-size', '10',
  '--rights-confirmed', '--evidence', resolve('/abs-evidence'), '--decisions', resolve('/abs-decisions'), ...extra]
const parse = (extra = [], env = ENV, outputs = '9:16,16:9') => parseArguments(base(extra).map((token) => (token === 'A' ? outputs : token)), env, { repositoryRoot: REPOSITORY_ROOT })
const usageError = (action, pattern) => assert.throws(action, (error) => error instanceof JourneyError && error.exitCode === EXIT.usage && pattern.test(error.message), String(pattern))

test('the arguments carry everything the journey needs and nothing is defaulted from the video', () => {
  const config = parse()
  assert.deepEqual(config.outputKeys, ['9:16', '16:9'])
  assert.equal(config.apiBaseUrl, 'http://127.0.0.1:9999')
  assert.equal(config['master-size'], 10)
  assert.equal(config['poll-ms'], 5000)
  assert.equal(config.objective, undefined, 'no objective is presumed')
  assert.equal(config.locale, undefined, 'no language is presumed')
  assert.equal(config.resume, false)
  assert.equal(parse(['--objective', 'objective-placeholder', '--locale', 'xx', '--resume']).resume, true)
  assert.equal(parse(['--objective', 'objective-placeholder']).objective, 'objective-placeholder')
  assert.match(usage(), /--briefing/)
  assert.equal(parseArguments(['--help'], {}, { repositoryRoot: REPOSITORY_ROOT }).help, true)
})

test('the arguments fail closed on anything missing, malformed or unsafe', () => {
  usageError(() => parse([], { APOLLO_API_TOKEN: 'token-placeholder-value' }), /APOLLO_API_BASE_URL/)
  usageError(() => parse([], { APOLLO_API_BASE_URL: 'http://127.0.0.1:1' }), /APOLLO_API_TOKEN/)
  usageError(() => parse([], { ...ENV, APOLLO_API_BASE_URL: 'ftp://x' }), /http or https/)
  usageError(() => parseArguments(base().filter((token) => token !== '--rights-confirmed'), ENV, { repositoryRoot: REPOSITORY_ROOT }), /rights-confirmed/)
  usageError(() => parseArguments(base().slice(2), ENV, { repositoryRoot: REPOSITORY_ROOT }), /--briefing is required/)
  usageError(() => parse(['--nope', 'x']), /unknown option/)
  usageError(() => parse(['--poll-ms', '5', '--poll-ms', '6']), /twice/)
  usageError(() => parse(['--poll-ms', '5']), /at least 100/)
  usageError(() => parse(['--master-sha256', sha]), /twice/)
  usageError(() => parseArguments(base().map((token) => (token === sha ? 'xyz' : token)), ENV, { repositoryRoot: REPOSITORY_ROOT }), /64 lowercase hex/)
  usageError(() => parseArguments(base().map((token) => (token === resolve('/abs/master.bin') ? 'relative/master.bin' : token)), ENV, { repositoryRoot: REPOSITORY_ROOT }), /absolute path/)
  usageError(() => parseArguments(base().map((token) => (token === resolve('/abs-evidence') ? join(REPOSITORY_ROOT, 'evidence') : token)), ENV, { repositoryRoot: REPOSITORY_ROOT }), /outside the repository/)
  usageError(() => parseArguments(base().map((token) => (token === resolve('/abs-decisions') ? resolve('/abs-evidence') : token)), ENV, { repositoryRoot: REPOSITORY_ROOT }), /different directories/)
  usageError(() => parseArguments(['--briefing'], ENV, { repositoryRoot: REPOSITORY_ROOT }), /needs a value/)
  usageError(() => parse(['stray']), /unexpected argument/)
})

test('--outputs are aspect ratios of the contract, once each', () => {
  assert.deepEqual(parseOutputs('9:16'), ['9:16'])
  assert.deepEqual(parseOutputs('16:9, 9:16'), ['16:9', '9:16'])
  assert.deepEqual([...ASPECT_RATIOS], ['9:16', '16:9', '4:5', '1:1', '21:9'])
  usageError(() => parseOutputs('3:2'), /not an aspect ratio/)
  usageError(() => parseOutputs('9:16,9:16'), /only once/)
  usageError(() => parseOutputs('9:16,'), /comma list/)
})

test('an output variant body comes from the product preset or the operator, with no caption unless asked', () => {
  const preset = { width: 200, height: 100, fps: 25, safeArea: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } }
  const body = buildVariantBody({ ratio: '16:9', preset, locale: undefined, baseVersionId: 'version-placeholder', baseHash: sha })
  assert.equal(body.output.locale, 'und')
  assert.equal(body.output.width, 200)
  assert.equal(body.profile.final.width, 200)
  assert.equal(body.profile.proxy.width, 100)
  assert.equal(body.profile.proxyToFinal.scaleX, 2)
  assert.deepEqual(body.profile.subtitles, { mode: 'none', configuration: null, fontAssets: [] })
  assert.equal(body.output.deliveryProfileId, body.profile.id)
  const overridden = buildVariantBody({ ratio: '16:9', preset, override: { width: 64, locale: 'xx', subtitles: { mode: 'burn-in' } }, locale: 'yy', baseVersionId: 'version-placeholder', baseHash: sha })
  assert.equal(overridden.output.width, 64)
  assert.equal(overridden.output.locale, 'xx')
  assert.equal(overridden.profile.subtitles.mode, 'burn-in')
  assert.equal(buildVariantBody({ ratio: '16:9', preset, locale: 'yy', baseVersionId: 'version-placeholder', baseHash: sha }).output.locale, 'yy')
  usageError(() => buildVariantBody({ ratio: '16:9', preset: {}, baseVersionId: 'x', baseHash: sha }), /width and height/)
  usageError(() => buildVariantBody({ ratio: '16:9', preset, override: { extra: 1 }, baseVersionId: 'x', baseHash: sha }), /unknown fields/)
  usageError(() => buildVariantBody({ ratio: '16:9', preset: { ...preset, safeArea: { top: 0.9 } }, baseVersionId: 'x', baseHash: sha }), /safeArea/)
  usageError(() => buildVariantBody({ ratio: '16:9', preset: { ...preset, fps: 500 }, baseVersionId: 'x', baseHash: sha }), /fps/)
  usageError(() => buildVariantBody({ ratio: '16:9', preset, override: { subtitles: { mode: 'x' } }, baseVersionId: 'x', baseHash: sha }), /subtitles.mode/)
  assert.deepEqual(parseOutputSpecFile({ '9:16': { width: 2 } }, ['9:16']), { '9:16': { width: 2 } })
  usageError(() => parseOutputSpecFile({ '1:1': {} }, ['9:16']), /not one of the requested outputs/)
  usageError(() => parseOutputSpecFile([], ['9:16']), /JSON object/)
})

test('the container of the master is read from its ftyp box', () => {
  const box = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(8)])
  assert.deepEqual(detectContainer(box('qt  ')), { brand: 'qt  ', mimeType: 'video/quicktime', extension: 'mov' })
  assert.deepEqual(detectContainer(box('isom')), { brand: 'isom', mimeType: 'video/mp4', extension: 'mp4' })
  assert.equal(detectContainer(Buffer.from('not a media file at all')), null)
  assert.equal(detectContainer(Buffer.alloc(4)), null)
})

const context = { outputKeys: ['9:16', '16:9'] }
const decide = (kind, record) => parseDecision(kind, JSON.stringify(record), context)
const refused = (kind, record, pattern) => assert.throws(() => decide(kind, record), (error) => error instanceof JourneyError && error.code === 'INVALID_DECISION' && pattern.test(error.message), String(pattern))

test('decision file names: the first is <kind>.json, the n-th is <kind>-n.json', () => {
  assert.equal(decisionFileName('proxy-review'), 'proxy-review.json')
  assert.equal(decisionFileName('revise-editorial-request', 2), 'revise-editorial-request-2.json')
  assert.throws(() => decisionFileName('nothing'), /unknown decision kind/)
  assert.throws(() => decisionFileName('proxy-review', 0), /positive/)
  assert.throws(() => parseDecision('nothing', '{}', context), /unknown decision kind/)
})

test('revise-editorial-request applies exactly the fields the file carries, with a reason', () => {
  const decision = decide('revise-editorial-request', { reason: 'reason placeholder', briefing: 'briefing placeholder', answers: [{ questionId: 'q1', answer: 'x' }] })
  assert.equal(decision.reason, 'reason placeholder')
  assert.deepEqual(Object.keys(decision.body).sort(), ['answers', 'briefing'])
  assert.equal(decide('revise-editorial-request', { reason: 'r', briefing: null }).body.briefing, null)
  assert.equal(decide('revise-editorial-request', { reason: 'r', objective: 'objective-placeholder' }).body.objective, 'objective-placeholder')
  refused('revise-editorial-request', { briefing: 'x' }, /reason/)
  refused('revise-editorial-request', { reason: 'r' }, /at least one of/)
  refused('revise-editorial-request', { reason: 'r', briefing: '   ' }, /text or null/)
  refused('revise-editorial-request', { reason: 'r', briefing: 'x', extra: true }, /unknown fields/)
  assert.throws(() => parseDecision('revise-editorial-request', '{broken', context), (error) => error.code === 'INVALID_DECISION' && /not valid JSON/.test(error.message))
  assert.throws(() => parseDecision('revise-editorial-request', '[]', context), /JSON object/)
})

test('remove-spoken-content is either a recorded skip or rules for named outputs', () => {
  assert.deepEqual({ ...decide('remove-spoken-content', { skip: true, reason: 'nothing to remove' }) }, { skip: true, reason: 'nothing to remove' })
  const rules = [{ id: 'rule-1', label: 'label placeholder', alternatives: ['phrase placeholder'] }]
  const decision = decide('remove-spoken-content', { variants: ['16:9'], rules, reason: 'r' })
  assert.deepEqual([...decision.variants], ['16:9'])
  assert.equal(decision.rules.length, 1)
  refused('remove-spoken-content', { skip: true }, /reason/)
  refused('remove-spoken-content', { skip: false, reason: 'r' }, /must be true/)
  refused('remove-spoken-content', { rules }, /variants/)
  refused('remove-spoken-content', { variants: ['1:1'], rules }, /variants/)
  refused('remove-spoken-content', { variants: ['16:9', '16:9'], rules }, /once each/)
  refused('remove-spoken-content', { variants: ['16:9'], rules: [] }, /non-empty/)
  refused('remove-spoken-content', { variants: ['16:9'], rules: [{ id: 'x', label: 'y', alternatives: [] }] }, /alternatives/)
  refused('remove-spoken-content', { variants: ['16:9'], rules: [{ id: 'x', label: 'y', alternatives: ['z'], extra: 1 }] }, /unknown fields/)
})

test('requests of a decision stay inside /v1/ and use only POST or PUT', () => {
  const [request] = parseRequests('d', [{ method: 'POST', path: '/v1/projects/{{projectId}}/commands', body: { baseVersionId: '{{head.versionId}}' } }])
  assert.equal(request.method, 'POST')
  assert.throws(() => parseRequests('d', []), /non-empty/)
  assert.throws(() => parseRequests('d', [{ method: 'DELETE', path: '/v1/x' }]), /POST or PUT/)
  assert.throws(() => parseRequests('d', [{ method: 'POST', path: 'https://elsewhere/v1/x' }]), /relative \/v1\//)
  assert.throws(() => parseRequests('d', [{ method: 'POST', path: '/v1/../x' }]), /relative \/v1\//)
  assert.throws(() => parseRequests('d', [{ method: 'POST', path: '/v1/x', body: [] }]), /body must be an object/)
  assert.throws(() => parseRequests('d', [{ method: 'POST', path: '/v1/x', expect: [404] }]), /2xx/)
  assert.throws(() => parseRequests('d', [{ method: 'POST', path: '/v1/x', odd: 1 }]), /unknown fields/)
})

test('proxy-review decides every output, and a correction carries its requests and reason', () => {
  const requests = [{ method: 'POST', path: '/v1/projects/{{projectId}}/commands', body: { type: 'placeholder' } }]
  const decision = decide('proxy-review', { outputs: { '9:16': { decision: 'approve', acknowledgeWarnings: true, note: 'note placeholder' }, '16:9': { decision: 'correct', requests, reason: 'reason placeholder' } } })
  assert.equal(decision.outputs['9:16'].acknowledgeWarnings, true)
  assert.equal(decision.outputs['16:9'].decision, 'correct')
  assert.equal(decide('proxy-review', { outputs: { '9:16': { decision: 'approve' }, '16:9': { decision: 'approve' } } }).outputs['9:16'].acknowledgeWarnings, false)
  refused('proxy-review', { outputs: { '9:16': { decision: 'approve' } } }, /exactly/)
  refused('proxy-review', { outputs: { '9:16': { decision: 'approve' }, '16:9': { decision: 'maybe' } } }, /approve" or "correct/)
  refused('proxy-review', { outputs: { '9:16': { decision: 'correct', requests }, '16:9': { decision: 'approve' } } }, /reason/)
  refused('proxy-review', { outputs: { '9:16': { decision: 'approve', acknowledgeWarnings: 'yes' }, '16:9': { decision: 'approve' } } }, /true or false/)
  refused('proxy-review', {}, /outputs/)
})

test('owner-correction names the affected outputs and approves their final; acceptance says who decided', () => {
  const requests = [{ method: 'POST', path: '/v1/projects/{{projectId}}/commands', body: { type: 'placeholder' } }]
  const correction = decide('owner-correction', { reason: 'r', requests, outputs: { '9:16': { approve: true, acknowledgeWarnings: true } } })
  assert.deepEqual(Object.keys(correction.outputs), ['9:16'])
  assert.equal(correction.runDirector, false)
  assert.equal(decide('owner-correction', { reason: 'r', runDirector: true, outputs: { '16:9': { approve: true } } }).runDirector, true)
  refused('owner-correction', { reason: 'r', outputs: { '9:16': { approve: true } } }, /requests, runDirector/)
  refused('owner-correction', { reason: 'r', requests, outputs: { '1:1': { approve: true } } }, /affected outputs/)
  refused('owner-correction', { reason: 'r', requests, outputs: { '9:16': { approve: false } } }, /approve": true/)
  refused('owner-correction', { requests, outputs: { '9:16': { approve: true } } }, /reason/)
  const acceptance = decide('owner-acceptance', { accepted: true, by: 'person placeholder', note: 'note placeholder' })
  assert.deepEqual({ ...acceptance }, { accepted: true, by: 'person placeholder', note: 'note placeholder' })
  assert.equal(decide('owner-acceptance', { accepted: false, by: 'p' }).accepted, false)
  refused('owner-acceptance', { by: 'p' }, /accepted/)
  refused('owner-acceptance', { accepted: true }, /by/)
  refused('owner-acceptance', { accepted: true, by: 'p', recordedAt: 'never' }, /ISO date/)
  const rights = decide('source-rights', { body: { status: 'approved' }, reason: 'r' })
  assert.equal(rights.body.status, 'approved')
  refused('source-rights', { body: {}, reason: 'r' }, /status/)
})

test('request templates substitute whole-string placeholders and nothing else', () => {
  const resolver = (name) => ({ projectId: 'project-placeholder', 'head.versionId': 'version-placeholder', 'variant:9:16': 'variant-placeholder' })[name]
  const responses = [{ data: { annotation: { id: 'annotation-placeholder' } }, status: 201 }]
  const value = substitute({ a: '{{projectId}}', b: ['{{head.versionId}}', 'plain'], c: { d: '{{r0.data.annotation.id}}', e: '{{variant:9:16}}' }, n: 3 }, { resolver, responses })
  assert.deepEqual(value, { a: 'project-placeholder', b: ['version-placeholder', 'plain'], c: { d: 'annotation-placeholder', e: 'variant-placeholder' }, n: 3 })
  assert.equal(substitute('prefix {{projectId}}', { resolver }), 'prefix {{projectId}}', 'only a whole-string token is a placeholder')
  assert.throws(() => substitute('{{unknown}}', { resolver }), (error) => error.code === 'UNKNOWN_PLACEHOLDER')
  assert.throws(() => substitute('{{r1.data}}', { resolver, responses }), (error) => error.code === 'UNKNOWN_PLACEHOLDER')
  assert.throws(() => substitute('{{r0.data.missing.id}}', { resolver, responses }), (error) => error.code === 'UNKNOWN_PLACEHOLDER')
  assert.equal(substitutePath('/v1/projects/{{projectId}}/commands', { resolver }), '/v1/projects/project-placeholder/commands')
  assert.equal(mentionsHead({ path: '/v1/x', body: { v: '{{head.baseHash}}' } }), true)
  assert.equal(mentionsHead({ path: '/v1/x', body: { v: '{{projectId}}' } }), false)
})

test('evidence never carries the credential, a download token or a screenshot', () => {
  const secret = 'bearer-secret-placeholder'
  const clean = sanitize({
    authorization: `Bearer ${secret}`, nested: { note: `uses ${secret} inline`, downloadUrl: 'https://host/grants/g/content?token=opaque-value&x=1', commitToken: 'abc', count: 3, tokenCount: 7 },
    screenshotRef: `data:image/jpeg;base64,${'A'.repeat(30_000)}`, list: [{ apiKey: 'k', fine: 'ok' }],
  }, [secret])
  const text = JSON.stringify(clean)
  assert.ok(!text.includes(secret))
  assert.ok(!text.includes('opaque-value'))
  assert.ok(!text.includes('AAAAAAAAAA'))
  assert.equal(clean.authorization, '[REDACTED]')
  assert.equal(clean.nested.commitToken, '[REDACTED]')
  assert.equal(clean.nested.tokenCount, 7, 'numbers are data, not secrets')
  assert.match(clean.screenshotRef, /^\[\d+ characters, sha256 [a-f0-9]{64}\]$/)
  assert.equal(clean.list[0].fine, 'ok')
})

// ---- the driver itself, against a server that cannot serve the journey: it must stop closed, never invent a state.
async function withTemporaryJourney(action, handler = (_request, response) => { response.statusCode = 503; response.end('{}') }) {
  const root = await mkdtemp(join(tmpdir(), 'apollo-w70-unit-'))
  const server = createServer(handler)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const briefing = join(root, 'briefing.txt')
    await writeFile(briefing, 'briefing placeholder\n')
    const env = { APOLLO_API_BASE_URL: `http://127.0.0.1:${server.address().port}`, APOLLO_API_TOKEN: 'token-placeholder-value' }
    const make = (extra = []) => parseArguments(['--briefing', briefing, '--outputs', '9:16,16:9', '--master', join(root, 'master.bin'), '--master-sha256', sha, '--master-size', '10', '--rights-confirmed',
      '--evidence', join(root, 'evidence'), '--decisions', join(root, 'decisions'), ...extra], env, { repositoryRoot: REPOSITORY_ROOT })
    return await action({ root, config: make(), make })
  } finally {
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  }
}

test('the driver refuses an unreachable or unhealthy server before it writes any phase', async () => {
  await withTemporaryJourney(async ({ config, root }) => {
    await assert.rejects(runJourney(config), (error) => error instanceof JourneyError && error.code === 'SERVER_UNREACHABLE')
    const log = (await readFile(join(root, 'evidence', 'journey-log.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(log[0].event, 'journey-start')
    assert.ok(!log.some((entry) => entry.event === 'phase-start'))
    assert.ok(!JSON.stringify(log).includes('token-placeholder-value'), 'the credential never reaches the log')
    await assert.rejects(runJourney(config), (error) => error.code === 'USAGE' && /--resume/.test(error.message), 'an existing journey is not silently restarted')
    await assert.rejects(runJourney({ ...config, resume: true, briefing: config.briefing, 'master-sha256': 'b'.repeat(64) }), (error) => error.code === 'USAGE' && /differ from the journey/.test(error.message))
  })
})

test('--resume without a journey to resume fails closed', async () => {
  await withTemporaryJourney(async ({ make }) => {
    await assert.rejects(runJourney(make(['--resume'])), (error) => error.code === 'USAGE' && /nothing to resume|no journey-log/.test(error.message))
  })
})

test('a journey holds the evidence directory: a second driver on it is refused', async () => {
  await withTemporaryJourney(async ({ config }) => {
    await mkdir(config.evidence, { recursive: true })
    await writeFile(join(config.evidence, 'journey.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    await assert.rejects(runJourney(config), (error) => error.code === 'LOCKED')
  })
})
