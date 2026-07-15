# ADR-045 — Cancelamento terminal e descarte do envelope HMAC

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Uma candidata preparada contém material HMAC cifrado que ainda não participa de deliveries. Se o receptor não conseguir instalá-la, o administrador precisa encerrar o preparo sem esperar o TTL e sem deixar o envelope recuperável. Suspender ou revogar o endpoint não deve impedir essa redução de risco. Em contrapartida, uma rotação já ativada representa histórico real e não pode ser “desfeita” por cancelamento.

## Decisão

- O cancelamento é exposto por `POST /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/cancel`.
- O body contém somente a `baseRevision` registrada no preparo; autenticação exige `webhooks:admin` e isolamento por workspace.
- Rotação `staged` dentro do prazo passa a `cancelled`. Se `cancelledAt >= expiresAt`, passa a `expired`.
- Em ambos os casos, algoritmo, key ID, nonce, ciphertext e auth tag intermediários são zerados logicamente na mesma transação.
- Endpoint ativo, suspenso ou revogado pode cancelar. A operação não altera seu lifecycle nem sua revisão.
- Rotação `cancelled` ou `expired` converge com `replayed: true`, limpando também envelopes residuais de versões anteriores do fluxo.
- Rotação `activated` retorna conflito; rollback de signing secret ativo exige uma nova rotação, nunca mutação do histórico.
- O replay da preparação original só é válido enquanto a rotação permanece `staged`. Estado terminal retorna conflito para preservar o schema público.
- A preparação também recusa fingerprint igual à chave ativa, protegendo contra RNG/provider defeituoso.

## Consequências

- Chave candidata nunca ativada deixa de existir de forma recuperável imediatamente após cancelamento ou expiração observada.
- Cancelamento não cria signing secret, não troca assinatura e não interfere em deliveries em voo.
- O mesmo endpoint pode preparar nova candidata após o estado terminal.
- Consulta/listagem administrativa será o mecanismo para observar histórico sem reabrir envelopes.

## Evidências exigidas

- staged vira cancelled ou expired atomicamente com payload intermediário nulo;
- replay terminal é convergente e revisão divergente falha;
- activated não pode ser cancelada;
- nenhuma candidate version cancelada aparece em `webhook_signing_secrets`;
- suspensão/revogação do endpoint não bloqueia descarte;
- respostas, ledger e logs não contêm plaintext, keyRef ou envelope;
- OpenAPI, schemas, testes Prisma e jornada HTTP refletem o mesmo lifecycle.
