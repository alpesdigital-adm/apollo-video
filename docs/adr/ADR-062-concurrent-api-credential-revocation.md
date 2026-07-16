# ADR-062 — Concorrência na revogação de credenciais de API

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`DELETE /v1/workspaces/{workspaceId}/clients/{clientId}/credentials/{credentialId}` é naturalmente idempotente. Duas chamadas simultâneas ou um retry após resposta perdida não podem sobrescrever `revokedAt`, produzir diagnósticos divergentes nem prolongar a validade do bearer token.

## Decisão

- A transição usa um único compare-and-set atômico com alvo exato de workspace, cliente, credencial e `status=active`.
- Somente o update vencedor grava `status=revoked` e `revokedAt`.
- Todas as chamadas relêem o registro após o compare-and-set e devolvem o estado terminal persistido.
- Conflitos transitórios `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- A credencial da própria request continua impedida de se autorrevogar.
- Autenticação consulta o estado persistido e recusa imediatamente a credencial revogada.

## Consequências

- Chamadas concorrentes devolvem o mesmo timestamp independentemente da vencedora.
- Retry de transporte não altera auditoria nem cria uma segunda transição.
- A operação dispensa `Idempotency-Key` porque credencial e estado terminal definem sua identidade natural.
- Revogação permanece irreversível; uma nova credencial exige rotação ou criação explícita.

## Evidências exigidas

- dois DELETEs simultâneos devolvem a mesma credencial e o mesmo `revokedAt`;
- resposta descartada é recuperada sem alterar o timestamp;
- o valor persistido coincide com as respostas;
- o token revogado recebe 401 imediatamente;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
