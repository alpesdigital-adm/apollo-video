# ADR-051 — Concorrência e token one-shot na rotação de credenciais

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

`POST /v1/workspaces/{workspaceId}/clients/{clientId}/credentials` encurta a validade das credenciais ativas, cria uma nova credencial e divulga seu bearer token uma única vez. Requests simultâneos não podem criar duas credenciais, aplicar overlaps conflitantes ou retornar mais de um token para a mesma chave idempotente.

## Decisão

- Ledger, atualização do overlap e nova credencial são gravados em uma transação serializável.
- Conflitos `P2002` e `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- Requests simultâneos com workspace, ator, cliente, chave e overlap idênticos convergem para a mesma credencial.
- Somente a transação vencedora devolve status 201, `secretAvailable=true` e o bearer token correspondente ao hash persistido. Replays devolvem status 200, `secretAvailable=false` e omitem `token`.
- Se a primeira resposta for perdida depois do commit, o retry recupera apenas cliente e credencial redigidos. O token não é persistido nem reaberto.
- O overlap integra o fingerprint. Reutilizar simultaneamente a mesma chave com overlaps diferentes admite um único vencedor e retorna `IDEMPOTENCY_PAYLOAD_MISMATCH` para o request divergente.

## Consequências

- A validade da credencial anterior é encurtada uma única vez por rotação vencedora.
- Automação externa pode repetir um resultado incerto sem criar credenciais extras.
- Perder o token exige uma nova rotação com outra chave idempotente.
- Retry limitado não mascara contenção persistente nem erros de domínio.

## Evidências exigidas

- duas rotações idênticas simultâneas retornam um 201 com token e um 200 redigido para a mesma credencial;
- resposta inicial descartada converge para replay sem token;
- overlaps divergentes sob a mesma chave produzem um 201 e um 409 de mismatch;
- o ledger nunca contém token, salt ou hash do segredo;
- a jornada passa repetidamente no SQLite e a CI hospedada confirma os invariantes no PostgreSQL.
