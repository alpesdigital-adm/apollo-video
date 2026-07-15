# ADR-028 — Dispatch assinado e seguro de webhook deliveries

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O ADR-027 tornou a posse de uma delivery recuperável e protegida por fencing, mas ainda faltava transformar a tentativa em um request HTTPS. Essa etapa cruza quatro limites sensíveis: reconstrução do evento, abertura da chave, assinatura dos bytes exatos e conexão com um destino controlado pelo cliente. Nenhum desses limites pode conseguir concluir uma tentativa sem o lease atual.

## Decisão

- O dispatcher recebe workspace, delivery, owner, número da tentativa e token bruto do lease. O token é convertido em hash antes de alcançar a persistência.
- O target só é carregado quando todo o fence ainda é válido e quando endpoint e subscription permanecem ativos.
- O evento é reidratado do outbox por `createPublicEvent` e serializado como JSON canônico. O mesmo buffer é assinado e enviado, sem nova serialização intermediária.
- Exatamente um signing secret precisa estar ativo. Ambiguidade, evento corrompido ou referência inválida falham fechados como conflito persistente.
- A persistência devolve somente `keyRef`, versão e fingerprint; bytes da chave pertencem a um `WebhookSigningSecretProvider` injetado.
- O provider abre a chave apenas em memória. O dispatcher copia os bytes, compara SHA-256 com o fingerprint persistido e zera sua cópia no `finally`.
- Divergência de fingerprint é terminal e não abre conexão. Indisponibilidade do provider é retryable.
- HMAC-SHA256 v1 cobre timestamp, event ID e bytes exatos do body. Headers assinados precisam concordar com o event ID antes da conexão.
- Toda tentativa resolve DNS novamente, rejeita o conjunto inteiro se qualquer IP for inseguro e prende HTTPS ao primeiro IP público validado, preservando Host, SNI e certificado do hostname.
- O request usa TLS mínimo 1.2, porta 443, conexão não reutilizada, sem redirect e deadline absoluto. Body é limitado a 256 KiB e resposta a 64 KiB.
- O body da resposta nunca retorna ao domínio; somente status e SHA-256 são persistíveis.
- Respostas 2xx concluem sucesso. 408, 425, 429 e 5xx usam retry; demais respostas são terminais.
- Backoff é exponencial, limitado e recebe jitter determinístico derivado de delivery+attempt, permitindo testes e evitando rajadas sincronizadas.
- Settlement continua condicionado ao fence. Se o lease vencer durante a rede, o resultado vira `stale` e não altera a tentativa retomada.

## Consequências

- Banco, transporte e provider isoladamente não possuem material suficiente para forjar uma conclusão válida.
- O destinatário pode verificar o request com os bytes recebidos e detectar replay pelo event ID.
- Falhas transitórias recebem agenda reproduzível; erros permanentes não consomem tentativas indefinidamente.
- Um adapter concreto de secret provider ainda precisa ser configurado por ambiente. O factory exige essa dependência explicitamente e não cria fallback inseguro.
- Replay administrativo e observabilidade/API de attempts continuam incrementos separados.

## Evidências exigidas

- target inválido ou fence vencido não abre secret nem rede;
- fingerprint divergente não conecta e termina a delivery;
- payload enviado é byte a byte igual ao payload assinado;
- headers assinados e event ID divergentes são rejeitados;
- DNS privado ou misto falha antes da conexão;
- resposta 2xx conclui sucesso e persiste somente hash do body;
- falha de rede e respostas retryable agendam backoff futuro;
- worker stale não consegue persistir o resultado da rede;
- integração Prisma comprova outbox canônico → assinatura → settlement.
