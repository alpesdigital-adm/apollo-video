# ADR-097 — Objetivo estratégico vinculado ao DirectorRun

## Status

Aceito em 2026-07-17.

## Decisão

Cada produção declara exatamente um dos oito objetivos canônicos antes do upload. O objetivo resolve uma rubrica versionada e passa a integrar o `DirectorRun`. Enquanto a run está em rascunho, a escolha pode ser corrigida; depois da aprovação, qualquer mudança cria uma nova run, incrementa a versão e referencia a anterior.

Projetos antigos podem manter objetivo ausente, sem inferência automática. Novas produções persistem a seleção feita pelo owner.

## Consequências

- o Diretor recebe um critério estratégico explícito;
- troca de objetivo não reinterpreta silenciosamente decisões aprovadas;
- interface, domínio e testes compartilham o mesmo catálogo de oito objetivos.
