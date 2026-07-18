# ADR-011 — Model routing and observability

Models are selected from a capability catalog with cost, latency, quality, region and health. Routing and fallback decisions are attached to DirectorRun, job and provider-call correlation IDs.

Logs and traces redact uploaded content, secrets and personal data by default. Prompt/response sampling is opt-in and bounded. Dashboards aggregate cost, quality, failure and elapsed time by workspace, phase, capability and provider without exposing media content.
