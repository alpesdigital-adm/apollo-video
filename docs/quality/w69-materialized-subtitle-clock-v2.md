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

**Normalização explícita (`ass-frame-clock/v2`).** O último estágio antes da libass passa a
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
é parte da correção. Não há teto de taxa na política; o teto 1..120 do OutputSpec é regra
de produto separada. Taxa genuinamente irrepresentável é recusa por intervalo, provada nos
pixels (esgotando os pares de centissegundos vizinhos) e não uma proibição.

**Fragmentos.** Cada fragmento clipado/rebaseado reinicia o relógio em 0 e é ligado de novo:
no modelo, o cue global [5,6) a 120 fps é representável (4..5 cs) e o mesmo cue local [1,2)
após rebase de 4 frames não é.
