# Transformation control plane — evidence (Wave 16, F3.013–F3.016)

Written 2026-09-01. This file records what was **measured**, not what was
intended. Where evidence does not exist it says so, in the same detail as where
it does.

Nothing in this document means a task is complete. F3.013, F3.014, F3.015 and
F3.016 are all open: without final integration into `main`, deployment and the
owner's acceptance, none of them close.

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

Everything below was produced by running the command named, on this branch.

| gate | command | result |
|---|---|---|
| unit + contract suite | `npm test` | **1649 / 1649** |
| transformation registry (PostgreSQL) | `npm run test:integration:transformation-registry` | 1 / 1 |
| novelty budget (PostgreSQL) | `npm run test:integration:novelty-budget` | 1 / 1 |
| schema from an empty database | `npm run db:v2:validate` | **213 tables, 1055 indexes, 814 foreign keys** |
| public contracts | `npm run api:v1:validate` | **293 capabilities, 533 schemas, 597 examples, 240 paths** |
| UI / REST / MCP parity | `npm run api:parity:validate` | verified |
| architecture gates | `npm run lint` | verified |
| code lint | `npm run lint:code` | 0 warnings |
| domain language | `npm run domain-language:validate` | verified |
| types | `npm run typecheck` | 0 errors |
| dependency audit | `npm audit --audit-level=low` | 0 vulnerabilities |

Baseline movement across the wave, reviewed before it was normalized:
**+7 capabilities, +11 schemas, +13 examples, +7 paths. Zero removed, zero
changed.**

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

## 6. What is **not** here

This section exists because the wave is not finished and saying otherwise would
be the failure `AGENTS.md` was written to prevent.

**No combined E2E journey ran.** Neither Journey A (durability and transports
against loopback servers, with a real worker restart) nor Journey B (medieval
traffic-management with real FFmpeg media, critic rejection and a fallback
descent) exists yet. The evidence for F3.013–F3.016 today is unit, contract and
PostgreSQL-persistence — **not journey**. Every claim in this file is scoped to
that.

**No repository writes the fallback ledger or the critic report.** Their
migration is applied and validated, and their domain aggregates are covered by
13 tests, but no application service persists them yet. Under the `AGENTS.md`
rule "schema sem persistência/migration executada" this counts as scaffolding,
not as delivery.

**No `/v1` surface for F3.015 or F3.016.** The transformation control plane's
public API today covers briefs, routing and jobs only. Fallback state and critic
verdicts are not readable from outside.

**No UI.** The editor cannot show a fallback that was applied, its reason, the
accumulated cost or the four review actions. `availableFallbackActions` computes
them; nothing renders them.

**No novelty goldens with real media.** The sober / balanced / excessive
separation is proven against synthetic candidate sets, not against three
FFmpeg-produced videos.

**The critic's evaluators are not implemented.** The report *aggregate* enforces
that evaluators declare themselves honestly, but no ffprobe integrity probe, no
region differ and no controlled identity probe exist behind it. The eval set is
12 domain cases, not 10 pieces of media.

**No browser E2E, no production Next build against these routes.**

---

## 7. Honest state

| | F3.013 | F3.014 | F3.015 | F3.016 |
|---|---|---|---|---|
| specified | yes | yes | yes | yes |
| implemented (domain) | yes | yes | yes | yes |
| persisted, migration validated | yes | yes | tables only | tables only |
| integrated into the runtime | yes | yes (submission gate) | no | no |
| public `/v1` contract | yes | no | no | no |
| E2E journey | **no** | **no** | **no** | **no** |
| deployed | no | no | no | no |
| accepted by the owner | no | no | no | no |
