# ADR-124 — Reuso semântico e processamento hierárquico

## Status

Aceita em 2026-07-17.

## Decisão

Falas, provas e momentos long-form são índices virtuais sobre masters imutáveis, nunca arquivos físicos recortados por padrão. Cada resultado conserva timestamps, provenance, confidence, direitos e evidence spans. A busca combina filtros estruturados, texto e vetores com pesos versionados e explicação de matches/bloqueios.

Long-form é processado em chunks sobrepostos: sinais baratos precedem visão/LLM; mudanças de modelo invalidam somente o tier afetado e seus dependentes. Agregação preserva os spans originais.

## Consequências

- Reuso não duplica mídia nem perde contexto.
- Provas com qualifier, consentimento ausente ou hearsay falham fechadas.
- “Hook validado” não é promovido a “vídeo validado” nem causalidade.
- Todas as operações possuem paridade externa em `/api/library/semantic-v2`.
