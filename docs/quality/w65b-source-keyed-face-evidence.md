# W65b - evidência facial chaveada pelo tempo da FONTE (`face-producer-envelope/v3`)

Escopo: segundo seguimento do W65b (depois de `docs/quality/w65b-final-caption-certification.md`). Ramo
`claude/w65b-final-gate-source-evidence`. A seção 1 a 9 é a **nota de projeto** (escrita antes do código e corrigida com o que o código
fez); a seção 10 registra o que foi provado e o que não foi.

## 1. O defeito

O envelope de janela da W62 (`face-producer-envelope/v2`) já mede em frames da fonte (`sourceFrame`), mas está **preso à linha do
tempo de um EditPlan**: tem projeto, versão, snapshot do plano, `timeMapHash` e `timelineDurationFrames`, e só pode ser produzido
quando a linha do tempo é exatamente UM clipe em tempo real da fonte, a partir do quadro 0. Três consequências:

1. um corte do Diretor (vários clipes, trims, cortes de silêncio) **não tem janelas**: `faceWindowTimeMap` devolve `null` e toda
   banda sobre a imagem fica `unknown`;
2. uma nova `ProjectVersion` invalida toda a evidência (`SCOPE_MISMATCH`, `TIMELINE_MISMATCH`) mesmo com a fonte imutável;
3. produzir evidência exige que a linha do tempo *atual* seja o master inteiro - o contrário do que o Diretor entrega.

## 2. Decisão

A evidência é uma função dos **bytes da fonte e do detector**, não de uma edição. Passa a ser produzida, guardada e lida na
coordenada da fonte, e só **no uso** é projetada pelos clipes do EditPlan sobre cada cue.

| | v2 (W62) | v3 (W65b) |
| --- | --- | --- |
| coordenada | frame da linha do tempo (a fonte é derivada) | frame da **fonte** |
| identidade | workspace, projeto, versão, snapshot, time map, fonte | workspace, **artefato-fonte + sha256**, relógio da fonte, janela, política, detector, produtor |
| produção exige | plano atual = 1 clipe, rate 1, `timelineIn 0` | a fonte anexada ao projeto e tocada por ele, com direitos |
| reuso | só a mesma versão | qualquer versão (e projeto do mesmo workspace com a fonte anexada) |
| lido por | `FaceWindowEvidenceReader` (por versão) | `FaceSourceWindowEvidenceReader` (por fonte) |

`free-certified` mantém o sentido da W62 (nenhuma detecção confiável sobrepõe a área na evidência amostrada) e
`faceSafety` continua `unknown`. Cobertura ausente continua `unknown`.

## 3. Modelo de dados

### 3.1 Envelope `face-producer-envelope/v3` (domínio, selado)

`authority: server-produced`, `coverage: sampled-only`, `faceSafety: unknown`, `identity: not-performed` (como no v2), mais:

- identidade da fonte: `workspaceId`, `sourceArtifactId`, `sourceSha256` e o relógio medido pelo analisador (`sourceFps`,
  `sourceTimebase`, `sourceClock`, `sourcePtsStart`, `sourcePtsRounding`, `sourceWidth`, `sourceHeight`, `sourceOrientation`);
  `sourceFps` é **inteiro** (`den = 1`): só um fps inteiro dá um mapeamento de frames por deslocamento inteiro;
- `window: { startSourceFrame, endSourceFrame }` meio-aberta, no máximo `faceWindowFrames(intervalo)` (300 frames, 60 amostras);
- `samples[]`: `sourceFrame` (múltiplo do intervalo), `sourcePts` e seu hash de evidência, `imageSha256`, dimensões, `status`,
  `boxes`, `rawOutput` (hash + 5600 bytes), `reasonCode`; `gaps[]` em frames da fonte; os dois cobrem a janela exatamente;
- proveniência de publicação: `operationId`, `operationAttempt`, `operationFenceHash`;
- política (`FACE_EVIDENCE_POLICY` sha), `detectorConfig` e `producer` com os pins V9 (modelo, runtime, adapter, bridge, FFmpeg,
  aceite do dono, paridade do runtime). A autenticação do produtor é **recalculada a cada leitura** (`authenticateFaceEnvelope`).

Não há projeto, versão, snapshot, time map nem duração de linha do tempo no selo. Quem pediu a janela fica na operação
(`face_producer_operations`), que é o registro de auditoria - não parte da identidade da evidência.

### 3.2 Persistência (migração aditiva `20261018180000_face_source_window_v1`)

- `face_source_window_envelopes`: `id`, `workspaceId`, `sourceArtifactId`, `sourceSha256`, `operationId` (único), `operationAttempt`,
  `operationFenceHash`, `detectorConfigHash`, `contentJson`, `envelopeHash`, `windowStartSourceFrame`, `windowEndSourceFrame`,
  `createdAt`. FKs: workspace, `(sourceArtifactId, workspaceId)` -> artefato, `(operationId, workspaceId)` -> operação. Índice
  `(workspaceId, sourceArtifactId, sourceSha256, windowStartSourceFrame)`. CHECK: schema `v3` e janela de 1 a 300 frames.
  **Não há unicidade por janela**: refazer uma janela gera outro envelope, e quem decide entre os dois é o stream de evidência
  (amostras do mesmo frame têm de coincidir, senão as duas janelas viram `EVIDENCE_CONFLICT`).
- `face_source_window_raw_outputs`: o tensor de 5600 bytes de cada amostra, preso ao envelope por `(envelopeId, workspaceId)`, com
  CHECK de tamanho (como `face_producer_raw_outputs`).
- `face_producer_operations`: perfil novo `openvino-face0204-v9-source` e colunas `windowStartSourceFrame`/`windowEndSourceFrame`
  (nulas nos outros perfis); a CHECK de perfil/janela da W62 é substituída por uma que conhece os três perfis. Nenhuma linha
  existente muda (`ALTER ... ADD COLUMN` nulo, CHECKs revalidadas sobre as linhas atuais).
- Os envelopes v2 ficam onde estão. O planejador **só lê v3**: um envelope v2 nunca é evidência de posicionamento (o recurso
  `face-window-operations` da W62 permanece como histórico/diagnóstico, sem consumidor).

## 4. Uso: projeção pelos clipes do EditPlan

Para cada banda candidata de uma cue, `canvasBandSourceAreas` já devolve segmentos **por clipe** (e por trecho linear de
reframe), em frames da linha do tempo, com a área da fonte sob a banda. O W65b acrescenta ao clipe da projeção
`sourceInFrame`, `sourceOutFrame` e `rate`, e avalia cada segmento `source` na **fonte**:

- `rate === 1` e `sourceOut - sourceIn === timelineOut - timelineIn` (senão `unknown`: `CLIP_RATE_NOT_UNIT` /
  `CLIP_MAP_INCONSISTENT`, avaliação `clip-map-unprovable`);
- o relógio da evidência é o da fonte: o planejador exige fps **inteiro** na linha do tempo (senão `TIMELINE_FPS_NOT_INTEGER`) e
  espera da fonte esse mesmo fps; uma janela medida em outro fps é `untrusted` com `CLOCK_MISMATCH` (a faixa fica `unknown`);
- deslocamento `o = sourceIn - timelineIn`; o segmento `[a, b)` vira `[a + o, b + o)` na fonte, e as áreas por trecho vão junto;
- o stream de evidência é o da **fonte** (`FaceSourceEvidenceStream`): amostras por `sourceFrame`, janelas confiáveis e não
  confiáveis em frames da fonte; a decisão é a mesma `evaluateFaceCaptionClearance` da W62, aplicada a esse stream (nada da
  regra de cobertura, lacuna máxima de 500 ms, dilatação e precedência muda);
- trechos adjacentes na linha do tempo de **clipes diferentes nunca se fundem**, mesmo da mesma fonte: um corte é um salto no
  tempo da fonte e uma "corrida" única atravessaria o intervalo cortado;
- amostras da fonte **fora** do trecho do clipe valem como vizinhas: a fonte é contínua e imutável, então o quadro logo antes do
  `sourceIn` atesta a borda do clipe (sem isso toda cue encostada num corte seria `unknown`);
- **velocidade**: `rate !== 1` fica `unknown` (`CLIP_RATE_NOT_UNIT`). Com `rate` racional o frame da fonte sob um frame da linha do
  tempo não é uma translação; um limite "alargado por ceil(rate)" é possível mas **não está provado** aqui, então não é usado.
  A certificação por **geometria** (`geometry-outside-foreground`: a banda não toca a imagem do clipe) não depende da taxa e continua
  valendo;
- uma janela pedida além da duração da fonte, ou o span de uma cue que sai dela, é `SPAN_OUTSIDE_EVIDENCE_TIMELINE`;
- o hash da projeção (`projectionHash`) passa a incluir `sourceInFrame`, `sourceOutFrame` e `rate` de cada clipe.

### 4.1 O que o planejador lista

`planRequiredSourceWindows`: por fonte, as janelas em frames da fonte (`{ startSourceFrame, endSourceFrame }`) que deixariam a
evidência responder para todas as cues (span de cada cue por clipe, alargado pela lacuna máxima, interseções fundidas, cortadas em
janelas de no máximo 300 frames). Só lista; pedir é do Diretor (W64/W70).

## 5. Leitura e verificação no uso

`listSourceWindows({ workspaceId, projectId, sourceArtifactId, fromSourceFrame, toSourceFrame, now })` devolve, por envelope que
sobrepõe o intervalo, o selo mais a autenticação do produtor **de agora**, depois de verificar:

1. o selo (reconstruído pelo construtor de domínio, `stableSerialize` idêntico) e as colunas da linha contra o conteúdo selado;
2. os tensores brutos reproduzem cada amostra pelo decodificador literal V9;
3. a operação publicadora (`perception-face-run`, perfil source, `succeeded`, tentativa e fence do selo, mesmo `requestHash`);
4. **a identidade da fonte**: o artefato do workspace tem o mesmo `sha256` selado, está `available` e é vídeo; a linha não é lida
   para outro workspace;
5. o projeto **consumidor** tem a fonte anexada como `source-master`;
6. **direitos vigentes no uso**: `evaluatePerceptionSourceAnalysisRights(direitosAtuais, { workspaceId, locale do projeto consumidor }, relógio do servidor)`;
   se não permitir, `ASSET_RIGHTS_BLOCKED` (o render é bloqueado, não "unknown");
7. o stream é montado por `collectFaceSourceEvidenceStream`: envelope não autenticado (`PRODUCER_*`), de outra fonte/sha
   (`SOURCE_MISMATCH`), de outro workspace (`SCOPE_MISMATCH`), de outro relógio (`CLOCK_MISMATCH`), de outra política
   (`POLICY_MISMATCH`), com selo inválido (`ENVELOPE_SEAL_INVALID`) ou contradito por outra janela (`EVIDENCE_CONFLICT`) vira
   `untrusted` (a faixa é `unknown`, nunca vazia).

Uma linha adulterada **interrompe** o render (erro de integridade), como no W65. Sem leitor, ou sem janela, a evidência não existe
e as bandas sobre a imagem são `unknown`.

## 6. Produção

`POST /v1/projects/{projectId}/face-source-windows` com `{ sourceArtifactId, window: { startSourceFrame, endSourceFrame } }`
(frames da fonte). A cadência é do servidor: `faceSampleIntervalFrames` do fps **inteiro** da fonte (probe do manifest); fps
fracionário não tem janela (`PRECONDITION_REQUIRED`). Admissão: projeto atual cuja versão atual referencia a fonte, fonte anexada,
`available`, vídeo, direitos de análise vigentes para o locale do projeto; a janela termina na duração da fonte e contém ao menos
um quadro amostrado. A versão da requisição é só auditoria: a operação **não** exige que a versão ainda seja a atual no claim nem
na publicação (a evidência não depende dela); exige fonte, hash, anexo e direitos. O worker (`runNextFaceSourceWindowOperationService`)
reusa o analisador V9 da W62 (`FaceWindowAnalyzer`), que já trabalha em frames da fonte, e publica na mesma transação fenced da
conclusão da operação. `scripts/run-v2-face-producer-worker.mjs` roda o perfil com `APOLLO_V2_FACE_PROFILE=openvino-face0204-v9-source`.

## 7. Contrato público (aditivo)

Capabilities `apollo.projects.face-source-windows.create` e `.read` 1.0.0 (`POST /v1/projects/{projectId}/face-source-windows`,
`GET .../face-source-windows/{operationId}`); schemas `face-source-window-run-request/v1`,
`face-source-window-operation-created/v1` e `face-source-window-operation-read/v1` (este traz o envelope v3 estrito e o veredito do
registro do produtor). A linha de base do contrato muda só por adição (2 capabilities, 3 schemas). O recurso `face-window-operations`
da W62 não é alterado: **recomendação** (decisão da Astra na integração) removê-lo antes da primeira publicação, já que nada mais o
consome.

## 8. O que não muda

`faceSafety` segue `unknown`; nada aqui identifica pessoas; a evidência é amostrada; o detector é o aceito pelo dono no escopo
`foreground-faces-and-speaker` sem confirmação independente; Linux só autenticado com recibo de paridade; cobertura ausente,
amostra `unknown`, lacuna acima do limite ou evidência não confiável perto da cue continuam `unknown`.

## 9. Limites conhecidos

- `rate !== 1` é `unknown` (seção 4); só a geometria certifica uma banda sobre um clipe com velocidade;
- fps fracionário da fonte (ou da linha do tempo) não tem janela nem projeção: `unknown`;
- a janela é de no máximo 300 frames: uma fonte longa precisa de muitas operações; pedi-las é do Diretor (W64/W70);
- o planejador do W65b lê só v3: evidência v2 existente não é migrada (a W62 não foi publicada);
- o detector das provas é um substituto (devolve tensores V9 reais para os frames em que o marcador existe); nenhuma prova aqui
  executou o detector OpenVINO sobre pixels, e o runtime Linux segue sem recibo de paridade;
- as suítes PostgreSQL e de pixels abaixo são locais (cluster descartável supervisionado, FFmpeg fixado); não há contrapartida em CI.

## 10. Provas

Rodadas em um cluster PostgreSQL descartável pelo harness supervisionado, sob o lock global de carga (sem outras cargas locais).
Os números e os caminhos de evidência estão no relatório da entrega; esta seção lista **o que cada prova estabelece**.

- Domínio e planejamento (testes unitários): `tests/v2/face-producer-envelope-v3.test.mjs`, `face-source-evidence-stream.test.mjs`,
  `face-source-windows-plan.test.mjs`, `caption-face-clearance.test.mjs` (projeção por clipe: deslocamento, vários clipes, trims,
  salto, vizinhança, `rate !== 1`), `plan-caption-placement.test.mjs`, `face-source-window-admission.test.mjs`,
  `run-face-source-window-worker.test.mjs`, `face-source-window-persistence.test.mjs`, `public-operation-contracts.test.mjs` (contrato
  estrito, 21 mutações negativas do envelope).
- PostgreSQL, persistência: `tests/v2/prisma-face-source-window.integration.mjs` - admissão (o projeto toca a fonte, anexada,
  fps inteiro, janela dentro da fonte e com amostra), isolamento dos três perfis, publicação selada com os 30 tensores, reuso
  por um corte do Diretor posterior e por um projeto irmão com a fonte anexada, nada para quem não tem a fonte, direitos reavaliados
  com o locale do projeto consumidor, identidade da fonte reverificada, adulterações recusadas, fences de lease e direitos, e cabeça
  que se moveu **não** descarta a evidência.
- PostgreSQL, planejamento sobre janelas reais: `tests/v2/prisma-caption-placement.integration.mjs` - cues de um corte do Diretor
  com três clipes lendo janelas produzidas sob uma versão anterior, com resposta diferente da de uma leitura pelo tempo da linha do
  tempo.
- PostgreSQL + FFmpeg + pixels, final real num corte do Diretor: `tests/v2/prisma-final-caption-source-evidence.integration.mjs` -
  F0 controle; F1 as duas cues queimadas (a sobre o rosto sai da banda de baixo, a outra fica nela); F2 a cue sem cobertura omitida
  e listada; F3 evidência posta no tempo da linha do tempo derruba o final pelo crítico de pixels.
- Pixels, mesma maquinaria sem banco: `tests/v2/caption-placement-pixels.integration.mjs` (migrado para o leitor por fonte).
- Composição: `tests/v2/face-window-composition.integration.mjs` (os dois workers V9 recusam plataforma sem recibo, pin ausente e
  runtime alterado antes de tocar o banco).
