# W68 - da issue ao override, à recompilação e ao critic de novo, na UI

Escopo: plano W68 (`docs/PLANO-WAVES-61-70.md`). Ramo `claude/w68-issue-override-ui`, a partir de `origin/main` 229d5a05 (W64 fundida). Esta nota registra o
que mudou, as regras, o que foi provado e **o que não foi**. Não marca nenhuma caixa do `TODO.md` e não altera `docs/quality/project-status.json`.

## 1. O que existia e o que faltava (achado de leitura, antes de escrever)

O brief descrevia o backend de exceções de legenda como completo. Não era: o Command `apply-subtitle-segment-override` gravava a exceção, versionava e
calculava o impacto, mas **nenhum render a lia**. `compileApolloVideoRenderProps` aceitava as exceções por parâmetro e ninguém o chamava com elas; o caminho
FFmpeg do proxy e do final (`deriveEditorialRenderGeometry`) não as consultava. Uma exceção aplicada pela UI não mudaria um pixel. O trabalho de W68 começa
por ligar o Command ao render; a UI vem depois.

Outro achado: `data-testid="review-layer-resolver"` não é um contêiner vazio, é a camada sob a marcação do compositor de anotações. Fica como está.

## 2. A exceção chega aos pixels (a mesma derivação de geometria, no proxy e no final)

`deriveEditorialRenderGeometry` (única autoridade das cues, do plano de posicionamento e do plano de reenquadramento) passa a aplicar as exceções vigentes
**da saída que está sendo renderizada** (`resolveSubtitleOverridesForRender`, domínio):

| Dimensão | Efeito no render |
| --- | --- |
| `text` | substitui o texto da cue que é desenhada |
| `visibility: false` | a cue sai do render **e do plano** (uma cue que não é desenhada não é certificada) |
| `style` | a cue é desenhada com o estilo ASS do preset registrado (`subtitle-ass-preset-style.ts`: cor do texto, caixa opaca ou contorno, peso, caixa do texto). **Limite dito**: tipografia, animação e destaque por palavra são da composição Remotion, não do caminho libass; o estilo `Default` e o ASS de um render sem exceção não mudam um byte |
| `position` | vira um **PIN**, não uma posição: o plano de âncora concede a faixa pedida só se a mesma evidência a certificar |

**O pin não é uma autoridade.** `SubtitleAnchorCueV1.pinnedAnchor` (plano `subtitle-anchor-plan/v3`): faixa certificada livre desenha; sobreposição só com
evidência não crítica desenha com o aviso `SUBTITLE_ANCHOR_FALLBACK`; faixa ocupada por rosto ou sem cobertura certificada **não desenha** e deixa um
issue localizado (`NO_SAFE_SUBTITLE_REGION` / `FACE_PERCEPTION_UNAVAILABLE`, com a faixa pedida na mensagem e a evidência). Uma cue pinada não entra na histerese:
as cues vizinhas são decididas como se ela não existisse (teste: decisão byte a byte igual). `validateSubtitleAnchorPlanV3` re-deriva o pin; trocá-lo, tirá-lo
ou inventá-lo quebra a validação. Um plano sem pin mantém o hash que sempre teve.

**Identidade.** O conjunto das exceções que carregam valor (`subtitleOverrideSetHash`) entra no hash de entrada do proxy e do final (`projectProxyRenderInputHash`,
`projectFinalRenderInputHash`) e no recibo `subtitleOverrides` da receita. Saída sem exceção, ou com todas revertidas (cabeça sem dimensão), é identificada como
sempre foi. Um render com exceção é sempre completo (a fonte descarta `rangeReuse`/`unchangedReuse`, como já fazia com o plano de reenquadramento).

**Plano de reenquadramento carregado.** O plano é por (Versão, saída). O Command de legenda não muda crop; sem carregar o plano, a Versão nova renderizaria sem
trajetória e uma correção de legenda desfaria o enquadramento. `carryVariantReframePlans` (no módulo do plano, um dos escritores permitidos pelo gate de
arquitetura) copia, na mesma transação, o registro de cada saída para a Versão nova, com o mesmo `recordHash`. Provado em PG real (seção 6).

## 3. API (aditiva)

`apollo.projects.subtitle-segments.read` 1.0.0, `GET /v1/projects/{projectId}/subtitle-segments?variantId=`, `projects:read`: os segmentos de **uma** saída da
Versão corrente (id, faixa semiaberta, texto compilado), a exceção vigente (dimensões, proteção, cadeia) e o que o render desenha (`effective`), mais as
referências de preset versionadas (a UI nunca calcula hash). Variante que o State não carrega e projeto de outro workspace são recusados antes de qualquer leitura.
`contracts/v1/public-contract-baseline.json` e `docs/quality/ui-capability-parity-report.json` regenerados no mesmo commit; 395 -> 396 capabilities, 717 schemas.
Nenhuma outra capability mudou de versão.

## 4. UI (editor, pt-BR)

`src/components/IssueOverridePanel.tsx` (+ `IssueChips.tsx`, `src/v2/ui/issue-override-view.ts`, puro), montado abaixo do preview do editor:

- **Todo issue do laudo é um chip** (`Revisar` = warning, `Bloqueado` = hard), com código, faixa em quadros e timecode, cue. Nada é truncado (a lista da lateral
  passou a dizer que há mais). Selecionar um chip leva o preview à faixa.
- **Evidência e proveniência abertas por padrão**: saída, hash do laudo, entrada do render, proxy e sha256, laudo e preset de formato, hashes dos planos, elementos e
  todos os ids de evidência. Lista vazia diz que está vazia.
- **Ações por tipo**: legenda -> exceção de posição / estilo / texto / visibilidade, com proteção e motivo, `set` e `reset`; reenquadramento -> crop manual (só pan, sem zoom)
  por clipe e faixa, `set` e `reset`. O `set` envia a lista **completa** de dimensões (o servidor substitui a cabeça, não faz merge).
- **Sem aceitação implícita**: não existe "resolver". O issue some só quando um **novo** render, com pixels novos, deixa de reportá-lo. A comparação antes/depois só diz
  "não reportado no novo render" contra o laudo de um render da Versão nova. Bloqueio não tem como ser reconhecido (a UI não oferece; o servidor recusa, 428).
  O reconhecimento de ressalvas continua onde estava (laudo do proxy, com ator e horário).
- **Recompilar só o necessário**: depois do Command a UI enfileira o proxy **da saída afetada** (`POST /proxy-renders {variantId}`), mostra a Versão nova, o impacto (renders
  invalidados, inclusive "MP4 final desatualizado", e saídas afetadas) e o estado da operação com cancelamento (dois cliques). Uma saída cujo render é de Versão anterior
  oferece "Renderizar esta saída na versão atual".
- **Exceções ativas** ficam listadas e reversíveis mesmo depois que o issue que as motivou sumiu.
- **Sessão expirada**: o rascunho é guardado no navegador (por saída e legenda) e o login volta ao projeto (`/login?next=`, também nas outras leituras do editor).
  **Outro workspace**: página "projeto não encontrado" sem eco do id. **Base velha**: conflito explícito, "reler e tentar de novo", rascunho preservado.
  **Repetição**: a mesma chave para o mesmo conteúdo; a UI diz "repetição da mesma chave" quando o servidor responde pela mesma Versão. Enquanto a Versão nova não tem
  render, os issues do último render ficam na tela marcados como de Versão anterior.

## 5. Decisões e limites

- **Reset volta ao nível anterior**, não necessariamente ao herdado (semântica do domínio: cadeia append-only). A UI diz isso e a prova usa cadeias de um elo.
- **Render cancelado não é reaberto**: `project_proxy_render_operations` é único por (workspace, Versão, hash de entrada). A UI não oferece "tentar de novo" para operação cancelada;
  o caminho é a próxima Versão (reverter ou aplicar outra exceção). Provado.
- **Final**: o impacto do Command já lista o MP4 final da saída como desatualizado e a UI o diz; o worker do final usa a mesma derivação e o mesmo hash. **Não** há render final no browser
  proof (exige DirectorRun aprovado e laudo liberado; é o escopo de W70). Ver seção 8.
- **Proteção (`protected`)** é gravada e exibida; a reaplicação sobre uma recompilação automática do Diretor não está implementada (o domínio tem `reapplyProtectedSubtitleSegmentOverrides`,
  ninguém o chama).
- **Integração com W67**: não fundida. A UI lê os issues que o laudo já persiste (formato, pixels de legenda do W65, reenquadramento); o relatório de MP4 independente do W67 entra como
  mais issues do mesmo laudo, sem mudança de UI (`ReviewIssueInput` é a costura).

## 6. Provas

Unitárias (`npm test`): `w68-subtitle-override-render.test.mjs` (pin, vizinhos intactos, validação adulterada, recibo, ASS `Default` intacto, geometria e hash de entrada),
`issue-override-view.test.mjs` (chips, evidência renderizada de verdade com react-dom, corpos dos Commands, chaves, falhas, antes/depois),
`issue-override-proof-oracle.test.mjs` (o oráculo de pixels testado antes de julgar um render). Contagem de capabilities e fakes dos leitores atualizados.

Navegador real + `next start` + PostgreSQL + worker de produção + FFmpeg (`tests/v2/issue-override-ui-browser.e2e.mjs`, harness supervisionado e passo da CI `quality`),
**um projeto com duas saídas (9:16 e 16:9) sobre uma gravação real** desenhada por um gerador (o detector é um STAND-IN rotulado: as caixas são as do gerador, gravadas pelo
decoder V9 real em janelas seladas):

- 16:9: baseline **bloqueado** por `CAPTION_PLACEMENT_MISMATCH` (legenda de duas linhas fora da faixa); correção por texto curto, a partir do chip duro, **depois** de um conflito de base velha
  (outro escritor) e da releitura; novo render, o novo critic não reporta mais o bloqueio e o oráculo mede, nos quadros decodificados, a legenda dentro da faixa (antes: fora, mesmo sem o critic);
  pin em faixa ocupada (recusada, com o motivo) com **perda da resposta** e repetição (mesma Versão, `replayed`); reset (quadro decodificado idêntico ao herdado); pin em faixa livre
  (movimento medido: um aglomerado de linhas na faixa antiga, outro na nova), protegido; reset; ocultar a cue 3.
- 9:16: render da Versão corrente da saída; **quadros idênticos aos do primeiro render** (nada feito na outra saída chegou aqui); pin com **sessão expirada** (nada gravado, rascunho
  restaurado após o login); reset; reenquadramento manual (o sujeito aparece no x que o crop escolhido especifica, medido: 170,5 px contra 170,7); plano do servidor intacto, plano final
  mudou; reset devolve o **mesmo recordHash** do plano automático e o quadro idêntico; ocultar a cue 3 com **cancelamento** antes do render (nenhum artefato promovido) e a Versão seguinte renderizada.
- Negativos: outro workspace (UI "não encontrado" e 404 em leitura de segmentos, Command, leitura do plano e render), base velha, repetição, cancelamento, reconhecimento de bloqueio recusado.
- Imutabilidade, a cada Command: a Versão anterior (linha e snapshot do EditPlan), as operações, artefatos, laudos e aprovações **da outra saída**, e o `recordHash` dos planos das duas saídas; o Command
  nomeia só a sua saída; só a sua saída ganha operação de render; **nenhuma linha de decisão (aprovação) foi escrita**, nenhum final existe.
- Capturas e evidência (privadas, fora do repositório): `C:/Users/leand/Documents/Apollo/w61-70-20261008/w68-evidence/run-*/` (quadros antes/depois com cue e sha do proxy no nome, painel).

Ids de run, contagens e mutações: ver o relatório final do wave (seção 9).

## 7. Achados do produto (não corrigidos aqui)

- **Legenda de duas linhas em 16:9**: o critic de pixels do W65 reprova (`CAPTION_PLACEMENT_MISMATCH`, bloqueio) uma legenda de duas linhas na faixa de 16:9; medido nos quadros decodificados
  (linhas 427-500 contra a faixa 436-492, tolerância publicada de 6). Em 9:16 não ocorre. É defeito de geometria da faixa ou do quebrador de linhas; a prova usa a correção do editor (texto curto), não o esconde.
- Um render cancelado não pode ser reaberto para as mesmas entradas (unicidade por Versão e hash de entrada): comportamento de projeto, agora refletido na UI.
- Uma execução do browser proof (`w68-explore-21`, depois de um build) ficou sem saída por ~30 min e foi morta pelo relógio do harness, num ponto depois do reenquadramento; a repetição passou. Não foi reproduzida
  nem explicada: leituras HTTP do proof ganharam timeout nomeado (90 s) e o teste um teto menor que o do harness. Tratar como flake aberto até haver N.
- O alarme de anomalia de requisições da governança (piso 20, 3x a linha de base) barra o proof (dezenas de leituras por minuto de um só cliente). O piso foi elevado **só no servidor do teste**
  (`APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM`); o limite de taxa (10000/min) não foi tocado e `editor-reliability-browser.e2e.mjs` segue com os padrões.

- **Pools de conexão no harness local**: a role do banco descartável do harness (`apollo_s2d`) aceita 12 conexões; a jornada abre o cliente do teste, o cliente do worker em processo e **dois** servidores (o do dono e o do estranho). Com `connection_limit=5` por processo (o que a CI configura), a leitura do workspace do estranho recebeu `FATAL: too many connections` (500, e a página mostrou `project-unavailable` em vez de `project-not-found`) em 4 de 4 execuções do lote `full-b2`/`rerun`. A jornada agora dá a cada cliente um pool pequeno (2 a 3); com isso passou 2 de 2. A CI do GitHub usa Postgres com 100 conexões e não é afetada, mas a falha era real do ponto de vista do que a página mostra quando o banco recusa: a página não confunde "recusado" com "não encontrado" (diz "A solicitação não pôde ser concluída").
- **Três passos do lote local que não são do W68** (ver o relatório final): `library-journey` espera MinIO/S3 (`'local' !== 's3'`, ambiente do harness, falha em todas as execuções anteriores); `synthetic-wave24-journey` (passo sem o catálogo W58) falha com o mesmo 409 `PERSISTENCE_CONFLICT` em `origin/main` 229d5a05 sem nenhuma mudança do W68 (executado em worktree limpa do commit base); `podcast-multicam` falhou uma vez por transação do Prisma que passou de 30 s (`color-plan`) e passou na repetição.

## 8. Lacunas abertas

- Sem render **final** no browser (ver 5). Coberto por unidade: o hash de entrada do final e o do proxy incluem o conjunto de exceções; o impacto lista o final como desatualizado.
- A saída 16:9 não tem issue de reenquadramento (quadro inteiro sobre fonte 16:9): o par override/reset de reenquadramento é provado só em 9:16.
- O alvo de reenquadramento do browser proof é o issue `REFRAME_PERCEPTION_UNCERTAIN` (sem evidência); o caso de um bloqueio duro de reenquadramento resolvido à mão não foi montado.
- Estilo: provado em unidade (ASS) e no recibo; não há captura de browser de um estilo diferente. Texto e visibilidade: provados no browser.
- `ReviewInput` na UI é um tipo local; os campos `placementPlanHash`/`reframePlanHash` por issue aparecem na evidência só quando o laudo os persiste.
