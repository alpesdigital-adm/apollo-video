# ADR-130 — Session clock and synchronization evidence

## Estado

Implementado localmente em 2026-09-03 (Wave 18, F4.002–F4.008). Integração em
`main`, E2E PostgreSQL no CI, deploy e aceite do proprietário permanecem
pendentes.

## Contexto

Uma sessão multicâmera tem tantos relógios quanto gravadores, e nenhum deles é
neutro. Editar exige exatamente uma linha do tempo contra a qual todas as fontes
sejam medidas. O caminho fácil — usar o MP4 normalizado que já foi transcodado,
que é CFR e começa em zero — falha por um motivo que só aparece meses depois:
esse arquivo é um *artefato derivado*. Recodifique-o com outra configuração e
cada timestamp da sessão se move, sem que nada a jusante consiga perceber.

O segundo problema é aritmético. Ticks de nanossegundo passam de 2^53 em catorze
semanas, e um `double` representa todo inteiro apenas até ali; depois disso dois
instantes distintos passam a comparar iguais, silenciosamente. E 30000/1001 não
tem forma decimal alguma: um cliente que recebe 29,97 nunca recupera a taxa que
lhe foi enviada.

O terceiro é editorial. Quando a evidência não basta, toda resposta plausível é
pior que admitir que não há nenhuma: zero diz que as gravações se alinham e um
editor corta em cima disso; um palpite de baixa confiança é arredondado para
"provavelmente ok" pelo próximo sistema que o lê; e uma falha dura joga fora o
material perfeitamente bom da faixa de referência.

## Decisão

**O relógio da sessão nunca é um arquivo de mídia.** É um `Timebase` declarado
mais um motivo declarado para tê-lo escolhido, e uma referência a rendition
normalizada é recusada na construção — tanto para o relógio da sessão quanto
para o relógio de uma fonte.

**Ticks são inteiros, guardados em `bigint`; taxas são racionais, nunca
decimais.** Intervalos são semiabertos `[start, end)`, de modo que intervalos
adjacentes ladrilham a linha do tempo sem buraco e sem sobreposição. Toda
conversão arredonda exatamente uma vez, half-to-even — half-up empurraria todo
empate na mesma direção, e uma sessão de duas horas acumularia um deslocamento
sistemático indistinguível de drift, que alguém então "corrigiria" esticando
áudio real.

**Um map é sempre source → session, nunca source → source.** Encadear A→B→C
compõe o arredondamento de dois maps e, pior, promove B silenciosamente a uma
autoridade que ninguém auditou. Quando alguém genuinamente precisa de "onde
está este instante da câmera A na câmera B", a resposta passa pela sessão duas
vezes e *reporta o bound acumulado*, deliberadamente sem devolver um
`AffineClockMap` — para que a resposta não possa ser persistida como um map
source → source.

**Drift é o que sobra depois de dividir fora a razão de timebase.** Uma fonte a
90 kHz num relógio de 1 MHz tem taxa composta perto de 11,1; reportar isso em
ppm anunciaria dez milhões de ppm de "deriva" num gravador perfeitamente
sincronizado.

**`insufficient-evidence` é uma resposta de primeira classe.** A cascata emite
`null` em vez de offset, e a coluna é anulável no banco: "não conseguimos
dizer" e "medimos zero" são respostas diferentes, e uma coluna não-nula seria
incapaz de mantê-las diferentes. Uma run que termina assim **tem sucesso** — a
pergunta foi respondida.

**Um mapping que afirma alinhamento precisa nomear a evidência.** Offset ou
drift diferentes da identidade exigem anchors e evidence refs, no domínio e
também em `CHECK` no PostgreSQL. Um mapping que não afirma nada — a faixa de
referência contra si mesma — é verdadeiro por definição e dispensa anchor. Sem
essa regra, um offset de 45.000 ticks sem procedência é uma linha perfeitamente
válida.

**Maps são piecewise, e nada é resolvido entre peças.** O intervalo entre um
gravador parar e voltar não é uma peça curta com taxa interpolada: é tempo em
que aquela fonte não tem nada a dizer. Duas peças nunca se sobrepõem — duas leis
sobre o mesmo tick fariam a conversão depender de qual foi consultada, e ambas
as respostas seriam defensáveis —, e a recusa é feita com uma constraint
`EXCLUDE USING gist` além do domínio.

**Uma sessão é uma cadeia imutável mais um ponteiro mutável.** Cada operação
devolve versão + 1 carregando o hash da versão que substituiu. Um comando
calculado contra a versão 4 é recusado assim que a 5 existe, e a recusa nomeia a
versão atual: quem perdeu a corrida precisa saber para quê.

**Trocar a faixa de referência exige aprovação humana.** Ela reancora todas as
outras faixas e invalida todos os maps, coberturas e diagnósticos de uma vez;
não é decisão para um agente tomar sozinho.

## Consequências

Precisão vira algo medido e não estimado: cada mapping carrega um bound de
residual classificado contra a grade de quadros, e "sub-frame" significa metade
de um quadro, porque só se pode situar um instante dentro de um quadro quando o
erro é menor que a distância até o vizinho.

O custo é volume: `bigint` em vez de `number`, pares num/den em vez de decimais,
strings decimais na fronteira pública em vez de números JSON, e um módulo de
contrato que é o único lugar que converte. Em troca, nenhuma dessas
representações perde precisão sem levantar erro.

Fica em aberto para calibração: a biblioteca de fingerprint, os thresholds por
fps e duração, e o tratamento de drift no áudio final sem alterar pitch.
