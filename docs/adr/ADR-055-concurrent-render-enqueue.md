# ADR-055 — Concorrência no enqueue durável de render

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`POST /v1/artifacts/{artifactId}/renders/{manifestId}` cria uma `PublicOperation` e um contexto privado que liga autorização e `inputHash`. Requests simultâneos ou retries após resposta perdida não podem criar duas operações para a mesma chave nem expor o contexto interno no replay público.

## Decisão

- Operação e contexto de render são gravados em transação serializável.
- Conflitos `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- Requests simultâneos com workspace, cliente, artifact, manifest, autorização e chave idênticos convergem para a mesma operação.
- Exatamente um resultado tem `replayed=false`; os demais retornam `replayed=true` e o mesmo operation ID.
- Se a resposta 202 for descartada depois do commit, repetir o request recupera a operação existente sem nova linha de contexto.
- Artifact, manifest e autorização integram o fingerprint. Reutilizar a chave com autorização divergente retorna `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Autorização, `inputHash`, paths e materialização permanecem ausentes da representação pública.

## Consequências

- Automação externa pode repetir enqueue com resultado de transporte desconhecido.
- Uma chave idempotente identifica uma única intenção de render, não apenas um artifact.
- Retry serializável limitado absorve contenção transitória sem loop indefinido.
- Claim e lease do worker continuam responsáveis por impedir execução e commit duplicados depois do enqueue.

## Evidências exigidas

- dois enqueues simultâneos devolvem o mesmo operation ID com um original e um replay;
- banco contém uma operação e um contexto privado;
- resposta inicial descartada converge para replay do mesmo ID;
- autorização divergente mantém mismatch explícito;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
