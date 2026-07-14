# ADR-014 — Worker durável de render e fencing de lease

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O endpoint público de render cria uma `PublicOperation`, mas codificação de mídia não pode ocorrer no processo HTTP. Um worker pode cair, perder acesso ao banco ou continuar calculando depois que outro worker recuperou a operação. Sem fencing, o worker antigo poderia promover um resultado obsoleto.

## Decisão

- O processo de render é independente da aplicação web e busca operações persistidas.
- Cada claim grava `leaseOwner`, `leaseExpiresAt`, `heartbeatAt` e incrementa `attempt`.
- Toda mutação do worker usa compare-and-swap sobre operation ID, status, fase, dono, tentativa, validade e versão temporal observada.
- Lease expirada permite novo claim e nova tentativa; o `attempt` funciona como fencing token, portanto comandos da tentativa anterior deixam de vencer.
- Heartbeat só renova lease ainda válida. Falha ou rejeição aborta o renderer e impede novas transições pelo worker antigo.
- A última renovação e a transição para `persisting` acontecem depois da segunda materialização/revalidação e imediatamente antes do commit do output.
- O renderer descarta o arquivo parcial quando o gate pré-commit falha.
- Resultado terminal público referencia somente artifact e manifest. Erros terminais são sanitizados; paths, output keys, stack e detalhes do renderer não são persistidos no contrato público.
- Falha retryable volta a `retrying` enquanto houver tentativas. Backoff exponencial, cancelamento e dead-letter serão adicionados sem alterar o fencing adotado aqui.

## Consequências

- Reinício do processo não perde a operação; leases vencidas são recuperáveis.
- Dois workers podem observar o mesmo candidato, mas somente um claim condicional vence.
- Uma renderização pode consumir trabalho antes de perder a lease, porém não pode promover o partial após o gate rejeitado.
- O commit físico e a conclusão no banco não formam uma transação distribuída. A output key determinística e a futura persistência de artifact/lineage tratarão recuperação após queda entre esses dois passos.
- Operação interna de fila, lease e storage não é exposta como endpoint público.

## Evidências exigidas

- disputa de claim com um único vencedor;
- heartbeat com owner/attempt incorretos rejeitado;
- recuperação após expiração incrementando attempt;
- worker antigo incapaz de avançar fase ou concluir;
- falha no gate pré-commit descartando partial;
- reinício, retry limitado e resultado terminal sem internals.
