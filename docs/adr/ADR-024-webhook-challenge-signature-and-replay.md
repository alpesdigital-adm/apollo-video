# ADR-024 — Challenge, assinatura e anti-replay de webhook

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O ADR-023 deixou endpoints e subscriptions em `pending-verification` e manteve o material secreto fora do banco. Antes de existir transporte de rede, o sistema precisa definir como comprovar controle do destino, autenticar os bytes entregues e impedir o processamento repetido do mesmo evento. Essas regras devem ser determinísticas e testáveis sem misturar segurança criptográfica com DNS, HTTP ou resolução de secrets.

## Decisão

- Cada challenge usa 32 bytes aleatórios e produz um token one-shot com prefixo `whc_`. Somente o SHA-256 do token é persistido; o token original é devolvido uma única vez ao chamador interno que futuramente executará o transporte.
- O TTL pode variar de 60 a 900 segundos e o limite de tentativas, de 1 a 10. Os defaults são 600 segundos e cinco tentativas.
- Só um challenge pendente pode existir por endpoint. Emitir outro invalida atomicamente o anterior. Respostas incorretas incrementam um contador durável; expiração e esgotamento são terminais.
- A resposta correta é one-shot e ativa, na mesma transação, o endpoint e todas as suas subscriptions pendentes. Repetição, endpoint fora do estado esperado e disputa concorrente falham fechados.
- A assinatura usa HMAC-SHA256 e uma chave de 32 a 128 bytes resolvida fora deste componente. O material secreto é recebido somente em memória e nunca entra em challenge, receipt, log ou modelo persistido.
- A entrada assinada é a concatenação binária de `apollo-webhook-v1`, timestamp Unix em segundos, event ID UUID v4 e os bytes exatos do body. A assinatura não depende de parse ou reserialização de JSON.
- Os headers são `apollo-webhook-id`, `apollo-webhook-timestamp` e `apollo-webhook-signature`, sendo a última no formato `v1=<hex>`. O body assinado fica limitado a 256 KiB.
- A verificação usa comparação em tempo constante e uma janela configurável de 30 a 900 segundos, com default de 300 segundos. Versão, ID, timestamp, tamanho, chave ou assinatura inválidos retornam o mesmo erro de assinatura.
- Depois da validação criptográfica, um receipt durável é consumido com unicidade por `(endpointId, eventId)`. Uma colisão ainda válida é replay e é rejeitada.
- O receipt é retido por pelo menos dez minutos ou duas vezes a tolerância, o que for maior, limitado a 24 horas. Receipts expirados podem ser substituídos para o mesmo evento.
- Challenge e receipt são sempre escopados por workspace e endpoint. As tabelas são internas e não serão expostas diretamente pela API pública.

## Fronteira desta decisão

Este incremento entrega a máquina de estado, a assinatura e a persistência anti-replay. O transporte de challenge foi implementado posteriormente pelo ADR-025 e deve:

- resolver DNS antes de cada conexão e bloquear redes privadas, loopback, link-local, respostas ambíguas e DNS rebinding;
- exigir HTTPS na porta 443, controlar redirects e limitar tempo, tamanho e número de conexões;
- enviar o token ao destino e aceitar somente o eco exato antes do vencimento;
- reutilizar as funções canônicas deste ADR, sem implementar uma segunda forma de assinatura.

A abertura da chave por secret provider não participa do challenge. Ela será exigida pelo futuro dispatcher ao assinar deliveries e deverá descartar o material após o uso.

## Consequências

- Segurança criptográfica e transições persistidas podem ser verificadas sem acesso à internet.
- Um vazamento de banco não revela tokens de challenge nem chaves de assinatura.
- Event IDs são também nonces de entrega; reutilizá-los no mesmo endpoint é rejeitado durante a retenção.
- O endpoint pode ser ativado pelo boundary server-side seguro do ADR-025; API e UI administrativas ainda não o expõem.
- Fan-out do outbox, claim/lease de delivery, retry, dead-letter e replay administrativo continuam fora desta slice.

## Evidências exigidas

- token original não aparece na linha persistida; resposta incorreta incrementa tentativa, esgotamento e expiração são terminais;
- resposta correta ativa endpoint e subscription atomicamente e não pode ser reutilizada;
- alteração de chave, body, ID, timestamp ou versão invalida a assinatura;
- body UTF-8 é verificado pelos bytes originais, sem normalização;
- o segundo consumo do mesmo event ID no endpoint produz `WEBHOOK_REPLAY_DETECTED`;
- migrations impõem estados, datas, unicidade, escopo de workspace e relacionamentos.
