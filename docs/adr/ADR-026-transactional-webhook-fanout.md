# ADR-026 — Fan-out transacional do outbox para webhooks

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O outbox do ADR-022 preserva eventos e o ADR-023 define subscriptions e deliveries, mas ainda faltava transformar um evento pendente em destinos duráveis. Marcar `publishedAt` antes dessa transformação pode perder eventos após crash; criar deliveries fora da mesma transação pode duplicá-las. Um evento ou filtro corrompido também não pode bloquear todos os workspaces.

## Decisão

- O materializador recebe um `workspaceId` obrigatório e processa somente o evento pendente mais antigo desse workspace, ordenado por `occurredAt` e ID.
- Um índice composto por workspace, `publishedAt`, instante e ID suporta essa seleção sem alterar a ordem pública, que continua não prometida entre recursos diferentes.
- Candidatos precisam pertencer ao mesmo workspace e ter endpoint e subscription atualmente ativos.
- O envelope persistido é reidratado por `createPublicEvent` antes do roteamento; tipo, versão, ator, recurso e payload inválidos abortam a transação.
- `subscription.createdAt` e `endpoint.verifiedAt` precisam ser anteriores ou iguais a `event.occurredAt`. Ativação posterior não cria backlog implícito.
- O conteúdo JSON de cada filtro é reidratado pelo domínio e seu hash é recalculado. Divergência ou JSON inválido é corrupção persistente e aborta o fan-out.
- Event type é comparado por igualdade com entradas do catálogo. Resource ID, quando configurado, também é comparado por igualdade; prefixos e wildcards não existem.
- Há limite fail-closed de 10.000 subscriptions candidatas por evento. Ultrapassar o limite deixa o evento pendente para intervenção explícita.
- Para cada match é criado um `WebhookDelivery` pendente. O `upsert` usa a identidade única `(subscriptionId, eventId)`, permitindo recuperação sem produzir duplicata.
- Todas as deliveries e a atualização de `publishedAt` pertencem à mesma transação. Qualquer erro reverte ambas.
- Evento sem match também recebe `publishedAt`: isso registra conclusão do roteamento, não entrega externa.
- `publishedAt` não representa sucesso HTTPS. Confirmação só poderá ser inferida do estado terminal das deliveries e attempts.
- O resultado do materializador contém apenas IDs, contagens e deliveries canônicas internas; não expõe payload do evento, URL ou secret.

## Consequências

- Crash antes do commit não publica o evento nem deixa delivery parcial; crash após o commit encontra deliveries duráveis.
- Reexecução de um evento cuja marca foi perdida reutiliza as deliveries existentes.
- Um evento inválido bloqueia somente o materializador daquele workspace, não a fila de outros tenants.
- Subscriptions pausadas, endpoints suspensos e destinos revogados não recebem novas deliveries no fan-out corrente.
- Replay histórico será uma operação explícita; ativar uma subscription não varre eventos antigos.
- Ainda não existe garantia at-least-once fim a fim: faltam claim/lease, secret provider, assinatura, transporte, classificação de resposta, backoff e dead-letter de delivery.

## Evidências exigidas

- evento compatível cria exatamente uma delivery por subscription;
- evento anterior à verificação, tipo/resource divergente ou ausência de subscription produz zero deliveries e conclui o roteamento;
- reexecução preserva o ID da delivery existente e não aumenta a contagem;
- filtro adulterado reverte a transação e mantém `publishedAt` nulo;
- chamada para outro workspace não é bloqueada pelo evento corrompido;
- migration contém o índice de polling workspace-scoped;
- integração roda em SQLite e PostgreSQL sem semântica dependente do provider.
