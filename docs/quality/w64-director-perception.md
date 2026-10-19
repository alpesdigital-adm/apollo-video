# W64 — o Diretor decide sobre a percepção persistida, com confiança (design e evidência)

Estado: **implementado e integrado, provado em PostgreSQL descartável (harness supervisionado); sem implantação**. Não marca nenhuma
caixa do `TODO.md` e não altera `docs/quality/project-status.json`. Base: W63a (`claude/w63a-perception-snapshot`, PR #83). A avaliação
com rótulos externos (calibração dos números abaixo) é a W63b e **não** está aqui: todo limiar desta nota é um *design prior* e diz isso.

## O que mudou, em uma frase por peça

1. **Claim** (`run-project-director.ts`): a percepção da run é o snapshot do servidor da Version dirigida (W63a), lido pelo mesmo leitor da API;
   a run reverifica workspace, selos/hashes dos envelopes, mapa de tempo (leitor + montador) e **direitos de TODA fonte que o plano toca**
   (mestre e inserts), integrais. Versão velha ⇒ `VERSION_CONFLICT` (código existente), antes de qualquer coisa ser pedida ou escrita.
2. **Janelas de rosto**: o que o corte precisa e as janelas seladas não cobrem é **pedido** pela mesma admissão da rota pública, como o ator da
   run, sem esperar.
3. **Tiers** `high`/`partial`/`absent` por modalidade e por decisão (`domain/director-evidence-rubric.ts`).
4. **`confidence-band-policy/v2`** (`domain/decision-confidence.ts`): tipos `crop`, `caption`, `insert` com bandas em (tier, confiança); v1 intacta.
5. **Decisions log + critic** levam os IDs de evidência; `director-quality-report/v4` traz a seção `perceptionEvidence`.
6. **`observationSet` de caller** não substitui nada (prova negativa abaixo).
7. **`GET .../perception/snapshot` é só leitura**; o snapshot é escrito no commit do Diretor.

## Tiers (rubrica `director-evidence-rubric/v1`)

Para uma modalidade sobre os intervalos da decisão (a decisão `crop` cobre a timeline; `caption`, os intervalos dos cues; `insert`, os clips
de outra fonte):

| tier | condição |
| --- | --- |
| `absent` | nada examinado no intervalo (sem produtor, ou examinado só fora dele), ou a evidência foi pedida e está pendente (`FACE_EVIDENCE_PENDING`), ou o pedido falhou (`FACE_EVIDENCE_REQUEST_FAILED`) |
| `partial` | parte do intervalo examinada (`PARTIAL_COVERAGE`, `PARTIAL_COVERAGE_REST_PENDING`), **ou** cobertura densa mas a modalidade tem teto (`FACE_DETECTOR_NOT_DEPLOYABLE`), ou a confiança não é medida (`CONFIDENCE_NOT_MEASURED`: a prior de 0,82 das palavras), ou a média medida está abaixo do piso (`BELOW_CONFIDENCE_FLOOR`) |
| `high` | cobertura **densa** de todo o intervalo por evidência selada, confiança média medida ≥ piso, modalidade sem teto (`SEALED_DENSE_COVERAGE`) |

*Densa*: todo instante do intervalo está a no máximo metade do `maxGapMs` da modalidade de uma amostra examinada. A cobertura estrita da W63a
(só os quadros amostrados) continua em `examinedMs`; `denseMs` é a que a rubrica aceita. Sem isso nada amostrado (OCR a cada 30 quadros,
rosto a 6 Hz) chegaria a `high`. Cobertura densa sem nenhuma observação (OCR amostrado sem texto) é medição de ausência: `high`.

| modalidade | `maxGapMs` | piso de confiança | teto |
| --- | --- | --- | --- |
| `transcript-word` | 600 | 0,70 | — (mas as palavras trazem prior, ver acima) |
| `ocr` | 2000 | 0,60 | — |
| `face` | 500 (gap de clearance da política de rosto) | 0,50 (piso V9) | **`partial`**, lido de `FACE_EVIDENCE_POLICY.claims` (`qualification: false`, gate `linux-parity-run-on-60-development-images-pending`) |
| `shot`, `motion` | 0 | 0 | — |
| demais kinds | sempre `absent` no snapshot | | |

Rosto é evidência `unverified-face-candidate`: **nunca `high`, nunca prova de face-safety** (`faceSafety` segue `unknown`,
`subtitlesFaceSafe=false`, `FACE_PERCEPTION_UNAVAILABLE`). `rights` é pseudo-modalidade **sem meio-termo**: `high` só se toda fonte tocada tem
direitos certos (aprovado, consentimento aprovado/não exigido, sem expirar em `now`); senão `absent` (`RIGHTS_UNKNOWN`,
`RIGHTS_STATUS_REVOKED`, `RIGHTS_EXPIRED`, `CONSENT_STATUS_*`…).

Requisitos por tipo (fixos na rubrica, o planner não os afrouxa): `crop` = face; `caption` = transcript-word + face + ocr; `insert` = rights quando
há insert, nada quando omitido. Tier da decisão = o mais fraco dos requeridos.

## `confidence-band-policy/v2`

Os tipos v1 mantêm exatamente os limiares v1. Tipos novos (todos *design prior*, sem corpus que os calibre):

| tipo | auto-apply | review (piso) | tier `absent` com confiança ≥ piso | por quê |
| --- | --- | --- | --- | --- |
| `crop` | tier `high` e ≥ 0,80 | 0,62 | **review** | o único crop do Diretor é o inset 16:9 sobre fundo borrado, não destrutivo e revisável; bloquear impediria toda run cujo detector ainda não olhou |
| `caption` | tier `high` e ≥ 0,80 | 0,70 | **review** | a legenda cai na região inferior reservada, rascunho revisável |
| `insert` | tier `high` e ≥ 0,90 | 0,65 | **block** | um insert acrescenta imagem que o mestre do dono não tem: sem direitos certos nada se apoia nele |
| `rights` | confiança = 1 | 1 | block | integral, ignora o tier |

Regra: confiança < piso ⇒ `block`; tier `absent` ⇒ resposta do tipo (nunca `auto-apply`); `auto-apply` só com tier `high` e confiança ≥ limiar; o resto é
`review`. Tier ausente ao classificar um tipo gated é erro. Confiança da decisão = o *prior* do planner (`crop` 0,82; `caption` 0,82 = prior das
palavras, em vez do 0,5 que fazia as vezes de "o detector não olhou"; `insert` 1,0): o tier carrega a qualidade da evidência. Uma decisão `block`
bloqueia o plano (`DECISION_EVIDENCE_BLOCKED`, issue `hard`; `INVALID_RENDER_INPUT` com `blockedDecisions`).

Hashes (SHA-256 do JSON canônico, fixados em `tests/v2/director-evidence-rubric.test.mjs`):

- `confidence-band-policy/v1`: `1d210d508cc54de38b55ec16d7f789b92b0411a44cf15889ed28e3e19e0fb43c` (inalterada)
- `confidence-band-policy/v2`: `7352b6295bf69af31ba4c36c2629922d9e1cd0d297fc7c910f05d41312158b34`
- `director-evidence-rubric/v1`: `fe25d5b395fadfa1cf5fafd094f243c4bf6b209da1fc6661f432df358e4bf75d`

O hash da política v2 vai em **cada decisão** (`bandPolicy`) e no relatório; o da rubrica, em cada evidência e no relatório. Uma decisão sem
`bandPolicy` é lida pela v1 como sempre foi (runs antigas não são re-graduadas); uma que carrega evidência sem `bandPolicy` v2 é recusada.

## Pedido de janelas de rosto

`planRequiredSourceWindows` sobre os clips (por fonte, spans de clips de taxa 1 e comprimentos iguais, alargados pelo gap de clearance e cortados
em janelas ≤ 300 quadros; fps não inteiro ⇒ `timeline-unsupported`). Janela coberta ponta a ponta por janelas seladas = *satisfied*. As demais são pedidas
por `enqueueFaceSourceWindowRunAsAudit` (a admissão da rota pública, agora com entrada por *audit* do ator da run; direitos de análise, limites de
janela e replay continuam sendo dela). **Chave de idempotência** = `dfw-` + 56 hex de SHA-256 de `(workspace, projeto, versão-base, fonte, janela)`:
pedir de novo o mesmo plano é a mesma operação. Limites: 200 pedidos por run (o resto `deferred`, `FACE_WINDOW_REQUEST_LIMIT_EXCEEDED`);
fonte cujas janelas excedem o orçamento da W63a não é pedida; pedido recusado com `DomainError` é registrado (`refused`) e a run segue; qualquer
outra falha **não** é engolida. Nunca se espera: janela pedida e não selada = `pending`. Janela pedida sob outra versão e ainda pendente é pedida
de novo sob a chave da nova versão (a chave inclui a versão, como o brief manda); o custo é trabalho duplicado do worker até a primeira selar.

## IDs de evidência

- snapshot: `perception-snapshot-<40 hex>` (= `server_perception_snapshots.id`, a linha que o commit escreve);
- envelopes: `inputs[].envelopeId` do snapshot por modalidade (OCR → `perception_producer_envelopes`, shot/motion → `temporal_producer_envelopes`,
  rosto → `face_source_window_envelopes`, palavras → `media_transcripts`, direitos → `asset_rights_snapshots`), até 64 por modalidade + contagem;
- observações: ids da timeline do snapshot nos intervalos da decisão, até 64 + contagem + `observationIdsHash` (hash da lista completa);
- cada decisão `crop`/`caption`/`insert` guarda `perceptionEvidence` (selada por `evidenceHash`) e nomeia o snapshot (e os envelopes, até 32 refs) em
  `evidenceRefs`, que o decisions log leva como `evidence[]`; o relatório v4 guarda, por modalidade, a mesma estrutura sobre a timeline inteira, as
  linhas de cobertura, os veredictos de direitos, o relatório de janelas e um *digest* por decisão. Nada disso exige migração: vive nos snapshots
  de projeto (`quality-report` v4) e no JSON das decisões.

## Contrato (aditivo; baseline e paridade regenerados no mesmo commit)

- `director-quality-report/v4` (novo; v3 segue legível) e schema `director-quality-report-read/v3`; capability `apollo.projects.director-runs.quality.read` 2.0.0 → 2.1.0.
- `project-workspace/v15` (`uncertainties[].type` aceita `crop`, `caption`, `insert`); `apollo.projects.workspace.read` 13.1.0 → 13.2.0 e `.current.read` 12.1.0 → 12.2.0.
- `apollo.projects.perception.snapshot.read` 1.0.0 → **2.0.0**: só leitura (404 `SNAPSHOT_NOT_MATERIALIZED` quando a Version toca algo e não tem snapshot; 428 se não toca nada, como antes;
  direitos e bytes das fontes reverificados a cada leitura; o hash do snapshot se reverifica contra a própria linha). Código novo `SNAPSHOT_NOT_MATERIALIZED` (404) altera, aditivamente,
  o enum dos `error-envelope` v3–v5 (a baseline os registra).
- Totais: 392 capabilities, 709 schemas (eram 707).

## Escrita do snapshot (fora do caminho de leitura)

O commit do Diretor escreve (uma vez, por conteúdo) o snapshot da Version dirigida, como na W63a. Depois do commit, **melhor esforço e fora da transação**,
o Diretor materializa o snapshot da Version que criou (falha ali não falha uma run já selada). `createServerPerceptionSnapshotMaterializer` (e o serviço
`materializeServerPerceptionSnapshotService`) escrevem para uma Version que nenhum Diretor dirigiu. **Lacuna aberta:** não há gatilho de produtor
(OCR/temporal/janela publica ⇒ materializa) nem capability pública de materialização; uma Version sem run do Diretor responde 404 até alguém materializar.
Custo no commit: inalterado em relação à W63a (a releitura de evidência dentro da transação Serializable é a mesma; o acréscimo é uma leitura de
direitos por fonte); timeouts não foram alterados. Ver "Custo medido" da W63a (≈ 5,4 s mediana a 1000 janelas em 30 s).

## Direitos revalidados onde a run nasce

O contexto lê o rights snapshot corrente de toda fonte do plano; o critic exige todos certos (gate `rights-compliance`, `STRATEGIC_RIGHTS_FAILED`).
No commit, dentro da transação, `evaluateSourceRightsCertainty` é aplicado de novo a cada fonte: não certa ⇒ `ASSET_RIGHTS_BLOCKED` (definitivo);
certa porém em outro snapshot de direitos ⇒ `PERSISTENCE_CONFLICT` (o worker tenta de novo). Os leitores dos produtores só reverificam direitos de fontes
que têm envelope; esta checagem é para todas, e é a que a prova PG isola (fonte sem envelope).

## Prova negativa do `observationSet`

`tests/v2/w64-caller-observations.test.mjs`: o schema legado `reframe-plan-request` v1 (o único com `observationSet`) continua registrado e **nenhuma**
capability, operação OpenAPI ou outro schema o referencia (decisão: manter registrado; remover quebraria a baseline por nada); nenhum schema de entrada declara
`observationSet`; reframe e `run-director` (enqueue e commands) **recusam** o corpo que o traz (Ajv, `additionalProperties`); nenhum módulo do caminho do
Diretor nomeia observation set, timeline manual, reframe legado ou o solver de placement; `createReframePlan` do legado não tem importador em `src`.
`run-project-director.test.mjs`: um Diretor que recebe `observationSet` no pedido e no contexto decide byte a byte como sem ele. PG: uma timeline manual
(`PUT /perception`) que declara rosto completo e perfeito não muda o hash do snapshot do Diretor. HTTP real: `POST /director-runs` com `observationSet` ⇒ 422 sem operação criada.
Os arquivos do reframe (`reframe-plan.ts` e família) não foram tocados (W66r); `domain/reframe-plan.ts` segue parseando um conjunto de caller, mas ninguém em `src` o importa.

## Evidência

Testes de unidade (`npm test`, sem banco): `director-evidence-rubric.test.mjs` (12), `run-project-director.test.mjs` (42, 7 novos),
`w64-caller-observations.test.mjs` (3), `server-perception-snapshot-read.test.mjs` (4).

PostgreSQL (harness `run-local-pg-s2d.mjs`, cluster descartável por invocação, lock global, pós-voo limpo em todas):

| run id | o que | resultado |
| --- | --- | --- |
| `w64-pg1-1ba518b1` | 1ª execução da suíte nova + W63a Director | 3/4 e 0/1: a falha da nova foi vazamento de fila (operação de rosto enfileirada por um teste, reivindicada pelo worker do teste seguinte; corrigido cancelando-as ao fim); a da W63a, contagem de linhas 1 → 2 (a Version criada ganha o seu snapshot; oráculo escopado à Version dirigida) |
| `w64-pg2-62ea0e45` | suíte nova 4/4; `prisma-director-server-perception` 1/1; `prisma-server-perception-snapshot` 5/5; `server-perception-snapshot-http` (tsx) 1/1 | 11/11, `success: true` |
| `w64-mut-rights-2b660e49` | **mutante sobrevivente**: re-verificação de direitos do commit desligada; a prova de direitos passou (outro guard do commit recusa com o mesmo código) | 4/4 passam: a prova não isolava a regra |
| `w64-mut-rights2-ab1975d4` | mesma mutação, depois de a prova passar a exigir a mensagem e os detalhes do guard do Diretor | 3/4, a de direitos falha: mutante morto |
| `w64-final-d660e7eb` (`--build`) | suíte nova 4, W63a Director 1, snapshot PG 5, snapshot HTTP 1, **servidor Next real 1**, `prisma-director-ocr` 6 (OCR real) | 18/18, 0 pulados |
| `w64-reg-96c0bbda` (`--build`, com as variáveis que habilitam as suítes) | `director-copy-editorial-cut.pg` 1, `multi-output-project-wide.pg` 1, `prisma-manual-edit` 1 | 3/3 (as três ficaram *puladas* na `w64-final-d660e7eb` por falta da variável; só esta rodada conta) |

Mutação (editar a regra, rodar as suítes de domínio, restaurar e conferir `git status` limpo; 59 testes de domínio/Diretor na base):

| regra quebrada | resultado |
| --- | --- |
| tier `absent` deixa de ter resposta própria (pode virar `auto-apply`) | 3 falhas |
| banda de `rights` deixa de ser integral (`>= 0,9`) | 1 falha |
| gate de direitos do critic: `every` → `some` | 1 falha |
| modalidade `rights`: um source certo basta | 1 falha |
| teto do rosto removido (rosto pode ser `high`) | 2 falhas |
| (PG) re-verificação de direitos no commit desligada | sobreviveu na 1ª forma da prova; morto depois (ver acima) |

Gates: `typecheck`, `lint`, `lint:code`, `lint:whitespace`, `db:v2:validate` (320 tabelas, 1429 índices, 1112 FKs: **nenhuma migração**), `api:v1:validate` (392 capabilities, 709 schemas),
`api:parity:validate` e `npm test` completo (3641 testes, 3628 passam, 0 falham, 13 pulados — os pulados já existiam).

## Asserções alteradas (todas explicadas; nenhuma enfraquecida)

- `run-project-director.test.mjs`: `decisionType` do layout `generation` → `crop` (o contrato novo tipa a decisão de layout como crop; a banda `review` segue); schema do relatório `v3` → `v4` e
  `contentSchemaVersion` 3 → 4 do snapshot de qualidade; o repositório controlado passa a declarar os direitos da fonte do insert (`timelineSourceRights`), como o leitor real faz, porque agora
  um insert de direitos desconhecidos é bloqueio.
- `list-projects`, `multi-output-public-contract`, `public-operation-contracts`: versões/refs de capability fixadas, atualizadas nas subidas deliberadas.
- `prisma-director-server-perception.integration.mjs` (W63a): "uma linha" passa a ser "uma linha **da Version dirigida**" (a Version criada ganha a sua após o commit).
- `server-perception-snapshot-http/-server`: antes do primeiro GET 200, o teste afirma o 404 e a ausência de escrita e então materializa; versão da capability 2.0.0.
- `tests/v2/helpers`: `ocrEnvelope` aceita `confidence` (default 0,76 inalterado); os mundos PG aceitam `evidence:false`, `ocrConfidence`, `faceRows`; `readServerPerceptionSnapshotService`
  (que montava e escrevia) virou `materializeServerPerceptionSnapshotService` nos helpers e suítes W63a que dependem dessa semântica.

## Limites e lacunas abertas

- `summary.confidence = 0,82` do resumo de percepção segue prior de política (duas asserções fixam o valor: `run-project-director.test.mjs` e `prisma-director-server-perception`). Nenhuma decisão o lê mais; trocá-lo
  por medida exige mudar essas asserções e a confiança por segmento do ASR no montador. TreatmentPlan segue com `visualVariety: 0` e recebe a cobertura de fala e a contagem real de observações; StoryPlan não consome percepção.
- Os números da rubrica e da política são priors; W63b mede.
- `speaker`, `silence`, `object`, `image-insert` seguem `absent` (W63a).
- Sem gatilho de produtor nem capability pública de materialização (ver acima).
- Janelas pendentes entre versões podem ser pedidas duas vezes (chave inclui a versão).
- A prova de cobertura densa usa gaps de design prior; o impacto real em vídeo é de W70.
