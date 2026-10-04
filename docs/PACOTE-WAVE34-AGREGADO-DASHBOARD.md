# Wave 34 — agregado público dos cards de projeto

**Pacote em fila; nenhuma prova W34 executada.** Base `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, CI `37167702546` verde; depende da W33. F1.001 / FR-002, subescopo da caixa `b37d988da372-1`. Estimativa **3–4 h de desenvolvimento**, CI/revisão fora.

`GET /v1/projects` v4/project-list v6 já agrega versão atual, operação pública durável recente, annotations abertas da versão corrente, outputs concluídos e fence administrativo a partir do PostgreSQL V2. A lacuna é provar o agregado persistido e os valores ausentes reais no browser, não apenas tipos, mocks ou consulta unitária.

Usar projetos V2 isolados com ProjectVersion, operação medida e não medida, review issue e output com identidades conhecidas; preparar após asserts baseline. Registrar linhas/refs no banco e ler a projeção pela API; conferir no card somente campos derivados dessas identidades e ausência `null`/vazia quando relação não existe. Exercitar relação inconsistente **em teste de domínio/repositório com injeção controlada** e exigir falha fechada, sem inventar versão/output; não burlar FKs nem corromper PostgreSQL para produzir esse caso no E2E. Confrontar IDs e valores da resposta com card e screenshots; a contagem visível deve refletir somente resultados carregados, não total global de páginas.

Testar service/repository/contract e jornada PostgreSQL/HTTP/Chromium; guardar manifesto de rows/projeção/cards, hashes de capturas e SHA do commit/run, sem payload sensível. Estado produzido só por seed PG controlado não equivale a operação/worker real; distinguir a origem de cada relação no manifesto. Guard de CI e postflight do `application_name` real, browser e servidor terminais. Fora: estados e ação recomendada completos (W35), evento push (W36), novos campos de domínio, produção e aceite. Se os fixtures de operação/output fizerem o slice exceder 4 h, registrar quais relações passaram e manter a caixa aberta.

Referências e gates comuns: [índice W31–W40](PLANO-WAVES-31-40.md); `src/v2/domain/project-dashboard.ts`, `src/app/ProjectsPageClient.tsx`, `tests/v2/project-dashboard.test.mjs` e `tests/v2/public-project-api.integration.mjs`.
