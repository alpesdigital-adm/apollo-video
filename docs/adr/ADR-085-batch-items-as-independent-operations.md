# ADR-085 — Itens de lote como operações independentes

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Cada item de lote referencia sua própria PublicOperation. Páginas retornam no
máximo 100 itens com status, `resultRef` ou erro redigido; status e retry usam as
APIs duráveis existentes por `operationId`, sem payload monolítico.

O estado autoritativo continua no `ProductionBatch`: `operationId` é uma
identidade content-addressed persistida no item, e a `PublicOperation` é uma
projeção validada desse aggregate. Não existe uma segunda state machine em
`public_operations`. `operations.read` resolve ambas as fontes e falha se houver
ambiguidade; `operations.retry` delega ao mesmo partial retry transacional usado
pela rota de batch, exigindo também `projects:write`.
