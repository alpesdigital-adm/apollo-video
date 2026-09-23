# Synthetic phase gate v1

## Status

Domain evaluator, immutable PostgreSQL persistence, the authoritative W24.2
collector for provider execution and master catalogues, and the authenticated
public run/list API are implemented locally. Provider-live execution, the
render-bound reuse/fallback/swap projections, editor integration, production
deployment and acceptance are still open. All W24.2 local gates listed below
passed under Astra supervision; the W24.2 CI run is still pending. This
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

The domain, service, runner and port are ready locally. Persistence is withheld
until W24.3 supplies the canonical synthetic render operation and manifest
binding. Consequently no build attestation is collected for `F3-GATE-004` in
W24.2, and commit metadata alone cannot make that check covered.

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
W24.3. The W24.2 CI run has not yet completed, and no live provider execution,
W24.3 render journey, editor UI, reviewed final MP4, merge, deployment, product
acceptance or TODO closure is claimed.

## Remaining integration

W24.3 must bind cross-project reuse, transformation rejection/fallback and the
provider swap to the exact consuming synthetic render operation, assets,
materialized props, manifest and attested bundle. Until those joins exist, the
corresponding checks stay missing even when historical cache or fallback rows
exist. It must also expose gate history in the editor and exercise the same
collector through the integrated production journey.

A separately authorized live run must traverse the production provider
services. Adapter names, controlled transport receipts and controlled
PostgreSQL evidence do not prove provider-live acceptance. No deploy or F3.019
acceptance is claimed here.
