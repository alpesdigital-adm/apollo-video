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
