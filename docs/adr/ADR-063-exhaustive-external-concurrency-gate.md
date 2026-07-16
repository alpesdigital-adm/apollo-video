# ADR-063 — Gate exaustivo de concorrência externa

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Testes incrementais cobriam commands externos individualmente, mas o registry podia receber uma nova capability não-query sem uma decisão explícita sobre simultaneidade, resposta perdida ou ausência de commit. Uma lista textual no TODO não oferece proteção automática contra essa deriva.

## Decisão

- Toda capability externa cujo `operationKind` não seja `query` deve constar na matriz testada de concorrência.
- Cada entrada é classificada como `durable-covered`, `read-only-deterministic` ou `pending-concurrency`.
- Entradas duráveis citam a slice que comprova requests simultâneos e recuperação após perda de resposta.
- Preflights somente podem usar a classificação sem commit quando `operationKind=preflight`.
- O teste compara exatamente os IDs da matriz com `FOUNDATION_CAPABILITIES`.
- A suíte também fixa a pendência atual em um único item: `apollo.webhooks.endpoints.challenge`.

## Consequências

- Nova capability não-query quebra a regressão até receber classificação explícita.
- Remoção ou renomeação de capability também exige atualização consciente da matriz.
- O progresso da cobertura deixa de depender de memória ou inspeção manual.
- A microtarefa permanece aberta até que não exista entrada `pending-concurrency`.

## Evidências exigidas

- os 23 IDs externos não-query coincidem exatamente com a matriz;
- 20 commands duráveis possuem evidência de cobertura;
- 2 preflights determinísticos não possuem commit;
- somente o challenge de webhook permanece pendente;
- typecheck e regressão completa permanecem verdes.
