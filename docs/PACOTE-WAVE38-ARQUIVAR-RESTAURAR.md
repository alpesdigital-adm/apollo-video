# Wave 38 — arquivar e restaurar sem perder o estado anterior

**Pacote em fila; nenhuma prova W38 executada.** Base `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, CI `37167702546` verde; depende da W37. F1.003 / FR-004, novos subescopos das **mesmas** caixas `1349e49bda43-1`, `288af260f3e0-1` e `70e3b8d2cdb3-1`. Estimativa **3–4 h de desenvolvimento**, CI/revisão fora.

UI e API já expõem arquivar/restaurar com `baseRevision`, confirmação explícita, idempotência e `archivedFromStatus`; registros antigos sem estado anterior não podem ser restaurados por palpite. Falta demonstrar confirmação/cancelamento no browser, autorização e preservação exata do status anterior no PostgreSQL.

Em fixture V2 pós-baseline com estado anterior não trivial, clicar Arquivar e **cancelar**: zero POST/comandos/revisões. Confirmar numa segunda tentativa; exigir um comando atômico, status `archived`, `archivedFromStatus` original, card agrupado e ação Restaurar correta. Restaurar e conferir retorno **exato** ao status prévio, revisão monotônica, história de commands e identidade de ProjectVersion intactas. Testar replay idempotente, stale 409, ausência de scope e linha histórica sem `archivedFromStatus` que falha fechada. Sem DELETE nem troca silenciosa para `draft`.

Validar contrato/service e jornada browser/PG, capturas de cancel/confirm/restore, hashes, IDs/revisões/contadores, CI SHA e postflight zero órfãos. Prova de um estado não generaliza todos; combinar com W35/W40 para cobertura final. Fora: rename novo, duplicação, purga física, migração de legados, produção e aceite. Se compatibilidade histórica demandar política maior, parar em até 4 h e registrar bloqueio sem fallback.

Referências e gates comuns: [índice W31–W40](PLANO-WAVES-31-40.md); `src/app/ProjectsPageClient.tsx`, `src/v2/application/project-quick-actions.ts`, `tests/v2/project-administration.test.mjs` e `tests/v2/public-project-api.integration.mjs`.
