# ADR-081 — PreflightResult canônico e público

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Operações futuras de edição e lote precisam explicar impacto antes do commit sem
usar respostas ad hoc incompatíveis entre UI, API, MCP e agentes.

## Decisão

`preflight-result/v1` é o envelope canônico de decisão prévia e contém:

- targets versionáveis;
- conflicts bloqueantes;
- invalidations tipadas;
- jobs previstos;
- custo estimado e máximo em centavos de USD;
- quota necessária, restante e decisão;
- warnings estruturados.

Elegibilidade é derivada: somente ausência de conflicts e quota suficiente produz
`eligible: true`. Todas as coleções e textos possuem limites. O schema e exemplo
são publicados pela API versionada de contratos.

## Consequências

- UI, ferramentas externas e agentes podem interpretar o mesmo impacto.
- Custo evita ambiguidade de ponto flutuante usando minor units.
- Commit token, snapshot e expiry entram nas próximas tarefas sem alterar v1.
- Novas dimensões exigem nova versão do schema.

## Evidências exigidas

- todas as sete dimensões estão presentes e limitadas;
- elegibilidade inconsistente falha fechada;
- quota e custo inconsistentes são rejeitados;
- schema é descoberto pela Public API;
- contratos, typecheck e regressão permanecem verdes.
