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
| Render com um crop estático ou `reframePlan` montado à mão | Render lê o plano persistido da **sua** variante; `reframeRecordHash` entra no hash do RenderInput; issues entram no critic da **sua** saída |

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
`tests/v2/reframe-trajectory-render.integration.mjs` (FFmpeg, via harness).

- **GT**: um gerador decide, por frame, onde está cada sujeito, **desenha** os sujeitos no vídeo-fonte (1280x720, 30 fps, retângulos coloridos
  + fiduciais brancos a cada 48 px) e produz, dos mesmos frames, as linhas do detector. **O detector é um STAND-IN rotulado** (`GT-STAND-IN` nas
  linhas de evidência): suas caixas são as do gerador, escritas pelo decoder V9 de tensor bruto num envelope selado de produtor aceito.
  Não é um detector e nada diz sobre um detector em vídeo real. Daí em diante tudo é o produto: stream de evidência -> ROI -> plano selado ->
  keyframes -> `FfmpegEditorialProxyRenderer` -> mp4.
- **Medição**: o mp4 é decodificado frame a frame. A janela de crop de cada frame é recuperada **dos fiduciais** (ajuste linear
  `x_canvas = escala * x_fonte + deslocamento`), não do RenderInput, e então comparada com a aritmética do RenderInput (mesma quantização de pixel
  par da expressão do FFmpeg). Para cada frame: o sujeito GT está dentro do crop medido com a margem de segurança (menos 3 px de tolerância de
  quantização/medição), a caixa decodificada do sujeito bate com a do gerador (tolerância 6 px de fonte), e a velocidade/aceleração do crop
  medido (janelas de 15 frames, para que um passo de 2 px não pareça movimento) ficam dentro da política; o RenderInput é medido exatamente por
  `measureReframeTrajectory`.
- **Cenas**: uma pessoa lenta; sujeito em movimento (0,2/s); sujeito que reverte; duas pessoas afastadas; só tela; corte entre dois clipes;
  sujeito rápido demais; e a variante 16:9 da mesma evidência.
- **Controles negativos** (o oráculo falha quando deve): crop estático perde o sujeito em movimento; trajetória com salto de 0,4 em 5 frames
  excede o limite de velocidade.
- **Achado de geometria** (pré-existente, não alterado): o canvas vertical é um **banda 16:9** com o crop em tira dentro dela (tarja preta do
  estágio) sobre um fundo borrado (`foregroundScale = 1` em toda a produção, ver `caption-canvas-projection.ts`). O sujeito está dentro do crop e
  a medição lê só a banda; mas na saída 9:16 a tira nítida ocupa ~0,42 da escala. Decidir a composição (para o crop preencher o canvas)
  é trabalho de outro escopo.

## 9. Provas executadas

Contagens e ids literais; "N" é 1 por cena (stand-in determinístico: sem dispersão a reportar, indício e não amostra).

| Prova | Comando / harness | Resultado |
| --- | --- | --- |
| GT no mp4 (9 testes, 8 cenas + controles) | harness, run `w66r-gt-2-4e383d43` | 9 de 9 passaram |
| GT, 1ª tentativa | run `w66r-gt-1-74890e9d` | 1 de 9 (8 falhas): o oráculo lia o canvas inteiro e o fundo borrado, não a banda 16:9; corrigido no oráculo, nenhum limite relaxado |
| PG + API (2 testes, `tests/v2/reframe-trajectory.pg.integration.mjs`) | harness (tsx), run `w66r-pg-5-15203dbf` | 2 de 2 passaram |
| PG, tentativas anteriores | `w66r-pg-1-55aef31c`, `w66r-pg-2-f3ceaf31`, `w66r-pg-3-5881803a`, `w66r-pg-4-6a2bb5cd` | falhas de fixture/expectativa, e um defeito do produto achado e corrigido: o GET de overrides de outro workspace respondia 200 (agora 404 `PROJECT_NOT_FOUND`; proporção como variante = 428) |

Medidas do run `w66r-gt-2-4e383d43` (150 frames por cena, todos decodificados): nas 7 cenas rastreadas ou de fallback sem issue de falha, **0 frame
falhou**; erro máximo da janela medida contra o RenderInput 0,86 px de fonte (limite 3), erro máximo de posição do sujeito 3,06 px (limite 6),
folga mínima da margem 88,4 px; velocidade medida máxima 0,269 e aceleração medida máxima 0,713 (limites 0,35 e 0,8), RenderInput exato
0,333 e excesso de aceleração 1,9e-16. Na cena rápida demais, 29 frames perdem o sujeito e **todos** estão dentro de uma issue localizada
(57 frames sinalizados, 0 falha sem sinalização). Controles: crop estático = 39 frames falhando sem issue; salto = 2,4/s exato, 0,80/s medido.

Os ids das execuções de regressão, de mutação e do `npm test` completo estão na seção 10.

## 10. Mutação, regressão e `npm test`

(preenchido ao final da execução)

## 11. Limites e lacunas abertas

- Nenhum detector real foi medido: a qualidade do ROI em vídeo real é **desconhecida** (`realVideoMeasurement: not-performed`). Nenhum número desta
  nota é qualificação.
- O plano não é carregado por Commands que não são de reframe: um plano é pedido por Versão (e o override exige o plano da Versão base).
- Uma única fonte de vídeo por linha do tempo; sem identidade de trilha (o pareamento entre amostras é por IoU/distância, não por pessoa).
- A aceleração é limitada na grade de keyframes, com isenção na borda do quadro e nos degraus manuais; a borda de uma faixa manual é um degrau de 1 frame.
- O crop manual é só de pan (mesmo tamanho do máximo); clipe em fallback aparece inteiro; mais de 600 keyframes por clipe viram fallback.
- Motivos de recusa do override (`HIDES_CRITICAL_SUBJECT`, `reframe-plan-required`, `reframe-plan-stale`) ficam internos: o apresentador público
  de erros só publica o conjunto fechado de motivos de consumo, então a API responde 422/428 genéricos (o serviço de aplicação os expõe).
- A paridade da aprovação do export final (`approvedReframePlanHash`) está provada em teste unitário (`project-final-export.test.mjs`), não em PG.
- A composição vertical (seção 8) não foi alterada.
- Os testes de PG e de FFmpeg desta nota rodam só no harness local supervisionado (declarados em `KNOWN_UNRUN_SUITES`), não no CI hospedado.
