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

O mesmo `POST /v1/session` aceita `application/x-www-form-urlencoded` como degradação segura da tela de login: em caso de sucesso responde `303` para um path interno validado e mantém username/password no corpo da requisição, nunca na query string. JSON continua sendo a representação canônica documentada em OpenAPI.

Esses endpoints possuem capability IDs, schemas e OpenAPI, mas não possuem `toolName`: senha humana não deve passar por MCP, Director, provider ou contexto de modelo.

### Automação e integrações

IA, MCP, scripts e ferramentas de terceiros usam `Authorization: Bearer <ApiCredential>`. A credencial pertence a um `ApiClient`, pode ser rotacionada/revogada e recebe somente os scopes necessários. Não é necessário — nem permitido — fazer login humano antes de operar a API com Bearer.

O bootstrap administrativo inicial é operacional. Depois dele, criação/rotação/revogação de clients ocorre pela própria Public API. Nunca grave username, password, cookie ou bearer em prompt, log, evento, analytics ou arquivo versionado.

## Workspace e edição por Command

`GET /v1/projects/{projectId}/workspace` devolve o estado atual usado pela interface, incluindo versão, mídia, transcrições, operações, resumo do EditPlan e Commands persistidos. A consulta exige `projects:read`.

Alterações editoriais usam o mesmo contrato para UI, IA e integrações. `POST /v1/projects/{projectId}/commands`, com scope `projects:write`, aplica atualmente o Command `remove-spoken-content`. A requisição deve informar `Idempotency-Key`, `baseVersionId`, `baseHash`, `sourceTranscriptId` e regras de frases. O servidor rejeita base obsoleta, confirma as frases na transcrição alinhada, cria uma nova `ProjectVersion` imutável e retima o plano sem sobrescrever a versão anterior.

Os contratos completos e exemplos são descobertos em `GET /v1/capabilities`, `GET /v1/openapi.json` e nos schemas `apply-project-edit-command-request/v1`, `project-edit-command-applied/v1` e `project-workspace/v2`.
