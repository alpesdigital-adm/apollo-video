# ADR-157 — Crítico de cor: a ação vem de uma tabela de causa, e a intenção declarada tem teto

- **Estado:** aceito
- **Data:** 2026-09-06
- **Contexto:** F4.014 (FR-184), Wave 20
- **Relacionado:** [ADR-111](ADR-111-decision-specific-confidence.md), [ADR-127](ADR-127-color-and-export-matrix.md), [ADR-147](ADR-147-synthetic-critic-evidence.md), `docs/specs/05-multicam-sync.md` §31

## Contexto

FR-184 pede um crítico que detecte clipping, cast, pele fora do alvo e
desencontro localizado, avalie antes e depois do output transform sem confundir
intenção criativa com defeito, e proponha correção limitada ou revisão humana
conforme a confiança.

Três armadilhas estavam no caminho, e duas delas o repositório já tinha caído
antes:

1. **Aprovar por ausência.** Um crítico que só reporta o que mediu aprova tudo
   o que não conseguiu medir. Uma dimensão ilegível vira silêncio, e silêncio
   vira `approve`.
2. **O chamador movendo a própria linha de aprovação.** Se uma "intenção
   criativa declarada" pode desculpar qualquer cast, basta declarar uma
   tolerância grande o bastante para que todo cast vire `documented-intent`. O
   chamador passa a escrever o veredito.
3. **Uma ação calculada como média dos números.** Um relatório em que "clipping
   grave" e "pele não medida" se compensam produz `bounded-correction` sobre uma
   imagem que ninguém deveria corrigir automaticamente.

## Decisão

**A ação nunca é calculada; ela é lida numa tabela de causa.**
`COLOR_CRITIC_CAUSE_ACTIONS` mapeia as dez causas para as quatro ações
(`approve`, `bounded-correction`, `human-review`, `reject`), e
`COLOR_CRITIC_CAUSE_PRECEDENCE` é a ordem em que as causas são consideradas — a
primeira que se aplica decide.

A ordem começa em `irreversible-technical-defect` e só depois passa por
`evidence-unavailable`: **um defeito duro medido supera uma dimensão que
ninguém conseguiu ler.** Saber que um quadro está ceifado não fica menos certo
porque uma segunda pergunta ficou sem resposta. Tudo abaixo de um defeito duro
medido cai para um humano.

**A ausência de leitura é falha, não aprovação.**
`COLOR_CRITIC_REQUIRED_DIMENSIONS` são as cinco sem as quais nada se sabe sobre
os bytes (`clipping`, `crushedBlacks`, `cast`, `hdrSdrInconsistency`,
`matchRegression`); `COLOR_CRITIC_BETWEEN_CAMERA_DIMENSIONS` são
`not-applicable` com uma câmera e **obrigatórias** com duas ou mais — uma
comparação ilegível num sujeito multicâmera é evidência faltando, não defeito
ausente, e é a mesma lacuna que o plano de match já recusa com
`COLOR_RANGES_NOT_COMPARABLE`.

**A intenção declarada limita um deslocamento de cor, nunca uma amostra
destruída.** `COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS` — clipping, blacks
esmagados, pele fora da banda, deriva de cor de marca, inconsistência HDR/SDR —
não são desfeitas por ganho nenhum do estágio `match`, e portanto nenhuma
declaração as desculpa. E o que a declaração **pode** desculpar tem teto:
`maxDeclaredCastAllowance = 0,25`, o dobro do limiar `hard` de `cast` e igual a
`maxProposedGain - 1`. Um look que precise de mais do que isso é uma graduação,
e um humano assina.

**Correção automática exige a banda `high`.**
`COLOR_CRITIC_BOUNDED_CORRECTION_MINIMUM_CONFIDENCE = 0,85`, e
`COLOR_CRITIC_MAX_CORRECTION_ITERATIONS = 2`; esgotado o orçamento, a causa é
`correction-budget-exhausted` e a ação é `human-review`.

**O crítico diz o que é.** `COLOR_CRITIC_EVALUATOR` é
`{ id: 'apollo-color-critic', kind: 'controlled' }`: ele não lê pixels, compara
agregados de medição contra limiares versionados
(`color-critic-thresholds/v1`), e o relatório carrega esse escopo em vez de
deixar o leitor supor um julgamento perceptual que não está implantado.

## Consequências

**O que melhora.** Medido nesta máquina em 2026-09-06
(`tests/v2/color-visual-evaluations.integration.mjs`, 7 casos):

- clipping de `highlights = 0,5` sai `reject`/`irreversible-technical-defect`
  **mesmo declarado como estética**, enquanto o controle da mesma suíte (valor 0)
  sai `human-review`/`correction-not-derivable` — o positivo e o negativo lado a
  lado, para que a recusa não seja um ramo que sempre dispara;
- um cast medido de 0,201998 é preservado quando declarado (classificação
  `documented-intent`, zero questões de cast) e continua sendo defeito quando
  não declarado; a rejeição que sobra no caso declarado é `skinToneOffTarget`,
  que a declaração não cobre;
- um desencontro confinado a um segundo é reportado como o intervalo
  `[1000, 2000)` da câmera `cam-b`, e não como um defeito global.

**O que piora.** Dois limiares por dimensão e dez causas são mais superfície de
calibração do que um número único. A mitigação é que os limiares são
`DEFAULT_COLOR_CRITIC_THRESHOLDS.calibrationVersion`: mudar um número muda a
versão, e um relatório antigo diz sob qual calibração foi escrito.

**O que fica em aberto.** Os limiares nunca foram calibrados contra material
real — todos os números vieram de fixtures geradas com `lavfi`. E o crítico
continua sendo `controlled`: nenhum avaliador perceptual está implantado, e o
relatório diz isso de si mesmo em vez de deixar a ausência passar por
aprovação.
