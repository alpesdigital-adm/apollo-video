# ADR-058 — Concorrência no replay de webhook por evento

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`POST /v1/webhooks/events/{eventId}/replay` cria um snapshot do lote de deliveries elegíveis, incluindo itens reagendados e ignorados. Requests simultâneos ou retries após resposta perdida não podem reavaliar o evento, reagendar uma delivery mais de uma vez nem devolver lotes divergentes.

## Decisão

- Ledger, seleção do lote e transições das deliveries são gravados em transação serializável.
- Conflitos `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- Requests com workspace, cliente, evento e chave idênticos convergem para o mesmo snapshot persistido.
- A transação vencedora devolve status 202 e `replayed=false`; a concorrente lê o ledger e devolve status 200, `replayed=true` e os mesmos itens.
- Cada delivery elegível é reaberta uma única vez. Itens ignorados também permanecem estáveis no snapshot.
- Se a primeira resposta for descartada, repetir a chave recupera o lote persistido sem nova avaliação ou transição.
- Outra chave contra um evento sem deliveries terminais elegíveis é rejeitada por `WEBHOOK_EVENT_REPLAY_REJECTED`.

## Consequências

- Retries de transporte não consomem novas tentativas nem duplicam reagendamentos.
- O snapshot continua estável mesmo que o estado externo mude depois do commit.
- O lote permanece limitado a 100 deliveries por request.
- Replay por intervalo continua um command separado, reservado para uma operação durável futura.

## Evidências exigidas

- duas chamadas simultâneas produzem um 202 e um 200 para o mesmo conjunto de itens;
- cada delivery elegível é reagendada uma única vez;
- resposta descartada converge sem reavaliação ou novo agendamento;
- chave diferente sem estado terminal elegível mantém a rejeição específica;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
