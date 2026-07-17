# ADR-122 — Edição manual por Command e render proxy-first

Todo gesto manual vira Command com scope, base version e revision. Timeline e inspector nunca escrevem diretamente; undo/redo são versões. Compare preserva ambas as versões e sincroniza somente quando o mapping permite. O workflow materializa proxy revisável, executa validators/critic e bloqueia final em hard issue. Final exige aprovação não stale, idempotência, checksum, manifest e promoção atômica, preservando tentativas falhas.
