# ADR-049 — Concorrência e perda de resposta na criação de projetos

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

`POST /v1/projects` é um comando externo idempotente que grava, na mesma unidade lógica, projeto, versão inicial, dois snapshots, ledger e dois eventos no outbox. Requests podem chegar simultaneamente com a mesma chave ou ser repetidos quando o cliente não sabe se o commit ocorreu. Sem invariantes verificáveis, uma corrida poderia criar projetos duplicados, aceitar payload divergente ou emitir eventos mais de uma vez.

## Decisão

- A criação inteira ocorre em transação com isolamento serializável.
- Um conflito de serialização `P2034` é repetido no máximo três vezes; depois disso, a API devolve `PERSISTENCE_CONFLICT` em vez de assumir um resultado.
- Requests simultâneos com o mesmo workspace, client, chave e fingerprint convergem para o registro já concluído. Exatamente um resultado tem `replayed=false`; os demais recuperam o mesmo projeto e versão com `replayed=true`.
- Reutilizar simultaneamente a mesma chave com fingerprints diferentes admite exatamente um vencedor. Depois que o vencedor fica durável, o outro request devolve `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Perder a resposta depois do commit não reabre a transação. O retry lê a resposta persistida e não duplica projeto, versão, snapshots, ledger ou eventos.
- Colisões de identidade que não correspondam ao ledger idempotente continuam falhando como `PERSISTENCE_CONFLICT` e preservam rollback integral.

## Consequências

- Clientes e agentes externos podem repetir com segurança uma criação cujo resultado de transporte seja desconhecido.
- O payload deve permanecer exatamente equivalente durante o retry; uma mudança de nome exige nova chave.
- O resultado correto é definido pelo estado durável, não pela ordem em que as Promises locais terminam.
- A política limitada de retry reduz conflitos transitórios sem criar loops ilimitados ou ocultar contenção persistente.

## Evidências exigidas

- duas criações idênticas simultâneas produzem um projeto, uma versão, dois snapshots, um ledger e dois eventos;
- uma resposta descartada depois do commit é recuperada como replay sem novas linhas;
- duas criações divergentes com a mesma chave produzem um sucesso e um mismatch;
- três conflitos de serialização consecutivos retornam conflito explícito;
- o teste de integração passa repetidamente no SQLite e a CI hospedada confirma os invariantes no PostgreSQL.
