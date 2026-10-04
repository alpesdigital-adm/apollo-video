# Plano progressivo Codex — biblioteca de mídia, W41–W50

**Apenas planejamento.** Base documental `dd2fb2b920afec6871221382597965d3caeb9e49`; runtime de referência `1b05a65654fc53c1ee13ffa3ab6deb36c6026455`, cujo CI `37167702546` estava verde. O CI do planejamento `37201179515` estava **em execução** no checkpoint, sem resultado presumido. Confirmar os SHAs e gates antes de iniciar cada wave. W31–W40 foram delegadas ao Claude Code pelo proprietário; isso **não** comprova início, integração ou entrega. W41–W50 pertencem ao fluxo Codex: Astra orquestra, Luna lê, Sol escreve e Astra revisa, testa, integra e entrega.

| Wave | Pacote | Depende de | Desenvolvimento estimado |
| --- | --- | --- | --- |
| W41 | [Paginação unificada da biblioteca](PACOTE-WAVE41-PAGINACAO-BIBLIOTECA.md) | base/W30 | 3–4 h |
| W42 | [Filtros e direitos reais](PACOTE-WAVE42-FILTROS-DIREITOS-BIBLIOTECA.md) | W41 | 3–4 h |
| W43 | [Leituras seguras e retry](PACOTE-WAVE43-LEITURAS-SEGURAS-BIBLIOTECA.md) | W42 | 3–5 h |
| W44 | [Detalhes e previews reais](PACOTE-WAVE44-PREVIEWS-BIBLIOTECA.md) | W43 | 4–6 h |
| W45 | [Segmentos virtuais](PACOTE-WAVE45-SEGMENTOS-VIRTUAIS.md) | W44 | 3–4 h |
| W46 | [Reuso por referência](PACOTE-WAVE46-REUSO-POR-REFERENCIA.md) | W45 | 4–6 h |
| W47 | [Derivadas sob demanda](PACOTE-WAVE47-DERIVATIVES-SOB-DEMANDA.md) | W46 | 6–8 h |
| W48 | [Imagem, OCR e derivadas](PACOTE-WAVE48-IMAGENS-OCR-DERIVATIVES.md) | W47 | 4–6 h |
| W49 | [Catalogação após promoção](PACOTE-WAVE49-CATALOGACAO-APROVADA.md) | W48 | 4–6 h |
| W50 | [Jornada consolidada](PACOTE-WAVE50-JORNADA-CONSOLIDADA-BIBLIOTECA.md) | W41–W49 | 4–6 h |

Total indicativo: **38–55 h de desenvolvimento**, não SLA; CI e revisão independente ficam fora. IDs TODO repetidos significam subescopos e provas progressivas da **mesma caixa**, nunca dez entregas completas. O runtime parcial existente não torna estas waves concluídas. Astra centraliza as atualizações do registro de status e, por wave executada, de TODO/PRD/rastreabilidade conforme evidência; estes pacotes não alteram o runtime do dashboard, o harness W29/W30 ou o CI central em paralelo ao trabalho delegado.

Gates comuns: suíte **separada** da biblioteca, com PostgreSQL/storage/Next/Chromium do próprio run, owner, prazo e `application_name` único; não compartilhar DB/processos com W29/W30 nem com o fluxo W31–W40. Fixtures usam bytes reais controlados, rights/consent e hashes observáveis, sem conteúdo de produção. Classificar cada prova como seed PG controlado, runtime/worker real, HTTP real ou browser real; um não substitui o outro. Autorização/isolamento/rights vêm do backend real; falha de rede controlada deve ser rotulada e não comprova 401/403/429. Artifact sanitizado liga fonte/CI/run, imagens/MP4/bytes por SHA e postflight terminal de browser, app, worker e zero backends. Falha do monitor/cleanup fecha o gate; ausência de prova não vira skip.

Coordenação de integração: Astra é o único owner de alterações compartilhadas em `capability-registry`, schema/migrations, composition root, workflow CI, status e Git remoto. Antes de integrá-las, parar/reconciliar diffs paralelos, obter HEAD/CI remoto atual, aplicar mudanças em série e impedir sobrescrita silenciosa. Não rodar builds, PostgreSQL ou browsers simultâneos sobre a mesma árvore/DB. DigitalOcean só numa operação futura isolada com identidade/orçamento confirmados; nunca usar produção para desenvolvimento. Ao exceder tempo/escopo, registrar parcial e bloqueio, sem marcar checkbox ou aceite.
