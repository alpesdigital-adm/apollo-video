# ADR-134 — Platform foundation and parity

Development infrastructure uses isolated PostgreSQL 16, MinIO S3-compatible storage and the same durable operation/checkpoint model as production. A deterministic vertical smoke crosses upload, normalization, static plan, proxy render and reconstruction with shared trace/workspace/project/job context.

The hosted CI run `30759468720` is the first fully green F0.030 vertical proof. It uses PostgreSQL 16/pgvector and real FFmpeg to cross verified upload, durable ingest, an immutable source-ingest EditPlan, Director planning, an explicit project LUT `none` Command, trusted color compilation, proxy enqueue, worker rendering, promotion, canonical manifest and RenderElementMap. The controlled transcript keeps the test deterministic; local filesystem storage is used by this smoke, so MinIO/object-storage reconstruction and the combined Compose runtime remain separate open gates.

The parallel `Isolated Compose infrastructure` job became green in run `30759955783`: it boots the repository's pinned PostgreSQL and MinIO Compose definitions with fail-closed credentials and loopback ports, migrates a clean database, verifies the expected public-table floor, confirms bucket versioning, performs a byte-exact object write/read and always removes containers, networks and volumes. This proves the isolated database and object-storage provisioning items; it does not yet prove the combined app/worker Compose topology or reconstruction after process restart.

Run `30760710159` extends that gate through the combined supervised topology. After clean migrations and the versioned-object round-trip, Compose builds one V2 image and starts the API plus ingest, render, webhook and long-form workers; the gate verifies API health, every container in `running`, restart policy `unless-stopped`, and unconditional teardown of containers, networks and volumes. The proof exposed a real ESM/CJS import incompatibility that made the long-form worker restart after initial health and now guards that boot contract. It concludes isolated durable-workflow provisioning, but does not claim proxy reconstruction from persisted state after restart.

Local PostgreSQL and MinIO publish only on explicit loopback ports and require
operator-supplied secrets. PostgreSQL uses a dedicated volume and a bounded
Prisma pool. MinIO initializes one declared bucket idempotently and enables
object versioning before the environment is considered ready. A dependency-free
`infra:validate` gate protects these invariants in CI even when Docker is not
available; passing that gate does not claim that containers, migrations or S3
I/O were executed. CI uses that exact pinned PostgreSQL 16 + pgvector image so
the clean migration run cannot silently drift to a server without `vector`.

The disposable local runtime composes that database and versioned bucket with
one immutable application image. A one-shot migration service must complete
before the API and the ingest, render, webhook and long-form workers start.
Every long-running process has PID 1 supervision, restart policy, graceful stop
and shared persistent artifact/work volumes. Static validation proves the
topology contract; it is not evidence that Docker boot or lease recovery ran.

Foundation data is never manufactured as a ready Source. Workspace/client
bootstrap is followed by an idempotent project-source seed that calls the same
project creation and media upload application services as the public API. The
OutputSpec lives in the immutable brief snapshot. A real, rights-confirmed
master must pass byte count and SHA-256 verification, then a durable ingest
operation must finish and persist both source-master and editing-proxy
relationships before the seed reports success. A queued operation alone is not
seed completion.

Deterministic media evidence belongs to CI as explicit jobs rather than the
default unit-test discovery. The hosted workflow runs the editorial renderer,
retimed-transcript worker and two-hour contiguous extraction goldens with real
FFmpeg. Each golden must materialize the current color compilation contract and
assert observable frame, pixel, duration or audio outcomes; a smoke render
alone is insufficient.

Code lint is a separate CI gate from the Apollo architecture boundary scanner.
It uses ESLint 9 with the official Next 16 core-web-vitals and TypeScript flat
configs over application, scripts and tests, and permits no warnings. Stable
Next, Hooks, JavaScript and TypeScript safety rules remain enabled. React
Compiler-only purity/ref/effect/memoization heuristics and the noisy
unused/explicit-any/empty-object rules are excluded until their underlying
patterns can be migrated without a UI rewrite; architecture, typecheck and
domain-language gates continue to cover their respective invariants.

Durable public-operation telemetry is emitted through an application port, not
from domain code. The production repository factory decorates operation
lifecycle writes and emits a closed `public-operation-telemetry/v1` JSON
envelope for creation/replay, claim, heartbeat, phase changes, waiting/resume,
retry, cancellation, success and failure. The trace is deterministic from the
workspace and operation identities, the operation ID is the job ID, and project
ID is included only when the persisted operation context has that relationship.
Type, status, phase and attempt are allowed; editorial payloads, file names,
transcripts, URLs and artifact identities are structurally absent. Telemetry is
best-effort and may never change the durable result. This is the worker-runtime
foundation only: inbound request trace propagation, provider/renderer spans,
complete metrics, dashboards and acceptance remain open under T-NFR-003.

Canonical persisted documents must be compared with canonical serialization,
never JavaScript insertion order. Hosted API integration exposed this at the
project LUT impact boundary after the command-type constraint was corrected:
the stored impact had identical content and hash but alphabetized keys. The
hydrator now revalidates with `stableSerialize`, and a regression test performs
the same canonical persistence round-trip.

OIDC-verified identities become signed, expiring workspace sessions; production never trusts an unverified local identity. Workspace switching invalidates caches and subscriptions. Architecture imports are enforced by a CI boundary check. UI actions, REST endpoints and tests map through capability IDs, while sensitive internals have explicit deny-only reasons.

Public operations generalize across ingest, Director, provider, sync, batch, render and export. Public conventions, deprecation/sunset headers, client kill switches and transition outbox events are stable application contracts.
