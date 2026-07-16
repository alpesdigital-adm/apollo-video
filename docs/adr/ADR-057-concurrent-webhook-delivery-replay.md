# ADR-057 — Concorrência no replay de webhook delivery

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`POST /v1/webhooks/deliveries/{deliveryId}/replay` reabre uma delivery terminal e amplia em uma unidade o limite necessário para a próxima tentativa. Requests simultâneos ou retries após resposta perdida não podem ampliar esse limite mais de uma vez nem duplicar o histórico já realizado.

## Decisão

- Ledger e transição da delivery são gravados em transação serializável.
- Conflitos `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- Requests simultâneos com workspace, cliente, delivery e chave idênticos convergem para uma única reabertura.
- A transação vencedora devolve status 202 e `replayed=false`; a concorrente lê o ledger e devolve status 200, `replayed=true` e o mesmo diagnóstico.
- `maxAttempts` é ampliado uma única vez. Attempts anteriores permanecem imutáveis e não são recriados pelo replay.
- Se a primeira resposta for descartada, repetir a chave recupera o diagnóstico sem nova transição.
- Outra chave contra a delivery já reaberta é rejeitada por `WEBHOOK_DELIVERY_REPLAY_REJECTED`.

## Consequências

- Retry de transporte não consome capacidade adicional de tentativa.
- O limite absoluto de attempts permanece efetivo mesmo sob concorrência.
- O diagnóstico persistido permite replay estável sem recalcular estado histórico.
- Replay por evento continua um command separado, com lote e ledger próprios.

## Evidências exigidas

- duas chamadas simultâneas produzem um 202 e um 200 para o mesmo diagnóstico;
- `maxAttempts` cresce uma única vez e attempts existentes não mudam;
- resposta descartada converge sem nova ampliação;
- chave diferente contra estado reaberto mantém rejeição específica;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
