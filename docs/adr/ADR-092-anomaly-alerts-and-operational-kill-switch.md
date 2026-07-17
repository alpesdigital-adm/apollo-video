# ADR-092 — Alertas de anomalia e kill switch

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

O kill switch é verificado antes da execução e retorna indisponibilidade. Picos de
erro, spend ou requests acima do threshold emitem alertas limitados e negam a
ação, vinculados a workspace e client.
