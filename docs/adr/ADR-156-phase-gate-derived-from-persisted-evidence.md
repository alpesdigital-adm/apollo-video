# ADR-156 — O gate da fase é derivado de linhas persistidas, e o hash tem três estados

- **Estado:** aceito
- **Data:** 2026-09-06
- **Contexto:** F4.016, Wave 20
- **Relacionado:** [ADR-123](ADR-123-closed-quality-loop-and-mvp-gate.md), [ADR-135](ADR-135-react-playback-and-multicam-gate.md), [ADR-141](ADR-141-mandatory-journeys-and-release-gate.md), `docs/specs/05-multicam-sync.md` §33

## Contexto

O repositório já tinha aprendido, caro, o que um gate não pode ser. Os módulos
`src/v2/application/mandatory-journeys.ts` e `release-risk-control.ts`,
removidos no commit `e8ba18e6`, geravam os ids `T-J.001…T-J.009` a partir de uma
fixture que construía toda etapa com `passed: true` e em seguida afirmava que
ela passara. Como o arquivo terminava em `.test.mjs`, aquilo rodava dentro do
`npm test` e do CI, e o ponteiro de evidência de `TODO.md:2433` ("T-J.007") era
satisfeito por um literal de string sobre uma fixture que não podia falhar.

Um gate cujo chamador fornece o veredito não é um gate. Um gate que lê o próprio
resultado de uma coluna que ninguém confere também não é.

## Decisão

**O gate multicâmera/long-form (`multicam-longform/v1`) é derivado no servidor a
partir de linhas do PostgreSQL e do grafo de módulos, e o chamador não fornece
nada além do escopo da pergunta.**

- **Dez critérios independentes**, cada um composto de checagens nomeadas — 38
  no total. Os ids dos critérios são frases
  (`insufficient-evidence-requires-manual`), não números de série: quem lê
  "AC-003: failed" tem de ir a uma tabela.
- **O conjunto de evidências é fechado.**
  `MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES` tem vinte e quatro tipos, cada um
  nomeando uma tabela que as migrações das Waves 18/19/20 criaram.
  "evidence-ref: o que o leitor quiser" é como um gate deixa de ser auditável.
- **Cinco motivos de falha**, porque a próxima ação do operador é diferente em
  cada um: `evidence-missing`, `evidence-unverified`, `evidence-not-measured`,
  `requirement-unmet`, `evidence-stale`.
- **A verificação de hash tem três estados, não dois.** Hash presente e
  conferido; hash presente e **não** conferido, que é adulteração e conta em
  `unverifiedReferenceCount`; e **hash ausente**, porque a tabela não guarda hash
  próprio (um artifact de mídia cujo sha256 exigiria download, uma linha filha
  coberta pelo hash do pai), que conta em `unhashedReferenceCount` e nunca na
  primeira. Confundir "não pude conferir" com "conferi e estava errado" tornava
  quatro dos dez critérios impossíveis de registrar como aprovados, porque a
  migração recusa uma linha aprovada que cite referência não verificada.
- **O critério 10 não lê banco.** "Sem runtime legado" é propriedade do código
  que produziu os outros nove, e `LEGACY_RUNTIME_MARKERS` fixa os cinco
  marcadores que contam para que o scanner não estreite em silêncio a própria
  definição. Módulos de entrada que o processo não conseguiu ler são reportados
  à parte das violações: uma árvore que não abriu não é uma árvore limpa.

## Consequências

**O que melhora.** O gate é falsificável por construção. Medido nesta máquina em
2026-09-06, contra um cluster PostgreSQL 16 descartável com todas as migrações
aplicadas do zero:

- um projeto vazio produz os mesmos 10 critérios e 38 checagens e satisfaz 1 de
  10;
- o mundo completo, lido pelo leitor real, satisfaz 10 de 10;
- **nove exclusões de uma linha cada derrubaram exatamente o seu próprio
  critério** — é isso que impede que dez critérios sejam um critério com dez
  nomes;
- pelas rotas `/v1` (`test:e2e:phase-gate-journey`), apagar a cabeça do plano de
  match leva a 9/10 por `evidence-missing`, adulterar a síntese leva a 9/10 por
  `evidence-unverified`, e restaurar volta a 10/10; **cinco corpos de requisição
  que carregavam um veredito foram recusados com 422 e zero linhas escritas.**

**O que piora.** Avaliar o gate custa uma varredura de banco e uma varredura do
grafo de módulos: 58 s a 75 s por execução nas medições acima. Não é uma
consulta de painel, e é por isso que o resultado é persistido como registro
imutável e a tela lê o último em vez de reavaliar.

**O que fica em aberto.** Um gate aprovado não é implantação nem aceite. As dez
condições estarem satisfeitas em PostgreSQL diz que o produto faz o que ADR-135
pediu; não diz que alguém rodou isso em produção. Nenhuma caixa de F4.012 a
F4.016 no `TODO.md` está marcada.
