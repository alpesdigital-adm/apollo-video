# ADR-111 — Confidence específica por decisão

Confidence é um valor calibrado acompanhado de evidência, reason codes e calibration version. Os thresholds variam por risco: rights nunca é aplicado automaticamente sem certeza total; reordenação narrativa é mais conservadora que seleção visual. O painel mostra somente estados `review` e `block`, evitando ruído. ECE é registrada nos eval sets para detectar regressão de calibração.
