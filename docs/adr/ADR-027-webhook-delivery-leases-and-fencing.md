# ADR-027 — Lease e fencing de deliveries de webhook

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O fan-out transacional do ADR-026 cria deliveries deduplicadas, mas uma fila durável ainda precisa impedir que dois workers concluam a mesma tentativa ou que um worker atrasado sobrescreva o resultado de quem retomou um lease vencido. Persistir o token de posse em claro transformaria acesso ao banco em capacidade de concluir a chamada.

## Decisão

- O claim é sempre limitado por `workspaceId` e considera somente deliveries vencidas ou prontas cujo endpoint e subscription continuam ativos.
- Estados elegíveis são `pending`, `retry-scheduled` com `nextAttemptAt` vencido e `in-flight` com lease expirado.
- Cada claim incrementa `attemptCount` e cria um `WebhookDeliveryAttempt` imutavelmente numerado na mesma transação.
- O worker recebe um token aleatório one-shot de 256 bits. Somente o SHA-256 desse token é persistido.
- O fence de heartbeat e conclusão combina workspace, delivery, owner, número da tentativa, hash do token e lease ainda não expirado.
- Heartbeat renova o lease apenas quando todo o fence ainda coincide. Worker obsoleto recebe `false`/`null` e não altera estado.
- Ao retomar um lease expirado, a tentativa anterior é encerrada como `failed` com `lease_expired` antes da nova tentativa.
- Se a tentativa expirada já consumiu `maxAttempts`, a delivery vai para `dead-lettered` e não é entregue a outro worker.
- Sucesso exige status HTTP 2xx. Falha só vira `retry-scheduled` quando existe instante futuro explícito e ainda há orçamento de tentativa; caso contrário termina em dead-letter.
- Todo estado fora de `in-flight` deve ter owner, hash, expiração e heartbeat nulos.
- Constraints do PostgreSQL e construtores de domínio validam contagem por estado e cronologia `scheduledAt <= startedAt <= completedAt`.
- O boundary desta slice não abre secrets nem executa rede. O dispatcher posterior reutilizará o transporte DNS-pinado e apresentará o resultado através deste fence.

## Consequências

- Apenas o possuidor atual do token bruto pode renovar ou concluir a tentativa.
- Um crash é recuperável depois do vencimento sem permitir que o resultado atrasado corrompa a nova tentativa.
- O histórico distingue falha de transporte de expiração operacional do worker.
- A garantia at-least-once ainda não está completa: faltam abertura do secret, assinatura, HTTPS, política de resposta/backoff e replay administrativo.

## Evidências exigidas

- token bruto nunca aparece na linha persistida;
- heartbeat com token incorreto falha sem estender o lease;
- lease vencido cria nova tentativa e fecha a anterior com `lease_expired`;
- worker anterior não consegue concluir depois do reclaim;
- retry não fica elegível antes de `nextAttemptAt`;
- sucesso limpa todo o lease e preserva attempts anteriores;
- expiração da última tentativa produz dead-letter terminal;
- o mesmo fluxo passa em SQLite e PostgreSQL.
