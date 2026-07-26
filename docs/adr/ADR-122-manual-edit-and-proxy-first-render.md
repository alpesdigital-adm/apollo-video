# ADR-122 — Edição manual por Command e render proxy-first

Todo gesto manual vira Command com scope, base version e revision. Timeline e inspector nunca escrevem diretamente; undo/redo são versões. Compare preserva ambas as versões e sincroniza somente quando o mapping permite. O workflow materializa proxy revisável, executa validators/critic e bloqueia final em hard issue. Final exige aprovação não stale, idempotência, checksum, manifest e promoção atômica, preservando tentativas falhas.

## Decisão de proxy-first

O proxy não é apenas uma mídia intermediária. Após o worker promover o artifact,
ele persiste um `ProxyReview` imutavelmente ligado à operação, versão, artifact
e manifest. O laudo inclui OutputSpec de revisão, issues técnicas e editoriais
localizadas, `rangeCacheKey`, timestamps reais, hash canônico e revision.

Hard issues mantêm `finalAllowed=false` sem bypass. Warnings podem ser aceitos
somente por uma decisão `acknowledge-warnings` append-only, idempotente e
protegida por compare-and-swap de hash/revision. O repositório de export final
volta `null` se o laudo exato não estiver `ready-for-final`; portanto uma GUI,
um cliente externo ou um worker stale não consegue contornar o gate.

A Web App usa exclusivamente as capabilities públicas de leitura e decisão do
laudo. O painel “Laudo do proxy” é uma projeção do PostgreSQL e a ação de
exportar permanece desabilitada até a mesma versão corrente possuir
`finalAllowed=true`.
