# ADR-052 — Concorrência no cadastro de endpoint de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

`POST /v1/webhooks/endpoints` grava endpoint, metadados do signing secret, payload cifrado e ledger idempotente na mesma transação. Requests simultâneos ou retries após resposta perdida não podem criar endpoints duplicados, órfãos criptográficos ou resultados ambíguos.

## Decisão

- A transação permanece serializável e conflitos `P2034` são repetidos no máximo três vezes antes de `PERSISTENCE_CONFLICT`.
- Requests simultâneos com workspace, cliente, chave e URL canônica idênticos convergem para o mesmo endpoint e secret.
- Exatamente uma resposta é criação 201; a concorrente recupera o resultado durável como replay 200.
- Se a primeira resposta for descartada depois do commit, repetir o request recupera o endpoint original sem criar outro payload cifrado.
- A URL canônica integra o fingerprint. URLs divergentes sob a mesma chave admitem um vencedor e retornam `IDEMPOTENCY_PAYLOAD_MISMATCH` para o request perdedor.
- A unicidade da URL continua independente do ledger: tentar cadastrar a mesma URL com outra chave retorna `WEBHOOK_ENDPOINT_ALREADY_EXISTS`.

## Consequências

- Agentes externos podem repetir cadastros cujo resultado de transporte seja incerto.
- Endpoint, signing secret e envelope cifrado permanecem uma unidade atômica.
- Retry limitado absorve conflitos transitórios sem ocultar contenção persistente.
- A chave HMAC não é exposta pelo cadastro; sua transferência one-shot continua no command de provisionamento.

## Evidências exigidas

- dois cadastros idênticos simultâneos retornam 201 e 200 para o mesmo endpoint;
- resposta inicial descartada converge sem duplicação;
- URLs divergentes simultâneas retornam um sucesso e um mismatch;
- cada endpoint vencedor possui exatamente um signing secret e um payload cifrado;
- a jornada passa repetidamente no SQLite e a CI hospedada confirma os invariantes no PostgreSQL.
