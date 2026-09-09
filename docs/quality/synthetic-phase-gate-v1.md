# Synthetic phase gate v1

## Status

Domain evaluator implemented locally. Persistence, server evidence collection,
public API, live-provider execution, production deployment and acceptance are
still open. This document is not an approval record.

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
- The evaluator labels its normalized evidence as server evidence; the future
  application service must derive the input from PostgreSQL and trusted build
  attestations rather than accepting it from the public request.

## Remaining integration

The next slice must persist immutable gate records, derive references from the
provider job/result, synthetic master/speech catalog, cache decision,
transformation fallback/critic and render records, then expose run/list through
authenticated `/v1` capabilities. A live run must traverse those production
services; the direct adapter smoke alone is not sufficient.
