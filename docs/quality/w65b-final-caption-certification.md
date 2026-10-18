# W65b - o gate do final por legenda queimada (`final-caption-certification/v1`)

Escopo: primeiro seguimento do W65b. Ramo `claude/w65b-final-gate-source-evidence` (a partir de `claude/w65-caption-placement`).
Segue o fecho do W65 (`docs/quality/w65-caption-placement-v3.md`), que deixou a exportação final exigindo um `faceSafety`
do Diretor `verified` que nada concede: **nenhum final podia ser produzido**.

## 1. A regra (política fixada e versionada)

A segurança facial global **continua `unknown`** (no relatório do Diretor e em todo plano de posicionamento). O que o final garante
é por legenda **queimada**. Um final é admissível quando:

- **(a)** a execução do Diretor e o seu `QualityReport` aprovam como antes: gate estratégico aprovado, todos os hard checks exceto
  `subtitlesFaceSafe` verdadeiros, nenhuma issue `hard`. A única reserva que o relatório pode ainda carregar é a incerteza facial
  (`review-required`, `faceSafety.status=unknown`, `evidenceRefs=[]`, `subtitlesFaceSafe=false`); um relatório que declare
  `verified` mantém o requisito antigo (cada `evidenceRef` é um envelope de percepção facial da execução);
- **(b)** **toda** legenda queimada está numa banda `free-certified` do canvas final (por evidência facial confiável, ou por
  geometria: a banda não toca a imagem) **e** o crítico de pixels C1 mediu o MP4 entregue e achou cada legenda onde o plano a pôs;
- **(c)** a legenda que **não** pôde ser certificada é **omitida** (não queimada) e **listada** como item de revisão.

`free-certified` mantém o sentido da W62: nenhuma detecção confiável sobrepõe a banda na evidência amostrada. **Não** é uma
afirmação de que não há rosto, e esta regra não diz isso em lugar nenhum.

A política é `FINAL_CAPTION_CERTIFICATION_POLICY` (`src/v2/domain/final-caption-certification.ts`, `final-caption-certification/v1`,
congelada em profundidade, digest SHA-256 do JSON canônico). O digest entra em dois lugares:

1. na **identidade pré-render** (`projectFinalRenderInputHash`): a operação enfileirada sob outra política (ou sem política) é rejeitada
   pelo worker antes de qualquer render (`INVALID_RENDER_INPUT`), em vez de ser certificada por regras com as quais ninguém a aprovou;
2. nos **parâmetros da receita** do final (receita `editorial-final` 1.13.0), junto do recibo.

## 2. Onde cada parte vive

| Parte | Onde |
| --- | --- |
| admissão do relatório do Diretor | `admitDirectorQualityForFinal` -> `PrismaProjectFinalExportRepository.readApproval` (`admissionBasis`: `verified-face-safety` ou `per-cue-caption-certification`) |
| política de âncora `omit-and-list` | `subtitle-anchor-plan/v3`: sem banda segura a legenda não é desenhada e o motivo é **warning** (item de revisão) em vez de **hard** (render inaprovável) |
| plano do proxy e do final | `planCaptionPlacement({ uncertifiedCues: 'omit-and-list' })`; o proxy planeja sob a mesma regra, então o laudo do proxy fica `warning-ack-required` (a pessoa reconhece as legendas listadas) e não `blocked` |
| certificação e recibo | `certifyFinalCaptions` (função pura do plano + resultado do crítico C1) |
| execução | `runNextProjectFinalExportOperationService`: planeja, valida, pré-certifica, renderiza, roda o C1 sobre o MP4, certifica de novo com pixels, grava |

### 2.1 O que o worker do final faz, em ordem

1. planeja as legendas no canvas **final**, sob `omit-and-list`; `validateRenderPlacementPlan`;
2. qualquer issue `hard` do plano, ou uma legenda colocada numa banda que não é `free-certified` (defesa em profundidade), **para antes do
   encode** (`INVALID_RENDER_INPUT`);
3. se o plano queima pelo menos uma legenda e **nenhum crítico de pixels está ligado**, **recusa antes do encode**: nunca se entrega legenda
   confiando só no plano;
4. renderiza; se há legendas queimadas, renderiza o **controle** (a mesma codificação sem as legendas) e o crítico C1 mede o MP4 entregue;
5. `certifyFinalCaptions` junta plano e pixels: uma issue `hard` do C1 (`CAPTION_PLACEMENT_MISMATCH`, `SUBTITLE_FACE_OVERLAP_IN_PIXELS`), um
   crítico que **não conseguiu medir** (`measurement: failed`, ou que lançou erro) e um crítico que não rodou **reprovam o final**
   (`RENDER_OUTPUT_INVALID`, nada é publicado). Ao contrário do proxy, aqui um crítico quebrado não deixa um entregável para trás;
6. o recibo vai nos parâmetros da receita e no registro da tentativa (`FINAL_CAPTION_CERTIFICATION`, `message` <= 500 caracteres).

### 2.2 O recibo (`final-caption-certification-receipt/v1`)

Política (id e digest), `faceSafety: 'unknown'`, hashes do plano de posicionamento e do plano de âncora, as legendas **queimadas** (`cueId`, banda,
como a banda foi certificada - `face-clearance`, `geometry-outside-foreground` ou `mixed` -, os selos `clearanceHash` das avaliações W62, as
fontes e a janela avaliada), as **omitidas** (`cueId`, código `FACE_PERCEPTION_UNAVAILABLE` ou `NO_SAFE_SUBTITLE_REGION`, disposição
`review-required` ou `blocked`, motivos), o estado do crítico (`ran`, `not-run`, `measurement-failed`, `not-needed`) e os avisos do C1
(por exemplo `FACE_PIXEL_CHECK_UNAVAILABLE`, porque nenhum detector de veto independente está ligado), e o `receiptHash`.

## 3. O que mudou para quem usa

- O relatório do Diretor (`review-required`, face `unknown`) agora **chega** ao final. Antes, nenhum relatório chegava.
- O laudo do proxy com legendas não certificáveis é `warning-ack-required` (antes, `blocked`): o revisor reconhece as legendas listadas e o
  final segue sem elas. O botão "Aprovar e exportar MP4 final" do dashboard aceita `review-required`; a decisão é do servidor.
- Receita final **1.13.0**; renderizador e receita do proxy não mudam (os pixels de um plano dado são os mesmos).
- `CaptionPixelVerification.measurement` (`completed | failed`) é novo no port do crítico.

## 4. O que a regra NÃO afirma

Que nenhuma legenda queimada cobre um rosto. A banda `free-certified` é evidência amostrada do detector aceito pelo dono no escopo
`foreground-faces-and-speaker` (sem confirmação independente) ou geometria da imagem projetada, e o C1 confirma **onde** a legenda está,
não **quem** está debaixo. Sem detector de veto independente, cada legenda queimada carrega o aviso `FACE_PIXEL_CHECK_UNAVAILABLE` no recibo.

## 5. Limites e decisões em aberto

- o controle do C1 é uma segunda codificação completa do final (o custo de um final com legendas queimadas dobra); aceitável aqui, a reavaliar
  se virar gargalo;
- o conjunto de legendas queimadas é decidido **no momento do final**, não interseccionado com o do proxy aprovado: o proxy e o final usam a mesma
  evidência, mas uma janela de rosto nova pode certificar (ou não) uma legenda a mais ou a menos entre os dois;
- as legendas omitidas geram `warning`, logo o laudo do proxy pede reconhecimento antes do final; relaxar isso (omissão silenciosa) é decisão de produto;
- uma reprovação do C1 reprova o final em vez de omitir a legenda: o plano certificou a banda e os pixels discordaram, isso é defeito, não incerteza.

## 6. Provas

(Preenchido quando as provas rodam.)

Suítes: `tests/v2/final-caption-certification.test.mjs` (domínio: política, admissão, recibo, mutações), `tests/v2/project-final-export.test.mjs`
(worker e gate com repositório simulado), `tests/v2/project-proxy-render-worker.test.mjs` (laudo do proxy sob `omit-and-list`),
`tests/v2/ass-emission-policy.test.mjs` (identidade pré-render e versões), e a prova em PostgreSQL + FFmpeg real
`tests/v2/prisma-final-caption-certification.integration.mjs` (supervisionada, fora do CI).
