# ADR-123 — Ciclo fechado de qualidade e gate executável do MVP

## Status

Aceita em 2026-07-17.

## Decisão

Toda inserção visual passa por `AssetBrief`, busca ordenada (biblioteca, stock, geração), avaliação multidimensional e decisão explícita `no_insert`. O proxy passa por validadores técnicos, de policy e integridade; críticas localizadas são compiladas em patches e rerender do menor intervalo possível.

O ciclo termina somente por aprovação, convergência, orçamento, problema incorrigível ou revisão humana. Relatórios são versionados e comparados ao dataset de referência. O MVP Core possui 16 critérios com evidência automática obrigatória e o mesmo gate é operável pela API externa.

## Consequências

- Um asset sem direitos ou continuidade não chega silenciosamente ao render final.
- Rejeitar todos os inserts é uma decisão válida e auditável.
- O progresso documental não substitui evidência executável.
- Integrações externas têm paridade com as operações internas de qualidade.
