# ADR-103 — Override de política por projeto

## Status

Aceito em 2026-07-17.

## Decisão

Cada elemento permitido usa `inherit`, `none` ou `custom`. A resolução sempre devolve valor e origem (`workspace`, `project-none`, `project-custom`). Overrides entram no Policy Snapshot ligado à versão do projeto e também podem ser operados por endpoint dedicado.

## Consequências

- desativar logo ou handle em um projeto não altera a marca global;
- o editor consegue explicar de onde veio cada valor;
- chaves não allowlisted falham antes de persistir.
