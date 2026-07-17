# ADR-100 — Briefing opcional com fronteira de confiança

## Status

Aceito em 2026-07-17.

## Decisão

O briefing livre é opcional e identificado como instrução autorizada do owner. Transcrição, OCR e outros conteúdos extraídos da mídia nunca são incorporados no mesmo campo: entram apenas por referência e com trust `untrusted-media-derived`.

Antes de qualquer geração cara, a interface apresenta resumo e assumptions. Ausência de briefing não bloqueia o fluxo e permanece explícita.

## Consequências

- prompt injection presente na mídia não vira instrução do owner;
- lacunas permanecem visíveis e auditáveis;
- media-only é um caminho de primeira classe, não um erro de formulário.
