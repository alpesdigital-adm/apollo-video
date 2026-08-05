# ADR-084 — Classes com preflight obrigatório

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Batch, matriz final, geração de custo variável e ação destrutiva exigem token de
preflight confiável e revalidado. Apenas ação explicitamente `bounded` dispensa o
gate; classe desconhecida falha fechada.

## Classificação operacional

`PREFLIGHT_ACTION_POLICIES` resolve action ID para classe e razão. A classe não é
input confiável do caller. IDs desconhecidos falham antes da mutação. O registry
atual integra `batch-edit.commit` e `variant-portfolio.confirm`; reserva as
classes `final-export-matrix.commit` e `destructive-command.commit` para os
respectivos commits futuros. `project-final-export.enqueue` é bounded apenas
porque enfileira um único formato já aprovado; não autoriza matriz multi-formato.
