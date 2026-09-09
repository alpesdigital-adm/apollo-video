# ADR-151 — A marcador só é identificado pelo código visual

- **Estado:** aceito
- **Data:** 2026-09-04
- **Contexto:** F4.010 (FR-148), Wave 19
- **Relacionado:** [ADR-150](ADR-150-multi-range-editorial-synthesis.md), `docs/specs/05-multicam-sync.md` §28

## Contexto

O marcador Apollo tem dois canais por desenho: um padrão de flashes e um chirp
de áudio. A ideia é que dois canais independentes se confirmem — se ambos
apontam para o mesmo instante, a leitura é medição e não palpite.

Uma fixture adversarial mostrou que essa leitura estava errada em um ponto
específico. Uma sessão pode ter vários marcadores (`start`, `end`,
`after-restart`). Procurar o marcador de reinício **no primeiro arquivo**, que
nunca o conteve, devolvia `confirmed`:

- o padrão de flashes bateu, porque **todo marcador da sessão alterna do mesmo
  jeito**;
- o chirp correlacionou, porque **todo marcador da sessão varre a mesma
  rampa**;
- os dois canais concordaram sobre o instante — do marcador errado.

O código visual era o único campo que diferia, e naquela resolução ele estava
ilegível.

## Decisão

**Concordância entre canais corrobora o *instante*, nunca a *identidade*.**

A fusão recusa com `identity-unverified` quando nenhum canal decodificou o
código, nos dois modos (`both-channels` e `either-channel`). O detector visual
também deixou de reportar confiança alta para um código ilegível: um padrão
perfeito cujo código não foi lido vale no máximo 0,6, abaixo do piso de
confirmação.

O caminho `either-channel` já recusava esse caso; `both-channels` não, porque um
chirp corroborando *parecia* corroboração.

## Consequências

**O que melhora.** Um marcador procurado no arquivo errado é recusado com o
motivo nomeado, em vez de produzir um deslocamento confiante e errado. Todo
corte derivado dele herdaria a mentira.

**O que piora.** Uma gravação em que o código nunca é legível — câmera longe,
compressão pesada, marcador fora de escala — perde a capacidade
`marker-correlation` inteira, mesmo com flash e chirp perfeitos. Ela continua
*cronometrável* (o instante é medido), mas não *confirmável*, e cai para
âncoras manuais.

Isso é honesto e é caro. A alternativa seria confirmar com identidade não
verificada, que é o defeito que esta decisão existe para impedir.

**O que fica em aberto.** O canal de áudio *poderia* carregar identidade — a
direção da varredura, um segundo tom associado à sequência, uma modulação. Não
carrega hoje: `DEFAULT_MARKER_AUDIO` é fixo, e dois marcadores da mesma sessão
têm chirps idênticos. Enquanto for assim, o código visual é o único portador de
identidade e o teto de robustez do marcador é o teto de legibilidade dele.

Um marcador cujo áudio codificasse a sequência sobreviveria a exatamente os
casos que hoje caem para manual. Isso é trabalho de uma wave futura, não desta.

## Limite declarado do canal visual

O código é lido recortando um quadrado de `codeSizePx` **do centro do quadro, no
tamanho de pixel que o marcador declarou**. O marcador precisa chegar ao
gravador em escala nativa — reproduzido em tela cheia ou composto. Filmado a
1,5×, o flash continua inconfundível e o código some.

Isso está afirmado em `MarkerVisualSpec` e coberto por
`T-FR-148 a marker filmed at the wrong apparent size is refused, not guessed at`,
porque um limite que ninguém escreveu é descoberto depois por quem confiou na
funcionalidade.
