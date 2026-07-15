# ADR-050 — Concorrência e token one-shot na criação de clientes de API

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

`POST /v1/workspaces/{workspaceId}/clients` cria um cliente e sua primeira credencial, mas o bearer token correspondente só pode ser mostrado uma vez. Requests simultâneos ou retries após resposta perdida não podem criar identidades duplicadas nem divulgar tokens diferentes para a mesma chave idempotente.

## Decisão

- Cliente, credencial e ledger são gravados em uma transação serializável.
- Conflitos concorrentes `P2002` e `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- Requests simultâneos com workspace, ator, chave e fingerprint idênticos convergem para o mesmo cliente e credencial.
- Somente a transação vencedora devolve `secretAvailable=true` e o token gerado pelo bundle efetivamente persistido. Todo replay devolve `secretAvailable=false` e omite `token`.
- Se o cliente descartar ou perder a primeira resposta depois do commit, o retry recupera metadados redigidos. O token original não é persistido e não pode ser reaberto.
- Requests simultâneos com a mesma chave e fingerprints diferentes admitem um único vencedor; o outro retorna `IDEMPOTENCY_PAYLOAD_MISMATCH`.

## Consequências

- Automação externa pode repetir uma criação incerta sem duplicar clientes ou credenciais.
- Perder a primeira resposta exige emitir outra credencial; retry não é mecanismo de recuperação de segredo.
- Colisões transitórias têm retry limitado, sem loop indefinido.
- A rotação de credenciais permanece um command separado e será endurecida em incremento próprio.

## Evidências exigidas

- duas criações idênticas simultâneas retornam um 201 com token e um 200 redigido para a mesma identidade;
- resposta inicial descartada converge para replay sem token;
- payloads divergentes simultâneos produzem um 201 e um 409 de mismatch;
- três conflitos concorrentes consecutivos retornam conflito explícito;
- a jornada passa repetidamente no SQLite e a CI hospedada confirma os invariantes no PostgreSQL.
