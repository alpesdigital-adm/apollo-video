# ADR-016 — Agendamento durável de retry e esgotamento

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

Uma falha recuperável não pode devolver a operação imediatamente à fila. Sem uma data de disponibilidade persistida, workers reiniciados entram em loop quente, aumentam custo e pressionam renderer, storage e providers. Também é necessário distinguir uma falha não recuperável de uma operação que consumiu todas as tentativas disponíveis.

## Decisão

- Cada falha recuperável persiste `nextAttemptAt` junto da transição para `retrying` e da liberação da lease.
- O atraso é exponencial e determinístico: 5 segundos na primeira falha, dobrando por tentativa até o teto padrão de 5 minutos.
- Base e teto podem ser configurados no worker; valores inválidos fazem a inicialização falhar fechada.
- `claimNext` ignora operações `retrying` antes de `nextAttemptAt` e aceita o instante exato de disponibilidade.
- O domínio também recusa iniciar a tentativa antes da data, evitando depender apenas do filtro do banco.
- Ao iniciar nova tentativa, `nextAttemptAt` é limpo atomicamente com o novo fencing token.
- Falha originalmente recuperável na última tentativa, inclusive lease expirada, termina como `failed` não retentável e recebe `deadLetteredAt` igual a `completedAt`.
- Falha não recuperável termina sem `deadLetteredAt`; isso preserva a distinção entre rejeição definitiva e esgotamento.
- `nextAttemptAt` e `deadLetteredAt` permanecem internos nesta versão. Retry manual e listagem ganharam contratos externos próprios nos ADR-018 e ADR-019, sem expor esses checkpoints internos.

## Consequências

- Restart não remove nem antecipa a espera já decidida.
- Vários workers continuam disputando somente operações disponíveis, usando o fencing já definido no ADR-014.
- A política não usa jitter nesta etapa; workloads com grande fan-out poderão adicionar jitter determinístico sem alterar os timestamps já persistidos.
- `deadLetteredAt` é o checkpoint durável para futura fila administrativa e replay controlado, não uma autorização automática para reexecutar.
- O ADR-017 entrega cancelamento e o ADR-018 entrega retry manual como commands e scopes próprios. Audit trail agregado e administração de dead-letter continuam separados.

## Evidências exigidas

- crescimento exponencial, teto e tentativas extremas sem overflow;
- recusa antes de `nextAttemptAt` e claim no instante exato;
- persistência da espera após liberação da lease;
- esgotamento por falha e por lease expirada marcado como dead-letter;
- campos internos ausentes do presenter público v1;
- constraint PostgreSQL impedindo combinações incoerentes de status e datas.
