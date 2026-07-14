# ADR-025 — Transporte seguro do challenge de webhook

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O ADR-024 definiu token, lifecycle e ativação, mas qualquer request para uma URL controlada por usuário cria risco de SSRF, acesso a metadata, DNS rebinding, redirect para rede privada e retenção indefinida de socket. Validar apenas a string da URL não protege a conexão efetiva. O transporte precisa provar que o endereço realmente usado é um dos endereços públicos inspecionados imediatamente antes do request.

## Decisão

- A URL vem exclusivamente do endpoint pendente persistido e é normalizada novamente antes do uso. O workflow não aceita uma URL substituta do chamador.
- O resolver é executado antes de cada conexão, sem cache do processo. Entre uma e 16 respostas A/AAAA são aceitas.
- Todos os endereços retornados precisam ser públicos. Um único endereço privado, loopback, link-local, CGNAT, multicast, documentação, benchmark, reservado, IPv4-mapped ou pertencente a faixa IPv6 especial rejeita a resolução inteira.
- O transporte seleciona uma resposta validada e fornece um `lookup` próprio ao cliente HTTPS. A conexão fica presa a esse endereço e família; o hostname original continua sendo usado para Host, SNI e verificação do certificado.
- Cada request usa `agent: false`, porta 443, TLS mínimo 1.2 e `rejectUnauthorized: true`. Variáveis de proxy não são interpretadas pelo adapter.
- Redirects não são seguidos. Qualquer status diferente de 200 é terminal para aquela tentativa de transporte.
- O deadline absoluto inclui resolução DNS e request HTTPS. O default é cinco segundos e a configuração permitida vai de um a dez segundos. O socket também recebe timeout de inatividade.
- Request e response são limitados a 1 KiB. O transporte não descomprime conteúdo.
- O request canônico é JSON UTF-8 com `type`, `challengeId`, `token` e `expiresAt`.
- A resposta deve usar `application/json`, conter exatamente `challengeId` e `token`, nessa ordem e sem representação ambígua, e repetir o ID esperado. O token ecoado segue para a verificação one-shot do ADR-024.
- Erros externos são convertidos em códigos estáveis e mensagens sem URL, IP, body ou token. Nenhum response ou erro retorna o token ao chamador do workflow.
- DNS, cliente pinado e transporte são boundaries separados e injetáveis; testes não dependem da internet nem aceitam relaxar a política em ambiente local.

## Consequências

- DNS rebinding entre resolução e conexão não altera o IP utilizado pelo socket.
- Um hostname com respostas públicas e privadas é recusado, evitando fallback perigoso da biblioteca de rede.
- Não há fallback automático para o segundo IP quando o primeiro falha; disponibilidade não prevalece sobre uma decisão de segurança ambígua.
- Faixas especiais potencialmente roteáveis podem ser recusadas. Qualquer exceção exigirá ADR e regressão explícitos.
- O adapter está pronto para uso server-side, mas não cria por si só capability pública, UI administrativa ou autorização de operador.
- A mesma resolução fail-closed deverá ser reutilizada por cada tentativa futura de delivery; não será permitido usar somente a verificação feita durante o challenge.

## Evidências exigidas

- IPv4 e IPv6 privados/especiais são bloqueados antes do cliente HTTPS;
- conjunto DNS misto falha por inteiro;
- duas resoluções sucessivas simulam rebinding e somente a primeira chega ao cliente;
- request options preservam hostname/SNI e prendem lookup, endereço e família;
- redirect, content type incorreto, body excessivo ou proof ambígua são rejeitados;
- token não aparece no estado persistido, retorno do workflow ou mensagem de erro;
- target cross-workspace ou endpoint fora de `pending-verification` não é retornado pelo repository.
