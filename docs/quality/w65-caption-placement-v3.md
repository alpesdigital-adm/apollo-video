# W65 - posicionamento de legenda por variante (`subtitle-anchor-plan/v3`)

Escopo: F1.036 (`e388518a7504-1`, `09dcdf656d1d-1`, `19f872a9d137-1`, `d7f581a07db8-1`) e o recorte de dois canvases de F1.030
(`247f7694a332-1`, `3c5a68e99d79-1`, `a4aa3d1b7ac4-1`). Os 20 placements em cinco formatos de F1.030 seguem fora.
Ramo `claude/w65-caption-placement` (a partir de `claude/w62-v9-runtime`, com `claude/w69-subtitle-binder` integrado).

## 1. O defeito que este recorte fecha

Rostos e texto (OCR, inserts) vivem no espaço normalizado do **quadro da fonte**. Bandas de legenda, CTA e logo vivem no espaço
normalizado do **canvas da variante**. O solver v1 comparava os dois como se fossem o mesmo espaço. Isso só coincide quando o canvas
é o quadro da fonte; um 16:9 num 9:16 ocupa uma faixa horizontal do meio do canvas, e o v1 colocava a legenda por cima do que o
detector mediu em outro lugar. `caption-canvas-projection.ts` é agora o **único** lugar onde os dois espaços se encontram.

## 2. Projeção fonte <-> canvas

Espelha, número a número, o filtergraph (`buildEditorialCompositionPrefix`): corte do clipe (`clip.crop` ou trajetória de reframe, alinhado a pixel
par), ajuste ao quadro de staging (a maior fonte de vídeo; a primeira em empate), `foregroundScale` e `verticalPosition` com
quatro casas. A cadeia é uma similaridade (`canvasPx = S * sourcePx + offset`). A cópia desfocada que preenche o resto do canvas
**não** carrega rosto e não tem projeção (decisão Q3).

Regra de solidez: onde o FFmpeg arredonda, a resposta alarga, nunca estreita. A banda é inflada em 3 px de canvas antes de voltar à
fonte, a área mapeada em 2 px de fonte, e uma área em movimento vira o casco de suas posições nas duas pontas de cada trecho linear.
A janela de corte do reframe é conferida quadro a quadro contra a expressão que o filtro recebe (`caption-canvas-projection.test.mjs`).
O renderer reconstrói a projeção das fontes que de fato leu e recusa um plano decidido sobre outra (`INVALID_RENDER_INPUT`).

## 3. Plano v3

Por cue e por banda (5 bandas) o plano registra `free-certified | occupied | unknown`, as avaliações que levaram a esse estado e os
bloqueadores não-faciais. A decisão é função pura disso:

1. só banda `free-certified` é candidata (e, no caso estrito, sem outro bloqueador); `occupied` e `unknown` nunca, nem como relaxamento;
2. a banda anterior é mantida enquanto continuar certificada (histerese);
3. sem candidata estrita, uma banda certificada que só encosta em OCR/CTA/logo é usada com `SUBTITLE_ANCHOR_FALLBACK` (warning);
4. sem nenhuma: todas ocupadas -> `blocked` + `NO_SAFE_SUBTITLE_REGION`; alguma `unknown` -> `review-required` +
   `FACE_PERCEPTION_UNAVAILABLE`. Nos dois casos a cue **não é queimada**, no proxy nem no final; o plano guarda o texto e as bandas
   candidatas como dado para a revisão (decisão Q1).

`free-certified` mantém o sentido da W62: nenhuma detecção confiável sobrepõe a banda na evidência amostrada, **não** que não haja
rosto. `faceClearance.faceSafety` é o literal `unknown`; nada aqui alimenta `subtitlesFaceSafe`.

Consequência a conhecer: uma banda que não toca nenhum pixel da imagem durante a cue (ex.: banda inferior de um 16:9 num 9:16, sobre a cópia
desfocada) é certificada por **geometria** (`geometry-outside-foreground`), sem evidência de detector.

## 4. Evidência e fiação

`planCaptionPlacement` (proxy e final) lê as janelas seladas da W62 da **ProjectVersion renderizada** (`listWindows`, escopo workspace/projeto/versão/fonte)
e só `collectFaceEvidenceStream` decide o que é confiável. Sem leitor, sem dimensões da fonte (`probe` do manifest, hidratado no
`RenderSource`), com fps fracionário, com snapshot renderizável ou com linha do tempo que não seja exatamente um clipe em tempo real,
a evidência não existe e as bandas sobre a imagem são `unknown`. Uma linha armazenada adulterada **interrompe** o render (erro de
integridade), não vira `unknown`. O planejador também **lista** as janelas que certificariam as cues (`planRequiredFaceWindows`);
pedi-las é do Diretor (W64), dependência para a jornada W70.

Reuso: os bytes reaproveitados de uma faixa vêm de um proxy-base sem legenda (o mapa de elementos atesta isso). Um plano que desenha uma cue sobre
quadro mantido não é satisfeito por eles; o worker faz o render completo.

O final decide no canvas **final**, grava `placementPlan` no RenderInput (a reconstrução desenha as mesmas cues nas mesmas bandas) e para
antes do encode se houver problema `hard`. O gate de aprovação do final continua exigindo `faceSafety` do Diretor `verified`, que este
recorte nunca concede.

## 5. Versões

Renderer 1.16.0, receita de proxy 1.17.0, receita de final 1.12.0: a mesma lista de cues produz pixels diferentes.

## 6. Provas

- Puras: projeção (`caption-canvas-projection.test.mjs`), claridade por banda (`caption-face-clearance.test.mjs`), plano v3 e validador
  (`subtitle-anchor-plan-v3.test.mjs`), planejador (`plan-caption-placement.test.mjs`), workers de proxy e de final.
- PostgreSQL (harness supervisionado, não roda no CI): `tests/v2/prisma-caption-placement.integration.mjs`.
- Pixels reais (FFmpeg, 9:16 e 16:9): ver a seção de evidência ao final do trabalho.

## 7. Limites declarados

- Na amostra de desenvolvimento em imagens paradas, uma banda ocupada foi julgada livre em 3/26 imagens (limiar 0,50) e 1/26 (0,10): `free-certified` é evidência amostrada, não prova.
- A W62 só produz janelas para uma linha do tempo de um único clipe em tempo real; qualquer corte do Diretor deixa as bandas sobre a imagem `unknown`.
- A evidência é por ProjectVersion; não há carry-forward para versões filhas.
- Detector no Linux: sem recibo de paridade aceito, a produção resolve tudo como `unknown` (equivale ao comportamento anterior).
- O veto por detector independente sobre os pixels (C2) fica como porta; em produção é `FACE_PIXEL_CHECK_UNAVAILABLE` (warning), pendente a questão de licença do YuNet.
- Medição em vídeo real, jornada W70.
