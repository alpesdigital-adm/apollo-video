# ADR-053 — Concorrência na criação de subscriptions de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

`POST /v1/webhooks/subscriptions` grava uma subscription filtrada e seu ledger idempotente. O filtro é parte do comportamento contratado de entrega; requests concorrentes não podem criar subscriptions duplicadas nem associar resultados diferentes à mesma chave.

## Decisão

- A criação permanece em transação serializável e conflitos `P2034` são repetidos no máximo três vezes antes de `PERSISTENCE_CONFLICT`.
- Requests simultâneos com workspace, cliente, chave, endpoint e filtro canônico idênticos convergem para a mesma subscription.
- Exatamente uma resposta representa criação 201; a concorrente recupera o resultado durável como replay 200.
- Se a primeira resposta for descartada depois do commit, repetir o request recupera a subscription sem nova linha.
- Endpoint e hash canônico do filtro integram o fingerprint. Filtros divergentes sob a mesma chave admitem um vencedor e retornam `IDEMPOTENCY_PAYLOAD_MISMATCH` para o request perdedor.
- A unicidade do filtro por endpoint independe do ledger: recriar o mesmo filtro com outra chave retorna `WEBHOOK_SUBSCRIPTION_ALREADY_EXISTS`.

## Consequências

- Ordem diferente dos mesmos event types e resource IDs converge pela canonicalização existente.
- Agentes externos podem repetir uma criação com resposta desconhecida sem duplicar entregas futuras.
- Retry limitado absorve contenção transitória sem esconder conflito persistente.
- Lifecycle posterior continua protegido por revisão opaca e compare-and-set próprios.

## Evidências exigidas

- duas criações idênticas simultâneas retornam 201 e 200 para a mesma subscription;
- resposta inicial descartada converge sem duplicação;
- filtros divergentes simultâneos retornam um sucesso e um mismatch;
- filtro duplicado com outra chave mantém conflito específico;
- a jornada passa repetidamente no SQLite e a CI hospedada confirma os invariantes no PostgreSQL.
