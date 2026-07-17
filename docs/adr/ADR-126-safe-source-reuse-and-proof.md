# ADR-126 — Reuso seguro de fontes publicadas e provas

## Status

Aceita em 2026-07-17.

## Decisão

Materiais publicados são desconstruídos em ranges essenciais e contaminantes localizados. Limpeza produz derivative por trim, crop/reframe ou cover; quando destruiria conteúdo ou integridade, o asset é rejeitado. O source permanece imutável.

Provas passam por necessidade narrativa e gate de claim, produto, pessoa, período, audiência, consentimento, qualifier e attribution. Ausência de prova é explícita; o sistema nunca sugere fabricação. Long-form usa workflow retomável e pode extrair uma janela contínua sem síntese de múltiplos trechos.

## Consequências

- Validação anterior é preservada por envelope ou sua perda exige aprovação.
- Repositório cross-asset filtra workspace/rights/consent antes do ranking.
- API externa: `/api/library/reuse-v2`.
