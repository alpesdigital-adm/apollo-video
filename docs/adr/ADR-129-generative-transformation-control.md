# ADR-129 — Generative transformation control plane

Transformation intent is stored in a provider-neutral brief with protected content, allowed changes, novelty and an explicit fallback ladder. A capability registry routes jobs by policy, health, limits, region, cost and quality. API, webhook, polling and MCP share the same durable job model and callback protection.

Generated results never replace source assets. The critic rejects protected changes even when visual quality is high; novelty is budgeted across narrative windows; reviewed masks require adequate tracking confidence before paid cleanup. Every failure descends through v2v, composite, cutaway and unchanged only while the original intent remains satisfied.

## Wave 16 — what was decided in implementation

Four decisions were taken while implementing F3.013–F3.016 and are recorded here
because each closed a question this ADR left open.

**The durable job splits by lifecycle, not by topic.** `ProviderJob` is
content-addressed, so the immutable half of transport — which of the four
carries the job, which brief and selection it serves — joins the job body as
optional fields, while the schedule (next attempt, deadline, Retry-After,
cancellation and resume intents, MCP session) lives in its own table with
compare-and-swap on a revision. A field that changes on every poll cannot sit
inside a hash that means "this is the same job". The fields are optional so that
every synthetic job written by Waves 13 and 14 keeps the exact hash it had.

**Callback verification runs over the exact bytes, and the nonce is durable.**
The replaced implementation guarded replay with an in-memory set that a restart
emptied, which made every replayed callback look new again. Consumed events are
now rows, keyed by (workspace, provider, event id) through a partial unique
index that only accepted events claim — a rejected callback must not be able to
burn an event id and lock out the genuine delivery. The same event id with the
same bytes is a duplicate delivery; with different bytes it is a replay attempt.

**The novelty budget is integer-only, and that is a correctness requirement
rather than a style choice.** The policy must yield the same verdict regardless
of the order candidates are read in, and floating-point addition is not
associative. Costs are integers in novelty units. Two amounts are tracked per
candidate and are deliberately not the same number: what the budget paid (zero
for a cache hit) and how much screen the effect occupies (identical either way),
because a reused effect is free to produce and not free to watch.

**A protected-content violation is terminal, not a score.** The critic's hard
gate can only produce a rejection, enforced in the aggregate and again by a
PostgreSQL constraint, and the fallback ledger refuses to name a violating
artifact as its best at any intent score. Evaluators declare themselves as
`measured` or `controlled`, and a controlled detector is never described as a
production visual evaluation.

State after production acceptance on 2026-09-02: F3.013–F3.016 and F3.018 are
implemented, integrated, exercised end to end, deployed and accepted. The
reviewed inpaint path, immutable derivative and visual eval also close three of
five F3.017 tasks. Source separation and the measured comparison against
crop/cover/reject remain explicitly open. The complete evidence and operational
boundaries are recorded in `docs/quality/transformation-control-plane-v1.md`.
