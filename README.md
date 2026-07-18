# Apollo Video

Editor de vídeo automático orientado por IA. O produto recebe masters brutos, briefing e objetivo, cria uma direção editorial rastreável, gera uma timeline versionada e materializa os derivados e renders sem depender do Apollo anterior.

## Arquitetura vigente

Existe um único runtime:

`UI nova → API pública /v1 → application services V2 → PostgreSQL → operações/workers V2 → renderer V2 → artifacts`

- PostgreSQL é a única fonte de verdade; não há SQLite, dual-write ou schema antigo.
- Toda operação disponível na interface também deve existir na API pública e no catálogo de capabilities.
- Login humano usa `POST /v1/session`; automações usam credenciais Bearer próprias.
- Masters, proxies, transcrições, planos, versões, operações e artifacts possuem identidade e lineage V2.
- Tarefas demoradas são executadas por workers duráveis e idempotentes.
- O renderer consome somente `RenderInput` materializado.

As regras vinculantes e a definição estrita de pronto estão em `AGENTS.md`. O progresso auditado está em `TODO.md`.

## Stack

- Next.js 16 e React 19
- PostgreSQL 16 e Prisma, usando exclusivamente `prisma/v2/schema.prisma`
- FFmpeg/ffprobe para ingestão, proxy, áudio e renderização auxiliar
- Remotion 4 para composição programática
- Groq Whisper para transcrição alinhada
- Public API HTTP e adapter MCP para operação externa

## Ambiente local

Pré-requisitos: Node.js 22, PostgreSQL 16 e as variáveis de `.env.local.example`.

```bash
npm ci
npm ci --prefix remotion
npm run db:v2:migrate:deploy
npm run db:v2:bootstrap -- \
  --workspace-id workspace-local \
  --workspace-slug local \
  --workspace-name "Apollo Local" \
  --client-id apollo-ui-local \
  --client-name "Apollo UI" \
  --environment sandbox
npm run dev
```

O bootstrap imprime uma credencial Bearer uma única vez. `APOLLO_UI_API_CLIENT_ID` deve apontar para esse client. Configure `APOLLO_UI_PASSWORD_HASH` com um hash `scrypt` gerado por `createUiPasswordHash()` e nunca grave senha ou token no repositório.

Interface: `http://localhost:3333`. OpenAPI: `GET /v1/openapi.json`. Catálogo externo: `GET /v1/capabilities` e `GET /v1/tools`.

## Workers

```bash
npm run worker:v2:ingest
npm run worker:v2:render
npm run worker:v2:webhook
npm run mcp:v2
```

O worker de ingestão verifica o upload, promove o master, gera proxy e áudio, transcreve e persiste artifacts/transcript. O worker de render valida autorização, rights, hashes e checkpoints antes de publicar o output.

## Gates locais

```bash
npm run typecheck
npm run lint
npm run domain-language:validate
npm test
npm run api:v1:validate
npm run db:v2:validate
npm run test:integration:media
npm run build
```

`npm run lint` também falha se qualquer raiz do runtime aposentado voltar a existir.

## Formatos previstos

O domínio de output suporta `9:16`, `16:9`, `4:5`, `1:1` e `21:9`. Suporte no contrato não equivale a render final aceito: cada jornada só é marcada como concluída depois do E2E visual correspondente.
