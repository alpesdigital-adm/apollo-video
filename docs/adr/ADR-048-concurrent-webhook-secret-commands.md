# ADR-048 — Concorrência e perda de resposta nos comandos de secret de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Comandos externos podem ser repetidos porque duas automações agiram ao mesmo tempo, porque o cliente perdeu a resposta depois do commit ou porque uma rotina de higiene concorreu com outra réplica. No ciclo de signing secrets, uma resolução ambígua poderia divulgar uma candidata duas vezes, reutilizar versão cancelada, ativar e cancelar o mesmo preparo ou contar duas vezes o mesmo material destruído.

## Decisão

- Duas preparações simultâneas com o mesmo `Idempotency-Key` e fingerprint de request convergem para um único rotation ID e um único commit.
- Somente a execução vencedora pode devolver `secretBase64url`; a concorrente recebe replay redigido com `secretAvailable=false`.
- Se a primeira resposta for perdida depois do commit, repetir o mesmo request devolve o registro persistido, mas nunca recupera o plaintext one-shot.
- Versões candidatas são monotônicas considerando tanto secrets materializados quanto rotações terminais. Cancelar ou expirar v3 reserva v3 definitivamente; a próxima candidata é v4.
- Ativar e cancelar simultaneamente o mesmo preparo têm um único vencedor terminal. O resultado durável é `activated` ou `cancelled`, nunca ambos, e exatamente um signing secret permanece ativo.
- Higienes simultâneas usam transação serializável e repetem automaticamente até três vezes em conflitos de serialização. As chamadas convergem: cada candidato é contabilizado e destruído uma única vez.
- Depois de três conflitos de serialização, a operação falha explicitamente com `PERSISTENCE_CONFLICT`; não oculta sucesso desconhecido.
- As regressões concorrentes são executadas contra o adapter real e repetidas localmente para capturar interleavings diferentes.

## Consequências

- Retry de transporte é seguro, mas não recupera secrets one-shot.
- Callers podem repetir higiene após conflito ou enquanto `hasMore=true`.
- O lifecycle terminal, e não a ordem de resolução das Promises, define o resultado observado.
- Os testes aceitam qualquer vencedor legítimo da corrida ativar/cancelar, mas exigem invariantes idênticos em todos os interleavings.

## Evidências exigidas

- duas preparações simultâneas geram exatamente um commit, um disclosure e um replay redigido;
- perda simulada depois do commit converge sem novo disclosure;
- versão cancelada não é reutilizada;
- ativação contra cancelamento produz exatamente um vencedor e uma chave ativa;
- duas higienes simultâneas somam uma única expiração, um único envelope e um único payload destruído;
- cinco execuções locais consecutivas permanecem verdes antes da publicação;
- PostgreSQL hospedado confirma os mesmos invariantes sob isolamento serializável.
