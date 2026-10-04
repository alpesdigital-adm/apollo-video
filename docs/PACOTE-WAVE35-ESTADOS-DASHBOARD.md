# Wave 35 — estados, ação recomendada e progresso medido

**Pacote em fila; nenhuma prova W35 executada.** Base `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, CI `37167702546` verde; depende da W34. F1.001 / FR-002, subescopos das caixas `bff460a9298a-1`, `0944e64350b1-1` e `ba0e03c8f7d9-1`. Estimativa **3–4 h de desenvolvimento**, CI/revisão fora.

Os cards já recebem projeção pública de estados e ações; barra/percentual só aparecem quando a operação fornece `completed` e `total`. Falta E2E visual/browser dos estados vazio, processando, aguardando revisão, falho, concluído e arquivado e da ação recomendada correta em cada um.

Montar fixtures reais pós-baseline, com status/visibleState persistidos pela trilha V2 e operações com e sem medidas. Fixar oráculo API/PG por projeto, depois conferir rótulo, tom, ação principal e destino do botão no browser para cada estado; não clicar mutações administrativas nesta wave. Verificar que progresso sem total mostra fase/“sem total medido” e **nenhuma** barra/percentual, enquanto progresso com total mede o número correto. Validar empty state real e screenshots desktop/mobile legíveis sem recorte/overflow. Não fabricar estado apenas em props React ou percentuais por tempo decorrido.

Executar regressões de projeção e jornada API/PG/browser; registrar IDs, fase, steps/items, expected/actual, capturas/hashes, CI SHA, cleanup terminal/zero backends. Identificar quais estados vieram de seed PG controlado e quais passaram por worker/operação real; só a segunda forma comprova transição executável. Preservar W34 e guards anteriores. Fora: transporte de eventos (W36), ações mutáveis W37–W39, provider live, deploy e aceite. Se algum estado não puder ser produzido por runtime V2 em 4 h, documentar a lacuna e não classificar a caixa como validada integralmente.

Referências e gates comuns: [índice W31–W40](PLANO-WAVES-31-40.md); `src/v2/domain/project-dashboard.ts`, `src/app/ProjectsPageClient.tsx`, `tests/v2/project-dashboard.test.mjs` e `tests/v2/public-project-api.integration.mjs`.
