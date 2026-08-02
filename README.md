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

Para o ambiente descartável isolado, preencha os segredos locais e suba cada
dependência explicitamente. Os dois serviços publicam somente em loopback; o
MinIO cria `APOLLO_V2_S3_BUCKET` e habilita versionamento antes de concluir.

```bash
npm run infra:validate
npm run infra:postgres:up
npm run infra:object-storage:up
```

O Postgres fica em `127.0.0.1:55432`, e o endpoint S3 em
`http://127.0.0.1:59000`. Esses comandos não executam migration nem bootstrap:
faça os passos abaixo somente depois que ambos os health checks estiverem
verdes. Não use esses volumes para produção ou E2E remoto.

Para subir o runtime novo completo de forma supervisionada, use o Compose
combinado. Ele espera Postgres e o bucket versionado, aplica as migrations e só
então inicia API, ingest, render, webhook e long-form workers. `down` preserva
os volumes; não use `-v` sem revisar os dados locais que serão removidos.

```bash
npm run infra:local:up
npm run infra:local:down
```

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

Com o worker de ingestão supervisionado e `APOLLO_V2_ARTIFACT_ROOT` apontando
para o mesmo volume persistente, o seed de projeto aceita somente um master real.
Ele cria/reutiliza o Project pela aplicação, persiste o OutputSpec no snapshot
imutável, atravessa upload verificado e aguarda a operação durável concluir. O
comando falha se source master e editing proxy não forem persistidos; não existe
inserção sintética de Source pronto.

```bash
npm run db:v2:seed:project-source -- \
  --seed-id welcome-v1 \
  --workspace-id workspace-local \
  --client-id apollo-ui-local \
  --project-name "Boas-vindas" \
  --source-file /seed-input/master.mp4 \
  --source-mime video/mp4 \
  --briefing "Briefing autorizado pelo owner"
```

O bootstrap imprime uma credencial Bearer uma única vez. `APOLLO_UI_API_CLIENT_ID` deve apontar para esse client. Configure `APOLLO_UI_PASSWORD_HASH` com um hash `scrypt` gerado por `createUiPasswordHash()` e nunca grave senha ou token no repositório.

Interface: `http://localhost:3333`. OpenAPI: `GET /v1/openapi.json`. Catálogo externo: `GET /v1/capabilities` e `GET /v1/tools`.

## Workers

Os comandos abaixo são úteis para desenvolvimento isolado de um worker. Para a
topologia completa, prefira `infra:local:up`, que supervisiona os processos e
compartilha os mesmos volumes persistentes.

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
npm run infra:validate
npm test
npm run api:v1:validate
npm run db:v2:validate
npm run test:integration:media
npm run build
```

`npm run lint` também falha se qualquer raiz do runtime aposentado voltar a existir.

## Formatos previstos

O domínio de output suporta `9:16`, `16:9`, `4:5`, `1:1` e `21:9`. Suporte no contrato não equivale a render final aceito: cada jornada só é marcada como concluída depois do E2E visual correspondente.
