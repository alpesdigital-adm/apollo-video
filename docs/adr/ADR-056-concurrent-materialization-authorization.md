# ADR-056 — Concorrência na autorização de materialização

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`POST /v1/artifacts/{artifactId}/materialization-authorizations/{manifestId}` avalia disponibilidade, direitos, consentimento e operações sintéticas para cada asset. O resultado grava uma autorização e decisões vinculadas aos snapshots de direitos. Requests simultâneos ou retries não podem produzir receipts divergentes para a mesma chave.

## Decisão

- Autorização e decisões por asset são gravadas em transação serializável.
- Conflitos `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- Requests simultâneos com workspace, cliente, artifact, manifest, política e chave idênticos convergem para a mesma autorização.
- Exatamente um resultado tem `replayed=false`; os demais devolvem `replayed=true` e o mesmo authorization ID.
- Se a primeira resposta for descartada após o commit, o retry recupera o receipt durável sem duplicar decisões.
- Uso, mercado, locale e operações sintéticas integram o fingerprint. Reutilização divergente da chave retorna `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- A resposta pública continua omitindo paths, payloads protegidos, notas jurídicas e parâmetros internos.

## Consequências

- Agentes externos podem repetir avaliações com resultado de transporte desconhecido.
- Cada autorização vencedora possui no máximo uma decisão por ordinal de asset.
- Mudanças posteriores nos direitos não alteram o receipt histórico; o worker revalida no momento da materialização.
- Retry limitado não mascara contenção persistente.

## Evidências exigidas

- duas autorizações simultâneas convergem para o mesmo ID com um original e um replay;
- autorização e decisões aparecem uma única vez no banco;
- resposta inicial descartada converge sem duplicação;
- política divergente mantém mismatch explícito;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
