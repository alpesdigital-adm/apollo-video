# ADR-041 — Challenge público e ativação convergente de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

O cadastro público cria um endpoint pendente e um signing secret cifrado, mas não deve ativar um destino sem provar que o chamador controla a URL. O núcleo já possuía challenge one-shot e transporte HTTPS protegido contra SSRF; faltava expor a operação sem publicar token, URL completa ou detalhes internos e sem transformar a perda de uma resposta bem-sucedida em erro permanente para o cliente.

## Decisão

- A capability `apollo.webhooks.endpoints.challenge` expõe `POST /v1/webhooks/endpoints/{endpointId}/challenge` sob `webhooks:admin` e confirmação humana.
- O command não aceita body nem `Idempotency-Key`. A identidade do endpoint e seu estado durável formam a idempotência natural.
- Somente `pending-verification` pode iniciar rede. `active` retorna sucesso convergente com `replayed: true`; `suspended` e `revoked` retornam conflito sem emitir token ou chamar o destino.
- O Apollo envia um POST HTTPS canônico para a URL cadastrada com `type`, `challengeId`, token aleatório one-shot e `expiresAt`.
- O receptor deve responder com status 200, `Content-Type: application/json` e o JSON canônico contendo exatamente `challengeId` e `token`, repetindo ambos sem campos extras.
- O transporte resolve DNS, aceita somente endereços globalmente roteáveis, prende a conexão ao IP validado, mantém SNI e valida o certificado do hostname. Redirect, IP privado, loopback, rebinding, resposta acima de 1 KiB, JSON ambíguo ou deadline excedido falham fechado.
- O token bruto existe apenas na execução. A persistência contém somente seu hash e o challenge é consumido uma vez.
- A prova válida ativa endpoint e subscriptions pendentes atomicamente. A resposta pública contém somente o endpoint redigido, a quantidade de subscriptions ativadas e `replayed`.
- Se uma corrida concluir a ativação enquanto outra chamada recebe ausência ou rejeição do challenge anterior, a operação relê o estado. Encontrando `active`, converge para sucesso sem nova rede.
- Chamadas simultâneas ainda pendentes podem superseder o challenge anterior. O contrato garante convergência por retry depois da primeira ativação, não sucesso simultâneo de todas as tentativas.
- Falhas são classificadas como 404 para endpoint ausente, 409 para lifecycle/prova rejeitada e 502 para falha no receptor ou transporte externo.

## Consequências

- Um agente externo consegue concluir todo o cadastro e ativação sem acesso ao cofre ou ao banco.
- Retry após timeout do cliente é seguro e não repete tráfego quando o endpoint já está ativo.
- O receptor precisa implementar previamente o protocolo exato; esse pré-requisito faz parte da documentação pública do sistema.
- O fluxo permanece síncrono enquanto o deadline máximo é curto. Providers com latência maior deverão usar uma operação durável separada sem mudar a máquina de estados.

## Evidências exigidas

- ativação inicial usa token one-shot e promove endpoint/subscriptions uma única vez;
- replay de endpoint ativo não emite challenge nem usa rede;
- suspensão, revogação, cross-workspace e endpoint ausente falham antes de efeitos externos;
- transporte rejeita DNS privado, rebinding, TLS/resposta inválidos e deadline excedido;
- rota rejeita body, exige scope e nunca expõe URL completa, token, hash ou `keyRef`;
- OpenAPI, schema, exemplos, testes de domínio, Prisma e jornada HTTP descrevem o mesmo contrato.
