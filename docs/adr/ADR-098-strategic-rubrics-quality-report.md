# ADR-098 — Rubricas estratégicas como proxy editorial

## Status

Aceito em 2026-07-17.

## Decisão

Cada objetivo possui rubrica própria, versionada e com pesos normalizados. O `QualityReport` preserva rubrica, score por critério e evidências observáveis. Integridade narrativa, legibilidade e direitos são gates universais; CTA também é gate nos objetivos de conversão.

Thresholds medem qualidade editorial esperada, não performance comercial nem causalidade. O conjunto inicial de calibração tem exemplos bom, limítrofe e ruim para cada objetivo.

## Consequências

- candidatos diferentes são comparados sob o mesmo critério declarado;
- score alto não contorna violações obrigatórias;
- qualquer recalibração futura exige nova versão da rubrica.
