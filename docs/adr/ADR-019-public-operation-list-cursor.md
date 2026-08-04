# ADR-019 — Listagem e cursor estável de PublicOperation

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

Leitura, cancelamento e retry por ID não permitem que um operador ou agente descubra jobs recentes, acompanhe um conjunto de renders ou localize operações por estado. Paginação por offset seria instável quando novas operações fossem inseridas e ficaria progressivamente cara. Aceitar filtros livres criaria uma superfície de consulta imprevisível e poderia vazar detalhes da persistência.

O primeiro modelo associava somente `artifact-render` a um `media-artifact` e não possuía vínculo canônico entre operação e projeto. O modelo atual distingue operações globais de artifact das operações pertencentes a projeto.

## Decisão

- A capability pública é `apollo.operations.list`, servida por `GET /v1/operations` e protegida pelo scope `operations:read`.
- A ordenação é fixa por `createdAt DESC, id DESC`. O ID resolve empates de timestamp e forma uma fronteira total e determinística.
- A paginação usa `limit`, `after` e `nextCursor`; o limite padrão é 20 e o máximo é 100.
- O cursor é um envelope v1 codificado em Base64 URL-safe. Ele contém somente a fronteira de criação, o ID e um SHA-256 da combinação workspace/filtros.
- O cursor é opaco para o consumidor, não é uma credencial e não amplia autorização. Toda consulta reaplica o workspace autenticado no banco.
- O hash vincula o cursor ao workspace e aos filtros originais. Alterar `status`, `type`, `projectId` ou `targetId` entre páginas produz `INVALID_ARGUMENT`.
- Filtros permitidos são somente os documentados: `status`, `type`, `projectId` e `targetId`. Parâmetros desconhecidos, repetidos ou valores fora da allowlist são rejeitados.
- O repository busca `limit + 1`; `nextCursor` só é devolvido quando existe outra página.
- Cada item usa o presenter público existente e continua omitindo client, authorization, RenderInput, leases, schedules e storage.
- `PublicOperation.projectId` é canônico e possui FK composta para o projeto do mesmo workspace. É obrigatório para ingest, proxy, export, cleanup, long-form e Director; `artifact-render` é global e deve mantê-lo ausente. `project-director-run` usa alvo/result `project-version`; os demais tipos atuais usam `media-artifact`. Domínio, constraint e reidratação falham fechados para outra combinação.
- Índices compostos por workspace/criação/ID e workspace/projeto/criação/ID sustentam a fronteira do cursor no PostgreSQL.

## Consequências

- Inserções posteriores ao início da navegação aparecem antes da fronteira já consumida e não duplicam itens nas páginas seguintes.
- A paginação não representa um snapshot transacional: exclusões concorrentes podem reduzir uma página e mudanças de estado podem alterar o resultado de um filtro entre requests.
- Como a ordem usa `createdAt`, atualizações de status ou progresso não reposicionam a operação.
- O cursor não precisa ser assinado porque não contém segredo e sua adulteração não contorna o filtro obrigatório de workspace; valores inválidos falham com erro público tipado.
- O filtro `projectId` não infere pertencimento por target ou tabela lateral: consulta exclusivamente a associação canônica persistida na operação.
- Ordenações alternativas, intervalos temporais e múltiplos tipos de job exigirão evolução aditiva; descoberta de dead-letter ganhou capability própria no ADR-020.

## Evidências exigidas

- empate de `createdAt` resolvido pelo ID sem duplicação;
- cursor rejeitado quando workspace ou filtros mudam;
- isolamento por workspace no repository e na API autenticada;
- associação de projeto obrigatória e consistente para operações project-bound, ausente para `artifact-render` e filtrável por índice;
- filtros exatos e parâmetros desconhecidos/repetidos rejeitados;
- ausência de contexto protegido na lista;
- primeira página, continuação e página terminal sem `nextCursor`.
