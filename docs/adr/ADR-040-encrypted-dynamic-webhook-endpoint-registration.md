# ADR-040 — Cadastro de endpoint com secret dinâmico cifrado

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Endpoints eram registrados apenas por fluxos internos que já recebiam uma referência de chave existente. Isso impedia que um administrador ou agente externo criasse um destino completo sem coordenar manualmente um catálogo estático do worker. Aceitar `keyRef` ou bytes secretos pela API pública transferiria detalhes internos ao chamador e ampliaria a superfície de vazamento.

## Decisão

- A capability `apollo.webhooks.endpoints.create` expõe `POST /v1/webhooks/endpoints` sob `webhooks:admin`, confirmação humana e `Idempotency-Key` obrigatória.
- O body fechado contém somente a URL HTTPS. A API não aceita nem devolve `keyRef`, chave HMAC, ciphertext, nonce, auth tag ou workspace.
- O serviço normaliza e valida a URL, cria endpoint `pending-verification` e gera 32 bytes aleatórios para o signing secret v1.
- O secret bruto existe apenas em memória, é fingerprinted com SHA-256, cifrado com AES-256-GCM usando contexto autenticado que vincula workspace, endpoint, secret, versão e referência interna, e então é zerado.
- Metadados públicos e payload cifrado ficam em tabelas separadas. Endpoint, secret, payload e ledger idempotente são gravados na mesma transação serializável.
- A relação durável vincula exatamente secret ID, workspace, endpoint e versão; constraints verificam algoritmo, versão e formato do envelope cifrado.
- Primeira criação retorna 201; replay idêntico retorna 200 com os mesmos IDs. A mesma chave com outra URL retorna `IDEMPOTENCY_PAYLOAD_MISMATCH`; a mesma URL com outra chave retorna `WEBHOOK_ENDPOINT_ALREADY_EXISTS`.
- O provider do worker abre primeiro o payload cifrado no banco, autentica o contexto e reconfirma o fingerprint. Payload existente porém inválido falha fechado; somente ausência permite fallback opcional ao catálogo legado do ambiente.
- O challenge de verificação continua sendo um command público separado: criar o endpoint não produz tráfego de rede automaticamente.

## Consequências

- O cadastro externo deixa de depender de edição manual de variáveis de ambiente.
- O banco nunca contém bytes HMAC em claro, e a resposta pública expõe apenas fingerprint e versão.
- Rotação futura pode reutilizar o mesmo envelope e provider, criando uma nova versão sem alterar o contrato do endpoint.
- A chave mestra de payload protegido torna-se requisito operacional para criar endpoints e abrir seus secrets dinâmicos.

## Evidências exigidas

- bytes gerados são zerados depois da cifragem e nunca aparecem no bundle durável ou na resposta;
- replay preserva endpoint e secret, sem criar outro payload;
- URL duplicada, payload divergente, workspace/client inválido e disputa concorrente falham atomicamente;
- provider abre apenas identidade exata e falha fechado com chave mestra incorreta;
- OpenAPI declara body fechado, header idempotente e respostas 200/201;
- migração, constraints, Prisma e jornada HTTP cobrem o fluxo real.
