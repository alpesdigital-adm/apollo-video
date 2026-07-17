# ADR-093 — Client não pode autoelevar scopes

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Um administrador de client só pode delegar scopes que já possui, dentro do mesmo
workspace. O bloqueio ocorre antes da persistência e é coberto por unit test e
jornada HTTP real com resposta 403 e isolamento cross-workspace.
