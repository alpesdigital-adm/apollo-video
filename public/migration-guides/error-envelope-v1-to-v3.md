# Migrating from error-envelope/v1 to v3

`apollo://schemas/error-envelope/v1` is deprecated as of 3 August 2026 and is
scheduled to be withdrawn on 3 August 2027. New integrations must validate
errors against `apollo://schemas/error-envelope/v3`.

The v3 envelope keeps `error.code`, `error.message`, `error.category`,
`error.retryable` and `error.requestId` stable. Its `code` field is restricted to
the published Apollo error catalog, including the safe `INTERNAL_ERROR`
fallback. Conflict responses can also include the structured `error.conflict`
object. Clients must branch on `code` and `retryable`; `message` is safe display
text and must not be parsed.

To migrate:

1. Fetch `/v1/schemas/error-envelope/v3` and update the local validator.
2. Accept every published v3 error code and treat unknown future codes as a
   non-retryable failure until the integration is reviewed.
3. Use `error.conflict` only when present; do not infer it from the message.
4. Keep `Apollo-Request-Id` and `error.requestId` in support telemetry, without
   recording credentials or request bodies.
5. Verify the integration against the versioned schema before the sunset date.

The public API routes already emit v3-compatible envelopes. This notice only
retires direct consumption of the older schema document; it does not deprecate
the `/v1` API major.
