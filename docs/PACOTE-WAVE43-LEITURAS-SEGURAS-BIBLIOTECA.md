# W43 — leituras concorrentes, erro e retry da biblioteca

**Plano, sem execução W43.** Bases e gates do [índice W41–W50](PLANO-WAVES-41-50.md); depende de W42. F1.012 / FR-040, subescopos das caixas `5fed046a5719-1` e `ac7e0a1c125b-1`. **3–5 h de desenvolvimento**, CI/revisão fora.

`MediaLibraryWorkspace.tsx` hoje usa fetch de lista e concatena página seguinte; verificar risco de resposta antiga substituir filtro novo, duplicar item, continuar após logout ou deixar usuário sem retry. Implementar só o necessário após RED observável: `AbortController`/geração de leitura, deduplicação de IDs entre páginas, estado de erro e retry explícito, sem mascarar falha com lista velha.

Com sessão humana real, disparar filtro A→B e página 2 com latência de **transporte controlado**; exigir cards/cursor apenas de B, request anterior abortado/ignorado, nenhum ID duplicado e nenhum fetch tardio após unmount/logout. Em sessões reais expiradas ou ator sem permissão, observar 401/403 do backend; 429 deve vir de quota/throttle real configurado na suíte ou ficar como caso controlado rotulado, jamais simular HTTP para alegar política de segurança. Botão Retry repete leitura segura, não mutação. Capturar request sequence, estado visual e postflight.

Fontes/testes: `src/components/MediaLibraryWorkspace.tsx`, `src/v2/application/media-library.ts`, `src/v2/infrastructure/prisma/media-library-repository.ts`, `tests/v2/media-library.test.mjs`, `tests/v2/prisma-media-library.integration.mjs`. Artifact SHA/run/screenshots, sem cookies. Fora: novo framework de cache, alteração global de autenticação, preview, produção/aceite. Acima de 5 h, documentar quais races permanecem e manter as caixas abertas.
