# ADR-092 — Alertas de anomalia e kill switch

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

O kill switch é verificado antes da execução e retorna indisponibilidade. Picos de
erro, spend ou requests acima do threshold emitem alertas limitados e negam a
ação, vinculados a workspace e client.

## Política executável

A política `governance-anomaly-policy/v1` é server-owned, bounded e identificada
por hash canônico. Requests e spend usam janela de sinal de 60 segundos e
baseline anterior de cinco minutos; error-rate usa cinco minutos e amostra
mínima de operações terminais. As medições são isoladas por environment e
calculadas para workspace e client sob o mesmo lock transacional da admission.

Admissions e alertas v2 persistem policy hash, janela, observado, threshold e
eventual bypass. Alertas são content-addressed e consultáveis pela capability
administrativa `apollo.governance.alerts.list`, sem expor o hash interno da
admission. Somente sessão humana administradora pode usar a allowlist de
recuperação durante uma anomalia; limites ordinários continuam fail-closed.
