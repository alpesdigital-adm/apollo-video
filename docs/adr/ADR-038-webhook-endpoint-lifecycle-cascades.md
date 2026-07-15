# ADR-038 — Lifecycle e cascatas de endpoints de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Subscriptions já podiam ser pausadas ou revogadas individualmente, mas desligar um destino inteiro ainda exigia alterações internas separadas. Atualizar somente o endpoint deixaria subscriptions aparentemente ativas; reativá-las automaticamente depois de uma suspensão poderia desfazer pausas deliberadas. Revogar um endpoint sem encerrar sua chave ativa também prolongaria credenciais sem utilidade.

## Decisão

- A capability `apollo.webhooks.endpoints.status.set` expõe `PUT /v1/webhooks/endpoints/{endpointId}/status` sob `webhooks:admin` e confirmação humana.
- O body fechado contém somente `status` e `baseRevision`; os alvos públicos são `active`, `suspended` e `revoked`.
- Toda representação pública do endpoint inclui revisão SHA-256 opaca derivada de ID, status e `updatedAt`.
- Alteração real exige a revisão atual e compare-and-set por workspace, ID, status e `updatedAt`. Repetir o mesmo alvo converge sem gravação.
- As transações de lifecycle de endpoint e subscription usam isolamento serializável; conflito de serialização é convertido em revisão divergente.
- A máquina de estados permite `active → suspended`, `suspended → active`, `active|suspended|pending-verification → revoked`; revogação é terminal.
- Suspender um endpoint pausa, na mesma transação, somente subscriptions atualmente ativas. Subscriptions já pausadas ou pendentes permanecem como estavam.
- Retomar o endpoint exige exatamente um signing secret ativo e não reativa subscriptions. Cada subscription deve ser retomada explicitamente com sua nova revisão.
- Revogar o endpoint revoga atomicamente todas as subscriptions não terminais e todo signing secret ainda ativo. Secrets já retired permanecem como histórico.
- O relógio do comando não pode anteceder o endpoint nem qualquer subscription atingida pela cascata.
- A resposta publica contagens de subscriptions pausadas/revogadas e signing secrets revogados, além do endpoint redigido e indicador de repetição.
- Cross-workspace retorna 404; respostas excluem workspace, URL completa, `keyRef`, bytes secretos, filtros internos, leases e payloads.

## Consequências

- Um único command interrompe de forma coerente todo o fan-out de um destino.
- A retomada é conservadora: restaurar conectividade não restaura consentimento operacional de cada subscription.
- Revogação remove a capacidade de entrega e de assinatura sem apagar o histórico administrativo.
- O isolamento serializável evita o write skew entre uma retomada de subscription e uma suspensão concorrente do endpoint.
- Criação, challenge, alteração de URL e rotação de chave continuam em contratos separados.

## Evidências exigidas

- suspensão pausa apenas subscriptions ativas e informa a contagem correta;
- repetição do mesmo alvo não repete cascatas;
- retomada mantém subscriptions pausadas e exige exatamente um secret ativo;
- revisão antiga, relógio regressivo e transição terminal retornam 409;
- revogação encerra subscriptions abertas e secret ativo na mesma transação;
- disputa serializável falha como conflito, sem estado parcialmente aplicado;
- cross-workspace retorna 404 e cliente sem scope recebe 403;
- body com campo extra ou estado interno retorna 422;
- OpenAPI, schemas, exemplos, Prisma e jornada HTTP exercitam o contrato real.
