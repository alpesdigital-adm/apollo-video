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

A resposta de `remove-spoken-content` inclui `editorial.impact`, as relações
`editorial.invalidations` realmente persistidas e uma `operation` durável de
proxy. Como esse Command recompila o plano inteiro, o range é full-timeline e o
proxy é integral; repetições com a mesma `Idempotency-Key` convergem para o mesmo
Command e a mesma operação.

O mesmo endpoint aceita `replace-source-transcript` com `baseVersionId`,
`baseHash`, `sourceTranscriptId` e `expectedTranscriptHash`. A troca seleciona
evidência imutável explicitamente, invalida outputs derivados da versão-base e
retorna `nextRequiredCapability=apollo.projects.commands.apply:run-director`.
Ela não dispara render: execute um novo Command `run-director` sobre a versão
resultante antes de solicitar proxy ou final.

`run-director` recebe apenas `baseVersionId`, `baseHash` e `reason` opcional. A
resposta inclui `directorRun.impact`, `directorRun.invalidations` e `operation`.
O impacto vincula transcript/planner/critic, declara full-timeline e contém
somente outputs proxy/final concluídos da versão-base. O servidor relê esse
conjunto na transação do Command; drift causa conflito. Mesmo sem output-base,
o resultado declara um proxy integral mínimo, mas retorna `invalidations: []`
em vez de fabricar estado stale.

Os contratos completos e exemplos são descobertos em `GET /v1/capabilities`, `GET /v1/openapi.json` e nos schemas versionados correntes informados pelo registry.

## Revisão do proxy antes da alta

`GET /v1/projects/{projectId}/proxy-reviews` consulta o laudo persistido do
proxy corrente ou recebe `projectVersionId` para ler uma versão específica. A
resposta informa OutputSpec, issues técnicas/editoriais, ranges afetados,
`timeToFirstProxyMs`, hash/revision e `finalAllowed`. A consulta exige
`projects:read`.

Warnings não são ignorados implicitamente. Para liberar conscientemente uma
versão sem hard issues, use `POST /v1/projects/{projectId}/proxy-reviews` com
scope `projects:approve`, `Idempotency-Key` e:

```json
{
  "action": "acknowledge-warnings",
  "proxyReviewId": "proxy-review-...",
  "projectVersionId": "project-version-...",
  "baseRevision": "<reviewHash retornado pelo GET>",
  "expectedRevision": 1
}
```

A mesma chave e o mesmo payload repetem a decisão sem duplicá-la. Hash/revision
stale retornam conflito; qualquer hard issue retorna precondition failure. O
endpoint de export final volta a validar o laudo no PostgreSQL, portanto a
liberação não depende do estado da tela nem pode ser forjada no cliente.
