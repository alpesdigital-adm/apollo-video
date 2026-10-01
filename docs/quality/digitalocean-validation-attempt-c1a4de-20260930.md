# W27/W28 — rodada c1a4de, 30/09/2026

**Não homologada. Contenção e exclusão verificadas.** Horários UTC.

- Commit `ac7b834e036571f15f7e047ae7d5326dace17226`, PR #68; CI `36786776983` aprovado nos dois jobs. Revisão Luna sem blockers; Astra repetiu ops (170 testes, zero falhas/erros, seis skips Windows), arquitetura, infraestrutura e whitespace. CI Linux passou separadamente.
- Run `w2728-260930-c1a4de`, droplet `605103460`, NYC3 Intel 8 vCPU/16 GiB. Criado em 30/09/2026 às 23:14:35. Executor Agendador PID18956, sem dependência do chat na chamada do controlador.
- Preflight remoto de 300 segundos concluído. Transferência do source concluiu às 23:33:02, com 53.299.200 bytes enviados e relidos, tamanho e SHA conferidos antes do marker. Não houve timeout nessa transferência.
- O guard concluiu build do runner, pull/start do PostgreSQL, bootstrap SQL e criação do runner. O batch registrou somente `whitespace` com exit 0 e início de `npm-ci`.
- O monitor interrompeu o trabalho por `pg_connections`: a amostra registrou `total=7`, `max_connections=40`, `ours=0`, `strangers=1`. As amostras anteriores tinham total 6/strangers 0; a seguinte voltou a total 6/strangers 0. Os probes de atividade PostgreSQL terminaram com exit 0, sem timeout. O bloqueio não foi por ultrapassar metade de max_connections, nem pelo prazo de quatro horas.
- O registro não preservou o `backend_type` da linha classificada como estranha. A hipótese de atividade interna PostgreSQL requer reprodução; não afirmar retrospectivamente autovacuum, cliente externo ou relação com recusa da IA.
- O guard parou runner e PostgreSQL e observou zero backends do run, mas manteve `cleanup_ok=false` pela falha sticky do monitor. O controlador terminou em `collect_and_cleanup` com `terminal_evidence_incomplete`, sem deleção automática nem aprovação retroativa.
- Depois de confirmar Agendador terminal/exit 1 e PID18956 ausente, Astra fez uma única inspeção SSH pinned de contenção: 120 segundos/13 amostras, guard PID1500 ausente, containers com identidade do run parados/PID0, nenhum Node/FFmpeg/PostgreSQL/guard restante. Inspector terminal e SSH fechado.
- API confirmou GET404 do droplet às 23:52:52, firewall `507408fa-1b15-4fa8-a684-181b4e081e56` às 23:52:53 e tag às 23:52:54. Snapshot240076873 preservado, zero droplets com a tag. Tarefa removida e chave de host efêmera apagada.
- Nenhum MP4/captura de UI foi produzido; `visual_directory_unavailable`. TODO/PRD não promovidos.
- Estimativa acumulada de compute das quatro tentativas: US$ 0,318955; não é fatura.

## Próximo gate

Verificar a classificação SQL do monitor em PostgreSQL descartável local. `pg_stat_activity` contém processos internos além de clientes; a consulta usada nesta rodada não discrimina `backend_type` ao contar strangers. Uma correção precisa preservar o bloqueio de clientes realmente desconhecidos, nome exato do run, contagem conservadora, limites e prova de órfãos. Não desativar proteção, aumentar max_connections nem reutilizar a configuração falha por tentativa cega. Reprodução, revisão e CI precedem qualquer nova rodada, sujeita à autorização e aos limites vigentes.
