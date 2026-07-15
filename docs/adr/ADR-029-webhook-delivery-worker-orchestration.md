# ADR-029 — Orquestração do worker de webhook deliveries

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

Claim, lease e dispatcher já existiam como boundaries separados. Sem uma orquestração única, cada host poderia esquecer heartbeat, interpretar `stale` como sucesso, processar tenants sem justiça ou registrar material sensível. O loop também precisa parar sem abandonar uma tentativa que já entrou em rede.

## Decisão

- Um runner executa exatamente uma unidade `claim → heartbeat → dispatch → settlement` para um workspace explícito.
- Claim ocioso retorna `null` e não agenda heartbeat nem abre secret.
- O heartbeat começa somente depois do claim, não permite renovações sobrepostas e continua durante abertura do secret, DNS e HTTPS.
- Intervalo de heartbeat deve ser menor que o lease. O factory valida essa relação antes de iniciar trabalho.
- Erro ou rejeição de heartbeat interrompe novas renovações. O dispatcher ainda precisa concluir pelo fence; resultado `stale` é apresentado como `lease-lost`.
- Settlement bem-sucedido é a autoridade final. Um heartbeat concorrente que perde a corrida porque o settlement já limpou o lease não converte sucesso durável em falha.
- O outcome contém apenas workspace, delivery, attempt e estado seguro. Token, URL, chave, payload, headers e resposta não aparecem em callbacks.
- O loop recebe uma lista explícita de workspaces autorizados ao shard, limitada a 1.000 IDs únicos.
- Cada passagem processa no máximo uma delivery por workspace e segue ordem round-robin, evitando que um tenant com backlog monopolize o processo.
- Erro de uma iteração é reportado somente com workspace ID e não interrompe os demais tenants.
- O loop só dorme quando todos os workspaces estão ociosos. O poll é interrompível por `AbortSignal`.
- Desligamento gracioso impede novos claims e permite que a iteração em andamento termine seu settlement.
- Provider de secrets e lista de workspaces permanecem dependências do host. Não existe descoberta global ou fallback de chave implícito.

## Consequências

- Um host não precisa reproduzir manualmente as regras de lease e fencing.
- Justiça entre tenants é determinística dentro de cada shard.
- Escala horizontal continua segura porque o claim é CAS e workspace-scoped.
- O deployment precisa fornecer o shard de workspaces e um provider confiável. Descoberta dinâmica e rebalanceamento pertencem a um scheduler posterior.
- Métricas e logs podem consumir outcomes seguros sem risco de vazar credenciais.

## Evidências exigidas

- runner ocioso não chama heartbeat nem dispatcher;
- dispatch longo recebe heartbeat durante a rede;
- heartbeat perdido + settlement stale resulta em `lease-lost`;
- sucesso persistido não é rebaixado por heartbeat concorrente tardio;
- erro de um workspace não bloqueia o próximo;
- callbacks e outcomes não contêm token ou secret;
- workspace duplicado, owner inseguro e intervalos inválidos falham antes do loop;
- integração Prisma executa claim → dispatch assinado → settlement pelo runner.
