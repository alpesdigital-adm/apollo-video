# ADR-021 — Envelope público e catálogo inicial de eventos

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

A API externa precisa publicar eventos que possam ser persistidos, entregues novamente e consumidos por automações sem depender da estrutura interna do banco ou dos workers. Antes de implementar outbox e webhooks, o contrato do evento precisa ser estável, versionado e descobrível.

Um catálogo também não pode sugerir que um evento já é emitido. Nesta etapa ele descreve apenas os tipos reservados e o envelope que as próximas slices usarão.

## Decisão

- O tipo canônico `PublicEvent<T>` contém `id`, `type`, `version`, `workspaceId`, `occurredAt`, `resource` e `data`, além de `sequence` e `actor` opcionais.
- `id` é UUID v4 em minúsculas. A criação e a validação em memória rejeitam IDs inválidos ou repetidos no mesmo lote. O ADR-022 acrescenta unicidade global e durável pela chave primária do outbox nas transições já conectadas.
- A versão pertence ao tipo do evento, não à versão da API. Todos os tipos iniciais começam em `1.0.0`; mudanças incompatíveis exigem nova versão do evento.
- `occurredAt` usa UTC canônico no formato produzido por `Date.toISOString()`. `sequence`, quando presente, é inteiro positivo e seguro.
- `resource.type` é fixado pelo catálogo para cada combinação de tipo e versão. O domínio rejeita eventos cuja referência de recurso não corresponda ao descritor.
- `actor` é opcional para permitir transições de sistema, mas, quando presente, deve informar `clientId` ou `userId`.
- `data` é um objeto JSON copiável e imutável, sem protótipos especiais, ciclos, números não finitos ou chaves perigosas. O limite atual é 64 KiB, profundidade 8 e até 1.024 itens por coleção.
- O catálogo inicial contém: `project.created`, `project.version.created`, `project.status.changed`, `operation.status.changed`, `operation.succeeded`, `operation.failed`, `annotation.created`, `annotation.resolved`, `quality.report.created`, `approval.changed`, `artifact.ready`, `artifact.rejected`, `budget.threshold.reached` e `client.suspended`.
- `GET /v1/events/catalog` publica o catálogo sem autenticação porque contém somente contrato estático, sem configuração ou dados de workspace.
- O catálogo referencia `apollo://schemas/public-event/v1`; ambos são publicados no registry de JSON Schemas e no OpenAPI derivados das capabilities.

## Consequências

- Produtores futuros devem construir eventos pelo domínio canônico, em vez de montar payloads livres.
- Consumidores podem preparar handlers antes de existir uma subscription, mas não devem inferir que um tipo já é emitido apenas porque aparece no catálogo.
- A correspondência entre o catálogo, o enum do schema e a capability pública é protegida por testes de contrato.
- O ADR-022 conecta a criação de projetos ao outbox. Subscription, dispatcher, endpoint receptor, assinatura, tentativa de entrega, retry, dead-letter e replay de eventos ainda não existem.
- A semântica at-least-once e a ordem observável só passam a existir quando o outbox durável for implementado.

## Evidências exigidas

- catálogo sem tipos/versões duplicados;
- UUID v4 e envelope canônico validados;
- tipo, versão e recurso incompatíveis rejeitados;
- payload fora dos limites, cíclico ou inseguro rejeitado;
- schema e catálogo expondo exatamente os mesmos tipos;
- descoberta pública sem revelar identificadores de workspace.
