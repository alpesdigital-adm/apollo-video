# Wave 37 — renomear projeto pelo card

**Pacote em fila; nenhuma prova W37 executada.** Base `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, CI `37167702546` verde; depende da W36. F1.003 / FR-004, subescopos das caixas `1349e49bda43-1`, `288af260f3e0-1` e `70e3b8d2cdb3-1`. Estimativa **2–3 h de desenvolvimento**, CI/revisão fora.

O card já oferece Renomear; a rota `/v1/projects/{id}/rename` e `src/v2/application/project-quick-actions.ts` exigem `projects:write`, baseRevision/idempotência e comando administrativo atômico. Falta provar UI→API→Postgres com nome antigo/novo, resposta durável e conflito recuperável; o card não deve se atualizar otimisticamente antes da confirmação.

Após baseline e com sessão real, registrar projeto, revisão, snapshot e comandos no banco; abrir ação no Chromium, editar nome e confirmar. Verificar request, código, command/ator/baseRevision, mudança única em PG/API e card atualizado pelo refetch. Repetir idempotency key sem duplicar comando; enviar `baseRevision` obsoleta de outro cliente e exigir 409 com nome/card estáveis e erro recuperável. Provar 401/scope insuficiente/isolamento com códigos **do contrato desta rota**, não allowlist genérica. Não armazenar cookies/keys no manifesto.

Usar testes de quick actions, contrato e jornada pública real; capturas antes/depois/erro, IDs/revisões e hashes ligados a SHA/CI, cleanup de browser/Next/PG. Preservar W29–W36. Fora: arquivar/restaurar (W38), duplicar (W39), política nova de autorização, deploy e aceite. Se regressão pequena exigir correção, RED real no arquivo existente; acima de 3 h registrar parcial e não promover nenhuma das três caixas.

Referências e gates comuns: [índice W31–W40](PLANO-WAVES-31-40.md); `src/app/ProjectsPageClient.tsx`, `src/v2/application/project-quick-actions.ts`, `tests/v2/project-administration.test.mjs` e `tests/v2/public-project-api.integration.mjs`.
