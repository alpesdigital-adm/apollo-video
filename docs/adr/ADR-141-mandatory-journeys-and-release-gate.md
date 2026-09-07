# ADR-141 — Mandatory journeys and release gate

Nine end-to-end journeys are named, stage-complete, policy-safe and reconstructable. Each produces a QualityReport and manifest. The external-agent journey additionally proves least-scope discovery, upload, operations/webhooks, versioned Command/preflight, API-only render/export/lineage and UI parity.

Release requires fourteen independent evidence artifacts and zero critical findings. Canonical domain terms are enforced by CI, while glossary, API guide, workflow concepts and schema/state documentation evolve with source contracts.

## Estado em 2026-09-06 — nada enforce as nove jornadas

Este ADR descreve a decisão; ele não descreve o estado do repositório.

O único módulo que dizia executar esta decisão era
`src/v2/application/mandatory-journeys.ts`, removido no commit `e8ba18e6` da
Wave 20. Ele gerava os ids `T-J.001` a `T-J.009` a partir de
`completeJourneyFixture`, que construía toda etapa com `passed: true` e em
seguida afirmava que ela havia passado — o antipadrão que o `AGENTS.md` L126
nomeia, um teste que reproduz a própria implementação. Como o arquivo terminava
em `.test.mjs`, ele rodava dentro do `npm test` e do CI, e por isso os quatro
ponteiros de evidência de `TODO.md` §J.007 ("Evidência: T-J.007" —
`TODO.md:2430-2433` antes do commit `a4f12a2f`, hoje substituídos pela nota que
começa em `TODO.md:2430`) eram satisfeitos por um literal de string sobre uma
fixture que não podia falhar.
`src/v2/application/release-risk-control.ts`, terceiro vocabulário paralelo de
"phase gate", foi removido no mesmo commit.

Hoje não existe módulo algum que avalie as nove jornadas obrigatórias nem os
catorze artefatos de evidência de release. Os gates que existem são por fase e
por projeto: `src/v2/domain/mvp-core-gate.ts` e
`src/v2/domain/multicam-longform-gate.ts` (ver
[ADR-156](ADR-156-phase-gate-derived-from-persisted-evidence.md)). Nenhum dos
dois cobre o que este ADR pede.

A decisão continua vigente; a implementação dela está por fazer, e dizer isso
aqui é mais barato do que outro leitor descobrir sozinho que o gate de release
era uma fixture.
