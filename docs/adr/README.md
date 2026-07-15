# Architecture Decision Records

ADRs registram decisões que alteram contratos, fronteiras ou operação do Apollo Video v2.

Estados usados:

- **Proposed:** ainda pode mudar antes da implementação dependente.
- **Accepted:** decisão vigente.
- **Superseded:** substituída por outro ADR, mantendo histórico.

Índice inicial:

- [ADR-001 — Estrutura modular da v2](./ADR-001-v2-modular-architecture.md)
- [ADR-002 — Banco, persistência v2 e migrations](./ADR-002-database-and-migrations.md)
- [ADR-006 — Commands, versões e concorrência](./ADR-006-command-version-model.md)
- [ADR-010 — Segurança, credenciais, rights e consent](./ADR-010-security-credentials-rights-consent.md)
- [ADR-013 — API pública e automação](./ADR-013-public-api-automation.md)
- [ADR-014 — Worker durável de render e fencing de lease](./ADR-014-durable-render-worker.md)
- [ADR-015 — Checkpoint do output materializado](./ADR-015-render-output-checkpoint.md)
- [ADR-016 — Agendamento durável de retry e esgotamento](./ADR-016-durable-retry-schedule.md)
- [ADR-017 — Cancelamento cooperativo de PublicOperation](./ADR-017-public-operation-cancellation.md)
- [ADR-018 — Retry manual e replay controlado](./ADR-018-manual-operation-retry.md)
- [ADR-019 — Listagem e cursor estável de PublicOperation](./ADR-019-public-operation-list-cursor.md)
- [ADR-020 — Descoberta administrativa de dead-letter](./ADR-020-public-operation-dead-letter-discovery.md)
- [ADR-021 — Envelope público e catálogo inicial de eventos](./ADR-021-public-event-envelope-and-catalog.md)
- [ADR-022 — Outbox transacional de eventos públicos](./ADR-022-transactional-public-event-outbox.md)
- [ADR-023 — Modelo de subscription e delivery de webhook](./ADR-023-webhook-subscription-and-delivery-model.md)
- [ADR-024 — Challenge, assinatura e anti-replay de webhook](./ADR-024-webhook-challenge-signature-and-replay.md)
- [ADR-025 — Transporte seguro do challenge de webhook](./ADR-025-safe-webhook-challenge-transport.md)
- [ADR-026 — Fan-out transacional do outbox para webhooks](./ADR-026-transactional-webhook-fanout.md)
- [ADR-027 — Claim, lease e fencing de deliveries de webhook](./ADR-027-webhook-delivery-leases-and-fencing.md)
- [ADR-028 — Dispatch assinado de deliveries de webhook](./ADR-028-signed-webhook-delivery-dispatch.md)
- [ADR-029 — Orquestração do worker de webhook deliveries](./ADR-029-webhook-delivery-worker-orchestration.md)
- [ADR-030 — Descoberta e sharding de workspaces com webhook executável](./ADR-030-webhook-workspace-discovery-and-sharding.md)
