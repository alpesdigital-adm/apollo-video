# Security and privacy baseline

Secrets are references with least privilege and rotation; public contracts never contain plaintext credentials, storage locations, raw prompts or private provider payloads. Workspace authorization protects API, jobs and storage. Uploads use short signed sessions, MIME/size checks, quarantine and SSRF-safe network boundaries. Webhooks and API/MCP requests are authenticated and replay-resistant.

Faces, voices, consent evidence, testimonials and transcripts are sensitive. Collection is purpose-bound and minimal; retention and sharing are versioned. Verified deletion cascades through derivatives, segments and cache, leaves a tombstone/receipt and produces redacted analytics. Authorized exports contain identity/metadata but no internal locations.
