# API and automation guide

An API Client belongs to one workspace/environment and receives least-privilege scopes through one-time credentials. Capability discovery, OpenAPI, JSON Schemas and MCP tools share the versioned registry. Mutations use idempotency and version preconditions; expensive/broad actions require preflight.

Long work returns a Public Operation with honest phase/progress, cancel/retry and redacted result/error. Webhooks notify transitions at least once with signatures and replay protection. The MCP adapter authenticates like any client and never accesses database, storage or workers directly.

## Autenticação também é API-first

Existem dois mecanismos separados, com finalidades diferentes:

### Sessão humana

Um cliente HTTP pode realizar o mesmo login da Web App:

```http
POST /v1/session
Content-Type: application/json

{"username":"operador","password":"senha-com-pelo-menos-12-caracteres","next":"/"}
```

Uma resposta `200` define o cookie `apollo_session` como HTTP-only e devolve somente `subject`, `workspaceId`, `expiresAt` e `redirectTo`. O token da sessão nunca aparece no JSON. `GET /v1/session` consulta a sessão corrente e `DELETE /v1/session` a encerra de modo idempotente. Clientes externos que escolherem esse fluxo precisam preservar cookies e usar HTTPS em produção.

Esses endpoints possuem capability IDs, schemas e OpenAPI, mas não possuem `toolName`: senha humana não deve passar por MCP, Director, provider ou contexto de modelo.

### Automação e integrações

IA, MCP, scripts e ferramentas de terceiros usam `Authorization: Bearer <ApiCredential>`. A credencial pertence a um `ApiClient`, pode ser rotacionada/revogada e recebe somente os scopes necessários. Não é necessário — nem permitido — fazer login humano antes de operar a API com Bearer.

O bootstrap administrativo inicial é operacional. Depois dele, criação/rotação/revogação de clients ocorre pela própria Public API. Nunca grave username, password, cookie ou bearer em prompt, log, evento, analytics ou arquivo versionado.
