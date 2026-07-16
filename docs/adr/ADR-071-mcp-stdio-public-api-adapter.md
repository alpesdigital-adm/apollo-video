# ADR-071 — Adapter MCP stdio sobre a Public API

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

O MCP deve oferecer as mesmas operações autorizadas da Public API sem ganhar um
caminho privilegiado para domínio, banco, storage ou workers. Recriar schemas e
autorização dentro do adapter produziria deriva. Atualizar tools durante uma
sessão também permitiria mudança silenciosa entre aprovação e execução.

## Decisão

- O primeiro transporte é stdio usando o SDK MCP TypeScript estável v1. É o
  formato mais simples para hosts locais e não exige um segundo servidor HTTP.
- O bearer pertence ao processo host e é usado somente pelo cliente da Public
  API. Ele nunca aparece em tool definitions, argumentos, resultados ou logs.
- Ao iniciar, o adapter consulta `GET /v1/tools` uma vez e fixa o catálogo pelo
  restante da sessão. Reiniciar a sessão é necessário para receber mudanças.
- Listagem e execução usam somente o descriptor publicado. Path, query, headers
  e body são convertidos para uma requisição HTTP à URL base fixa.
- HTTPS é obrigatório fora de loopback; redirects e URLs com credentials são
  rejeitados para evitar exfiltração do bearer.
- O adapter valida inputSchema antes da chamada e outputSchema antes de devolver
  structuredContent. Output inválido não é ecoado ao host.
- Erro HTTP público retorna `isError` com seu envelope JSON. Erro interno retorna
  mensagem limitada e não inclui configuração sensível.
- Approval usa elicitation suportada pelo host e gera evidência efêmera vinculada
  ao fingerprint. Sem canal confiável, a tool protegida falha fechada.
- O entrypoint stdio nunca escreve logs em stdout.

## Consequências

- MCP, REST e futuros SDKs compartilham a mesma autorização e schemas.
- O adapter pode ser testado com Public API fake sem iniciar banco ou workers.
- Snapshot por sessão reduz risco de tool-definition drift/rug pull.
- Streamable HTTP poderá reutilizar o mesmo cliente e handlers em fatia futura.
- Resources, prompts e preflight token assinado permanecem incrementos separados.

## Evidências exigidas

- list/call com client e transport MCP oficiais;
- bearer presente somente no request HTTP;
- path/query/headers/body mapeados sem inferência;
- input e output inválidos bloqueados;
- redirect e configuração insegura rejeitados;
- tool protegida sem approval não chama a API;
- processo stdio real não corrompe stdout;
- contratos, build, integrações e regressão completa verdes.
