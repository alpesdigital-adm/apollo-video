# ADR-059 — Concorrência natural no cancelamento e retry de operações

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`POST /v1/operations/{operationId}/cancel` e `POST /v1/operations/{operationId}/retry` são commands de idempotência natural. Requests simultâneos ou repetidos após uma resposta perdida não podem aplicar duas transições, ampliar duas vezes o limite de tentativas nem permitir que uma lease antiga publique resultado.

## Decisão

- Os commands não criam ledger por `Idempotency-Key`; a identidade estável da operação e seu estado persistido determinam o efeito.
- Cada mutação usa compare-and-set sobre o estado atual e relê o registro persistido quando perde a disputa.
- Cancelamentos simultâneos convergem para uma única transição terminal `canceled`, que invalida a lease existente.
- Retries simultâneos de uma operação terminal convergem para um único estado `queued` ou `retrying`.
- Se a operação esgotou o limite, `maxAttempts` é ampliado uma única vez pela transação vencedora.
- Repetir o command após perder a resposta devolve o estado atual sem reaplicar a transição.
- Retry de operação `succeeded` continua rejeitado por `PUBLIC_OPERATION_RETRY_REJECTED`.

## Consequências

- O efeito administrativo permanece único sem exigir que o cliente invente uma chave para uma operação já identificada.
- A resposta recuperada pode refletir progresso posterior do worker; idempotência natural não preserva um snapshot histórico da primeira resposta.
- Claim, heartbeat e fencing existentes continuam impedindo publicação por uma tentativa cancelada.
- Commands externos que criam recursos ou possuem payload variável continuam exigindo ledger idempotente próprio.

## Evidências exigidas

- dois cancelamentos simultâneos devolvem o mesmo estado terminal;
- dois retries simultâneos devolvem a mesma reabertura;
- resposta descartada é recuperada sem nova transição;
- retry concorrente de dead-letter amplia `maxAttempts` somente uma vez;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
