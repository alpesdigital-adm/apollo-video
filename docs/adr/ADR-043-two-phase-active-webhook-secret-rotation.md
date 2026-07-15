# ADR-043 — Rotação HMAC ativa preparada em duas fases

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Trocar imediatamente a chave de um endpoint ativo cria duas corridas. O receptor pode receber uma delivery assinada com a chave nova antes de conseguir instalar a resposta do command. Em paralelo, um worker pode capturar a versão antiga e tentar abri-la depois que ela já foi aposentada. Um overlap apenas nominal não resolve a primeira corrida, pois o Apollo não controla a transação no secret manager do receptor.

## Decisão

- A rotação ativa usa duas fases externas: `stage` e `activate`.
- O F0-054 implementa `stage` em `POST /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations`.
- `stage` exige endpoint ativo, `baseRevision`, `overlapSeconds` entre 60 e 86.400 e `Idempotency-Key`.
- A candidata tem ID, versão, fingerprint e envelope AES-256-GCM próprios, mas fica no agregado `webhook_signing_secret_rotations`; ela ainda não entra em `webhook_signing_secrets` e não pode assinar deliveries.
- A primeira resposta divulga os 32 bytes em Base64URL. Replay devolve o mesmo rotation ID e metadados, sem plaintext.
- A preparação expira em 24 horas. Somente uma rotação `staged` não expirada pode existir por endpoint; uma preparação vencida é marcada `expired` antes da criação seguinte.
- O ledger guarda somente `endpointId` e `rotationId`. O envelope cifrado permanece na tabela protegida e nunca compõe resposta, log ou registro idempotente.
- A fase futura `activate` confirmará explicitamente que o receptor instalou a candidata, moverá seu envelope para o secret ativo e iniciará o overlap da versão anterior.
- Durante o overlap, novas deliveries usam somente a candidata; a chave anterior pode ser aberta apenas para attempts que capturaram sua versão antes do corte. Depois do prazo, ela deixa de ser abrível.

## Consequências

- Nenhuma delivery muda de assinatura no instante em que o administrador recebe a chave candidata.
- Receptores podem aceitar chave atual e candidata antes do corte, sem janela de rejeição.
- O `overlapSeconds` é registrado no preparo e não pode ser alterado silenciosamente na ativação.
- Perder a primeira resposta não autoriza recuperar a chave. A rotação deve expirar ou ser cancelada e uma nova candidata deve ser gerada.
- Suspensão ou revogação posterior do endpoint impede a ativação, mesmo que a preparação ainda exista.

## Evidências exigidas

- `stage` preserva exatamente uma chave ativa e não cria a candidate version na tabela de secrets;
- plaintext aparece somente na primeira resposta e buffers temporários são zerados;
- replay, ledger, OpenAPI e respostas não contêm `keyRef`, ciphertext, nonce ou auth tag;
- workspace, actor, lifecycle, revisão, TTL e concorrência falham fechado;
- preparação expirada pode ser substituída, mas duas preparações abertas não podem coexistir;
- a futura ativação deve testar explicitamente delivery capturada antes do corte e aberta durante o overlap.
