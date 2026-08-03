# ADR-134 — Platform foundation and parity

Development infrastructure uses isolated PostgreSQL 16, MinIO S3-compatible storage and the same durable operation/checkpoint model as production. A deterministic vertical smoke crosses upload, normalization, static plan, proxy render and reconstruction with shared trace/workspace/project/job context.

The hosted CI run `30759468720` is the first fully green F0.030 vertical proof. It uses PostgreSQL 16/pgvector and real FFmpeg to cross verified upload, durable ingest, an immutable source-ingest EditPlan, Director planning, an explicit project LUT `none` Command, trusted color compilation, proxy enqueue, worker rendering, promotion, canonical manifest and RenderElementMap. The controlled transcript keeps the test deterministic; local filesystem storage is used by this smoke, so MinIO/object-storage reconstruction and the combined Compose runtime remain separate open gates.

The parallel `Isolated Compose infrastructure` job became green in run `30759955783`: it boots the repository's pinned PostgreSQL and MinIO Compose definitions with fail-closed credentials and loopback ports, migrates a clean database, verifies the expected public-table floor, confirms bucket versioning, performs a byte-exact object write/read and always removes containers, networks and volumes. This proves the isolated database and object-storage provisioning items; it does not yet prove the combined app/worker Compose topology or reconstruction after process restart.

Run `30760710159` extends that gate through the combined supervised topology. After clean migrations and the versioned-object round-trip, Compose builds one V2 image and starts the API plus ingest, render, webhook and long-form workers; the gate verifies API health, every container in `running`, restart policy `unless-stopped`, and unconditional teardown of containers, networks and volumes. The proof exposed a real ESM/CJS import incompatibility that made the long-form worker restart after initial health and now guards that boot contract. It concludes isolated durable-workflow provisioning, but does not claim proxy reconstruction from persisted state after restart.

Run `30763463127` closes the proxy reconstruction gate. The ingest worker promotes the immutable master and editing derivative to a versioned MinIO bucket with full-object SHA-256 metadata and requires a non-null `VersionId`. The test then removes the complete local artifact namespace before proxy execution. A fresh worker relaunch reads the immutable ProjectVersion/EditPlan, source and manifest identities from PostgreSQL, materializes the exact S3 version into operation-owned ephemeral storage, revalidates key, checksum and byte size, renders with real FFmpeg, promotes the proxy back to MinIO and opens it through a second fresh work root to validate its bytes and 540×960/duration probe. The same run passes 801 tests, all media/Remotion goldens, build, Prisma/API integration and a supervised API plus four-worker topology with zero restarts and unconditional teardown. This proves reconstruction in isolated CI; it is not a production deployment or user acceptance.

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
retry, cancellation, success and failure. API-created operations persist the
validated `Apollo-Request-Id` as their trace before crossing the process
boundary; ingest, authorized render, proxy, final export, source cleanup and
long-form workers therefore retain the same trace after claim and replay.
Pre-existing and internal operations retain a deterministic workspace+operation
fallback. The operation ID is the job ID, and project ID is included only when
the persisted operation context has that relationship.
Type, status, phase and attempt are allowed; editorial payloads, file names,
transcripts, URLs and artifact identities are structurally absent. Telemetry is
best-effort and may never change the durable result. Migration, Prisma/API
integration and supervised cross-process runtime passed in hosted run
`30761608326`. Provider/renderer child spans, complete metrics, dashboards and
acceptance remain open under T-NFR-003.

Provider and renderer boundaries use a second closed envelope,
`public-operation-span-telemetry/v1`. The production composition root shares
one sink between lifecycle persistence and worker execution, so normalization,
transcription, long-form stages, proxy/final/authorized rendering and source
cleanup inherit the durable trace instead of minting an unrelated identifier.
Only a bounded span name/kind, deterministic span ID, job/workspace/project,
attempt, terminal result and measured duration are emitted; provider payloads,
paths, transcripts, URLs, artifact identities and exception text are absent.
Hosted run `30762327139` proves the real PostgreSQL+FFmpeg vertical chain emits
started/succeeded pairs for normalization, transcription and proxy rendering
under stable trace/job identities, while unit tests cover failure and collector
isolation. Wait/byte/token/cost metrics, dashboards, alerts and operational
acceptance remain open.

Hosted run `30763965449` extends the closed envelopes without inspecting provider payloads. Lifecycle events measure queue wait at claim and total running duration at terminal settlement. Provider/renderer spans accept only explicitly measured non-negative integer bytes, tokens and minor-unit cost; render and media workers report typed output sizes, while long-form stages report their persisted cost. Invalid measurements are omitted and collector failure remains unable to affect durable work. The production composition root also evaluates deterministic thresholds for failed operations, queue/run/span duration and cost and emits redacted `public-operation-alert/v1` records with canonical IDs, observed value and threshold only. The run passed 804 tests, build, all media/Remotion goldens, Prisma/API integration and the supervised Compose topology. A durable collector/query surface, dashboard and operational acceptance remain open, so F0.030 telemetry is still partial.

Hosted run `30765019248` makes the closed telemetry durable without turning it into an arbitrary event store. Separate PostgreSQL tables persist only the allowlisted lifecycle/span columns and redacted alert columns, use content hashes for idempotency, enforce schema/event/shape/metric constraints, and cascade only with their owning workspace. The public query `apollo.operations.telemetry.summary` requires `operations:read`, binds every aggregate to the authenticated workspace and an exclusive UTC window of at most 31 days, and returns counts plus decimal-string totals/maxima so byte/token/cost precision is not lost. It exposes no trace, job, project, provider payload or error text. PostgreSQL integration proved duplicate replay, workspace isolation, alert storage and exact aggregates; the complete run passed 807 tests, migrations from zero, API integration, build, media goldens and supervised Compose cleanup. Journey/phase dashboards, hard-invariant alerts and operational acceptance remain open, so the F0.030 telemetry checkbox remains partial.

Canonical persisted documents must be compared with canonical serialization,
never JavaScript insertion order. Hosted API integration exposed this at the
project LUT impact boundary after the command-type constraint was corrected:
the stored impact had identical content and hash but alphabetized keys. The
hydrator now revalidates with `stableSerialize`, and a regression test performs
the same canonical persistence round-trip.

ADR-142 selects OIDC Authorization Code + PKCE and opaque server-side sessions for production; the current scrypt bootstrap remains isolated-development only and blocks production until replaced. Workspace switching invalidates caches and subscriptions. Architecture imports are enforced by a CI boundary check. UI actions, REST endpoints and tests map through capability IDs, while sensitive internals have explicit deny-only reasons. Hosted runs `30765404717`, `30766068302` and `30768229810` make the session/tool separation fail closed, prove the login password absent from server logs, persist revocable sessions and distributed throttles, and require the durable session from every current V2 page boundary.

Hosted run `30770605092` integrates the six-destination shell and workspace switching without coupling a human identity to an automation credential. Each active workspace has one server-resolved `V2WorkspaceUiPrincipal`; the human must independently hold an active `V2WorkspaceMember`. A switch validates same-origin state mutation, resolves both records server-side and serializably revokes the old durable session while creating the target session with the original absolute expiry. The browser emits a workspace-changing event, removes only Apollo workspace-namespaced storage/cache entries and performs a hard navigation so prior subscriptions and React state cannot survive. PostgreSQL/HTTP E2E denied expired, cross-origin and suspended-member requests, rejected the old cookie after rotation and returned 404 for the previous workspace artifact while exposing the target artifact. This is integrated CI evidence, not production deployment or acceptance; OIDC remains the deployment gate.

Public operations generalize across ingest, Director, provider, sync, batch, render and export. Public conventions, deprecation/sunset headers, client kill switches and transition outbox events are stable application contracts.

Hosted run `30774673461` establishes the first executable F0.032 logical-boundary gate. The policy defines the permitted dependency direction for Domain, Application, Infrastructure, Public API, Agent, MCP and UI, scans every V2 static import, and separately prevents Web/Editor code from importing generated Prisma, repository factories, storage SDKs or media/database adapters. Only the named public authentication and server UI-session composition roots may assemble infrastructure. The gate exposed and removed two real inversions: ingest and cleanup Application workers now receive probe and file-integrity ports, and the Director agent no longer imports an MCP client type. T-F0.032 also executes a deterministic synthetic path across web, application, domain, orchestrator, provider, critic, compiler and renderer and proves representative violations fail closed. The same run passed the complete PostgreSQL, MinIO, FFmpeg, Remotion, API/OIDC and supervised Compose matrix. This is integrated structural evidence; it does not prove that every product flow already crosses the desired interfaces, that all worker stages are operationally isolated, or that the system is deployed and accepted.

Hosted run `30775230222` replaces the former trace-only fake with typed Application ports. Versioned references now cross Provider Registry/perception, Director, Critic, Compiler and Renderer without exposing an adapter, database or storage location. One orchestrator validates canonical context and every returned reference, propagates the same abort signal, requires a SHA-256-bound compiled RenderInput and fails before Compiler/Renderer when the Critic blocks. The fake vertical test wraps that orchestrator behind synthetic Web, authentication and domain-command calls and checks exact data flow; cancellation and non-canonical input fail before provider selection. The run passed 826 tests and the complete hosted matrix. These contracts are an architecture proof and intended seam, not evidence that the complete production pipeline has already been rewired through them.

Hosted run `30775662600` makes the PRD 10.1–10.6 conceptual inventory executable. Spec 10 maps all 57 normative names to one owner and to 26 typed Prisma targets, five immutable snapshot kinds, fourteen exported value objects or twelve explicit planned gaps. The test derives the expected set from the PRD, rejects missing/duplicate rows, validates every model and exported symbol, checks snapshot kinds and prevents a generic conceptual/entity/document table. It also removes the previous partial in-code registry so the PRD plus Spec 10 are the only inventory. The run passed 827 tests and the full hosted matrix. This exposes rather than closes the twelve missing contracts; relational graph verification, implementation, deployment and acceptance remain open.
