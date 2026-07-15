# ADR-030 — Descoberta e sharding de workspaces com webhook executável

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O runner de deliveries exige um workspace explícito para preservar isolamento de tenant, mas uma lista estática não acompanha novos destinos, retries vencidos ou leases expirados. Consultar todos os workspaces em memória também não escala, e dividir por posição de página faria um workspace mudar de worker conforme a base crescesse.

## Decisão

- O repositório descobre somente workspaces ativos que possuam delivery executável ligada a subscription e endpoint ativos.
- São executáveis: `pending` ou `retry-scheduled` com `nextAttemptAt <= asOf`, e `in-flight` com lease expirado em `asOf`.
- O instante `asOf` é fixado na primeira página e carregado no cursor. Workspaces e deliveries criados depois dele ficam para o ciclo seguinte.
- A paginação usa `workspaceId` crescente como high-water mark. O repositório deve devolver IDs estritamente ordenados, únicos e dentro do limite solicitado.
- O cursor v1 é opaco, canônico e vinculado por SHA-256 às coordenadas `shardIndex/shardCount`. Reutilizá-lo em outro shard falha fechado.
- O shard é `uint32(SHA-256(workspaceId)[0..3]) mod shardCount`, estável e independente da ordem ou do volume de páginas.
- `shardCount` é limitado a 1.024 e cada página examina de 1 a 500 workspaces. A filtragem por shard ocorre depois do high-water global, portanto páginas vazias ainda podem possuir continuação.
- O scheduler percorre todas as páginas do ciclo e executa no máximo uma delivery por workspace descoberto. IDs repetidos entre páginas são ignorados.
- Cursor repetido encerra o ciclo e gera callback seguro de erro, evitando loop infinito por implementação defeituosa.
- Erro de discovery encerra apenas o ciclo corrente; erro de um workspace não impede os demais. Polling ocorre somente quando nenhuma delivery foi processada.
- O banco recebe índices compostos por workspace, status e instante de elegibilidade para sustentar a consulta sem varredura global de deliveries.
- O deployment continua responsável por atribuir coordenadas de shard exclusivas. Alterar `shardCount` pode redistribuir workspaces, mas claim com CAS e fencing mantém a execução segura durante a transição.

## Consequências

- Novos workspaces, retries vencidos e leases abandonados entram automaticamente no worker sem lista estática.
- A paginação tem corte temporal estável para inserções, mas não congela mudanças de status concorrentes; isso é intencional, pois claim e fencing são a autoridade de execução.
- Um workspace pode ser observado por shards antigos e novos durante rebalanceamento. A duplicação de observação é segura; a coordenação operacional ainda deve reduzir trabalho desperdiçado.
- O scheduler não é uma API pública. Operação externa permanece nos contratos administrativos de webhook e de replay previstos em F0.038.

## Evidências exigidas

- todas as páginas reutilizam o mesmo `asOf` e o relógio é lido uma vez;
- cursor de um shard é rejeitado em outro;
- união dos resultados corresponde ao hash determinístico do shard;
- repository ignora workspaces e deliveries criados depois de `asOf`;
- delivery futura não aparece antes de `nextAttemptAt` e aparece quando vence;
- workspace repetido entre páginas roda uma única vez por ciclo;
- cursor repetido não cria loop infinito;
- integração Prisma percorre elegibilidade e runner até settlement.
