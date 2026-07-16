# ADR-060 — Concorrência revisionada no status de webhooks

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`PUT /v1/webhooks/endpoints/{endpointId}/status` e `PUT /v1/webhooks/subscriptions/{subscriptionId}/status` usam `baseRevision` e transações serializáveis. Um conflito transitório do banco não deve fazer duas chamadas idênticas parecerem divergentes, mas pedidos de estados diferentes não podem ocultar uma disputa real.

## Decisão

- Cada repository repete conflitos serializáveis `P2034` no máximo três vezes.
- Após o retry, se o estado persistido já é o alvo pedido, o command converge como replay mesmo com a revisão anterior.
- Se o estado persistido difere do alvo e a revisão mudou, o command retorna o conflito de revisão específico do recurso.
- A suspensão ou revogação do endpoint e suas cascatas permanecem dentro de uma única transação.
- A transação vencedora contabiliza os efeitos; o replay idêntico não repete nem reconta cascatas.
- Resposta perdida pode ser recuperada repetindo o mesmo estado e a mesma revisão-base.

## Consequências

- Contenção transitória não vira falso conflito para requests semanticamente idênticos.
- Requests divergentes continuam usando compare-and-set e têm apenas um vencedor.
- Endpoint expõe `replayed` e totais de efeitos; subscription expõe convergência pelo mesmo recurso e revisão.
- Após três conflitos persistentes, o código público de revisão divergente existente é preservado.

## Evidências exigidas

- duas pausas de subscription simultâneas devolvem a mesma revisão;
- duas suspensões de endpoint simultâneas pausam cada subscription uma única vez;
- retomada com primeira resposta descartada converge sem nova transição;
- conflito `P2034` persistente é limitado a três tentativas;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
