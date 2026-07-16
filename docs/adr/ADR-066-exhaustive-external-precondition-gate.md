# ADR-066 — Gate exaustivo de precondições externas

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Nem toda operação concorrente deve receber ETag. Criações usam idempotência;
ações como cancel, retry e replay obedecem uma state machine; challenge usa
single-flight; apenas substituições de estado precisam provar a versão lida.
Aplicar uma regra única criaria parâmetros sem significado e não impediria que
uma capability futura fosse publicada sem decisão consciente.

## Decisão

- Toda capability externa não-query deve constar numa matriz testada e citar sua
  evidência.
- `explicit-precondition` cobre substituições de estado e exige `If-Match` ou
  `baseRevision`. Todo endpoint `PUT` ou `PATCH` deve usar esta categoria.
- `revision-bound-action` cobre ações cujo efeito depende da revisão do resource
  e exige `baseRevision` no schema público.
- `idempotent-create` exige idempotência durável, sem inventar uma versão anterior
  para um resource ainda inexistente.
- `state-machine-action` usa transições atômicas, estados terminais e replay
  convergente conforme a evidência de concorrência.
- `single-flight-action` coordena o único efeito externo por lease durável.
- `read-only-preflight` não faz commit e permanece determinístico.
- O teste compara a matriz exatamente com o registry e fixa as contagens atuais.

## Consequências

- Uma nova operação externa quebra a regressão até receber estratégia explícita.
- Novo `PUT`/`PATCH` sem revisão também quebra, ainda que tenha sido classificado
  incorretamente como action.
- Commands futuros de ProjectVersion deverão declarar `baseVersionId` quando
  entrarem no registry.
- A microtarefa de precondições pode ser fechada sem confundi-la com auto-rebase.

## Evidências exigidas

- correspondência exata com as 23 operações externas não-query;
- schemas públicos das sete operações revisionadas exigem a precondição correta;
- contagens: 3 explicit, 4 revision-bound, 7 creates, 6 state-machine, 1
  single-flight e 2 preflights;
- regressão completa verde.
