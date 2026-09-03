# Transformation control plane — production evidence (F3.013–F3.018)

Updated 2026-09-02. This file records what was **measured**, not what was
intended. Where evidence does not exist it says so, in the same detail as where
it does.

F3.013–F3.016 and F3.018 now meet the five-state delivery rule: implemented,
integrated into `main`, exercised end to end with real persistence/media/UI,
deployed and accepted. F3.017 remains partial: its reviewed inpaint path and
visual eval are delivered, while source separation and the direct comparison
against crop/cover/reject remain open.

---

## 1. What the wave changed, in one paragraph each

**F3.013 — durable transformation jobs.** The canonical `ProviderJob` gained
the immutable half of transport (which of the four carries the job, which brief
and routing selection it serves) as optional fields, and a separate table for
the mutable half (schedule, deadline, Retry-After, cancellation and resume
intents, MCP session). Inbound provider callbacks are verified over the exact
bytes received and consumed exactly once, durably.

**F3.014 — novelty budget.** A versioned, integer-only policy evaluated before
any paid submission, with the verdict persisted per candidate and enforced as a
gate in `requestTransformationJobService`.

**F3.015 — fallback ladder.** A canonical, versioned ladder with an append-only
decision ledger. Descending is a recorded decision with a reason, never a
mechanical step.

**F3.016 — transformation critic.** An immutable, content-addressed report over
fourteen dimensions, where a protected-content violation is a hard gate that no
aesthetic score can compensate.

---

## 2. Why `ProviderJob` was split the way it was

`ProviderJob` is content-addressed: `jobHash` covers the whole body. `nextAttemptAt`
moves on every poll. Putting it inside the hash would rewrite the job's identity
several times a minute and make `jobHash` stop meaning "this is the same job".

So the split is by **lifecycle**, not by topic:

| fact | where it lives | why |
|---|---|---|
| which transport carries the job | job body, optional field | decided once, before any paid call |
| brief and selection it serves | job body, optional field | immutable for the life of the job |
| next attempt, deadline, Retry-After | `provider_job_transport_states` | changes on every tick |
| cancellation / resume intent | `provider_job_transport_states` | operator input, compare-and-swap on `revision` |
| verified callbacks | `provider_callback_events` | append-only, consumed exactly once |

Optional is load-bearing. An absent field is absent from the canonical body, so
every synthetic job written by Waves 13 and 14 keeps the exact `jobHash` it
already had. This was verified by running the Wave 14 provider-job suite
unchanged (7/7) after the fields were added.

---

## 3. Why the novelty budget is integer-only

The requirement "changing the storage order must not change the decision" is
**not satisfiable with floating point**. Floating-point addition is not
associative: `(a + b) + c` and `a + (b + c)` can differ in the last bits, and at
a threshold that is enough to flip a candidate from accepted to blocked.

Every cost is an integer in *novelty units*, one ten-thousandth of the total
budget. `tests/v2/novelty-budget.test.mjs` evaluates the same candidate set
forward, reversed and shuffled and asserts the resulting lines are deep-equal.

Two measured consequences worth naming:

- **Cooldown is half-open.** Exactly `cooldownFrames` apart is allowed; one
  frame less is refused. Stated explicitly so the boundary is reproducible.
- **Duration is ceilinged.** 31 frames at 30fps costs two seconds. Rounding down
  would make one frame *over* a boundary cheaper than one frame *under* it.

`chargedUnits` and `densityUnits` are deliberately different numbers. A cache
hit charges zero and occupies the same screen time as a generated effect.
Collapsing them into one figure is how a video ends up visually exhausting and
technically under budget, so `treatment` reads the density and not the spend.

---

## 4. Measured numbers

Everything below was produced by the final implementation and repeated on the
merge commit before deployment.

| gate | command | result |
|---|---|---|
| unit + contract suite | `npm test` | **1672 / 1672** |
| transformation registry (PostgreSQL) | `npm run test:integration:transformation-registry` | 1 / 1 |
| novelty budget (PostgreSQL) | `npm run test:integration:novelty-budget` | 1 / 1 |
| reviewed masks (PostgreSQL) | `npm run test:integration:review-cleanup-mask` | 1 / 1 |
| real-media critic and novelty/cleanup goldens | `npm run test:integration:transformation-critic-media` | **3 / 3** |
| combined provider/worker/API/browser journey | `npm run test:e2e:transformation-production` | **1 / 1** |
| schema from an empty database | `npm run db:v2:validate` | **214 tables, 1063 indexes, 823 foreign keys** |
| public contracts | `npm run api:v1:validate` | **299 capabilities, 542 schemas, 606 examples, 244 paths** |
| UI / REST / MCP parity | `npm run api:parity:validate` | verified |
| architecture gates | `npm run lint` | verified |
| code lint | `npm run lint:code` | 0 warnings |
| domain language | `npm run domain-language:validate` | verified |
| types | `npm run typecheck` | 0 errors |
| dependency audit | `npm audit --audit-level=low` | 0 vulnerabilities |

The final public surface includes list/create/refine for cleanup masks, durable
transformation job request/read/cancel/retry, transformation-quality read and
fallback actions. Compatibility baseline movement remained additive.

**Paid provider calls: zero.** No credential for any live provider was
configured at any point.

---

## 5. Structural gates, and the reason they are tested

Six gates stand against the shapes Gate Zero removed. They live in
`scripts/transformation-architecture-rules.mjs` rather than inline in the linter
so they can be exercised directly.

That is not ceremony. The first draft of these rules reported a clean repository
because a stray control character (`0x08`, produced by a generation script where
`\b` meant backspace rather than a regex word boundary) had eaten a word
boundary. The file was syntactically valid; the regex simply matched a control
character that never appears in source. **A gate nobody has seen fire is
indistinguishable from a gate that does not work.**

`tests/v2/transformation-architecture-gates.test.mjs` exercises each rule in
both directions: it must catch the shape it exists for, and stay silent on the
shape that merely resembles it.

Calibrating against the real repository killed three rules that were too broad:

| rule as first drafted | what it flagged | resolution |
|---|---|---|
| `dedup` in an in-memory-replay pattern | `const deduped = new Map()` in hybrid search | narrowed to nonce/event vocabulary |
| `providerId === '…'` | `typeof body.providerId === 'string'` | excludes typeof-result literals |
| `status: 'approved'` near `v2ProviderJob` | the synthetic master repository's own read guard | narrowed to write calls only |

A gate that cries wolf teaches people to ignore the lint.

---

## 6. End-to-end and observable acceptance

The combined T-FR-113/114/115/116/123/218 journey starts from an immutable MP4
source and persisted rights, brief, routing, novelty decision, annotation and
reviewed mask. Each provider tick is executed by a fresh worker identity, which
proves that polling and state live in PostgreSQL rather than process memory. The
controlled HTTP boundary receives the exact source bytes and mask hash; result
bytes return through the real ingestor into content-addressed storage.

One result removes only the reviewed region and is approved. A second changes a
protected subject and is rejected despite its visual plausibility. The runtime
persists fourteen measurements, blocking issues, the best valid derivative,
both observed costs and the fallback descent. The source artifact and hash do
not change.

The browser logs in against `next start`, loads the same project through `/v1`,
shows novelty treatment, all critic dimensions, cost, ladder and review actions,
refines the cleanup mask through the public API, observes the new immutable
revision and accepts the measured result. The CI artifact
`transformation-reviewed-and-accepted.png` is the durable visual evidence.

Independent real-media goldens cover 270-frame sober/balanced/intense videos
and burned subtitle, logo and complex-background cleanup. FFmpeg/ffprobe verify
container, frames and decoded pixels; region comparison permits change only
inside the reviewed mask while protected zones remain hard gates.

Hosted evidence: PR CI `33662647886`, feature merge CI `33664477610`, deploy
hotfix PR CI `33667530939` and hotfix merge CI `33669465697`. Production runs
`apollo-video:b0cd3e1` from `b0cd3e17`, with 192 migrations, a healthy app and
five workers observed with zero restarts and zero OOM after the stability
window. Immediate recovery backup:
`apollo_video_v2-20260902T190458Z.dump`.

---

## 7. Honest state

| | F3.013 | F3.014 | F3.015 | F3.016 | F3.018 |
|---|---|---|---|---|---|
| specified | yes | yes | yes | yes | yes |
| implemented | yes | yes | yes | yes | yes |
| persisted, migration validated | yes | yes | yes | yes | yes |
| integrated into the runtime | yes | yes | yes | yes | yes |
| public `/v1` contract | yes | yes | yes | yes | yes |
| E2E journey | yes | yes | yes | yes | yes |
| deployed | yes | yes | yes | yes | yes |
| accepted | yes | yes | yes | yes | yes |

---

## 8. Reviewed cleanup masks and remaining F3.017 boundary

The local Wave 17 slice replaces the earlier `annotationToMask` fixture with a
runtime boundary. `review-cleanup-mask/v1` is immutable and content-addressed;
it binds one open regional annotation to the exact proxy, source artifact,
project version, TransformationBrief and output format. Refinements append a
revision under the same root and use both an expected hash and latest-revision
check. Format reprojection is explicit and remains `uncertain` until reviewed.

Masked transformation modes now require the latest stored mask before the job
exists. Submission is refused when protected regions overlap, source or brief
hashes drift, output format differs, tracking is uncertain or confidence is
below policy. The provider projection excludes screenshot, review copy and
author identity. The common submission materializer now accepts transformation
jobs and revalidates the authorized source immediately before the adapter call.

The final journey added the missing browser, source-byte materialization,
derivative MP4, critic, fallback, deployment and acceptance evidence. F3.018 is
therefore complete. F3.017 closes the pre-job mask/preserve/threshold boundary,
immutable derivative storage and the three-case visual eval. A subsequent local
slice implements a provider-bound source-separation adapter and the measured
comparison against crop, cover and reject in the source-cleanup pipeline. Those
two microtasks remain open until their PostgreSQL/CI, merge, deploy and owner
acceptance gates complete.

No paid provider credential was used. HTTP and MCP adapters ran at their real
contract boundaries against controlled loopback implementations, so transport,
bytes, retry/callback semantics and persistence were exercised without claiming
a live commercial-provider smoke.
