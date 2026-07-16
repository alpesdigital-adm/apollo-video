# ADR-072 — Resources MCP autorizados e paginados

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Resources MCP precisam permitir contexto de leitura sem oferecer um caminho
paralelo de autorização ou acesso ao banco. Collections grandes também não
podem ser embutidas integralmente no contexto do agente.

## Decisão

- Uma collection só existe na sessão se sua capability de listagem estiver no
  snapshot autenticado obtido de `/v1/tools`.
- `resources/list` pagina os próprios descriptors; `resources/read` preserva a
  paginação da Public API para projects e operations.
- Capabilities são paginadas sobre a resposta autenticada sem encaminhar ao
  endpoint um cursor que pertence apenas ao adapter.
- URIs usam `apollo://<collection>` e aceitam somente parâmetros allowlisted.
- Cursor inválido, duplicado ou fora da collection falha fechado.
- Reports não são inferidos de eventos nem de nomes. A collection será anunciada
  somente quando `apollo.reports.list` estiver autorizada.
- Project list adota keyset `createdAt DESC, id DESC`, cursor vinculado ao
  workspace e schema público versionado `project-list/v2`; `v1` não muda.

## Consequências

- O host recebe apenas collections que também poderia consultar via REST.
- Adicionar uma nova collection exige capability pública explícita.
- Paginação evita respostas monolíticas e permite retomada determinística.
- O adapter continua sem imports de repository, Prisma, storage ou worker.

## Evidências exigidas

- client MCP oficial lista duas páginas de resources;
- templates e leitura preservam somente queries permitidas;
- report sem capability é invisível e ilegível;
- cursor de project não pode atravessar workspace;
- contratos versionados, typecheck e regressão completa verdes.
