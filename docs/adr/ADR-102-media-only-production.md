# ADR-102 — Media-only como caminho explícito

## Status

Aceito em 2026-07-17.

## Decisão

Na ausência de briefing, a produção inicia com objetivo, ação e referências de mídia. O tratamento resultante declara modo `media-only`, assumptions e confidence limitada a 0,65. Claims e ofertas só podem ser repetidos quando aparecem no conjunto observado.

## Consequências

- ausência de briefing não impede um proxy revisável;
- o Diretor deixa claro onde possui baixa confiança;
- mídia sozinha nunca autoriza inventar promessa, oferta ou condição comercial.

## Evidência de implementação

O `TreatmentPlan v2` mantém media-only ortogonal à gramática visual: material
com speaker observado continua usando speaker como visual primário. Claims
propostos precisam pertencer exatamente ao conjunto observado e snapshots
adulterados falham na hidratação antes do render. O run remoto
`f1009-20260807-r4` (commit `4e5fa18`) comprovou a cadeia PostgreSQL → ingest →
Director → worker → proxy FFmpeg sem briefing, com postflight sem órfãos. A
decisão está implementada e testada ponta a ponta, mas ainda não implantada nem
aceita em produção.
