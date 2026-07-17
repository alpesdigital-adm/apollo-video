# ADR-116 — Segurança narrativa localizada

Trim e reordenação são validados contra claims, qualifiers, negação, causalidade, prazo, prova, contexto e atribuição. Remover ou deslocar um elemento necessário produz `NarrativeQualityIssue` bloqueante com range, evidência e correção possível. A política é determinística e não depende de prompt. Fixtures cobrem promessa, testemunho, comparação e contexto removido.
