# ADR-099 — Ação desejada e CTA canônicos

## Status

Aceito em 2026-07-17.

## Decisão

Objetivo e ação desejada são conceitos separados, porém compatíveis. A ação guarda destino explícito, CTA verbal, CTA visual e disclosures. Objetivos de conversão não avançam sem destino; URLs usam HTTPS. StoryPlan, legendas, overlays e critic consomem a mesma estrutura canônica.

## Consequências

- o editor nunca inventa link, handle, telefone ou material;
- CTA falado e CTA visual podem ser comparados com o destino configurado;
- divergências tornam-se issues determinísticas antes do render.

## Evidência de implementação

Em 2026-08-07, os commits `c3529ed` e `f1d58e5` materializaram esta decisão nos
contratos públicos, Postgres, Diretor, planos, critic e renderer. O run remoto
`f1006-20260807-r7`, no SHA `2e797c6`, comprovou a persistência e a identidade
canônica através de API, worker e Chromium; o golden FFmpeg local comprovou o
overlay nos frames exatos. A decisão está implementada e testada em ambiente
controlado, mas o requisito F1.006 permanece sem implantação e aceite finais.
