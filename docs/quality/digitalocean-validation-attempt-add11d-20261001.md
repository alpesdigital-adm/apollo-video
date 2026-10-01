# W27/W28 — tentativa DigitalOcean add11d, 2026-10-01

## Resultado: não homologado

A rodada `w2728-261001-add11d`, autorizada pelo owner ao pedir para prosseguir após o CI Linux, executou o commit `2a527b225b5c4360b028bcd3827ef446f29a52ad`. Os CIs anteriores da PR e do main estavam aprovados; isso não substituiu a execução remota.

- Droplet descartável: `605314705`, NYC3, `s-8vcpu-16gb-intel`, criado às `2026-10-01T16:26:16Z`.
- Firewall exclusivo: `5e2c65d1-71ca-4173-89b8-dad6cd926e97`.
- Owner: `astra-w2728-261001`; controlador local PID `31944`, guard remoto PID `1505`.
- Bundle SHA-256: `bb738e01ed00f60f01c85f6b31e7f9550450f879d9461226807dc21336b9091d`.
- Inventário e VPC vazia, identidade SSH, disponibilidade e preço foram revalidados antes da criação. Preço observado: US$ 0,16667/h. Snapshot preexistente preservado; nenhuma alteração de produção, DNS ou provider pago.

## Evidência de execução

O preflight registrou cinco minutos de estabilidade. Upload e readback do bundle terminaram com integridade conferida. Build da imagem de runner, inicialização do PostgreSQL e configuração do banco dedicado passaram.

Resultados do batch:

| Etapa | Exit code |
|---|---:|
| whitespace | 0 |
| npm-ci | 0 |
| remotion-ci | 0 |
| prisma-generate | 124 |

`prisma-generate` excedeu o limite de 180 segundos. Não houve E2E concluído, screenshot de aceite nem MP4. O postflight registrou `work_outcome=failed`, `cleanup_ok=true`, runner e PostgreSQL parados e `orphan_backends=0`. Foram recolhidas 251 amostras de monitoramento; o encerramento incluiu uma janela de postflight de 60 segundos. O timeout desta etapa não demonstra regressão do produto nem identifica sua causa interna.

## Cleanup confirmado, com reconciliação do owner

O controlador registrou `needs_owner_intervention` em `collect_and_cleanup`, depois de emitir o intent de exclusão do droplet. A consulta posterior do owner retornou HTTP 404 para esse droplet: não foi enviada uma segunda exclusão.

Após confirmar que a tarefa local estava `Ready`, com resultado 1 e PID encerrado, o owner adquiriu o mesmo lock operacional. O contrato `terminal_ready` e a inspeção de identidade dos recursos restantes passaram. O cleanup existente foi usado para remover somente firewall e tag exclusivos. Readback às `2026-10-01T17:11:36.631871+00:00`:

- droplet: HTTP 404;
- firewall: HTTP 404;
- tag: HTTP 404;
- snapshot `240076873`: HTTP 200, preservado.

A tarefa agendada foi removida após confirmação de terminalidade. O erro exato da interrupção do cleanup automático não foi determinado; a reconciliação não é prova de correção desse caminho.

## Limitação de diagnóstico e orçamento

O log interno `prisma-generate.log` não foi recolhido antes da exclusão da VM. Os resultados de fase e o postflight sobrevivem, mas não permitem atribuir o timeout a CPU, download, Prisma ou outra causa. A coleta de diagnóstico de falhas precisa preceder o descarte, sem expor credenciais e sem impedir cleanup seguro.

Estimativa conservadora de compute, usando como término a confirmação final do cleanup: US$ 0,1259576983 nesta rodada e US$ 0,4449129104 acumulados. Não é fatura. Saldo estimado sob o teto de US$ 1: US$ 0,5550870896; outra janela máxima de quatro horas ao preço observado não cabe nesse saldo. Nenhuma sexta VPS foi criada.

Evidências privadas fora do repositório: diretório `w2728-261001-add11d` do operador, com `postflight.json`, `samples.jsonl`, `batch-results.jsonl`, `visual-inventory.json`, `manual-cleanup-result.json` e `attempt-cost-estimate.json`.

W27/W28 continuam sem aceite DigitalOcean/MP4. TODO e PRD não foram promovidos. Esta nota registra uma tentativa falha e o descarte comprovado, não entrega do produto.
