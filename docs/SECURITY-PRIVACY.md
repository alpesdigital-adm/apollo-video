# Security and privacy baseline

Secrets are references with least privilege and rotation; public contracts never contain plaintext credentials, storage locations, raw prompts or private provider payloads. Workspace authorization protects API, jobs and storage. Uploads use short signed sessions, MIME/size checks, quarantine and SSRF-safe network boundaries. Webhooks and API/MCP requests are authenticated and replay-resistant.

Human authentication is API-first but remains isolated from automation. `POST/GET/DELETE /v1/session` use a signed HTTP-only cookie with bounded expiry; username/password are write-only inputs and never enter logs, events, analytics, prompts or response bodies. MCP, Director and third-party agents never receive human credentials or cookies: they authenticate with independently scoped and revocable `ApiClient` Bearer credentials.

Faces, voices, consent evidence, testimonials and transcripts are sensitive. Collection is purpose-bound and minimal; retention and sharing are versioned. Verified deletion cascades through derivatives, segments and cache, leaves a tombstone/receipt and produces redacted analytics. Authorized exports contain identity/metadata but no internal locations.
