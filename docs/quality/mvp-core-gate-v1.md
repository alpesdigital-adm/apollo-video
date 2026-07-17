# Evidência do gate MVP Core v1

O gate `mvp-core/v1` exige AC-001 a AC-016, todos aprovados e com evidência automática. A suíte `tests/v2/mvp-core-gate.e2e.test.mjs` atravessa os contratos reais de modo de produção, proxy, seleção/rejeição de asset, crítica localizada, edição manual, formatos independentes, reconstrução por manifest, dashboard e paridade da API externa.

Resultado esperado: `approved=true`, `covered=16`, `total=16`, sem critérios ausentes, falhos ou exclusivamente manuais. A aprovação final só pode ser registrada após a suíte completa de regressão, typecheck, contratos públicos, banco e build passarem no mesmo commit.
