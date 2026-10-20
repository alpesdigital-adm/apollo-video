# W67 — resultados do crítico independente do MP4 entregue (v1)

Estado: **corpus controlado registrado executado uma vez; aceite do pré-registro atendido; limites declarados no §6.** Este documento se lê junto com o pré-registro `docs/quality/w67-mp4-critic-preregistration-v1.md`. O resumo por saída, com os SHA-256 dos MP4 entregues e dos relatórios selados, está em `docs/quality/w67-mp4-critic-results-v1.json` (sem mídia).

## 1. Ordem dos commits e proveniência

| commit | o que | relação com o primeiro render do corpus registrado |
| --- | --- | --- |
| `524755c2` | pré-registro, etapa 1 (regras, política, aceite) | antes |
| `4c506715`, `824d1078` | crítico, oráculo, selo, porta de exportação, ferramentas do corpus | antes (código congelado, hashes no manifesto) |
| `5838b3ae` | pré-registro, etapa 2 + manifesto congelado `w67-mp4-critic-corpus-v1.json` | **antes**: a corrida registrada começou depois deste commit |

- Manifesto: SHA-256 do arquivo `f88584cdd473906544d784b4379bbbc2f04ed52e68a4016915ac2a0b76d90b2f`, `manifestHash` `5fe1eaf409f84055d103a714d0d194927910565ef9e5710c60872c74048d4f0a`, política `c7089682fa32b55fd39a16e359e8d92217e8339773995d416627a1cbbaaca687`. A corrida recusa começar se um dos 13 arquivos de código congelados mudar ou se o manifesto não se re-derivar; nenhum arquivo congelado foi editado depois do commit `5838b3ae`.
- Corpus: 2 fotografias do split calibration do Open Images V5, escolhidas pela regra fixa R1–R5 (só metadados) **e por uma exclusão visual R6 POST HOC** da primeira da fila (retrato numa cédula; inspeção automatizada do agente redator, **não humana**; escrita depois de eu ver títulos e fotos dos 3 candidatos, e foi ela que decidiu o corpus, ver pré-registro §11 e os resultados de sensibilidade no §8 abaixo): `1580caef8efed517` (homem de cartola com trompete, CC BY 2.0, Zaneology) e `9295ab265fafd8e5` (homem deitado numa cama de hospital, CC BY 2.0, Franco Dal Molin). Caixas humanas do Open Images (`xclick`), inalteradas; olhos desconhecidos; sem adjudicador de projeto.
- Divulgações (pré-registro §11): as regras de enquadramento e o planejador de legendas de produção foram executados sobre caixas humanas e dimensões de itens do calibration (só metadados) às 20:03–20:05, antes do congelamento (sem detector nem render); e o `renderInputHash` dos relatórios do corpus é um substituto (hash de `{ saída, placementPlanHash, reframePlanHash }`, `corpus-run.mjs:135`), não o hash de um `RenderInput` de produção.
- Holdout do W62: **nunca aberto, listado ou lido**. O detector de produto (V9) rodou no W62 só nas 60 fotos de development; o retail-0004 e o YuNet passaram pelo calibration no W61 (V5–V7) com configurações pré-registradas, então o calibration **não é virgem para o retail-0004**.
- Oráculo: união de `omz-face-detection-0204` (V9 do produto, 448 BGR, score ≥ 0,5) e `omz-face-detection-retail-0004` (300 BGR, score ≥ 0,5), mais a projeção registrada das detecções do quadro de origem (ORB, 2000 pontos, razão 0,75, RANSAC de similaridade 3 px, semente 0). Os tensores brutos são decodificados em TypeScript; `unknown` quando não há evidência. Os SHA-256 dos modelos, da ponte e do interpretador entram no selo de cada relatório.
- Controles: o mesmo `RenderInput` renderizado sem legenda, sem CTA e sem ambos pelo renderer real do produto (FFmpeg 6.1.1 essentials, binário SHA-256 `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`). Tinta = entregue menos controle.

## 2. O que foi implementado (estado: integrado ao runtime com o crítico opcional; provado localmente)

Um crítico do MP4 efetivamente entregue, independente do plano, do `RenderElementMap` e do detector do produto como único oráculo.

| peça | arquivo | papel |
| --- | --- | --- |
| domínio (puro) | `src/v2/domain/mp4-pixel-quality.ts` | política com unidades, avaliação por amostra, localização das issues, planejamento de amostragem, relatório selado `mp4-quality-report/v1`, selo `mp4-evidence-seal/v1` |
| geometria de pixels (pura) | `src/v2/domain/mp4-pixel-geometry.ts` | tinta, retângulos, portões e projeção do registro, sujeito |
| oráculo (puro) | `src/v2/domain/pixel-face-oracle.ts` | pins dos dois modelos, decodificadores TypeScript dos tensores brutos (V9 e retail-0004), união |
| ponte OpenVINO | `src/v2/infrastructure/perception/openvino_pixel_oracle_bridge.py`, `openvino-pixel-oracle.ts` | dois detectores + registro ORB; devolve tensores brutos; hashes do interpretador, da ponte e dos modelos conferidos nos dois lados |
| crítico | `src/v2/infrastructure/media/ffmpeg-mp4-pixel-critic.ts` | decodificação completa, controles em passo travado, tinta, oráculo em lotes, fatos por amostra, selo |
| porta e aplicação | `src/v2/application/ports/mp4-pixel-critic.ts`, `verify-delivered-mp4.ts` | porta; execução dos controles (mesmo `RenderRequest` sem o overlay) e persistência do relatório como JSON endereçado por conteúdo |
| veredito por variante | `src/v2/domain/format-quality-critic.ts` | `format-quality-report/v3` (traz `mp4Evidence`); `selectExportableVariants` rejeita v2 e rejeita relatório que permite o que o selo proíbe |
| proxy | `run-project-proxy-render-worker.ts` | issues do crítico entram no veredito da variante; sem crítico lido = aviso `MP4_PIXEL_CRITIC_UNAVAILABLE`, nunca aprovação |
| final | `run-project-final-export-worker.ts` | **antes de promover**: relatório selado e guardado, `critiqueOutputFormat` + `selectExportableVariants`; variante bloqueada (ou crítico que não leu o arquivo) não é promovida, anexada nem catalogada |
| composição | `repository-factory.ts` (`optionalMp4PixelCritic`) | ligado só quando todas as variáveis `APOLLO_V2_PIXEL_ORACLE_*` existem; configuração parcial falha fechada |
| contrato público | `schema-registry.ts`, `capability-registry.ts` | `project-proxy-review-response` e `…-warning-acknowledgement-result` v3 (aditivo: `formatQuality.mp4Evidence`); v2 mantém seus bytes; capabilities `proxy-reviews.read` 2.2.0 e `acknowledge-warnings` 2.1.0; baseline e relatório de paridade regenerados no mesmo commit |

Nenhuma migração de banco: o selo viaja no JSON `formatQualityJson` do review já persistido (lido de volta com validação estrita) e o relatório completo vai para o armazenamento de conteúdo.

## 3. Resultados do corpus registrado

Corrida do harness `w67-calibration-run1-4fcf3a8c` (passos `render`, `evaluate`, `keep-first-evaluation`, `evaluate-replica`, `compare-replica`; todos com exit 0, pós-voo limpo, PostgreSQL descartável; lock de carga global respeitado). Unidade de avaliação: defeito × formato × intervalo; "detectado" = os quadros marcados são exatamente o intervalo rotulado.

| defeito | formato | unidades rotuladas | detectadas | exatas | falso seguro | marcações em unidade sem rótulo | quadros extras | quadros unknown |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| caption-over-face | 16:9 | 4 | 4 | 4 | 0 | 0 | 0 | 0 |
| caption-over-face | 9:16 | 4 | 4 | 4 | 0 | 0 | 0 | 0 |
| crop-lost | 16:9 | 4 | 4 | 4 | 0 | 0 | 0 | 0 |
| crop-lost | 9:16 | 4 | 4 | 4 | 0 | 0 | 0 | 0 |
| cta-outside-safe-area | 16:9 | 4 | 4 | 4 | 0 | 0 | 0 | 0 |
| cta-outside-safe-area | 9:16 | 4 | 4 | 4 | 0 | 0 | 0 | 0 |

Totais: 20 saídas, 24 unidades rotuladas; 24 detectadas (recall 100%), 24 exatas; 0 falso seguro; 0 falso positivo (as 4 saídas limpas passaram e nenhuma unidade sem rótulo foi marcada); 0 issue hard sem classe; 0 quadro `unknown`; 0 falha de decodificação. **Aceite do §6 do pré-registro: atendido.** Intervalos: caption-over-face quadros [8, 28) = 20 quadros; crop-lost [45, 90) = 45; cta-outside-safe-area [31, 44) = 13. Cada marcação saiu com exatamente esses quadros, nas 4 combinações foto × formato de cada classe e também nas 4 saídas `combined`, onde os três defeitos coexistem.

### 3.1 N e dispersão (o que "medido" quer dizer aqui)

- **N = 1 corrida de render** (uma renderização de cada uma das 20 saídas) e **2 avaliações completas** dos mesmos arquivos. A réplica de avaliação deu **20 de 20 hashes de relatório selado idênticos** e o mesmo aceite: o crítico é determinístico sobre os mesmos bytes. Isso **não** mede variação de renderização, de foto ou de detector; são duas fotos.
- Com duas fotos, 20 saídas e uma corrida, os 100% são resultado de **controles mecânicos** (a fonte é uma foto parada), não uma taxa populacional. O limite inferior de 24/24 pela regra dos três é de cerca de 87,5% (95% unilateral), e não representa vídeo natural.
- Dispersão do que foi medido nos pixels (por saída, 90 quadros):
  - IoU da projeção por registro ORB contra a caixa humana projetada por construção: mediana por saída de 0,793 a 0,830, mínimo por quadro 0,787. O registro por pixels reproduz a geometria construída.
  - Tinta da legenda no quadro 18: de 6622 a 9448 pixels nas saídas limpas e de 6377 a 9392 nas com legenda. Pixels dessa tinta dentro da caixa humana: 0 nas limpas e de 3523 a 5210 nas saídas com legenda-defeito.
  - Excesso do CTA para fora da safe area no quadro 37: 31,9 px no 9:16 e 3,5 px no 16:9 (os mesmos valores nas 4 saídas de cada formato, porque o texto e a geometria são iguais).
  - Fração visível da caixa humana no quadro 60: 1,00 (controle) e 0,35 (crop perdido).
  - Tempo do crítico por saída: mínimo 16,9 s, mediana 20,1 s, máximo 32,5 s (N = 20, uma máquina). Renderização por saída: 0,84 s a 1,07 s.

### 3.2 Detectores (informativo; nada disso entrou em limiar)

| modelo | quadros com rosto inteiro no canvas | encontrado (IoU ≥ 0,3) | recall | detecções sem relação com a caixa |
| --- | ---: | ---: | ---: | ---: |
| omz-face-detection-0204 (V9) | 1440 | 1440 | 100,0% | 0 |
| omz-face-detection-retail-0004 | 1440 | 1080 | 75,0% | 0 |
| união | 1440 | 1440 | 100,0% | 0 |

**Achado:** o retail-0004 não achou o rosto em **nenhum dos 360 quadros** da foto `9295ab265fafd8e5` em 9:16 (homem deitado, cabeça inclinada, recorte vertical estreito) e achou em todos os outros 1080. O V9 achou 1440 de 1440. A união cobriu; é por isso que o oráculo é uma união e não o retail-0004 sozinho. É um recall baixo do segundo detector, declarado, não um ajuste: nada foi mudado por ele. Nenhum detector deu detecção sem relação com a caixa humana (0 em 1440 quadros por modelo).

### 3.3 Revisão visual das folhas de contato (automatizada, **não humana**)

Folhas em `C:/Users/leand/Documents/Apollo/w61-70-20261008/w67-calibration-run-1/contact-sheets/` (privadas). Vi `9295ab265fafd8e5-9x16-combined` e `1580caef8efed517-16x9-combined`:

- A legenda de defeito cobre o queixo e a barba do homem no 9:16 e a região do queixo e do pescoço no 16:9.
- No crop perdido o rosto sai pelo topo do quadro (ficam o corpo e as mãos).
- O CTA do 9:16 é cortado nas duas bordas do canvas ("om desconto exclusivo … e bonu").
- No 16:9 o CTA cabe no canvas mas invade a safe area por 3,5 px. É um excesso **pequeno**: o rótulo é verdadeiro nos pixels (sanidade de rótulos, excesso medido pelo mesmo cálculo do crítico), mas o olho quase não o distingue de uma legenda dentro da margem.

A revisão visual é do agente, serve de sanidade e não substitui revisão humana.

### 3.4 Prova do bloqueio de exportação

Nível 1, **o código de produção sobre os relatórios reais**: `corpus-run.mjs` aplica `critiqueOutputFormat` e `selectExportableVariants` (as funções que o worker final usa) a cada relatório selado e só copia para `promoted/` o que elas aprovam. Resultado: **4 aprovadas e 4 promovidas**, exatamente as 4 saídas limpas; **16 bloqueadas e 0 promovidas**. Códigos bloqueadores: `SUBTITLE_FACE_OVERLAP_IN_PIXELS` (legenda), `SUBJECT_CLIPPED_IN_PIXELS` (crop), `INK_OUTSIDE_SAFE_AREA_IN_PIXELS` e, no 9:16, também `INK_CLIPPED_BY_CANVAS_IN_PIXELS` (CTA); as `combined` levam os códigos das três classes. Os 4 arquivos em `promoted/` têm os SHA-256 dos entregues das limpas (conferido por script; campo `promoted` do JSON de resultados).

Nível 2, **o worker final em teste de unidade** (`tests/v2/project-final-export.test.mjs`, casos W67): armazenamento falso, **zero chamadas de promoção, anexo e catálogo** para a variante bloqueada; crítico que não lê o arquivo = sem promoção; `selectExportableVariants` rejeita relatório v2 e relatório cujo selo proíbe a exportação. A corrida do §3 **não** executou o worker final sobre PostgreSQL; a ligação do worker ao crítico é provada pelos testes de unidade e pela suíte sintética com o renderer real, não por este corpus.

## 4. Falhas, conflitos e o que não deu certo (publicados)

- Rótulo × pixels: **0 conflitos**. Nas 20 saídas a legenda-defeito cai sobre a caixa humana nos pixels e a limpa não; o CTA excede a safe area onde rotulado e não onde não é; a fração visível da caixa no crop perdido é 0,35. O planejador de legendas (código de produção) levou a cue para a faixa-alvo do rótulo nas 8 saídas com legenda-defeito.
- Nenhum quadro `unknown` e nenhuma amostra sem decodificar. Nenhum limiar, rótulo ou oráculo foi alterado depois do congelamento.
- Antes do congelamento (declarado no §9 do pré-registro): 3 falhas de encanamento da ponte do oráculo, a primeira corrida da suíte sintética (6 de 9) e uma avaliação abortada pela checagem de congelamento de código. Nenhuma produziu medida de detecção sobre foto do calibration.
- O retail-0004 não detectou o rosto de `9295ab265fafd8e5` em 9:16 (§3.2).

## 5. Achado pré-existente (não causado por este trabalho)

O esquema público `formatQuality` da revisão de proxy omitia `placementPlanHash` e `reframePlanHash`, que o veredito armazenado já carregava. O esquema v3 (aditivo; v2 mantém seus bytes) agora os lista; `tests/v2/proxy-review-hydration.test.mjs` cobre o contrato.

## 6. Limites

- Duas fotos, 20 saídas, uma corrida de render: **controles mecânicos** sobre uma foto parada, não vídeo natural nem taxa populacional.
- A completude da anotação (nenhum outro rosto na foto) repousa no Open Images *validation* e **não foi adjudicada por humano**; olhos desconhecidos.
- O oráculo é um detector (união de dois). Onde os dois falham o quadro fica `unknown` (por isso o aceite exige 0 unknown, e deu 0); um rosto que nenhum modelo vê **não** é detectável por este crítico.
- A legenda-defeito usa evidência fabricada para o planejador (caixas-fantasma e rosto omitido); a posição final é a do planejador de produção, conferida contra o rótulo.
- Densidade de tinta não tem defeito semeado: só falsos positivos medidos (0).
- Runtime Windows (Python 3.14, OpenVINO 2026.4.0, OpenCV 4.13.0, NumPy 2.5.1); sem recibo de paridade Linux. **O OpenVINO não roda no CI hospedado**: as provas com o oráculo real são locais (`KNOWN_UNRUN` `W67_MP4_CRITIC_PIXELS`, suíte `tests/v2/mp4-pixel-critic.integration.mjs`, que usa um oráculo de chave de cor, não o OpenVINO); o CI cobre os testes de domínio, de portão, de contrato e de hidratação.
- Nenhum modelo reprovado, fixture mecânica ou supressão geral de legendas converte este documento em crítico visual validado; aprovação do proprietário e revisão humana são etapas separadas.

## 7. Gates e execuções locais (cabeça `ab3e4918`, árvore limpa; este documento é o único acréscimo posterior)

Gates diretos, todos exit 0: `typecheck`, `lint`, `lint:code`, `lint:whitespace`, `db:v2:validate`, `api:v1:validate`, `api:parity:validate`.

Execuções pelo harness (`run-local-pg-s2d.mjs`, `APOLLO_S2D_CHECKOUT` = o worktree, lock global respeitado, intervalos de 60 s entre execuções; as pastas estão em `s2d-runs/`):

| execução | passos | testes | passaram | falharam | pulados | resultado |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `w67-full-3-65923a68` (`npm test` completo + suíte sintética `mp4-pixel-critic.integration.mjs`) | 2 | 3723 | 3710 | 0 | 13 | verde (suíte completa 3713 / 3700 / 0 / 13; sintética 10 / 10) |
| `w67-full-b1r-597c0ec4` (full-b1, com build) | 37 | 104 | 103 | 1 | 0 | 1 falha **herdada** (dashboard runtime journey) |
| `w67-full-b2-c7e98c37` (full-b2, com build) | 51 | 109 | 105 | 1 | 3 | 1 falha de tempo, **verde ao repetir** |
| `w67-full-b3-bed6a701` (full-b3, com build) | 27 | 39 | 33 | 3 | 3 | 3 falhas **herdadas** |

- Uma primeira execução do b1 (`w67-full-b1-f2b80d8e`) foi abortada pelo próprio harness: a consulta `Get-CimInstance Win32_Process` do observador de processos foi cancelada pelo WMI (carga da máquina). Não é falha de teste; o b1 foi refeito (`…b1r…`).
- Uma execução anterior da suíte completa (`w67-full-2-316e32c4`) achou 3 falhas reais minhas (a auditoria de spawns de `ffmpeg-binary-resolution` recusava o spawn do Python do oráculo, e a checagem de suítes não executadas exigia que este documento citasse a suíte sintética). Foram corrigidas no commit `ab3e4918` (registro auditado do spawn, `optionalMp4PixelCritic` no formato `required(...)` e citação); a execução `w67-full-3` é a verde.
- `quali-051-test-integration-api` (no b2) falhou com "W36 timed out waiting for bounded retries" sob carga; repetido isolado (`w67-full-051r-7ac74eed`): 12 de 12.
- **Herdadas**, reproduzidas na base do meu branch (`ba56e0db`, sem nenhum código do W67), com a mesma mensagem: `dashboard-runtime-journey` (`w67-basecheck-088-8736733d`: "The negative must reach the real persistence admission gate", 0 !== 1) e, no b3, `059 export-matrix.e2e` (`false !== true` na pré-verificação), `069 library-journey.e2e` (`'local' !== 's3'`, o ambiente local não tem o S3 versionado) e `070 synthetic-wave24-journey` (409 `PERSISTENCE_CONFLICT` no enqueue de render do project-a-final, o VERSION_CONFLICT do W24 já em investigação no W64), tudo em `w67-basecheck-b3-86a2660b`. Nenhuma delas toca código do W67 (pré-verificação de matriz, S3, enqueue).
- CI: nenhum passo novo foi necessário para o crítico em si além dos testes de domínio, de portão, de contrato e de hidratação, que rodam em `npm test`; a suíte com o runtime real do OpenVINO é `KNOWN_UNRUN` com motivo (§6), e o corpus registrado é local por construção (modelos privados, runtime Windows).

## 8. Execução de sensibilidade pós-hoc: a foto excluída por R6 (`968a460084c588a1`)

Declarada no pré-registro §11 e commitada antes de renderizar (`fb3aec56`, manifesto `19eafe8b`: `docs/quality/w67-mp4-critic-sensitivity-968-v1.json`, `manifestHash` `f96ae78e1a8d88dc470dea9af47aa99a2f69934c6b01c84a8e557c7865db0d02`, SHA-256 do arquivo `6fb49ec64ea5e29c2ba63ccf3f127b66eff3afa2d0955d197f915eff243191ae`). Roda sob o **código congelado** (os 13 SHA-256 de código e o da política iguais aos do manifesto registrado, conferido; nenhum arquivo congelado tocado). Corrida do harness `w67-sensitivity-968-a74cd3a6` (passos `render`, `evaluate`, exit 0, pós-voo limpo). Resumo por saída em `docs/quality/w67-mp4-critic-sensitivity-968-results-v1.json`. **É uma execução pós-hoc: não entra no aceite do corpus registrado e não o altera.**

| defeito | formato | unidades rotuladas | detectadas | exatas | falso seguro | marcações em unidade sem rótulo | quadros unknown |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| caption-over-face | 16:9 | 2 | 2 | 2 | 0 | 0 | 0 |
| caption-over-face | 9:16 | 2 | 2 | 2 | 0 | 0 | 0 |
| crop-lost | 16:9 | 2 | 2 | 2 | 0 | 0 | 0 |
| crop-lost | 9:16 | 2 | 2 | 2 | 0 | 0 | 0 |
| cta-outside-safe-area | 16:9 | 2 | 2 | 2 | 0 | 0 | 0 |
| cta-outside-safe-area | 9:16 | 2 | 2 | 2 | 0 | 0 | 0 |

Totais: 10 saídas, 12 unidades rotuladas; 12 detectadas e 12 exatas; 0 falso seguro; 0 falso positivo (as 2 limpas passaram); 0 `unknown`; 0 falha de decodificação. Mesmos intervalos exatos (20, 45 e 13 quadros). Com as 20 saídas registradas somam 30 saídas e 36 unidades, todas exatas (a soma é informativa; o aceite registrado é o do §3). N = 1 render e 1 avaliação (sem réplica).

O que a execução mostra além do placar:

- **A exclusão não escondia uma falha deste crítico.** Os dois detectores trataram o retrato gravado na cédula como um rosto: V9 achou a caixa humana em 720 de 720 quadros, retail-0004 também (720 de 720, mas com 360 detecções sem relação com a caixa, todas no 16:9), e a projeção por registro bateu com a construção (IoU mediana 0,786). Por isso a legenda de defeito caiu "sobre o rosto" e foi marcada.
- **Limite que isso evidencia:** o crítico não distingue um rosto de uma representação de rosto. Um retrato impresso, um cartaz ou uma tela com rosto passam a ser regiões protegidas; é o comportamento conservador (protege mais, não menos), mas significa que "rosto" aqui é "o que os detectores acham que é rosto". Isso é a razão técnica pela qual R6 não é uma regra do crítico e sim uma regra de escolha de fotos, e o motivo de eu ter tratado a cédula como depiction; o resultado de sensibilidade diz só que, tratada como foto de rosto, ela também é medida de forma exata.
- O corpus registrado (2 fotos, escolhidas com a exclusão R6 post hoc) e a foto excluída dão o mesmo veredito qualitativo; isso **não** valida a escolha das fotos nem torna R6 uma regra pré-registrada.

## 9. Emenda pós-revisão: o final falha fechado, a proveniência do detector, o código depois da corrida registrada

Pedida pela revisão do coordenador (Astra/Opus); commits `50570fbd` (código e testes) e `312a1275` (merge de `origin/main` 11823b72).

**Falha aberta achada na revisão.** Quando a ponte do OpenVINO caía, o crítico engolia o erro e deixava os quadros `unknown` (`ffmpeg-mp4-pixel-critic.ts`); `unknown` era só aviso (`mp4-pixel-quality.ts`) e tudo o que não fosse bloqueado era aprovado (`format-quality-critic.ts`, worker final). Um OpenVINO caído entregava o final, contra o que os comentários do worker diziam. O mesmo valia para um crítico não ligado (só ligava com as 7 variáveis `APOLLO_V2_PIXEL_ORACLE_*`).

**Regra agora** (`src/v2/domain/mp4-export-gate.ts`, aplicada pelo worker final ao relatório verificado, além do `selectExportableVariants`):

| bloqueio | quando | pode ser reconhecido? |
| --- | --- | --- |
| `MP4_ORACLE_FAILED` | o relatório traz uma falha do oráculo (lote não rodou), com ou sem tinta | **nunca** |
| `MP4_ORACLE_MODEL_MISSING` | o relatório não fixa nenhum modelo | **nunca** |
| `MP4_FACE_ORACLE_UNREADABLE_UNDER_INK` | há tinta de legenda/CTA em quadros que o oráculo não conseguiu ler | **nunca** |
| `MP4_FACE_EVIDENCE_ABSENT_UNDER_INK` | há tinta em quadros sem nenhuma evidência de rosto (o oráculo leu e não viu rosto, nem na fonte projetada) | só com reconhecimento explícito |
| `MP4_CRITIC_NOT_CONFIGURED` | nenhum crítico ligado ao final | só com reconhecimento explícito |

O reconhecimento é um registro de quem aceitou, quando (instante UTC canônico) e por quê (≥ 10 caracteres): `mp4ExportAcknowledgement` no serviço do worker, vindo da implantação por três variáveis, todas ou nenhuma (`APOLLO_V2_MP4_CRITIC_ACK_ACTOR`, `…_ACK_AT`, `…_ACK_REASON`); malformado ou parcial lança erro. Ele é copiado para a mensagem do validador `FINAL_MP4_CRITIC` da tentativa. **Efeito de implantação:** um worker final sem as 7 variáveis do OpenVINO e sem o reconhecimento **não entrega mais nenhum final**. A revisão de proxy continua só avisando (`MP4_PIXEL_CRITIC_UNAVAILABLE`, `unknown` como aviso): é consultiva, e o final é que fecha.

**Provas** (`tests/v2/project-final-export.test.mjs`, `tests/v2/mp4-export-gate.test.mjs`; worker real, armazenamento falso, zero chamadas de promoção/anexo/catálogo quando bloqueado):

- ponte caída (com e sem tinta, com e sem reconhecimento): nada promovido; a mensagem traz `MP4_ORACLE_FAILED (… BRIDGE_EXIT_NONZERO)` e o relatório selado fica guardado;
- crítico não ligado: bloqueado; com reconhecimento é entregue e o validador registra "acknowledged by … at …: …"; reconhecimento malformado (ator vazio, instante sem milissegundos, motivo curto, campo a mais) não entrega;
- tinta sobre quadros ilegíveis: bloqueada, mesmo com reconhecimento; tinta sobre quadros sem rosto: bloqueada, entregue só com reconhecimento;
- **mutação** (no teste, sem tocar o repositório): uma cópia do worker, em diretório temporário, sem a regra "crítico não ligado" ou sem a regra "gate sobre o relatório", **entrega** o mesmo final que o worker real recusa; e, trocando a linha no worker real, 3 testes falham (conferido à mão antes de restaurar). O teste achou um defeito real na hora (`new Date('2026-13-40…').toISOString()` lançava `RangeError` em vez de recusar), já corrigido.

**Proveniência do detector na projeção.** Cada região protegida `source-projection` do relatório selado agora traz `sourceModels` (qual detector produziu o rosto da fonte que ela projeta); `measureSubject` devolve também o índice do rosto de origem de cada projeção mantida, o que vale quando uma projeção anterior sai do quadro. A suíte sintética com o renderer real confere o campo.

**O código depois da corrida registrada (declaração).** Três arquivos congelados mudaram depois da corrida registrada e da de sensibilidade: `mp4-pixel-geometry.ts` (devolve `projectedSourceFaceIndices`), `mp4-pixel-quality.ts` (só o tipo: `sourceModels` opcional) e `ffmpeg-mp4-pixel-critic.ts` (preenche `sourceModels`). Nada da lógica de detecção, de tolerância ou de veredito mudou. Consequências: (1) os SHA-256 de código do manifesto `w67-mp4-critic-corpus-v1.json` **deixam de bater** com a cabeça atual, então `corpus-run.mjs` **recusa rodar** o corpus registrado nesta cabeça; reproduzir a corrida registrada exige o commit `ab3e4918`; (2) os relatórios de uma nova corrida teriam hashes diferentes (campo novo), sem mudar quais quadros são marcados; (3) **o corpus registrado não foi rodado de novo** na cabeça nova: a evidência de detecção continua sendo a corrida `w67-calibration-run1-4fcf3a8c`, e a suíte sintética com o renderer real foi refeita na cabeça nova (§10). Uma nova corrida registrada sob este código seria um novo protocolo com novo congelamento.
