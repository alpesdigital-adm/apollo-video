# ADR-152 — O react PlaybackMap é um agregado próprio, não um PiecewiseClockMap

- **Estado:** aceito
- **Data:** 2026-09-06
- **Contexto:** F4.015, Wave 20
- **Relacionado:** [ADR-130](ADR-130-session-clock-and-sync-evidence.md), [ADR-135](ADR-135-react-playback-and-multicam-gate.md), `docs/specs/05-multicam-sync.md` §16 e §32

## Contexto

A Wave 18 entregou `PiecewiseClockMap` como o modelo de tempo de uma sessão de
captura: peças contíguas de ticks de origem, cada uma descrita por uma lei
afim, mapeando **origem → sessão**. É a autoridade, e reusá-la para o react era
a resposta óbvia — um react também é um mapa piecewise entre duas gravações.

A tentativa não passa da construção, e por dois motivos que são propriedades do
material, não limitações do código:

- **Uma pausa não tem lei afim.** `createAffineClockMap` recusa taxa ≤ 0
  (`session-time.ts:263-278`), corretamente: taxa zero significaria que a origem
  não avança, e um mapa que devolve o mesmo instante para um intervalo inteiro
  não é uma função de tempo. Mas uma pausa é exatamente isso — um trecho da
  reação durante o qual a referência não produz tempo nenhum. Não existe range
  de referência para aquele trecho, e inventar um (o instante congelado repetido)
  seria afirmar uma medição que ninguém fez.
- **Um replay é sobreposição na origem.** `createPiecewiseClockMap` recusa
  cobertura de **origem** sobreposta (`piecewise-clock-map.ts:213-223`), também
  corretamente: duas peças reivindicando o mesmo tick de origem tornam a
  resolução ambígua. Só que um replay toca os mesmos ticks da referência duas
  vezes. Num mapa referência → sessão as duas peças reivindicariam o mesmo
  intervalo de origem e o construtor recusaria o par — de novo, com razão.

As duas recusas são certas e não devem ser afrouxadas. Afrouxar a primeira
permitiria taxa zero em qualquer mapa de sessão; afrouxar a segunda permitiria
que duas peças de uma câmera reivindicassem o mesmo material.

## Decisão

**O react PlaybackMap é um agregado próprio (`react-playback-map/v1`), e a sua
direção é reação → referência.**

Inverter a direção torna as duas coisas expressáveis sem enfraquecer nada:
intervalos da **reação** nunca se sobrepõem, porque o reactor viveu cada
instante uma vez só; intervalos da **referência** podem repetir, correr para
trás ou faltar, e é exatamente isso que um replay, um rewind e uma pausa são.

Uma peça sem `referenceRange` é a forma que uma pausa tem: os dois modos de
`NO_REFERENCE_PLAYBACK_MODES` (`paused`, `commentary-only`) não recebem range de
referência nenhum, em vez de receberem um range degenerado.

O que **não** é reinventado, e é importado da autoridade: `TickInterval`,
`Rational` e o arredondamento único de `convertTick` (`session-time.ts`); o
vocabulário de fronteira `PIECE_BOUNDARY_CAUSES`, que entra por spread em
`PLAYBACK_DISCONTINUITY_REASONS` e recebe apenas os três acréscimos que só
acontecem a um *player* (`pause`, `commentary`, `manual-anchor`); a forma de
`PiecewiseResolution`, que devolve "nenhum número" em vez de zero; o formato de
`DiagnosticAnchor` e `ANCHOR_ORIGINS` da Wave 19; e os limiares de admissão de
`DEFAULT_SYNC_EVIDENCE_THRESHOLDS`.

A duração da reação nunca implica a da referência (ADR-135). A duração da
referência chega medida, em `PlaybackReferenceMedia.durationTicks`, ao lado do
`sha256` dos bytes que a produziram: bytes diferentes são outro mapa.

## Consequências

**O que melhora.** Uma sessão de react com pausa, comentário, replay e seek é
construtível — e uma sessão sem nenhum desses continua sendo o caso trivial de
uma peça só. Um trecho que a evidência não resolve vira `uncovered` com motivo
(`manual-anchor-required`, `conflicting-evidence`) e o mapa fica `needs-input`,
em vez de um `resolved` com um buraco silencioso. Um mapa em que nenhuma peça
achou a referência é `failed`, e não um mapa vazio.

**O que piora.** Existem agora dois modelos de tempo no repositório, e um leitor
precisa saber qual está lendo. A mitigação é que eles não competem: o
`PiecewiseClockMap` continua sendo o único mapa **da sessão**, e o PlaybackMap
não mapeia faixas de uma sessão entre si — ele mapeia uma reação contra uma
mídia de referência que nem sequer é faixa da sessão. Nenhum consumidor precisa
escolher entre os dois.

**O que fica em aberto.** `rate` numa peça vem da correlação daquela peça, e não
de um ajuste de drift da sessão: `fitClockDrift` continua sem escritor
(spec 05 §34.3). Uma peça cuja taxa não foi medida diz `rate: null` e o mapa
carrega o aviso `rate-unmeasured`.
