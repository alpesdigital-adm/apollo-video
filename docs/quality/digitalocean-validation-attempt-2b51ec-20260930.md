# W27/W28 — terceira tentativa DigitalOcean, 30/09/2026

**Não homologado. Recursos da tentativa excluídos e verificados.** Horários UTC.

- Código `60d9c489debdd09477aa0193ea73855ffdf848b6`, PR #67 integrada; CI `36753849046` passou nos dois jobs. Next.js/eslint-config-next 16.3.6; observabilidade do monitor e preflight de 300 segundos integrados.
- Run `w2728-260930-2b51ec`; droplet `605038679`; região NYC3 autorizada. Controller no Agendador, PID50728, iniciou às 18:19.
- Preflight remoto comprovado por 300.002 segundos. Bootstrap chegou à preparação do Docker; runner e PostgreSQL não foram despachados.
- Às 18:32:10 o controller encerrou por `TimeoutError`. O guard registrou `SSH stdin EOF; owner disconnected`, executou postflight e terminou. O ponto exato que originou o timeout no controller não ficou identificado; não atribuir causa ao monitor, SFTP ou rede sem evidência adicional.
- Recuperação somente leitura confirmou PID1509 terminal e preservou postflight, amostras e diagnóstico. Inspeção posterior de 120 segundos/13 amostras verificou ausência de containers do run e processos Node/FFmpeg/PostgreSQL/guard. Sem PostgreSQL criado, contagem de backends é não aplicável, não uma consulta SQL com zero.
- API confirmou GET404 do droplet às 18:39:25, firewall às 18:39:26 e tag às 18:39:27. Snapshot240076873 preservado. Tarefa local removida, PID50728 terminal e chave de host efêmera removida.
- Não houve jornada do produto nem MP4 nesta tentativa. Nenhum aceite TODO/PRD.
- Estimativa compute das três tentativas: US$ 0.212568, baseada no preço horário da API até confirmação da exclusão; não é fatura.

## Bloqueio

As três tentativas falharam em fronteiras operacionais distintas: identidade provisória, timeout do monitor durante build e timeout do controller com desconexão SSH. Não iniciar uma quarta tentativa por correção especulativa. É necessário revisar o controle de execução/transferência/observação, preservar causa e estado em todas as fronteiras e obter uma reprodução verificável antes de nova provisão. Não relaxar limites nem gates; não confundir CI verde com homologação.
