# F2.021 — Modos de prova v1

## Estado

Implementação local integrada ao runtime V2, compiler e Remotion. O requisito
permanece aberto no `TODO.md`: ainda faltam executar o E2E PostgreSQL atualizado
em ambiente seguro, implantar e auditar o mesmo comportamento em produção.

## Resultado implementado

`ProofModeRun` transforma somente avaliações `approved` de
`ProofIntegrityRun` em planos imutáveis por prova e formato.

Modos do MVP:

- `cutaway`: evidência visual em tela inteira;
- `split-screen`: presenter e evidência simultâneos;
- `proof-card`: card tipográfico/estático identificado.

Montage, audio-only e proof-first/cold-open não são aliases desses modos e
permanecem fora deste slice.

## Política

| Entrada | Escolha automática |
| --- | --- |
| áudio/documento | proof-card |
| contexto visual obrigatório | split-screen |
| vídeo/imagem + ritmo rápido | cutaway |
| vídeo medido + 16:9/21:9 | split-screen |
| imagem medida | proof-card |
| demais vídeos medidos | cutaway |

Cutaway e split-screen exigem vídeo/imagem. Contexto obrigatório bloqueia
proof-card. Override manual é permitido por
`proofNeedItemId + format + expectedEvaluationHash`; ele não relaxa essas
invariantes.

## Timing e composição

Cada plano conserva:

- texto exato da claim que o proof-card deve apresentar;
- frame e milissegundo de entrada vindos do ProofNeed;
- range integral aprovado no ProofIntegrity;
- duração mínima, alvo e máxima em frames;
- corte ou crossfade de entrada e saída explícita;
- canvas e safe area do preset canônico;
- regiões separadas para evidência, presenter, crédito e qualifiers;
- contraste mínimo 4,5 e fonte mínima proporcional ao canvas;
- attribution e qualifiers visual/verbal byte a byte iguais;
- contrato `proof-presentation/v1`, sem materializar mídia.

Os 15 goldens cobrem `9:16`, `16:9`, `4:5`, `1:1` e `21:9` nos três modos.

## Persistência

A migration `20260729163000_proof_mode_runs` cria:

- `proof_mode_runs`;
- `proof_mode_plans`;
- vínculos compostos com ProofIntegrity evaluation e ProofNeed item;
- vínculos com EvidenceSegment e media artifact;
- constraints de versão, contagens, modo/mídia, contexto, identificação,
  conteúdo e hashes.

Criação ocorre em transação serializável e revalida:

- ProofIntegrity ID/hash e readiness;
- evaluation, ProofNeed item e presentation hash;
- EvidenceSegment e artifact exatos;
- tipo e disponibilidade da mídia;
- current rights snapshot ainda igual ao snapshot catalogado;
- expiração de rights/consent;
- API client ativo.

Run e planos são hidratados do JSON canônico e comparados às projeções
relacionais.

## API

| Capability | Método e rota |
| --- | --- |
| `apollo.projects.proof-mode-runs.list` | `GET /v1/projects/{projectId}/proof-mode-runs` |
| `apollo.projects.proof-mode-runs.create` | `POST /v1/projects/{projectId}/proof-mode-runs` |
| `apollo.projects.proof-mode-runs.read` | `GET /v1/projects/{projectId}/proof-mode-runs/{runId}` |

A listagem filtra por ProofIntegrity, formato, modo e origem automática/manual.
A criação é bounded, idempotente e não inicia provider, render ou
materialização.

## Interface

O painel “Composição da prova” consome exclusivamente `/v1` e mostra:

- preview proporcional ao canvas;
- regiões de evidência, presenter, crédito, qualifier e safe area;
- modo, formato, timing, transições e contexto;
- attribution e qualifiers obrigatórios;
- origem automática ou manual;
- ações para override por segmento/formato.

Um override cria outro run imutável pela API. Botões que removeriam mídia ou
contexto ficam desabilitados, e o servidor repete a validação.

## Evidência atual

- `tests/v2/proof-mode.test.mjs`: seleção, 15 goldens, overrides, integridade,
  tamper e application service;
- `tests/v2/project-editor-ui.test.mjs`: leitura e override exclusivamente
  pela `/v1`;
- `tests/v2/proof-mode-visual-goldens.integration.mjs`: quinze stills reais nos
  presets canônicos, contact sheet, inspeção de contraste/dimensões e três MP4s
  reais materializados pelo port Remotion;
- contract registry: 160 capabilities, 248 schemas, 280 exemplos e 127 paths;
- migration estática: 104 tabelas, 532 índices e 407 FKs;
- regressão unitária completa: 592/592 testes;
- TypeScript da aplicação e do Remotion, arquitetura V2-only, linguagem de
  domínio, contratos, schema, auditorias de segurança e `git diff --check`
  verdes;
- build de produção Next.js concluído em 159,2 s, registrando as rotas públicas
  de proof mode; bundle Remotion aprovado.

O primeiro run visual detectou dois defeitos que os testes estruturais não
enxergavam: legendas horizontais continuavam sobre a prova e o conteúdo do
proof-card colidia com attribution/qualifiers. O run foi rejeitado. O renderer
passou a ocultar legendas durante toda a janela de proof-presentation, o layout
do card ganhou regiões não sobrepostas e o segundo run foi revisado nas quinze
combinações.

Evidência local aprovada do segundo run:

- 15 PNGs: `9:16`, `16:9`, `4:5`, `1:1` e `21:9` × cutaway,
  split-screen e proof-card;
- MP4 cutaway 9:16:
  `ba8300425fce6d329cacfe70f996798def7f9337926a048ecd61ac7cbe5365ea`;
- MP4 split-screen 16:9:
  `1a1a005860a9c604e01a9ac40142ac0f170590e82c3d71c575c65092a7272d0c`;
- MP4 proof-card 1:1:
  `7f237ca0fbd6579f0a01f14a63678df27e8d6033f5f4671d378a18ddc98e9ae4`;
- nenhuma cena aplicou zoom/pan; attribution e qualifiers permaneceram dentro
  das regiões seguras; a legenda sentinela ficou ausente em todos os formatos.

O cenário T-FR-132 foi acrescentado ao E2E real
`tests/v2/prisma-compatibility-graph.integration.mjs`, incluindo API,
PostgreSQL, replay, mismatch, override, filtros, constraints e contagem
inalterada de artifacts. Ele não foi reexecutado após esta alteração porque a
VPS está explicitamente interditada durante o incidente operacional; isso não
é contado como evidência concluída.

## Esteira durável de render (correção do caminho de produção)

Até esta revisão, os três MP4s de prova eram produzidos chamando
`RemotionRenderInputRenderer.stage()` diretamente dentro do teste. Isso provava
o renderer, não o produto: nenhuma operação durável era criada, nenhum lease era
renovado e nenhum checkpoint era persistido.

A esteira durável real que renderiza composições Remotion em produção é:

1. `runNextPublicOperationService`
   (`src/v2/application/run-public-operation-worker.ts:60`) — reivindica a
   operação `artifact-render` com `claimNext`, mantém o lease com `heartbeat`,
   avança as fases `rendering → verifying → persisting` com `advancePhase`,
   grava o checkpoint em `ArtifactRenderCheckpointRepository` e conclui com
   `succeed`/`failOrRetry` e backoff exponencial;
2. `renderAuthorizedInputService`
   (`src/v2/application/render-authorized-input.ts:28`) — materializa o
   `RenderInput` autorizado, revalida `inputHash`/`revalidationHash` antes da
   promoção e descarta o staging em caso de falha;
3. `RemotionRenderInputRenderer`
   (`src/v2/infrastructure/remotion-render-input-renderer.ts:269`) — renderiza
   e promove o MP4.

A fábrica de produção monta exatamente essa cadeia em
`createPublicOperationWorker` /`createAuthorizedRenderExecutor`
(`src/v2/infrastructure/repository-factory.ts:1293` e seguintes). Nenhuma
operação nova foi inventada: cenas de prova são cenas do `RenderInput` da
composição `apollo-video`, que é o que essa operação já renderiza.

O elo que faltava era a compilação. Ele passou a existir como módulo de
aplicação, não como código de teste:

- `src/v2/application/compile-proof-mode-render-input.ts` —
  `compileProofModeRenderInput` recebe um `ProofModePlan` aprovado e devolve o
  `RenderInputSpecV1` portável (presenter no ordinal 0, evidência no ordinal 1,
  cena `proof-presentation` compilada por `compileProofModeRenderScene`,
  duração mínima igual a `timelineEntryFrame + targetDurationFrames`). Ele
  recusa evidência cujo `kind` divirja de `sourceMediaType` e recusa
  `split-screen`/`proof-card` sem presenter em vídeo.

Com isso o golden visual deixou de chamar o adapter: cada MP4 é produzido por
`compileProofModeRenderInput → runNextPublicOperationService →
renderAuthorizedInputService → RemotionRenderInputRenderer`, e o teste afirma as
fases exatas, a renovação de lease, a revalidação dupla do input e o checkpoint
cujo `byteSize` bate com o arquivo promovido.

## O que os goldens medem agora

Antes só se verificava dimensão e um delta de contraste global por canal. As
verificações passaram a ser medidas em pixels, para os 15 stills e para os 3
MP4s:

- contraste de identificação: razão de contraste WCAG entre o percentil 99,5 e o
  percentil 10 de luminância dentro de `creditRegion` e de `qualifierRegion`,
  exigida `>= plan.legibility.minimumContrast` (4,5);
- altura real dos glifos: extensão vertical, em pixels, das linhas que contêm
  pixels quase brancos dentro da faixa de attribution, exigida
  `>= 0,7 × minimumFontPixels`;
- marcador de identificação: presença de pixels do acento na borda esquerda de
  `creditRegion`;
- quadro de entrada e de saída: o quadro 0 precisa ter menos acento que o quadro
  do meio (o `entryTransition` é `crossfade`) e o último quadro precisa manter
  pelo menos 80% do acento do meio (o `exitTransition` é `cut`);
- contagem de quadros igual a `output.durationInFrames`;
- separação de modos: cutaway precisa trocar o presenter pela evidência
  (distância de cor >= 24), split-screen precisa mostrar duas fontes distintas
  na mesma imagem (distância de cor >= 24) e proof-card precisa escurecer o
  fundo (luminância relativa <= 0,1) mantendo o cartão pelo menos 3× mais claro;
- matriz: os 15 `inputHash` e os 15 `layoutHash` precisam ser distintos, o que
  impede que dois modos virem alias um do outro.

### Medições do run local (2026-08-21, Windows 11, 2 execuções verdes)

Stills (15/15):

- contraste de attribution entre 20,10 e 20,27 (mínimo exigido 4,5);
- contraste de qualifiers entre 16,53 e 16,94;
- altura medida dos glifos de attribution entre 31 px e 52 px;
- 15 `layoutHash` distintos e 15 `inputHash` distintos.

MP4s, todos com fases `rendering → verifying → persisting` e checkpoint cujo
`byteSize` bate com o arquivo:

| modo | formato | quadros | bytes | sha256 (prefixo) | acento entrada/meio/saída | contraste attribution | glifo | sinal do modo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cutaway | 9:16 | 75 | 524.580 | `f6ee87d8af723e02` | 0 / 938 / 939 | 20,13 | 52 px | distância de cor 126,15 |
| split-screen | 16:9 | 135 | 1.309.065 | `687f2da4d8d9e51b` | 0 / 526 / 526 | 20,03 | 33 px | distância de cor 107,10 |
| proof-card | 1:1 | 120 | 235.213 | `b63f80b48aa288d5` | 0 / 515 / 515 | 20,05 | 31 px | cartão 68,14× o fundo |

O acento zero no quadro de entrada e mantido no quadro final é a prova direta do
`crossfade` de entrada e do `cut` de saída definidos por `ProofModeTiming`.
Attribution e qualifiers renderizados conferem byte a byte com
`presentation.visual` do plano.

Duração do golden completo: ~166 s por execução (n=2, ambas verdes). O bundle do
Remotion precisa existir antes (`npm run remotion:build`); sem ele o teste falha
com `RENDER_WORKER_FAILED`.

## Cobertura de runtime sem renderer

`tests/v2/proof-mode-render-runtime.test.mjs` roda na suíte padrão (sem ffmpeg,
sem Remotion) e cobre: distinção estrutural dos 15 pares formato×modo, compilação
dos 15 `RenderInput`, vínculo do override manual a evaluation/modo/formato/faixa/
hash com rejeição de hash divergente, e a travessia de uma cena de prova pela
operação durável com fases, lease e checkpoint.

## E2E de API/PostgreSQL

O cenário T-FR-132 do E2E real
(`tests/v2/prisma-compatibility-graph.integration.mjs`) ganhou duas provas que
faltavam, ambas contra a API `/v1` e o PostgreSQL reais:

- **stale**: `POST /v1/projects/{id}/proof-mode-runs` com
  `overrides[].expectedEvaluationHash` divergente responde 409, e o mesmo ocorre
  com `expectedProofIntegrityRunHash` divergente; a contagem de
  `v2ProofModeRun` permanece inalterada;
- **tamper**: alterar `presentation.visual.attribution` dentro do `planJson`
  persistido faz o `GET` do run e a listagem responderem 409
  (`PERSISTENCE_CONFLICT`); restaurar a linha devolve 200 com o `runHash`
  original, provando que a rejeição veio do conteúdo adulterado.

Scripts: `npm run test:integration:proof-mode-goldens` (unidade + runtime +
goldens visuais sob `APOLLO_PROOF_MODE_VISUAL_E2E=1`) e
`npm run test:e2e:proof-modes`, que executa o arquivo de E2E real acima sob
`APOLLO_COMPATIBILITY_GRAPH_E2E=1` — ele cobre outros FRs no mesmo arquivo
porque é lá que a cadeia ProofNeed → ProofIntegrity → ProofMode é semeada; não
foi duplicado um segundo semeador.

No CI, os goldens rodam no job de qualidade logo após o bundle do Remotion, e o
E2E de API/PostgreSQL roda no job `local-infrastructure` contra um banco
`apollo_v2_e2e` provisionado no Compose, com `application_name`
`apollo-video-e2e-ci-proof-modes`, `connection_limit=5` e verificação de zero
backends órfãos em `pg_stat_activity` ao final.

## Pendências de aceite

1. executar o E2E PostgreSQL em ambiente descartável local ou VPS formalmente
   liberada e saudável. Os passos de CI existem (`local-infrastructure`), mas a
   máquina de desenvolvimento usada nesta revisão não tem Docker nem `psql`;
   nenhuma execução verde do E2E de API/PostgreSQL foi observada aqui, apenas os
   testes de unidade, runtime e os goldens visuais;
2. observar o job `local-infrastructure` verde com os novos passos;
3. implantar e auditar produção;
4. somente então marcar as cinco caixas do F2.021.
