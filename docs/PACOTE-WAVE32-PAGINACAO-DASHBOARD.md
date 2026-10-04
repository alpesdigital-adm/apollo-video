# Wave 32 — paginação e ordem estável do dashboard

**Pacote em fila; nenhuma prova W32 executada.** Base `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, CI `37167702546` verde; depende da W31. F1.002 / FR-003, partes das caixas `7e132977731d-1` (paginação/ordem/combinação) e `3543edbc5940-1` (teste de paginação). Estimativa **3–4 h de desenvolvimento**, CI/revisão fora.

`listProjectsService` já ordena por `createdAt/id`, vincula cursor ao filtro/workspace e `ProjectsPageClient.tsx` pede páginas de 24, deduplica e cancela leituras superadas. Falta prova browser/HTTP/PostgreSQL com **25 registros ou mais**, inclusive empate real de `createdAt`, sem fingir que duas páginas de dois itens validam o limite da UI.

Preparar 25+ projetos V2 apenas após baseline fixo, ou em suíte isolada descartável, com IDs/nomes e timestamps controlados no banco. Oráculo independente lê `createdAt/id` e prevê a sequência. Abrir `/` com sessão real, conferir primeira página de 24 e `nextCursor`, acionar “Carregar mais”, conferir página seguinte, ausência de duplicados/lacunas e ordem idêntica à API/PG. Trocar filtros durante request lenta/controlada para comprovar cancelamento da resposta stale sem sobrescrever cards; cursor de fingerprint antigo deve ser rejeitado pelo contrato, não aceito silenciosamente. Testar zero e fim da lista sem inventar percentual de progresso.

Registrar IDs/ordem, cursores opacos **sem segredos**, screenshot antes/depois, requests/responses, SHA/CI run e manifesto guardado em diretório externo; CI falha sem artifact e o publica com `always()`. Testes de service/codec e jornada real, build/contratos/CI; postflight browser/Next/PG zero. Fora: cross-workspace (W33), novo algoritmo de ordenação, infinite-scroll, ações, produção e aceite. Se a fixture ou race controlada demandar mais de 4 h, preservar resultado parcial e não marcar as caixas.

Referências e gates comuns: [índice W31–W40](PLANO-WAVES-31-40.md); `src/app/ProjectsPageClient.tsx`, `src/v2/ui/project-dashboard-filters.ts`, `tests/v2/list-projects.test.mjs` e `tests/v2/public-project-api.integration.mjs`.
