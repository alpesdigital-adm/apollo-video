# Plano de execução progressiva — Waves 31 a 40

> **Estado de execução (2026-10-05).** As dez waves foram executadas a partir de `main` `dd2fb2b9` em quatro frentes paralelas (W31–W33, W34–W35, W36, W37–W39) e integradas em `claude/waves-31-40-integration`, onde a W40 consolidou a jornada. A jornada pública integrada W29–W40 passou em runs locais consecutivos no harness supervisionado (PostgreSQL 16 descartável, `next start`, Chromium, sessão humana real, zero backends e browser terminal no postflight). Cada pacote traz sua seção "Checkpoint técnico executado" com casos provados, origem controlada x runtime e lacunas; `docs/quality/project-status.json` registra implementação, integração, E2E controlado, CI, implantação e aceite separadamente. Lacunas principais: W35 com estados majoritariamente de seed PostgreSQL controlado; W36 cobre só eventos de administração de projeto; W40 prova o destino `?mode=review`, mas o editor ainda não lê `mode`. Nenhuma caixa do `TODO.md` foi remarcada; implantação DigitalOcean e aceite do proprietário continuam pendentes. O texto abaixo é o plano original.

**Planejamento, sem execução W31–W40.** Base de referência: `main` `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`; CI `37167702546` verde nessa base. Confirmar ambos novamente antes de iniciar cada wave. As dez waves estão na **fila de validação/implementação incremental**, embora haja runtime parcial em F1.001–F1.003. Nenhuma caixa do `TODO.md` é remarcada por este plano; implantação na DigitalOcean, produção e aceite do proprietário não são alegados.

| Ordem | Foco e pacote | Dependência | Estimativa de desenvolvimento |
| --- | --- | --- | --- |
| W31 | [Oito filtros combinados](PACOTE-WAVE31-FILTROS-COMBINADOS.md) | W30 | 2–3 h |
| W32 | [Paginação e ordem estável](PACOTE-WAVE32-PAGINACAO-DASHBOARD.md) | W31 | 3–4 h |
| W33 | [Isolamento de workspace](PACOTE-WAVE33-ISOLAMENTO-DASHBOARD.md) | W32 | 2–3 h |
| W34 | [Agregado público do card](PACOTE-WAVE34-AGREGADO-DASHBOARD.md) | W33 | 3–4 h |
| W35 | [Estados, ação e progresso](PACOTE-WAVE35-ESTADOS-DASHBOARD.md) | W34 | 3–4 h |
| W36 | [Atualização por evento real](PACOTE-WAVE36-EVENTOS-DASHBOARD.md) | W35 | 4–6 h |
| W37 | [Renomear projeto](PACOTE-WAVE37-RENOMEAR-PROJETO.md) | W36 | 2–3 h |
| W38 | [Arquivar e restaurar](PACOTE-WAVE38-ARQUIVAR-RESTAURAR.md) | W37 | 3–4 h |
| W39 | [Duplicação copy-on-write](PACOTE-WAVE39-DUPLICACAO-COPY-ON-WRITE.md) | W38 | 3–4 h |
| W40 | [Jornada consolidada](PACOTE-WAVE40-JORNADA-CONSOLIDADA-DASHBOARD.md) | W31–W39 | 3–4 h |

As horas são **estimativas de desenvolvimento, não SLA**; CI e revisão independente ficam fora da estimativa. Uma dependência que falhe bloqueia a próxima wave sem falsificar conclusão. Os mesmos IDs TODO reaparecem em waves diferentes porque cada uma comprova um **subescopo da mesma caixa**, não porque criam dez entregas distintas. O registro canônico de status deve manter estado, prova e bloqueios de cada wave separados de implantação e aceite.

Cada execução deverá usar PostgreSQL/HTTP/Chromium isolados e sessão humana real onde houver UI, com owner, prazo, `application_name` conferido, zero backends/processos próprios no postflight e artifact sanitizado vinculado ao SHA efetivo. O harness público atual pode ser ampliado após os asserts baseline; fixtures que alterem contagens antigas ficam depois do baseline ou em suíte isolada. Um browser ou banco indisponível falha a prova, sem skip. O guard preserva as provas W29/W30. Não usar DigitalOcean de produção para desenvolvimento/E2E, não usar dados de produção, provider fake como integração real nem evento sintético como E2E.

Ao terminar uma wave, Astra registra implementação, integração, E2E controlado, CI, implantação e aceite como estados distintos; Luna revisa leitura/provas, Sol escreve o slice autorizado, Astra testa/integra/entrega. Se escopo ou orçamento crescer, fechar um resultado parcial documentado e manter a caixa aberta. W36 possui lacuna arquitetural real e pode terminar bloqueada sem abrir uma décima primeira wave automaticamente.
