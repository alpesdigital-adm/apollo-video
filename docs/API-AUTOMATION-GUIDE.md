# API and automation guide

An API Client belongs to one workspace/environment and receives least-privilege scopes through one-time credentials. Capability discovery, OpenAPI, JSON Schemas and MCP tools share the versioned registry. Mutations use idempotency and version preconditions; expensive/broad actions require preflight.

Long work returns a Public Operation with honest phase/progress, cancel/retry and redacted result/error. Webhooks notify transitions at least once with signatures and replay protection. The MCP adapter authenticates like any client and never accesses database, storage or workers directly.
