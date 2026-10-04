# W45 — segmentos virtuais criados e lidos pela UI

**Plano, sem execução W45.** Bases e gates do [índice W41–W50](PLANO-WAVES-41-50.md); depende de W44. F1.013 / FR-042, subescopos das caixas `4b34d180f96e-1`, `685f984e3c9d-1` e `82ccf53db39a-1`. **3–4 h de desenvolvimento**, CI/revisão fora.

Domínio, repository e `GET/POST /v1/media/library/{artifactId}/segments` já modelam range semântico, nesting, source time 1:1, hash e `physicalObjectKey=null`. Falta operar criação/leitura na biblioteca UI e comprovar com master real que escolher um range **não** recorta o arquivo. Não reinterpretar a prova histórica de FFmpeg como UI atual.

Adicionar só interface necessária para marcar início/fim/label/description no master de fixture controlada. Criar via API pública, reler em Chromium e PG, comparar `startMs/endMs`, `parentAssetId/parentSegmentId`, `segmentHash`, mapeamento e duração; testar overlap, nested e borda exata, além de range inválido e 404 cross-workspace. Antes/depois: SHA/byteSize do master idênticos, nenhum novo objeto físico ou FFmpeg; `physicalObjectKey` continua null. Replay idempotente não duplica linha.

Fontes/testes: `src/v2/domain/media-segment.ts`, `src/v2/application/media-segments.ts`, `src/v2/infrastructure/prisma/media-segment-repository.ts`, `src/components/MediaLibraryWorkspace.tsx`, `tests/v2/media-segment.test.mjs`, `tests/v2/prisma-media-library.integration.mjs`, `tests/v2/media-segment-materialization.integration.mjs`. Manifest de ranges/IDs/hashes, screenshots/API/PG e cleanup. Fora: derivative físico W47, attach W46, produção/aceite.
