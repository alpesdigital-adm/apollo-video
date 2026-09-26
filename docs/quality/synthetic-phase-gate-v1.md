# Synthetic phase gate v1

## Status

Domain evaluator, immutable PostgreSQL persistence, the authoritative W24.2
collector for provider execution and master catalogues, and the authenticated
public run/list API are implemented locally. W24.3 adds the canonical synthetic
render operation, protected compiler input, Remotion worker, MP4 inspection,
technical quality report, build attestation persistence and cross-project
master-consumption lineage. The controlled W24.3 PostgreSQL/render/browser
journey passed locally with the honest partial gate described below.
Provider-live execution, production deployment and acceptance are still open;
CI for the current W24.3 commit is reported by the PR checks. All W24.2
local gates listed below passed under Astra supervision, and CI run
`35859804992` passed both jobs at `46cae59d81916f597f47b50a077682e5413261a4`.
Wave 25 adds only the editor history of the last 20 evaluations, recorded in
its own section below; it changes no gate, API or acceptance. Wave 27 adds only the inline reading
of the critic report a gate references, also in its own section, and changes
nothing else either. This
document is not an approval record or a production acceptance record.

## Purpose

`synthetic-phase/v1` prevents the F3 synthetic gate from being approved because
provider adapters, fakes or isolated tests happen to exist. Approval requires
all four criteria and all eight checks below to be backed by typed, hashed,
server-owned resources.

| Criterion | Required checks |
| --- | --- |
| `F3-GATE-001` | ElevenLabs audio+alignment live; HeyGen avatar from generated audio live; HeyGen avatar from ready audio live |
| `F3-GATE-002` | approved blocks catalogued; cross-project reuse with zero provider work |
| `F3-GATE-003` | transformation rejected before fallback; fallback result approved |
| `F3-GATE-004` | provider swap keeps EditPlan and renderer contracts |

## Fail-closed rules

- Every criterion and check is exhaustive and unique.
- Every reference has an opaque ID and SHA-256 digest.
- Each check requires specific evidence resource types; a generic artifact is
  not interchangeable with alignment, cache, critic or render evidence.
- Failed checks remain covered but do not pass.
- Missing resource types make the criterion uncovered and failed.
- Input order does not change the report fingerprint.
- Output contains no provider credential, request body or download URL.
- The evaluator labels its normalized evidence as server evidence; the
  application service derives the input from PostgreSQL rather than accepting
  evidence from the public request.
- A controlled adapter receipt is never provider-live evidence. Provider-live
  checks require the exact native adapter, transport observations, receipt,
  result ledger, critic report, current policy, presenter consent and artifact
  rights to agree with the same job and attempt.
- A report produced by the current policy can prove a covered failure. Missing,
  foreign, corrupted or cross-context sources are omitted and remain visible
  through `missing`, `missingChecks` and `missingEvidenceTypes`.
- The gate reads a repeatable snapshot and re-reads actor, version, evidence,
  current consent and rights in the serializable commit. A concurrent change
  refuses the new gate instead of preserving a stale positive.
- Normalized missing checks are report output. Hydration omits their empty
  reference rows only while re-evaluating, then compares the entire stored
  report and record hashes.

## Build attestation boundary

The internal W24.2 attestation runner owns a fixed check set for architecture,
domain language, provider swap and compiler/render contracts. It captures log
digests and verifies a clean Git tree, commit, contract graph, toolchain and the
materialized Remotion bundle before and after execution. Abort and timeout stop
the owned process tree before the runner returns.

W24.3 persists the attestation only against the exact render operation,
checkpoint, manifest, plan snapshot and runtime identity. The render worker
does not execute build checks: a separate local/CI service runs them while the
operation waits without a lease, and the next worker claim revalidates current
authority before completing the operation and production run atomically.
Production hosts therefore cannot run validation builds through the render
worker. The controlled W24.3 journey proved these bindings against a clean
attested checkout and supplied the server-owned evidence for `F3-GATE-004`;
that controlled attestation is not provider-live or production acceptance.

## Public API

- `POST /v1/projects/{projectId}/synthetic-phase-gates` requires
  `projects:write` and `Idempotency-Key`. Its closed body contains only
  `projectVersionId` and `projectVersionHash`.
- `GET /v1/projects/{projectId}/synthetic-phase-gates` requires
  `projects:read` and accepts only an optional integer `limit` from 1 to 100.
- Both operations bind the authenticated actor to the requested workspace.
  The response omits the idempotency key and request fingerprint while
  preserving `missing`, `failed`, `missingChecks` and
  `missingEvidenceTypes`.
- Replay of the same request returns the original immutable record. Reusing a
  key with a different request is rejected.

## Local W24.2 verification checkpoint

The following results were measured locally on 2026-09-23:

- `w24-2-build-fixed.log`: the production build passed. Typecheck, ESLint,
  domain-language, architecture and public API parity passed in their separate
  `w24-2-typecheck`, `w24-2-eslint`, `w24-2-domain-language`,
  `w24-2-architecture` and `w24-2-api-parity` logs. The generated public
  surface contained 371 capabilities, 647 schemas, 713 examples and 302 paths,
  with its compatibility baseline intact.
- The schema/migration verifier reported the expected structural inventory of
  287 tables, 1,322 indexes and 984 foreign keys. These numbers are verifier
  output, not an independently observed `pg_catalog` count.
- `w24-2-gate-http-catalogue-fixed-46ee1a83`: gate, authenticated HTTP API and
  catalogue batch passed 3/3.
- `w24-2-provenance-final-6eca6ab7`: provider execution provenance passed 1/1.
- The initial consumer batch `w24-2-consumers-provider-718c4eb4` passed block
  generation, cache decision, cache invalidation, master asset and
  transformation, 5/8. Its three failures exposed tsx interop in block
  compilation, missing result-artifact ingestor wiring in provider-avatar and
  an adapter configuration mismatch in synthetic production.
- The rerun `w24-2-consumers-provider-fixed-c78007c5` passed block compilation
  and provider-avatar, 2/3. Production reached an approved job after the
  configuration fix, then failed only because its exact call assertion omitted
  the legitimate final `capabilities` read used by the receipt.
- `w24-2-production-final-d42ed0c0`: synthetic production passed 1/1 with the
  canonical adapter configuration recorded in its receipt lineage and an exact
  call sequence that proves one `submit` plus the final `capabilities` read.
- `w24-2-full-unit-final.log`: the complete unit suite passed 2,467/2,467, with
  zero failures and zero skipped tests.
- Every PostgreSQL run above completed its supervised cleanup with zero
  backends for the run application name, the cluster stopped, its port free
  and no owned process left in CIM.

These results prove the local W24.2 implementation and controlled PostgreSQL
integration. The catalogue proof is intentionally partial: it covers the
approved master and speech-segment catalogue path, while the consuming render
lineage needed for cross-project reuse, fallback and provider swap belongs to
W24.3. W24.2 CI run `35859804992` passed both jobs. No live provider execution,
completed W24.3 render journey, reviewed final MP4, merge, deployment, product
acceptance or TODO closure is claimed by W24.2.

## Local W24.3 verification checkpoint

The supervised run `w24-3-full-journey-c2645167-551e8a1f` passed 1/1 in 183 s
at `c26451670c6a1c9cec36aa97d085b70edbc07359`. It exercised PostgreSQL, public
API, workers, artifact storage with the local driver, the canonical compiler, Remotion and the real
editor panel. Render A ended at
`ebdb51f115709248f421038ba32983d2da33ac994b672ad3f567d9adb882e03e`; render B
ended at `93c99df84c89813914e5fd97a6297b4d58f74881b4ca83e408d5db3e078d39cb`.
Both passed full decode and ffprobe measured 1080×1920 H.264, 60 frames over
2 s, with AAC lasting 2.048 s. The retained frames show `Olá` at 0.25 s,
`mundo` at 1.25 s and the disclosure at the top; B separately shows B-roll at
0.75 s and the overlay at 1.75 s. This is frame inspection and full technical
decoding, not a claim that a person watched the two complete MP4s.

B consumed the exact approved full master from A with a different composition
and zero provider jobs, budget reservations or transport submits in the
consumer project. The fallback chain persisted the rejected result, the
server-owned reroute, the approved result and the human decision. The API and
browser read the same immutable report: 3/4 criteria and 5/8 checks, with
`approved=false` and all three live-provider checks missing. The supervisor
observed 68 owned process identities and ended with zero alive, zero database
backends, the cluster stopped, port 55571 free, scratch removed and no cleanup
errors. The complete unit suite at the preceding checkpoint passed 2,519/2,519;
the static gates and application/Remotion builds also passed locally.

## Wave 25 — history of the last 20 evaluations in the editor

Scope of the change: only `src/components/SyntheticPhaseGatePanel.tsx`, the
pure module `src/v2/ui/synthetic-phase-gate-history.ts` it delegates to, the
browser helper/journey and this document. The public API, persistence,
contract, domain, authorization, idempotency and `EditorReads` are unchanged;
no endpoint, capability, schema, migration, deep link, export, comparator or
dependency was added. `docs/quality/ui-capability-parity-report.json` was
regenerated because the panel's POST call site moved one line.

Behaviour, as implemented and proven:

- The panel reads `GET /v1/projects/{id}/synthetic-phase-gates?limit=20` (it
  used to request 100 and keep one) and shows the list **in the order the
  server returns it** (`createdAt desc, id desc`); it never sorts locally and
  never shows more than twenty. Gate ids are random, so recency is a property
  of the received order, not of the id.
- A native, labelled `<select>` lists every evaluation with its date, version
  and state (approved, failed, incomplete). The first gate of the server order
  is selected on load and again after a full reload. Selecting an entry is a
  pure state change: it issues no request, starts no render, provider,
  operation or job.
- Everything visible — summary, the eight checks, references and their
  addresses, `reportFingerprint`/`recordHash`, version and date — derives from
  the single selected gate and changes together.
- Exactly one of three labels accompanies the selected gate: the latest of the
  current version; a historical evaluation of the **same** version (never
  called obsolete); or an evaluation whose `projectVersionId` **or**
  `projectVersionHash` differs from the editor's current props. A permanent
  note states that the verdict belongs to the selected snapshot and that no
  historical evaluation equals approval of the current version.
- "Avaliar versão atual" fires only on an explicit click and always posts the
  editor's current `projectVersionId`/`projectVersionHash`, whatever is
  selected. On success the returned gate is inserted (or, on an idempotent
  replay, replaced in place), selected and pinned; the canonical list is then
  re-read and reconciled, and a late response cannot move the selection away
  from a gate that is still listed. The idempotency key stays bound to the
  props identity, is reused after an uncertain HTTP result and reset after
  success, as before.

Evidence for Wave 25, kept separate from the W24 acceptance record above:

- Unit: `tests/v2/synthetic-phase-gate-history.test.mjs` (cap, insert/replace,
  pinned reconciliation, three-way classification) and a structural guard in
  `tests/v2/project-editor-ui.test.mjs` (`limit=20`, no local sort, the
  history identifiers, the POST body from props); the full unit suite passed
  2,528/2,528 with none skipped (2,520 before this wave).
- Browser, real (PostgreSQL, public API, workers, artifact storage with the
  local driver, Chromium, authenticated editor), inside
  `tests/v2/synthetic-wave24-journey.e2e.mjs`: three evaluations of the same
  project and version were persisted through the canonical POST as the
  journey's API client — before any render (1/4 criteria, 3/8 checks: the
  reuse and provider-swap checks are absent because both are read from the
  consumer's attested render), after the renders (3/4, 5/8) and a repeat after
  the renders (3/4, 5/8 with a new id, `recordHash` and `createdAt`). The
  editor read `?limit=20`; its options equalled the API list, ids and order;
  the newest gate was selected by default and again after a page reload;
  selecting the older gates changed summary, verdict, the eight check states,
  references with their hashes, fingerprint, record, date and version
  together, each compared with that gate's API record; the historical label
  appeared and the stale label did not; **zero** page requests and no change
  in the editor's read counters during a 1.5 s window after each selection;
  with the oldest gate selected, "Avaliar versão atual" posted the editor's
  current version and hash, the returned gate became the selected one and the
  list grew from 3 to 4. The database held exactly four gates afterwards,
  none of them controlled.
- Browser, controlled transport (`page.route` answers on the same
  authenticated page, labelled `controlled-transport` in the evidence and
  never reaching the server): identical `createdAt` answered in both orders
  keeps the received order — a proof that the UI does not re-sort, not a
  statement about PostgreSQL ordering; 25 gates answered render exactly 20
  options; a gate of another version/hash shows the stale label and never the
  historical one — not an end-to-end proof of a real version change; a POST
  that times out is retried with the same idempotency key and a later POST
  after a success gets a new key, every body carrying the editor's version;
  GET 403 and 429 show the failure text and a retry with no gate data, and 401
  redirects to `/login`; an A→B→A navigation with B's read held back rendered
  no B data under A — on the real page the editor remounts on project change
  and the browser aborted B's request, so that protection is the unmount, not
  the panel's own fence.
- Local supervised runs (throwaway PostgreSQL 16, pool of one, Chromium): three
  runs by the executor during development passed in 134.9 s, 88.1 s and
  89.8 s, and a fourth run by the coordinator on the final code commit
  `cea5e659` passed 11/11 (the journey and its ten W25 subtests) in 136.2 s
  with 59 observed process identities and none alive at the end. Four runs,
  88.1–136.2 s, each ending with zero database backends, the cluster stopped,
  port 55571 free and the scratch removed, with no cleanup errors.
- Screenshots retained with the evidence: the selector, its options, the
  historical state, the divergent (controlled) state and the panel.
- CI: the two jobs for the PR head commit are reported by the PR checks; the
  Isolated Compose job runs this journey and publishes its evidence. As with
  W24.3 above, no CI run id is recorded in this document.

What Wave 25 does not claim: no evaluation in the history approves the
current version; the W24 gate remains 3/4 criteria and 5/8 checks with
`approved=false` and the three live-provider checks absent; no live provider,
merge, deployment, owner acceptance or TODO closure.

## Wave 27 — inline viewer of the referenced transformation critic report

Scope of the change: `src/components/SyntheticPhaseGatePanel.tsx` (the
`transformation-critic-report` reference now carries the existing link,
labelled "Abrir JSON", and a "Ver relatório" button), the new small client
component `src/components/TransformationCriticReportViewer.tsx`, the pure
module `src/v2/ui/transformation-critic-report-view.ts`, focused unit tests,
the browser helper/journey and this document. No page, API, schema,
migration, dependency, provider, chart, video seek, comparison, export or
accept/evaluate action was added; the gate calculation, its state, the
authorization, the `EditorReads` coordinator and `TransformationReviewPanel`
are unchanged. `docs/quality/ui-capability-parity-report.json` was regenerated
because the panel's POST call site moved one line; the parity scanner records
only reads made on a variable named `reads`, so the viewer's `props.reads.read`
is not listed there, exactly like the panel's own reads.

Behaviour, as implemented and proven:

- "Ver relatório" appears only for a `transformation-critic-report`
  reference whose exact capability
  `apollo.projects.transformation-critic-reports.get` is published to the
  session; the address is the canonical one from
  `addressSyntheticPhaseGateReference`, never built from report content.
  "Abrir JSON" keeps pointing at the same public GET.
- The click issues one GET through the existing session and `EditorReads`
  (own identity/visibility fence; no `setScope`, `abortAll` or invalidation
  of other reads). Opening, closing, retrying and selecting another history
  entry never POST. A repeated click during the load does not stack requests.
- Before anything is shown, `report.projectId` must equal the gate's
  project and `report.id`/`report.reportHash` must equal the reference's
  id/hash (the reference carries no `projectId`; the report carries no
  `projectVersionId`, and no such link is invented). The client never
  recomputes the hash; the backend already revalidates the record. A mismatch
  closes the reading and shows an error with no partial data.
- The reading shows the decision, the suggested action as a recorded
  suggestion that nothing executes, the evaluation date, the hard gates
  (an empty list is stated not to mean approval), each measurement with
  dimension, `measured` / `not-applicable` / `unavailable`, score and
  threshold in basis points (`null` renders as "indisponível", never as
  zero), its note and its origin resolved by `evaluatorId` (`measured` as a
  real measurement, `controlled` as a controlled proof, never as a real
  visual evaluation), the overall scores only when present, and each issue
  with severity, dimension, description and its range in frames (never
  converted to seconds). Ids, hashes and lineage sit in an expandable
  technical details block. All dynamic text is rendered by React; no HTML,
  link or identity is derived from the response.
- The viewer closes and clears when the gate, project, version or hash of
  the editor changes, when the capability is no longer published, on manual
  close and on unmount; a late answer after any of those is discarded.
- Errors have their own state and an explicit retry: 401 follows the session
  flow, 403 shows the refusal, 429 shows the coordinator's remaining wait,
  and a missing report on the existing route is 422 `ASSET_NOT_FOUND`. No
  old report stays on screen after an error; the JSON link stays available.

Evidence for Wave 27, kept separate from the W24, W25 and W26 records:

- Unit: `tests/v2/transformation-critic-report-view.test.mjs` (reference match
  with each of project, id and hash diverging; `null` basis points render
  `indisponível` and never `0 bps`; frames label; evaluator origin measured,
  controlled and missing; failure texts), the 422 `ASSET_NOT_FOUND`
  classification added to `tests/v2/editor-reads.test.mjs`, and a W27
  structural guard in `tests/v2/project-editor-ui.test.mjs` (labels, testids,
  read name, identity match, fence, `/login`, and the absence of
  `dangerouslySetInnerHTML`, `fetch(`, `setScope(`, `abortAll(`, `invalidate(`
  and `canonical-hash` in the viewer). The full unit suite passed 2,541/2,541
  with none skipped (2,532 on `main`).
- Browser, real (PostgreSQL, public API, workers, artifact storage with the
  local driver, Chromium, authenticated editor) inside
  `tests/v2/synthetic-wave24-journey.e2e.mjs`, after the W25 steps and on the
  history they leave behind: the newest gate of the project that holds the
  persisted rejected critic report lists that reference with the record's id
  and hash, "Abrir JSON" at the canonical address and "Ver relatório", and no
  other reference carries a control; opening issued exactly one GET to the
  report URL and no POST, with the editor URL, the selected gate and the
  history unchanged; every rendered field was compared with the record read
  over the API by the journey actor (the same record the W26 step reads) —
  decision `rejected`, action `fallback`, the evaluation date, the
  `preserve-list` hard gate, all fourteen measurements with status, scores
  and thresholds (`indisponível` for null), notes, frame ranges and the origin
  resolved by `evaluatorId` (measured versus controlled), the overall scores,
  the blocking issue in frames 0–60 with its violated preserve, and the
  thirteen technical fields — and the viewer contained no link; "Fechar"
  closed it, reopening issued a second GET with the same hash and the button
  toggled it closed; choosing an older evaluation closed the viewer with zero
  requests in the 1.5 s window and it did not reopen on returning to the
  newest; the database counts of critic reports, measurements, issues, gates
  and evidence rows were identical before and after.
- Browser, controlled transport (`page.route` on the report URL only, on the
  same authenticated page, labelled `controlled-transport` in the evidence
  and never reaching the server; refusals shaped with the route's own codes
  `AUTH_SCOPE_REQUIRED` and `GOVERNANCE_LIMIT_EXCEEDED`): 403 showed the
  refusal with no report id and, after the intercept was removed, an explicit
  retry read the real report; 429 with `Retry-After: 2` showed the wait, an
  immediate retry was refused locally by the coordinator without any request
  and a retry after the wait read the real report; a 422 `ASSET_NOT_FOUND`
  envelope showed the not-found error with no data; the same record answered
  with `projectId`, `id` or `reportHash` changed showed the identity error
  each time and no report data at any point; an answer held until after
  "Fechar" rendered nothing; A→B→A across history entries (the journey's
  second project has no gate) with the older entry's answer held rendered no
  B data under A — the viewer unmounts on the switch, as in W25; 401, run
  last, redirected to `/login`. Every controlled step recorded zero POST.
- Local supervised runs (throwaway PostgreSQL 16, pool of one, Chromium):
  the journey passed 25/25 (the W24.3 journey, ten W25 subtests, one W26
  step and thirteen W27 subtests) in four runs — three by the executor during
  development (journey 115 s, 101 s and 100 s, the last two on the final code
  commit `3b65fcab`) and one by the coordinator on that commit (106.4 s, 60
  observed process identities, none alive at the end) — each ending with zero
  database backends, the cluster stopped, port 55571 free, no owned process
  alive and the scratch removed, with no cleanup errors.
- Screenshots retained with the evidence: the open viewer on the real
  rejected report and an error state.
- CI: the two jobs for the PR head commit are reported by the PR checks; the
  Isolated Compose job runs this journey and publishes its evidence. As with
  W24.3 and W25 above, no CI run id is recorded in this document.

Limitations and what Wave 27 does not claim: the viewer reads an existing
record and changes nothing about the gate — the F3 gate remains 3/4 criteria
and 5/8 checks with `approved=false` and the three live-provider checks
absent; a controlled evaluator shown in the viewer is a controlled proof,
not a real visual evaluation; controlled transport cases prove the viewer's
handling, not the real report; no live provider, merge, deployment, owner
acceptance or TODO closure.

## Remaining integration

The local checkpoint did not include W24.3 CI; consult the PR checks for the
current commit. A separately authorized live run must traverse the production
provider services before the three `F3-GATE-001` checks can pass.
Adapter names, controlled receipts and controlled PostgreSQL evidence do not
prove provider-live acceptance. Merge, deployment, owner acceptance and TODO
closure also remain open; no F3.019 acceptance is claimed here.
