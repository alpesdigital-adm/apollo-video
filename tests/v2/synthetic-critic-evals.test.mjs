import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const ffmpeg = require('ffmpeg-static')

/**
 * Versioned eval set for the synthetic critic.
 *
 * Every case below is declarative: it names bytes to synthesize with ffmpeg,
 * what the pipeline expected of them, and the verdict a correct critic must
 * reach. None of it is produced by the code under test — ffmpeg builds the
 * media, the expectations are written by hand, and the sentinels compare the
 * critic's own output against them. Changing a verdict here has to be a
 * deliberate edit to this table.
 */
const EVAL_SET_VERSION = 'synthetic-critic-eval-set/v1'

const SIZE = 'size=160x120:rate=30:duration=3'
const AAC = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']

/** ffmpeg recipes. Each produces a deterministic file: 3s, 30fps, h264 + aac. */
const FIXTURES = Object.freeze({
  'clean.mp4': ['-f', 'lavfi', '-i', `testsrc=${SIZE}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', ...AAC],
  'silent.mp4': ['-f', 'lavfi', '-i', `testsrc=${SIZE}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '3', ...AAC],
  'frozen.mp4': ['-f', 'lavfi', '-i', `color=c=blue:${SIZE}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', ...AAC],
  'gap.mp4': ['-f', 'lavfi', '-i', `testsrc=${SIZE}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-af', "volume=0:enable='between(t,1,2)'", ...AAC],
  'long.mp4': ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', ...AAC],
  'speech.m4a': ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:a', 'aac'],
  'stretched.m4a': ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3.5', '-c:a', 'aac'],
})

const SCRIPT = 'Primeira ideia do roteiro'
const SPOKEN = Object.freeze([
  { word: 'Primeira', startMs: 0, endMs: 700 },
  { word: 'ideia', startMs: 700, endMs: 1_100 },
  { word: 'do', startMs: 1_100, endMs: 1_300 },
  { word: 'roteiro', startMs: 1_300, endMs: 1_900 },
])
const SPOKEN_MISSING_WORD = Object.freeze(SPOKEN.filter((word) => word.word !== 'do'))
const SPOKEN_EXTRA_WORD = Object.freeze([
  ...SPOKEN,
  { word: 'aprovado', startMs: 1_900, endMs: 2_400 },
])

const AVATAR = 'heygen-v3'
const GENERIC_AVATAR = 'synthesia-v2'
const GENERIC_POLICY = 'synthetic-critic-thresholds/audio-avatar/v1'
const ADAPTER_POLICY = 'synthetic-critic-thresholds/audio-avatar/heygen-v3/v1'
const TTS_POLICY = 'synthetic-critic-thresholds/tts/v1'

/** Everything a take was approved to be, before it was generated. */
const CLEAN_EXPECTATION = Object.freeze({
  durationMs: 3_000,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioSampleRateHz: 48_000,
  identityRef: 'avatar_ana',
  declaredIdentityRef: 'avatar_ana',
  rights: { withinGrantedScope: true, reason: null },
  previousBlock: null,
})

const EVAL_SET = Object.freeze([
  {
    id: 'clean-take',
    why: 'a take that matches the approval in every measurable way is approved, and nothing is invented for the dimensions no model covers',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'clean.mp4',
    words: SPOKEN,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'approved',
    action: 'none',
    causes: [],
  },
  {
    id: 'muted-audio',
    why: 'a take with no measurable audio is rejected, and the fix is to ask the provider again',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'silent.mp4',
    words: SPOKEN,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'rejected',
    action: 'retry',
    causes: ['audio-silent'],
  },
  {
    id: 'frozen-video',
    why: 'a take whose picture never moves is a dead render; retrying the same adapter would repeat it, so the answer is a fallback',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'frozen.mp4',
    words: SPOKEN,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'rejected',
    action: 'fallback',
    causes: ['video-frozen'],
  },
  {
    id: 'duration-drift',
    why: 'a take two seconds longer than the approved block is rejected on its own timeline, before anything else is considered',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'long.mp4',
    words: SPOKEN,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'rejected',
    action: 'retry',
    causes: ['duration-drift'],
  },
  {
    id: 'omitted-word',
    why: 'the bytes do not say what was approved; that is the hard gate the critic exists for',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'clean.mp4',
    words: SPOKEN_MISSING_WORD,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'rejected',
    action: 'retry',
    causes: ['word-omitted'],
  },
  {
    id: 'added-word',
    why: 'an extra word is not a missing word: it is held for a person to look at, not thrown away',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'clean.mp4',
    words: SPOKEN_EXTRA_WORD,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'needs-review',
    action: 'manual-review',
    causes: ['word-added'],
  },
  {
    id: 'empty-alignment',
    why: 'with no spoken words to compare, the critic does not know whether the take said the script — and not knowing is never approval',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'clean.mp4',
    words: [],
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'evidence-unavailable',
    action: 'manual-review',
    causes: ['required-evidence-missing'],
  },
  {
    id: 'corrupt-blob',
    why: 'knowing the bytes are broken beats not knowing anything about them: the corrupt blob rejects even though the missing timeline is also reported',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'corrupt.mp4',
    words: SPOKEN,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'rejected',
    action: 'retry',
    causes: ['blob-undecodable', 'required-evidence-missing'],
  },
  {
    id: 'identity-mismatch',
    why: 'the adapter rendered a different avatar than the approved snapshot; another attempt on the same adapter would render the same one',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'clean.mp4',
    words: SPOKEN,
    expected: { ...CLEAN_EXPECTATION, declaredIdentityRef: 'avatar_outra_pessoa' },
    thresholdsVersion: GENERIC_POLICY,
    decision: 'rejected',
    action: 'fallback',
    causes: ['identity-mismatch'],
  },
  {
    id: 'outside-rights',
    why: 'a generation outside the granted rights is never a retry: a person decides, or nothing ships',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'clean.mp4',
    words: SPOKEN,
    expected: {
      ...CLEAN_EXPECTATION,
      rights: { withinGrantedScope: false, reason: 'the consent does not cover this market' },
    },
    thresholdsVersion: GENERIC_POLICY,
    decision: 'rejected',
    action: 'manual-review',
    causes: ['change-outside-rights'],
  },
  {
    id: 'silence-window',
    why: 'a pause inside a sentence is normal speech: it is reported with its range, not turned into a gate',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'gap.mp4',
    words: SPOKEN,
    expected: CLEAN_EXPECTATION,
    thresholdsVersion: GENERIC_POLICY,
    decision: 'needs-review',
    action: 'manual-review',
    causes: ['audio-silence-window'],
  },
  {
    id: 'continuity-break',
    why: 'the take is fine on its own but does not match the block before it, which is a judgement call rather than a rejection',
    capability: 'audio-avatar',
    adapterId: GENERIC_AVATAR,
    video: 'clean.mp4',
    words: SPOKEN,
    expected: {
      ...CLEAN_EXPECTATION,
      previousBlock: {
        width: 160,
        height: 120,
        fps: 25,
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
    },
    thresholdsVersion: GENERIC_POLICY,
    decision: 'needs-review',
    action: 'manual-review',
    causes: ['continuity-break'],
  },
  {
    id: 'audio-video-offset',
    why: 'the audio track is half a second longer than the picture; the controlled probe cannot confirm lip-sync but it can refuse this',
    capability: 'audio-avatar',
    adapterId: AVATAR,
    video: 'clean.mp4',
    audio: 'stretched.m4a',
    words: SPOKEN,
    expected: CLEAN_EXPECTATION,
    // The adapter-scoped policy wins over the capability-wide one.
    thresholdsVersion: ADAPTER_POLICY,
    decision: 'rejected',
    action: 'fallback',
    causes: ['lip-sync-below-threshold'],
  },
  {
    id: 'speech-only-clean',
    why: 'speech has no picture: lip-sync, identity and continuity do not apply, which is a different answer from "could not be measured"',
    capability: 'tts',
    adapterId: 'elevenlabs-tts',
    audio: 'speech.m4a',
    words: SPOKEN,
    expected: { ...CLEAN_EXPECTATION, fps: null, videoCodec: null },
    thresholdsVersion: TTS_POLICY,
    decision: 'approved',
    action: 'none',
    causes: [],
  },
])

const UNDEPLOYED = ['visual-artifacts', 'framing', 'eyes', 'teeth', 'hands']

function inMemoryReports() {
  const rows = new Map()
  const takeKey = (report) => `${report.workspaceId}|${report.blockId}|${report.artifactId}|${report.thresholdsVersion}`
  const sorted = (predicate, limit) => Object.freeze([...rows.values()]
    .filter(predicate)
    .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))
    .slice(0, limit ?? 20))
  return {
    stored: rows,
    async record({ report }) {
      for (const existing of rows.values()) {
        if (existing.reportHash === report.reportHash || takeKey(existing) === takeKey(report)) {
          return Object.freeze({ value: existing, replayed: true })
        }
      }
      rows.set(report.id, report)
      return Object.freeze({ value: report, replayed: false })
    },
    async read({ workspaceId, reportId }) {
      const row = rows.get(reportId)
      return row && row.workspaceId === workspaceId ? row : null
    },
    async readByHash({ workspaceId, reportHash }) {
      return [...rows.values()].find((row) => row.workspaceId === workspaceId && row.reportHash === reportHash) ?? null
    },
    async readByBlock({ workspaceId, blockId, artifactId, thresholdsVersion, limit }) {
      return sorted((row) =>
        row.workspaceId === workspaceId &&
        row.blockId === blockId &&
        (!artifactId || row.artifactId === artifactId) &&
        (!thresholdsVersion || row.thresholdsVersion === thresholdsVersion), limit)
    },
    async readByArtifact({ workspaceId, artifactId, limit }) {
      return sorted((row) => row.workspaceId === workspaceId && row.artifactId === artifactId, limit)
    },
    async listByProject({ workspaceId, projectId, decision, limit }) {
      return sorted((row) =>
        row.workspaceId === workspaceId &&
        row.projectId === projectId &&
        (!decision || row.decision === decision), limit)
    },
  }
}

test(`T-FR-106 ${EVAL_SET_VERSION}: the critic reaches the declared verdict on known takes`, {
  timeout: 600_000,
}, async (t) => {
  const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { evaluateSyntheticCriticService, readSyntheticCriticReportsService } =
    await import('../../src/v2/application/synthetic-critic.ts')
  const { assertSyntheticCriticReportIntegrity, SYNTHETIC_CRITIC_DIMENSIONS } =
    await import('../../src/v2/domain/synthetic-critic-report.ts')
  const { FfprobeSyntheticCriticMediaEvaluator } =
    await import('../../src/v2/infrastructure/media/synthetic-critic-media-integrity.ts')
  const { AlignmentSyntheticCriticPronunciationEvaluator } =
    await import('../../src/v2/infrastructure/media/synthetic-critic-pronunciation.ts')
  const { DeterministicSyntheticCriticControlledEvaluator } =
    await import('../../src/v2/infrastructure/media/synthetic-critic-controlled-probe.ts')

  const workspaceId = 'critic-eval-workspace'
  const audit = createExternalAuditContext({
    clientId: 'critic-eval-client',
    credentialId: 'critic-eval-credential',
    workspaceId,
    environment: 'production',
  })
  const actor = Object.freeze({
    ...audit,
    scopes: new Set(['projects:read', 'projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext: audit,
  })

  const root = await mkdtemp(join(tmpdir(), 'apollo-critic-evals-'))
  const identities = new Map()
  try {
    for (const [name, recipe] of Object.entries(FIXTURES)) {
      const path = join(root, name)
      await execFileAsync(ffmpeg, ['-y', '-v', 'error', ...recipe, path], { windowsHide: true, timeout: 300_000 })
      const bytes = await readFile(path)
      identities.set(name, { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length })
    }
    // Not a video at all: 4KiB of noise wearing an .mp4 extension.
    const corruptPath = join(root, 'corrupt.mp4')
    const noise = randomBytes(4_096)
    await writeFile(corruptPath, noise)
    identities.set('corrupt.mp4', {
      path: corruptPath,
      sha256: createHash('sha256').update(noise).digest('hex'),
      byteSize: (await stat(corruptPath)).size,
    })

    const sources = {
      async materialize({ artifactKey }) {
        const identity = identities.get(artifactKey)
        assert.ok(identity, `unknown fixture ${artifactKey}`)
        return { path: identity.path, sha256: identity.sha256, byteSize: identity.byteSize }
      },
      async cleanup() {},
    }

    const reports = inMemoryReports()
    let minted = 0
    const evaluate = evaluateSyntheticCriticService({
      reports,
      media: new FfprobeSyntheticCriticMediaEvaluator({ sources }),
      pronunciation: new AlignmentSyntheticCriticPronunciationEvaluator({
        alignment: {
          async readWords() {
            return currentWords
          },
        },
      }),
      controlled: new DeterministicSyntheticCriticControlledEvaluator(),
      clock: () => new Date(Date.parse('2026-09-01T00:00:00.000Z') + (minted += 1) * 1_000),
      createId: ({ blockId }) => `critic-report-${blockId}`,
    })

    let currentWords = SPOKEN
    const ref = (name) => {
      const identity = identities.get(name)
      return {
        artifactId: `artifact-${name.replace(/[^A-Za-z0-9]/g, '-')}`,
        artifactKey: name,
        sha256: identity.sha256,
        byteSize: identity.byteSize,
      }
    }

    for (const evaluation of EVAL_SET) {
      await t.test(`${evaluation.id} — ${evaluation.why}`, async () => {
        currentWords = evaluation.words
        const blockId = `block-${evaluation.id}`
        const subject = {
          workspaceId,
          projectId: 'critic-eval-project',
          blockId,
          capability: evaluation.capability,
          adapterId: evaluation.adapterId,
          adapterVersion: '1.0.0',
          modelRef: null,
          video: evaluation.video ? ref(evaluation.video) : null,
          audio: evaluation.audio ? ref(evaluation.audio) : null,
          alignmentArtifactId: evaluation.words.length === 0 ? null : 'artifact-alignment',
          scriptText: SCRIPT,
          expected: evaluation.expected,
        }
        const result = await evaluate({
          subject,
          profileSnapshotId: 'ana:v2',
          scriptHash: createHash('sha256').update(SCRIPT, 'utf8').digest('hex'),
          actor,
        })
        const report = result.report

        assert.equal(result.replayed, false)
        assert.equal(report.thresholdsVersion, evaluation.thresholdsVersion, 'resolved the declared policy')
        assert.equal(report.decision, evaluation.decision, 'decision')
        assert.equal(report.recommendedAction, evaluation.action, 'recommended action')

        // The cause is preserved in the issue, and it is what the action was
        // derived from — never a combined score.
        const causes = [...new Set(report.issues.map((issue) => issue.evidence.split(':')[0]))].sort()
        assert.deepEqual(causes, [...evaluation.causes].sort(), 'causes localized in the issues')
        for (const issue of report.issues) {
          assert.ok(['retry', 'fallback', 'manual-review'].includes(issue.action))
          assert.ok(issue.evidence.length > issue.evidence.split(':')[0].length + 1, 'the issue explains itself')
        }

        // Invariants that hold for every take, whatever the verdict.
        assert.equal(assertSyntheticCriticReportIntegrity(report), report)
        assert.deepEqual(report.measurements.map((entry) => entry.dimension), [...SYNTHETIC_CRITIC_DIMENSIONS])
        for (const measurement of report.measurements) {
          if (measurement.status === 'measured') {
            assert.ok(Number.isFinite(measurement.value) && measurement.unit && measurement.evidenceRefs.length > 0)
          } else {
            assert.equal(measurement.value, null)
            assert.equal(measurement.confidence, null)
            assert.ok(measurement.note && measurement.note.trim().length > 0, 'says why it carries no number')
          }
        }
        for (const dimension of UNDEPLOYED) {
          const entry = report.measurements.find((measurement) => measurement.dimension === dimension)
          assert.ok(
            entry.status === 'unavailable' || entry.status === 'not-applicable',
            `${dimension} must never be reported as measured while no model is deployed`,
          )
        }
        // A controlled stand-in is always labelled, so nobody can read it as
        // production visual validation.
        for (const measurement of report.measurements) {
          if (measurement.status !== 'measured' || !measurement.evaluatorId) continue
          const evaluator = report.evaluators.find((entry) => entry.id === measurement.evaluatorId)
          assert.ok(evaluator, 'a measured dimension names an evaluator the report carries')
          if (['lip-sync', 'identity', 'continuity'].includes(measurement.dimension)) {
            assert.equal(evaluator.kind, 'controlled')
            assert.match(evaluator.scope, /not production visual validation/)
          }
        }
        if (evaluation.decision === 'approved') {
          assert.equal(report.issues.length, 0)
        }

        // Idempotent by take: the same block, the same bytes and the same
        // published policy return the stored verdict instead of a fresh one.
        const again = await evaluate({
          subject,
          profileSnapshotId: 'ana:v2',
          scriptHash: createHash('sha256').update(SCRIPT, 'utf8').digest('hex'),
          actor,
        })
        assert.equal(again.replayed, true)
        assert.deepEqual(again.report, report)
      })
    }

    await t.test('every declared case ran, and the reports stay queryable by block and by artifact', async () => {
      assert.equal(EVAL_SET.length, 14, 'the eval set is versioned: adding or removing a case is a deliberate edit')
      assert.equal(reports.stored.size, EVAL_SET.length)

      const read = readSyntheticCriticReportsService({ reports })
      const byBlock = await read({ workspaceId, actor, blockId: 'block-muted-audio' })
      assert.equal(byBlock.length, 1)
      assert.equal(byBlock[0].decision, 'rejected')

      const byArtifact = await read({ workspaceId, actor, artifactId: 'artifact-clean-mp4' })
      // Every case that judged the clean bytes shows up against them.
      assert.ok(byArtifact.length >= 6)

      const byProject = await read({ workspaceId, actor, projectId: 'critic-eval-project', limit: 100 })
      assert.equal(byProject.length, EVAL_SET.length)

      const foreign = await read({ workspaceId, actor, blockId: 'block-that-never-existed' })
      assert.equal(foreign.length, 0)
    })

    await t.test('a take in another workspace is refused before anything is measured', async () => {
      await assert.rejects(
        evaluate({
          subject: {
            workspaceId: 'another-workspace',
            projectId: 'critic-eval-project',
            blockId: 'block-clean-take',
            capability: 'audio-avatar',
            adapterId: GENERIC_AVATAR,
            adapterVersion: '1.0.0',
            modelRef: null,
            video: ref('clean.mp4'),
            audio: null,
            alignmentArtifactId: 'artifact-alignment',
            scriptText: SCRIPT,
            expected: CLEAN_EXPECTATION,
          },
          profileSnapshotId: 'ana:v2',
          scriptHash: createHash('sha256').update(SCRIPT, 'utf8').digest('hex'),
          actor,
        }),
        /another workspace/,
      )
    })

    await t.test('a capability with no published thresholds is never judged against an improvised default', async () => {
      const { resolveSyntheticCriticThresholds } =
        await import('../../src/v2/domain/synthetic-critic-thresholds.ts')
      assert.throws(
        () => resolveSyntheticCriticThresholds({ capability: 'full-body-avatar' }),
        /no synthetic critic thresholds are published/,
      )
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
