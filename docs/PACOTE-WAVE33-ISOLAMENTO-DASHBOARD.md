# Wave 33 — isolamento de workspace na listagem

**Pacote em fila; nenhuma prova W33 executada.** Base `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, CI `37167702546` verde; depende da W32. F1.002 / FR-003, subescopo da caixa `3543edbc5940-1`. Estimativa **2–3 h de desenvolvimento**, CI/revisão fora.

A API valida workspace e fingerprint do cursor; testes locais anteriores cobrem parte desse contrato. Falta jornada autenticada demonstrando que resultados, zero-state e cursores do workspace A não revelam projetos de B pela UI ou pelo HTTP real.

Criar projetos V2 de identidades distintas em A/B no PostgreSQL isolado, após baseline ou em suíte própria. Emitir sessões/credenciais reais para cada workspace; ler IDs esperados diretamente do banco. Para A e B, comparar `/v1/projects` e cards `data-project-id`, filtros e páginas sem vazamento. Submeter cursor de A sob B e cursor de outro filtro sob A: exigir erro exato do contrato, sem aceitar 200 vazio como prova de isolamento. Exercitar zero results legítimo, sessão expirada/não autorizada e anônimo com resposta/redirecionamento esperados; nunca registrar cookie ou Bearer no artifact.

Preservar W31/W32, contratos 401/403/404 conforme rota específica e nenhum downgrade de segurança. Testes de isolamento/contrato e browser/PG reais; evidência sanitizada com IDs, códigos, query/fingerprint sem valor secreto, screenshots, SHA e postflight zero backends/processos. CI deve rejeitar falta de qualquer caso e publicar artifact em falha. Fora: paginação nova, administração, troca de workspace do produto, dados reais, deploy e aceite. Se descoberta exigir política nova, parar no resultado parcial em até 3 h e registrar decisão antes de alterar autorização.

Referências e gates comuns: [índice W31–W40](PLANO-WAVES-31-40.md); `src/app/ProjectsPageClient.tsx`, `src/v2/ui/project-dashboard-filters.ts`, `tests/v2/list-projects.test.mjs` e `tests/v2/public-project-api.integration.mjs`.
