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
  `rejected` (cada envelope — ou fonte, ou grupo de palavras — recusado, com o motivo), `unexaminedSpans` (trechos que nenhuma amostra poderia
  cobrir, com o motivo) e `snapshotHash` (SHA-256 do JSON canônico).
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
| `face` | `face-producer-envelope/v3` por quadros da fonte | só os quadros amostrados com status `observed`, projetados pelos clips de taxa 1 e spans de mesmo comprimento (deslocamento `sourceIn − timelineIn`); amostras `unknown` e lacunas não cobrem; taxa ≠ 1 (`NO_UNIT_RATE_CLIP`), span desigual (`SOURCE_TIMELINE_LENGTH_MISMATCH`) ou fps não inteiro (`TIMELINE_FPS_NOT_INTEGER`) ⇒ o trecho fica em `unexaminedSpans` com o PRÓPRIO motivo, nunca estimado (mesma regra da W65b). **Todas** as janelas da fonte que tocam o que os clips tocam são lidas (keyset), dentro de um orçamento de 1000 janelas por snapshot; a fonte que não cabe é recusada inteira (`FACE_WINDOW_LIMIT_EXCEEDED`), nunca truncada (ver "Janelas de rosto") |
| `speaker` | — | sempre `absent`, `DIARIZATION_UNAVAILABLE` |
| `silence` | — | sempre `absent`, `SILENCE_PRODUCER_UNAVAILABLE` |
| `object` | — | sempre `absent`, `NO_VERIFIED_DETECTOR` (nenhum produtor, nenhuma fixture) |
| `image-insert` | — | sempre `absent`, `INSERT_GEOMETRY_NOT_COMPILED` |

`complete` ⇔ todo quadro da versão foi examinado por *aquele* tipo. `partial` lista exatamente as faixas examinadas
(`ranges`); o complemento são as não vistas (`unexaminedRanges`, na leitura). `absent` sempre traz `reasonCode`:
`NO_PRODUCER_RUN`, `NO_TRANSCRIPT_WORDS`, `NO_SAMPLES_OBSERVED`, `TIMELINE_FPS_NOT_INTEGER`, `NO_UNIT_RATE_CLIP`,
`SOURCE_TIMELINE_LENGTH_MISMATCH`, `FACE_WINDOW_LIMIT_EXCEEDED`, `WORD_OUTSIDE_TIMELINE`, `WORD_SPAN_INVALID`, os quatro fixos acima.
Recortada a um intervalo, um tipo examinado só fora dele é `absent` ali com `RANGE_NOT_EXAMINED`.

**O motivo vai com o trecho.** O que nenhuma amostra poderia cobrir por um fato estrutural — clip de outra velocidade, spans de
comprimento desigual, fps não inteiro, fonte cujas janelas não foram lidas — vem em `snapshot.unexaminedSpans`
(`{ kind, startMs, endMs, reasonCode }`, ordenado, dentro do hash e conferido por `verifyServerPerceptionSnapshot`). Na leitura por
intervalo, `coverage[].unexaminedReasons` parte o `unexaminedRanges` onde o motivo muda: o trecho dentro de um span estrutural diz o
motivo do span (`NO_UNIT_RATE_CLIP`), o resto diz o genérico (`SAMPLED_FRAMES_ONLY`/`RANGE_NOT_EXAMINED`); o `reasonCode` do tipo é o
único motivo quando só há um. Antes isto aparecia como `RANGE_NOT_EXAMINED`/`SAMPLED_FRAMES_ONLY`, como se o produtor tivesse apenas
deixado de amostrar.

## O que é recusado, e onde

Há dois lugares, com efeitos diferentes:

1. **O leitor real (`GET`)** reverifica, a cada leitura e pelos leitores dos próprios produtores, o selo de cada envelope, os bytes da
   fonte (SHA) e os direitos de análise. Uma violação — envelope adulterado, envelope selado para outros bytes que os da fonte (SHA
   diferente), direito revogado — **faz a leitura inteira falhar**: 409 `PERSISTENCE_CONFLICT` (selo/SHA) ou 422
   `ASSET_RIGHTS_BLOCKED` (direitos). Nada meio-confiável é servido, e nada é gravado. É o que as suítes PG provam (seção Evidência).
2. **O montador puro** (`assembleServerPerceptionSnapshot`) recusa e LISTA em `snapshot.rejected[]` a evidência que lhe é entregue e
   que não pertence a esta versão ou não se sustenta. `SOURCE_MISMATCH` aparece aqui — quando o SHA da fonte que o chamador declara
   difere do selado no envelope (e, para uma janela de rosto, quando o SHA da fonte não é conhecido) —, mas **não** é o que acontece num
   `GET` cujo envelope foi selado para outros bytes que os da fonte no banco: os leitores do item 1 recusam antes, com 409.

Motivos de recusa do montador (`snapshot.rejected[].reasonCodes`): `ENVELOPE_SEAL_INVALID` (reconstruído pelo construtor do domínio,
não serializa igual), `ENVELOPE_AUTHORITY_INVALID`, `SCOPE_MISMATCH` (outro workspace/projeto), `STALE_VERSION` (outra versão),
`EDIT_PLAN_MISMATCH` (snapshot/hash do plano), `SOURCE_MISMATCH` (SHA dos bytes da fonte), `SOURCE_NOT_IN_TIMELINE`,
`TIME_MAP_MISMATCH`, `DURATION_MISMATCH`, `CLOCK_MISMATCH`, `DUPLICATE_ENVELOPE`, `TIMELINE_FPS_NOT_INTEGER`, e os motivos
`PRODUCER_*`/`EVIDENCE_CONFLICT`/`CLOCK_MISMATCH` do fluxo de evidência de rosto. Entradas novas:

- `FACE_WINDOW_LIMIT_EXCEEDED`: `{ kind: 'face', envelopeId: <fonte>, envelopeHash: <SHA dos bytes da fonte> }` — a fonte cujas janelas
  não cabem no orçamento; nenhuma janela dela é usada.
- `WORD_OUTSIDE_TIMELINE` e `WORD_SPAN_INVALID`: `{ kind: 'transcript', envelopeId: <transcrição>, envelopeHash: <hash da transcrição>,
  subjects: [<ids das palavras>] }`. Uma palavra que o plano põe fora da linha do tempo (começa antes de 0 ou termina depois da duração)
  ou com intervalo vazio/inválido é descartada e nomeada, **nunca** grudada na borda (antes ela virava `[duração−1, duração]`). O id da
  palavra é sua posição no plano (`transcript-word-<n>`), então a recusa nomeia exatamente a palavra que perdeu. Se nenhuma palavra
  é aproveitável o tipo é `absent` com esse motivo e nenhum `input` de transcrição é listado.

## Janelas de rosto: todas ou nenhuma

A evidência de rosto é da FONTE e cresce com cada janela publicada. O leitor antigo listava no máximo 200 janelas (as primeiras por início)
e descartava o resto sem dizer: janelas depois do corte não davam cobertura e duas janelas que se contradiziam nunca se encontravam.
Agora (`src/v2/domain/face-window-paging.ts`):

- as janelas de cada fonte são lidas por **keyset** `(windowStartSourceFrame, createdAt, id)`, páginas de 100, até acabarem; cada página
  é reverificada como antes (selo, colunas, bytes brutos, direitos); o cursor tem de avançar, senão a leitura falha (`PERSISTENCE_CONFLICT`);
- o orçamento é de **1000 janelas por snapshot** (somado entre as fontes da linha do tempo, gasto em ordem de id de fonte: cada fonte recebe
  o que sobrou). A contagem vem antes: uma fonte que não cabe não custa nenhuma leitura de janela. Se janelas escritas durante a leitura
  estourarem o orçamento, nada do que foi lido é usado;
- a fonte que não cabe é **recusada inteira**: sem cobertura de rosto, `rejected` com `FACE_WINDOW_LIMIT_EXCEEDED`, um `unexaminedSpans`
  por clip dela com o mesmo motivo, e o tipo `face` `absent` com esse motivo (se outra fonte contribui, o tipo é `partial`). Nunca uma
  lista parcial em silêncio. A lista e a resposta do snapshot ficam limitadas por construção (`inputs`/`rejected` ≤ 4096, no esquema e no
  domínio).

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
- **O `GET` grava a linha endereçada pelo conteúdo** quando ela ainda não existe (o escopo é `projects:read`): o conteúdo é função
  determinística de evidência imutável e o chamador não escolhe nenhum byte dele; a Director grava a mesma linha no seu commit. O efeito
  é idempotente (mesma evidência, mesma linha, `createdAt` da primeira escrita) e uma leitura recusada não grava nada. Selo de cada
  envelope, bytes da fonte e direitos de análise são reverificados a cada leitura pelos leitores dos próprios produtores, inclusive
  quando a linha já existe (não há caminho "quente" que pule a verificação; ver o custo medido abaixo).

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
- `GET` cujo leitor encontra direitos revogados, um selo violado ou um envelope selado para outros bytes que os da fonte (SHA) falha por inteiro (`ASSET_RIGHTS_BLOCKED` 422, `PERSISTENCE_CONFLICT` 409), em vez de omitir parte da evidência. O `rejected` lista o que o montador puro recusa (seção "O que é recusado, e onde"); um SHA divergente no caminho real NÃO chega a ser listado: é 409.
- A evidência de rosto é da FONTE e compartilhada: quando surge uma janela nova para a fonte, o snapshot de uma versão antiga (pedida por `versionId`) passa a ter conteúdo diferente — é outra linha, endereçada pelo novo hash; as linhas já gravadas nunca mudam. OCR e temporal são presos à versão e não crescem.
- O orçamento de 1000 janelas é uma decisão de custo, não de correção: uma fonte além dele fica sem cobertura de rosto, dita (`FACE_WINDOW_LIMIT_EXCEEDED`). 1000 janelas de ≤10 s sem sobreposição são ≈2,7 h de fonte; a sobreposição (re-execuções) consome o orçamento mais depressa. Medido: o custo cresce ≈ linearmente com o nº de janelas (≈4,8 ms/janela reverificada, ver "Custo medido"), e a Director refaz essa leitura DENTRO da transação Serializable do commit; a constante é `FACE_WINDOW_SNAPSHOT_CAP`.
- A fonte da transcrição é a da linha de transcrição. Palavras cujo registro não está no workspace seguem presas ao EditPlan selado (produtor `unresolved`, hash do plano) e não são escondidas; nesse caso a fonte nomeada é a **única** fonte que a linha do tempo toca, e, havendo várias, `inputs[].sourceArtifactId` é `null` (e `sourceSha256` `null`) — nunca a primeira da lista, que seria um palpite apresentado como fato.
- A cobertura de rosto é a dos quadros amostrados (nenhuma interpolação por `maxSampleGapFrames`, que é política de legenda da W65).
- CI hospedado: as suítes PG, a da Director e a do servidor real (`next start`) rodam no job `perception` pelo lançador de namespace (ver "Evidência"). A suíte HTTP em processo (`server-perception-snapshot-http`) segue local: importa o handler da rota pelo alias `@/`, o que exige tsx, e o lançador roda Node nativo; o mesmo contrato é coberto no CI pela suíte do servidor real. O orçamento agregado do job (`APOLLO_PERCEPTION_JOB_DEADLINE_MS`, 18 min; 8 min exigidos livres a cada lançamento de namespace) não foi alterado e **não pôde ser medido fora do CI hospedado**: três lançamentos a mais são o risco a vigiar na primeira execução.

## Evidência

Suítes. Rodam no job `perception` do CI hospedado (lançador de namespace, passo "Server perception snapshot, Director commit and real-server
HTTP", depois do passo temporal) **e** no harness supervisionado de PostgreSQL descartável: `prisma-server-perception-snapshot`,
`prisma-director-server-perception` e `server-perception-snapshot-server`. Fora do CI, declaradas em `KNOWN_UNRUN_SUITES` com o motivo:
`server-perception-snapshot-http` (tsx) e `prisma-server-perception-cost` (medição).

- `tests/v2/server-perception-snapshot.test.mjs` — 21 testes de domínio (`node --test`, roda no `npm test`): ordenação e desempate, aritmética de
  cobertura, duplicatas, lacunas preservadas, mesma evidência em outra ordem = mesmo hash, selo violado recusado, vínculo (versão, plano, workspace,
  fonte, mapa de tempo, relógio), PTS/relógio preservados, projeção de rosto por clips cortados, taxa ≠ 1, `object` ausente, PUT manual não eleva; e,
  novos: o motivo próprio de cada trecho estrutural (no snapshot e em cada consulta de intervalo, soma das partes = não examinado), o verificador
  recusa um span que não é span, palavra fora da linha do tempo recusada e nomeada (nunca `[4999, 5000]`), fonte de janelas não lidas, fonte da
  transcrição `null` quando indeterminada.
- `tests/v2/face-window-paging.test.mjs` — 5 testes: >200 janelas lidas por inteiro e em ordem (sem repetir nem pular entre páginas, inclusive em
  empate de início+criação), exatamente o teto é lido e um acima é recusa que não lê nenhuma janela, o orçamento é um só para todas as fontes,
  cursor que não avança e página maior que a pedida falham fechado.
- `tests/v2/prisma-server-perception-snapshot.integration.mjs` — evidência real (OCR, temporal, rosto v3 gravados pelos escritores dos produtos),
  cobertura por tipo, idempotência e concorrência, isolamento, versão antiga, direitos revogados, selo/bytes violados, tabela imutável, CHECKs, linha
  forjada; e, novo, **213 janelas** publicadas pelos escritores dos produtos: todas lidas (também com página de 7, mesma evidência), a contradição
  numa janela que a lista antiga de 200 nunca alcançava é encontrada (as duas janelas em desacordo recusadas, `EVIDENCE_CONFLICT`), exatamente o
  teto é lido e um abaixo dele é a recusa `FACE_WINDOW_LIMIT_EXCEEDED` (linha própria, resposta válida no esquema publicado, a consulta de
  intervalo diz o motivo).
- `tests/v2/prisma-director-server-perception.integration.mjs` — a percepção da Director é o snapshot (mesmos bytes), gravada uma vez no commit, run recusada se a evidência mudou. Usa a razão de aspecto 4:5 (a suíte de OCR é dona de 9:16 e um id de variante é único no banco).
- `tests/v2/server-perception-snapshot-http.integration.mjs` — a rota, em processo (tsx), com autenticação real: 200 + esquema publicado, recorte, 404/401/403/422/428, PUT manual separado.
- `tests/v2/server-perception-snapshot-server.integration.mjs` — a mesma rota num `next start` real (build de produção), esquema servido pela própria API e OpenAPI.
- `tests/v2/prisma-server-perception-cost.integration.mjs` — a medição abaixo (corretude verificada; nunca falha por tempo).

### Execuções (harness `run-local-pg-s2d.mjs`, cluster descartável por invocação, lock global, pós-voo limpo)

| run id | o que | resultado |
| --- | --- | --- |
| `w63a-final2-3a0c809a` (`--build`, migração aplicada do zero) | `prisma-server-perception-snapshot` 4 testes; `prisma-director-server-perception` 1; `server-perception-snapshot-http` 1; `server-perception-snapshot-server` (Next real, build de produção) 1; regressão: `director-copy-editorial-cut.pg` 1, `multi-output-project-wide.pg` 1, `prisma-director-ocr` 6 (inclui o teste W64 com OCR real: 32 s), `prisma-manual-edit` 1 | 16/16 passam; `success: true`, pós-voo limpo (cluster parado, zero backends) |
| `w63a-vs2-47940039` | `prisma-vertical-smoke` isolada | 1/1 passa |
| `w63a-reg1-b46a34c2` e `w63a-final-53a1cae4` | rodadas anteriores (mesmo código) | as suítes W63a e a regressão passaram; `a1-manual` precisa de `--build` (falhou sem ele, passou com ele); a suíte real-server falhou por um nome de cabeçalho errado no TESTE (corrigido) |
| `w63a-r2b-86ec159d` (`--build`, commit `eb898e2e`, na ordem e na forma do job `perception`: `node --experimental-transform-types --test`, sem tsx, `CI=true`, `APOLLO_PERCEPTION_HTTP_E2E=1`, pool 2) | regressão `prisma-director-ocr` 6; depois `prisma-server-perception-snapshot` 5 (76,6 s no passo), `prisma-director-server-perception` 1 (16,8 s), `server-perception-snapshot-server` (Next real, **Node nativo**) 1 (16,8 s); e a suíte de rota em processo (tsx) 1 (31,7 s) | 14/14 passam, 0 pulados; `success: true`, pós-voo limpo |
| `w63a-r2a-a957865e` (commit `9aad5617`, ambiente do job `perception`: `CI=true`, pool `connection_limit=2`, nome de aplicação do job) | `prisma-server-perception-snapshot` 5 testes (61,5 s no passo; o de 213 janelas 43,1 s); `prisma-director-server-perception` 1 (16,5 s); `prisma-server-perception-cost` 1 (196,5 s) | 7/7 passam; `success: true`, pós-voo limpo |

Interferência anterior à W63a, medida na linha de base (`origin/main` 9b03d7bf, run `w63a-base2-51fbab8c`): `prisma-vertical-smoke` roda o worker de proxy
render, que reivindica a PRÓXIMA operação da fila do cluster; executada no mesmo cluster depois de `prisma-manual-edit` ela falha com
"Project proxy worker returned no persisted failure detail", com ou sem esta mudança: N=1 na linha de base (`w63a-base2-51fbab8c`) e N=1 no branch
(`w63a-final-53a1cae4`), a mesma asserção. (Repetida duas vezes no MESMO banco depois de passar, `w63a-vs1-01df846d` passos b/c, ela falha por outra causa, uma
violação de unicidade do Prisma: a suíte assume um banco novo.) Sozinha passa (N=4 no branch: `w63a-vs2-47940039`, `w63a-vs1-01df846d` passo a, `w63a-reg1-b46a34c2`,
e a linha de base `w63a-base1-ec6fd1d9`). O CI roda cada suíte num banco novo. Isto é uma hipótese confirmada por contraste (mesma falha antes e depois, passa isolada);
a causa dentro do worker de proxy não foi investigada.

Domínio e contrato (sem banco): `npm test` completo em `eb898e2e`: 3601 testes, 3588 passam, 0 falham, 13 pulados (os pulados já existiam). Gates:
`typecheck`, `lint`, `lint:code`, `lint:whitespace`, `db:v2:validate` (320 tabelas, 1429 índices, 1112 FKs), `api:v1:validate` (392 capabilities, 707 schemas),
`api:parity:validate`: todos exit 0.

### Custo medido (`prisma-server-perception-cost`, run `w63a-r2a-a957865e`)

Janelas de rosto publicadas pelos escritores dos produtos (admissão, claim, publicação com fence), uma de cada vez: ≈96 ms por janela até 200 e
≈87 ms até 990. PostgreSQL 16 descartável **na mesma máquina** (sem rede), uma execução do harness, **N=3 por escala** (cada repetição publica uma
janela a mais, então toda GET fria e toda run da Director vê evidência que de fato mudou). Valores em ms, mín / mediana / máx; **medido** onde
dito, **estimado** onde dito. Números de um runner hospedado ou de um banco remoto serão outros: leia as proporções, não os valores.

| | 201–203 janelas | 991–993 janelas |
| --- | --- | --- |
| leitura da evidência, sozinha (cada janela reverificada) | 843 / 931 / 1102 | 4451 / 4772 / 5189 |
| montagem (CPU, sem banco) | 31 / 31 / 41 | 118 / 132 / 135 |
| GET fria (lê, monta, grava a linha) | 994 / 1076 / 1121 | 4574 / 4681 / 4851 |
| GET quente (lê, monta, acha a linha) | 948 / 1005 / 1043 | 4960 / 5152 / 5338 |
| Director: leitura do contexto | 1048 / 1103 / 1172 | 5068 / 5342 / 5470 |
| **Director: commit (transação Serializable, timeout 30 000)** | **1154 / 1225 / 1382** | **4922 / 5445 / 6046** |
| Director: run inteira | 2351 / 2352 / 2477 | 10104 / 10915 / 11640 |
| tentativas do commit (as 3 permitidas) | 1, 1, 1 | 1, 1, 1 |
| JSON gravado / corpo da resposta (bytes) | ≈345 mil / ≈349 mil | ≈858 mil / ≈862 mil |

Leitura: o custo é ≈ linear no nº de janelas (**estimado** ≈4,6–4,8 ms por janela reverificada: 931/202 e 4772/992); a montagem é desprezível (≤3 %);
a GET quente **não** é mais barata que a fria — toda GET reverifica selos, bytes e direitos (por desenho), e a gravação da linha é pequena. No teto
(≈1000 janelas) a transação de commit da Director usa **≈18 % do timeout de 30 s na mediana e ≈20 % no pior caso medido**, sem nenhuma segunda
tentativa; em 200 janelas, ≈4–5 %. Os timeouts não foram alterados. Pesos a ter em conta: (1) a Director refaz TODA a leitura dentro da transação
Serializable (para recusar evidência que mudou), então um banco ≈5× mais lento que este (**estimativa**: 30 s / 5,4 s, não medida) já a levaria ao limite; (2) uma GET
no teto leva ≈5 s e devolve ≈0,86 MB; (3) o JSON do snapshot guarda um `input` por janela (≈0,65 KB cada: (858 − 345) mil bytes / (992 − 202) janelas). Se isto for pesado demais, a alavanca é a
constante `FACE_WINDOW_SNAPSHOT_CAP` (a fonte que não cabe é recusada com motivo, não quebrada); a outra é não reverificar tudo no commit
(comparar as linhas selecionadas em vez de refazer a leitura), que é uma mudança de projeto e não foi feita.
As três Directors de cada escala rodam em sequência sobre o head que a anterior deixou: a primeira na Version de entrada (com OCR e temporal),
as outras nas Versions de saída da própria Director (as mesmas janelas da fonte, sem linha de OCR/temporal) — a diferença é de duas linhas, o custo vem das janelas.

### Teste de mutação (três regras), com as suítes de domínio

| regra quebrada (editada e restaurada) | resultado |
| --- | --- |
| `coverageState`: `complete` quando `observedMs > 0` | 9 testes falham (7 do snapshot, 2 do `perception-timeline`) |
| `complete` por empréstimo: um tipo sem evidência herda as faixas de `shot` | 1 falha ("nunca vira complete porque outro tipo tem cobertura") |
| verificação do selo do OCR reduzida a "o construtor aceita" | 1 falha (envelope violado deve ser recusado) |
| verificador sem o vínculo observação → input listado | 0 falhas na 1ª versão do teste (a mutação SOBREVIVEU: o teste também tropeçava num hash de timeline desatualizado); teste reforçado (re-sela todos os hashes, só o vínculo recusa) → 1 falha; o mesmo reforço no caso forjado do PG |
| verificador sem a regra `object` ausente | 1 falha |
| montador sem `object` fixo ausente (`NO_VERIFIED_DETECTOR`) | 5 falhas |

Segunda rodada (paginação, motivos por trecho, palavras fora da linha do tempo; cada regra editada, as suítes de domínio rodadas, a regra restaurada e conferida byte a byte):

| regra quebrada | resultado |
| --- | --- |
| paginação sem a recusa por contagem (`total > cap`) | 1 falha ("over the cap is a stated refusal…") |
| paginação sem a checagem de crescimento durante a leitura | 1 falha (leitura que estoura o teto no meio não é confiável) |
| o orçamento não é abatido pelas fontes já lidas | 1 falha ("the cap is one budget for the whole snapshot…") |
| clip fora de taxa 1 não gera `unexaminedSpans` | 1 falha |
| a consulta de intervalo ignora os spans (volta ao motivo genérico) | 1 falha |
| palavra além da duração volta a ser grudada na borda (`end > durationFrames` deixa de recusar) | 1 falha |
| fonte recusada continua usando suas janelas | 1 falha |
