# W70 - prontidão (achados do Opus sobre a PR #91)

Ramo `claude/w70-readiness`, a partir de `origin/claude/w69t-w70-prep` (PR #91, fundida em `main` como 24bbf8a2; `origin/main` foi fundido de volta aqui). Não marca
nenhuma caixa do `TODO.md` e não altera `docs/quality/project-status.json`. Registra o que mudou em cada item, o que foi provado e **o que não foi**.

## 1. Versão de exceção herda a qualidade do Director (0d3f4928, b3ac70b9, ad6dd41c)

Uma Versão criada por exceção de legenda (`apply-subtitle-segment-override`) ou reenquadramento manual (`apply-variant-reframe-override`) não tinha DirectorRun próprio: o
final era inalcançável e, pior, um proxy novo lia lista **vazia** de issues do Director (ressalvas que alguém teria de reconhecer sumiam). Regra (`director-run-inheritance.ts`):
anda por `parentVersionId` enquanto cada Versão foi feita por um desses dois Commands, com base registrada = o pai e EditPlan igual ao do pai (sem os campos de identidade); a
primeira Versão resultado de um DirectorRun bem-sucedido encerra a caminhada; qualquer outra coisa para com motivo preciso (`command-not-inheriting`, `version-without-command`,
`command-base-mismatch`, `parent-missing`, `edit-plan-moved`, `chain-too-long`). A linha de DirectorRun nunca é copiada; Versões e Commands atravessados entram no hash de entrada
do final, no contexto da operação (coluna nova, documento selado) e no recibo; repositório, transação de admissão e worker re-derivam a cadeia e recusam uma que mudou.

Revisão deste item (feita aqui): a caminhada para em qualquer Command fora da lista, e `inheritedThroughVersionIds` + ids de Command estão no hash e no recibo, como pedido. Dois
defeitos, corrigidos:

- a busca de herança rodava para **toda** Versão sem DirectorRun próprio, inclusive edição manual e criação, e os 37 testes unitários que leem fontes com um cliente que só
  modela as consultas de uma fonte de proxy quebravam (`npm test` vermelho em 0d3f4928). b3ac70b9: só se busca quando o Command da própria Versão é um dos herdáveis (para as
  demais a caminhada pararia no primeiro passo; o resultado é o mesmo);
- toda parada virava `EDITORIAL_ACCEPTANCE_FAILED` (`director-run-not-inherited`), também numa linha que **nunca** foi dirigida (edição manual, review patch, `run-director` sem
  run bem-sucedido). Antes da herança isso era "sem aprovação" (`readApprovedCurrentSource` = null), e dois oráculos PostgreSQL do W66 dizem exatamente isso
  (`w66-consumption-proxy-final`, `mo-render-consumers`, reprovados no `full-b1` de b5bcd975). ad6dd41c: a parada só é recusa quando existe um DirectorRun bem-sucedido na
  Versão acima dela ou mais acima; senão a resposta é `none`, como antes. As recusas que a jornada de herança prova (LUT e exceção empilhada sobre ela, atrás de uma Versão
  dirigida) não mudaram.

## 2. R1 - o carry é visível como carry (5ca7ec84, 669e3d53)

Já estava completo no commit do escritor anterior (schema público `project-proxy-review-response/v4` com `carriedFrom {versionId, reviewId, reviewHash, decisionId,
renderContentHash}`, rótulo na UI "Aprovação herdada automaticamente da versão X - conteúdo idêntico", `reuseImpactHash` com o impacto do Command, baseline e paridade
regenerados). Um defeito: o apresentador saiu da rota para `proxy-review-presenter.ts` e a guarda estrutural T-FR-165 (que lia `outputSpecId`/`formatQuality` na rota) ficou
vermelha em `npm test`; 669e3d53 a aponta para o apresentador e exige que a rota delegue a ele.

## 3. R2 - o endereço de conteúdo prova entradas iguais (0eb29b58)

O endereço (`renderContentHash`) é calculado das entradas seladas antes de o render ler qualquer coisa, então não via (a) as janelas de rosto que o posicionamento de legenda
lê quando o render roda e (b) as issues do Director sobre as quais o laudo é montado; e era gravado no enqueue sem nunca ser conferido.

- `deriveProxyRenderGeometry` é a única derivação da geometria do proxy: o worker renderiza dela e o carry a executa para a cabeça. Ela registra toda resposta do leitor de
  janelas (id, hash do envelope, faixa e veredito do registro, confiável ou não), as janelas que o plano ainda pede (as pendentes) e se há leitor, como `faceEvidenceDigest`;
  `criticIssuesDigest` é o digest de `source.criticIssues`.
- O worker grava os dois na conclusão (migração 20261021120000, duas colunas CHAR(64) anuláveis, juntas ou nenhuma) e recalcula o endereço antes de renderizar: diferente do
  enfileirado, `INVALID_RENDER_INPUT` e nada é renderizado.
- O carry calcula os dois para a cabeça com o mesmo leitor do worker e recusa `face-evidence-moved` / `critic-issues-moved`; render sem digests nunca é fonte; a linha carregada
  copia os digests.

Provas: digests (independentes de ordem, todo movimento da evidência os move); worker grava o que o carry recalcula e recusa endereço movido; jornada de carry com a janela de
rosto pendente publicada depois do render (recusado; renderizado de novo e carregado) e com o digest de issues do Director movido (recusado; restaurado, carregado). O digest de
issues é movido à mão na jornada: nesse mundo não existe DirectorRun para movê-lo de verdade.

Não feito / limite: o endereço também não inclui o plano de cor da Versão (`colorPlans.readEffectiveForVersion`, que o worker aplica) além do que as compilações ligadas às fontes
já carregam. Não verifiquei se um Command de plano de cor entre um render ancestral e a cabeça pode deixar o endereço igual; registro para o Opus validar.

## 4. R3 - legenda que não cabe bloqueia antes do render (52913dbb)

`layoutCaption` dizia `fits: false` e o renderer ignorava; só o crítico de pixels pegava, e uma legenda de três linhas na faixa de duas linhas do 16:9 sai da faixa **1,6 px**
nos pixels entregues (medido, `W70-LAYOUT-3LINE` no log do passo `caption-text-layout`), dentro da tolerância de 6 px: o crítico não disse nada e o proxy passava.

- `caption-burn-layout.ts` (domínio) tem a geometria e as linhas da legenda queimada; o renderer desenha exatamente essas linhas. `captionLayoutOverflows` lista as cues
  DESENHADAS que não cabem, antes de qualquer render.
- Proxy: a cue é desenhada como está (a pessoa vê) e vira issue HARD `CAPTION_TEXT_DOES_NOT_FIT` daquela saída: o laudo fica bloqueado.
- Final (regra W65b): planeja de novo sem elas, e o recibo de certificação as lista como omitidas (`CAPTION_TEXT_DOES_NOT_FIT`, review-required). A política de certificação
  fixada nomeia a regra (`overflowingCue`), então seu digest - parte do hash de entrada de todo final - mudou (operações enfileiradas antes falham no worker, como projetado).
- `npm run test:integration:caption-text-layout` roda a prova de pixels (agora com o caso de três linhas 16:9); a CI roda depois dos goldens do renderer, com
  `fonts-liberation` instalado. **Não executado em CI hospedada** (só localmente): a estimativa de largura foi calibrada com Arial/Liberation Sans; um runner cujo `Arial` resolva
  para DejaVu sairia do que a prova afirma.

## 5. Cabeças de exceção por ancestralidade (60e10666)

`readSubtitleSegmentOverrideHeadsAsOf` escolhia, por segmento, a exceção mais nova por número de sequência. Agora anda por `parentVersionId` e escolhe a do ancestral mais
próximo. Hoje o histórico de um projeto é uma linha (Command com base que não é a cabeça é recusado) e as duas leituras coincidem; prova unitária com histórico ramificado.

## 6. Flake da jornada de browser W68 em `main` (CI 39593869024; 1177e5dd, b5bcd975)

Falha: `caption-form` nunca apareceu depois do re-login (`login -> openOutput -> selectChip('FACE_PIXEL_CHECK_UNAVAILABLE','cue-2') -> caption-form.waitFor()`). Pelo log da CI,
de `tall-unaffected-by-wide` até a falha passaram 62,5 s: login, abrir a saída e clicar o chip levaram ~2,5 s, e o formulário esperou 60 s.

Causa (produto): ao trocar de saída, a página mantinha o laudo da saída ANTERIOR até a nova leitura responder, e o painel o mostrava rotulado como da saída nova (e ainda o
"lembrava" com o rótulo errado). O chip clicado era a issue da outra saída; quando o laudo certo chegava, as chaves mudavam (outputSpecId), a seleção era descartada e o detalhe
e o formulário sumiam. Do mesmo tipo: as leituras de segmentos e do plano de reenquadramento não tinham cerca, e uma resposta lenta da saída anterior podia sobrescrever a da
atual (o formulário teria os textos da outra saída, e um Command os gravaria).

Correção: o laudo é guardado com a saída para a qual foi lido e só é o laudo da página enquanto essa saída está selecionada; segmentos e plano idem, e só a resposta da leitura
mais recente chega ao editor; o botão "Renderizar esta saída" não aparece enquanto o primeiro laudo da saída ainda está sendo lido. Regressão determinística na jornada: a
leitura do laudo da saída é retida, e enquanto isso nenhum chip da outra saída pode aparecer; depois os chips são exatamente os do laudo dela e o formulário edita esta saída.

Antes/depois, com a mesma regressão: contra o código anterior à correção (worktree temporária em 52913dbb + só o teste novo, harness `w70r-ui-before`) a jornada reprova
exatamente nela - o painel da saída 9:16 mostrava os chips da 16:9 (`FACE_PIXEL_CHECK_UNAVAILABLE` cue-1 e cue-2) enquanto o laudo da 9:16 era lido; com a correção
(`w70r-ui-after`) passa, assim como sidecar, carry e herança. A guarda estrutural W22 checa o nome `setProxyReview` no caminho de falha; b5bcd975 manteve esse nome.

## 7. Execuções (cabeça final 653264c2, árvore limpa; harness `run-local-pg-s2d.mjs`, lock global; os planos vêm do `ci.yml` deste ramo)

Portões em 653264c2: `typecheck`, `lint`, `lint:code`, `lint:whitespace`, `db:v2:validate`, `api:v1:validate`, `api:parity:validate` verdes; `npm test` 3847 testes, 3834
passam, 0 falham, 13 pulados (suítes com portão).

| Execução | Resultado |
| --- | --- |
| `full-b1` `w70r-final-b1-46aff9fb` | 41 passos, 115/115 |
| `full-b2` `w70r-final-b2-afa4c4dd` | 56 passos (inclui a herança do Director, agora um passo da CI), 110 passam, 3 pulados, 1 reprovado: `wave20-browser`, na limpeza (`Owned Wave20 browser cleanup must observe real closes without warnings`), com a jornada já concluída. Repetição isolada `w70r-rerun-w20-4f0bb7f8`: reprova igual; o mesmo passo na árvore de `main` (`w69t-w70p`, `w70r-w20-main-*`) reprova com o
mesmo aviso do observador de processos do navegador (mesmo `messageSha256` beaa6cf9...), então é do host neste momento, não deste ramo (passou no `b2` intermediário de b5bcd975). A jornada W68 (com a regressão nova), sidecar, carry, cancelamento, herança e final export passam |
| `full-b3` `w70r-final-b3-f9c44086` | 27 passos, 59 passam, 3 pulados, 1 reprovado: `library-journey` (S3/MinIO, ambiente, como no W68/W69). `synthetic-wave24-journey` 25/25 com o bundle Remotion |
| alvo: pixels de layout, renderer, posicionamento, final W65b (`w70r-r3-1-eda6eda9`) | 6 suítes verdes (a jornada W68 dessa execução reprovou no próprio `route.continue` do teste novo, corrigido) |
| alvo: W68 antes/depois (`w70r-ui-before-*`, `w70r-ui-after-97aad1a7`) | antes: reprova na regressão (chips da 16:9 sob a 9:16); depois: 4/4 |

Achados de ambiente, registrados para quem rodar depois:

- `synthetic-wave24-journey` exige árvore **limpa** (a atestação de build lê `git status`; um arquivo não rastreado basta para `VERSION_CONFLICT` no enfileiramento do render, que
  a API publica só como "Version conflict"). Duas execuções intermediárias reprovaram assim (o rascunho desta nota estava não rastreado); na mesma árvore de `main` passou. Alguns
  passos do `b3` (block-plan, synthetic-production, hybrid-search) regravam `next-env.d.ts` com caminhos `.next/dev`; durante o `b3` final ele foi restaurado ao conteúdo
  commitado (3 vezes) para não sujar a árvore.
- O disco do host chegou a 70 MB livres no meio do trabalho (um build reprovou com `ENOSPC`); cada execução do `b1` deixa ~0,5 GB em `%TEMP%\apollo-w39-artifacts-*`.
- Uma execução do harness abortou ao observar processos (`powershell ... Falha na inicialização do CLR`), sem relação com o produto.
