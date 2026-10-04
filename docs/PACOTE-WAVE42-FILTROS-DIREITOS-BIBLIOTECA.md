# W42 — filtros server-side e direitos da biblioteca

**Plano, sem execução W42.** Bases e gates do [índice W41–W50](PLANO-WAVES-41-50.md); depende de W41. F1.012 / FR-040, partes das caixas `db882ddc544b-1` e `ac7e0a1c125b-1`. **3–4 h de desenvolvimento**, CI/revisão fora.

O domínio normaliza `kind`, `person`, `topic` e `rightsStatus`; a UI aplica filtros no GET. `mediaLibraryRights` deriva elegibilidade do snapshot jurídico com workspace, locale e tempo. Falta prova atual de combinação, isolamento A/B, expiração e locale com decisão real do backend; badge “Liberado” não basta para provar inserção autorizada.

Preparar assets e segmentos de bytes reais controlados em A/B, com snapshots eligible/review/restricted/expired e datas/locale deliberados. Oráculo PG/rights service prevê IDs e razão da decisão. Exercitar cada filtro e sua conjunção em `/v1/media/library` e Chromium; comparar query, cards e cursor, sem vazamento B→A. Alterar tempo/locale de fixture para direitos expirados e confirmar listagem e gate de attach sem copiar bytes; API específica deve retornar código de contrato, não uma allowlist 403/404. Verificar negativo de rights ausentes/restritos e zero results.

Fontes/testes: `src/v2/domain/media-library.ts`, `src/v2/domain/asset-rights.ts`, `src/v2/infrastructure/prisma/media-library-repository.ts`, `src/components/MediaLibraryWorkspace.tsx`, `tests/v2/media-library.test.mjs`, `tests/v2/prisma-media-library.integration.mjs`, `tests/v2/asset-rights-audit.test.mjs`. Manifest sanitizado com snapshot IDs/hashes, decisões, queries e capturas; CI/cleanup próprios. Fora: anexar segmento W46, mudanças de política jurídica, provider live, produção/aceite. Se o cenário exigir direitos não existentes, registrar bloqueio sem marcar as caixas.
