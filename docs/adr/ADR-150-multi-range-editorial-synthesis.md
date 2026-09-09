# ADR-150 — Síntese editorial multi-range

## Estado

Implementado localmente em 2026-09-03 (Wave 18, F4.001 / FR-135). Integração em
`main`, E2E PostgreSQL no CI, deploy e aceite do proprietário permanecem
pendentes.

## Contexto

A extração contígua (FR-134) seleciona uma janela autocontida e se defende
declarando `synthesizedRanges: false`: o que a pessoa disse dentro daquela
janela, ela disse naquela ordem, sem interrupção. Nada foi montado, portanto
nada pôde ser mal montado.

O multi-range abre mão dessa defesa. Ele pega várias janelas de um master de
duas horas e as junta em dois minutos, e **cada emenda é uma afirmação que a
fonte nunca fez** — a de que estas palavras pertencem ao lado daquelas.

Três falhas passam a ser possíveis, e nenhuma delas o range único consegue
produzir:

1. **Uma afirmação pode ser separada da sua ressalva.** A janela A carrega "os
   nossos clientes cresceram quarenta por cento"; o "no melhor trimestre deles"
   ficou em material que ninguém selecionou. O corte é limpo, o áudio é
   contínuo, e o resultado é uma frase que a pessoa não disse. Um seletor
   escolhendo por relevância temática não tem motivo para manter as duas metades
   juntas — a ressalva costuma ser a metade *menos* citável.
2. **A cronologia pode ser invertida.** "Tentamos X, aí Y falhou" e "Y falhou,
   aí tentamos X" são o mesmo material e afirmações opostas sobre causa.
3. **Ranges podem se sobrepor.** A mesma frase duas vezes não é edição, é
   gagueira, e depois de compilada para números de quadro fica quase invisível
   num plano.

## Decisão

Cada uma das três vira invariante, não aviso.

**`assertClaimContextPreserved` recusa a montagem** quando uma claim incluída
perde qualquer um dos seus qualifiers ou proof contexts. O StoryPlan é lido do
repositório, nunca aceito do pedido: quem enviasse as duas metades estaria
corrigindo a própria prova. E o registro do que foi checado é guardado **haja ou
não achado** — uma prova que só existe quando falha não se distingue, depois, de
um ramo que nunca rodou.

**A ordem da fonte é preservada** a menos que o reordenamento seja declarado com
um motivo defensável, que fica gravado. Puxar o fecho para abrir o corte é
ofício comum; fazê-lo sem registro é que não é.

**Sobreposição é recusada na construção**, e também por `EXCLUDE USING gist`
sobre `int4range` no PostgreSQL, de modo que nem um backfill consegue
contorná-la.

**Se uma emenda é splice ou contiguidade é medido, não declarado.** Rotular um
splice como "contíguo" afirma que a pessoa disse aquelas palavras em sequência,
e só a fonte decide isso. Splices carregam justificativa; junções contíguas não
precisam de nenhuma, porque a fonte já as fez.

**Direitos e consentimento são reconferidos na montagem**, não herdados da
seleção: uma janela pode ser escolhida enquanto aprovada e montada depois de uma
revogação.

**A conversão para quadros é aritmética racional exata e ancorada na fonte**, de
modo que um clipe nunca reivindica um quadro que o seu range não contém. As duas
leituras divergem de verdade — de 1034 ms a 1068 ms há dois quadros de fonte,
enquanto os mesmos 34 ms medidos do zero dão um — e a leitura ancorada na fonte
é a que corresponde ao que está no cartão.

## Consequências

O plano resultante declara `synthesizedRanges: true`: a contraparte honesta do
`false` do caminho contíguo. Quem lê um plano sabe, sem inferir, se está diante
de material preservado ou montado.

O custo é que montagens legítimas ficam mais verbosas — toda emenda precisa de
uma frase, e todo reordenamento de um motivo. Esse é o ponto: essas frases são a
trilha de auditoria de afirmações que o sistema fez em nome de alguém, e é a
única coisa que torna o corte revisável meses depois.

Fica em aberto: gerar bridge de narração para emendas que não se sustentam
sozinhas continua fora de escopo, e o critério para "se sustenta" ainda não foi
calibrado contra material real.
