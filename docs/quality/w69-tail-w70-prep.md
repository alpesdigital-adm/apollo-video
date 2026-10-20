# W69 (cauda) + W70 (preparação)

Ramo `claude/w69t-w70-prep`, a partir de `origin/claude/w68-issue-override-ui` (W68, já fundida em `main` como 40f4056c). Não marca nenhuma caixa do `TODO.md` e não altera
`docs/quality/project-status.json`. Esta nota registra o que mudou, a decisão tomada em cada ponto em aberto, o que foi provado e **o que não foi**.

## 1. W69 cauda - o sidecar segue o que o MP4 queimou

### Decisões (o plano diz "exclusivamente das `RenderedCue` efetivamente usadas")

| Caso | Decisão |
| --- | --- |
| Texto alterado por exceção (`text`) | o sidecar traz o texto que o render queimou (texto compilado com as exceções da saída aplicadas, na forma canônica `canonicalCaptionText`) |
| Cue ocultada (`visibility: false`) | não é cue efetiva: não é desenhada nem listada |
| Cue que o plano não desenhou (suprimida / omitida e listada, p.ex. sem região segura) | **ausente do arquivo** e **nomeada** em `alignment.omittedCueIds` (resposta da API) e no compromisso (hash) do manifesto do sidecar; nunca marcada dentro do arquivo |
| Cue desenhada que não é cue efetiva | recusa `SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH`, `details.reason = rendered-cue-not-effective` |
| Render sem nenhuma cue desenhada | recusa `no-rendered-cue` |
| Versão sem render da saída, com render de **outra** Versão | recusa `render-stale` (antes: "não encontrado") com `requestedVersionId` e `renderedVersionId` |
| Conjunto de exceções vigente diferente do que o review do render registrou | recusa `override-set-mismatch` |
| Render bloqueado / sem review | `render-blocked` / `review-missing` (já existiam) |

O texto efetivo vem do snapshot de EditPlan do próprio render mais as exceções **vigentes na Versão do render** (`readSubtitleSegmentOverrideHeadsAsOf`), resolvidas pela mesma função
que o render usou (`resolveSubtitleOverridesForRender`), e o conjunto tem de ter o hash que o review do render gravou (`formatQuality.subtitleOverridesHash`). A receita do sidecar
subiu para 1.3.0; um render com exceções nomeia o conjunto no lineage (um render sem exceções mantém a forma do lineage que tinha).

Hardening encontrado no caminho: uma `Idempotency-Key` já usada para **outro** pedido de sidecar era respondida pelo lineage (não pelo conflito) quando o lineage do novo pedido já existia;
o serviço agora compara o fingerprint antes de qualquer I/O (`IDEMPOTENCY_PAYLOAD_MISMATCH`). E o apresentador de erros públicos passou a publicar o conjunto fechado de `details.reason` do
sidecar (a descrição da capability já prometia `details.reason`, mas ele não saía).

API: `apollo.projects.subtitle-sidecars.export` 2.1.0, resposta `subtitle-sidecar-exported/v2` (aditivo: `alignment.omittedCueIds`, `alignment.subtitleOverridesHash`; o v1 mantém seus bytes). Baseline de contrato e relatório de paridade regenerados no mesmo commit.

### Provas

- Unidade: `tests/v2/subtitle-sidecar-rendered-cues.test.mjs` (texto NFC decomposto vira `Ação`, `Última cue.` como última cue, tempos exatos, cue omitida nomeada, cue oculta, rendered-cue-not-effective, no-rendered-cue, lineage com/sem exceções, duas saídas com MP4/RenderInput/variante próprios, reuso de chave, apresentação do erro).
- Jornada real `tests/v2/subtitle-sidecar-override.e2e.mjs` (harness supervisionado, passo da CI `quality`): um projeto, duas saídas (9:16 e 16:9), `next start`, PostgreSQL, worker de produção, FFmpeg e storage reais.
  O SRT e o VTT de cada saída são baixados pela rota de conteúdo do artefato, conferidos contra o SHA-256 do registro e contra o arquivo do storage, lidos por um parser **independente do escritor do produto** e pelo demuxer SRT/WebVTT do FFmpeg (`ffprobe`), e os limites de cada cue são comparados com os **quadros decodificados do MP4**
  (o quadro em que a legenda aparece e o quadro seguinte ao último: no 16:9 pela mudança quadro a quadro da faixa, no 9:16 contra um controle da mesma saída sem legendas, porque o reenquadramento move a imagem sob a faixa).
  Passos: baseline das duas saídas (SRT+VTT); exceção de texto numa saída -> `render-stale` até recompilar; recompilar **uma** saída -> o sidecar dela segue o texto novo e o hash muda, o da outra (mesmo registro, mesmos bytes) não se move; ocultar cue; texto longo demais -> review bloqueado -> nenhum sidecar e nada persistido;
  autorização (outro workspace: 404 no export, lista vazia idêntica à de um projeto inexistente; sem `projects:write`: 403; sem credencial: 401; download por outro workspace recusado); replay, conflito de chave (409), arquivo adulterado no storage recusado na leitura.

## 2. W70 preparação

### 2.1 Quebra de legenda 16:9 (defeito real, anterior)

`wrapAssText` quebrava em 20 caracteres fixos para todo formato e o corpo vinha de `min(w * 0.059, h * 0.067)` (36 px em 16:9 de 960x540), enquanto a faixa que o plano certifica vem do **preset** (`deriveSubtitleRegion`: `maxLines` linhas no corpo do preset, 56 linhas de pixel em 16:9). Duas linhas de 36 px pedem ~74 linhas: toda legenda com mais de 20 caracteres em 16:9 era bloqueada pelo crítico de pixels do W65, no proxy e no final.

Agora (`src/v2/domain/caption-text-layout.ts`, geometria única): o corpo é o do preset no canvas (reduzido só se a faixa certificada for curta demais para `maxLines` linhas), a linha quebra pela **largura medida** do texto contra a largura da faixa (larguras do Arial Bold, que é o que a libass desenha; a estimativa só pode ser mais larga que os pixels) e as linhas saem como o texto pede; um texto que não cabe em `maxLines` **não é cortado**: transborda e o crítico bloqueia. O CTA mantém a quebra e o corpo que tinha.
Versões: renderer 1.17.0, receita de proxy 1.18.0, receita de final 1.15.0 (o mesmo texto agora desenha outros pixels).
`canonicalCaptionText` é o texto que o render queima e o que o sidecar leva.

Provas: `tests/v2/caption-text-layout.test.mjs` (invariante da geometria única para todos os presets x 2 formatos x canvas de proxy e de entrega: as linhas cabem na faixa; a testemunha do defeito antigo); `tests/v2/caption-text-layout-pixels.integration.mjs` (renderer real + FFmpeg + crítico W65 de produção, 16:9 e 9:16: legendas de 16 a 55 caracteres, com `Ação` e `Última cue.`, sem nenhuma issue, glifos dentro da faixa decidida, da safe area e do canvas, nunca mais largos que a estimativa; texto longo demais transborda e é bloqueado).
O browser proof do W68 dependia do defeito (o baseline 16:9 bloqueava "de graça"): o mundo agora semeia, pelo serviço de produção, uma exceção de texto longa demais na saída 16:9 (`wideOverflow`), que é um bloqueio duro **real**.

### 2.2 "Invalidar so o necessario": a saída intocada herda render, laudo e aprovação

Um Command aimed at one output cria uma Versão nova e a **outra** saída perdia render e aprovação. O hash de entrada do render (`projectProxyRenderInputHash`) nomeia a Versão (id, snapshot, State, materialização), então ele nunca é igual entre Versões; o endereço que vale entre Versões é
`projectProxyRenderContentHash`: o conteúdo do EditPlan **sem** `id/projectVersionId/createdAt`, as fontes, as ligações de cor, `variantId` + revisão e hash do OutputSpec, o registro de reenquadramento, o conjunto de exceções de legenda, o preset de legenda (e o snapshot), a evidência de OCR, os assets e os sujeitos de posicionamento, o renderer e a receita.
Ele é gravado na operação de render (`project_proxy_render_operations.renderContentHash`, coluna nova, migração `20261020120000_proxy_render_carry_over_v1`); uma linha anterior não tem endereço e **nunca** é fonte.

`carryOverUntouchedOutputService` (chamado após a confirmação dos Commands de exceção de legenda e de reenquadramento, melhor esforço; e a resposta de um pedido de render de uma saída já herdada é a operação herdada, não um segundo render) herda de uma Versão **ancestral** cuja operação de render concluída tem exatamente o endereço de agora, numa transação Serializable: operação concluída sobre o **mesmo artefato**
(`reusedFromOperationId`, `reuseBaseVersionId`, `reuseCommandId` = o Command que fez a cabeça), o mapa de cues do mesmo MP4 ligado à Versão nova e um laudo com hash próprio. Um laudo cujas ressalvas uma pessoa reconheceu é criado como o laudo pendente que era e levado a `ready-for-final` por uma **decisão de tipo próprio**, `carry-over-approval`
(`baseReviewHash` = o laudo herdado, `requestFingerprint` = o endereço que provou a igualdade, ator = quem disparou; a restrição de ação de `proxy_review_decisions` passou a aceitar o novo valor): a aprovação é religada explicitamente, nunca copiada em silêncio, e nenhum "reconhecimento humano" é inventado. Um laudo que ninguém aprovou é herdado como era. O status do projeto não muda.

Provas (`tests/v2/proxy-render-content-hash.test.mjs`; `tests/v2/proxy-carry-over.e2e.mjs`, PostgreSQL + FFmpeg + worker de produção): o endereço é igual para Versões que só diferem na identidade e se move com cada entrada (18 mutações, sem colisão); Command na saída 16:9 -> a 9:16 (aprovada por uma pessoa) é herdada pelo mesmo artefato, hash do laudo recalculado e válido, decisão
`carry-over-approval` com base/resultado/ator, nenhum segundo `acknowledge-warnings`, mapa de cues ligado, o leitor do sidecar vê a saída herdada, a saída afetada não é herdada, uma segunda tentativa encontra a operação, e pedir o render da saída herdada devolve a mesma operação; Command que muda as entradas da outra saída -> nada é herdado para ela;
operação sem endereço nunca é fonte; endereço restaurado -> herda de uma Versão ancestral que não é a mãe; cabeça que se moveu -> recusa.
Limite declarado: o endereço não vê evidência de rosto publicada **depois** do render anterior (o plano de posicionamento a lê na hora de renderizar), como o hash de entrada também não vê; herdar mantém os pixels e o veredito que a saída tinha, não reexecuta percepção. A herança não é exposta no esquema público do laudo (aditivo
futuro); está na operação (`reusedFrom*`), na decisão e no endereço.

### 2.3 Cancelamento durante um render em execução

`tests/v2/proxy-render-cancel-running.e2e.mjs` (worker de produção, repositórios reais, PostgreSQL, FFmpeg): o renderer real é retido depois que o FFmpeg escreveu o MP4 inteiro no scratch, até a operação ser cancelada, de modo que o cancelamento cai no meio da fase `rendering` com o arquivo pronto e ainda não promovido. Cancelado pelo serviço público: o sinal do render é abortado, o worker retorna, a operação termina `canceled` sem lease, **não** existe linha de artefato, manifesto,
laudo, mapa de cues nem decisão, nenhum arquivo sob o prefixo do artefato, o diretório de scratch da operação some, e o mesmo pedido não reabre a operação cancelada (a saída é outra Versão).

### 2.4 Aprovação x conjunto de exceções

Já estava no W68 e foi conferida: `subtitleOverridesMatchApproval` (final recusa uma aprovação dada para outro conjunto; "nenhum" dos dois lados é igual) com testes em `tests/v2/w68-subtitle-override-render.test.mjs`. O laudo herdado leva o mesmo `subtitleOverridesHash`, então o portão continua coerente.

## 3. Lacunas e limites declarados

- A estimativa de largura é calibrada no Arial Bold (e na Liberation Sans, métrica compatível). Um host cujo `Arial` resolva para uma face mais larga (DejaVu) está fora desta alegação.
- Três linhas de legenda em 16:9 ainda cabem na tolerância de 6 px do crítico W65 (a layout reporta `fits: false`; o pixel não); é do crítico W65, não foi alterado.
- O crítico de pixels do W67 (OpenVINO) e o final real (W70) não foram executados aqui. O final exige um DirectorRun cujo resultado seja a Versão; uma Versão nascida de um Command de exceção não o tem, então a aprovação herdada vale para o portão do laudo, não substitui o Diretor.
- Uma execução da jornada de browser do W68 (`w69t-w68ui-3`) falhou no passo `tall-hide` ("hide Command is committed: null", depois do reenquadramento), o mesmo ponto em que o W68 relatou uma execução sem saída; ver o relatório final.
- Uma execução da jornada do sidecar ficou sem saída por 48 min num render que parou em `persisting` (`w69t-sidecar-16`), sem erro registrado; a repetição imediata passou. Não foi reproduzida nem explicada; a jornada agora coleta o estado do banco (`pg_stat_activity`) quando um render não se resolve e o `stop` do pump tem prazo.
