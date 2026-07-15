# ADR-035 — Coordenação durável de shards do worker de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

O discovery já dividia workspaces por hash estável, mas cada réplica precisava receber manualmente um `shardIndex` exclusivo. Configurações duplicadas desperdiçavam capacidade; um índice ausente deixava parte dos workspaces sem varredura. As leases de delivery impediam execução concorrente da mesma tentativa, porém não garantiam cobertura operacional equilibrada do conjunto de shards.

## Decisão

- Cada pool configura somente um `shardCount` comum. Réplicas não recebem mais um índice estático.
- A tabela `webhook_worker_shard_leases` possui exatamente um slot por combinação `poolId + shardIndex` e no máximo um slot por `poolId + leaseOwner`.
- Claim remove leases expiradas, rejeita topologia ativa com outro `shardCount` e ocupa deterministicamente o menor índice livre.
- Disputas de unicidade retornam ausência de slot e são repetidas pelo loop; não criam dois donos.
- A lease usa ID UUID, owner único e token de alta entropia. Somente o hash do token é persistido.
- Heartbeat e release exigem ID, pool, coordenadas, owner e token hash exatos. Heartbeat exige lease ainda válida e relógio não regressivo.
- A lease dura inicialmente 30 segundos, com heartbeat a cada 10 segundos. Duração, heartbeat e retry são configuráveis dentro de limites fechados.
- Perda ou erro de heartbeat aborta imediatamente o loop atribuído. O worker tenta release cercado e volta a disputar um slot.
- `SIGINT`/`SIGTERM` aborta o shard atual, espera trabalho em andamento respeitar seu próprio fencing e libera o slot.
- A assignment coordenada alimenta o mesmo discovery determinístico existente. Leases de delivery continuam sendo a autoridade final contra execução duplicada durante sobreposição transitória ou failover.
- Coordenação é infraestrutura interna e não recebe capability pública de mutação. Diagnóstico operacional futuro poderá expor somente metadados redigidos.

## Consequências

- Réplicas podem iniciar com a mesma configuração de pool e contagem; os índices são distribuídos automaticamente.
- Queda de uma réplica deixa o slot recuperável após expiração, sem intervenção manual.
- Alterar `shardCount` exige drenar ou expirar todas as leases do pool, evitando duas topologias simultâneas.
- Um pool com mais réplicas que slots mantém excedentes em espera; com menos réplicas, alguns slots permanecem livres e podem ser ocupados assim que nova capacidade entrar.
- O replay por intervalo continua sendo uma operação administrativa separada e não interfere na garantia at-least-once do fluxo normal.

## Evidências exigidas

- contrato mantém token bruto fora dos comandos persistidos e usa apenas seu hash em heartbeat/release;
- loop executa somente o shard adquirido e sempre tenta release no shutdown;
- integração Prisma cobre ocupação de todos os slots, espera do excedente, rejeição de topologia divergente, fencing de heartbeat, expiração, takeover e release antigo inofensivo;
- migration impõe coordenadas, identidade, token, datas e unicidade;
- worker não aceita mais `shardIndex` manual.
