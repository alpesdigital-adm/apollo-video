# W66r - reframe com trajetória e override por variante

Escopo: plano W66 (reframe com trajetória e override por variante). Ramo `claude/w66r-reframe-trajectory`, a partir de `origin/main` 9b03d7bf.
O reframe passa a ser decidido pelo servidor, por **variante estável de saída** (nunca por proporção), a partir de evidência selada; o editor
corrige por Command, por variante e por faixa, sem tocar a observação nem o plano do servidor. Esta nota registra a política, as regras, o que
foi medido e **o que não foi**.

## 1. O que mudou, em uma tabela

| Antes | Depois |
| --- | --- |
| `createReframePlan` recebia observações do chamador; plano sem persistência (`plan: null`, sempre `review-required`) | Observações **do servidor** (`face-source-evidence-stream/v1` projetado pelos clipes do EditPlan), plano **selado pela política** e persistido por (Versão, variante) |
| Variante = proporção (`'9:16'`); duas saídas 9:16 colidiam | Variante = id estável do State (`requireOutputVariant`); proporção como variante é recusada (`output-variant-unknown`) |
| Override do crop: conjunto v1 por proporção | `apply-variant-reframe-override` v2: Command por variante + faixa semiaberta de um clipe, `set`/`reset`, cadeia por `previousOverrideId` |
| Render com um crop estático ou `reframePlan` montado à mão; o crop virava uma tira num quadro 16:9 | Render lê o plano persistido da **sua** variante e o crop **preenche o canvas**; `reframeRecordHash` entra no hash do RenderInput; issues entram no critic da **sua** saída |

## 2. Política: constantes e hash

`src/v2/domain/reframe-policy.ts`, `REFRAME_POLICY` (`reframe-policy/v1`, id `w66r-reframe-trajectory/v1`), congelada. O hash é
`REFRAME_POLICY_SHA256 = 6d9be3e9018577c3c940e8c2da29afa55ca07f4177eeb0d791412e8fc51afc78` e vai **dentro** de cada plano e de cada registro
(`policyHash`, `record.policy.hash`); um plano ressealado sob outro hash, ou uma política com um número trocado, é recusado
(`isPinnedReframePolicy` compara o conteúdo, não só o id).

| Constante | Valor | Origem |
| --- | --- | --- |
| `tracking.maxVelocityPerSecond` | 0,35 (unidades normalizadas da fonte por segundo) | herdada de `createReframePlan` v1, **não afrouxada** |
| `tracking.maxAccelerationPerSecondSquared` | 0,8 | herdada |
| `tracking.safetyMargin` | 0,02 de cada lado do sujeito | herdada |
| `tracking.minObservationConfidence` | 0,6 | herdada |
| `roi.face.evidencePolicySha256` | `e7e606e03cf29fdbfb759acd8fe7b1d8875ec16b2a3e90051a80e5caa76bb4c0` (`w62-v9-foreground-evidence/v1`) | política de evidência facial fixada; mudar aquela muda este hash |
| `roi.face.includeScoreMin` / `criticalScoreMin` | 0,2 / 0,5 | idem (ponto de operação V9 aceito pelo dono) |
| `roi.face.foregroundMinHeightFraction` | 0,1 | idem |
| `roi.face.pairingMinIou` / `pairingMaxCenterDistanceBoxHeights` | 0,3 / 1 | idem; nenhuma identidade é afirmada |
| `roi.interpolation.maxGapStrides` | 1 stride (5 frames a 30 fps = 6 Hz) | decisão W66r, **não medida** |
| `roi.interpolation.acrossCuts / acrossUnknownSamples / acrossWindowGaps / acrossUntrustedEvidence` | `false` | decisão W66r |
| `render.maxKeyframesPerRange` | 600 | limite do renderer |
| `render.keyframeSimplificationTolerance` | 0,004 | decisão W66r, **não medida** |
| `roi.object` / `roi.screen` | ausentes (`NO_VERIFIED_DETECTOR` / `NO_VERIFIED_PRODUCER`) | não existe produtor verificado |
| `claims` | `qualification: false`, `faceSafety: 'unknown'`, `realVideoMeasurement: 'not-performed'` | declaração explícita |

Nada aqui é qualificação: os números novos foram escolhidos para ser conservadores, não medidos em vídeo real.

## 3. ROI do servidor

`src/v2/domain/server-reframe-roi.ts`. Caixas só vêm de amostras de envelopes que `collectFaceSourceEvidenceStream` aceitou (selo, registro de
produtor, fonte, relógio); cada observação carrega o hash do envelope de onde veio. O chamador não fornece nenhuma.

- A amostra "possui" o stride que começa nela. Duas amostras consecutivas **do mesmo clipe**, ambas observadas, descrevem o stride pelo envelope
  das duas caixas (um sujeito que se move entre elas fica dentro): essa é a interpolação, limitada a um stride.
- Uma amostra sem vizinha utilizável é mantida só pelo seu stride (no máximo `stride - 1` frames além dela), dentro do próprio clipe.
- **Nada atravessa** corte, amostra `unknown`, buraco entre janelas ou janela cujo selo foi recusado: o trecho vira intervalo desconhecido com
  motivo (`UNKNOWN_SAMPLE`, `WINDOW_GAP`, `UNTRUSTED_EVIDENCE`, `UNSUPPORTED_CLIP`), nunca "sem sujeito" e nunca a caixa da vizinha.
- Amostra observada sem rosto de primeiro plano é ausência observada: o plano responde `NO_SUBJECT_OBSERVATION`.
- Só `rate === 1` é projetado (`UNSUPPORTED_CLIP` nos outros). Tela e objeto não têm ROI (política).

## 4. Plano, keyframes e render

- Um plano por (Versão, variante), em `variant-reframe-plan/v1` (`src/v2/domain/variant-reframe-plan.ts`): canvas selado da variante, clipes,
  hash da política, observações com a evidência, **plano do servidor** (`serverPlan`), plano **final** (servidor + overrides), `renderPlan`
  (`RenderReframePlanV1`) e issues localizadas. Endereçado por conteúdo (`recordHash`), encadeado por `sequence`/`previousPlanId`; o índice
  único do sucessor faz do encadeamento um compare-and-swap.
- Keyframes por variante: 9:16 = janela de pan do tamanho máximo do crop (`maximumReframeCrop`, só desloca); 16:9 sobre fonte 16:9 = quadro
  inteiro (não pede evidência). Interpolação linear entre keyframes, **um intervalo por clipe**, nunca entre clipes.
- Trecho que o plano não pode rastrear não ganha keyframe próprio: a trajetória é ponteada do último crop rastreado ao próximo, nunca mais
  rápido que o plano permitiu. Clipe sem trecho rastreado e sem trecho manual vira intervalo `fallback` (sem keyframe: o clipe aparece inteiro).
- O caminho é conferido frame a frame contra as observações; frame cujo crop interpolado esconde um sujeito vira `TRACKING_LIMIT_EXCEEDED`.
- Um clipe que exigiria mais de 600 keyframes vira `fallback` com violação `KEYFRAME_BUDGET_EXCEEDED`.

## 4b. Composição: um range reenquadrado PREENCHE o canvas

Defeito achado na revisão: o renderer cortava o clipe, escalava e preenchia (`pad`) até o quadro de trabalho 16:9 da maior fonte e o punha sobre uma cópia
borrada. Um crop 404x720 virava uma tira de ~171x304 (~10% de 540x960) e, agora que o plano persistido é aplicado, um plano só **tirava** imagem. A regra
passa a ser (`REFRAME_COMPOSITION_ID = reframe-fills-canvas/v1`, em `render-reframe-plan.ts`), e é a mesma nos quatro lugares onde a geometria existe:

- **Renderer** (`ffmpeg-editorial-composition-graph.ts`): um clipe sob range ativo (`plan`/`manual`) é cortado e escalado pelo fator cover
  (`scale=W:H:force_original_aspect_ratio=increase,crop=W:H`): sem quadro de trabalho, sem `pad`, sem fundo borrado. Um clipe sem range ativo mantém a
  composição de sempre, feita clipe a clipe quando outro clipe da linha do tempo é reenquadrado (termina em `setsar=1`: o `concat` recusa SAR diferentes).
  Sem nenhum clipe reenquadrado o grafo é o histórico, literalmente (teste dourado em `reframe-composition-fill.test.mjs`).
- **Projeção de legenda** (`caption-canvas-projection.ts`): a similaridade de um clipe reenquadrado é o cover; o id da composição entra na identidade da
  projeção só quando há clipe reenquadrado.
- **Mapa de elementos do render** (`review-system.ts`): um clipe reenquadrado é o canvas inteiro e não tem elemento de fundo.
- **Hash de entrada do render**: um render feito de plano persistido nomeia `reframeComposition`; mudar a regra nunca passa por o mesmo render.

## 5. Issue -> estado da variante

Decidido por `reframeVariantDisposition` (política: `issueDisposition`); o critic (`critiqueOutputFormat`) traduz cada issue em `REFRAME_*` na
saída **dela**, com faixa em frames, `evidenceIds` e `reframe-plan-record:<hash>`; a outra variante não muda.

| Issue | Severidade | Estado da variante | Código no critic |
| --- | --- | --- | --- |
| `SUBJECTS_DO_NOT_FIT` | hard | `blocked` | `REFRAME_SUBJECTS_DO_NOT_FIT` |
| `TRACKING_LIMIT_EXCEEDED` | hard | `blocked` | `REFRAME_TRACKING_LIMIT_EXCEEDED` |
| `PERCEPTION_UNCERTAIN` | warning | `review-required` | `REFRAME_PERCEPTION_UNCERTAIN` |
| `NO_SUBJECT_OBSERVATION` | warning | `review-required` | `REFRAME_NO_SUBJECT_OBSERVATION` |

Sem evidência autenticada nenhum crop é decidido: a resposta é `review-required` + `FACE_PERCEPTION_UNAVAILABLE` + as janelas a pedir (e nada é gravado).

## 6. Override: semântica

Command `apply-variant-reframe-override` (tipo novo e fechado no registro; filho `preserves-plan`: reidentifica o EditPlan do pai, não recompila).

- **Escopo**: uma variante (id estável), um clipe, uma faixa semiaberta `[startFrame, endFrame)`. Variante fora do State, proporção como variante,
  clipe que a Versão não toca, faixa fora do clipe: recusados.
- **`set`**: crop manual **só de pan** (mesmo tamanho do crop máximo). Recusado se esconder um sujeito de que o servidor tem certeza
  (`HIDES_CRITICAL_SUBJECT`), salvo onde o próprio servidor achou `SUBJECTS_DO_NOT_FIT` (aí o editor escolhe qual manter).
- **`reset`**: devolve a faixa **exata** ao nível automático. Sem override ali, é recusado.
- **Precedência**: manual sobre automático, **só dentro da faixa**. Faixa idêntica substitui; sobreposição parcial é recusada.
- **Imutabilidade**: o Command recompõe o plano da variante sobre as **mesmas observações**; o `observationSet` e o `serverPlan` ficam
  byte a byte iguais, só o plano final e os intervalos do render mudam. Um `reset` completo devolve o **mesmo `recordHash`** do plano
  automático. O plano da **outra variante** é carregado idêntico (mesmo registro) para a Versão nova; a Versão anterior e seus planos não mudam.
- **Base e repetição**: base velha = `VERSION_CONFLICT`; mesma `Idempotency-Key` + mesmo corpo = a mesma Versão (200, `replayed`); outro corpo =
  `IDEMPOTENCY_PAYLOAD_MISMATCH`; direitos revogados = `ASSET_RIGHTS_BLOCKED`.
- **Ativo/inativo**: um override cujo clipe mudou (`CLIP_CHANGED`/`CLIP_ABSENT`) ou que passou a esconder um sujeito fica **inativo, com motivo
  no registro**, nunca descartado nem dobrado sobre outro clipe.
- Linhagem: `variant_reframe_overrides` (uma linha por Command), `variant_reframe_override_heads` (o último de cada faixa).

## 7. Contrato público e migração

- Migração `prisma/v2/migrations/20261019100000_variant_reframe_v1`: três tabelas novas (`variant_reframe_plans`, `variant_reframe_overrides`,
  `variant_reframe_override_heads`), a CHECK de `edit_commands.type` reescrita com o tipo novo e `w66_assert_child_command_state_v1` substituída
  (nenhum gatilho tocado). Validada: `db:v2:validate` = 321 tabelas, 1436 índices, 1119 FKs; implantada em PG16 descartável pelo harness.
- Capacidades: `apollo.projects.reframe-plans.create` **2.0.0 -> 3.0.0** (corpo `{baseVersionId, variantId}`, escopo `projects:write`; era `{baseVersionId, format}` com escopo `projects:read`, por
  proporção e sem persistência: a mudança de maior é intencional); novas `...reframe-plans.read`, `...variant-reframe-overrides.read` e
  `...variant-reframe-overrides.apply`. Total 391 -> 394. `contracts/v1/public-contract-baseline.json` e
  `docs/quality/ui-capability-parity-report.json` regenerados no mesmo commit.
- O conjunto v1 de overrides por proporção foi **mantido** (legado), sem alteração de comportamento.

## 8. Método da prova no mp4 renderizado (GT)

`tests/v2/helpers/reframe-gt-oracle.mjs` (puro; aritmética testada sem FFmpeg em `tests/v2/reframe-gt-oracle.test.mjs`) e
`tests/v2/reframe-trajectory-render.integration.mjs` (FFmpeg; **no CI**, passo "Run reframe trajectory goldens on the rendered mp4", e no harness).

**Um erro meu, registrado.** A primeira versão do oráculo media dentro de uma banda 16:9 e foi **adaptada ao layout** (`foregroundMapping`
codificava "tira dentro da banda"); quando o primeiro run tropeçou nisso, o oráculo foi ajustado ao que o renderer produzia em vez de apontar
o defeito: o crop de um reframe nunca preenchia o canvas (uma tira de ~171x304 num canvas de 540x960). A revisão rejeitou, com razão. O oráculo
foi reescrito para **não saber nada do layout** e para exigir o que um reframe **especifica**; o defeito foi corrigido no renderer (seção 4b).

- **GT**: um gerador decide, por frame, onde está cada sujeito, **desenha** os sujeitos num vídeo-fonte 1280x720 a 30 fps (textura de xadrez fina,
  que um borrão não reproduz; fiduciais brancos com espaçamentos irregulares, de modo que poucos deles se identificam sozinhos) e produz, dos
  mesmos frames, as linhas do detector. **O detector é um STAND-IN rotulado** (`GT-STAND-IN` nas linhas de evidência): suas caixas são as do
  gerador, escritas pelo decoder V9 de tensor bruto num envelope selado de produtor aceito. Não é um detector e nada diz sobre um detector em
  vídeo real. Daí em diante tudo é o produto: stream de evidência -> ROI -> plano selado -> keyframes -> `FfmpegEditorialProxyRenderer` -> mp4.
- **Expectativa** (da especificação, não do layout): um range reenquadrado mostra a janela de crop **preenchendo** o canvas da variante (cover);
  um range sem reframe (`fallback`) mostra o quadro inteiro como sempre mostrou.
- **Medição, em coordenadas do FRAME DE SAÍDA, sem dica de layout**: (1) onde está a imagem nítida (textura) e **quanto do canvas ela cobre**, por
  largura e por altura; (2) a escala (ajuste linear dos fiduciais); (3) a janela da fonte que a imagem mostra; (4) a caixa de cada sujeito em
  pixels do canvas e em pixels da fonte. Asserções por frame de um range reenquadrado: cobertura >= 98% da largura **e** da altura, escala igual à do
  cover do crop (2%), sujeito a <= 8 px de canvas de onde a especificação o põe, sujeito dentro do crop com a margem de segurança (menos 3 px de
  tolerância), caixa decodificada a <= 6 px de fonte da do gerador, e velocidade/aceleração do crop medido (janelas de 15 frames, para que um
  passo de 2 px não pareça movimento) dentro da política; o RenderInput é medido exatamente por `measureReframeTrajectory`. Cobertura e escala são
  razões **estruturais**: nenhuma issue do plano as desculpa.
- **Cenas**: uma pessoa lenta; sujeito em movimento (0,2/s); sujeito que reverte; duas pessoas afastadas; só tela; corte entre dois clipes;
  sujeito rápido demais; **uma linha do tempo com um clipe reenquadrado e outro não** (o segundo mantém a composição de sempre: comparado
  pixel a pixel com o mesmo clipe renderizado sozinho, diferença média absoluta 1,18 a 1,20 níveis, limite 2); e a variante 16:9.
- **Controles negativos** (o oráculo falha quando deve): crop estático perde o sujeito em movimento; trajetória com salto de 0,4 em 5 frames
  excede o limite de velocidade; e, no teste unitário, a composição de antes da correção **reprova** em todo frame reenquadrado.

## 9. Provas executadas

Contagens e ids literais; "N" é 1 por cena (stand-in determinístico: sem dispersão a reportar, indício e não amostra).

| Prova | Harness | Resultado |
| --- | --- | --- |
| **GT ANTES da correção** (oráculo final, composição antiga), 9 testes | `w66r-gt-before-3-661d89f4` | **3 de 9**: as 6 cenas 9:16 reenquadradas falham, com cobertura mínima **31,9% da largura x 31,8% da altura**, `foreground-does-not-fill-canvas` e `scale-differs-from-cover` em 150 de 150 frames, sujeito ~198 px de canvas fora de onde a especificação o põe; passam as duas cenas sem reframe e a 16:9 (cobertura 99,9% x 99,8%) |
| GT antes, tentativas com bugs do oráculo (não de produto) | `w66r-gt-before-1-fc0e7b7c`, `w66r-gt-before-2-48dcf674` | a cena só-tela falhava por uma linha de fundo saturado lida como imagem; corrigido no oráculo (lê sujeitos 3 px para dentro da borda), teste unitário acrescentado |
| **GT DEPOIS da correção**, 10 testes | `w66r-after-2-c24995ad` | **10 de 10**; cobertura mínima **99,6% x 99,8%**; erro máximo do sujeito no canvas 2,1 px; janela medida vs RenderInput 0,32 px; velocidade medida 0,269 e aceleração 0,713 (limites 0,35 e 0,8); cena rápida demais: 29 frames perdem o sujeito, todos dentro de issue localizada; clipe sem reframe vs sozinho 1,2 níveis |
| GT depois, 1ª tentativa | `w66r-after-1-6d13fcf3` | 8 de 10: a cena mista quebrava o `concat` (SAR 5120:5121 vs 1:1 no clipe composto): **defeito real achado pelo GT**, corrigido (`setsar=1`); o teste da cena rápida contava os frames desculpados contra o erro máximo: corrigido no juiz |
| PG + API (2 testes, `tests/v2/reframe-trajectory.pg.integration.mjs`), com GET por Versão nomeada (404 de outro workspace e de projeto inexistente; proporção e variante desconhecida = 428 `output-variant-unknown`), direitos revogados no override (422 `ASSET_RIGHTS_BLOCKED`, nada escrito, liberado quando os direitos voltam) e impacto de Versão inteira | `w66r-after-1-6d13fcf3` | 2 de 2 |
| Pixels e PG do W65 | `w66r-after-1-6d13fcf3` | `caption-placement-pixels` 11/11 **sem asserção alterada**, `prisma-caption-placement` 1/1, `prisma-final-caption-certification` 1/1, `prisma-final-caption-source-evidence` 1/1 |
| Regressão FFmpeg | `w66r-after-1-6d13fcf3` | `render-geometry-render` 3/3, `reframe-plan-render` 1/1, `format-quality-critic` 1/1, `transcript-rate-render` 2/2, `wave10` 2/2; `wave9` 2/3 (a 3ª mudou de causa, ver seção 10; `w66r-after-2-c24995ad`: 3/3) |
| Final export (precisa de build do Next) | `w66r-last-1-720fe008` | `w66r-last-1-720fe008` (com `--build`): **2 de 2** (na 1ª rodada, `w66r-after-1-6d13fcf3`, sem build do Next, o 2º teste falhava por falta de `.next`: ambiente, não produto) |
| `npm test` completo | `w66r-last-1-720fe008` | `w66r-final-2-0bf01d0e` (HEAD `9b38a332`): **3611 testes, 3598 passaram, 0 falharam, 13 pulados** (os mesmos pulados de antes: só-Linux/YuNet e um teste de PG isolado). Junto, no mesmo run: GT 10 de 10 e PG 2 de 2. O `npm test` de `w66r-last-1-720fe008` (3611, 1 falha) foi **contaminado por mim**: a rodada de mutação ainda estava viva e aplicou a mutação do GET de plano durante o run; a falha é exatamente o teste que a mutação deve quebrar. Repetido com a árvore limpa no run acima. |

## 10. Mutação, regressão e fixtures alteradas

**Mutação** (a regra quebrada com Edit temporário, o teste falha; restaurada, passa; `git status` limpo depois de cada uma):

| Regra | Quebra | Unitário | Renderizado / PG |
| --- | --- | --- | --- |
| Nunca interpolar através de um corte | a amostra seguinte vale mesmo fora do clipe | 9 de 10 (`reframe-trajectory-domain`) | `w66r-gt-mut2-a-b95929ab`: 9 de 10, falha a cena de dois clipes |
| Limite de velocidade/aceleração | o rastreador sem os dois `clampMagnitude` | 6 de 10 | `w66r-gt-mut2-b-0e71fd80`: 6 de 10 (4 falham) |
| O override nunca muda a observação nem o plano do servidor | plano do servidor decidido com os overrides | 9 de 10 | `w66r-pg-mut2-c-6865e0f9`: o arquivo falha (guarda do planejador) |
| **O crop preenche o canvas** | o clipe reenquadrado volta pelo quadro de trabalho | `reframe-composition-fill` 2 falhas | `w66r-gt-mut2-f-0c08cd15`: **3 de 10** (as cenas 9:16 reenquadradas falham pela cobertura) |
| Clipes unidos têm pixels quadrados | sem `setsar=1` no clipe composto | 1 falha | `w66r-gt-mut2-g-dc2020cc`: 9 de 10, a cena mista falha no `concat` |
| GET de plano checa projeto/workspace/variante com Versão nomeada | volta a pular a checagem | `plan-project-reframe-service` 1 falha ("Missing expected rejection") | (unitário) |
| Impacto honesto (Versão inteira da variante) | volta a ser a faixa editada | 3 falhas (registro e impacto) | (unitário) |

**Asserções pré-existentes alteradas, e por quê** (nenhuma foi afrouxada; cada uma descrevia o layout antigo ou o desenho anterior):

- `caption-canvas-projection.test.mjs`, "the reframe crop window reproduces ... the expression": afirmava a **tira** (largura visível do crop no quadro de
  trabalho e a borda esquerda da tira); passa a afirmar o **preenchimento** (imagem = canvas inteiro; a borda esquerda do crop está na borda esquerda do
  canvas). Teste novo: um clipe reenquadrado e um não, na mesma projeção, cada um com a sua geometria, e a identidade da projeção.
- `wave9-combined-journeys.integration.mjs`: o bloqueio duro da saída 9:16 vinha de um "apresentador com pillarbox" que deixava `subject-face` fora da
  imagem; com o canvas preenchido a geometria não pode mais pôr um sujeito protegido fora dela. O bloqueio passa a ser o que o plano da própria saída 9:16
  reporta (`REFRAME_SUBJECTS_DO_NOT_FIT`, `reframeIssues` na fonte falsa), localizado nela como antes: `SUBJECT_NOT_VISIBLE` deixa de existir nas duas
  saídas, o 16:9 não reporta nada `REFRAME_*`, e a decisão por variante é a mesma. (Antes: `reframePlanFor` com `variantId` estável e as duas asserções
  de `variantId`, ver `4e59a6b7`.)
- `edit-command-registry.test.mjs`: `apply-variant-reframe-override` sai da lista `partial-range` e entra na `full-timeline` (um render feito de plano é
  sempre completo); teste novo do impacto.
- `wave10`, `reframe-plan-render`, `render-geometry-render`, `caption-placement-pixels`, os PG do W65 e do export final: **nenhuma asserção alterada**.
- Anteriores: `proxy-source-rights` e `command-impact` (clientes falsos com `v2VariantReframePlan`), `project-final-export` (`variantId` estável),
  os pins SQL de `project-output-state-transition` e `renderable-compile-output-state` (primeira definição e a em vigor), `public-operation-contracts`
  (391 -> 394), `reframe-plan.test.mjs` (fronteira de aplicação e contrato v3; os testes de domínio ficam), `mvp-production-formats` (só o nome importado).

## 11. Limites e lacunas abertas

- Nenhum detector real foi medido: a qualidade do ROI em vídeo real é **desconhecida** (`realVideoMeasurement: not-performed`). Nenhum número desta
  nota é qualificação.
- O plano não é carregado por Commands que não são de reframe: um plano é pedido por Versão (e o override exige o plano da Versão base).
- Uma única fonte de vídeo por linha do tempo; sem identidade de trilha (o pareamento entre amostras é por IoU/distância, não por pessoa).
- A aceleração é limitada na grade de keyframes, com isenção na borda do quadro e nos degraus manuais; a borda de uma faixa manual é um degrau de 1 frame.
- O crop manual é só de pan (mesmo tamanho do máximo); clipe em fallback aparece inteiro (na composição de sempre: banda 16:9 sobre fundo borrado); mais de
  600 keyframes por clipe viram fallback.
- O cover de um crop com a proporção do canvas é exato a menos de ~1 px (404x720 em 540x960 corta ~1 px); um crop de outra proporção é cortado no centro.
- Motivos de recusa do override (`HIDES_CRITICAL_SUBJECT`, `reframe-plan-required`, `reframe-plan-stale`) ficam internos: o apresentador público
  de erros só publica o conjunto fechado de motivos de consumo, então a API responde 422/428 genéricos (o serviço de aplicação os expõe).
- A paridade da aprovação do export final (`approvedReframePlanHash`) está provada em teste unitário (`project-final-export.test.mjs`), não em PG.
- Os testes de PG desta nota rodam só no harness local supervisionado (declarados em `KNOWN_UNRUN_SUITES`); o de FFmpeg está no CI hospedado, onde
  roda sobre o `ffmpeg-static` do CI (não o do harness), o que não foi observado.
