# Wave 35 — estados, ação recomendada e progresso medido

**Planejamento original, preservado como histórico.** Base `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, CI `37167702546` verde; depende da W34. F1.001 / FR-002, subescopos das caixas `bff460a9298a-1`, `0944e64350b1-1` e `ba0e03c8f7d9-1`. Estimativa original **3–4 h de desenvolvimento**, CI/revisão fora. Estado atual: [PROJECT-STATUS.md](PROJECT-STATUS.md).

Os cards já recebem projeção pública de estados e ações; barra/percentual só aparecem quando a operação fornece `completed` e `total`. Falta E2E visual/browser dos estados vazio, processando, aguardando revisão, falho, concluído e arquivado e da ação recomendada correta em cada um.

Montar fixtures reais pós-baseline, com status/visibleState persistidos pela trilha V2 e operações com e sem medidas. Fixar oráculo API/PG por projeto, depois conferir rótulo, tom, ação principal e destino do botão no browser para cada estado; não clicar mutações administrativas nesta wave. Verificar que progresso sem total mostra fase/“sem total medido” e **nenhuma** barra/percentual, enquanto progresso com total mede o número correto. Validar empty state real e screenshots desktop/mobile legíveis sem recorte/overflow. Não fabricar estado apenas em props React ou percentuais por tempo decorrido.

Executar regressões de projeção e jornada API/PG/browser; registrar IDs, fase, steps/items, expected/actual, capturas/hashes, CI SHA, cleanup terminal/zero backends. Identificar quais estados vieram de seed PG controlado e quais passaram por worker/operação real; só a segunda forma comprova transição executável. Preservar W34 e guards anteriores. Fora: transporte de eventos (W36), ações mutáveis W37–W39, provider live, deploy e aceite. Se algum estado não puder ser produzido por runtime V2 em 4 h, documentar a lacuna e não classificar a caixa como validada integralmente.

Referências e gates comuns: [índice W31–W40](PLANO-WAVES-31-40.md); `src/v2/domain/project-dashboard.ts`, `src/app/ProjectsPageClient.tsx`, `tests/v2/project-dashboard.test.mjs` e `tests/v2/public-project-api.integration.mjs`.

## Checkpoint técnico executado

Esta seção descreve o primeiro recorte controlado das W31–W40. A retomada para fechar as lacunas de runtime é registrada separadamente abaixo.

Stream s2, executor Sonnet; sem revisão independente ainda. Estados separados: **implementado** (somente teste; nenhuma mudança de produto na W35); **integrado na branch** `claude/w34-35-dashboard-cards` (`b2bf9ec0` primeira versão, `1622251b` estado final de código); **E2E controlado local** três jornadas completas verdes em `1622251b` (`s2-w34-l` 64 s, `-o` 102 s, `-n` 125 s; W34 e W35 no mesmo teste; zero skip; postflight zero backends, cluster parado, porta livre); **CI pendente** (passos "Verify/Publish Wave 35 dashboard states evidence" criados, nunca executados); **implantação pendente**; **aceite pendente**. A caixa **não deve ser classificada como validada integralmente**: nenhum estado passou por worker ou operação real, então as transições executáveis não foram provadas.

Jornada `tests/v2/helpers/dashboard-w35-states.mjs` (bloco `// --- W35 (stream s2) ---` após o bloco W34; fixtures `w35-*`; filtro `?text=w35-`): nove projetos; expectativas do PostgreSQL e da API (`visibleState`) antes do card. Rótulo, tom (classe de cor), ação principal e texto do botão são fixados no teste, independentes do componente.

- `w35-draft`: Configuração, neutro, "Abrir workspace", "Nenhuma operação iniciada". **Real API**.
- `w35-queued`: Renderizando proxy, informativo, "Acompanhar", "Na fila" com barra em 0%. Status e operação **seed**.
- `w35-processing-25` (1/4, 25%) e `w35-processing-75` (Exportando final, 3/4, 75%, "Salvando resultado"): **seed**.
- `w35-unmeasured`: fase "Renderizando" e "sem total medido", **sem barra e sem percentual**. **Seed** de forma aceita pelo PostgreSQL (CHECK permissivo a NULL) que o produto nunca grava; é a única forma de exibir esse ramo a partir de dado persistido.
- `w35-review`: Revisar proxy, aviso, "Revisar agora", 1 pendência, operação 4/4. **Seed**.
- `w35-failed`: Requer atenção, perigo, "Ver erro", 50% e `render-failed · recuperável`. **Seed**.
- `w35-completed`: Concluído, sucesso, 1 output. Status e cadeia de export **seed** com FKs reais.
- `w35-archived`: Arquivado, neutro, "Ver histórico". **Real API** (`POST .../archive` pelo cliente da jornada, caminho de runtime; sem clique na UI).

Por card, em desktop e mobile: badge, `data-state`, classe de tom, botão principal habilitado, fatos Versão/Pendências/Outputs, fase, percentual e `aria-valuenow` (0, 25, 50, 75, 100), erro e data. Os botões administrativos refletem o estado persistido (Arquivar habilitado só em draft, completed e failed; Restaurar só no arquivado com `archivedFromStatus`) e nenhum foi clicado. Destino por clique real no botão principal dos nove estados: `/projects/{id}` sem parâmetro; o botão secundário "Revisar" do estado em revisão vai a `/projects/{id}?mode=review`. Zero requisição mutável em toda a sessão, inclusive nas páginas de projeto abertas (só GET); rows e contadores do PostgreSQL idênticos antes e depois. Contadores visíveis 1/4/1/1 (Em configuração, Em produção, Aguardando revisão, Concluídos), só dos nove carregados.

Estado vazio real: um segundo `POST /v1/session` humano (a linha de throttle do fixture anterior de login é removida para permitir um login genuíno) e `POST /v1/session/workspace` para um workspace dedicado sem nenhuma linha de projeto. A API devolve lista vazia, a página mostra "Nenhuma produção ainda" e "Criar primeiro projeto", zero cards, contadores 0, e não a mensagem de filtro sem resultado. Capturas revisadas: `w35-desktop-states.png` com nove cards legíveis e sem recorte; `w35-mobile-states.png` em coluna única sem overflow; `w35-desktop-empty.png` e `w35-mobile-empty.png` com o estado vazio legível, sem overflow.

Guard `tests/v2/helpers/dashboard-w35-evidence-guard.mjs` (23 mutações rejeitadas, entre elas barra em progresso não medido, número errado, ação, tom ou destino trocados, worker alegado, arquivado sem origem API, lacunas escondidas; aceita os manifestos reais) e passos de CI após "Publish Wave 34". O manifesto mantém `gaps` e a origem de cada estado (`real-api`, `controlled-pg-seed`, `absent`); `worker` é `absent` em todos.

Observações para decisão, sem alterar produto: o botão principal "Revisar agora" do estado em revisão navega a `/projects/{id}` sem `?mode=review` (só o botão secundário usa o modo), e a prova fixa o comportamento atual; todas as ações primárias têm o mesmo destino. A transição real de estado (operação ou worker) exige mídia, EditPlan compilado e render, e não coube no orçamento. Gates como no checkpoint da W34 (`npm test` 2612/2613 com a falha herdada de citação W39/W40; demais gates com saída 0).
