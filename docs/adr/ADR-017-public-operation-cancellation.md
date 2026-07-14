# ADR-017 — Cancelamento cooperativo de PublicOperation

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

Operações de render podem estar na fila, aguardando retry ou consumindo CPU quando o usuário ou uma automação decide interrompê-las. Alterar somente a interface não basta: o cancelamento precisa sobreviver a restart, invalidar o worker atual e impedir que uma tentativa antiga publique checkpoint ou resultado.

## Decisão

- O command externo é `POST /v1/operations/{operationId}/cancel`, capability `apollo.operations.cancel` e scope dedicado `operations:cancel`.
- A idempotência é natural: repetir cancelamento devolve a mesma operação, com o primeiro `completedAt` preservado.
- `queued`, `waiting`, `retrying` e `running` transitam para `canceled`; `succeeded`, `failed` e `canceled` permanecem inalterados.
- Cancelamento preserva `attempt` e `startedAt`, mas limpa lease, heartbeat, `nextAttemptAt`, result e error no mesmo update transacional.
- O worker observa a perda da lease pelo heartbeat ou pelo gate pré-commit, aciona o `AbortSignal` e não consegue avançar fase, registrar checkpoint ou concluir.
- A mutação é workspace-scoped, exige autenticação e scope específico. A capability anuncia `human-approval` para clientes de tooling; a fronteira efetivamente autorizadora continua sendo o scope.
- O contrato reutiliza `public-operation-detail/v1`; nenhuma chave de storage, autorização ou diagnóstico interno é exposta.
- Operações terminais são replay seguro, não erro: cancelamento tardio nunca reabre nem sobrescreve resultado já decidido.

## Corridas e efeitos externos

- Claim e cancel podem competir. Se o claim vencer primeiro, o cancel invalida a lease recém-criada; se o cancel vencer, o CAS do claim não encontra mais um candidato.
- Cancel e conclusão também competem. A transação que tornar a operação terminal primeiro prevalece, e a outra observa o estado terminal sem reescrevê-lo.
- Depois que bytes foram fisicamente promovidos, cancelamento não promete rollback distribuído. Se ocorrer na janela entre commit e checkpoint, o arquivo pode permanecer para reconciliação/limpeza, mas não pode ganhar checkpoint nem resultado pela operação cancelada.

## Consequências

- Reiniciar web ou worker não perde o cancelamento.
- Um renderer que respeita `AbortSignal` encerra cedo; um provider que não respeita ainda é impedido de publicar pela lease e pelo fencing.
- O tempo máximo até aborto durante cálculo é limitado pelo heartbeat configurado; o gate pré-commit permanece obrigatório.
- Motivo, ator persistido, event outbox e cobrança proporcional do trabalho cancelado continuam no incremento de audit/cost.
- Retry manual e replay de dead-letter são commands distintos e permanecem posteriores.

## Evidências exigidas

- cancelamento de queued, retrying e running;
- replay idempotente mantendo o primeiro timestamp;
- isolamento por workspace e scope;
- heartbeat, fase, checkpoint e reclaim rejeitados depois do cancel;
- corrida real claim versus cancel no PostgreSQL;
- jornada HTTP, capability, OpenAPI e schema compatíveis.
