# ADR-054 — Concorrência no provisionamento HMAC pendente

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

`POST /v1/webhooks/endpoints/{endpointId}/signing-secrets` substitui a chave inicial de um endpoint pendente e devolve a nova chave HMAC uma única vez. Duas chamadas simultâneas podem gerar candidatos distintos em memória, mas jamais podem persistir ou divulgar duas versões para a mesma chave idempotente.

## Decisão

- Requests simultâneos com workspace, cliente, endpoint, revisão e chave idempotente idênticos convergem para uma única transação vencedora.
- Somente a resposta ligada ao candidato efetivamente persistido devolve status 201, `secretAvailable=true` e `secretBase64url`.
- A chamada concorrente lê o ledger concluído e devolve status 200, `secretAvailable=false`, omitindo `secretBase64url`.
- O secret anterior é aposentado uma única vez; a nova versão possui exatamente um payload cifrado e é o único secret ativo do endpoint.
- Se a resposta vencedora for descartada após o commit, repetir a mesma chamada recupera somente metadados redigidos. O plaintext não é persistido nem reaberto.
- O ledger contém somente IDs necessários ao replay e nunca inclui chave, salt, ciphertext ou parâmetros internos.

## Consequências

- Retry de transporte é seguro, mas não recupera material one-shot.
- Perder a primeira resposta exige consultar a revisão atual e emitir outra versão com nova chave idempotente.
- Candidatos perdedores existem apenas em memória e não se tornam signing secrets duráveis.
- A ativação posterior do endpoint continua um workflow separado.

## Evidências exigidas

- duas chamadas simultâneas retornam um 201 com chave e um 200 redigido para a mesma versão;
- exatamente um secret permanece ativo e o anterior fica aposentado;
- resposta inicial descartada converge para replay sem chave;
- endpoint auxiliar mantém duas versões totais e uma ativa depois da recuperação;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
