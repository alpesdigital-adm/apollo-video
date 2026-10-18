# W69 — relógio materializado de emissão de legendas

Desenho para implementação, 2026-10-12. Não ativa a policy ASS isolada nem
declara W69 integrada. A prova física v5 permanece FAIL autenticado.

## Evidência que determina a correção

O run privado `w69-ass-clock-v5-differential-5f07883b` preserva o resultado
SHA-256 `18e3d5e5efcb4074c789f525458e9eeceaa8af14c934a8b01eca2fc2cf117e3a`
e manifesto `3805d9f7d22092683c2163b4a08bb16cac304cf8145c3895f6c510245f40cfb6`.
Os 281 arquivos e 36 comparações de pixels foram autenticados em revisão
independente. O caso original reprovado e os casos não executados permanecem
assim classificados; 73 execuções FFmpeg com exit 0 não equivalem a pixel PASS.

Os controles ASS antes/depois da fronteira discriminam comportamentos nos
frames 6/60, 111/30 e 803/100. FPS ideal sozinho não identifica o instante
efetivamente entregue a libass. O PTS/time_base foi observado antes do filtro;
a conversão numérica para `long long now` é inferida da implementação pinada
FFmpeg/libass e validada pelos pixels, não uma medição interna desse argumento.

O graph controlado concat v=1:a=0 dessa prova também não é o graph completo do
produto: este inclui concat v=1:a=1, áudio, retiming, escala, background/foreground,
overlays e placements antes de libass, além de `-r` na saída.

## Contrato proposto

Materializar uma identidade versionada do relógio para cada composição e cada
fragmento antes de serializar ASS. Ela deve vincular:

- identidades reais de workspace, projeto, versão, OutputVariant/OutputSpecRevision
  e spec validado, sem usar formato como ID;
- RenderInput preparado, fontes/manifestos/SHA/bytes e metadados/probes reais,
  source clocks, rates e mapeamentos de ranges;
- prefixo exato do graph até libass, incluindo áudio que influencia concat,
  composição/placements, seek/trim/fps/setpts e rebase do fragmento;
- executável FFmpeg, bibliotecas/build e versão da policy de conversão, fonte
  de glifos e parâmetros efetivos; versão declarada sem hash de executável
  não comprova a identidade dos bytes utilizados;
- sequência de frames, PTS inteiro e time_base racional efetivos, ou uma
  representação compacta cuja equivalência integral à sequência foi provada;
- origem global do fragmento, intervalo local e política de encoding/emissão.

Um FPS, um recipe ID ou um vetor calculado apenas por `n/fps` não substitui
essa materialização. Fonte/graph alterado, PTS ausente, duplicado, não monótono,
contagem inesperada ou observação incompleta bloqueiam a emissão.

O primeiro caminho de implementação será preparação explícita do prefixo
efetivo sem ASS, sob owner/deadline, com coleta bounded do relógio, seguida da
emissão usando exatamente o mesmo prefixo e identidades. A execução definitiva
precisa conferir o relógio observado novamente antes de publicar: determinismo
entre duas execuções não é presumido. Limites de frames, bytes e duração vêm
do RenderInput materializado; overflow/incompletude não vira amostragem.

Uma normalização explícita do clock após a composição pode substituir essa
preparação no futuro, somente com contrato/recipe próprio e prova física. Não
será introduzida como correção numérica implícita nem derivada de FPS por
conveniência. Rates .25–4, multilayers, diferentes source FPS e orientação
continuam capacidades a preservar; não se aplica o limite crop v1 ao renderer.

## Escolha de fronteiras ASS

Para iniciar no frame `k`, uma fronteira em centissegundos `cs` precisa
satisfazer `previousMs < 10*cs <= currentMs`, usando o relógio efetivo
materializado e a conversão pinada. A mesma regra governa o fim exclusivo.
O intervalo inteiro admissível é de `floor(previousMs/10)+1` até
`floor(currentMs/10)`. Sem inteiro admissível, o intervalo solicitado é
irrepresentável e falha antes de renderer/cache. Não usar epsilon, deslocar
os frames esperados ou reduzir o teto global de FPS para ocultar o caso.

Primeiro/último frame exigem limites explícitos do domínio da composição; não
inventar predecessor ou sucessor. Cues adjacentes, CTA e cada fragmento
clipado/rebaseado passam pela mesma política. Representabilidade global não
comprova representabilidade local após rebase.

## Selos, cache e publicação

O input seal inclui clock materializado, policy/encoding, spec revision,
fontes/graph/executável e conteúdo ASS efetivo. Entradas antigas sem esse selo
não são reutilizadas sob o recipe novo; isso não invalida silenciosamente todo
cache do recipe anterior antes da ativação. A mudança é explícita e implica
cold render nos recipes afetados.

O hash de entrada não contém o hash futuro do MP4 nem do receipt. Após render,
o receipt liga input seal, ASS UTF-8 efetivo, mapa bijetivo de cues pós-wrap,
frames/pixels observados, MP4 e relógio final. O clock do MP4 após `-r`, mux e
stitch é medido separadamente; sidecar não presume que seja igual ao de libass.

W69 integrada exige variantes reais W66 e publicação atômica de receipt,
manifestos, catálogo, outbox e succeed, com fences de head/rights/attempt/lease/
cancel e testes PG com esperas reais. Qualquer falha mantém todos esses fatos
fora do estado atual. Reader diagnóstico não concede aprovação futura.

## Próximas provas

Antes de ativar: contratos/negativos puros; pixels independentes nos dois graphs
controlados e no prefixo completo do produto; 3/6/111/803, 100/120 FPS, adjacência,
CTA, fragmentos rebaseados, .25–4 e multilayers; verificação de PTS do MP4 final;
cache frio/stale e publicação PG atômica. A policy v1 reprovada não é reabilitada
por este desenho. Nenhum status TODO, deploy ou aceite é promovido.

## Causa exata e binder de intervalos representáveis (2026-10-17)

**Causa.** O vf_subtitles do FFmpeg 8.1.1 não entrega a libass o instante racional
do frame. Ele calcula `double time_ms = pts * av_q2d(time_base) * 1000` e a conversão
implícita para `long long now` trunca. O binary64 arredonda depois de `av_q2d`, depois
do produto com o PTS e depois do `* 1000`; um frame que cai exatamente num milissegundo
chega um milissegundo abaixo: 100000@1/1000000 = 99 (o mesmo frame 6/60 em 1/60 = 100),
111@1/30 = 3699, 803@1/100 = 8029. A libass mostra um evento sse `start <= now < start +
duração` (meio-aberto, em ms) e o ASS guarda centissegundos; a fronteira escrita no
centissegundo ideal (v1) cai um frame depois exatamente nesses frames. Inclusividade,
direção do arredondamento do centissegundo e fps não são a causa: o frame com now = 100
acende o evento que começa em 100. No modelo, com `now` pela conversão fixada, a fronteira
v1 fica atrasada em 450 de 6667 frames sobre centissegundo exato a 30 fps com time_base
1/fps e em 1920 de 6667 com o time_base 1/1000000 que o concat publica (25/50/100 fps:
97 e 5937 de 20000).

**Binder.** Para iniciar (ou terminar, exclusivo) no frame `k` o centissegundo `cs` tem de
satisfazer `now(k-1) < 10*cs <= now(k)`; o binder escolhe o máximo desse intervalo, como o
contrato do relógio materializado, sem epsilon e sem deslocar o frame esperado. Janela
vazia é recusa tipada (`AssBoundaryUnrepresentableError`, `details.reason =
ASS_BOUNDARY_UNREPRESENTABLE`, com o frame e os `now` vizinhos) antes de qualquer I/O. A
mesma implementação (`libass-clock-model.ts`) atende o relógio observado (contrato acima) e
o relógio fechado abaixo; a prova de solidez e completude contra um oráculo independente
da visibilidade libass cobre todos os intervalos [a,b) de 120 frames em 24–240 fps e três
time_bases (`tests/v2/libass-clock-binder-model.test.mjs`).

**Normalização explícita (`ass-frame-clock/v2`; o estágio foi substituído em `ass-frame-clock/v3`, seção
"Estágio final do relógio" abaixo).** O último estágio antes da libass passou a
ser `fps=<taxa>`: o filtro publica o inverso da taxa reduzida como time_base e numera os
frames consecutivamente a partir do primeiro PTS, então o `now` da libass é função fechada
de (índice, taxa) e o time_base de saída da composição (concat 1/1000000, lavfi 1/taxa,
overlay herdado) não chega mais à libass. É a "normalização explícita do clock" que este
desenho previa para o futuro, com contrato e recipe próprios (política v2, renderer 1.14.0,
receitas 1.15.0/1.10.0) e prova física própria; não é correção numérica. O coletor observa
o mesmo estágio e o teste de integração do coletor exige PTS = índice em 1/taxa. O caminho
observado/replay deste documento continua sendo o contrato de evidência (isolado, não
ativado) e verifica o relógio fechado, não é substituído por ele.

**Representabilidade.** Com o relógio fechado, 24–90 fps têm 100% das fronteiras e dos
cues de um frame representáveis (janela de pelo menos 10 ms); 100 fps: 99,7% e 99,4%
(frame 803 recusado: `now` 8020 e 8029 não contêm centissegundo); 120 fps: 83,3% e 66,7%;
144 fps: 69,4% e 38,9%; 240 fps: 41,7% e 0% (cue de um frame nunca é representável).
Com o time_base 1/1000000 do concat, 100 fps cairia para 77,0% e 53,9%: o estágio `fps`
é parte da correção. O modelo do relógio não tem teto de taxa: uma taxa genuinamente
irrepresentável é recusa por intervalo, provada nos pixels (esgotando os pares de
centissegundos vizinhos). O teto de produto para legenda queimada está na seção seguinte.

## Legenda queimada acima de 90 fps é recusada na validação (decisão de 17/10/2026)

**Regra.** Um OutputSpec cujo perfil de entrega queima legenda (`profile.subtitles.mode =
burn-in`) só existe até 90 fps (`BURN_IN_SUBTITLE_MAX_FPS`). Acima disso a recusa é tipada e
acontece antes de qualquer renderização, relógio, cache ou leitura de repositório:
`DomainError` de código `INVALID_OUTPUT_SPEC` com `details.reason =
SUBTITLE_BURN_IN_FPS_UNSUPPORTED`, `details.mode = burn-in`, `details.fps` e `details.maxFps`
(`BurnInSubtitleFpsUnsupportedError`, `isBurnInSubtitleFpsUnsupported`, em
`src/v2/domain/output-spec.ts`). Saídas sem legenda queimada (`none`) e com sidecar mantêm
1..120 fps: o relógio do sidecar é o do MP4, em milissegundos exatos (receita 1.2.0).

**Por que 90.** É a maior taxa com representabilidade medida de 100% das fronteiras e dos cues
de um frame (24–90 fps, relógio fechado `ass-frame-clock/v2`/`v3`; o par entregue à libass é o mesmo). A 100 fps já existe frame que
nenhum centissegundo separa (frame 803, provado nos pixels) e a 120 fps o modelo perde um
sexto das fronteiras e um terço dos cues de um frame. As taxas 91–99 não foram medidas
separadamente; o corte em 90 não afirma nada sobre elas, só deixa de oferecê-las.

**Onde é aplicada.** (1) `parseCreateProjectOutputVariantBody`, a porta pública de
`POST /v1/projects/{projectId}/output-variants`, antes de ler o projeto; (2)
`createOutputSpecRevisionBody`, que todo caminho que cria, revisa, bifurca, sela ou reidrata
uma revisão de OutputSpec atravessa (comando de variante, estado de saída, bifurcação,
relógio materializado e coletor), antes de qualquer verificação de configuração ou fonte. Não
há mudança de schema público (a restrição é entre campos, como `proxy.fps = output.fps`, e
já era imposta em tempo de execução), então não há versão de schema nem de capability a subir;
o texto da capability `apollo.projects.output-variants.create` foi atualizado.

**Testes.** `tests/v2/burn-in-subtitle-fps.test.mjs` varre 1..120 fps nos três modos, prova a
precedência da recusa, o caminho de selagem e o caminho público; cada ponto de aplicação tem
mutação que o teste detecta. Três testes do relógio materializado e o fixture do coletor
usavam burn-in a 100/120 fps só para exercitar o relógio; passaram a selar essas entradas como
`sidecar` (o relógio não lê o modo), mantendo todas as asserções de recusa por intervalo, e o
teste ganhou a asserção de que o spec de burn-in a 120 fps não existe mais.

## Sidecar de uma versão histórica (decisão de 17/10/2026)

`POST /v1/projects/{projectId}/subtitle-sidecars` aceita `projectVersionId` de uma versão que
não é mais a corrente. O sidecar dela é derivado só do render dela: mesma variante, mesmo
RenderInput, mesmo snapshot de EditPlan e mesmo cue map, nunca do head atual. A resposta traz
`projectVersion.current = false`. O serviço recusa, com `SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH`
e antes de ler artefato, preparar arquivo, promover ou persistir (`details.reason =
render-binding-mismatch`), qualquer resolução que não seja o render que o pedido nomeia
(outro projeto, outra variante, outra versão); as verificações de checksum do MP4, receita do
manifesto, RenderInput do manifesto, hash do cue map, igualdade texto-cue e o veredito de
revisão (`render-blocked`, `review-missing`) valem igual para versão corrente e histórica. A
condição de corrente é lida na hora da exportação e não entra no lineage: o mesmo render gera o
mesmo sidecar endereçado por conteúdo esteja a versão no head ou não. A listagem devolve o
`projectVersionId` de cada sidecar; compará-lo com a versão corrente do projeto é feito pelo
cliente (a listagem não persiste nem recalcula "corrente"). Testes:
`tests/v2/subtitle-sidecar-historical.test.mjs` (sem FFmpeg) e, com MP4 real,
`T-FR-175 a historical version yields its own sidecar` em
`tests/v2/subtitle-sidecar-pipeline.integration.mjs`.

**Fragmentos.** Cada fragmento clipado/rebaseado reinicia o relógio em 0 e é ligado de novo:
no modelo, o cue global [5,6) a 120 fps é representável (4..5 cs) e o mesmo cue local [1,2)
após rebase de 4 frames não é.

**Sidecars SRT/VTT.** O relógio dos sidecars é o do MP4 (frame `k` apresentado em `k/taxa`),
não o da libass. Um player mostra o cue em `t` sse `start <= t < end`; arredondar ao
milissegundo mais próximo (regra 1.1.0) começava o cue depois do seu próprio primeiro frame
(30 fps, frame 2 = 66,67 ms virava 67 ms) e terminava o cue um frame tarde. A receita 1.2.0
usa o piso exato (inteiros, taxa canônica em micro-hertz): cobre exatamente [a,b) em todos
os pares de 24–120 fps incluindo 23,976/29,97/59,94, cues adjacentes compartilham o
milissegundo da fronteira, e uma taxa que não separa frames consecutivos em milissegundos
recusa o cue (faixa não positiva) em vez de publicar um errado
(`tests/v2/subtitle-sidecar-frame-clock.test.mjs`, com oráculo de player independente).

## Estágio final do relógio: `settb=1/<taxa>,setpts=N` em vez de `fps` (`ass-frame-clock/v3`, 18/10/2026)

**Achado.** A primeira rodada das suítes físicas em 47467ff7 (`BASE/w69-physical-suites-v1-2e497d0d`) reprovou
`T-FR-227` do renderer editorial: o proxy de 30 s saía com 899 quadros em vez de 900. No commit anterior
(f7ee0b05, `BASE/w69-physical-suites-v1-58726aee`) a mesma suíte passa 9/9; as demais falhas daquela rodada eram
anteriores ao W69 e iguais em f7ee0b05. A prova de pixels v6 passara porque usa o FFmpeg 8.1.1 pinado; as suítes usam o
`ffmpeg-static`, que é o **6.1.1** (Gyan essentials 2023).

**Causa.** No 6.1.1, `fps=<taxa>` colocado depois de `concat` + `overlay=shortest=1` descarta o último quadro, em todas
as taxas medidas (24, 25, 30, 50, 60, 90, 100, 120; `BASE/w69-clock-stage-candidates-v1-b40105d5`). A reprodução do grafo exato
do T-FR-227, com e sem o estágio, isola o estágio: sem ele 900 quadros, com ele 899 (`BASE/w69-fps-stage-diagnosis-v2-27d318a0`).
No 8.1.1 o mesmo estágio mantém a contagem.

**O que não resolve.** `fps=<taxa>:eof_action=pass` conserta o grafo do T-FR-227 mas não a matriz sintética no 6.1.1 e, no
8.1.1, **acrescenta** um quadro a 24 e a 60 fps (149 de 148; 365 de 364); `start_time=0` não muda nada; `round=up` não é
uma garantia, só um resultado (`BASE/w69-fps-eof-action-v1-7db6c2a3`).

**Escolha.** `settb=1/<taxa>,setpts=N`: publica o inverso da taxa como time base e numera os quadros 0, 1, 2, ... sem
tocar na contagem. A libass recebe o mesmo par (PTS = índice, time base 1/taxa) que o `fps` entregava, então o binder, a
tabela de representabilidade e a prova de pixels continuam valendo sem mudança de arquitetura. Em todas as taxas e nas duas
builds a contagem é exata e o PTS na saída do estágio é igual ao índice do quadro (`showinfo`). O custo é que o estágio não
repara um fluxo que chegue irregular; o renderer já normaliza cada clipe com `fps=<taxa>` na entrada do grafo, e o fluxo
composto é CFR (o `-r` da saída continua aplicado).

**Versões.** Política `ass-frame-clock/v3` (clock `settb-setpts-consecutive-pts/v1`), renderer 1.15.0, receita de proxy 1.16.0
e de final 1.11.0: um proxy ou final do estágio `fps` fica um quadro curto nessa build e não pode ser reaproveitado. O
coletor observa o mesmo estágio (`buildPreLibassClockStage`).

**Verificação física no commit que adota o estágio** (sob o lock global, evidência add-only em `BASE`):
prova de pixels com receita nova, editorial-renderer 9/9 (T-FR-227 completo, 30/60/120 s, proxy e final), coletor,
subtitle-anchor, subtitle-styles, style-tokens, proof-mode goldens e subtitle-vtt-native; caminhos em
`docs/quality/w69-materialized-subtitle-clock-v2.md` na seção seguinte quando a rodada termina.
