# ADR-018 — Retry manual e replay controlado

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

Backoff automático resolve falhas transitórias enquanto ainda há tentativas. Depois de cancelamento, falha definitiva ou dead-letter, um operador precisa conseguir autorizar nova execução sem editar o banco, perder o contexto protegido ou criar uma operação concorrente apontando para a mesma autorização.

Criar uma segunda `PublicOperation` exigiria copiar autorização, target e RenderInput internos, além de decidir qual operação representa o resultado canônico. Reabrir indiscriminadamente também seria perigoso: uma operação bem-sucedida nunca deve perder seu resultado terminal.

## Decisão

- O command externo é `POST /v1/operations/{operationId}/retry`, capability `apollo.operations.retry` e scope `operations:retry`.
- O retry reabre a mesma operação e preserva ID, target, contexto protegido, checkpoint existente, `attempt`, primeiro `startedAt` e histórico implícito de capacidade consumida.
- Somente `failed` e `canceled` podem ser reabertos. `succeeded` retorna conflito `PUBLIC_OPERATION_RETRY_REJECTED`.
- Chamar retry sobre `queued`, `running`, `waiting` ou `retrying` é replay natural: o estado atual é devolvido sem conceder capacidade adicional.
- Cancelamento antes da primeira tentativa volta para `queued`, mantendo `attempt = 0`.
- Operação com tentativa anterior volta para `retrying` e ganha disponibilidade praticamente imediata, persistida 1 ms após o command.
- Se `attempt = maxAttempts`, o command incrementa `maxAttempts` em exatamente um. Se ainda há capacidade original, ela é preservada sem expansão.
- `completedAt`, error e `deadLetteredAt` são limpos; a próxima tentativa continua sujeita a claim, lease, rights revalidation, validade da autorização, checkpoint e fencing normais.
- A idempotência é natural. Duas chamadas concorrentes sobre o mesmo terminal produzem uma única reabertura; a segunda observa o estado não terminal e não incrementa novamente o limite.
- A capability anuncia `human-approval`. O scope separado é a fronteira de autorização efetiva e permitirá políticas/quota específicas.

## Consequências

- Nenhum payload protegido é copiado ou devolvido à API.
- Retry não contorna autorização expirada ou rights revogados; a nova tentativa falha fechada durante revalidação.
- Um checkpoint anterior válido pode ser recuperado sem recodificação, preservando a semântica do ADR-015.
- Cada nova falha terminal exige um novo command explícito para receber outra tentativa.
- Limites de orçamento, motivo, ator persistido e audit/event outbox serão adicionados antes de permitir políticas amplas de retry pago.
- Listagem e filtros seguros foram entregues pelo ADR-019; a console administrativa agregada de dead-letter continua necessária.

## Evidências exigidas

- canceled antes e depois da primeira tentativa;
- dead-letter reaberto com somente uma tentativa adicional;
- schedule limpo e recriado corretamente;
- sucesso rejeitado sem mutação;
- isolamento por workspace e scope;
- duas chamadas concorrentes concedendo uma única reabertura no PostgreSQL;
- jornada HTTP com retry, replay imediato, leitura posterior e target ausente.
