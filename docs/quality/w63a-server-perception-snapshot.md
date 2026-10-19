# W63a — snapshot de percepção do servidor (design e evidência)

Estado: **implementado e integrado, provado em PostgreSQL descartável (harness supervisionado); sem implantação**. Não marca
nenhuma caixa do `TODO.md` e não altera `docs/quality/project-status.json`. A avaliação com rótulos externos (corpus e métricas)
é a W63b e **não** está aqui.

## O que é

Uma fusão canônica, de propriedade do servidor, de tudo o que o servidor já selou sobre **uma ProjectVersion**, no relógio do
próprio EditPlan, dizendo — por tipo — quanto da versão foi de fato examinado. Contrato do plano W63: *"Fundir words/speakers/
silence, faces, OCR, shots, motion e inserts em timeline canônica ordenada. `object` fica ausente quando não existir detector
verificado… Ranges não vistos e diferenças de fps/PTS são preservados."*

- `assembleServerPerceptionSnapshot` (`src/v2/domain/server-perception-snapshot.ts`) é uma função pura. Recebe somente evidência
  que o servidor selou: a transcrição retemporizada do EditPlan, envelopes de OCR, envelopes temporais (shot/motion) e janelas de
  rosto `face-producer-envelope/v3` (por quadros da FONTE). Devolve um `ServerPerceptionSnapshot` com `timeline`
  (`PerceptionTimeline`, `inventedValues: 0`), `inputs` (cada envelope usado, com o relógio medido pelo produtor),
  `rejected` (cada envelope recusado, com o motivo) e `snapshotHash` (SHA-256 do JSON canônico).
- A mesma evidência, em qualquer ordem, dá os mesmos bytes e o mesmo hash. Evidência diferente é outro snapshot.
- Uma timeline **manual** (`PUT /perception`, `manual-controlled`) é outra coisa e nunca entra no snapshot: `createPerceptionTimeline`
  tem `origin: 'manual'` por padrão e recusa proveniência de servidor e `reasonCode`; só a montagem do servidor (e os leitores que
  reconstroem o que ela gravou) passam `origin: 'server'`.

## Relógio e relação com fps/PTS

`ms = round(quadro / fps * 1000)`, com `fps` do EditPlan; duração `ceil(durationFrames / fps * 1000)`. Faixas de quadros que se
tocam se tocam em ms (a cobertura é fundida no domínio de quadros e só então convertida; o último quadro termina exatamente na
duração), então um tipo com **todos** os quadros examinados cobre a duração inteira — e só ele. Nada é interpolado: a faixa de um
quadro amostrado é a desse quadro. O relógio de cada produtor fica como foi medido (`inputs[].sourceClock.fps/timebase`) e cada
observação guarda seus próprios PTS/quadros de origem (`sourcePts`, `startSourcePts`, `sourceFrame`, `timelineFrame`). Um envelope cujo
`timelineFps` difere do EditPlan é recusado (`CLOCK_MISMATCH`); uma janela de rosto de fonte com fps diferente é *untrusted*
pelo fluxo de evidência da W65b.

## Cobertura por tipo (nunca `complete` por empréstimo)

| tipo | origem | cobertura |
| --- | --- | --- |
| `transcript-word` | `retimedTranscript.words` do EditPlan selado | só os trechos de palavra reconhecida (`RECOGNIZED_WORD_SPANS_ONLY`); o registro da transcrição não declara o intervalo examinado, então o silêncio entre palavras **não** é "examinado" |
| `ocr` | `perception-producer-envelope/v1` | só os quadros amostrados (`SAMPLED_FRAMES_ONLY`); as lacunas `NOT_SAMPLED` do produtor são levadas em `inputs[].unexamined` |
| `shot`, `motion` | `temporal-producer-envelope/v1` | pares de quadros adjacentes (`ADJACENT_PAIR_WINDOW_ONLY`); o último quadro de uma janela nunca tem par; pares acima do gate (`UNRELIABLE_FRAME_DIFFERENCE`) não são movimento; os valores são medidas brutas (`raw-adjacent-frame-change-score`, `raw-global-translation-estimate`), sem rótulo semântico |
| `face` | `face-producer-envelope/v3` por quadros da fonte | só os quadros amostrados com status `observed`, projetados pelos clips de taxa 1 e spans de mesmo comprimento (deslocamento `sourceIn − timelineIn`); amostras `unknown` e lacunas não cobrem; taxa ≠ 1, span desigual ou fps não inteiro ⇒ ausente com motivo, nunca estimado (mesma regra da W65b) |
| `speaker` | — | sempre `absent`, `DIARIZATION_UNAVAILABLE` |
| `silence` | — | sempre `absent`, `SILENCE_PRODUCER_UNAVAILABLE` |
| `object` | — | sempre `absent`, `NO_VERIFIED_DETECTOR` (nenhum produtor, nenhuma fixture) |
| `image-insert` | — | sempre `absent`, `INSERT_GEOMETRY_NOT_COMPILED` |

`complete` ⇔ todo quadro da versão foi examinado por *aquele* tipo. `partial` lista exatamente as faixas examinadas
(`ranges`); o complemento são as não vistas (`unexaminedRanges`, na leitura). `absent` sempre traz `reasonCode`:
`NO_PRODUCER_RUN`, `NO_TRANSCRIPT_WORDS`, `NO_SAMPLES_OBSERVED`, `TIMELINE_FPS_NOT_INTEGER`, `NO_UNIT_RATE_CLIP`, os quatro fixos acima.
Recortada a um intervalo, um tipo examinado só fora dele é `absent` ali com `RANGE_NOT_EXAMINED`.

Motivos de recusa de um envelope (`snapshot.rejected[].reasonCodes`): `ENVELOPE_SEAL_INVALID` (reconstruído pelo construtor do domínio,
não serializa igual), `ENVELOPE_AUTHORITY_INVALID`, `SCOPE_MISMATCH` (outro workspace/projeto), `STALE_VERSION` (outra versão),
`EDIT_PLAN_MISMATCH` (snapshot/hash do plano), `SOURCE_MISMATCH` (SHA dos bytes da fonte), `SOURCE_NOT_IN_TIMELINE`,
`TIME_MAP_MISMATCH`, `DURATION_MISMATCH`, `CLOCK_MISMATCH`, `DUPLICATE_ENVELOPE`, `TIMELINE_FPS_NOT_INTEGER`, e os motivos
`PRODUCER_*`/`EVIDENCE_CONFLICT`/`CLOCK_MISMATCH` do fluxo de evidência de rosto.

## Proveniência

Cada observação do servidor traz `source` (o registro que a originou: id do envelope ou da transcrição — como já era), `model`,
`version`, `confidence` e, **aditivamente**, `origin: 'server'`, `producer`, `envelopeId`, `envelopeHash` e `confidenceBasis`
(`producer-reported` = confiança do próprio produtor; `deterministic-measurement` = medida exata; `policy-prior` = não medida).
Os cinco campos de servidor vêm juntos ou não vêm, e `verifyServerPerceptionSnapshot` exige que `envelopeId/envelopeHash` de cada
observação nomeie um `input` listado.

**Desvio em relação ao brief, a ser decidido pelo revisor.** O brief descreve a proveniência como `{source:'server', producer, model,
version, envelopeId, envelopeHash, confidence}`. `source:'server'` é impossível sem enfraquecer uma asserção existente:
`tests/v2/run-project-director.test.mjs` exige `provenance.source === envelope.id` nas observações de OCR da Director ("com as
asserções inalteradas"). Mantive `source` como o id do registro e pus a autoridade em `origin:'server'`. É um renomear de campo
(custo de trocar: uma constante e os testes de contrato), sem consequência arquitetural.

`confidence` das palavras é `0.82` com base `policy-prior`: é a constante que a Director já usava no resumo; o plano retemporizado
não traz confiança do ASR. Está rotulada como prior de política, não medida; a W64 deve substituí-la.

## Persistência (migração aditiva `20261019120000_server_perception_snapshot_v1`)

- `server_perception_snapshots`: o `id` **é** o endereço de conteúdo (`perception-snapshot-` + 40 primeiros hex do SHA-256, por
  CHECK); único por `(workspaceId, projectVersionId, snapshotHash)`; FKs compostas para workspace, projeto, versão e snapshot do
  EditPlan; `BEFORE UPDATE OR DELETE` recusa (`server_perception_snapshot_immutable`).
- `server_perception_snapshot_coverage`: nove linhas por snapshot, com CHECKs: `absent` examinou 0 e tem motivo; `complete` examinou a duração
  inteira e não tem motivo; `partial` fica entre os dois; `object` só `absent/NO_VERIFIED_DETECTOR`; `speaker/silence/image-insert`
  só `absent`; motivo em maiúsculas. Um trigger `DEFERRABLE INITIALLY DEFERRED` exige os nove tipos no commit.
- Escrever é idempotente (`createMany … skipDuplicates`): a mesma evidência é a mesma linha, de qualquer chamador e sob concorrência.
- Ler reverifica tudo: o JSON se reconstrói (hash, timeline, estados e faixas recalculados, invariantes por tipo, proveniência
  amarrada a `inputs`), as colunas concordam com ele e as nove linhas de cobertura são as que o JSON implica.
- `GET` materializa o snapshot sob demanda (função determinística de evidência imutável; o chamador não escolhe conteúdo). Selo de
  cada envelope, bytes da fonte e direitos de análise são reverificados a cada leitura pelos leitores dos próprios produtores.

## Contrato público

`GET /v1/projects/{projectId}/perception/snapshot?versionId=&fromMs=&toMs=&kinds=` — capability `apollo.projects.perception.snapshot.read`
**1.0.0** (`projects:read`), schema `server-perception-snapshot-response/v1`. Workspace alheio ou versão inexistente: 404
(`PROJECT_NOT_FOUND`); sem credencial 401; sem o escopo 403; consulta inválida 422; versão que não toca nada 428. A linha de base
(`contracts/v1/public-contract-baseline.json`) e o relatório de paridade foram regenerados no mesmo commit (somente adições: 1 capability,
1 schema, 392 capabilities / 707 schemas no total). As capabilities de `perception.read/.put` (manual) não mudaram.

## Director

`run-project-director` monta a percepção **com o mesmo montador**; a `timeline` da run É a do snapshot e a run o nomeia por hash
(`perception.serverSnapshot`). O contexto da Director leva a evidência (`perceptionEvidence`), lida pelo mesmo leitor. No commit, a
transação relê a evidência: se algo mudou (OCR, temporal, janela de rosto, plano) a run é recusada sem deixar nada; senão os
mesmos bytes são gravados uma vez, dentro do commit. `faceSafety` continua `unknown` e nenhuma decisão lê os tipos novos
(`review-required`, `subtitlesFaceSafe=false`, `summary.confidence 0.82` inalterados). Mudanças visíveis e intencionais:
`summary.faceCoverage` deixa de ser `absent` fixo e passa a ser o estado do tipo `face` na timeline (o parser agora **amarra** o
resumo à cobertura da própria timeline, em vez de exigir `absent`); `visualCoverage` passa a considerar OCR, shot, motion e face;
`treatmentPlan.perception.evidenceItemCount` conta todas as observações da timeline.
`expectedOcrTimeline` (verificação de commit e trilha do proxy) usa a mesma projeção de OCR que o snapshot.

## Limites e lacunas abertas

- `speaker`: existem `speaker_diarization_runs` (clusters anônimos em tempo de fonte, pelo fluxo de long-form), mas nenhum código as liga ao
  EditPlan de uma versão e criar uma run exige workflow, manifesto e transcrição de long-form. Não foi consumido: `absent`
  (`DIARIZATION_UNAVAILABLE`). Caminho de integração: projetar os segmentos pelos clips (ms de fonte → quadros → linha do tempo) e
  cobrir `[0, durationMs)` da run.
- `silence`: não existe produtor (busca por `silencedetect`/áudio no ingest, transcrição e esquema Prisma: nada ligado a uma versão).
- `image-insert`: o EditPlan compilado só tem clips de vídeo e CTA; cenas `image-insert` nascem em compiladores de render específicos,
  não em snapshot de versão, e o `RenderElementMap` não distingue imagem de b-roll.
- O produtor temporal só existe para linhas do tempo de ≤300 quadros (≤10 s) de uma fonte; versões maiores ficam `NO_PRODUCER_RUN`.
- `GET` com leitor que revoga direitos ou encontra selo violado falha por inteiro (403/409), em vez de omitir parte da evidência.
- A cobertura de rosto é a dos quadros amostrados (nenhuma interpolação por `maxSampleGapFrames`, que é política de legenda da W65).
- Não há passo de CI hospedado para as suítes PG (declaradas em `KNOWN_UNRUN_SUITES`).

## Evidência

(ver a seção final, preenchida com as execuções)
