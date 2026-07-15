# ADR-033 — Replay controlado de deliveries por evento exato

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O replay individual exige conhecer cada delivery. Incidentes de fan-out, indisponibilidade temporária de um consumidor ou correções operacionais frequentemente exigem reprocessar todas as deliveries de um evento público conhecido. Uma operação irrestrita por intervalo aumentaria o impacto de erro humano, poderia gerar carga não estimada e dificultaria uma resposta idempotente e auditável.

## Decisão

- `POST /v1/webhooks/events/{eventId}/replay` opera somente sobre um UUID de evento exato; replay por intervalo continua fora desta slice.
- A capability `apollo.webhooks.events.replay` exige `webhooks:admin`, confirmação humana e `Idempotency-Key` obrigatório. Seu custo é classificado como alto.
- O fingerprint vincula versão da ação, workspace, API client, event ID e limite do lote. Reuso da chave para outro evento falha com `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- No máximo 100 deliveries podem ser avaliadas em uma chamada. Eventos acima do limite falham antes de qualquer alteração com `WEBHOOK_EVENT_REPLAY_LIMIT_EXCEEDED`.
- A leitura e as alterações são executadas em uma única transação. As deliveries são ordenadas por ID para produzir resultado determinístico.
- Cada delivery recebe exatamente uma classificação: `scheduled`, `skipped-non-terminal`, `skipped-target-inactive` ou `skipped-attempt-limit`.
- Somente deliveries `succeeded` ou `dead-lettered`, abaixo do limite absoluto de 20 attempts e com endpoint e subscription ativos são reagendadas.
- O reagendamento reutiliza a transição canônica do replay individual: preserva `attemptCount` e attempts, limpa estado terminal e lease e só amplia `maxAttempts` quando o teto anterior já foi consumido.
- Ao menos uma delivery precisa ser elegível. Evento sem delivery ou sem item elegível falha com `WEBHOOK_EVENT_REPLAY_REJECTED` e não cria ledger.
- Cada atualização usa CAS por status e `updatedAt`. Qualquer colisão desfaz o lote inteiro, incluindo o ledger.
- A primeira aceitação retorna 202. A mesma chave devolve por 24 horas o snapshot original com 200 e `replayed: true`, mesmo se o worker já tiver avançado as deliveries.
- O snapshot contém apenas event ID, classificação e resumo redigido de cada delivery. Attempts, URL, payload, assinatura, secret e lease não são armazenados na resposta idempotente.
- Evento de outro workspace é indistinguível de inexistente e retorna 404.

## Consequências

- O operador consegue recuperar um fan-out conhecido sem enumerar deliveries manualmente.
- Itens ignorados permanecem visíveis e explicáveis sem transformar uma condição esperada em falha parcial.
- A aceitação é atômica: nunca existe um lote parcialmente reagendado por colisão concorrente.
- O limite fixo mantém resposta, custo e ledger bounded. Um futuro replay por intervalo deverá usar preflight, operação durável e resultados paginados, compondo os mesmos invariantes.

## Evidências exigidas

- serviço vincula evento, cliente, workspace e limite ao fingerprint idempotente;
- integração Prisma cobre 202 inicial, snapshot idempotente, mismatch de evento, lote sem elegíveis e evento inexistente;
- contrato público enumera todas as classificações e limita o resultado a 100 itens;
- jornada HTTP cobre chave obrigatória, resultado redigido, 200 idempotente, 409 sem elegíveis e 403 sem scope;
- build e OpenAPI registram a rota e exigem confirmação humana.
