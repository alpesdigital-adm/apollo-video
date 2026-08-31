# ADR-147 — The synthetic critic reports evidence, not scores

A synthetic result is judged by an immutable, content-addressed
`synthetic-critic-report/v1`, localized by block and range, that records exactly
which bytes were evaluated, which evaluators ran, what each one measured, which
thresholds applied, where the problems are and what should be done about them.

The aggregate enforces one rule above all others: **a report must answer for
every dimension**. Lip-sync, identity, pronunciation, visual artifacts, framing,
continuity, eyes, teeth, hands, temporal integrity and audiovisual integrity each
carry `measured`, `not-applicable` or `unavailable` — silence about a dimension
is rejected at construction. A measured dimension must name an evaluator listed
in the report, carry a finite value with its unit, and reference its evidence. A
dimension that was not measured must carry no value and no confidence, and must
say in words why. PostgreSQL enforces the same rules with CHECK constraints, so
a dishonest report cannot be written even by bypassing the domain.

Every evaluator declares its kind. `measured` means an instrument read the number
from the artifact — FFprobe and FFmpeg for duration, codecs, frames, audio
presence and freezes; an alignment comparison for words omitted or added against
the approved script. `controlled` means a named deterministic probe standing in
for a perceptual model that is not deployed, with a scope that says so. The kind
travels with the report because a controlled probe read as production visual
validation is exactly the kind of claim that caused the incident this repository
exists to prevent. Dimensions with no model at all — visual artifacts, framing,
eyes, teeth, hands — are `unavailable` with a written reason, not zero and not
one.

`evidence-unavailable` is therefore a decision of its own, and explicitly not
approval: not knowing is not the same as knowing it is fine. A capability that
requires a dimension and receives it as unavailable fails closed. Approval must
be clean — no blocking issue, no recommended action — while any other decision
must say what to do, a rejection must localize at least one issue, and
evidence-unavailable must point at the dimension it could not evaluate.

The action follows the cause, never an aggregate score. A shared cause table maps
each failure to retry, fallback or manual review, and the cause is written into
the issue evidence so the reason a block is being retried survives to whoever
reads it later. Averaging six ratios into a number, which is what the removed
`evaluateSyntheticBlock` did, cannot tell a silent audio track from a wrong face.

Criticism gates the rest of the system rather than decorating it. A master can
only be sealed by a persisted approved report; a rejected, needs-review or
evidence-unavailable result never becomes a master and never becomes an eligible
cache candidate. Retry affects only its own block, the previously valid artifact
is preserved, and no new provider call happens without a durable decision and a
policy that allows it.
