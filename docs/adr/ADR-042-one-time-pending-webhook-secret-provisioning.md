# ADR-042 — Provisionamento one-shot da chave HMAC pendente

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

O Apollo gerava e cifrava o signing secret de cada endpoint, mas não existia um canal para provisionar a mesma chave no receptor. Como HMAC exige segredo compartilhado, o receptor podia responder ao challenge, porém não conseguia verificar assinaturas das deliveries. Expor novamente uma chave após replay também criaria risco de persistência acidental em ledger, cache ou logs.

## Decisão

- A capability `apollo.webhooks.endpoints.signing-secrets.provision` expõe `POST /v1/webhooks/endpoints/{endpointId}/signing-secrets` sob `webhooks:admin` e confirmação humana.
- O body contém somente `baseRevision`; `Idempotency-Key` é obrigatória e vinculada a workspace, actor, endpoint e revisão solicitada.
- Somente endpoint `pending-verification` pode usar o command. Assim, nenhuma delivery assinada pode estar em voo durante a substituição.
- A operação lê a maior versão, gera 32 bytes aleatórios para a próxima, calcula SHA-256, cifra o valor Base64URL com AES-256-GCM e contexto autenticado e zera o buffer temporário.
- Na mesma transação serializável, o endpoint avança de revisão, o único secret ativo é aposentado, a nova versão e seu payload cifrado são criados e o ledger é concluído.
- A primeira resposta retorna `secretBase64url`, `secretAvailable: true` e 201. Esse é o único momento em que a chave deixa a fronteira protegida do Apollo.
- Replay idêntico retorna 200, os mesmos metadados, `secretAvailable: false` e omite completamente `secretBase64url`.
- O ledger armazena apenas `endpointId` e `secretId`. Plaintext, Base64URL, `keyRef`, nonce, ciphertext e auth tag não entram na resposta persistida.
- Se a primeira resposta for perdida, a chave não é recuperada. O administrador consulta a nova revisão e executa outro provisionamento com nova `Idempotency-Key`, aposentando a versão desconhecida.
- Endpoint ativo, suspenso ou revogado retorna conflito. Rotação ativa será outro contrato, com validade sobreposta e versão de assinatura explícita para proteger deliveries em voo.

## Consequências

- O workflow externo completo passa a ser: criar endpoint, provisionar chave no receptor, configurar verificação HMAC, executar challenge e somente então receber deliveries.
- Agentes externos podem automatizar o provisionamento sem acesso ao banco, `keyRef` ou chave mestra do Apollo.
- A resposta one-shot deve usar `Cache-Control: no-store`, TLS e um cliente que não registre bodies sensíveis.
- A versão v1 criada junto do endpoint pode ser aposentada sem nunca ter sido divulgada; a primeira chave operacional normalmente será v2.

## Evidências exigidas

- primeira resposta contém exatamente 32 bytes em Base64URL e fingerprint correspondente;
- replay nunca contém a chave e devolve o mesmo secret ID/version;
- ledger e payload durável não contêm plaintext;
- retirement, criação do payload, nova revisão e idempotência são atômicos;
- revisão antiga, lifecycle incompatível, workspace ausente e falta de scope falham fechado;
- bytes temporários são zerados e provider abre somente a versão ativa exata;
- OpenAPI, schemas, exemplos, Prisma e jornada HTTP descrevem o mesmo contrato.
