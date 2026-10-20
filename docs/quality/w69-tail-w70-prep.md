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

## 3. Lacunas e limites declarados

- A estimativa de largura é calibrada no Arial Bold (e na Liberation Sans, métrica compatível). Um host cujo `Arial` resolva para uma face mais larga (DejaVu) está fora desta alegação.
- Três linhas de legenda em 16:9 ainda cabem na tolerância de 6 px do crítico W65 (a layout reporta `fits: false`; o pixel não); é do crítico W65, não foi alterado.
- O crítico de pixels do W67 e o final real (W70) não foram executados aqui.
