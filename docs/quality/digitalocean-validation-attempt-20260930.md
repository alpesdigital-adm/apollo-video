# Homologação DigitalOcean W27/W28 — tentativa de 30/09/2026

**Resultado: não homologado. Contenção e exclusão verificadas.** Horários em UTC.

- Código: main `4def1b36c0c17c0f2e81f35b43a5f8d2d4078f1a`; PR #66; CI `36727261869` aprovado nos dois jobs. Isso não equivale à homologação.
- Run: `w2728-260930-1675b3`, NYC3, plano autorizado de 8 vCPUs/16 GiB.
- Droplet `604988363`, criado às 14:46:26. Identidade e SSH pinned confirmados; bootstrap, fonte verificada, runner e PostgreSQL criados.
- 19 fases retornaram exit 0: whitespace, npm-ci, remotion-ci, prisma-generate, security-audit, security-audit-remotion, architecture, eslint, domain, infra-contracts, platform, public-api, parity, migration-validation, typecheck, focused-w28-regressions, migration, remotion-bundle, browser-presence.
- Interrupção durante `next-build`: `GateClosed: monitor: GateClosed: command deadline exceeded`. A mensagem não identifica qual comando do monitor excedeu o prazo; não há causa específica comprovada.
- 221 amostras registradas: CPU busy máxima 19,4842%, steal máximo 3,0149%, load/CPU máximo 0,372925; memória disponível mínima 11.359.380 KiB. Nenhuma razão de limiar nas amostras persistidas. Isso não valida a coleta que falhou nem exclui uma anomalia não registrada.
- O guard encerrou runner e PostgreSQL, com zero backends órfãos observado, mas registrou `cleanup_ok=false`/`cleanup_outcome=unverified` por falha do monitor. O controller bloqueou exclusão automática (`terminal_evidence_incomplete`).
- Contenção posterior: uma única conexão SSH pinned, somente leitura; 120 segundos/13 amostras; PID antigo 1502 ausente; ambos containers com identidade do run, parados e PID 0; nenhum Node/FFmpeg/PostgreSQL/guard remanescente; inspector encerrado e SSH fechado. Essa prova separada não altera nem torna verde o resultado original.
- Exclusão por API confirmada com GET 404: droplet às 15:32:36, firewall às 15:32:37, tag às 15:32:38. Snapshot `240076873` preservado; zero droplets com a tag. Tarefa local removida e PID34264 terminal; chave de host efêmera removida.
- Nenhum MP4 ou evidência visual coletado; `visual_directory_unavailable`. W27/W28 permanecem sem aceite remoto. TODO/PRD não promovidos.
- Estimativa compute desta tentativa: US$ 0.128285; somada à tentativa anterior: US$ 0.156564, baseada no preço horário da API até a confirmação de exclusão. Não é fatura.

## Gate de retomada

A falha do monitor interrompe a operação. Nenhum novo teste/deploy/restart remoto foi iniciado. Retomada exige autorização explícita do owner e os critérios de estabilidade do AGENTS.md; o diagnóstico/correção deve preservar os limites e a política fail-closed, sem aumentar timeout ou orçamento por suposição. Investigar o comando exato e reproduzir antes de corrigir.

Atualização local de 30/09, antes da correção abaixo: a autorização explícita
do owner para retomar após correção/validação do monitor e cinco minutos de
estabilidade já foi recebida; isso não dispensa gates. Naquele momento, o slice
de instrumentação ainda não havia passado na suíte ops; segue sem validação
Linux e sem autorização operacional para rodada agora. A instrumentação visa
somente corrigir a perda comprovada de
atribuição/diagnóstico; a causa específica do timeout original permanece
desconhecida, sem comprovação de falha Docker ou throttling cgroup. Timeout
injetado em teste não reproduz o incidente.

Correção local posterior à revisão independente: o probe registra `failed` com
estado e return code do subprocesso mesmo quando o leitor de output não encerra
após o join de 8 segundos; erro ao fechar o pipe não suprime esse evento. O
watchdog exige preflight de pelo menos 300 segundos/30 amostras e postflight de
60 segundos/6 amostras. Testes RED reproduziram ambos os blockers; a suíte ops
local depois da correção passou: 158 testes, 6 skips (Windows). Testes de
contrato exercitam produtor real com relógio/host controlados → watchdog e
controller; nenhuma validação Linux, remota, visual ou aceite foi realizada.
O resultado desta correção não promove o run anterior nem libera rodada remota.

## Evidências preservadas

Evidências privadas do run: `postflight.json`, `original-samples.jsonl`, `original-runner.log`, `manual-containment-postflight.json`, `manual-cleanup-result.json`, `visual-inventory.json`, `attempt-cost-estimate.json` e journal do controller. Não incluir configurações, credenciais, envs ou chaves em pacotes de evidência.
