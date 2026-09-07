# Public release decisions

F1 uses server-enforced roles, 0.90 minimum confidence for safe auto-apply, progressive proxy targets, project-lifetime master retention, 30-day reconstructable derivatives and 24-hour temporary assets. Service keys ship first; OAuth 2.1 serves delegated users. Public majors receive at least 180 days sunset. Webhooks order per resource and retain 90 days. Quotas and cost caps are versioned.

F2 defaults to six variants and caps fifty after preflight. “Validated hook” always names external source/scope/date and remains historical, not causal. URL import starts disabled; libraries remain workspace-isolated; LUT/stock require license provenance.

F3 starts with fakes, HeyGen, ElevenLabs and a Higgsfield pilot only after contract suites. Synthetic disclosure follows versioned market/channel policy.

F5 accepts owned or catalog-licensed sound with territory/channel/expiry evidence. Initial targets are -14 LUFS social, -23 LUFS broadcast and -1 dBTP, with locale profiles. Each decision record names owner, deadline, options, evidence, impact, ADR, config version and tests.

That last sentence describes a shape nothing enforces any more, and the `tests` field in it is the part that stopped being true. `validateReleaseDecisionRecord` — the function that refused a record with an empty `owner`, `due`, `options`, `evidence`, `impact`, `adr`, `tests` or a `configVersion` under 1 — was deleted with `src/v2/application/release-risk-control.ts` in commit `e8ba18e6` (2026-09-04), together with `RELEASE_DECISIONS`. The suite id those records named as their evidence, `T-DECISION-001`, names nothing that runs. So every default on this page is held by prose alone: it can drift from the configuration that actually ships without a single check failing, and re-reading this page is the only way to notice. ADR-140 records the same retraction from the other side.
