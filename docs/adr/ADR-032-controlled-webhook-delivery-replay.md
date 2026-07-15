# ADR-032 — Replay controlado e idempotente de webhook delivery

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O diagnóstico público torna uma delivery identificável, mas reabri-la diretamente no banco perderia autoria, permitiria duplicação por timeout do cliente e poderia competir com uma tentativa ainda ativa. Replay também não pode apagar attempts anteriores nem contornar o limite absoluto de execução.

## Decisão

- `POST /v1/webhooks/deliveries/{deliveryId}/replay` é a única entrada externa de replay individual.
- A capability `apollo.webhooks.deliveries.replay` exige `webhooks:admin`, confirmação humana e `Idempotency-Key` obrigatório.
- O fingerprint idempotente vincula versão da ação, workspace, API client e delivery. A mesma chave com outro alvo falha com `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- O ledger genérico armazena, na mesma transação, um snapshot redigido da resposta aceita por 24 horas. Repetição da mesma chave devolve esse snapshot com `replayed: true`, mesmo que o worker tenha avançado posteriormente.
- Replay novo retorna 202; replay idempotente do request retorna 200.
- Apenas deliveries `succeeded` ou `dead-lettered` podem ser reabertas. `pending`, `in-flight` e `retry-scheduled` falham com conflito.
- Endpoint e subscription precisam estar ativos no momento da aceitação.
- Attempts anteriores permanecem imutáveis. A delivery volta para `retry-scheduled`, limpa estado terminal e lease, e agenda `nextAttemptAt` depois do timestamp da mutação.
- Quando `attemptCount == maxAttempts`, o replay concede exatamente uma tentativa adicional. Caso ainda exista capacidade, o teto não aumenta.
- `attemptCount == 20` é limite absoluto e não pode ser ampliado por replay.
- A atualização usa comparação de status e `updatedAt`; colisão concorrente não agenda duas execuções.
- Uma nova tentativa só é criada pelo claim normal do worker, preservando a mesma lógica de lease, assinatura, backoff e fencing.
- Delivery de outro workspace é indistinguível de inexistente. Ledger não é criado quando alvo, estado ou target falham.

## Consequências

- Timeout ou retry do cliente não multiplica replays.
- O histórico permanece contínuo na mesma delivery e pode ser acompanhado pela API de diagnóstico.
- Uma delivery concluída novamente pode receber outro replay intencional com uma nova chave.
- Replay em lote, por evento ou intervalo, continua fora desta decisão e deverá compor este comando sem contornar seus invariantes.
- O snapshot idempotente contém somente o diagnóstico interno redigido; não inclui URL, payload, assinatura, secret ou lease.

## Evidências exigidas

- terminal succeeded e dead-lettered reabrem sem apagar attempts;
- estado não terminal, target inativo e teto de 20 attempts são rejeitados;
- dead-letter no limite recebe exatamente mais uma tentativa;
- mesma chave retorna o snapshot original e não cria segundo ledger;
- mesma chave com outra delivery é rejeitada por fingerprint;
- outra chave enquanto replay está pendente não agenda duplicata;
- cross-workspace retorna 404 sem ledger;
- OpenAPI exige `Idempotency-Key`, scope e confirmação humana;
- jornada HTTP cobre 202 inicial, 200 idempotente, 409 concorrente e 403 sem scope.
